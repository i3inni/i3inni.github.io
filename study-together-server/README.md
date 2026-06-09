# Study Flight — Backend (같이 공부 서버)

`study-together/` 프론트엔드를 위한 독립 백엔드.
**Spring Boot + PostgreSQL + Docker**, WebRTC 시그널링 포함.

> 이 디렉토리는 독립 모듈입니다. 삭제 시 이 폴더만 지우면 됩니다.

## 구성

```
study-together-server/
├── docker-compose.yml      # postgres + app
├── Dockerfile              # 멀티스테이지 (gradle 빌드 → JRE 실행)
├── .env.example            # 환경변수 분리 (복사해서 .env 로 사용)
├── build.gradle
└── src/main/
    ├── java/com/i3inni/studytogether/
    │   ├── config/         # CORS, WebSocket 등록
    │   ├── room/           # Room 엔티티 · 로비 REST API
    │   ├── presence/       # 방별 실시간 참가자(인메모리)
    │   └── signaling/      # WebRTC offer/answer/ice 중계 (WS)
    └── resources/application.yml
```

## API

| Method | Path | 설명 |
|---|---|---|
| `POST` | `/api/rooms` | 방 생성 (title, hostName, departure, destination, durationMinutes) |
| `GET` | `/api/rooms` | 공개 방 목록(대기실) — 참가자 수 포함 |
| `GET` | `/api/rooms/{code}` | 방 상세 |
| `WS` | `/ws/signal` | WebRTC 시그널링 + presence |

WS 메시지: `join` / `offer` / `answer` / `ice` / `start` / `leave`
(상세 프로토콜은 `SignalingHandler.java` 주석 참고)

## 실행 (Docker, 권장)

```bash
cp .env.example .env          # 값 채우기 (특히 POSTGRES_PASSWORD)
docker compose up --build
```
- 앱: http://localhost:8080
- DB: localhost:5432

## 실행 (로컬, Postgres 직접)

```bash
# Postgres 띄우고 DB/계정 생성 후
export DB_URL=jdbc:postgresql://localhost:5432/studytogether
export DB_USERNAME=studytogether
export DB_PASSWORD=studytogether
./gradlew bootRun     # 또는: gradle bootRun
```

## 환경변수 (전부 분리됨)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `SERVER_PORT` | 8080 | 앱 포트 |
| `DB_URL` | jdbc:postgresql://localhost:5432/studytogether | JDBC URL |
| `DB_USERNAME` / `DB_PASSWORD` | studytogether | DB 계정 |
| `JPA_DDL_AUTO` | update | 운영은 `validate` 권장 |
| `ALLOWED_ORIGINS` | localhost:5500, i3inni.github.io | CORS 허용 오리진(콤마) |
| `LOG_LEVEL` | INFO | 앱 로그 레벨 |

## 프론트 연결

프론트(`study-together/`)는 화면 하단 **백엔드 서버** 입력칸에 이 서버 주소를 넣는다.
- 로컬: `http://localhost:8080`
- 배포: 배포된 서버 주소 (HTTPS면 프론트도 `wss://` 자동 사용)

## ⚠️ TURN (다른 네트워크 영상)

이 서버는 **로비 + 시그널링**을 담당한다. 하지만 서로 다른 네트워크(모바일/회사망/대칭 NAT)
사이의 **영상 P2P 연결 자체**는 TURN 서버가 있어야 안정적이다(시그널링과 별개 문제).

TURN 추가 지점: 프론트 `study-together/app.js` 의 `ICE_SERVERS` 배열.
```js
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  // { urls: "turn:YOUR_TURN:3478", username: "...", credential: "..." },
];
```
TURN 없이도 **같은 네트워크/같은 기기**에서는 정상 동작한다(데모용으로 충분).
