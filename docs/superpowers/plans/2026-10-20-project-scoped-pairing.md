# 과제별 태블릿 연결 · 동기화 주기 조정 · 바뀐 쪽만 올리기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 태블릿 연결을 (기기, 연구원, 과제) 단위로 바꿔 연구책임자가 과제 화면에서 1회용 QR을 발급·관리하고 연구원 본인이 구노 웹에서 승인해야 연결되게 하며, 동기화 10분·자동 버전 30분·토큰 갱신 하루 1번으로 늘리고 버전마다 바뀐 페이지 그림만 올린다.

**Architecture:** 계약(`SYNC-API.md`)과 모의 서버를 먼저 바꿔 단일 기준을 만든다(Task 1). 서버는 새 표(과제 연결 `PL_APP_PROJECT_LINK`, 승인 요청 `PL_APP_PAIRING_REQUEST`)와 순수 규칙(`AppLinkRules`) → 발급·승인·재인증 흐름(`AppLinkService`) → 요청 시 과제 연결 검사·끊김 규칙·하루 1번 작업 → 재사용 ref → 웹 화면(과제 태블릿 영역, 대시보드 승인 모달, 마이페이지 축소) 순서로 쌓는다. 앱은 연결 로직(승인 대기·재인증·과제별 잠금) → 화면·E2E → 동기화 주기·바뀐 쪽만 올리기 순서다. 연결이 끊기면 서버가 그 연결의 기기 작성 중 노트를 WEB으로 되돌리고, 앱은 그 과제 노트를 잠그고 대기 버전을 미반영으로 둔다.

**Tech Stack:** 앱 — Capacitor 8, React 19, TypeScript, Vite, Express 모의 서버, `node --test`, Playwright. 서버 — Java 8, Spring Boot 2.7.18 / Spring Security 5.7, eGovFrame `@Mapper` + MyBatis XML, MariaDB, Thymeleaf + jQuery, 동봉된 `static/lib/qrcode/qrcode.js`.

**Spec:** `C:/Users/harim/work/handdrawing/docs/superpowers/specs/2026-10-20-project-scoped-pairing-design.md` (기존 설계 `2026-10-17-goono-tablet-app-design.md`, 계약 `app/docs/SYNC-API.md`).

**저장소/브랜치:** `C:/Users/harim/work/handdrawing`(작업 위치 `app/`)와 `C:/Users/harim/work/Goono-ELN`, 둘 다 브랜치 `claude/tablet-app-hand-drawing-sync-ofo0oi`. Task 1·8·9·10은 handdrawing, Task 2~7은 Goono-ELN, Task 11은 둘 다.

## Global Constraints

- 연결 단위는 **(기기, 연구원, 과제)** = (`PL_APP_DEVICE.DEVICE_MNO`, `PROJECT_MNO`). 기기·연구원 단위 토큰은 그대로 두고, 모든 노트·버전 API가 그 과제 연결이 활성인지 본다. 단방향 유지 — 서버는 기기에 노트 내용·획 데이터를 보내지 않는다(메타데이터만).
- 발급·기기 목록·연결 끊기 권한: 그 과제 구성원 중 `PROJECT_MEMBER_ROLE_CCD IN ('PJ_MANAGER','PJ_LEAD_RESEARCHER')` **또는** `GNRL_YN='Y'`(`inspectionNudge-mapper.xml` `sqlProjectScope`와 같은 조건). 기관 관리자는 발급하지 않는다. 발급 대상은 그 과제 구성원 한 명(본인 포함).
- 과제 QR: 1회용·**5분**, 코드 형식·정규화·QR 형식은 그대로(`goono-note://pair?server=…&code=XXXX-XXXX`, 과제 정보는 서버가 코드로 안다). 같은 (과제, 연구원)으로 새로 만들면 이전 미사용 QR은 무효. IP 실패 제한(같은 IP 10분 5회 → 429 `TOO_MANY_ATTEMPTS`)·평가 순서·클라이언트 IP 규칙(`X-Real-IP`, 루프백 peer일 때만) 유지. 미리보기(코드 소모 없음)도 같은 실패 제한을 쓴다.
- 승인 요청: **10분** 유효, **연구원 본인만** 승인·거절(웹 세션 사용자 = 요청의 `USER_MNO`, 그 외에는 목록에도 보이지 않는다). 토큰은 **승인 뒤에만** 발급한다(승인 상태를 확인한 앱이 받는다). 승인 후 토큰 수령 기한 = 승인 시각 + 10분, 그 안의 상태 확인마다 새 토큰(앞 토큰 무효).
- 끊김 사유와 노트 이력 내용(정확히, `NOTE_EDIT_RECLAIM` 이력의 내용, 대상 = 기기 관리번호): 책임자 끊음 `연결 끊김`, 구성원 제외 `구성원 제외`, 과제 편집 불가로 중지 `과제 종료`, 다른 연구원이 같은 기기 연결 `다른 연구원이 기기 연결`, 장기 미접속 `장기 미접속`, 마이페이지 사용 중지 `기기 사용 중지`. 시스템 작업의 이력 작성자 관리번호는 `0`.
- 장기 미접속 **30일**(`COALESCE(LAST_SEEN_DT, CREATE_DT) < NOW() - INTERVAL 30 DAY`, DB 시각). 과제 편집 가능 = 삭제·미사용 아님 + `ElnProjectGracePeriodPolicy.isEditableStatus(prgrstCcd, graceEndDe)`. 편집 불가 과제의 연결은 `SUSPENDED`(지우지 않음, 요청 시 403), 다시 편집 가능해지면 새 QR 없이 `ACTIVE`.
- 오류 코드(계약에 확정): 403 `PROJECT_NOT_LINKED`(연결 없음·끊김·구성원 아님), 403 `PROJECT_SUSPENDED`(과제 편집 불가로 중지), 403 `PAIRING_REJECTED`, 410 `PAIRING_EXPIRED`(승인 10분 경과·수령 기한 경과·취소됨), 403 `NO_PROJECT_LINKS`(재인증할 살아 있는 연결 없음), 400 `REUSED_REF_MISSING`(재사용 ref의 파일이 이 노트에 없음). 기존 `NOT_EDIT_OWNER`·`NOT_WRITABLE`·`APP_DISABLED`(기관 스위치 꺼짐 → 모든 `/api/app/v1` 403) 유지. 승인 대기는 오류가 아니라 응답 `status: "PENDING"`.
- 주기: 주기 동기화 **10분**(`600_000`), 자동 버전 **30분**(`1_800_000`, 손을 4초 이상 멈췄을 때 — `PEN_IDLE_MS` 그대로), 토큰 갱신은 마지막 갱신 후 **24시간** 또는 만료까지 **3일 미만**일 때만. 즉시 동기화(노트 나갈 때, 앱 내릴 때, 버전 저장·작성 완료, 네트워크 복귀, 앱 다시 열기) 유지. 승인 대기 상태 확인은 **3초** 간격, 대시보드 승인 확인은 진입 시 + **15초** 간격.
- 바뀐 쪽만: 페이지 PNG의 SHA-256이 직전 버전의 페이지와 같으면 그 ref를 그대로 쓴다(직전 버전의 ref 하나는 한 번만 재사용). 업로드는 이 노트의 **SENT 버전에 있던 ref만** `meta.reusedRefs`로 바이트 없이 보내고 나머지는 바이트를 보낸다. 서버는 재사용 ref를 저장 파일 `{noteMno}-{ref}.png`에서 읽어 내용 해시에 넣는다(내용 해시 정의는 그대로). `REUSED_REF_MISSING`을 받으면 앱은 그 버전을 바로 전체 바이트로 한 번 다시 보낸다.
- 화면 문구(정확히): 앱 확인 `{과제명} / 작성자 {연구원 이름} 으로 연결할까요?`(과제명·이름은 굵게), 대기 제목 `구노 웹에서 승인을 기다리는 중` + `남은 시간 m:ss` + `취소`, `PAIRING_EXPIRED` `승인 시간이 지났습니다. 연구책임자에게 새 QR을 요청하세요.`(재인증이면 `승인 시간이 지났습니다. "다시 연결"로 다시 요청하세요.`), `PAIRING_REJECTED` `구노 웹에서 연결을 거절했습니다. 연구책임자에게 새 QR을 요청하세요.`, `NO_PROJECT_LINKS` `연결된 과제가 없습니다. 연구책임자에게 과제 QR을 요청하세요.`, `INVALID_PAIRING_CODE` `코드가 맞지 않거나 만료되었습니다. 연구책임자에게 새 QR을 요청하세요.`, 끊긴 과제 배너 `이 과제의 태블릿 연결이 끊겼습니다. 올리지 않은 기록은 미반영으로 보관됩니다.`, 중지 과제 배너 `과제가 종료되어 이 과제의 태블릿 작성이 중지되었습니다. 올리지 않은 기록은 미반영으로 보관됩니다.`, 연결 과제 없음 `연결된 과제가 없습니다. 연구책임자에게 과제 QR을 요청하세요.`. 웹 모달 `{과제명} 과제에 태블릿 '{기기 이름}'({플랫폼} · {모델})을 연결할까요? 요청 시각 {HH:mm}` / 재인증 `태블릿 '{기기 이름}'({플랫폼} · {모델})을 다시 연결할까요? 연결된 과제: {과제명, …} 요청 시각 {HH:mm}` + `승인`·`거절`. 웹 상태 표시 `승인 대기`·`연결됨`·`과제 종료로 중지`·`끊김`, 기능 꺼짐 `이 기관은 태블릿 연결을 사용하지 않습니다.` 웹 화면의 모든 사용자 값은 `.text()`로 넣는다.
- 계약 원칙: `SYNC-API.md` = 서버 동작 = 모의 서버(`app/mock-server/server.mjs`) = 체험 서버(`app/src/lib/demo.ts`, 코드 검사 없이 즉시 승인). 기존 노트·버전 저장 형식과 웹 표시(바이트 동일 렌더링) 그대로.
- 이행: 기존 계정 단위 연결은 모두 끊는다 — 연결 행이 없는 기기의 토큰·이전 토큰을 지우고, 그 연결이 없는 기기 작성 중 노트를 WEB으로(이력 없이), 과제 없는 옛 연결 코드는 지운다. 스크립트는 다시 실행해도 안전해야 한다(`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN/KEY IF NOT EXISTS`, `INSERT IGNORE`, 조건부 UPDATE/DELETE).
- 서버: Java 8, 기존 보안 체인·오류 본문 `{ "error": { "code", "message" } }`·`AppApiException` 형식 유지. 웹 JSON API는 기존 관례(`ViewConstant.JSON_VIEW`, `resultCode`, 오류는 `S2RuntimeException` 메시지). 순수 도우미는 `java.*`만 import.
- 엔진 `js/engine.js`는 이 계획에서 바꾸지 않는다. 바꾸게 되면 Goono-ELN `src/main/resources/static/lib/handdrawing`에 다시 동봉한다.
- 커밋: `git -c user.name=Claude -c user.email=noreply@anthropic.com commit -m "<제목>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`. scratch 하네스·스텁은 커밋하지 않는다.

