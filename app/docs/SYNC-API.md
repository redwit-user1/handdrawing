# 태블릿 앱 ↔ 구노 ELN 동기화 API (v1)

구노 연구노트 태블릿 앱(`app/`)이 오프라인에서 작성한 노트를 구노 ELN에 올리는 계약이다.
Goono-ELN 서버 구현의 기준이며, 개발·테스트용 구현은 `app/mock-server/`에 있다
(계약 = 서버 동작 = 모의 서버 = 앱 안 체험 서버 `app/src/lib/demo.ts`. 체험 서버만 코드 검사 없이 곧바로 승인한다).

## 원칙

1. **내용은 단방향** — 노트 내용은 앱 → ELN으로만 올라간다. ELN → 앱은 기준 정보(연결된 과제, 노트 상태, 편집 위치)만
   내려준다. 서버는 기기에 노트 내용·획 데이터를 보내지 않는다.
2. **연결은 과제 단위** — 기기는 **(기기, 연구원, 과제)** 단위로 연결된다. 연구책임자가 과제 화면에서 구성원 한 명에게
   그 과제 전용 1회용 QR을 만들고, 연구원 **본인이 구노 웹에서 승인**해야 연결된다. 기기는 연결된 과제에만 노트를 만들고 올릴
   수 있다. 기기·연구원 단위 토큰은 그대로 두고, 모든 노트·버전 API가 그 과제 연결이 활성인지 본다.
3. **편집 위치는 하나** — 노트마다 편집할 수 있는 곳은 웹(`WEB`) 또는 특정 기기(`DEVICE`) 하나다.
   앱에서 만든 노트는 만든 기기가 편집 위치다. 동시 편집은 없다. 연결이 끊기면 그 연결로 작성 중이던 노트의 편집 위치는
   자동으로 `WEB`으로 돌아온다(§0.12).
4. **점검 전 누락 없음** — 편집 위치가 `DEVICE`인 노트는 웹에서 점검 요청할 수 없다. 앱이 "작성
   완료"로 모든 버전을 올리고 편집권을 웹에 넘긴 뒤에만 점검 요청이 가능하다. 시점인증은 기존대로
   점검 시 수행되고, 점검 요청 이후에는 어디서도 수정할 수 없다.
5. **덮어쓰기 없음** — 버전은 쌓기만 한다. 서버가 받지 않은 기기 작성분은 앱이 "미반영 기록"으로
   보관한다(버리지 않는다). 연결이 끊긴 과제의 올리지 않은 기록도 미반영으로 남는다.
6. **저장 형식은 웹과 동일** — 본문은 editor-ai HTML(손글씨는 `figure.rw-drawing[data-strokes]`).
   이미지는 기존 `/api/eln/note/editor/saveEditor`와 같은 `blob:` 치환 규칙으로 보내므로
   `ElnNoteEditorService.createNoteEditorDtl`을 그대로 재사용할 수 있다. 바뀌지 않은 페이지 그림은 다시 보내지 않고
   앞 버전의 파일을 가리킨다(§6 `reusedRefs`).

## 공통

- 기본 경로: `{서버}/api/app/v1`
- 인증: `Authorization: Bearer {기기 토큰}`. 예외 — 익명: 연결 경로 `/devices/pair/preview`·`/devices/pair`·`/devices/pair/status`·
  `/devices/pair/cancel`(요청 토큰이 본문에 있다)과 기기 등록 `/devices/register`. `/devices/reauth`는 Bearer 토큰을 받지만 **기한이
  지난 토큰도 허용**한다(§0.10). 웹 로그인 세션과 **분리**한다 — 웹의 동시 세션 1개 제한(`maximumSessions(1)`)에 걸리지 않게 별도
  필터 체인으로 처리.
- 오류 본문: `{ "error": { "code": "…", "message": "…" } }` — 이 문서의 오류 코드는 모두 이 형식이다. 다만 경로·메서드가
  없는 요청(매핑되지 않은 404, 405)은 서버(Spring) 기본 응답이라 이 형식이 아닐 수 있다. 앱은 본문에 `error`가 없으면
  `HTTP_{상태}`로 다룬다.
- **승인 대기는 오류가 아니다** — 연결 요청·재인증은 202 `{ "status": "PENDING", … }`, 상태 확인은 200 `{ "status": "PENDING", … }`로
  알린다.
- `400 BAD_REQUEST`와 `400 INVALID_REQUEST`의 구분: `BAD_REQUEST`는 **요청 형식이 틀림**(필수 값 없음·길이 초과·JSON·multipart가
  아님·타입이 다름 등), `INVALID_REQUEST`는 **형식은 맞지만 내용 규칙 위반**(같은 아이디로 다른 내용, 이미지 ref 규칙, 같은 ref의 다른
  이미지). 둘 다 다시 보내도 결과가 같다.
- 기관이 태블릿 연결을 꺼 두었으면(`app.device.enabled=false`) **모든 `/api/app/v1` 요청**이 403 `APP_DISABLED`다(미리보기·연결·
  상태 확인·재인증·갱신·동기화 모두, 다른 검사보다 먼저). 앱은 이 코드를 받으면 연결 안내 문구를 보여 준다. 동기화 중이면 그 자리에서
  멈추고 올리지 않은 버전은 대기 그대로 둔다(미반영으로 돌리지 않는다).
- 시각: ISO-8601 (UTC). 서버 시각이 기준이며 기기 시각은 참고 값으로만 저장한다. 남은 시간(`expiresInSeconds`)은 서버가 DB 시각으로
  계산한 값이며, 화면의 카운트다운은 기기·브라우저 시계 대신 이 값으로 센다.
- CORS: 앱 웹뷰 오리진 `capacitor://localhost`(iOS), `https://localhost`(Android), `http://localhost`(Android를 `http`
  스킴으로 띄운 빌드)를 허용한다. 메서드 GET·POST·OPTIONS, 헤더 `Authorization`·`Content-Type`. 앱이 429의 `Retry-After`를
  읽을 수 있게 `Access-Control-Expose-Headers: Retry-After`를 보낸다.
- 웹 API(`/api/eln/app/…`)는 기존 웹 로그인 세션·CSRF 규칙과 웹 공통 JSON 응답(`ViewConstant.JSON_VIEW` — `resultCode` 같은 웹 공통
  필드가 더 붙는다)을 따르고, 오류는 `S2RuntimeException` 메시지(웹 공통 오류 응답)다. 이 문서의 웹 응답 예시는 공통 필드를 뺀 것이다.
  웹 화면은 사용자가 넣은 값(기기 이름·모델·과제명·이름)을 모두 텍스트(`.text()`)로 넣는다.

### 오류 코드 한눈에 (앱이 보이는 문구)

| 상태 | 코드 | 언제 | 앱 문구(정확히) |
|---|---|---|---|
| 401 | `INVALID_PAIRING_CODE` | 과제 QR 코드가 없음·만료·사용됨·무효(§0.6·§0.7) | `코드가 맞지 않거나 만료되었습니다. 연구책임자에게 새 QR을 요청하세요.` |
| 403 | `PAIRING_REJECTED` | 연구원이 구노 웹에서 거절(§0.8) | `구노 웹에서 연결을 거절했습니다. 연구책임자에게 새 QR을 요청하세요.` |
| 410 | `PAIRING_EXPIRED` | 승인 10분 경과·토큰 수령 기한 경과·취소됨(§0.8) | `승인 시간이 지났습니다. 연구책임자에게 새 QR을 요청하세요.` (재인증이면 `승인 시간이 지났습니다. "다시 연결"로 다시 요청하세요.`) |
| 403 | `NO_PROJECT_LINKS` | 재인증할 살아 있는 연결이 없음(§0.10) | `연결된 과제가 없습니다. 연구책임자에게 과제 QR을 요청하세요.` |
| 403 | `PROJECT_NOT_LINKED` | 이 기기 묶음에 그 과제 연결이 없음·끊김·구성원이 아님(§3·§5·§6·§7) | 노트 배너 `이 과제의 태블릿 연결이 끊겼습니다. 올리지 않은 기록은 미반영으로 보관됩니다.` |
| 403 | `PROJECT_SUSPENDED` | 과제가 편집 불가라 연결 중지(§0.12) | 노트 배너 `과제가 종료되어 이 과제의 태블릿 작성이 중지되었습니다. 올리지 않은 기록은 미반영으로 보관됩니다.` |
| 400 | `REUSED_REF_MISSING` | 재사용 ref의 파일이 이 노트에 없음(§6) | (문구 없음 — 앱은 그 버전을 곧바로 전체 바이트로 한 번 다시 보낸다) |

