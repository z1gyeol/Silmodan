'use strict';

const { Pool, types } = require('pg');

// DATE 컬럼은 'YYYY-MM-DD' 문자열 그대로 받는다 (타임존 변환 방지)
types.setTypeParser(1082, (v) => v);

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL 환경 변수가 설정되지 않았습니다.');
}

const isLocal = /@(localhost|127\.0\.0\.1)(:|\/)/.test(connectionString) || connectionString.includes('host=/');

// 서버리스 환경에서는 인스턴스마다 연결을 적게 유지한다
const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10_000,
});

function query(text, params) {
  return pool.query(text, params);
}

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (lower(username));

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE IF NOT EXISTS exams (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject     TEXT NOT NULL CHECK (subject IN ('korean', 'math')),
    exam_date   DATE,                           -- NULL = 날짜 모름
    school_year INTEGER NOT NULL,               -- 시험지 학년도
    exam_name   TEXT NOT NULL,
    round       TEXT NOT NULL DEFAULT '',
    score       INTEGER NOT NULL,
    wrong       JSONB NOT NULL DEFAULT '[]',
    notes       JSONB NOT NULL DEFAULT '[]',
    sort_order  INTEGER NOT NULL DEFAULT 0,     -- 날짜 모름 시험끼리의 순서 (클수록 최근)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_exams_user_subject ON exams (user_id, subject);
`;

// 콜드 스타트마다 한 번만 스키마를 확인한다
let ready = null;
function ensureSchema() {
  if (!ready) {
    ready = query(SCHEMA).catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

module.exports = { query, transaction, ensureSchema };