## 검증 방법 (이 환경)

- 앱: `cd app && npm test && npm run typecheck && npm run build && CHROMIUM_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" npm run test:e2e`.
- Goono-ELN: `./gradlew`는 사설 Placelink 패키지를 받지 못해 쓸 수 없다. 자바 테스트는 세션 scratchpad의 하네스로 돌린다 — `javac --release 8` + JUnit 5 console standalone + Mockito·MockMvc(Maven Central jar) + 사설 클래스 최소 스텁. 테스트 파일에는 JUnit/Mockito를 그대로 쓰고 보고·커밋 메시지에 **"Gradle 미실행"**을 적는다.
- SQL: scratch MariaDB 10.11(공식 zip)에 새 DB를 만들고 `1.goono_db_ddl.sql`~`9.app_project_link.sql`을 적용(7·8·9는 두 번)한 뒤, **실제 매퍼 XML**을 MyBatis로 실행해 픽스처로 확인한다.
- 웹 화면 스크립트: Thymeleaf 인라인 값을 치환한 스크립트를 `node --check`하고, jsdom(`ajaxPost`·`coreDialog` 스텁)에서 동작·XSS 문자열의 `.text()` 삽입을 확인한다.

## Review Focus

1. **남의 승인 요청**: 다른 사람이 연구원 명의로 연결하려는 요청이 다른 웹 사용자의 대시보드에 뜨거나 그 사람이 승인할 수 있으면 안 된다 — 목록에 없고 승인은 거부 → Task 3 `decideRejectsOtherUsersRequest`, Task 7 `pendingRequestsOnlyOwn`.
2. **분실(사용 중지)된 기기의 옛 토큰**이 나중의 과제 QR 승인으로 되살아나면 안 된다 — 승인은 사용 중지를 풀지 않고 토큰을 새로 줄 때만 푼다 → Task 3 `approvalDoesNotReviveRevokedToken`.
3. **승인 직후 응답을 잃거나 10분 끝에 승인**해도 앱이 토큰을 받는다 — 수령 기한은 승인 + 10분, 다시 확인하면 새 토큰 → Task 3 `approvedNearRequestExpiryStillDelivers`, `secondApprovedPollIssuesFreshToken`.
4. **업그레이드한 기기**(옛 계정 단위 연결, 옛 캐시 `projects`에 `linkStatus` 없음): 첫 동기화 전에는 잠그지 않고, 서버 이행 뒤 401이면 "다시 연결" 안내, 옛 노트는 미반영으로 남아 새 노트로 복원 가능 → Task 8 `linkStatusOf treats missing field as ACTIVE and missing project as ENDED`, Task 2 SQL 이행 픽스처.
5. **미반영 버전 뒤의 버전**(앞 버전이 서버에 없음)과 **같은 그림의 페이지가 둘**인 버전 — 서버에 없는 ref를 재사용으로 보내지 않고, 한 버전 안에서 ref가 겹치지 않는다 → Task 10 `splitReusedRefs only reuses refs from SENT versions`, `reuseRefs never reuses one previous ref twice`.

---

### Task 1: 계약 문서 + 모의 서버

**Files:**
- Modify: `app/docs/SYNC-API.md`, `app/mock-server/server.mjs`, `app/README.md`(모의 서버 관리 API)
- Create: `app/tests/unit/mockServer.test.mjs`

**Interfaces:**
- Produces (계약, 앱·서버 공통):
  - 웹(세션) `POST /api/eln/app/project/pairing-code {projectMno, userMno}` → `{appEnabled, code, qrPayload, expiresAt, expiresInSeconds, userNm, projectNm}`; `POST /api/eln/app/project/links {projectMno}` → `{appEnabled, links:[{linkMno|null, requestMno|null, userMno, userNm, deviceNm, platform, model, appVersion, lastSeenAt, status:"PENDING|ACTIVE|SUSPENDED|ENDED", endReason}]}`; `POST /api/eln/app/project/unlink {projectMno, linkMno}` → `{ended}`; `POST /api/eln/app/pairing-requests` → `{appEnabled, requests:[{requestMno, kind:"LINK|REAUTH", projectNm, linkedProjectNms, deviceNm, platform, model, requestedAt, expiresInSeconds}]}`; `POST /api/eln/app/pairing-requests/decide {requestMno, decision:"APPROVE|REJECT"}` → `{status}`. 기존 `POST /api/eln/app/pairing-code`(마이페이지 발급)은 **삭제**, `myDevices` 각 기기에 `projects:[{projectNm, status}]` 추가, `revokeDevice`는 모든 과제 연결 끊기.
  - 앱(익명) `POST /devices/pair/preview {pairingCode}` → 200 `{project:{projectMno,name}, user:{userMno,loginId,name}, expiresAt}`(코드 소모 없음, 실패는 401 `INVALID_PAIRING_CODE`·실패 1회); `POST /devices/pair {pairingCode, device}` → **202** `{status:"PENDING", requestToken, expiresAt, expiresInSeconds, project, user}`; `POST /devices/pair/status {requestToken}` → 200 `{status:"PENDING", expiresAt, expiresInSeconds}` | 200 `{status:"APPROVED", token, tokenExpiresAt, offlineGraceDays, user, serverTime}` | 403 `PAIRING_REJECTED` | 410 `PAIRING_EXPIRED` | 401 `UNAUTHORIZED`(모르는 값); `POST /devices/pair/cancel {requestToken}` → 200 `{status}`; `POST /devices/reauth`(헤더 Bearer = 기한 지난 토큰도 허용, 본문 `{}`) → 202 `{status:"PENDING", requestToken, expiresAt, expiresInSeconds, user, projects:[{projectMno,name}]}`, 오류 401 `UNAUTHORIZED`·401 `DEVICE_REVOKED`·403 `NO_PROJECT_LINKS`.
  - `GET /bootstrap`의 `projects` = **이 기기 묶음의 연결 과제만** `[{projectMno, name, writable, linkStatus:"ACTIVE|SUSPENDED|ENDED"}]`(`writable` = ACTIVE이고 편집 가능). `POST /notes`·`/versions`·`/release`에 403 `PROJECT_NOT_LINKED`·`PROJECT_SUSPENDED`. `/versions` 평가 순서: 1 400·413 multipart → 2 404 → 3 400 meta → 4 duplicate → **5 403 링크** → 6 409 `NOT_EDIT_OWNER` → 7 409 `NOT_WRITABLE` → 8 409 `STALE_BASE` → 9 413 → 10 400 `INVALID_REQUEST`(필드 이름·ref 형식, `reusedRefs` 형식·업로드 필드와 겹침, 본문의 `blob:goono-app/{ref}`가 업로드·재사용 어디에도 없음) → **11 400 `REUSED_REF_MISSING`** → 12 422 → 13 400 같은 ref 다른 바이트. `/release`: 400 → 404 → 403 링크 → 409 `NOT_EDIT_OWNER` → 409 `VERSION_MISMATCH`. `/notes` 생성: 400 → 같은 clientNoteId면 200 기존 → 403 링크 → 403 `PROJECT_NOT_WRITABLE`. `meta.reusedRefs`: 선택, 문자열 배열(아니면 400 `BAD_REQUEST`), 413 계산엔 전송 바이트만.
  - `/devices/refresh` 설명을 "하루 1번 또는 만료 3일 전"으로. `/devices/register`(보조 경로)는 토큰만 주고 과제 연결은 만들지 않는다(연결은 과제 QR + 승인으로만). 끊김·중지·재개·장기 미접속·다른 연구원 연결 규칙과 이력 내용(Global Constraints), 이행 규칙, DB 변경안 표(Task 2 표 정의).