연결된 과제가 하나도 없을 때 앱의 노트 목록·새 노트 화면 문구: `연결된 과제가 없습니다. 연구책임자에게 과제 QR을 요청하세요.`
기존 `NOT_EDIT_OWNER`·`NOT_WRITABLE`·`STALE_BASE`·`VERSION_MISMATCH`·`APP_DISABLED`·`TOKEN_EXPIRED`·`DEVICE_REVOKED`는 그대로다.

### 주기 (앱)

| 항목 | 값 |
|---|---|
| 주기 동기화 | **10분** (`600_000` ms) |
| 자동 버전 | **30분** (`1_800_000` ms) — 손을 4초 이상 멈췄을 때만(`PEN_IDLE_MS` 그대로) |
| 토큰 갱신(§2) | 마지막 갱신 후 **24시간**이 지났거나 토큰 만료까지 **3일 미만**일 때만 |
| 즉시 동기화 | 노트를 나갈 때, 앱을 내릴 때, 버전 저장·작성 완료, 네트워크 복귀, 앱 다시 열기 |
| 승인 대기 상태 확인(§0.8) | **3초** 간격(최대 10분) |
| 구노 웹 대시보드 승인 확인(§0.4) | 대시보드 진입 시 + **15초** 간격(승인 창이 떠 있는 동안은 건너뜀) |

## 0. 연결 — 과제 QR + 연구원 승인 (기본 경로)

앱은 비밀번호를 받지 않는다. 계정 비밀번호가 태블릿을 거치지 않고, SSO·2단계 인증을 쓰는 기관도 같은 방식으로 연결된다.

```
연구책임자(과제 화면)          태블릿 앱                               연구원(구노 웹 대시보드)
 QR 만들기(§0.1) ──QR──▶  미리보기(§0.6, 코드 안 씀)
                          "{과제명} / 작성자 {이름} 으로 연결할까요?"
                          연결 → POST /devices/pair (§0.7) ──202 PENDING + requestToken
                          "구노 웹에서 승인을 기다리는 중" ──────▶ 승인 창(§0.4) → 승인/거절
                          3초마다 /devices/pair/status (§0.8) ◀── APPROVED → 기기 토큰
                          → /bootstrap 의 projects 에 그 과제
```

- 발급·연결 기기 목록·연결 끊기 권한(**과제 책임자**): 그 과제 구성원 중 `PROJECT_MEMBER_ROLE_CCD IN ('PJ_MANAGER','PJ_LEAD_RESEARCHER')`
  **또는** `GNRL_YN='Y'`(`inspectionNudge-mapper.xml`의 `sqlProjectScope`와 같은 조건). 기관 관리자는 발급하지 않는다.
  발급 대상은 그 과제 구성원 한 명(책임자 본인 포함).
- 승인·거절은 **연구원 본인만**(웹 세션 사용자 = 요청의 `USER_MNO`). 다른 사용자에게는 그 요청이 목록에도 보이지 않는다.
- 토큰은 **승인 뒤에만** 발급한다. 승인 전의 요청 토큰(`requestToken`)으로 할 수 있는 일은 상태 확인과 취소뿐이다.

### 0.1 과제 QR 발급 `POST /api/eln/app/project/pairing-code` (웹 · 로그인 세션)

과제 화면 ▸ 태블릿 연결 영역에서 과제 책임자가 부른다.

```json
요청 { "projectMno": 3, "userMno": 12 }      // userMno = QR을 받을 연구원(그 과제 구성원)
응답 200 {
  "appEnabled": true,
  "code": "K7Q2-M9XD",
  "qrPayload": "goono-note://pair?server=https%3A%2F%2Feln.example.com&code=K7Q2-M9XD",
  "expiresAt": "2026-10-20T09:05:00Z",
  "expiresInSeconds": 300,
  "userNm": "김연구",
  "projectNm": "시료 A 열처리"
}
```

- 오류(웹 공통 오류): 세션 사용자가 그 과제 책임자가 아님 → `i18n.error.write`(`작성 권한이 없습니다.`), 대상이 그 과제 구성원이
  아님 → `과제 구성원에게만 QR을 만들 수 있습니다.`
- **코드 형식**: 8자, 문자 집합 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`(0·O·1·I·L 제외). 화면에는 `XXXX-XXXX`로
  표시한다. 암호학적 난수(`SecureRandom`)로 만든다.
- **정규화**: 서버·앱 모두 **대문자로 바꾸고 `-`·공백을 지운 뒤** 비교한다. 서버는 정규화한 값의
  해시(`CODE_HASH`)만 저장한다. 소문자·하이픈 없음·앞뒤 공백으로 입력해도 같은 코드다.
- **일회용, 5분 유효**: `expiresAt`까지만 쓸 수 있고, 연결 요청(§0.7)에 한 번 쓰이면 다시 쓸 수 없다(미리보기는 쓰지 않는다).
- **재발급 무효화**: 같은 **(과제, 연구원)**으로 새 코드를 만들면 그 (과제, 연구원)의 이전 미사용 코드는 무효가 된다. 같은 연구원의
  다른 과제 코드는 그대로다.
- 코드는 (과제, 연구원, 발급자)를 묶는다. 과제 정보는 서버가 코드로 알므로 **QR 내용 형식은 그대로**다:
  `goono-note://pair?server=<https URL>&code=<XXXX-XXXX>` (두 값 모두 URL 인코딩).
  앱은 scheme이 `goono-note`·host가 `pair`가 아니거나, `server`가 https가 아니거나(개발 빌드만 http 허용),
  `code`가 정규화 후 8자가 아니면 요청을 보내지 않고 거부한다.
  `server`는 서버 설정 `app.base-url` 값이다. 설정이 비어 있으면 서버는 이 요청의 URL(scheme + host + context path)로
  만들고 경고 로그를 남긴다.
- 웹 화면: 구성원 선택 + `QR 만들기` → QR + 코드 + 남은 시간(`5:00`부터 `expiresInSeconds`로 센다, 0이면 QR을 숨김) + `새 QR`.
- 기관이 태블릿 연결을 꺼 두었으면 코드를 만들지 않고 **200 `{ "appEnabled": false }`**로 응답한다(403이 아니다). 웹의 태블릿 연결
  영역은 그 대신 `이 기관은 태블릿 연결을 사용하지 않습니다.`를 보인다.

### 0.2 과제 연결 기기 목록 `POST /api/eln/app/project/links` (웹 · 과제 책임자)

```json
요청 { "projectMno": 3 }
응답 200 { "appEnabled": true, "links": [ {
  "linkMno": 31,            // 승인 대기 행은 null
  "requestMno": null,       // 승인 대기 행만 값이 있다
  "userMno": 12, "userNm": "김연구",
  "deviceNm": "연구실 iPad", "platform": "ios", "model": "iPad14,5", "appVersion": "0.2.0",
  "lastSeenAt": "…Z",       // 승인 대기 행·한 번도 접속하지 않은 기기는 null
  "status": "PENDING|ACTIVE|SUSPENDED|ENDED",
  "endReason": "LEADER|MEMBER_REMOVED|REVOKED|HANDOVER|INACTIVE"   // ENDED만, 그 밖에는 null
} ] }
```

- 행: 이 과제의 연결 행(ENDED는 **끝난 지 30일 안**의 것만) + 이 과제로 들어온 **기한 안의 PENDING 연결 요청**(`status: "PENDING"`).
- `status`는 요청 시점 상태(§0.12 `effectiveStatus`)다. 구성원에서 빠져 끊김으로 보이지만 아직 기록 전인 행의 `endReason`은
  `MEMBER_REMOVED`.
- 순서: `PENDING` → `ACTIVE` → `SUSPENDED` → `ENDED`, 같은 상태 안에서는 연구원 이름 → 기기 이름 순.
- 웹 상태 표시(정확히): `PENDING` `승인 대기`, `ACTIVE` `연결됨`, `SUSPENDED` `과제 종료로 중지`, `ENDED` `끊김`.
  `ACTIVE`·`SUSPENDED` 행에 `연결 끊기`(확인 `이 기기의 이 과제 연결을 끊을까요? 기기에서 작성 중인 노트는 웹으로 돌아옵니다.`).
