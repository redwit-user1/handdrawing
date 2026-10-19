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
- 오류 본문: `{ "error": { "code": "…", "message": "…" } }`
- 기관이 태블릿 연결을 꺼 두었으면(`app.device.enabled=false`) **모든 `/api/app/v1` 요청**이 403 `APP_DISABLED`일 수
  있다(연결·갱신·동기화 모두). 앱은 이 코드를 받으면 연결 안내 문구를 보여 준다. 동기화 중이면 그 자리에서 멈추고
  올리지 않은 버전은 대기 그대로 둔다(미반영으로 돌리지 않는다).
- 시각: ISO-8601 (UTC). 서버 시각이 기준이며 기기 시각은 참고 값으로만 저장한다.
- CORS: 앱 웹뷰 오리진 `capacitor://localhost`(iOS), `https://localhost`(Android)를 허용한다. 앱이 429의 `Retry-After`를
  읽을 수 있게 `Access-Control-Expose-Headers: Retry-After`를 보낸다.

## 0. 연결(QR) — 기본 경로

앱은 비밀번호를 받지 않는다. 구노 웹에 로그인한 사용자가 **일회용 연결 코드**(QR)를 띄우고, 태블릿이
그것을 읽어 기기 토큰을 받는다. 계정 비밀번호가 태블릿을 거치지 않고, SSO·2단계 인증을 쓰는 기관도
같은 방식으로 연결된다.

### 0.1 연결 코드 발급 `POST /api/eln/app/pairing-code` (웹 · 로그인 세션)

웹 화면(내 설정 ▸ 태블릿 연결)에서 부른다. 기존 웹 로그인 세션·CSRF 규칙을 그대로 따르며 본문은 없다.

```json
응답 200 {
  "code": "K7Q2-M9XD",
  "qrPayload": "goono-note://pair?server=https%3A%2F%2Feln.example.com&code=K7Q2-M9XD",
  "expiresAt": "2026-10-18T09:05:00Z"
}
```

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
- 기관이 태블릿 연결을 꺼 두었으면(`app.device.enabled=false`) 이 API는 403 `APP_DISABLED`로 거부한다(웹은 메뉴를 숨긴다).

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
| 400 | `BAD_REQUEST` | 요청 형식 오류(`device.id` 없음 등). 실패 횟수에 넣지 않는다 |
| 401 | `INVALID_PAIRING_CODE` | 코드가 없거나 만료되었거나 이미 사용됨(무효화된 코드 포함). `pairingCode`가 비었거나 형식이 틀린 값(8자가 아님 등)도 400이 아니라 이 오류이며 **실패 1회로 센다**. 이유는 구분해 알려 주지 않는다 |
| 403 | `APP_DISABLED` | 기관이 태블릿 연결을 끔 |
| 403 | `DEVICE_NOT_ALLOWED` | **예약** — 이 기기는 연결할 수 없음(기관 정책). 이때 코드는 소비하지 않는다. 구노 서버는 아직 보내지 않는다(이번 단계에는 기기 차단 목록이 없다. 모의 서버만 `blockedDeviceIds`로 흉내 낸다) |
| 429 | `TOO_MANY_ATTEMPTS` | 실패가 너무 많음. `Retry-After` 헤더(초)가 풀릴 때까지의 시간 |

- **평가 순서**: 403 `APP_DISABLED` → 400 `BAD_REQUEST`(요청 형식 오류) → 429 `TOO_MANY_ATTEMPTS` → 401 `INVALID_PAIRING_CODE`
  → 403 `DEVICE_NOT_ALLOWED`(예약) → 200(코드 소비 + 기기 묶음 upsert + 토큰 발급).
- **연결 실패 제한**: **같은 IP에서 10분 안에 5번 실패하면 429.** 실패는 `INVALID_PAIRING_CODE`와 §1 `/devices/register`의
  `INVALID_CREDENTIALS`이며, 두 엔드포인트가 **같은 IP별 횟수를 공유**한다(설계 §7.1). 막혀 있는 동안은 맞는 코드도 429이고, 429 응답 자체는 실패 횟수를 늘리지 않는다. `Retry-After`는
  가장 오래된 실패가 10분 창에서 빠질 때까지 남은 초다. (틀린 코드는 어느 코드의 시도인지 알 수 없으므로
  코드 단위가 아니라 IP 단위로 제한한다 — 설계 §7.1이 정한 "틀린 시도 5회면 폐기"의 구현 방식.)