- Produces (모의 서버 관리 API): `POST /__admin/pairing-code {loginId, projectMno, ttlMs?}`(구성원 아니면 404); `POST /__admin/approve {loginId, decision?:"APPROVE"|"REJECT"}`(그 사용자의 가장 오래된 PENDING 요청 결정 → `{requestMno, status}`, 없으면 404); `POST /__admin/unlink {deviceId, loginId, projectMno}`; `POST /__admin/projects/:projectMno/state {editable}`; `POST /__admin/projects/:projectMno/remove-member {loginId}`; `POST /__admin/devices/:deviceId/last-seen {loginId, daysAgo}`; `POST /__admin/daily`(하루 작업); `POST /__admin/notes/:noteMno/forget-images`(저장 이미지 기록 지움); `/__admin/config`에 `requestTtlMs`; `/__admin/devices/:deviceId/revoke`는 연결 끊기 + 노트 WEB. `GET /__admin/state`에 `links`, `requests`, 버전별 `uploadedImages`·`reusedImages`. 프로젝트 구성원: researcher1 → 3·4·5, researcher2 → 3·4. 서버를 `PORT=0`으로 띄우면 실제 포트를 `[mock-eln] http://localhost:<port>` 줄로 알린다.

- [ ] **Step 1: 실패하는 테스트** — `mockServer.test.mjs`(모의 서버를 `PORT=0`으로 띄워 fetch): `project QR: preview does not consume, pair → 202 PENDING, approve → APPROVED token`, `reject → 403 PAIRING_REJECTED`, `approval window passed → 410 PAIRING_EXPIRED`(`requestTtlMs:1`), `bootstrap lists only linked projects with linkStatus`, `note in unlinked project → 403 PROJECT_NOT_LINKED`, `unlink returns device notes to WEB with history 연결 끊김`, `second project QR (same user) adds a link`, `other researcher approval ends previous links (다른 연구원이 기기 연결)`, `reauth with expired token keeps links; no live links → 403 NO_PROJECT_LINKS`, `daily: closed project suspends then resumes, 31 days unseen ends (장기 미접속), removed member ends (구성원 제외)`, `reusedRefs: stored ref accepted and counted in hash; unknown → 400 REUSED_REF_MISSING; overlap → 400 INVALID_REQUEST`.
- [ ] **Step 2: 실패 확인** — `npm test` → 새 테스트 실패, 기존 단위 테스트 통과.
- [ ] **Step 3: SYNC-API.md** — Interfaces 계약대로 §0 재작성(과제 QR 발급·미리보기·연결·승인 대기·상태·취소·재인증·웹 승인 API·연결 수명), §2·§3·§5·§6·§7·서버 규칙·DB 변경안 갱신.
- [ ] **Step 4: 모의 서버** — 계약대로. 하루 작업은 Task 2 `jobAction`과 같은 우선순위(끊김 → 구성원 아님 → 장기 미접속 → 중지 → 재개). 이미지 기록은 노트별 `{ref: {sha256, saveNm}}`.
- [ ] **Step 5: 통과 확인** — `npm test` → 전부 통과. `npm run typecheck`.
- [ ] **Step 6: Commit** — `docs: 과제별 태블릿 연결·승인·재인증·바뀐 쪽만 올리기 계약과 모의 서버`

### Task 2: DB(9.app_project_link.sql) + 순수 규칙 + 연결 저장

**Files:**
- Create: `deploy/src/ddl/mariadb/9.app_project_link.sql`, `src/main/java/so/goono/eln/app/support/AppLinkRules.java`, `src/main/java/so/goono/eln/app/vo/{AppProjectLinkVO,AppPairingRequestVO}.java`, `src/main/java/so/goono/eln/app/service/AppLinkMapper.java`, `src/main/resources/meta-mappers/eln/app/appLink-mapper.xml`
- Modify: `src/main/java/so/goono/eln/app/service/AppDeviceMapper.java`, `src/main/resources/meta-mappers/eln/app/appDevice-mapper.xml`
- Test: `src/test/java/so/goono/eln/app/support/AppLinkRulesTest.java`