- 기능 꺼짐 → `{ "appEnabled": false }`만. 책임자가 아니면 `i18n.error.write`.

### 0.3 연결 끊기 `POST /api/eln/app/project/unlink` (웹 · 과제 책임자)

```json
요청 { "projectMno": 3, "linkMno": 31 }
응답 200 { "ended": 1 }     // 끊은 연결 수. 이미 끊겼거나 그 과제의 연결이 아니면 0
```

- 그 연결을 `ENDED`(사유 `LEADER`)로 바꾸고, 그 연결로 편집 위치가 기기인 그 과제 노트를 `WEB`으로 되돌린다(이력 `연결 끊김`, 작성자 =
  책임자). §0.12.
- 기능 꺼짐 → `{ "appEnabled": false }`만. 책임자가 아니면 `i18n.error.write`.

### 0.4 승인 요청 목록·결정 (웹 · 연구원 본인)

`POST /api/eln/app/pairing-requests` (본문 없음) — 세션 사용자의 **기한 안 PENDING** 요청만, 오래된 것부터.

```json
응답 200 { "appEnabled": true, "requests": [ {
  "requestMno": 77,
  "kind": "LINK|REAUTH",
  "projectNm": "시료 A 열처리",     // LINK: 연결할 과제, REAUTH: null
  "linkedProjectNms": [],            // REAUTH: 그 기기 묶음의 살아 있는(ACTIVE·SUSPENDED) 연결 과제 이름(이름순), LINK: []
  "deviceNm": "연구실 iPad", "platform": "ios", "model": "iPad14,5",
  "requestedAt": "…Z",
  "expiresInSeconds": 540
} ] }
```
기능 꺼짐 → `{ "appEnabled": false, "requests": [] }`.

`POST /api/eln/app/pairing-requests/decide`

```json
요청 { "requestMno": 77, "decision": "APPROVE|REJECT" }
응답 200 { "status": "APPROVED|REJECTED" }
```

- 남의 요청·기한 지남·이미 처리됨 → 웹 공통 오류 `승인 요청이 만료되었거나 이미 처리되었습니다.`(남의 요청인지 알려 주지 않는다).
  `decision`이 두 값이 아니면 같은 웹 공통 오류 형식의 입력 오류.
- **LINK 승인**: 연구원이 아직 그 과제 구성원이어야 한다(아니면 `과제 구성원이 아니어서 연결할 수 없습니다.`, 요청은 PENDING 그대로) →
  (기기 ID, 연구원) 기기 묶음이 없으면 만들고(토큰 없음), 있으면 기기 이름·플랫폼·모델·앱 버전만 바꾼다(**사용 중지·토큰은 그대로** —
  사용 중지는 §0.8에서 토큰을 줄 때 풀린다) → (묶음, 과제) 연결을 `ACTIVE`로(끊겼던 행이면 되살리고 끝 정보를 지운다) → 같은 기기
  ID의 **다른 연구원 묶음**에 살아 있는 연결이 있으면 그 묶음의 연결을 모두 끊는다(사유 `HANDOVER`, §0.12).
- **REAUTH 승인**: 요청 상태만 바꾼다(연결은 그대로).
- **거절**: 요청 상태만 `REJECTED`(기기 묶음·연결을 만들지 않는다).
- 기능 꺼짐 → `{ "appEnabled": false }`만(결정하지 않는다).
- 대시보드 승인 창(정확히, `{HH:mm}` = 요청 시각): LINK `{과제명} 과제에 태블릿 '{기기 이름}'({플랫폼} · {모델})을 연결할까요? 요청 시각 {HH:mm}`,
  REAUTH `태블릿 '{기기 이름}'({플랫폼} · {모델})을 다시 연결할까요? 연결된 과제: {과제명, …} 요청 시각 {HH:mm}` + `승인`·`거절`.
  요청이 여럿이면 하나씩 차례로 띄운다. 만료 오류면 안내 후 다음 요청.

### 0.5 내 기기(마이페이지, 웹 · 본인)

- `POST /api/eln/app/myDevices` — 기존 필드에 기기마다 `projects: [ { "projectNm": "…", "status": "ACTIVE|SUSPENDED|ENDED" } ]`
  (그 기기 묶음의 모든 연결, 요청 시점 상태, 이름순)를 더한다.
- `POST /api/eln/app/revokeDevice` — 사용 중지(`DEVICE_REVOKED`)하면서 그 기기 묶음의 **모든 과제 연결을 끊고**(사유 `REVOKED`) 그 묶음이
  편집 위치인 노트를 모두 `WEB`으로(이력 `기기 사용 중지`). 확인 문구 `이 기기의 모든 과제 연결이 끊기고, 기기에서 작성 중인 노트는 웹으로 돌아옵니다.`
  다시 쓰려면 과제 QR + 승인부터.
- **삭제**: `POST /api/eln/app/pairing-code`(마이페이지에서 연구원이 스스로 QR 발급) — 없어졌다(404). 마이페이지 메뉴 이름은 `내 태블릿`.

### 0.6 미리보기 `POST /devices/pair/preview` (앱 · 익명)

앱의 확인 단계(`{과제명} / 작성자 {연구원 이름} 으로 연결할까요?`)에 쓸 이름을 **코드를 쓰지 않고** 가져온다.

```json
요청 { "pairingCode": "k7q2m9xd" }        // 정규화 전 값도 허용
응답 200 {
  "project": { "projectMno": 3, "name": "시료 A 열처리" },
  "user": { "userMno": 12, "loginId": "researcher1", "name": "김연구" },
  "expiresAt": "…Z"                        // 코드의 유효 기한
}
```

| 상태 | 코드 | 의미 |
|---|---|---|
| 400 | `BAD_REQUEST` | 본문이 JSON 객체가 아님. 실패 횟수에 넣지 않는다 |
| 401 | `INVALID_PAIRING_CODE` | 코드가 없음·만료·사용됨·무효, 빈 값·형식이 틀린 값 포함. **실패 1회로 센다** |
| 403 | `APP_DISABLED` | 기관이 태블릿 연결을 끔 |
| 429 | `TOO_MANY_ATTEMPTS` | 실패가 너무 많음(§0.11). `Retry-After` 헤더(초) |

평가 순서: 403 `APP_DISABLED` → 400 → 429 → 401 → 200. 이미 연결된 기기에서 **다른 연구원**의 과제 QR이면 앱은 올리지 않은 기록이
있는 한 이 단계에서 거부한다(앱 규칙 — 코드를 쓰지 않으므로 그 QR은 다른 기기에서 그대로 쓸 수 있다).

### 0.7 연결 요청 `POST /devices/pair` (앱 · 익명)

```json
요청 {
  "pairingCode": "K7Q2-M9XD",   // 정규화 전 값도 허용(서버가 정규화)
  "device": { "id": "기기가 만든 UUID", "name": "연구실 iPad", "platform": "ios|android|web",
              "model": "iPad14,5", "appVersion": "0.2.0" }
}
응답 202 {
  "status": "PENDING",
  "requestToken": "…",          // 불투명 문자열. 서버는 해시만 저장. 상태 확인·취소에만 쓴다
  "expiresAt": "…Z",            // 승인 요청 기한(만든 때 + 10분)
  "expiresInSeconds": 600,
  "project": { "projectMno": 3, "name": "시료 A 열처리" },
  "user": { "userMno": 12, "loginId": "researcher1", "name": "김연구" }
}
```

| 상태 | 코드 | 의미 |
|---|---|---|
| 400 | `BAD_REQUEST` | 요청 형식 오류 — 본문이 없거나 `device`가 아래 규칙에 맞지 않음. 코드를 쓰지 않고 실패 횟수에 넣지 않는다 |
| 401 | `INVALID_PAIRING_CODE` | §0.6과 같다(**실패 1회**). 이유는 구분해 알려 주지 않는다 |
| 403 | `APP_DISABLED` | 기관이 태블릿 연결을 끔 |
| 403 | `DEVICE_NOT_ALLOWED` | **예약** — 이 기기는 연결할 수 없음(기관 정책). 이때 코드는 쓰지 않는다. 구노 서버는 아직 보내지 않는다(기기 차단 목록이 없다. 모의 서버만 `blockedDeviceIds`로 흉내 낸다) |
| 429 | `TOO_MANY_ATTEMPTS` | §0.11 |

