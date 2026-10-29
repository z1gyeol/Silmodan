'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const db = require('./db');

const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'silmodan_sid';
const COOKIE_SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : Boolean(process.env.VERCEL);

// ---------- 과목 설정 ----------
const GUESS_NOTE = '찍맞';

// areas: from~to 가 있으면 틀린 문제 번호로 자동 계산, manual 이면 직접 입력
const SUBJECTS = {
  korean: {
    label: '국어',
    maxQuestion: 45,
    notes: ['시간 부족', '실수', '이해 못함', '어휘', '보기', '세부', GUESS_NOTE],
    areas: [
      { name: '독서론', from: 1, to: 3 },
      { name: '독서', from: 4, to: 17 },
      { name: '문학', from: 18, to: 34 },
      { name: '언어', from: 35, to: 39 },
      { name: '매체', from: 40, to: 45 },
    ],
  },
  math: {
    label: '수학',
    maxQuestion: 30,
    notes: ['시간 부족', '계산 실수', '해결 실패', GUESS_NOTE],
    manualRange: { from: 1, to: 22 },
    areas: [
      { name: '수1', manual: true },
      { name: '수2', manual: true },
      { name: '미적', from: 23, to: 30 },
    ],
  },
};

const inRange = (q, r) => q >= r.from && q <= r.to;

// 영역별 틀린 개수. 수동 입력값이 없으면(예전 기록) null
function computeAreas(subject, wrong, areaManual) {
  const conf = SUBJECTS[subject];
  const noManualWrong = conf.manualRange && !wrong.some((q) => inRange(q, conf.manualRange));
  const out = {};
  for (const area of conf.areas) {
    if (!area.manual) out[area.name] = wrong.filter((q) => inRange(q, area)).length;
    else if (areaManual && Number.isInteger(areaManual[area.name])) out[area.name] = areaManual[area.name];
    else out[area.name] = noManualWrong ? 0 : null;
  }
  return out;
}

// ---------- 비밀번호 ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, expectedHex) {
  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---------- 세션 ----------
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)', [
    token, userId, new Date(Date.now() + SESSION_MS),
  ]);
  // 만료된 세션 정리
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: SESSION_MS,
    path: '/',
  });
}

// async 핸들러의 에러를 Express 에러 핸들러로 넘긴다
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const loadUser = wrap(async (req, _res, next) => {
  await db.ensureSchema();
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  req.user = null;
  if (token) {
    const { rows } = await db.query(
      `SELECT u.id, u.username FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token = $1 AND s.expires_at > now()`,
      [token]
    );
    if (rows[0]) {
      req.user = { id: rows[0].id, username: rows[0].username };
      req.sessionToken = token;
    }
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다.' });
  next();
}

// ---------- 시험 기록 ----------
function rowToExam(row) {
  return {
    id: row.id,
    subject: row.subject,
    examDate: row.exam_date,
    schoolYear: row.school_year,
    examName: row.exam_name,
    round: row.round,
    score: row.score,
    wrong: row.wrong,
    guessed: row.guessed,
    areas: computeAreas(row.subject, row.wrong, row.area_manual),
    notes: row.notes,
    position: row.position,
    createdAt: row.created_at,
  };
}

// 오래된 순
const byPosition = (a, b) => a.position - b.position || a.id - b.id;

// 새 위치: 날짜 모름 → 첫 번째 날짜 있는 시험 바로 앞 (날짜 모름끼리는 나중에 입력한 것이 최근)
//          날짜 있음 → 날짜가 같거나 이전인 마지막 시험 바로 뒤
function insertIndex(list, examDate) {
  const firstDated = list.findIndex((e) => e.exam_date !== null);
  const fallback = firstDated < 0 ? list.length : firstDated;
  if (examDate === null) return fallback;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].exam_date !== null && list[i].exam_date <= examDate) return i + 1;
  }
  return fallback;
}

async function renumber(client, list) {
  await client.query(
    `UPDATE exams e SET position = v.pos
     FROM unnest($1::int[], $2::int[]) AS v(id, pos) WHERE e.id = v.id`,
    [list.map((e) => e.id), list.map((_, i) => i + 1)]
  );
}

async function lockGroup(client, userId, subject) {
  const { rows } = await client.query(
    'SELECT id, exam_date, position FROM exams WHERE user_id = $1 AND subject = $2 FOR UPDATE',
    [userId, subject]
  );
  return rows.sort(byPosition);
}

