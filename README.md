# 실모단

실전 모의고사(실모) 기록을 저장하고 성적 변화를 확인하는 웹사이트입니다.

## 기능

- **로그인 / 회원가입**: 계정별로 기록을 DB(Postgres)에 저장합니다. 비밀번호는 scrypt로 해시해서 저장합니다.
- **과목**: 국어, 수학
- **기록 입력**
  - 응시 날짜를 고르거나 **날짜 모름** 체크
    - 날짜 모름 시험은 날짜가 있는 시험보다 오래된 것으로 취급합니다.
    - 날짜 모름 시험끼리는 나중에 입력한 것이 더 최근으로 들어갑니다. 기록 목록의 ▲▼ 버튼으로 순서를 바꿀 수 있습니다.
  - 학년도(시험지 기준), 모의고사 이름(목록에서 선택 또는 직접 입력), 회차, 점수
  - 틀린 문제: 번호 버튼을 눌러 선택 (국어 1~45, 수학 1~30)
  - 비고(중복 선택)
    - 국어: 시간 부족 / 실수 / 이해 못함
    - 수학: 시간 부족 / 계산 실수 / 해결 실패
- **과목별 전체 성적**: 최근 점수, 평균, 최근 5회 평균, 최고/최저 점수, 비고 통계, 자주 틀린 문항, 전체 기록 표(수정/삭제)
- **성적 변화 그래프**: 오래된 시험부터 최근 시험까지 점수 변화

## Vercel 배포 (Neon Postgres)

1. https://vercel.com 에 GitHub 계정으로 로그인
2. **Add New → Project** 에서 이 저장소를 **Import** (설정은 기본값 그대로)
3. 프로젝트의 **Storage** 탭 → **Create Database** → **Neon** 선택 후 프로젝트에 연결
   - `DATABASE_URL` 환경 변수가 자동으로 추가됩니다.
4. **Deployments** 탭에서 **Redeploy** (DB 연결 전에 배포했다면)
5. 첫 요청 때 테이블이 자동으로 만들어집니다. 이후 `main` 에 푸시하면 자동 배포됩니다.

## 로컬 실행

Node.js 20.12 이상과 Postgres 접속 주소가 필요합니다 (Neon 주소를 그대로 써도 됩니다).

```bash
npm install
cp .env.example .env   # DATABASE_URL 입력
npm run dev
# http://localhost:3000
```

### 환경 변수

| 이름 | 설명 |
|---|---|
| `DATABASE_URL` | Postgres 접속 주소 (Vercel + Neon 연결 시 자동 설정) |
| `PORT` | 로컬 서버 포트 (기본 3000) |
| `COOKIE_SECURE` | 세션 쿠키 Secure 여부. 기본값은 Vercel에서 `true`, 로컬에서 `false` |

## 구조

```
api/index.js       Vercel 서버리스 함수 진입점 (/api/*)
lib/app.js         Express 앱 + API
lib/db.js          Postgres 연결, 테이블 생성
dev-server.js      로컬 개발 서버
public/            화면 (index.html, style.css, app.js, Chart.js)
vercel.json        /api/* → 함수 연결
```