- **클라이언트 IP**: 직접 연결한 상대(peer)가 같은 서버의 리버스 프록시(루프백 주소)일 때만 `X-Real-IP` 또는
  `X-Forwarded-For`의 첫 값을 쓰고, 그 밖에는 peer 주소를 쓴다(다른 곳에서 보낸 이 헤더는 무시).
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
오류: 400 `BAD_REQUEST`(요청 형식 오류 — `device.id` 없음 등), 401 `INVALID_CREDENTIALS`, 403 `APP_DISABLED`, 403 `PASSWORD_LOGIN_DISABLED`,
403 `DEVICE_NOT_ALLOWED`(예약 — §0.2), 429 `TOO_MANY_ATTEMPTS`(+ `Retry-After` 초)

평가 순서: 403 `APP_DISABLED` → 403 `PASSWORD_LOGIN_DISABLED` → 400 `BAD_REQUEST` → 429 → 401 `INVALID_CREDENTIALS` → 403 `DEVICE_NOT_ALLOWED`(예약) → 200.
`INVALID_CREDENTIALS`는 §0.2의 IP별 실패 횟수(5회/10분)에 **같은 통에 합산**되고, 막히면 `/devices/pair`와 `/devices/register` 모두 429다.
기기 묶음 규칙은 §0.2와 같다.

## 2. 토큰 갱신 `POST /devices/refresh`

온라인일 때마다 호출해 기한을 연장한다. 응답은 등록과 같은 형식(user 제외).
오류: 401 `TOKEN_EXPIRED`(다시 연결), 401 `DEVICE_REVOKED`(분실 등으로 폐기됨 — 앱은 편집을 잠근다)

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
같은 `clientNoteId`로 다시 오면 200과 기존 값(멱등). 오류: 403 `PROJECT_NOT_WRITABLE`

서버 구현: 작성 방식 `EDITOR`로 노트를 만들고 편집 위치를 이 기기로 둔다.

## 6. 버전 올리기 `POST /notes/{noteMno}/versions`

`multipart/form-data`:

| 필드 | 내용 |
|---|---|
| `meta` | JSON `{ "clientVersionId", "baseVersionId" (직전에 서버가 받은 버전, 첫 버전은 null), "deviceWrittenAt", "contentHash", "autoSave", "title" }` — `title`이 있으면 노트 제목을 그 값으로 바꾼다(앱에서 제목을 고친 경우) |
| `noteContent` | 노트 HTML. 태블릿 앱은 손글씨 블록 하나 `<figure class="rw-drawing" data-strokes="{title,strokes,layout}" data-drawing-sha256="…">` 안에 페이지마다 `<img src="blob:goono-app/{ref}">` (웹 구노 editor-ai 의 손글씨 블록과 같은 형식) |
| `inlineImages[blob:goono-app/{ref}]` | 이미지 파일 (여러 개) |

- 201 `{ "versionId": 5008, "receivedAt": "…" }`
- 200 `{ …, "duplicate": true }` — 같은 `clientVersionId`를 이미 받음(재전송 안전)
- 404 `NOT_FOUND` — 노트가 없거나 노트 주인이 토큰의 사용자가 아님(남의 노트). 상태·편집 위치를 본문에 넣지 않는다
- 409 `NOT_EDIT_OWNER` — 내 노트지만 편집권이 이 기기에 없음(회수됨). 앱은 이 버전을 미반영 기록으로 보관
- 409 `NOT_WRITABLE` — 점검 요청·완료된 노트
- 409 `STALE_BASE` — `baseVersionId`가 서버 최신 버전과 다름
- 422 `HASH_MISMATCH` — 전송 중 손상
- 413 `TOO_LARGE`

**내용 해시** (`contentHash`, 소문자 hex SHA-256):
`SHA-256( UTF-8(noteContent) ‖ ⨁ over images sorted by ref: "\n" + ref + ":" + hex(SHA-256(image bytes)) )`