// 시험 하나를 규칙에 맞는 자리에 (다시) 넣는다
async function placeExam(client, userId, subject, examId, examDate) {
  const list = (await lockGroup(client, userId, subject)).filter((e) => e.id !== examId);
  list.splice(insertIndex(list, examDate), 0, { id: examId });
  await renumber(client, list);
}

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function validateExam(body) {
  const errors = [];
  const subject = body.subject;
  const conf = SUBJECTS[subject];
  if (!conf) return { errors: ['과목을 선택해 주세요.'] };

  let examDate = null;
  if (body.examDate !== null && body.examDate !== undefined && body.examDate !== '') {
    if (typeof body.examDate !== 'string' || !isValidDate(body.examDate)) errors.push('날짜 형식이 올바르지 않습니다.');
    else examDate = body.examDate;
  }

  const schoolYear = Number(body.schoolYear);
  if (!Number.isInteger(schoolYear) || schoolYear < 2000 || schoolYear > 2100) errors.push('학년도를 올바르게 입력해 주세요.');

  const examName = typeof body.examName === 'string' ? body.examName.trim() : '';
  if (!examName) errors.push('모의고사 이름을 입력해 주세요.');
  else if (examName.length > 50) errors.push('모의고사 이름은 50자 이하로 입력해 주세요.');

  const round = typeof body.round === 'string' ? body.round.trim() : String(body.round ?? '').trim();
  if (round.length > 20) errors.push('회차는 20자 이하로 입력해 주세요.');

  const score = Number(body.score);
  if (body.score === '' || body.score === null || !Number.isInteger(score) || score < 0 || score > 100) {
    errors.push('점수는 0~100 사이의 정수로 입력해 주세요.');
  }

  const toQuestions = (raw) => [...new Set((Array.isArray(raw) ? raw : []).map(Number))].sort((a, b) => a - b);
  const badQuestion = (n) => !Number.isInteger(n) || n < 1 || n > conf.maxQuestion;
  const wrong = toQuestions(body.wrong);
  const guessed = toQuestions(body.guessed);
  if (wrong.some(badQuestion)) errors.push(`틀린 문제 번호는 1~${conf.maxQuestion} 사이여야 합니다.`);
  if (guessed.some(badQuestion)) errors.push(`찍맞 문제 번호는 1~${conf.maxQuestion} 사이여야 합니다.`);
  if (guessed.some((q) => wrong.includes(q))) errors.push('같은 문제를 틀린 문제와 찍맞 문제로 동시에 고를 수 없습니다.');

  const notesRaw = Array.isArray(body.notes) ? body.notes : [];
  if (notesRaw.some((n) => !conf.notes.includes(n))) errors.push('비고 항목이 올바르지 않습니다.');
  // 찍맞 문제가 있으면 비고에 '찍맞' 자동 추가
  const notes = conf.notes.filter((n) => notesRaw.includes(n) || (n === GUESS_NOTE && guessed.length > 0));

  // 수학: 1~22번 틀린 문제를 수1/수2로 나눈 개수
  let areaManual = null;
  if (conf.manualRange) {
    const total = wrong.filter((q) => inRange(q, conf.manualRange)).length;
    const raw = body.areaManual || {};
    const names = conf.areas.filter((a) => a.manual).map((a) => a.name);
    areaManual = {};
    for (const name of names) {
      const v = total === 0 ? 0 : Number(raw[name]);
      if (!Number.isInteger(v) || v < 0) errors.push(`${name} 틀린 개수를 입력해 주세요.`);
      areaManual[name] = v;
    }
    const sum = names.reduce((a, n) => a + (areaManual[n] || 0), 0);
    if (!errors.length && sum !== total) {
      errors.push(`${names.join(' + ')} 틀린 개수의 합(${sum})이 ${conf.manualRange.from}~${conf.manualRange.to}번 틀린 문제 수(${total})와 같아야 합니다.`);
    }
  }

  return { errors, value: { subject, examDate, schoolYear, examName, round, score, wrong, guessed, notes, areaManual } };
}

async function getOwnExam(userId, id) {
  if (!Number.isInteger(id)) return null;
  const { rows } = await db.query('SELECT * FROM exams WHERE id = $1 AND user_id = $2', [id, userId]);
  return rows[0] || null;
}

// ---------- 앱 ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', loadUser);

// 간단한 로그인 시도 제한 (인스턴스별, IP당 15분에 20회)
const attempts = new Map();
function rateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const entry = attempts.get(key) || { count: 0, reset: now + 15 * 60 * 1000 };
  if (now > entry.reset) Object.assign(entry, { count: 0, reset: now + 15 * 60 * 1000 });
  entry.count += 1;
  attempts.set(key, entry);
  if (entry.count > 20) return res.status(429).json({ error: '시도 횟수가 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
  next();
}

app.get('/api/config', (_req, res) => res.json({ subjects: SUBJECTS }));

app.post('/api/register', rateLimit, wrap(async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!/^[A-Za-z0-9_가-힣]{3,20}$/.test(username)) {
    return res.status(400).json({ error: '아이디는 3~20자의 한글, 영문, 숫자, _ 만 사용할 수 있습니다.' });
  }
  if (password.length < 6 || password.length > 100) {
    return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const { rows } = await db.query(
    `INSERT INTO users (username, password_hash, salt) VALUES ($1, $2, $3)
     ON CONFLICT (lower(username)) DO NOTHING RETURNING id`,
    [username, hashPassword(password, salt), salt]
  );
  if (!rows[0]) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
  await createSession(res, rows[0].id);
  res.status(201).json({ user: { id: rows[0].id, username } });
}));

