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
const SUBJECTS = {
  korean: { label: '국어', maxQuestion: 45, notes: ['시간 부족', '실수', '이해 못함'] },
  math: { label: '수학', maxQuestion: 30, notes: ['시간 부족', '계산 실수', '해결 실패'] },
};

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
    notes: row.notes,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

// 오래된 순: 날짜 모름(sort_order 오름차순) → 날짜 있는 시험(날짜 오름차순)
function chronological(a, b) {
  const aUnknown = a.exam_date === null;
  const bUnknown = b.exam_date === null;
  if (aUnknown !== bUnknown) return aUnknown ? -1 : 1;
  if (aUnknown) return a.sort_order - b.sort_order || a.id - b.id;
  return a.exam_date.localeCompare(b.exam_date) || a.id - b.id;
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

  const wrongRaw = Array.isArray(body.wrong) ? body.wrong : [];
  const wrong = [...new Set(wrongRaw.map(Number))].sort((a, b) => a - b);
  if (wrong.some((n) => !Number.isInteger(n) || n < 1 || n > conf.maxQuestion)) {
    errors.push(`틀린 문제 번호는 1~${conf.maxQuestion} 사이여야 합니다.`);
  }

  const notesRaw = Array.isArray(body.notes) ? body.notes : [];
  const notes = conf.notes.filter((n) => notesRaw.includes(n));
  if (notesRaw.some((n) => !conf.notes.includes(n))) errors.push('비고 항목이 올바르지 않습니다.');

  return { errors, value: { subject, examDate, schoolYear, examName, round, score, wrong, notes } };
}

async function nextUnknownOrder(userId, subject) {
  const { rows } = await db.query(
    'SELECT COALESCE(MAX(sort_order), 0) AS m FROM exams WHERE user_id = $1 AND subject = $2 AND exam_date IS NULL',
    [userId, subject]
  );
  return rows[0].m + 1;
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
  rows.sort(chronological);
  res.json({ exams: rows.map(rowToExam) });
}));

app.post('/api/exams', requireAuth, wrap(async (req, res) => {
  const { errors, value: v } = validateExam(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('\n') });
  const sortOrder = v.examDate === null ? await nextUnknownOrder(req.user.id, v.subject) : 0;
  const { rows } = await db.query(
    `INSERT INTO exams (user_id, subject, exam_date, school_year, exam_name, round, score, wrong, notes, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [req.user.id, v.subject, v.examDate, v.schoolYear, v.examName, v.round, v.score,
      JSON.stringify(v.wrong), JSON.stringify(v.notes), sortOrder]
  );
  res.status(201).json({ exam: rowToExam(rows[0]) });
}));

app.put('/api/exams/:id', requireAuth, wrap(async (req, res) => {
  const existing = await getOwnExam(req.user.id, Number(req.params.id));
  if (!existing) return res.status(404).json({ error: '기록을 찾을 수 없습니다.' });
  const { errors, value: v } = validateExam(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('\n') });

  // 날짜 모름으로 바뀌었거나 과목이 바뀐 경우 해당 그룹에서 가장 최근으로 배치
  let sortOrder = existing.sort_order;
  if (v.examDate === null && (existing.exam_date !== null || existing.subject !== v.subject)) {
    sortOrder = await nextUnknownOrder(req.user.id, v.subject);
  }
  const { rows } = await db.query(
    `UPDATE exams SET subject = $1, exam_date = $2, school_year = $3, exam_name = $4, round = $5, score = $6,
       wrong = $7, notes = $8, sort_order = $9 WHERE id = $10 AND user_id = $11 RETURNING *`,
    [v.subject, v.examDate, v.schoolYear, v.examName, v.round, v.score,
      JSON.stringify(v.wrong), JSON.stringify(v.notes), sortOrder, existing.id, req.user.id]
  );
  res.json({ exam: rowToExam(rows[0]) });
}));

app.delete('/api/exams/:id', requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const result = Number.isInteger(id)
    ? await db.query('DELETE FROM exams WHERE id = $1 AND user_id = $2', [id, req.user.id])
    : { rowCount: 0 };
  if (!result.rowCount) return res.status(404).json({ error: '기록을 찾을 수 없습니다.' });
  res.json({ ok: true });
}));

// 날짜 모름 시험의 순서 변경. direction: 'newer' | 'older'
app.post('/api/exams/:id/move', requireAuth, wrap(async (req, res) => {
  const exam = await getOwnExam(req.user.id, Number(req.params.id));
  if (!exam) return res.status(404).json({ error: '기록을 찾을 수 없습니다.' });
  if (exam.exam_date !== null) return res.status(400).json({ error: '날짜를 모르는 시험만 순서를 바꿀 수 있습니다.' });
  const { direction } = req.body;
  if (direction !== 'newer' && direction !== 'older') return res.status(400).json({ error: '잘못된 요청입니다.' });

  await db.transaction(async (client) => {
    const { rows: group } = await client.query(
      'SELECT * FROM exams WHERE user_id = $1 AND subject = $2 AND exam_date IS NULL FOR UPDATE',
      [req.user.id, exam.subject]
    );
    group.sort(chronological);
    const idx = group.findIndex((g) => g.id === exam.id);
    const target = direction === 'newer' ? idx + 1 : idx - 1;
    if (target < 0 || target >= group.length) return;
    [group[idx], group[target]] = [group[target], group[idx]];
    for (const [i, g] of group.entries()) {
      await client.query('UPDATE exams SET sort_order = $1 WHERE id = $2', [i + 1, g.id]);
    }
  });
  res.json({ ok: true });
}));

app.use('/api', (_req, res) => res.status(404).json({ error: '존재하지 않는 API입니다.' }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

module.exports = app;