**Interfaces:**
- Produces:
  - 표: `PL_APP_PROJECT_LINK (LINK_MNO PK /*FN_SEQ('PL_APP_PROJECT_LINK.LINK_MNO')*/, DEVICE_MNO NOT NULL, PROJECT_MNO NOT NULL, STATUS_CCD VARCHAR(10) NOT NULL /*ACTIVE|SUSPENDED|ENDED*/, END_REASON_CCD VARCHAR(20) NULL /*LEADER|MEMBER_REMOVED|REVOKED|HANDOVER|INACTIVE*/, ISSUER_MNO NULL, LINKED_DT NOT NULL, SUSPENDED_DT NULL, ENDED_DT NULL, ENDED_USER_MNO NULL, CREATE_DT, MODIFY_DT, UNIQUE(DEVICE_MNO, PROJECT_MNO), KEY(PROJECT_MNO, STATUS_CCD))`; `PL_APP_PAIRING_REQUEST (REQUEST_MNO PK /*FN_SEQ*/, REQUEST_SE_CCD VARCHAR(10) /*LINK|REAUTH*/, USER_MNO NOT NULL, PROJECT_MNO NULL, ISSUER_MNO NULL, DEVICE_MNO NULL, DEVICE_ID VARCHAR(64), DEVICE_NM VARCHAR(100), PLATFORM VARCHAR(20), MODEL VARCHAR(100), APP_VERSION VARCHAR(30), REQUEST_TOKEN_HASH CHAR(64) UNIQUE, STATUS_CCD VARCHAR(10) /*PENDING|APPROVED|REJECTED|EXPIRED|CANCELED*/, EXPIRES_DT, DECIDED_DT NULL, CREATE_DT, KEY(USER_MNO, STATUS_CCD))`; `PL_APP_PAIRING_CODE` + `PROJECT_MNO`, `ISSUER_MNO`(NULL 허용), `KEY(USER_MNO, PROJECT_MNO)`; `PL_SEQ` 두 행; 이행(Global Constraints — 노트 WEB은 `(EDIT_DEVICE_MNO, 노트의 PROJECT_MNO)` 연결 행이 없을 때, 토큰은 기기에 연결 행이 하나도 없을 때).
  - `AppLinkRules`(java.*만): 상태 상수 `LINK_ACTIVE/LINK_SUSPENDED/LINK_ENDED`, `REQ_PENDING/REQ_APPROVED/REQ_REJECTED/REQ_EXPIRED/REQ_CANCELED`, `SE_LINK/SE_REAUTH`, `REQUEST_VALID_MINUTES=10`, `DELIVERY_VALID_MINUTES=10`, `INACTIVE_DAYS=30`; `enum EndReason { LEADER, MEMBER_REMOVED, REVOKED, HANDOVER, INACTIVE; String historyText() }`(Global Constraints 문구), `SUSPEND_HISTORY_TEXT="과제 종료"`; `static String effectiveStatus(String statusCcd, boolean member, boolean projectAvailable, boolean projectEditable)`(ENDED 또는 구성원 아님 → ENDED, 그 밖에 삭제·미사용·편집 불가 → SUSPENDED, 아니면 ACTIVE); `enum JobAction { NONE, SUSPEND, RESUME, END_MEMBER, END_INACTIVE }`, `static JobAction jobAction(String statusCcd, boolean member, boolean projectAvailable, boolean projectEditable, boolean deviceInactive)`(우선순위 ENDED→NONE, 구성원 아님→END_MEMBER, 미접속→END_INACTIVE, ACTIVE·편집 불가→SUSPEND, SUSPENDED·편집 가능→RESUME); `static String pollOutcome(String requestStatusCcd, boolean requestExpired, boolean deliveryExpired)` → `PENDING|APPROVED|REJECTED|EXPIRED`(EXPIRED·CANCELED·기한 지난 PENDING·수령 기한 지난 APPROVED → EXPIRED).
  - `AppProjectLinkVO`: linkMno, deviceMno, projectMno, projectNm, statusCcd, endReasonCcd, linkedDt, endedDt, memberYn, projectAvailableYn, projectPrgrstCcd, graceEndDe, deviceInactiveYn, userMno, userNm, deviceId, deviceNm, platform, model, appVersion, lastSeenDt. `AppPairingRequestVO`: requestMno, requestSeCcd, userMno, loginId, userNm, projectMno, projectNm, issuerMno, deviceMno, deviceId, deviceNm, platform, model, appVersion, statusCcd, expiresDt, decidedDt, createDt, expiredYn, deliveryExpiredYn, secondsLeft.
  - `AppLinkMapper`: `insertRequest(AppPairingRequestVO)`(selectKey, `EXPIRES_DT = NOW() + 10분`), `selectRequestByTokenHash(String)`, `selectRequestForUpdate(long)`, `cancelPendingRequests(String deviceId, long userMno, Long projectMno)`, `cancelRequestByTokenHash(String)`, `decideRequest(long requestMno, long userMno, String statusCcd, Long deviceMno)`(PENDING·기한 안·같은 사용자일 때만 1), `selectPendingRequests(long userMno)`, `selectProjectPendingRequests(long projectMno)`, `upsertLink(long deviceMno, long projectMno, Long issuerMno)`(ACTIVE, 끝 정보 지움), `selectLinkState(long deviceMno, long projectMno)`, `selectDeviceLinks(long deviceMno)`(모든 상태, 과제 이름·상태 열 포함), `selectLiveLinksOfDevice(long deviceMno)`, `selectLiveLinksOfOtherUsers(String deviceId, long userMno)`, `selectLiveLinksOfMember(long projectMno, long userMno)`, `selectProjectLinks(long projectMno)`(ENDED는 30일 안에 끝난 것만), `selectLinksForJob()`(ACTIVE·SUSPENDED + 구성원·과제·미접속 열), `endLink(long linkMno, String reasonCcd, long actorMno)`(ENDED 아닌 행만), `suspendLink(long)`(ACTIVE만), `resumeLink(long)`(SUSPENDED만), `selectEditNoteMnos(long deviceMno, Long projectMno)`(`FOR UPDATE`, projectMno null이면 전체), `countProjectManager(long projectMno, long userMno)`, `countProjectMember(long projectMno, long userMno)`, `deleteOldRequests()`(결정·만료 7일 지난 행), `insertNoteHist(long noteMno, String content, long trgtMno, long createUserMno)`(`FN_SEQ('PL_ELN_NOTE_HIST.NOTE_HIST_MNO')`, `NOTE_EDIT_RECLAIM`, `CRUD_SE_CCD='U'` — 세션이 없는 작업에서도 쓰려고 작성자를 인자로 받는다).
  - `AppDeviceMapper` 변경: `deletePairingCodesForIssue(long userMno, long projectMno)`(그 (사용자, 과제) 미사용 + 모든 만료 행), `insertPairingCode(String codeHash, long userMno, long projectMno, long issuerMno, int validMinutes)`, `selectValidPairingCode(String codeHash)` → `AppPairingRequestVO`(미사용·기한 안·`PROJECT_MNO` 있음, 사용자·과제 이름 조인), `usePairingCode`에 `PROJECT_MNO IS NOT NULL` 조건, `selectPairingCodeTarget(String codeHash)` → `AppPairingRequestVO`, `upsertDeviceOnApprove(AppDeviceInfo device, long userMno)`(새 행은 토큰 없음·사용 중; 있는 행은 이름·플랫폼·모델·앱 버전만 — **사용 중지·토큰은 건드리지 않음**), `issueToken(long deviceMno, String tokenHash, int graceDays)`(새 토큰·기한, 이전 토큰 지움, 사용 중지 해제).

- [ ] **Step 1: 실패하는 테스트** — `AppLinkRulesTest`: `effectiveStatusEndedWins`, `nonMemberIsEnded`, `deletedOrClosedProjectIsSuspended`, `jobActionPriority`(구성원 아님 + 미접속 → END_MEMBER, 미접속 + 편집 불가 → END_INACTIVE, ACTIVE·편집 불가 → SUSPEND, SUSPENDED·편집 가능 → RESUME, ENDED → NONE), `pollOutcomeExpiresPendingAfterWindow`, `pollOutcomeExpiresUndeliveredApproval`, `canceledPollsAsExpired`, `endReasonHistoryTexts`(6개 문구 정확히).
- [ ] **Step 2: 실패 확인** → 컴파일 오류.
- [ ] **Step 3: 구현** — `AppLinkRules`, VO, DDL.
- [ ] **Step 4: 순수 테스트 통과 확인** — 기존 순수 테스트 포함 전부 통과.
- [ ] **Step 5: SQL 검증(실제 매퍼 XML)** — 새 DB에 7·8·9를 두 번 적용, `SHOW CREATE TABLE` 확인. 픽스처: 코드 재발급 시 같은 (사용자, 과제)의 이전 코드만 무효(다른 과제 코드는 유지), 과제 없는 옛 코드로 `usePairingCode` 0, 요청 결정은 다른 사용자·만료 후 0, `upsertDeviceOnApprove`가 사용 중지된 행의 `REVOKED_YN`·`TOKEN_HASH`를 바꾸지 않음, `issueToken`이 사용 중지를 풂, `upsertLink`가 ENDED 행을 ACTIVE로, `endLink`·`suspendLink`·`resumeLink`를 두 번 불러도 두 번째는 0, `selectLinksForJob`의 미접속 판정(29일·31일), 이행 — 연결 없는 기기의 토큰 NULL·연결 없는 DEVICE 노트 WEB, 연결 행이 있는 기기·노트는 그대로(스크립트 재실행 후에도).
- [ ] **Step 6: Commit** — `feat: 과제별 태블릿 연결·승인 요청 저장(9.app_project_link.sql)과 연결 규칙` (Gradle 미실행)

### Task 3: 과제 QR 발급·미리보기·연결 요청·승인·재인증 흐름

**Files:**
- Create: `src/main/java/so/goono/eln/app/service/AppLinkService.java`, `src/main/java/so/goono/eln/app/vo/{AppPairPending,AppPairPoll}.java`
- Modify: `src/main/java/so/goono/eln/app/controller/AppDeviceController.java`, `src/main/java/so/goono/eln/app/security/AppTokenFilter.java`, `src/main/java/so/goono/eln/app/config/AppSecurityConfig.java`, `src/main/java/so/goono/eln/app/service/AppDeviceService.java`(옛 `pair`·`issuePairingCode` 제거, `qrPayload` 재사용)
- Test: `src/test/java/so/goono/eln/app/service/AppLinkServiceTest.java`, `src/test/java/so/goono/eln/app/controller/AppDeviceApiTest.java`

