# 태블릿 앱 ↔ 구노 ELN 동기화 API (v1)

구노 연구노트 태블릿 앱(`app/`)이 오프라인에서 작성한 노트를 구노 ELN에 올리는 계약이다.
Goono-ELN 서버 구현의 기준이며, 개발·테스트용 구현은 `app/mock-server/`에 있다.

## 원칙

1. **내용은 단방향** — 노트 내용은 앱 → ELN으로만 올라간다. ELN → 앱은 기준 정보(프로젝트,
   노트 상태, 편집 위치)만 내려준다.
2. **편집 위치는 하나** — 노트마다 편집할 수 있는 곳은 웹(`WEB`) 또는 특정 기기(`DEVICE`) 하나다.
   앱에서 만든 노트는 만든 기기가 편집 위치다. 동시 편집은 없다.
3. **점검 전 누락 없음** — 편집 위치가 `DEVICE`인 노트는 웹에서 점검 요청할 수 없다. 앱이 "작성
   완료"로 모든 버전을 올리고 편집권을 웹에 넘긴 뒤에만 점검 요청이 가능하다. 시점인증은 기존대로
   점검 시 수행되고, 점검 요청 이후에는 어디서도 수정할 수 없다.
4. **덮어쓰기 없음** — 버전은 쌓기만 한다. 서버가 받지 않은 기기 작성분은 앱이 "미반영 기록"으로
   보관한다(버리지 않는다).
5. **저장 형식은 웹과 동일** — 본문은 editor-ai HTML(손글씨는 `figure.rw-drawing[data-strokes]`).
   이미지는 기존 `/api/eln/note/editor/saveEditor`와 같은 `blob:` 치환 규칙으로 보내므로
   `ElnNoteEditorService.createNoteEditorDtl`을 그대로 재사용할 수 있다.

## 공통

- 기본 경로: `{서버}/api/app/v1`
- 인증: `Authorization: Bearer {기기 토큰}` (연결 `/devices/pair`·기기 등록 `/devices/register` 제외). 웹 로그인 세션과 **분리**한다 —
  웹의 동시 세션 1개 제한(`maximumSessions(1)`)에 걸리지 않게 별도 필터 체인으로 처리.
- 오류 본문: `{ "error": { "code": "…", "message": "…" } }` — 이 문서의 오류 코드는 모두 이 형식이다. 다만 경로·메서드가
  없는 요청(매핑되지 않은 404, 405)은 서버(Spring) 기본 응답이라 이 형식이 아닐 수 있다. 앱은 본문에 `error`가 없으면
  `HTTP_{상태}`로 다룬다.
- `400 BAD_REQUEST`와 `400 INVALID_REQUEST`의 구분: `BAD_REQUEST`는 **요청 형식이 틀림**(필수 값 없음·길이 초과·JSON·multipart가
  아님 등), `INVALID_REQUEST`는 **형식은 맞지만 내용 규칙 위반**(같은 아이디로 다른 내용, 이미지 ref 규칙, 같은 ref의 다른 이미지).
  둘 다 다시 보내도 결과가 같다.
- 기관이 태블릿 연결을 꺼 두었으면(`app.device.enabled=false`) **모든 `/api/app/v1` 요청**이 403 `APP_DISABLED`일 수
  있다(연결·갱신·동기화 모두). 앱은 이 코드를 받으면 연결 안내 문구를 보여 준다. 동기화 중이면 그 자리에서 멈추고
  올리지 않은 버전은 대기 그대로 둔다(미반영으로 돌리지 않는다).
- 시각: ISO-8601 (UTC). 서버 시각이 기준이며 기기 시각은 참고 값으로만 저장한다.
- CORS: 앱 웹뷰 오리진 `capacitor://localhost`(iOS), `https://localhost`(Android), `http://localhost`(Android를 `http`
  스킴으로 띄운 빌드)를 허용한다. 메서드 GET·POST·OPTIONS, 헤더 `Authorization`·`Content-Type`. 앱이 429의 `Retry-After`를
  읽을 수 있게 `Access-Control-Expose-Headers: Retry-After`를 보낸다.

## 0. 연결(QR) — 기본 경로

앱은 비밀번호를 받지 않는다. 구노 웹에 로그인한 사용자가 **일회용 연결 코드**(QR)를 띄우고, 태블릿이
그것을 읽어 기기 토큰을 받는다. 계정 비밀번호가 태블릿을 거치지 않고, SSO·2단계 인증을 쓰는 기관도
같은 방식으로 연결된다.