- **기기 정보(`device`) 규칙** (서버 DDL `PL_APP_DEVICE`의 길이): `id` 필수·64자 이하, `name` 필수·100자 이하, `platform` 필수·
  20자 이하, `model` 선택·100자 이하, `appVersion` 선택·30자 이하. 필수 값이 없거나 공백뿐이거나 길이를 넘으면 400 `BAD_REQUEST`
  (`/devices/register`도 같다).
- **평가 순서**: 403 `APP_DISABLED` → 400 `BAD_REQUEST` → 429 → 401 `INVALID_PAIRING_CODE` → 403 `DEVICE_NOT_ALLOWED`(예약) →
  202(코드 사용 처리 + 같은 (기기 ID, 연구원, 과제)의 이전 PENDING 요청을 `CANCELED`로 + 승인 요청 생성).
- 이 단계에서는 **기기 묶음도 연결도 토큰도 만들지 않는다**(승인 때 만든다, §0.4). 요청은 연구원 본인의 대시보드 승인 창에 뜬다.
- 앱 대기 화면(정확히): 제목 `구노 웹에서 승인을 기다리는 중` + `남은 시간 m:ss`(`expiresInSeconds`로 센다) + `취소`.

### 0.8 승인 상태 확인 `POST /devices/pair/status` (앱 · 익명)

연결 요청(§0.7)과 재인증(§0.10) 모두 이것으로 확인한다. 앱은 대기 중 **3초**마다 부른다.

```json
요청 { "requestToken": "…" }
응답 200 { "status": "PENDING", "expiresAt": "…Z", "expiresInSeconds": 412 }
응답 200 { "status": "APPROVED", "token": "…", "tokenExpiresAt": "…Z", "offlineGraceDays": 14,
           "user": { "userMno": 12, "loginId": "researcher1", "name": "김연구" }, "serverTime": "…Z" }
```

| 상태 | 코드 | 의미 |
|---|---|---|
| 400 | `BAD_REQUEST` | `requestToken`이 없거나 문자열이 아님 |
| 401 | `UNAUTHORIZED` | 모르는 요청 토큰 |
| 403 | `PAIRING_REJECTED` | 연구원이 거절함 |
| 403 | `APP_DISABLED` | 기관이 태블릿 연결을 끔 |
| 410 | `PAIRING_EXPIRED` | 승인 없이 요청 기한(10분)이 지남, 승인됐지만 **토큰 수령 기한**이 지남, 또는 취소된 요청(같은 기기·과제로 다시 요청해 취소된 것 포함) |

- **결과 판정**(서버 `pollOutcome`): `PENDING`이고 기한 안 → PENDING / `PENDING`인데 기한 지남 → EXPIRED / `APPROVED`이고 **승인 시각 + 10분**
  안 → APPROVED / 그 뒤 → EXPIRED / `REJECTED` → REJECTED / `EXPIRED`·`CANCELED` → EXPIRED.
- **토큰은 APPROVED 응답에서만** 준다. 수령 기한 안의 상태 확인마다 **새 토큰**을 발급한다(앞 토큰·갱신 유예 토큰은 무효 — 승인 직후 응답을
  잃은 앱이 다시 확인해도 받을 수 있게). 토큰을 줄 때 그 기기 묶음의 **사용 중지가 풀린다**(분실 신고한 기기의 옛 토큰은 되살아나지 않는다 —
  새 토큰만 쓸 수 있다).
- APPROVED 뒤 앱은 기존 연결 처리와 같다: 같은 계정이면 기기 데이터를 이어 쓰고, `/bootstrap`으로 연결된 과제를 받는다.
- 요청 토큰은 추측할 수 없는 값이므로 이 경로·취소의 401은 IP 실패 횟수(§0.11)에 넣지 않는다.

### 0.9 요청 취소 `POST /devices/pair/cancel` (앱 · 익명)

```json
요청 { "requestToken": "…" }
응답 200 { "status": "CANCELED" }   // 기한 안 PENDING 이면 CANCELED 로 바꾼다
```
이미 결정된 요청은 바꾸지 않고 지금 상태(`APPROVED|REJECTED|EXPIRED|CANCELED`, 기한 지난 PENDING은 `EXPIRED`)를 돌려준다.
오류: 400 `BAD_REQUEST`, 401 `UNAUTHORIZED`(모르는 값), 403 `APP_DISABLED`. 취소된 요청의 상태 확인은 410 `PAIRING_EXPIRED`.

### 0.10 재인증 `POST /devices/reauth` (앱 · 기한 지난 토큰 허용)

14일 오프라인 등으로 토큰이 만료돼도 과제 연결은 유지된다. 앱의 "다시 연결"은 새 QR 대신 이것을 보낸다.

```json
요청 헤더 Authorization: Bearer {기기 토큰 — 만료돼도 됨}
요청 {}
응답 202 {
  "status": "PENDING", "requestToken": "…", "expiresAt": "…Z", "expiresInSeconds": 600,
  "user": { "userMno": 12, "loginId": "researcher1", "name": "김연구" },
  "projects": [ { "projectMno": 3, "name": "시료 A 열처리" } ]   // 살아 있는 연결(ACTIVE·SUSPENDED), 이름순
}
```

| 상태 | 코드 | 의미 |
|---|---|---|
| 401 | `UNAUTHORIZED` | 토큰이 없거나 모르는 토큰(현재 토큰도, 유예 중인 이전 토큰도 아님) |
| 401 | `DEVICE_REVOKED` | 사용 중지된 기기 묶음 — 과제 QR부터 |
| 403 | `NO_PROJECT_LINKS` | 그 기기 묶음에 살아 있는(`ACTIVE`·`SUSPENDED`) 연결이 없음 — 과제 QR부터 |
| 403 | `APP_DISABLED` | 기관이 태블릿 연결을 끔 |

- **평가 순서**: 403 `APP_DISABLED` → 401 `UNAUTHORIZED` → 401 `DEVICE_REVOKED` → 403 `NO_PROJECT_LINKS` → 202(이 기기 묶음의 이전
  PENDING 재인증을 `CANCELED`로 + 재인증 요청 생성). 토큰의 **기한은 보지 않는다**.
- 재인증 요청은 그 기기 묶음(기기 ID, 연구원)에 묶이고, 연구원 본인 대시보드에 REAUTH 승인 창이 뜬다(§0.4). 상태 확인·취소는 §0.8·§0.9와
  같다. 승인되면 새 토큰이 발급되고 **살아 있는 과제 연결이 모두 그대로** 쓰인다(책임자 재발급 불필요).

### 0.11 연결 실패 제한·클라이언트 IP

- **같은 IP에서 10분 안에 5번 실패하면 429 `TOO_MANY_ATTEMPTS`.** 실패는 §0.6·§0.7의 `INVALID_PAIRING_CODE`와 §1 `/devices/register`의
  `INVALID_CREDENTIALS`이며, 세 엔드포인트가 **같은 IP별 횟수를 공유**한다(설계 §7.1). 막혀 있는 동안은 맞는 코드도 429이고, 429 응답
  자체는 실패 횟수를 늘리지 않는다. `Retry-After`는 가장 오래된 실패가 10분 창에서 빠질 때까지 남은 초다. (틀린 코드는 어느 코드의
  시도인지 알 수 없으므로 코드 단위가 아니라 IP 단위로 제한한다.)
  **성공해도 실패 횟수를 지우지 않는다**(미리보기·연결·등록 모두). 계정이 있는 사용자가 자기 코드로 성공해 횟수를 되돌리며 추측을 이어 가지
  못하게 하기 위해서다. 실패는 10분 창에서 저절로 빠진다.
- **클라이언트 IP**: 직접 연결한 상대(peer)가 같은 서버의 리버스 프록시(루프백 주소 127.0.0.0/8·::1)일 때만 `X-Real-IP`를
  쓰고(IP 리터럴일 때만), 그 밖에는 peer 주소를 쓴다(다른 곳에서 보낸 이 헤더는 무시). `X-Forwarded-For`는 **쓰지 않는다**(첫
  값을 클라이언트가 정할 수 있다). nginx는 `proxy_set_header X-Real-IP $remote_addr;`로 이 값을 덮어쓴다.
  실패 횟수는 서버 인스턴스의 메모리에 둔다 — 인스턴스가 여러 개인 기관은 인스턴스마다 따로 센다.