**Interfaces:**
- Consumes: Task 2 전부; `AppTokens`, `PairingCodes`, `PairAttemptLimiter`, `AppClientIp`.
- Produces:
  - `AppPairPending { String requestToken; Date expiresAt; long expiresInSeconds; AppPairingRequestVO request; List<AppProjectLinkVO> links /* 재인증만 */ }`, `AppPairPoll { String status /* PENDING|APPROVED */; Date expiresAt; long expiresInSeconds; AppTokenIssue issue /* APPROVED만 */ }`.
  - `AppLinkService`:
    - `AppPairingCodeVO issueProjectCode(long projectMno, long researcherMno, long issuerMno, String serverUrl)` — 발급자 책임자 아님 → `S2RuntimeException(i18n.error.write)`, 대상이 구성원 아님 → `S2RuntimeException("과제 구성원에게만 QR을 만들 수 있습니다.")`.
    - `AppPairingRequestVO previewPair(String rawCode)` — 401 `INVALID_PAIRING_CODE`.
    - `AppPairPending requestPair(String rawCode, AppDeviceInfo device)` — 400 `BAD_REQUEST`(기기 정보, 코드 소비 안 함), 401 `INVALID_PAIRING_CODE`; 코드 소비 → 같은 (기기 ID, 사용자, 과제)의 PENDING 취소 → 요청 생성(요청 토큰은 `AppTokens.newToken`, DB엔 해시).
    - `AppPairPoll pollPair(String rawRequestToken)` — 401 `UNAUTHORIZED`, 403 `PAIRING_REJECTED`, 410 `PAIRING_EXPIRED`; APPROVED면 `issueToken`으로 새 토큰.
    - `void cancelPair(String rawRequestToken)`.
    - `AppPairPending requestReauth(AppDeviceVO device)` — 살아 있는(ACTIVE·SUSPENDED) 연결 없음 → 403 `NO_PROJECT_LINKS`; 이 기기 묶음의 이전 PENDING 재인증은 취소.
    - `List<AppPairingRequestVO> selectPendingRequests(long userMno)`; `List<AppProjectLinkVO> selectLiveLinks(long deviceMno)`; `List<AppProjectLinkVO> selectDeviceLinks(long deviceMno)`(모든 상태 — 마이페이지용).
    - 의존 방향: `AppLinkService`는 `AppDeviceService`를 주입하지 않는다(Task 4에서 `AppDeviceService`가 `AppLinkService`를 쓴다). 토큰은 `AppTokens` + `AppDeviceMapper.issueToken`, 기한 일수는 `@Value("${app.device.offline-grace-days:14}")`, 노트 되돌리기는 `AppNoteMapper.updateNoteReclaimToWeb`, QR 내용은 `AppDeviceService.qrPayload`(정적).
    - `String decideRequest(long requestMno, long userMno, boolean approve)` → `APPROVED|REJECTED` — 남의 요청·만료·처리됨 → `S2RuntimeException("승인 요청이 만료되었거나 이미 처리되었습니다.")`. LINK 승인: 연구원이 아직 구성원이어야 함(아니면 `S2RuntimeException("과제 구성원이 아니어서 연결할 수 없습니다.")`) → `upsertDeviceOnApprove` → `upsertLink` → 같은 `DEVICE_ID`의 다른 연구원 묶음 `endAllLinks(…, HANDOVER, userMno)`. REAUTH 승인: 상태만 바꾼다.
    - `int endAllLinks(long deviceMno, AppLinkRules.EndReason reason, long actorMno)` — 그 묶음의 살아 있는 연결을 ENDED로, `selectEditNoteMnos(deviceMno, null)` 노트를 WEB(`updateNoteReclaimToWeb`) + 이력(`reason.historyText()`, 대상 = deviceMno, 작성자 = actorMno). 끊은 연결 수.
    - `boolean isProjectManager(long projectMno, long userMno)`.
  - 기기 API: Task 1 계약대로 `/devices/pair/preview`(IP 제한 확인 → 실패 기록), `/devices/pair`(202), `/devices/pair/status`, `/devices/pair/cancel`, `/devices/reauth`(필터를 거치지 않고 컨트롤러가 `Authorization`을 `AppDeviceService.authenticate`로 확인 — null → 401 `UNAUTHORIZED`, 사용 중지 → 401 `DEVICE_REVOKED`, 기한 지남은 허용). 네 경로는 `AppSecurityConfig` permitAll + `AppTokenFilter`가 인증 없이 통과(기관 스위치 검사는 그대로 먼저).

- [ ] **Step 1: 실패하는 테스트(Gradle 미실행, 하네스로 실행)** — `AppLinkServiceTest`(목 매퍼): `issueRequiresManager`, `issueRequiresMemberTarget`, `previewDoesNotConsumeCode`, `pairConsumesCodeAndCreatesPendingRequest`, `pairRejectsInvalidDeviceWithoutConsuming`, `pollPendingReturnsSecondsLeft`, `pollRejectedIs403`, `pollExpiredIs410`, `approvedNearRequestExpiryStillDelivers`(요청 기한은 지났지만 수령 기한 안), `secondApprovedPollIssuesFreshToken`, `decideRejectsOtherUsersRequest`, `approveFailsWhenNoLongerMember`, `approvalDoesNotReviveRevokedToken`(승인 시 `issueToken` 미호출·`upsertDeviceOnApprove`만), `approveLinkEndsOtherResearchersLinks`(이력 `다른 연구원이 기기 연결`, 노트 WEB), `reauthWithoutLiveLinksIs403`, `reauthApprovalKeepsLinks`. `AppDeviceApiTest` 추가: `previewFailureCountsTowardLimit`, `pairReturns202Pending`, `statusAndCancelAreAnonymous`, `reauthAcceptsExpiredToken`, `reauthRevokedIs401DeviceRevoked`, `newEndpointsReturnAppDisabledWhenOff`.
- [ ] **Step 2: 실패 확인** → 컴파일 오류·실패.
- [ ] **Step 3: 구현** — Interfaces대로, 쓰기 메서드 `@Transactional`.
- [ ] **Step 4: 통과 확인** — 하네스에서 기존 기기 API 테스트 포함 전부 통과(옛 `pair` 토큰 응답 테스트는 202 계약으로 고친다). SQL: 승인 → 기기 행·연결 행 생성, 다른 연구원 승인 → 앞 연구원 연결 ENDED·노트 WEB·이력 1건씩.
- [ ] **Step 5: Commit** — `feat: 과제 QR 연결 요청·구노 웹 승인·재인증 흐름` (Gradle 미실행)

### Task 4: 과제 연결 검사 + 끊김·중지 규칙 + 하루 1번 작업

**Files:**
- Create: `src/main/java/so/goono/eln/app/AppLinkScheduler.java`
- Modify: `AppLinkService.java`, `src/main/java/so/goono/eln/app/service/AppNoteService.java`, `src/main/java/so/goono/eln/app/controller/AppNoteController.java`(bootstrap), `src/main/java/so/goono/eln/app/vo/AppProjectVO.java`(`linkStatus`), `src/main/java/so/goono/eln/app/service/AppDeviceService.java`(`revoke` → 연결 끊기), `src/main/java/so/goono/eln/project/service/ElnProjectMemberService.java`(`deleteProjectMembers`의 삭제 성공 뒤 훅), `src/main/resources/config/eln.properties`
- Test: `AppLinkServiceTest`, `src/test/java/so/goono/eln/app/AppLinkSchedulerTest.java`, `src/test/java/so/goono/eln/app/controller/{AppNoteApiTest,AppNoteVersionApiTest}.java`

**Interfaces:**
- Consumes: Task 2 `AppLinkRules.effectiveStatus`·`jobAction`, Task 3 `endAllLinks`; `ElnProjectGracePeriodPolicy.isEditableStatus`.
- Produces:
  - `void requireActiveLink(AppDeviceVO device, Long projectMno)` — 연결 없음·ENDED·구성원 아님·projectMno null → 403 `PROJECT_NOT_LINKED`, SUSPENDED 판정 → 403 `PROJECT_SUSPENDED`(요청 시 과제 상태로 계산 — 작업 전이라도).
  - `List<AppProjectVO> selectLinkedProjects(AppDeviceVO device)` — 연결 과제만, 이름순, `linkStatus` = effectiveStatus, `writable` = ACTIVE.
  - `int endLink(long projectMno, long linkMno, AppLinkRules.EndReason reason, long actorMno)`, `int endLinksForMember(long projectMno, long userMno, long actorMno)`(MEMBER_REMOVED), `List<AppProjectLinkVO> selectLinksForJob()`, `AppLinkRules.JobAction applyJobAction(AppProjectLinkVO link)`(자기 트랜잭션, 조건부 UPDATE가 0이면 아무것도 하지 않음; SUSPEND는 그 과제의 그 기기 노트 WEB + 이력 `과제 종료`, END_*는 그 과제 노트 WEB + 사유 이력), `int cleanupExpired()`(`deleteOldRequests`).
  - `AppNoteService`: `createNote`는 기존 노트 멱등 확인 뒤 `requireActiveLink`, `uploadVersion`은 duplicate 판정 뒤·`NOT_EDIT_OWNER` 앞, `release`는 노트 잠금 뒤·`NOT_EDIT_OWNER` 앞(노트의 과제는 `selectNoteProject`). bootstrap `projects` = `selectLinkedProjects`.
  - `AppDeviceService.revoke(deviceMno, userMno)`가 1이면 `endAllLinks(deviceMno, REVOKED, userMno)`.
  - `AppLinkScheduler`(`@Profile("!0_LOCAL") @Component`): `@Scheduled(cron = "${app.device.link-job.cron:0 40 3 * * *}") void runDaily()` → `int[] runOnce()`(링크마다 `applyJobAction`, 한 건 실패는 로그 후 계속, 끝에 `cleanupExpired`) — 반환 {중지, 재개, 끊김}. 설정 `app.device.link-job.cron=0 40 3 * * *`(한국어 주석 유니코드 이스케이프).

