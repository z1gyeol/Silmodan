'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'silmodan.db');
const SESSION_DAYS = 30;
const COOKIE_NAME = 'silmodan_sid';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';

// ---------- 과목 설정 ----------
const SUBJECTS = {
  korean: { label: '국어', maxQuestion: 45, notes: ['시간 부족', '실수', '이해 못함'] },
  math: { label: '수학', maxQuestion: 30, notes: ['시간 부족', '계산 실수', '해결 실패'] },
};

// ---------- DB ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS exams (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject     TEXT NOT NULL CHECK (subject IN ('korean', 'math')),
    exam_date   TEXT,               -- NULL = 날짜 모름
    school_year INTEGER NOT NULL,   -- 시험지 학년도
    exam_name   TEXT NOT NULL,
    round       TEXT NOT NULL DEFAULT '',
    score       INTEGER NOT NULL,
    wrong       TEXT NOT NULL DEFAULT '[]',  -- JSON 배열
    notes       TEXT NOT NULL DEFAULT '[]',  -- JSON 배열
    sort_order  INTEGER NOT NULL DEFAULT 0,  -- 날짜 모름 시험끼리의 순서 (클수록 최근)
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_exams_user_subject ON exams(user_id, subject);
`);

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

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function loadUser(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  req.user = null;
  if (token) {
    const row = db
      .prepare(
        `SELECT u.id, u.username, s.expires_at FROM sessions s
         JOIN users u ON u.id = s.user_id WHERE s.token = ?`
      )
      .get(token);
    if (row && row.expires_at > Date.now()) {
      req.user = { id: row.id, username: row.username };
      req.sessionToken = token;
    } else if (row) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    }
  }
  next();
}

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
    wrong: JSON.parse(row.wrong),
    notes: JSON.parse(row.notes),
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

function nextUnknownOrder(userId, subject) {
  const row = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM exams WHERE user_id = ? AND subject = ? AND exam_date IS NULL')
    .get(userId, subject);
  return row.m + 1;
}

function getOwnExam(userId, id) {
  return db.prepare('SELECT * FROM exams WHERE id = ? AND user_id = ?').get(id, userId);
}

// ---------- 앱 ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(loadUser);

// 간단한 로그인 시도 제한 (IP당 15분에 20회)
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

app.post('/api/register', rateLimit, (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!/^[A-Za-z0-9_가-힣]{3,20}$/.test(username)) {
    return res.status(400).json({ error: '아이디는 3~20자의 한글, 영문, 숫자, _ 만 사용할 수 있습니다.' });
  }
  if (password.length < 6 || password.length > 100) {
    return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const result = db
    .prepare('INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)')
    .run(username, hashPassword(password, salt), salt);
  createSession(res, Number(result.lastInsertRowid));
  res.status(201).json({ user: { id: Number(result.lastInsertRowid), username } });
});

app.post('/api/login', rateLimit, (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }
  createSession(res, user.id);
  res.json({ user: { id: user.id, username: user.username } });
});

app.post('/api/logout', (req, res) => {
  if (req.sessionToken) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ user: req.user }));

app.get('/api/exams', requireAuth, (req, res) => {
  const { subject } = req.query;
  const rows = SUBJECTS[subject]
    ? db.prepare('SELECT * FROM exams WHERE user_id = ? AND subject = ?').all(req.user.id, subject)
    : db.prepare('SELECT * FROM exams WHERE user_id = ?').all(req.user.id);
  rows.sort(chronological);
  res.json({ exams: rows.map(rowToExam) });
});

app.post('/api/exams', requireAuth, (req, res) => {
  const { errors, value: v } = validateExam(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('\n') });
  const sortOrder = v.examDate === null ? nextUnknownOrder(req.user.id, v.subject) : 0;
  const result = db
    .prepare(
      `INSERT INTO exams (user_id, subject, exam_date, school_year, exam_name, round, score, wrong, notes, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.user.id, v.subject, v.examDate, v.schoolYear, v.examName, v.round, v.score,
      JSON.stringify(v.wrong), JSON.stringify(v.notes), sortOrder);
  res.status(201).json({ exam: rowToExam(getOwnExam(req.user.id, result.lastInsertRowid)) });
});

app.put('/api/exams/:id', requireAuth, (req, res) => {
  const existing = getOwnExam(req.user.id, Number(req.params.id));
  if (!existing) return res.status(404).json({ error: '기록을 찾을 수 없습니다.' });
  const { errors, value: v } = validateExam(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('\n') });

  // 날짜 모름으로 바뀌었거나 과목이 바뀐 경우 해당 그룹에서 가장 최근으로 배치
  let sortOrder = existing.sort_order;
  if (v.examDate === null && (existing.exam_date !== null || existing.subject !== v.subject)) {
    sortOrder = nextUnknownOrder(req.user.id, v.subject);
  }
  db.prepare(
    `UPDATE exams SET subject = ?, exam_date = ?, school_year = ?, exam_name = ?, round = ?, score = ?,
       wrong = ?, notes = ?, sort_order = ? WHERE id = ? AND user_id = ?`
  ).run(v.subject, v.examDate, v.schoolYear, v.examName, v.round, v.score,
    JSON.stringify(v.wrong), JSON.stringify(v.notes), sortOrder, existing.id, req.user.id);
  res.json({ exam: rowToExam(getOwnExam(req.user.id, existing.id)) });
});

app.delete('/api/exams/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM exams WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!result.changes) return res.status(404).json({ error: '기록을 찾을 수 없습니다.' });
  res.json({ ok: true });
});

// 날짜 모름 시험의 순서 변경. direction: 'newer' | 'older'
app.post('/api/exams/:id/move', requireAuth, (req, res) => {
  const exam = getOwnExam(req.user.id, Number(req.params.id));
  if (!exam) return res.status(404).json({ error: '기록을 찾을 수 없습니다.' });
  if (exam.exam_date !== null) return res.status(400).json({ error: '날짜를 모르는 시험만 순서를 바꿀 수 있습니다.' });
  const { direction } = req.body;
  if (direction !== 'newer' && direction !== 'older') return res.status(400).json({ error: '잘못된 요청입니다.' });

  const group = db
    .prepare('SELECT * FROM exams WHERE user_id = ? AND subject = ? AND exam_date IS NULL')
    .all(req.user.id, exam.subject)
    .sort(chronological);
  const idx = group.findIndex((g) => g.id === exam.id);
  const target = direction === 'newer' ? idx + 1 : idx - 1;
  if (target >= 0 && target < group.length) {
    [group[idx], group[target]] = [group[target], group[idx]];
    const update = db.prepare('UPDATE exams SET sort_order = ? WHERE id = ?');
    db.exec('BEGIN');
    try {
      group.forEach((g, i) => update.run(i + 1, g.id));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  res.json({ ok: true });
});

app.get('/vendor/chart.umd.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'));
});
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

// 만료된 세션 정리
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 60 * 60 * 1000).unref();

app.listen(PORT, () => console.log(`실모단 서버 실행 중: http://localhost:${PORT}`));