### 0.1 연결 코드 발급 `POST /api/eln/app/pairing-code` (웹 · 로그인 세션)

웹 화면(내 설정 ▸ 태블릿 연결)에서 부른다. 기존 웹 로그인 세션·CSRF 규칙을 그대로 따르며 본문은 없다.

```json
응답 200 {
  "appEnabled": true,
  "code": "K7Q2-M9XD",
  "qrPayload": "goono-note://pair?server=https%3A%2F%2Feln.example.com&code=K7Q2-M9XD",
  "expiresAt": "2026-10-18T09:05:00Z",
  "expiresInSeconds": 300
}
```
`expiresInSeconds`는 발급 때 DB 시각으로 계산한 남은 초다. 웹 화면의 카운트다운은 브라우저 시계 대신 이 값으로 센다.
(웹 공통 JSON 응답이라 `resultCode` 같은 웹 공통 필드가 더 붙는다.)

- **코드 형식**: 8자, 문자 집합 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`(0·O·1·I·L 제외). 화면에는 `XXXX-XXXX`로
  표시한다. 암호학적 난수(`SecureRandom`)로 만든다.
- **정규화**: 서버·앱 모두 **대문자로 바꾸고 `-`·공백을 지운 뒤** 비교한다. 서버는 정규화한 값의
  해시(`CODE_HASH`)만 저장한다. 소문자·하이픈 없음·앞뒤 공백으로 입력해도 같은 코드다.
- **일회용, 5분 유효**: `expiresAt`까지만 쓸 수 있고, 연결에 한 번 성공하면 다시 쓸 수 없다.
- **재발급 무효화**: 같은 사용자가 새 코드를 받으면 그 사용자의 이전 미사용 코드는 무효가 된다.
- **QR 내용**: `goono-note://pair?server=<https URL>&code=<XXXX-XXXX>` (두 값 모두 URL 인코딩).
  앱은 scheme이 `goono-note`·host가 `pair`가 아니거나, `server`가 https가 아니거나(개발 빌드만 http 허용),
  `code`가 정규화 후 8자가 아니면 연결을 시도하지 않고 거부한다.
  `server`는 서버 설정 `app.base-url` 값이다. 설정이 비어 있으면 서버는 이 요청의 URL(scheme + host + context path)로
  만들고 경고 로그를 남긴다.
- 기관이 태블릿 연결을 꺼 두었으면(`app.device.enabled=false`) 이 API는 코드를 만들지 않고 **200 `{ "appEnabled": false }`**로
  응답한다(403이 아니다). 웹의 "태블릿 연결" 메뉴는 늘 보이며, 꺼져 있으면 "이 기관은 태블릿 연결을 사용하지 않습니다." 안내와 함께
  QR 만들기만 숨기고 내 기기 목록·`사용 중지`는 그대로 쓸 수 있다.

### 0.2 연결 `POST /devices/pair`

인증 없음(익명). 코드가 곧 자격이다.

```json
요청 {
  "pairingCode": "K7Q2-M9XD",   // 정규화 전 값도 허용(서버가 정규화)
  "device": { "id": "기기가 만든 UUID", "name": "연구실 iPad", "platform": "ios|android|web",
              "model": "iPad14,5", "appVersion": "0.1.0" }
}
응답 200 {                         // §1 /devices/register 와 같은 형식
  "token": "…", "tokenExpiresAt": "…Z", "offlineGraceDays": 14,
  "user": { "userMno": 12, "loginId": "researcher1", "name": "김연구" },
  "serverTime": "…"
}
```

오류:

| 상태 | 코드 | 의미 |
|---|---|---|
| 400 | `BAD_REQUEST` | 요청 형식 오류 — 본문이 없거나 `device`가 아래 규칙에 맞지 않음. 코드를 소비하지 않고 실패 횟수에 넣지 않는다 |
| 401 | `INVALID_PAIRING_CODE` | 코드가 없거나 만료되었거나 이미 사용됨(무효화된 코드 포함). `pairingCode`가 비었거나 형식이 틀린 값(8자가 아님 등)도 400이 아니라 이 오류이며 **실패 1회로 센다**. 이유는 구분해 알려 주지 않는다 |
| 403 | `APP_DISABLED` | 기관이 태블릿 연결을 끔 |
| 403 | `DEVICE_NOT_ALLOWED` | **예약** — 이 기기는 연결할 수 없음(기관 정책). 이때 코드는 소비하지 않는다. 구노 서버는 아직 보내지 않는다(이번 단계에는 기기 차단 목록이 없다. 모의 서버만 `blockedDeviceIds`로 흉내 낸다) |
| 429 | `TOO_MANY_ATTEMPTS` | 실패가 너무 많음. `Retry-After` 헤더(초)가 풀릴 때까지의 시간 |