- [ ] **Step 1: 실패하는 테스트(Gradle 미실행)** — `AppLinkServiceTest`: `requireActiveLinkNotLinked`, `requireActiveLinkSuspendedWhenProjectClosedBeforeJob`, `requireActiveLinkEndedWhenMemberRemoved`, `endLinkReturnsOnlyThatProjectsNotes`(이력 `연결 끊김`), `revokeEndsAllLinksWithHistory`(`기기 사용 중지`), `memberRemovalEndsLinks`(`구성원 제외`), `jobSuspendsThenResumesWithoutNewQr`, `jobEndsInactiveDevice`(`장기 미접속`), `jobTransitionsAreIdempotent`(조건부 UPDATE 0 → 노트·이력 손대지 않음). `AppLinkSchedulerTest`: `oneFailingLinkDoesNotStopOthers`. `AppNoteApiTest`: `bootstrapListsOnlyLinkedProjects`, `createNoteInUnlinkedProjectIs403`, `createNoteExistingClientNoteIdStill200`. `AppNoteVersionApiTest`: `uploadInEndedLinkIs403BeforeNotEditOwner`, `uploadInSuspendedProjectIs403ProjectSuspended`, `duplicateUploadStill200AfterUnlink`, `releaseInEndedLinkIs403`.
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현** — Interfaces대로. 구성원 삭제 훅은 `deleteProjectMembers`의 `cnt > 0` 분기 안에서 `endLinksForMember(projectMno, userMno, loginUserMno)`.
- [ ] **Step 4: 통과 확인** — 하네스 전체 + SQL: 과제 완료(유예 없음) → 작업 1회 → 연결 SUSPENDED·노트 WEB·이력 1건, 다시 실행 → 변화 없음, 유예 연장 → 작업 → ACTIVE, 31일 미접속 → ENDED.
- [ ] **Step 5: Commit** — `feat: 노트 API의 과제 연결 검사와 끊김·과제 종료·장기 미접속 처리(하루 1번 작업)` (Gradle 미실행)

### Task 5: 서버 — 바뀐 쪽만 올리기(재사용 ref)

**Files:**
- Modify: `src/main/java/so/goono/eln/app/service/AppNoteService.java`(`VersionMeta.reusedRefs`, `uploadVersion` 10·11단계), `src/main/java/so/goono/eln/app/support/AppRefRules.java`
- Test: `src/test/java/so/goono/eln/app/support/AppRefRulesTest.java`, `src/test/java/so/goono/eln/app/controller/AppNoteVersionApiTest.java`

**Interfaces:**
- Consumes: Task 1 계약 §6, `ElnNoteEditorService.readInlineImage`·`inlineImageSrc`.
- Produces: `AppRefRules.reusedSaveNm(long noteMno, String ref)` → `storedRef(noteMno, ref) + ".png"`. `uploadVersion`: `reusedRefs` 형식(배열 아님·문자열 아닌 원소 → 400 `BAD_REQUEST`; ref 규칙 위반·업로드 필드와 겹침·본문의 blob ref가 업로드·재사용 어디에도 없음 → 400 `INVALID_REQUEST`) → 재사용 파일 읽기(없음 → 400 `REUSED_REF_MISSING`) → 업로드 + 재사용 바이트로 `AppContentHash.compute` → 재사용 ref는 `inlineImageSrc(noteMno, reusedSaveNm)`로 치환, 새로 저장하지 않음. 크기 상한은 전송 바이트만.

- [ ] **Step 1: 실패하는 테스트(Gradle 미실행)** — `AppRefRulesTest.reusedSaveNmIsPng`; `AppNoteVersionApiTest`: `reusedRefUsesStoredFile`(저장 HTML의 img src가 앞 버전과 같은 파일, 새 파일 저장 없음), `reusedRefCountsInHash`(재사용 바이트를 빼고 계산한 해시 → 422), `reusedRefMissingIs400ReusedRefMissing`, `reusedRefOverlappingUploadIs400InvalidRequest`, `contentRefWithoutImageIs400InvalidRequest`, `reusedRefsNotArrayIs400BadRequest`, `reusedBytesNotCountedInSizeLimit`.
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — 하네스 전체, 고정 입력의 해시가 Task 1 모의 서버와 같은 값.
- [ ] **Step 5: Commit** — `feat: 버전 올리기에서 이전 페이지 그림 재사용(reusedRefs)` (Gradle 미실행)

### Task 6: 웹 — 과제 화면 "태블릿 연결" 영역

**Files:**
- Create: `src/main/java/so/goono/eln/app/controller/AppProjectLinkWebController.java`, `src/main/resources/templates/basic/eln/project/project_details_tablet.html`(`th:fragment="tabletArea"`)
- Modify: `src/main/java/so/goono/eln/project/controller/ElnProjectController.java`(`projectDetailsMember`에 `appLinkManagerYn`·`appDeviceEnabled`), `src/main/resources/templates/basic/eln/project/project_details_member.html`(책임자일 때만 fragment 포함), `AppLinkService`(`selectProjectLinks`), `AppPairingWebController`(QR 서버 주소 규칙을 `static String serverUrl(String appBaseUrl, HttpServletRequest request)`로 빼서 두 컨트롤러가 함께 쓴다)
- Test: `src/test/java/so/goono/eln/app/controller/AppProjectLinkWebControllerTest.java`

**Interfaces:**
- Consumes: Task 3 `issueProjectCode`, `isProjectManager`, `AppPairingWebController.serverUrl` 규칙(`app.base-url`); Task 4 `endLink(…, LEADER, loginUserMno)`; 기존 `/api/eln/member/projectMemberList`.
- Produces: Task 1 웹 API 3개(`project/pairing-code`, `project/links`, `project/unlink`) — 모두 세션 사용자가 그 과제 책임자여야 함(아니면 `i18n.error.write`), 기능 꺼짐이면 `{appEnabled:false}`만. `AppLinkService.selectProjectLinks(long projectMno)` → 연결 행 + PENDING 요청을 한 목록(`status` PENDING)으로. 화면: 구성원 선택 + `QR 만들기` → QR(`qrcode-generator`) + 코드 + 남은 시간(5:00, `expiresInSeconds`로, 0이면 QR 숨김) + `새 QR`; 기기 목록(연구원, 기기 이름, 플랫폼·모델, 앱 버전, 마지막 접속, 상태 문구) + `연결 끊기`(확인 대화상자 `이 기기의 이 과제 연결을 끊을까요? 기기에서 작성 중인 노트는 웹으로 돌아옵니다.`); 기능 꺼짐 안내.

- [ ] **Step 1: 실패하는 테스트(Gradle 미실행)** — `projectCodeRequiresManager`, `projectCodeRejectsNonMemberTarget`, `projectCodeAllowsSelf`, `projectCodeDisabledReturnsAppEnabledFalse`, `linksListsPendingActiveSuspendedEnded`, `unlinkRequiresManager`, `unlinkEndsWithLeaderReason`.
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인 + 화면 확인(jsdom)** — QR 렌더 후 `jsqr` 디코드 = `qrPayload`, 카운트다운 0 → QR 숨김, 상태 문구 4종, XSS 문자열(기기 이름 `<img src=x onerror=…>`)이 텍스트로, 기능 꺼짐 안내, 책임자 아님이면 영역 없음(Thymeleaf 조건).
- [ ] **Step 5: Commit** — `feat: 과제 화면 태블릿 연결 — 구성원 QR 발급·연결 기기 목록·연결 끊기` (Gradle 미실행)

### Task 7: 웹 — 대시보드 승인 모달 + 마이페이지 축소

**Files:**
- Modify: `src/main/java/so/goono/eln/app/controller/AppPairingWebController.java`(`pairing-code` 삭제, `pairing-requests`·`pairing-requests/decide` 추가, `myDevices`에 `projects`), `src/main/resources/templates/basic/eln/dashboard/dashboard.html`(모달 + 스크립트), `src/main/resources/templates/basic/system/user/mypageDevices.html`(QR 영역 삭제, 기기별 연결 과제 표시, 사용 중지 확인 문구 `이 기기의 모든 과제 연결이 끊기고, 기기에서 작성 중인 노트는 웹으로 돌아옵니다.`), `deploy/src/ddl/mariadb/9.app_project_link.sql`(메뉴 이름 `내 태블릿`), `src/main/resources/messages/messages.properties`·`messages_en.properties`(`i18n.menu.mypage.devices` = 내 태블릿 / My tablets)
- Test: `src/test/java/so/goono/eln/app/controller/AppPairingWebControllerTest.java`

