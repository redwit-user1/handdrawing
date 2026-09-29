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
- 인증: `Authorization: Bearer {기기 토큰}` (기기 등록 제외). 웹 로그인 세션과 **분리**한다 —
  웹의 동시 세션 1개 제한(`maximumSessions(1)`)에 걸리지 않게 별도 필터 체인으로 처리.
- 오류 본문: `{ "error": { "code": "…", "message": "…" } }`
- 시각: ISO-8601 (UTC). 서버 시각이 기준이며 기기 시각은 참고 값으로만 저장한다.
- CORS: 앱 웹뷰 오리진 `capacitor://localhost`(iOS), `https://localhost`(Android)를 허용한다.

## 1. 기기 등록 `POST /devices/register`

인증 없음. 구노 계정으로 로그인해 기기 토큰을 받는다.

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
오류: 401 `INVALID_CREDENTIALS`, 403 `DEVICE_NOT_ALLOWED`

## 2. 토큰 갱신 `POST /devices/refresh`

온라인일 때마다 호출해 기한을 연장한다. 응답은 등록과 같은 형식(user 제외).
오류: 401 `TOKEN_EXPIRED`(재로그인), 401 `DEVICE_REVOKED`(분실 등으로 폐기됨 — 앱은 편집을 잠근다)

## 3. 기준 정보 `GET /bootstrap`

```json
{ "user": {…},
  "projects": [ { "projectMno": 3, "name": "시료 A 열처리", "writable": true } ],
  "policy": { "offlineGraceDays": 14, "maxImageBytes": 52428800 },
  "serverTime": "…" }
```

## 4. 노트 상태 `GET /notes`

이 기기가 만들었거나 편집 위치가 이 기기인 노트.

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
- 409 `NOT_EDIT_OWNER` — 편집권이 이 기기에 없음(회수됨). 앱은 이 버전을 미반영 기록으로 보관
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
오류: 409 `VERSION_MISMATCH`(서버 최신 버전이 다름 — 아직 안 올라간 버전이 있음), 409 `NOT_EDIT_OWNER`

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
| `PL_ELN_NOTE` | `EDIT_LOCATION_CCD` (`WEB`/`DEVICE`), `EDIT_DEVICE_ID`, `CLIENT_NOTE_ID` | 편집 위치 |
| `PL_ELN_NOTE_EDITOR` | `SOURCE_CCD` (`WEB`/`APP`), `DEVICE_ID`, `DEVICE_WRITTEN_DT`, `CLIENT_VERSION_ID`(유니크), `CONTENT_HASH` | 버전 출처 |
| 신규 `PL_APP_DEVICE` | `DEVICE_ID`, `USER_MNO`, `NAME`, `PLATFORM`, `TOKEN_HASH`, `TOKEN_EXPIRES_DT`, `REVOKED_YN`, `LAST_SEEN_DT` | 기기 |