- **기기 정보(`device`) 규칙** (서버 DDL `PL_APP_DEVICE`의 길이): `id` 필수·64자 이하, `name` 필수·100자 이하, `platform` 필수·
  20자 이하, `model` 선택·100자 이하, `appVersion` 선택·30자 이하. 필수 값이 없거나 공백뿐이거나 길이를 넘으면 400 `BAD_REQUEST`
  (`/devices/register`도 같다).
- **평가 순서**: 403 `APP_DISABLED` → 400 `BAD_REQUEST`(요청 형식 오류) → 429 `TOO_MANY_ATTEMPTS` → 401 `INVALID_PAIRING_CODE`
  → 403 `DEVICE_NOT_ALLOWED`(예약) → 200(코드 소비 + 기기 묶음 upsert + 토큰 발급).
- **연결 실패 제한**: **같은 IP에서 10분 안에 5번 실패하면 429.** 실패는 `INVALID_PAIRING_CODE`와 §1 `/devices/register`의
  `INVALID_CREDENTIALS`이며, 두 엔드포인트가 **같은 IP별 횟수를 공유**한다(설계 §7.1). 막혀 있는 동안은 맞는 코드도 429이고, 429 응답 자체는 실패 횟수를 늘리지 않는다. `Retry-After`는
  가장 오래된 실패가 10분 창에서 빠질 때까지 남은 초다. (틀린 코드는 어느 코드의 시도인지 알 수 없으므로
  코드 단위가 아니라 IP 단위로 제한한다 — 설계 §7.1이 정한 "틀린 시도 5회면 폐기"의 구현 방식.)
  **성공해도 실패 횟수를 지우지 않는다**(`/devices/pair`·`/devices/register` 모두). 계정이 있는 사용자가 자기 코드로 연결에 성공해
  횟수를 되돌리며 추측을 이어 가지 못하게 하기 위해서다. 실패는 10분 창에서 저절로 빠진다.
- **클라이언트 IP**: 직접 연결한 상대(peer)가 같은 서버의 리버스 프록시(루프백 주소 127.0.0.0/8·::1)일 때만 `X-Real-IP`를
  쓰고(IP 리터럴일 때만), 그 밖에는 peer 주소를 쓴다(다른 곳에서 보낸 이 헤더는 무시). `X-Forwarded-For`는 **쓰지 않는다**(첫
  값을 클라이언트가 정할 수 있다). nginx는 `proxy_set_header X-Real-IP $remote_addr;`로 이 값을 덮어쓴다.
  실패 횟수는 서버 인스턴스의 메모리에 둔다 — 인스턴스가 여러 개인 기관은 인스턴스마다 따로 센다.
- **기기 묶음**: 서버의 기기 기록은 **(기기 ID, 사용자)** 단위. 같은 사용자가 같은 기기를 다시 연결하면 토큰만 새로 발급. 다른 사용자가 같은 기기를 연결하면 새 묶음이 생기고, 이전 사용자의 "기기에서 작성 중" 노트는 웹에서 편집권 회수로 정리한다.
  따라서 노트의 편집권(`editLocation.deviceId`)은 **그 노트의 주인 + 그 기기**에게만 있다. 같은 기기를 다른
  사용자가 연결해도 남의 노트를 올리거나 반납할 수 없다 — 노트 주인이 토큰의 사용자가 아니면 404 `NOT_FOUND`
  (남의 노트는 있는지도 알려 주지 않는다). 409 `NOT_EDIT_OWNER`는 내 노트인데 편집 위치가 이 (기기, 사용자) 묶음이 아닐 때다.
- **다시 연결**: 토큰 만료(`TOKEN_EXPIRED`)·기기 사용 중지(`DEVICE_REVOKED`) 모두 앱의 "다시 연결" 버튼으로
  새 QR을 읽는다. 같은 사용자가 같은 기기를 다시 연결하면 그 묶음의 이전 토큰은 즉시 무효가 되고(새 토큰만 유효), 사용 중지된 묶음이면 사용 중지도 풀린다(사용 중지한 기기도 새 QR로 다시 연결하면 다시 사용 상태가 된다).
  같은 계정이면 앱은 기기 데이터를 이어 쓰고, 다른 계정이면 올리지 않은 기록이 있는 한 거부한다(앱 규칙).