### 0.12 기기 묶음과 연결 수명

- **기기 묶음**: 서버의 기기 기록(`PL_APP_DEVICE`)은 **(기기 ID, 연구원)** 단위이고 토큰도 이 단위다. 과제 연결(`PL_APP_PROJECT_LINK`)은
  **(기기 묶음, 과제)** 단위다. 한 기기 묶음에 여러 과제 연결을 둘 수 있다 — 이미 연결된 기기에서 같은 연구원의 다른 과제 QR을 승인하면
  **연결이 하나 더 추가**된다(토큰은 새로 받은 것만 유효).
- 노트의 편집권(`editLocation.deviceId`)은 **그 노트의 주인 + 그 기기**에게만 있다. 같은 기기를 다른 연구원이 연결해도 남의 노트를 올리거나
  반납할 수 없다 — 노트 주인이 토큰의 사용자가 아니면 404 `NOT_FOUND`(남의 노트는 있는지도 알려 주지 않는다). 409 `NOT_EDIT_OWNER`는 내
  노트인데 편집 위치가 이 (기기, 연구원) 묶음이 아닐 때다.
- **연결 상태**: `ACTIVE`(쓸 수 있음) / `SUSPENDED`(과제 편집 불가로 중지 — 지우지 않음) / `ENDED`(끊김, 사유 `END_REASON_CCD`).
  요청 때의 상태(`effectiveStatus`): 저장 상태가 `ENDED`이거나 연구원이 그 과제 구성원이 아니면 **ENDED**, 그 밖에 과제가 편집 불가(삭제·
  미사용·`ElnProjectGracePeriodPolicy.isEditableStatus(prgrstCcd, graceEndDe)`가 거짓)면 **SUSPENDED**, 아니면 **ACTIVE**. 하루 작업 전이라도
  요청 때 이 규칙으로 판정한다(저장 상태가 SUSPENDED라도 과제가 다시 편집 가능하면 ACTIVE).
- **요청 검사**: `POST /notes`·`/versions`·`/release`는 그 노트(또는 만들 노트)의 과제에 대해 이 기기 묶음의 연결이 ACTIVE인지 본다.
  연결 없음·ENDED → 403 `PROJECT_NOT_LINKED`, SUSPENDED → 403 `PROJECT_SUSPENDED`. 각 API의 평가 순서 안 위치는 §5·§6·§7.
- **끊김과 노트**: 연결이 끊기거나 중지되면 그 연결(기기 묶음, 과제)로 편집 위치가 기기인 노트를 **`WEB`으로 되돌리고** 노트 이력
  `NOTE_EDIT_RECLAIM`(대상 = 기기 관리번호 `DEVICE_MNO`)에 아래 내용을 남긴다. 시스템 작업의 이력 작성자 관리번호는 `0`. 앱은 다음 동기화의
  `/bootstrap`에서 그 과제의 `linkStatus`를 보고 그 과제 노트를 잠그고 대기 버전을 미반영으로 둔다.

| 경우 | 언제 | 연결 | 되돌리는 노트 | 이력 내용(정확히) | 작성자 |
|---|---|---|---|---|---|
| 책임자가 끊음 | §0.3 | ENDED `LEADER` | 그 과제 | `연결 끊김` | 책임자 |
| 구성원 제외 | 과제 구성원 삭제 직후 + 하루 작업 | ENDED `MEMBER_REMOVED` | 그 과제 | `구성원 제외` | 삭제한 사용자 / `0` |
| 과제 편집 불가 | 하루 작업 | **SUSPENDED** | 그 과제 | `과제 종료` | `0` |
| 다른 연구원이 같은 기기 연결 | 그 연결 승인 때(§0.4) | 이전 연구원 묶음의 살아 있는 연결 모두 ENDED `HANDOVER` | 이전 연구원 묶음의 모든 노트 | `다른 연구원이 기기 연결` | 승인한 연구원 |
| 장기 미접속 | 하루 작업 | ENDED `INACTIVE` | 그 과제 | `장기 미접속` | `0` |
| 사용 중지 | 마이페이지 §0.5 | 그 묶음의 살아 있는 연결 모두 ENDED `REVOKED` | 그 묶음의 모든 노트 | `기기 사용 중지` | 본인 |

- **재개**: 과제가 다시 편집 가능해지면(유예 연장·재개) 하루 작업이 `SUSPENDED` → `ACTIVE`로 되돌린다. **새 QR이 필요 없다**. 노트는 이미
  `WEB`이므로 새 노트부터 다시 쓴다.
- **장기 미접속**: `COALESCE(LAST_SEEN_DT, CREATE_DT) < NOW() - INTERVAL 30 DAY`(DB 시각)인 기기 묶음의 연결. `LAST_SEEN_DT`는 기기 토큰으로
  인증된 요청마다(그리고 승인 토큰 수령 때) 갱신된다.
- **하루 1번 작업**(서버 `app.device.link-job.cron`, 기본 `0 40 3 * * *`): 저장 상태가 `ACTIVE`·`SUSPENDED`인 연결마다 아래 **우선순위로 하나만**
  한다 — ① ENDED → 아무것도 안 함 ② 구성원 아님 → 끊음(`MEMBER_REMOVED`) ③ 장기 미접속 → 끊음(`INACTIVE`) ④ `ACTIVE`이고 과제 편집 불가 →
  중지 ⑤ `SUSPENDED`이고 과제 편집 가능 → 재개. 상태 바꾸기는 조건부 UPDATE이고 0건이면 노트·이력을 건드리지 않는다(다시 돌려도 안전).
  한 연결의 실패는 로그를 남기고 다음 연결로 넘어간다. 끝에 결정·만료된 지 7일 지난 승인 요청을 지운다.
- **다른 연구원 연결**: 앱 쪽 "올리지 않은 기록이 있으면 다른 연구원 연결 거부" 규칙은 그대로다(§0.6 미리보기 단계). 책임자 목록에는 이전 연구원
  연결이 `끊김`으로 보인다.
- **다시 연결**: 토큰 만료(`TOKEN_EXPIRED`)는 §0.10 재인증으로, 사용 중지(`DEVICE_REVOKED`)·살아 있는 연결 없음은 과제 QR(§0.1) + 승인으로 한다.
  같은 연구원이 같은 기기로 승인 토큰을 받으면 그 묶음의 이전 토큰은 즉시 무효가 되고(새 토큰만 유효) 사용 중지도 풀린다.
  같은 계정이면 앱은 기기 데이터를 이어 쓰고, 다른 계정이면 올리지 않은 기록이 있는 한 거부한다(앱 규칙).

## 1. 기기 등록 `POST /devices/register` (보조 경로)

인증 없음. 구노 계정의 아이디·비밀번호로 기기 토큰을 받는다. **서버 설정
`app.device.password-login.enabled`가 켜졌을 때만** 동작하며, 꺼져 있으면 403 `PASSWORD_LOGIN_DISABLED`.
운영 서버의 기본값은 꺼짐이고, 앱의 비밀번호 화면도 개발·체험 빌드(`ALLOW_DEMO`)에만 보인다.
**토큰만 주고 과제 연결은 만들지 않는다** — 연결은 과제 QR + 승인으로만 생긴다. 이 토큰만 가진 기기의 `/bootstrap` `projects`는 비어 있고
노트를 만들 수 없다(403 `PROJECT_NOT_LINKED`).

```json
요청 {
  "loginId": "researcher1",
  "password": "…",
  "device": { "id": "기기가 만든 UUID", "name": "연구실 iPad", "platform": "ios|android|web",
              "model": "iPad14,5", "appVersion": "0.2.0" }
}
응답 200 {
  "token": "…",                       // 불투명 문자열. 서버는 해시만 저장
  "tokenExpiresAt": "2026-11-03T…Z",  // = 오프라인 편집 허용 기한
  "offlineGraceDays": 14,
  "user": { "userMno": 12, "loginId": "researcher1", "name": "김연구" },
  "serverTime": "…"
}
```
오류: 400 `BAD_REQUEST`(요청 형식 오류 — `loginId`·`password`가 없거나 `device`가 §0.7 규칙에 맞지 않음), 401 `INVALID_CREDENTIALS`, 403 `APP_DISABLED`, 403 `PASSWORD_LOGIN_DISABLED`,
403 `DEVICE_NOT_ALLOWED`(예약 — §0.7), 429 `TOO_MANY_ATTEMPTS`(+ `Retry-After` 초)

