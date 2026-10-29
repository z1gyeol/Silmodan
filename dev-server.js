'use strict';

// 로컬 개발용 서버. 배포(Vercel)에서는 api/index.js가 쓰인다.
try {
  process.loadEnvFile();
} catch {
  // .env 파일이 없으면 환경 변수만 사용
}

const app = require('./lib/app');
const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => console.log(`실모단 서버 실행 중: http://localhost:${PORT}`));