## 1. 기기 등록 `POST /devices/register` (보조 경로)

인증 없음. 구노 계정의 아이디·비밀번호로 기기 토큰을 받는다. **서버 설정
`app.device.password-login.enabled`가 켜졌을 때만** 동작하며, 꺼져 있으면 403 `PASSWORD_LOGIN_DISABLED`.
운영 서버의 기본값은 꺼짐이고, 앱의 비밀번호 화면도 개발·체험 빌드(`ALLOW_DEMO`)에만 보인다.

```json
요청 {
  "loginId": "researcher1",
  "password": "…",
  "device": { "id": "기기가 만든 UUID", "name": "연구실 iPad", "platform": "ios|android|web",
              "model": "iPad14,5", "appVersion": "0.1.0" }
}
응답 200 {
  "token": "…",                       // 불투명 문자열. 서버는 해시만 저장
  "tokenExpiresAt": "2026-10-13T…Z",  // = 오프라인 편집 허용 기한
  "offlineGraceDays": 14,
  "user": { "userMno": 12, "loginId": "researcher1", "name": "김연구" },
  "serverTime": "…"
}
```
오류: 400 `BAD_REQUEST`(요청 형식 오류 — `loginId`·`password`가 없거나 `device`가 §0.2 규칙에 맞지 않음), 401 `INVALID_CREDENTIALS`, 403 `APP_DISABLED`, 403 `PASSWORD_LOGIN_DISABLED`,
403 `DEVICE_NOT_ALLOWED`(예약 — §0.2), 429 `TOO_MANY_ATTEMPTS`(+ `Retry-After` 초)

평가 순서: 403 `APP_DISABLED` → 403 `PASSWORD_LOGIN_DISABLED` → 400 `BAD_REQUEST` → 429 → 401 `INVALID_CREDENTIALS` → 403 `DEVICE_NOT_ALLOWED`(예약) → 200.
`INVALID_CREDENTIALS`는 §0.2의 IP별 실패 횟수(5회/10분)에 **같은 통에 합산**되고, 막히면 `/devices/pair`와 `/devices/register` 모두 429다.
기기 묶음 규칙은 §0.2와 같다.

## 2. 토큰 갱신 `POST /devices/refresh`

온라인일 때마다(동기화 시작마다) 호출해 기한을 연장한다. 응답은 등록과 같은 형식(user 제외).
오류: 401 `TOKEN_EXPIRED`(다시 연결), 401 `DEVICE_REVOKED`(분실 등으로 폐기됨 — 앱은 편집을 잠근다), 401 `UNAUTHORIZED`(알 수 없는 토큰)

- **매번 새 토큰으로 바꾼다.** 보낸(이전) 토큰은 **10분 동안, 또는 새 토큰으로 첫 요청이 올 때까지** 함께 받는다. 갱신 응답을
  받지 못한 앱이 이전 토큰으로 다음 요청을 하거나 다시 갱신해도 401이 되지 않는다(재시도 안전). 유예 중인 이전 토큰으로 다시
  갱신하면 서버는 새 토큰을 또 발급하고(응답을 못 받은 쪽 토큰은 버려진다) 이전 토큰의 유예 기한은 늘리지 않는다.
- 10분이 지났거나 새 토큰을 이미 쓴 뒤의 이전 토큰은 401 `UNAUTHORIZED`. 기기를 `사용 중지`하면 유예가 끝나고 현재·이전 토큰
  모두 401 `DEVICE_REVOKED`. 다시 연결(QR)하면 이전 토큰은 지워진다.

## 3. 기준 정보 `GET /bootstrap`

```json
{ "user": {…},
  "projects": [ { "projectMno": 3, "name": "시료 A 열처리", "writable": true } ],
  "policy": { "offlineGraceDays": 14, "maxImageBytes": 52428800 },
  "serverTime": "…" }
```

## 4. 노트 상태 `GET /notes`