평가 순서: 403 `APP_DISABLED` → 403 `PASSWORD_LOGIN_DISABLED` → 400 `BAD_REQUEST` → 429 → 401 `INVALID_CREDENTIALS` → 403 `DEVICE_NOT_ALLOWED`(예약) → 200.
`INVALID_CREDENTIALS`는 §0.11의 IP별 실패 횟수(5회/10분)에 **같은 통에 합산**된다. 기기 묶음은 §0.12와 같다(같은 연구원·같은 기기면 토큰만 새로,
사용 중지 해제).

## 2. 토큰 갱신 `POST /devices/refresh`

기한을 연장한다. 앱은 **하루 1번 또는 만료 3일 전**에만 부른다 — 마지막 갱신 후 24시간이 지났거나 토큰 만료까지 3일 미만일 때(동기화마다
부르지 않는다). 응답은 등록과 같은 형식(user 제외).
오류: 401 `TOKEN_EXPIRED`(다시 연결 — §0.10 재인증), 401 `DEVICE_REVOKED`(분실 등으로 폐기됨 — 앱은 편집을 잠근다), 401 `UNAUTHORIZED`(알 수 없는 토큰)

- **매번 새 토큰으로 바꾼다.** 보낸(이전) 토큰은 **10분 동안, 또는 새 토큰으로 첫 요청이 올 때까지** 함께 받는다. 갱신 응답을
  받지 못한 앱이 이전 토큰으로 다음 요청을 하거나 다시 갱신해도 401이 되지 않는다(재시도 안전). 유예 중인 이전 토큰으로 다시
  갱신하면 서버는 새 토큰을 또 발급하고(응답을 못 받은 쪽 토큰은 버려진다) 이전 토큰의 유예 기한은 늘리지 않는다.
- 10분이 지났거나 새 토큰을 이미 쓴 뒤의 이전 토큰은 401 `UNAUTHORIZED`. 기기를 `사용 중지`하면 유예가 끝나고 현재·이전 토큰
  모두 401 `DEVICE_REVOKED`. 승인 토큰을 새로 받으면(§0.8) 이전 토큰은 지워진다.

## 3. 기준 정보 `GET /bootstrap`

```json
{ "user": {…},
  "projects": [ { "projectMno": 3, "name": "시료 A 열처리", "writable": true, "linkStatus": "ACTIVE" },
                { "projectMno": 4, "name": "세포 배양 조건 최적화", "writable": false, "linkStatus": "ENDED" } ],
  "policy": { "offlineGraceDays": 14, "maxImageBytes": 52428800 },
  "serverTime": "…" }
```
- `projects`는 **이 기기 묶음의 연결 과제만**(끊긴 연결 포함), 과제 이름순. 연결 안 된 과제는 넣지 않는다.
- `linkStatus` = 요청 때의 연결 상태(`ACTIVE|SUSPENDED|ENDED`, §0.12 `effectiveStatus`), `writable` = `linkStatus`가 `ACTIVE`(편집 가능한
  과제의 활성 연결)일 때만 true.
- 앱: 새 노트의 과제 선택지는 `writable`이고 `ACTIVE`인 과제만. 목록에 없는 과제의 노트는 끊긴 것으로 본다. `ENDED` 과제 노트는 잠그고
  `이 과제의 태블릿 연결이 끊겼습니다. 올리지 않은 기록은 미반영으로 보관됩니다.`, `SUSPENDED`는
  `과제가 종료되어 이 과제의 태블릿 작성이 중지되었습니다. 올리지 않은 기록은 미반영으로 보관됩니다.` 배너를 보인다.

## 4. 노트 상태 `GET /notes`

이 사용자의 노트 중 이 기기가 만들었거나 편집 위치가 이 (기기, 사용자) 묶음인 노트. 다른 사용자의 노트는 넣지 않는다(과제 연결 상태와
상관없이 — 끊긴 과제의 노트도 편집 위치 `WEB`으로 보인다).
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
- **멱등은 노트 주인 단위**: 같은 사용자가 같은 `clientNoteId`로 다시 보내면 200과 기존 값(**과제 연결 검사보다 먼저** — 연결이 끊긴 뒤의
  재전송도 200). 다른 사용자의 `clientNoteId`와는 겹쳐도 상관없다. 웹에서 **삭제한 노트**의 `clientNoteId`로 다시 오면 그 노트의 `noteMno`를
  200으로 돌려주고, 그 노트의 이후 버전·반납은 404 `NOT_FOUND`다 — 되살아나지 않는 끝 상태이므로 앱은 그 노트의 전송을 멈춘다(앱은 404를
  노트 단위 거부로 처리한다).
- **평가 순서**: 400 `BAD_REQUEST` → 같은 `clientNoteId`면 200 기존 값 → 403 `PROJECT_NOT_LINKED`·`PROJECT_SUSPENDED`(이 기기 묶음의 그 과제
  연결, §0.12) → 403 `PROJECT_NOT_WRITABLE`(프로젝트 참여자가 아니거나 편집할 수 없는 프로젝트 — 새로 만들 때만 본다) → 201.

서버 구현: 작성 방식 `EDITOR`로 노트를 만들고 편집 위치를 이 기기로 둔다.

## 6. 버전 올리기 `POST /notes/{noteMno}/versions`

`multipart/form-data`:

| 필드 | 내용 |
|---|---|
| `meta` | JSON `{ "clientVersionId"(필수·64자 이하), "baseVersionId" (직전에 서버가 받은 버전, 첫 버전은 null), "deviceWrittenAt", "contentHash"(필수), "autoSave", "title", "reusedRefs" }` — `title`이 있으면 노트 제목을 그 값으로 바꾼다(앱에서 제목을 고친 경우. §5처럼 다듬고 256자에서 자른다). `reusedRefs`는 선택(아래) |
| `noteContent` | 노트 HTML. 태블릿 앱은 손글씨 블록 하나 `<figure class="rw-drawing" data-strokes="{title,strokes,layout}" data-drawing-sha256="…">` 안에 페이지마다 `<img src="blob:goono-app/{ref}">` (웹 구노 editor-ai 의 손글씨 블록과 같은 형식) |
| `inlineImages[blob:goono-app/{ref}]` | 이미지 파일 (여러 개). 페이지 PNG는 파일 이름 `….png` |

- 201 `{ "versionId": 5008, "receivedAt": "…" }`
- 200 `{ …, "duplicate": true }` — 같은 `clientVersionId`를 이 노트에서 이미 받음(재전송 안전. 편집권 회수·반납·점검 요청·연결 끊김 뒤의
  재전송도 200)

**바뀐 쪽만 올리기 — `meta.reusedRefs`**: 선택. 있으면 **문자열 배열**이어야 한다(배열이 아니거나 문자열이 아닌 원소 → 400 `BAD_REQUEST`.
없거나 `null`이면 빈 배열). 각 ref는 이 노트에 **이미 저장된 이미지**를 바이트 없이 다시 쓴다는 뜻이다.
- 앱: 페이지 PNG의 SHA-256이 직전 버전의 페이지와 같으면 그 ref를 그대로 쓴다(직전 버전의 ref 하나는 한 번만 재사용 — 한 버전 안에서 ref가
  겹치지 않는다). 업로드는 이 노트의 **서버가 받은(SENT) 버전에 있던 ref만** `reusedRefs`로 바이트 없이 보내고 나머지는 바이트를 보낸다.
  400 `REUSED_REF_MISSING`을 받으면 그 버전을 곧바로 **전체 바이트로 한 번** 다시 보낸다(같은 `clientVersionId`, `reusedRefs` 없음).
- 서버: 재사용 ref의 바이트는 저장 파일 `{noteMno}-{ref}.png`(인라인 이미지 폴더, §6 아래 저장 규칙)에서 읽어 **내용 해시에 넣는다**. 그 파일이
  없으면 400 `REUSED_REF_MISSING`. 재사용 ref는 새로 저장하지 않고 본문의 `blob:goono-app/{ref}`를 그 파일 주소로 바꾼다. 크기 상한(413)에는
  **전송한 바이트만** 센다.