**Interfaces:**
- Consumes: Task 3 `selectPendingRequests`, `decideRequest`, `selectLiveLinks`, `selectDeviceLinks`; Task 4 `AppDeviceService.revoke`(연결 끊기 포함).
- Produces: Task 1 웹 API 2개(세션 사용자 본인 것만; 기능 꺼짐이면 `{appEnabled:false, requests:[]}`). REAUTH 요청의 `linkedProjectNms` = 그 기기 묶음의 살아 있는 연결 과제 이름. 대시보드: 진입 시 + 15초마다 조회(모달이 떠 있으면 건너뜀), 요청을 하나씩 모달로(Global Constraints 문구, 요청 시각 `HH:mm`), `승인`·`거절` → decide → 다음 요청, 만료 오류면 안내 후 다음.

- [ ] **Step 1: 실패하는 테스트(Gradle 미실행)** — `pendingRequestsOnlyOwn`, `decideOtherUsersRequestFails`, `decideExpiredRequestFails`, `pairingCodeEndpointRemoved`(404), `myDevicesListsLinkedProjects`, `revokeEndsLinks`.
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인 + 화면 확인(jsdom)** — 요청 2건 → 모달 차례대로, 승인 클릭 → decide 호출 인자, 15초 타이머가 모달 중엔 조회 안 함, LINK·REAUTH 문구, XSS 문자열 텍스트 처리; 마이페이지 — QR 버튼 없음, 기기별 과제·상태, 사용 중지 확인 문구.
- [ ] **Step 5: Commit** — `feat: 대시보드 태블릿 연결 승인 창, 마이페이지는 내 기기·사용 중지만` (Gradle 미실행)

### Task 8: 앱 — 연결 로직(승인 대기·재인증·과제별 잠금)

**Files:**
- Modify: `app/src/lib/{types,api,session,pairing,rules,sync,demo}.ts`, `app/src/screens/Connect.tsx`(컴파일이 되도록 `requestPair`+`pollPair` 최소 연결만 — 화면은 Task 9)
- Test: `app/tests/unit/{pairing,rules}.test.mjs`

**Interfaces:**
- Consumes: Task 1 계약.
- Produces:
  - `types.ts`: `export type LinkStatus = 'ACTIVE' | 'SUSPENDED' | 'ENDED'`; `Project`에 `linkStatus?: LinkStatus`; `Session`에 `lastRefreshAt?: string`.
  - `api.ts`: `previewPair(serverUrl, pairingCode): Promise<PairPreview>`(`{project:{projectMno,name}, user: User, expiresAt}`), `pair(serverUrl, pairingCode, device): Promise<PairPendingResponse>`(`{status:'PENDING', requestToken, expiresAt, expiresInSeconds, project?, user, projects?}`), `pairStatus(serverUrl, requestToken): Promise<{status:'PENDING'; expiresAt; expiresInSeconds} | ({status:'APPROVED'} & RegisterResponse)>`, `cancelPair(serverUrl, requestToken): Promise<{status: string}>`, `reauth(serverUrl, token): Promise<PairPendingResponse>`.
  - `session.ts`: `export interface PendingPair { kind: 'LINK' | 'REAUTH'; serverUrl: string; deviceName: string; requestToken: string; expiresAt: string; expiresInSeconds: number; projectName?: string; userName: string; linkedProjectNames?: string[] }`; `previewPair(serverUrl, code): Promise<PairPreview>`(다른 계정이고 올리지 않은 기록이 있으면 **코드를 쓰기 전에** 기존 거부 문구로 throw); `requestPair(serverUrl, code, deviceName): Promise<PendingPair>`; `requestReauth(): Promise<PendingPair>`; `pollPair(p: PendingPair): Promise<Session | { pending: true; expiresInSeconds: number }>`(APPROVED면 기존 `connect` 공통 처리로 세션 저장 — 같은 계정이면 데이터 유지, `lastRefreshAt` = 지금); `cancelPair(p: PendingPair): Promise<void>`. `pair()`(토큰 즉시)는 삭제, `login`(개발용)은 유지.
  - `pairing.ts`: `PAIR_ERROR_MESSAGES`에 `PAIRING_REJECTED`·`PAIRING_EXPIRED`·`NO_PROJECT_LINKS` 추가, `INVALID_PAIRING_CODE` 문구 교체(Global Constraints), `REAUTH_EXPIRED_MESSAGE`; `formatLeft(sec: number): string`(`m:ss`).
  - `rules.ts`: `linkStatusOf(meta: Meta | null, projectMno: number): LinkStatus`(meta 없음 또는 그 과제에 `linkStatus` 필드 없음 → ACTIVE, 목록에 과제 없음 → ENDED); `pickableProjects(projects: Project[]): Project[]`(writable이고 ACTIVE); `editBlock(note, s, now, link: LinkStatus = 'ACTIVE')` — 순서 LOCK → RELEASED → RELEASE_PENDING → **UNLINKED / SUSPENDED** → RECLAIMED → NOT_WRITABLE, `EditBlock.kind`에 `'UNLINKED' | 'SUSPENDED'`; `LINK_BLOCK_MESSAGES`; `REJECT_MESSAGES`에 `PROJECT_NOT_LINKED: '이 과제의 태블릿 연결이 끊겨 서버가 받지 않았습니다.'`, `PROJECT_SUSPENDED: '과제가 종료되어 서버가 받지 않았습니다.'`, `REUSED_REF_MISSING: '서버에 이전 페이지 그림이 없어 전체를 다시 올려야 합니다.'`.
  - `sync.ts`: bootstrap 뒤 `linkStatusOf`가 ACTIVE가 아닌 과제의 노트는 업로드·노트 생성을 시도하지 않고 대기 버전을 `REJECTED`(코드 `PROJECT_NOT_LINKED`/`PROJECT_SUSPENDED`), `releaseRequested=false`, `syncIssue` 기록. 업로드·생성 중 403 링크 오류도 같은 결과(기존 `REJECT_NOTE`).
  - `demo.ts`: preview·pair(PENDING)·status(곧바로 APPROVED)·cancel·reauth, bootstrap 과제에 `linkStatus:'ACTIVE'`.

- [ ] **Step 1: 실패하는 테스트** — `rules.test.mjs`: `linkStatusOf treats missing field as ACTIVE and missing project as ENDED`, `pickableProjects keeps only writable ACTIVE`, `editBlock shows UNLINKED/SUSPENDED before RECLAIMED but after RELEASED`, `unlinked banner text exact`. `pairing.test.mjs`: `pair error messages for rejected/expired/no links`, `formatLeft 600 → 10:00, 59 → 0:59`.
- [ ] **Step 2: 실패 확인** — `npm test` → 새 테스트 실패.
- [ ] **Step 3: 구현** — Interfaces대로.
- [ ] **Step 4: 통과 확인** — `npm test`, `npm run typecheck`(화면은 Task 9에서 바꾸므로 `Connect.tsx`의 옛 `pair` 호출은 이 태스크에서 `requestPair`+`pollPair` 최소 연결로 컴파일만 맞춘다).
- [ ] **Step 5: Commit** — `feat(app): 과제 QR 승인 대기·재인증·과제별 잠금 로직`

### Task 9: 앱 — 연결·대기·과제 추가·잠금 화면 + E2E

**Files:**
- Modify: `app/src/screens/{Connect,Notes,Note,Versions}.tsx`, `app/src/App.tsx`, `app/src/ui.tsx`, `app/styles.css`, `app/tests/e2e/run.mjs`, `app/README.md`

**Interfaces:**
- Consumes: Task 8 전부.
- Produces:
  - `Connect` props `{ session?: Session | null; mode: 'first' | 'relogin' | 'add'; target?; linkError?; onDone; onCancel? }`. 단계: 첫 화면 → (QR·코드) **미리보기 확인**(`connect-confirm`, `connect-confirm-project`, `connect-confirm-user`) → `연결` → **대기**(`connect-waiting`, `connect-waiting-left`, `connect-waiting-cancel`, 3초 간격 `pollPair`) → 끝/오류(`connect-error`). `relogin`·`add`는 지금 서버의 QR만. `relogin`이고 잠금이 `NEEDS_LOGIN`이면 첫 화면의 주 버튼 `다시 연결 요청`(`connect-reauth`) → 대기, `NO_PROJECT_LINKS`·`UNAUTHORIZED`면 그 안내 + QR 경로. `REVOKED`면 QR 경로만.
  - `App.tsx`: 경로 `{ name: 'add'; back: Route }`; 연결된 채 평소 화면에서 딥링크가 오면 `add`로 열어 받는다(무시하지 않음).
  - `Notes.tsx`: `과제 연결` 버튼(`add-project`), 새 노트·프로젝트 선택은 `pickableProjects`, 연결 과제가 없으면 `no-projects` 안내(Global Constraints 문구) + `과제 연결`; 카드 칩 `연결 끊김`·`과제 종료`. `Note.tsx`: `editBlock(…, linkStatusOf(meta, note.projectMno))`, 배너 `block-banner[data-kind=UNLINKED|SUSPENDED]`. `Versions.tsx` 복원 대상 = `pickableProjects`.