이 사용자의 노트 중 이 기기가 만들었거나 편집 위치가 이 (기기, 사용자) 묶음인 노트. 다른 사용자의 노트는 넣지 않는다.
응답의 `editLocation.deviceId`는 기기 UUID(`PL_APP_DEVICE.DEVICE_ID`)로, 서버는 `EDIT_DEVICE_MNO`를 조인해 채운다.

```json
{ "notes": [ {
    "noteMno": 101, "clientNoteId": "…", "title": "…", "projectMno": 3,
    "status": "WRITING|INSPECTION|COMPLETE|REJECT",
    "editLocation": { "type": "DEVICE", "deviceId": "…" },   // 또는 { "type": "WEB" }
    "latestVersionId": 5007, "updatedAt": "…" } ] }
```

## 5. 노트 생성 `POST /notes`

```json
요청 { "clientNoteId": "…", "projectMno": 3, "title": "…", "deviceCreatedAt": "…" }
응답 201 { "noteMno": 101, "status": "WRITING", "editLocation": { "type": "DEVICE", "deviceId": "…" } }
```
- `clientNoteId` 필수·64자 이하, `projectMno` 필수 — 없거나 넘으면 400 `BAD_REQUEST`.
- `title`은 선택. 앞뒤 공백을 지우고, 비면 "제목 없음", 256자를 넘으면 256자로 자른다.
- `deviceCreatedAt`은 받기만 하고 저장하지 않는다(참고 값).
- **멱등은 노트 주인 단위**: 같은 사용자가 같은 `clientNoteId`로 다시 보내면 200과 기존 값. 다른 사용자의 `clientNoteId`와는 겹쳐도
  상관없다. 웹에서 **삭제한 노트**의 `clientNoteId`로 다시 오면 그 노트의 `noteMno`를 200으로 돌려주고, 그 노트의 이후 버전·반납은
  404 `NOT_FOUND`다 — 되살아나지 않는 끝 상태이므로 앱은 그 노트의 전송을 멈춘다(앱은 404를 노트 단위 거부로 처리한다).
- 오류: 400 `BAD_REQUEST`, 403 `PROJECT_NOT_WRITABLE`(프로젝트 참여자가 아니거나 편집할 수 없는 프로젝트 — 새로 만들 때만 본다)

서버 구현: 작성 방식 `EDITOR`로 노트를 만들고 편집 위치를 이 기기로 둔다.

## 6. 버전 올리기 `POST /notes/{noteMno}/versions`

`multipart/form-data`:

| 필드 | 내용 |
|---|---|
| `meta` | JSON `{ "clientVersionId"(필수·64자 이하), "baseVersionId" (직전에 서버가 받은 버전, 첫 버전은 null), "deviceWrittenAt", "contentHash"(필수), "autoSave", "title" }` — `title`이 있으면 노트 제목을 그 값으로 바꾼다(앱에서 제목을 고친 경우. §5처럼 다듬고 256자에서 자른다) |
| `noteContent` | 노트 HTML. 태블릿 앱은 손글씨 블록 하나 `<figure class="rw-drawing" data-strokes="{title,strokes,layout}" data-drawing-sha256="…">` 안에 페이지마다 `<img src="blob:goono-app/{ref}">` (웹 구노 editor-ai 의 손글씨 블록과 같은 형식) |
| `inlineImages[blob:goono-app/{ref}]` | 이미지 파일 (여러 개) |

- 201 `{ "versionId": 5008, "receivedAt": "…" }`
- 200 `{ …, "duplicate": true }` — 같은 `clientVersionId`를 이 노트에서 이미 받음(재전송 안전. 편집권 회수·반납·점검 요청 뒤의
  재전송도 200)

**평가 순서** (노트 행을 잠근 한 트랜잭션. 앞의 검사에 걸리면 뒤는 보지 않는다):

1. 400 `BAD_REQUEST` — multipart가 아님(노트를 보기 전). multipart 전체가 서버의 multipart 상한을 넘으면 413 `TOO_LARGE`
2. 404 `NOT_FOUND` — 노트가 없거나 삭제됐거나 노트 주인이 토큰의 사용자가 아님(남의 노트). 상태·편집 위치를 알려 주지 않는다
3. 400 `BAD_REQUEST` — `meta`가 없거나 JSON 객체가 아님, `clientVersionId`(64자 이하)·`contentHash`가 없음, `baseVersionId`가
   정수·null이 아님, `noteContent` 없음