**평가 순서** (노트 행을 잠근 한 트랜잭션. 앞의 검사에 걸리면 뒤는 보지 않는다):

1. 400 `BAD_REQUEST` — multipart가 아님(노트를 보기 전). multipart 전체가 서버의 multipart 상한을 넘으면 413 `TOO_LARGE`
2. 404 `NOT_FOUND` — 노트가 없거나 삭제됐거나 노트 주인이 토큰의 사용자가 아님(남의 노트). 상태·편집 위치를 알려 주지 않는다
3. 400 `BAD_REQUEST` — `meta`가 없거나 JSON 객체가 아님, `clientVersionId`(64자 이하)·`contentHash`가 없음, `baseVersionId`가
   정수·null이 아님, `reusedRefs`가 문자열 배열이 아님, `noteContent` 없음
4. 같은 `clientVersionId`를 이미 받음 → 이 노트의 버전이면 200 `duplicate`. **다른 노트의 버전이면 400 `BAD_REQUEST`**,
   이 노트의 버전인데 `contentHash`가 다르면(같은 아이디로 다른 내용) **400 `INVALID_REQUEST`**
5. 403 `PROJECT_NOT_LINKED`·`PROJECT_SUSPENDED` — 이 기기 묶음의 그 노트 과제 연결이 ACTIVE가 아님(§0.12). 앱은 이 버전을 미반영 기록으로 보관
6. 409 `NOT_EDIT_OWNER` — 내 노트지만 편집 위치가 이 기기가 아님(회수·반납됨). 앱은 이 버전을 미반영 기록으로 보관
7. 409 `NOT_WRITABLE` — 작성 중·반려가 아님(점검 요청·완료), 에디터 노트가 아님, 프로젝트가 편집할 수 없는 상태
8. 409 `STALE_BASE` — `baseVersionId`가 서버 최신 버전과 다름
9. 413 `TOO_LARGE` — `meta` + `noteContent` + 전송한 모든 이미지 바이트의 **합**이 서버 상한(`app.device.max-upload-bytes`, 기본 50 MiB =
   `/bootstrap`의 `policy.maxImageBytes`)을 넘음. 재사용 ref의 저장 파일은 세지 않는다
10. 400 `INVALID_REQUEST` — 파일 필드 이름이 `inlineImages[blob:goono-app/{ref}]`가 아니거나 ref가 `^[A-Za-z0-9-]{16,64}$`가 아님;
    `reusedRefs`의 원소가 그 ref 형식이 아니거나 서로 겹치거나 업로드 필드의 ref와 겹침; 본문(`noteContent`)의 `blob:goono-app/{ref}`
    (`blob:goono-app/` 뒤에 오는 `[A-Za-z0-9-]*`를 가장 길게 — 빈 값 포함)가 업로드 ref에도 `reusedRefs`에도 없음
11. 400 `REUSED_REF_MISSING` — `reusedRefs`의 ref 중 이 노트의 저장 파일 `{noteMno}-{ref}.png`가 없는 것이 있음
12. 422 `HASH_MISMATCH` — 전송 중 손상(업로드 + 재사용 이미지로 계산한 내용 해시가 다름)
13. 400 `INVALID_REQUEST` — 이 노트에 같은 ref의 이미지가 이미 저장돼 있는데 업로드 바이트가 다름(앞 버전의 이미지를 덮어쓰지 않는다.
    바이트가 같으면 다시 저장하지 않고 그 파일을 가리킨다)

409 응답 본문은 `{ "error": { … } }`뿐이다(상태·편집 위치·최신 버전 같은 다른 필드는 없다). 앱은 409 본문의 다른 필드에 기대지
않고 다음 동기화의 `GET /notes`로 상태를 맞춘다. 모의 서버도 같은 본문을 보낸다.

**내용 해시** (`contentHash`, 소문자 hex SHA-256) — 정의는 그대로이며, 이미지는 **업로드한 것과 `reusedRefs`의 것 모두**다:
`SHA-256( UTF-8(noteContent) ‖ ⨁ over images sorted by ref: "\n" + ref + ":" + hex(SHA-256(image bytes)) )`

서버 구현: 해시를 검증한 뒤 이미지 주소 `blob:goono-app/{ref}`를 `blob:goono-app/{noteMno}-{ref}`로 바꿔(이미지 파일이 한
디렉터리에 모이므로 노트끼리 이름이 겹치지 않게) 웹 저장과 같은 `createNoteEditorDtl`로 저장한다(`img[src*="blob:"]` 치환 규칙이
같다 — 저장 파일 이름은 `{noteMno}-{ref}.{업로드 파일 이름의 확장자}`, 페이지 PNG는 `{noteMno}-{ref}.png`). 이미 같은 바이트로 저장된 ref와
재사용 ref는 다시 저장하지 않고 본문 주소를 그 파일(`/editor-inline-images/{saveNm}?noteMno={noteMno}`)로 바로 바꾼다. 노트 이력은 남기고
사용자 알림·웹 푸시는 보내지 않는다. 버전 행에 `SOURCE_CCD=APP`, `DEVICE_MNO`, `DEVICE_WRITTEN_DT`,
`CLIENT_VERSION_ID`, `CONTENT_HASH`를 추가로 남긴다. 연구노트 지침의 "입력 일시 자동 기록"은 서버 수신 시각으로 충족하고,
기기 작성 시각은 함께 표시한다. (모의 서버도 같은 이름 `{noteMno}-{ref}.{ext}`로 저장하고 노트별 저장 이미지 기록 `{ref: {sha256, saveNm}}`을
둔다.)

## 7. 작성 완료(편집권 반납) `POST /notes/{noteMno}/release`

```json
요청 { "lastVersionId": 5008 }
응답 200 { "status": "WRITING", "editLocation": { "type": "WEB" } }
```
오류: 400 `BAD_REQUEST`(본문 없음·`lastVersionId`가 정수·null이 아님), 404 `NOT_FOUND`(노트가 없거나 남의 노트 — §6과 같음),
403 `PROJECT_NOT_LINKED`·`PROJECT_SUSPENDED`(§0.12), 409 `NOT_EDIT_OWNER`(내 노트지만 편집 위치가 이 기기가 아님),
409 `VERSION_MISMATCH`(서버 최신 버전이 다름 — 아직 안 올라간 버전이 있음).
**평가 순서**: 400 → 404 → 403(연결) → 409 `NOT_EDIT_OWNER` → 409 `VERSION_MISMATCH`(편집 위치를 버전 비교보다 먼저). 409 본문은
`{ "error": { … } }`뿐이다.

- 성공하면 노트 이력에 `편집권 반납`(내용 = 노트 제목, 대상 = 이 기기)이 남는다. 사용자 알림은 없다.
- **재시도에 안전하지 않다**: 서버에서 반납이 끝났는데 응답을 잃은 뒤 같은 요청을 다시 보내면 편집 위치가 이미 `WEB`이라
  409 `NOT_EDIT_OWNER`다. 앱은 응답을 못 받으면 그 동기화를 멈추고, 다음 동기화의 `GET /notes`에서 편집 위치 `WEB`과
  `latestVersionId`가 자기가 올린 마지막 버전과 같음을 보고 "반납 완료"로 정리한다(회수로 보지 않는다).

이후 웹에서 기존 절차로 점검 요청(점검자 지정 포함)을 한다. 앱에서는 읽기 전용이 된다.

## 서버 쪽 추가 규칙 (Goono-ELN)

- 편집 위치가 `DEVICE`인 노트: 웹 에디터는 읽기 전용으로 열고 "○○ 기기에서 작성 중 · 마지막 동기화
  시각"을 표시한다. **점검 요청 API는 거부**한다.
- 편집권 회수: 노트 주인 또는 관리자가 사유(200자 이하)를 남기고 `WEB`으로 되돌릴 수 있다(기기 분실 등). 노트 이력에 `편집권 회수`.
  이후 그 기기의 버전 업로드는 409 `NOT_EDIT_OWNER`. 연결 끊김·중지(§0.12)는 이것과 같은 이력 종류(`NOTE_EDIT_RECLAIM`)로 **자동으로** 되돌린다 —
  같은 기기를 다른 연구원이 연결하면 그 승인 때 이전 연구원의 기기 작성 중 노트가 자동으로 `WEB`이 된다.