- [ ] **Step 1: E2E 재작성(실패 확인)** — 연결 단계를 "`/__admin/pairing-code {loginId, projectMno:3}` → 코드 입력 → 미리보기에 과제명·`김연구` → 연결 → 대기 화면·남은 시간 → `/__admin/approve` → 목록, 새 노트의 과제 선택지는 3만"으로. 새 단계: `거절 → PAIRING_REJECTED 문구`, `승인 시간 지남(requestTtlMs) → 정확한 안내`, `대기 중 취소 → 요청 CANCELED`, `연결된 기기에서 과제 4 QR(딥링크) → 연결 추가, 선택지 3·4`, `책임자가 과제 3 연결 끊기(오프라인 대기 버전 있음) → 동기화 후 그 노트 UNLINKED 배너·대기 버전 미반영, 과제 4 노트는 그대로`, `미반영 → 과제 4 새 노트로 복원 → 서버에 올림`, `과제 종료(state editable:false) + daily → SUSPENDED 배너, 다시 열면(editable:true) + daily → 새 노트 가능`, `31일 미접속 + daily → 모든 노트 UNLINKED 배너·새 노트 불가(no-projects)`, `연결 만료 → 다시 연결 요청(재인증) → 승인 → 과제 연결 그대로·대기 버전 업로드`, `researcher2 과제 QR + 올리지 않은 기록 → 미리보기 단계에서 거부, 코드 미사용(codeState.usedAt null)`, `사용 중지 → 다시 연결은 과제 QR + 승인 → 앞 노트는 미반영·새 노트 가능`. 기존 오프라인·암호화·반납·회수·기한·화면 단계는 그대로. `npm run build && … npm run test:e2e` → 새 단계 실패.
- [ ] **Step 2: 화면 구현** — Interfaces대로, 문구는 Global Constraints.
- [ ] **Step 3: 통과 확인** — `npm test`, `npm run typecheck`, `npm run build`, E2E(`CHROMIUM_PATH=…`) → 전 단계 통과, 단계 수·스크린숏(`tests/e2e/out/`) 보고.
- [ ] **Step 4: Commit** — `feat(app): 과제 QR 확인·승인 대기·과제 추가·끊긴 과제 잠금 화면`

### Task 10: 앱 — 동기화 주기·하루 1번 토큰 갱신·바뀐 쪽만 올리기

**Files:**
- Modify: `app/src/lib/{rules,images,notes,sync,store,types,demo}.ts`, `app/src/screens/Note.tsx`(`AUTO_VERSION_MS` 제거 → `rules.ts` 상수), `app/tests/e2e/run.mjs`
- Test: `app/tests/unit/{rules,images}.test.mjs`

**Interfaces:**
- Consumes: Task 1 §6 `reusedRefs`, Task 8 `Session.lastRefreshAt`.
- Produces:
  - `rules.ts`: `SYNC_INTERVAL_MS = 600_000`, `AUTO_VERSION_MS = 1_800_000`, `REFRESH_INTERVAL_MS = 86_400_000`, `REFRESH_BEFORE_EXPIRY_MS = 3 * 86_400_000`, `needsRefresh(s: Session, now: number): boolean`. `store.ts`·`Note.tsx`가 이 상수를 쓴다.
  - `images.ts`: `contentHashFromHex(uploadHtml: string, images: { ref: string; sha256: string }[]): Promise<string>`(`contentHash`가 이것을 쓴다), `reuseRefs(prev: { refs: string[]; hashes: string[] } | null, hashes: string[]): (string | null)[]`(같은 해시의 직전 ref, 직전 ref 하나는 한 번만, 없으면 null), `splitReusedRefs(refs: string[], sentRefs: ReadonlySet<string>): { upload: string[]; reused: string[] }`.
  - `types.ts` `LocalVersion.imageHashes?: string[]`(옛 버전엔 없음 → 재사용 없음). `notes.ts`: `createVersion`이 직전 버전(상태 무관)의 `imageRefs`·`imageHashes`로 `reuseRefs` → null인 페이지만 `db.putImage`; `uploadPayload(v, sentRefs: ReadonlySet<string>, opts?: { full?: boolean })` → `{ html, images, reusedRefs, missing }`(재사용 ref는 바이트 불필요 — `missing`에 넣지 않음). `api.uploadVersion` meta에 `reusedRefs`.
  - `sync.ts`: `needsRefresh`일 때만 `/devices/refresh`(성공 시 `lastRefreshAt`), 아니면 bootstrap `serverTime`으로 `lastServerContactAt`·`clockHighWater` 갱신; `sentRefs` = 이 노트 SENT 버전들의 `imageRefs` 합집합; `REUSED_REF_MISSING`이면 같은 버전을 `{full:true}`로 한 번 다시 보내고, 또 실패하면 기존 분류(SKIP).
  - `demo.ts`: 노트별 `{ref: sha256}`을 두고 `reusedRefs`를 계약대로 받는다.

- [ ] **Step 1: 실패하는 테스트** — `rules.test.mjs`: `cadence constants pin spec values`(600000·1800000), `needsRefresh: never refreshed, 23h vs 24h, 3 days before expiry`. `images.test.mjs`: `contentHashFromHex equals contentHash`, `reuseRefs reuses same-hash page ref`, `reuseRefs never reuses one previous ref twice`(같은 그림 페이지 둘), `reuseRefs without previous returns nulls`, `splitReusedRefs only reuses refs from SENT versions`.
- [ ] **Step 2: 실패 확인** — `npm test`.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: E2E 추가** — `두 쪽 노트에서 2쪽만 고쳐 버전 저장 → 서버 버전 uploadedImages 1·reusedImages 1, 웹 확인 화면에 두 쪽 모두`, `서버가 이미지를 잃음(forget-images) → 다음 버전은 전체 바이트로 다시 올라감(uploadedImages = 쪽 수), 동기화 오류 없음`, `동기화를 두 번 해도 refresh는 한 번`(모의 서버 요청 기록 또는 네트워크 응답 수).
- [ ] **Step 5: 통과 확인** — `npm test && npm run typecheck && npm run build && CHROMIUM_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" npm run test:e2e` → 전부 통과.
- [ ] **Step 6: Commit** — `feat(app): 동기화 10분·자동 버전 30분·토큰 갱신 하루 1번, 바뀐 페이지 그림만 올리기`

### Task 11: 배포 문서 + 전체 확인

**Files:**
- Modify: `C:/Users/harim/work/Goono-ELN/deploy/doc/app-sync-upgrade.md`, `C:/Users/harim/work/handdrawing/app/README.md`

**Interfaces:**
- Consumes: Task 1~10 결과.

- [ ] **Step 1: 배포 문서** — 한국어, 짧게: `9.app_project_link.sql`을 8 다음·WAR보다 먼저(다시 실행해도 안전); **이행 — 모든 기존 연결이 끊긴다**(연결 행 없는 기기 토큰 삭제, 기기 작성 중 노트는 이력 없이 웹으로, 앱은 "다시 연결" → 연구책임자에게 과제 QR 요청, 기기의 올리지 않은 기록은 미반영으로 남아 복원 가능; 비밀번호 등록 기기는 스크립트를 다시 돌리면 토큰이 지워짐); 연구책임자 과제 화면 발급 → 연구원 대시보드 승인(10분); 마이페이지는 내 기기·사용 중지만; 끊김·중지·재개·장기 미접속 30일 규칙과 이력 문구; `app.device.link-job.cron`(기본 03:40, 서버 여러 대면 각 인스턴스가 돌지만 조건부 갱신이라 중복 처리 없음); 2절의 "이전 사용자 노트는 자동 회수 아님"을 "다른 연구원 연결 승인 시 자동으로 웹으로"로 교체; 병합 전 관문에 "과제 화면 QR → 앱 → 대시보드 승인 → 끊기"를 실제 브라우저·실제 개발 서버로 확인 추가.
- [ ] **Step 2: README** — 모의 서버 관리 API(Task 1 목록)와 E2E 실행 명령.
- [ ] **Step 3: 전체 확인** — 앱 전체 명령(검증 방법), Goono-ELN 하네스 전체(`so.goono.eln.app.**` + 1단계 순수 테스트), SQL 1~9 적용(7·8·9 두 번). 결과·실행하지 못한 것(Gradle·실기기·실서버)을 보고.
- [ ] **Step 4: Commit** — 각 저장소에서 `docs: 과제별 태블릿 연결 배포 문서와 모의 서버 안내`