4. 같은 `clientVersionId`를 이미 받음 → 이 노트의 버전이면 200 `duplicate`. **다른 노트의 버전이면 400 `BAD_REQUEST`**,
   이 노트의 버전인데 `contentHash`가 다르면(같은 아이디로 다른 내용) **400 `INVALID_REQUEST`**
5. 409 `NOT_EDIT_OWNER` — 내 노트지만 편집 위치가 이 기기가 아님(회수·반납됨). 앱은 이 버전을 미반영 기록으로 보관
6. 409 `NOT_WRITABLE` — 작성 중·반려가 아님(점검 요청·완료), 에디터 노트가 아님, 프로젝트가 편집할 수 없는 상태
7. 409 `STALE_BASE` — `baseVersionId`가 서버 최신 버전과 다름
8. 413 `TOO_LARGE` — `meta` + `noteContent` + 모든 이미지 바이트의 **합**이 서버 상한(`app.device.max-upload-bytes`, 기본 50 MiB =
   `/bootstrap`의 `policy.maxImageBytes`)을 넘음
9. 400 `INVALID_REQUEST` — 파일 필드 이름이 `inlineImages[blob:goono-app/{ref}]`가 아니거나 ref가 `^[A-Za-z0-9-]{16,64}$`가 아님
10. 422 `HASH_MISMATCH` — 전송 중 손상
11. 400 `INVALID_REQUEST` — 이 노트에 같은 ref의 이미지가 이미 저장돼 있는데 바이트가 다름(앞 버전의 이미지를 덮어쓰지 않는다.
    바이트가 같으면 다시 저장하지 않고 그 파일을 가리킨다)

409 응답 본문은 `{ "error": { … } }`뿐이다(상태·편집 위치·최신 버전 같은 다른 필드는 없다). 앱은 409 본문의 다른 필드에 기대지
않고 다음 동기화의 `GET /notes`로 상태를 맞춘다. 모의 서버도 같은 본문을 보낸다.

**내용 해시** (`contentHash`, 소문자 hex SHA-256):
`SHA-256( UTF-8(noteContent) ‖ ⨁ over images sorted by ref: "\n" + ref + ":" + hex(SHA-256(image bytes)) )`

서버 구현: 해시를 검증한 뒤 이미지 주소 `blob:goono-app/{ref}`를 `blob:goono-app/{noteMno}-{ref}`로 바꿔(이미지 파일이 한
디렉터리에 모이므로 노트끼리 이름이 겹치지 않게) 웹 저장과 같은 `createNoteEditorDtl`로 저장한다(`img[src*="blob:"]` 치환 규칙이
같다). 노트 이력은 남기고 사용자 알림·웹 푸시는 보내지 않는다. 버전 행에 `SOURCE_CCD=APP`, `DEVICE_MNO`, `DEVICE_WRITTEN_DT`,
`CLIENT_VERSION_ID`, `CONTENT_HASH`를 추가로 남긴다. 연구노트 지침의 "입력 일시 자동 기록"은 서버 수신 시각으로 충족하고,
기기 작성 시각은 함께 표시한다. (모의 서버는 이미지를 임의 파일명으로 저장하지만 같은 ref의 다른 이미지 거부는 같다.)

## 7. 작성 완료(편집권 반납) `POST /notes/{noteMno}/release`

```json
요청 { "lastVersionId": 5008 }
응답 200 { "status": "WRITING", "editLocation": { "type": "WEB" } }
```
오류: 400 `BAD_REQUEST`(본문 없음·`lastVersionId`가 정수·null이 아님), 404 `NOT_FOUND`(노트가 없거나 남의 노트 — §6과 같음),
409 `NOT_EDIT_OWNER`(내 노트지만 편집 위치가 이 기기가 아님), 409 `VERSION_MISMATCH`(서버 최신 버전이 다름 — 아직 안 올라간 버전이 있음).
이 순서로 본다(편집 위치를 버전 비교보다 먼저). 409 본문은 `{ "error": { … } }`뿐이다.

- 성공하면 노트 이력에 `편집권 반납`(내용 = 노트 제목, 대상 = 이 기기)이 남는다. 사용자 알림은 없다.
- **재시도에 안전하지 않다**: 서버에서 반납이 끝났는데 응답을 잃은 뒤 같은 요청을 다시 보내면 편집 위치가 이미 `WEB`이라
  409 `NOT_EDIT_OWNER`다. 앱은 응답을 못 받으면 그 동기화를 멈추고, 다음 동기화의 `GET /notes`에서 편집 위치 `WEB`과
  `latestVersionId`가 자기가 올린 마지막 버전과 같음을 보고 "반납 완료"로 정리한다(회수로 보지 않는다).