- 편집 위치가 `DEVICE`인 노트는 작성자 위임(단건·직번변경 일괄)도 거부한다.
- 과제 구성원 삭제(`ElnProjectMemberService.deleteProjectMembers`)가 성공하면 그 연구원의 그 과제 연결을 곧바로 끊는다(`MEMBER_REMOVED`). 다른
  경로로 구성원이 빠진 경우는 요청 때 `PROJECT_NOT_LINKED`로 막히고 하루 작업이 기록한다.
- 기기 관리(마이페이지 `내 태블릿`): 사용자별 기기 목록(기기별 연결 과제·상태)과 사용 중지(`DEVICE_REVOKED` + 모든 연결 끊기). 기관이 기능을 꺼도
  목록·사용 중지는 쓸 수 있다.

## DB 변경안

| 테이블 | 컬럼 | 설명 |
|---|---|---|
| `PL_ELN_NOTE` | `EDIT_LOCATION_CCD` (`WEB`/`DEVICE`), `EDIT_DEVICE_MNO`(→ `PL_APP_DEVICE.DEVICE_MNO`), `CREATE_DEVICE_MNO`(만든 기기), `CLIENT_NOTE_ID`, `UNIQUE(OWNER_MNO, CLIENT_NOTE_ID)` | 편집 위치. 편집하는 곳은 (기기, 사용자) 묶음이므로 기기 ID 문자열이 아니라 대리키를 가리킨다 |
| `PL_ELN_NOTE_EDITOR` | `SOURCE_CCD` (`WEB`/`APP`), `DEVICE_MNO`(→ `PL_APP_DEVICE.DEVICE_MNO`, 기기 ID 문자열이 아님), `DEVICE_WRITTEN_DT`, `CLIENT_VERSION_ID`(유니크), `CONTENT_HASH` | 버전 출처 |
| `PL_APP_DEVICE` | `DEVICE_MNO`(PK, 대리키), `DEVICE_ID`, `USER_MNO`, `DEVICE_NM`, `PLATFORM`, `MODEL`, `APP_VERSION`, `TOKEN_HASH`(유니크, **NULL 허용** — 승인 뒤 토큰을 받기 전·이행으로 지운 묶음), `TOKEN_EXPIRES_DT`, `PREV_TOKEN_HASH`·`PREV_TOKEN_VALID_UNTIL`(§2 갱신 유예), `REVOKED_YN`, `REVOKED_DT`, `LAST_SEEN_DT`, `CREATE_DT`, `MODIFY_DT`, `UNIQUE(DEVICE_ID, USER_MNO)` | 기기 묶음. 같은 물리 기기를 다른 연구원이 연결하면 행이 하나 더 생긴다 |
| `PL_APP_PAIRING_CODE` + 컬럼 | 기존 `CODE_HASH`(PK, 정규화한 코드의 해시), `USER_MNO`, `EXPIRES_DT`, `USED_DT`, `CREATE_DT` + **`PROJECT_MNO`**, **`ISSUER_MNO`**(둘 다 NULL 허용 — 옛 행 호환), `KEY(USER_MNO, PROJECT_MNO)` | 과제 QR 코드(일회용·5분). 새로 만들면 그 **(연구원, 과제)**의 미사용 행과 모든 만료 행을 **지운다**(무효화). `PROJECT_MNO`가 없는 옛 코드는 쓸 수 없다(사용 처리 조건 `PROJECT_MNO IS NOT NULL`). 발급 시 `CODE_HASH`가 중복(PK 충돌)되면 코드를 다시 생성한다 |
| 신규 `PL_APP_PROJECT_LINK` | `LINK_MNO`(PK, `FN_SEQ('PL_APP_PROJECT_LINK.LINK_MNO')`), `DEVICE_MNO` NOT NULL(→ `PL_APP_DEVICE`), `PROJECT_MNO` NOT NULL, `STATUS_CCD VARCHAR(10)` NOT NULL(`ACTIVE`/`SUSPENDED`/`ENDED`), `END_REASON_CCD VARCHAR(20)` NULL(`LEADER`/`MEMBER_REMOVED`/`REVOKED`/`HANDOVER`/`INACTIVE`), `ISSUER_MNO` NULL, `LINKED_DT` NOT NULL, `SUSPENDED_DT` NULL, `ENDED_DT` NULL, `ENDED_USER_MNO` NULL, `CREATE_DT`, `MODIFY_DT`, `UNIQUE(DEVICE_MNO, PROJECT_MNO)`, `KEY(PROJECT_MNO, STATUS_CCD)` | 과제 연결. 끊어도 지우지 않는다(다시 승인하면 같은 행을 `ACTIVE`로 되살리고 끝 정보를 지운다) |
| 신규 `PL_APP_PAIRING_REQUEST` | `REQUEST_MNO`(PK, `FN_SEQ('PL_APP_PAIRING_REQUEST.REQUEST_MNO')`), `REQUEST_SE_CCD VARCHAR(10)`(`LINK`/`REAUTH`), `USER_MNO` NOT NULL, `PROJECT_MNO` NULL(REAUTH는 NULL), `ISSUER_MNO` NULL, `DEVICE_MNO` NULL(LINK는 승인 때 채움), `DEVICE_ID VARCHAR(64)`, `DEVICE_NM VARCHAR(100)`, `PLATFORM VARCHAR(20)`, `MODEL VARCHAR(100)`, `APP_VERSION VARCHAR(30)`, `REQUEST_TOKEN_HASH CHAR(64)` 유니크, `STATUS_CCD VARCHAR(10)`(`PENDING`/`APPROVED`/`REJECTED`/`EXPIRED`/`CANCELED`), `EXPIRES_DT`(만든 때 + 10분), `DECIDED_DT` NULL(수령 기한 = 이것 + 10분), `CREATE_DT`, `KEY(USER_MNO, STATUS_CCD)` | 승인 요청. 결정·만료된 지 7일 지난 행은 하루 작업이 지운다 |
| `PL_SEQ` | `PL_APP_PROJECT_LINK.LINK_MNO`, `PL_APP_PAIRING_REQUEST.REQUEST_MNO` 두 행 | `FN_SEQ` 채번 |

연결 실패 횟수(IP 단위 5회/10분, 미리보기·연결·등록 공유)는 DB에 두지 않고 서버 인스턴스의 메모리에 둔다
(인스턴스가 여러 개면 인스턴스마다 따로 센다 — §0.11).
서버 설정: `app.base-url`(QR의 `server` 값 — 비면 요청 URL로 만들고 경고 로그), `app.device.enabled`(기관의 태블릿 연결 사용 여부),
`app.device.password-login.enabled`(기본 꺼짐), `app.device.link-job.cron`(하루 1번 작업, 기본 `0 40 3 * * *`).

### 이행 (계정 단위 연결 → 과제 단위 연결)

기존 연결은 모두 계정 단위였고 개발 단계 데이터뿐이므로 **모두 끊고 과제 QR로 다시 연결**하게 한다(배포 문서에 적는다). 스크립트
(`9.app_project_link.sql`)는 다시 실행해도 안전해야 한다(`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN/KEY IF NOT EXISTS`, `INSERT IGNORE`,
조건부 UPDATE/DELETE).

1. 연결 행이 하나도 없는 기기 묶음의 `TOKEN_HASH`·`TOKEN_EXPIRES_DT`·`PREV_TOKEN_HASH`·`PREV_TOKEN_VALID_UNTIL`을 지운다(그 기기의 요청은 401
   `UNAUTHORIZED` → 앱은 "다시 연결" 안내, 재인증은 `UNAUTHORIZED`이므로 과제 QR로).
2. 편집 위치가 `DEVICE`인데 `(EDIT_DEVICE_MNO, 노트의 PROJECT_MNO)` 연결 행이 없는 노트를 `WEB`으로(이력 없이).
3. `PROJECT_MNO`가 없는 옛 연결 코드를 지운다.

앱 쪽: 업그레이드한 기기의 옛 캐시 `projects`에는 `linkStatus`가 없다 — 앱은 필드가 없으면 `ACTIVE`로 보고(첫 동기화 전에는 잠그지 않는다),
목록에 없는 과제는 끊긴 것으로 본다. 서버 이행 뒤 401이면 "다시 연결" 안내, 옛 노트의 올리지 않은 기록은 미반영으로 남아 새 노트로 복원할 수 있다.