서버 구현: 해시를 검증한 뒤 `createNoteEditorDtl(noteMno, noteContent, autoSaveYn, inlineImages)`를
그대로 호출한다(`img[src*="blob:"]` 치환 규칙이 같다). 버전 행에 `SOURCE=APP`, `DEVICE_ID`,
`DEVICE_WRITTEN_DT`, `CLIENT_VERSION_ID`, `CONTENT_HASH`를 추가로 남긴다. 연구노트 지침의
"입력 일시 자동 기록"은 서버 수신 시각으로 충족하고, 기기 작성 시각은 함께 표시한다.

## 7. 작성 완료(편집권 반납) `POST /notes/{noteMno}/release`

```json
요청 { "lastVersionId": 5008 }
응답 200 { "status": "WRITING", "editLocation": { "type": "WEB" } }
```
오류: 404 `NOT_FOUND`(노트가 없거나 남의 노트 — §6과 같음), 409 `VERSION_MISMATCH`(서버 최신 버전이 다름 — 아직 안 올라간 버전이 있음),
409 `NOT_EDIT_OWNER`(내 노트지만 편집 위치가 이 기기가 아님)

이후 웹에서 기존 절차로 점검 요청(점검자 지정 포함)을 한다. 앱에서는 읽기 전용이 된다.

## 서버 쪽 추가 규칙 (Goono-ELN)

- 편집 위치가 `DEVICE`인 노트: 웹 에디터는 읽기 전용으로 열고 "○○ 기기에서 작성 중 · 마지막 동기화
  시각"을 표시한다. **점검 요청 API는 거부**한다.
- 편집권 회수: 노트 주인 또는 관리자가 사유를 남기고 `WEB`으로 되돌릴 수 있다(기기 분실 등).
  이후 그 기기의 버전 업로드는 409 `NOT_EDIT_OWNER`.
- 기기 관리: 사용자별 등록 기기 목록과 토큰 폐기(`DEVICE_REVOKED`).

## DB 변경안

| 테이블 | 컬럼 | 설명 |
|---|---|---|
| `PL_ELN_NOTE` | `EDIT_LOCATION_CCD` (`WEB`/`DEVICE`), `EDIT_DEVICE_MNO`(→ `PL_APP_DEVICE.DEVICE_MNO`), `CLIENT_NOTE_ID` | 편집 위치. 편집하는 곳은 (기기, 사용자) 묶음이므로 기기 ID 문자열이 아니라 대리키를 가리킨다 |
| `PL_ELN_NOTE_EDITOR` | `SOURCE_CCD` (`WEB`/`APP`), `DEVICE_ID`, `DEVICE_WRITTEN_DT`, `CLIENT_VERSION_ID`(유니크), `CONTENT_HASH` | 버전 출처 |
| 신규 `PL_APP_DEVICE` | `DEVICE_MNO`(PK, 대리키), `DEVICE_ID`, `USER_MNO`, `NAME`, `PLATFORM`, `MODEL`, `APP_VERSION`, `TOKEN_HASH`, `TOKEN_EXPIRES_DT`, `REVOKED_YN`, `LAST_SEEN_DT`, `UNIQUE(DEVICE_ID, USER_MNO)` | 기기. 같은 물리 기기를 다른 사용자가 연결하면 행이 하나 더 생긴다 |
| 신규 `PL_APP_PAIRING_CODE` | `CODE_HASH`(PK, 정규화한 코드의 해시), `USER_MNO`, `EXPIRES_DT`, `USED_DT`, `CREATE_DT` | 연결 코드(일회용·5분). 새 코드 발급 시 같은 `USER_MNO`의 `USED_DT IS NULL` 행은 `EXPIRES_DT`를 현재로 당겨 무효화. 만료·사용된 행은 주기적으로 삭제. 발급 시 `CODE_HASH`가 중복(PK 충돌)되면 코드를 다시 생성한다 |

연결 실패 횟수(IP 단위 5회/10분, `/devices/pair`·`/devices/register` 공유)는 DB에 두지 않고 서버 인스턴스의 메모리에 둔다
(인스턴스가 여러 개면 인스턴스마다 따로 센다 — §0.2).
서버 설정: `app.base-url`(QR의 `server` 값 — 비면 요청 URL로 만들고 경고 로그), `app.device.enabled`(기관의 태블릿 연결 사용 여부),
`app.device.password-login.enabled`(기본 꺼짐).