이후 웹에서 기존 절차로 점검 요청(점검자 지정 포함)을 한다. 앱에서는 읽기 전용이 된다.

## 서버 쪽 추가 규칙 (Goono-ELN)

- 편집 위치가 `DEVICE`인 노트: 웹 에디터는 읽기 전용으로 열고 "○○ 기기에서 작성 중 · 마지막 동기화
  시각"을 표시한다. **점검 요청 API는 거부**한다.
- 편집권 회수: 노트 주인 또는 관리자가 사유(200자 이하)를 남기고 `WEB`으로 되돌릴 수 있다(기기 분실 등). 노트 이력에 `편집권 회수`.
  이후 그 기기의 버전 업로드는 409 `NOT_EDIT_OWNER`. 같은 기기를 다른 사용자가 연결해도 이전 사용자의 기기 작성 중 노트는
  자동으로 회수되지 않는다(주인·관리자가 회수할 때까지 기기 작성 중).
- 편집 위치가 `DEVICE`인 노트는 작성자 위임(단건·직번변경 일괄)도 거부한다.
- 기기 관리: 사용자별 등록 기기 목록과 토큰 폐기(`DEVICE_REVOKED`). 기관이 기능을 꺼도 목록·폐기는 쓸 수 있다.

## DB 변경안

| 테이블 | 컬럼 | 설명 |
|---|---|---|
| `PL_ELN_NOTE` | `EDIT_LOCATION_CCD` (`WEB`/`DEVICE`), `EDIT_DEVICE_MNO`(→ `PL_APP_DEVICE.DEVICE_MNO`), `CREATE_DEVICE_MNO`(만든 기기), `CLIENT_NOTE_ID`, `UNIQUE(OWNER_MNO, CLIENT_NOTE_ID)` | 편집 위치. 편집하는 곳은 (기기, 사용자) 묶음이므로 기기 ID 문자열이 아니라 대리키를 가리킨다 |
| `PL_ELN_NOTE_EDITOR` | `SOURCE_CCD` (`WEB`/`APP`), `DEVICE_MNO`(→ `PL_APP_DEVICE.DEVICE_MNO`, 기기 ID 문자열이 아님), `DEVICE_WRITTEN_DT`, `CLIENT_VERSION_ID`(유니크), `CONTENT_HASH` | 버전 출처 |
| 신규 `PL_APP_DEVICE` | `DEVICE_MNO`(PK, 대리키), `DEVICE_ID`, `USER_MNO`, `DEVICE_NM`, `PLATFORM`, `MODEL`, `APP_VERSION`, `TOKEN_HASH`(유니크), `TOKEN_EXPIRES_DT`, `PREV_TOKEN_HASH`·`PREV_TOKEN_VALID_UNTIL`(§2 갱신 유예), `REVOKED_YN`, `REVOKED_DT`, `LAST_SEEN_DT`, `CREATE_DT`, `MODIFY_DT`, `UNIQUE(DEVICE_ID, USER_MNO)` | 기기. 같은 물리 기기를 다른 사용자가 연결하면 행이 하나 더 생긴다 |
| 신규 `PL_APP_PAIRING_CODE` | `CODE_HASH`(PK, 정규화한 코드의 해시), `USER_MNO`, `EXPIRES_DT`, `USED_DT`, `CREATE_DT` | 연결 코드(일회용·5분). 같은 사용자가 새 코드를 받으면 그 사용자의 미사용 행과 만료된 행을 **지운다**(무효화). 따로 도는 정리 작업은 아직 없다 — 사용된 행은 그 사용자가 다음에 코드를 받을 때(만료 뒤) 지워진다. 발급 시 `CODE_HASH`가 중복(PK 충돌)되면 코드를 다시 생성한다 |

연결 실패 횟수(IP 단위 5회/10분, `/devices/pair`·`/devices/register` 공유)는 DB에 두지 않고 서버 인스턴스의 메모리에 둔다
(인스턴스가 여러 개면 인스턴스마다 따로 센다 — §0.2).
서버 설정: `app.base-url`(QR의 `server` 값 — 비면 요청 URL로 만들고 경고 로그), `app.device.enabled`(기관의 태블릿 연결 사용 여부),
`app.device.password-login.enabled`(기본 꺼짐).