app.post('/api/login', rateLimit, wrap(async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const { rows } = await db.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
  const user = rows[0];
  if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }
  await createSession(res, user.id);
  res.json({ user: { id: user.id, username: user.username } });
}));

app.post('/api/logout', wrap(async (req, res) => {
  if (req.sessionToken) await db.query('DELETE FROM sessions WHERE token = $1', [req.sessionToken]);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
}));

app.get('/api/me', (req, res) => res.json({ user: req.user }));

app.get('/api/exams', requireAuth, wrap(async (req, res) => {
  const { subject } = req.query;
  const { rows } = SUBJECTS[subject]
    ? await db.query('SELECT * FROM exams WHERE user_id = $1 AND subject = $2', [req.user.id, subject])
    : await db.query('SELECT * FROM exams WHERE user_id = $1', [req.user.id]);
  rows.sort(byPosition);
  res.json({ exams: rows.map(rowToExam) });
}));

const examParams = (v) => [
  v.subject, v.examDate, v.schoolYear, v.examName, v.round, v.score,
  JSON.stringify(v.wrong), JSON.stringify(v.guessed), JSON.stringify(v.notes),
  v.areaManual ? JSON.stringify(v.areaManual) : null,
];

app.post('/api/exams', requireAuth, wrap(async (req, res) => {
  const { errors, value: v } = validateExam(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('\n') });
  const row = await db.transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO exams (subject, exam_date, school_year, exam_name, round, score, wrong, guessed, notes, area_manual, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [...examParams(v), req.user.id]
    );
    await placeExam(client, req.user.id, v.subject, rows[0].id, v.examDate);
    return (await client.query('SELECT * FROM exams WHERE id = $1', [rows[0].id])).rows[0];
  });
  res.status(201).json({ exam: rowToExam(row) });
}));

app.put('/api/exams/:id', requireAuth, wrap(async (req, res) => {
  const existing = await getOwnExam(req.user.id, Number(req.params.id));
  if (!existing) return res.status(404).json({ error: '기록을 찾을 수 없습니다.' });
  const { errors, value: v } = validateExam(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('\n') });

  const row = await db.transaction(async (client) => {
    await client.query(
      `UPDATE exams SET subject = $1, exam_date = $2, school_year = $3, exam_name = $4, round = $5, score = $6,
         wrong = $7, guessed = $8, notes = $9, area_manual = $10 WHERE id = $11 AND user_id = $12`,
      [...examParams(v), existing.id, req.user.id]
    );
    // 날짜나 과목이 바뀌면 규칙에 맞는 자리로 다시 배치
    if (existing.exam_date !== v.examDate || existing.subject !== v.subject) {
      await placeExam(client, req.user.id, v.subject, existing.id, v.examDate);
    }
    return (await client.query('SELECT * FROM exams WHERE id = $1', [existing.id])).rows[0];
  });
  res.json({ exam: rowToExam(row) });
}));

app.delete('/api/exams/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const result = Number.isInteger(id)
    ? await db.query('DELETE FROM exams WHERE id = $1 AND user_id = $2', [id, req.user.id])
    : { rowCount: 0 };
  if (!result.rowCount) return res.status(404).json({ error: '기록을 찾을 수 없습니다.' });
  res.json({ ok: true });
}));

// 날짜 모름 시험의 순서 변경 (날짜 있는 시험 사이로도 이동 가능). direction: 'newer' | 'older'
app.post('/api/exams/:id/move', requireAuth, wrap(async (req, res) => {
  const exam = await getOwnExam(req.user.id, Number(req.params.id));
  if (!exam) return res.status(404).json({ error: '기록을 찾을 수 없습니다.' });
  if (exam.exam_date !== null) return res.status(400).json({ error: '날짜를 모르는 시험만 순서를 바꿀 수 있습니다.' });
  const { direction } = req.body;
  if (direction !== 'newer' && direction !== 'older') return res.status(400).json({ error: '잘못된 요청입니다.' });

  await db.transaction(async (client) => {
    const list = await lockGroup(client, req.user.id, exam.subject);
    const idx = list.findIndex((g) => g.id === exam.id);
    const target = direction === 'newer' ? idx + 1 : idx - 1;
    if (target < 0 || target >= list.length) return;
    [list[idx], list[target]] = [list[target], list[idx]];
    await renumber(client, list);
  });
  res.json({ ok: true });
}));

app.use('/api', (_req, res) => res.status(404).json({ error: '존재하지 않는 API입니다.' }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

module.exports = app;
