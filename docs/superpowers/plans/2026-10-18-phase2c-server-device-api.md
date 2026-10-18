# 2C단계 — 구노 서버 기기 API·QR 연결·편집 위치 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Goono-ELN `main`에 태블릿 앱용 기기 토큰 API(`/api/app/v1/*`)와 웹의 QR 연결·기기 관리·편집 위치(웹/기기) 규칙을 구현해, 2B에서 확정한 계약대로 앱이 실제 서버에 붙게 한다.

**Architecture:** 새 패키지 `so.goono.eln.app`에 순수 도우미(코드·토큰·내용 해시·IP 실패 제한) → 기기·연결 코드 저장 → 별도 보안 필터 체인(`@Order(1)`, 무상태 Bearer) + 기기 API 컨트롤러 → 노트·버전·반납 → 웹 쪽 편집 위치 강제·편집권 회수 → 마이페이지 "태블릿 연결" 화면 순서로 쌓는다. 버전 저장은 기존 `ElnNoteEditorService.createNoteEditorDtl`을 재사용한다.

**Tech Stack:** Java 8, Spring Boot 2.7.18 / Spring Security 5.7(`SecurityFilterChain` 빈 방식), eGovFrame `@Mapper` + MyBatis XML, MariaDB, Thymeleaf + jQuery, 내장 QR 생성기 `qrcode-generator@1.4.4`(MIT, 정적 파일로 동봉).

**Spec:** `handdrawing/docs/superpowers/specs/2026-10-17-goono-tablet-app-design.md` §6.0, §7.1, §7.2(1단계 범위: pairing-code·pair), §7.3, §8, §9. **계약:** `handdrawing/app/docs/SYNC-API.md`(2B Task 1에서 갱신된 판) — 엔드포인트·요청·응답·오류 코드는 계약 문서가 기준이다. 2A(웹 손글씨 이식)가 먼저 끝나 있어야 웹에서 앱 노트가 보인다.

**저장소/브랜치:** `/home/user/Goono-ELN`, 브랜치 `claude/tablet-app-hand-drawing-sync-ofo0oi`.

## Global Constraints

- 오류 본문은 **`{ "error": { "code": "…", "message": "…" } }`**(계약). 401 응답도 이 형식(보안 체인의 entry point에서 직접 작성 — `server.error.include-stacktrace: always` 때문에 `sendError` 금지).
- 기기 API 체인: `/api/app/v1/**`, `@Order(1)`, 세션 없음(STATELESS), CSRF 끔, `Authorization: Bearer <token>`. 익명 허용은 `OPTIONS`, `POST /devices/pair`, `POST /devices/register`(설정이 켜진 경우)뿐. 기존 웹 체인(`maximumSessions(1)`)에 걸리지 않아야 하고, 이 경로에서는 **HTTP 세션을 만들지 않는다**(`SessionTimeoutCookieFilter`가 `/api/app/v1/`을 건너뜀).
- CORS(이 체인): 허용 오리진 `capacitor://localhost`, `https://localhost`, `http://localhost`; 메서드 GET·POST·OPTIONS; 헤더 `Authorization`, `Content-Type`.
- 토큰: 32바이트 난수 base64url(43자), DB에는 **SHA-256 hex만** 저장. 기한 = 지금 + `app.device.offline-grace-days`(기본 14일), `/devices/refresh`마다 연장. 사용 중지된 기기는 401 `DEVICE_REVOKED`, 기한 지남은 401 `TOKEN_EXPIRED`, 그 밖의 무효 토큰은 401 `UNAUTHORIZED`.
- 연결 코드: 2B Global Constraints와 동일(8자, `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, 표시 `XXXX-XXXX`, 정규화 후 비교, **일회용·5분**, 재발급 시 이전 미사용 코드 무효, DB엔 정규화 값의 SHA-256만). 사용 처리는 원자적으로(`UPDATE … WHERE CODE_HASH=? AND USED_DT IS NULL AND EXPIRES_DT > NOW()`의 영향 행 1).
- IP 실패 제한: 같은 IP **10분 안에 5번 실패 → 429 `TOO_MANY_ATTEMPTS`** + `Retry-After`(초). 인스턴스 메모리 기준.
- 설정 키(`config/eln.properties`, 정확히): `app.device.enabled=false`(**기본 꺼짐** — 꺼지면 모든 `/api/app/v1`은 403 `APP_DISABLED`, 웹 pairing-code는 `appEnabled=false`로 응답해 화면이 안내 문구를 띄움), `app.device.offline-grace-days=14`, `app.device.password-login.enabled=false`(꺼지면 `/devices/register` 403 `PASSWORD_LOGIN_DISABLED`), `app.device.max-upload-bytes=52428800`(버전 1건 전체 업로드 상한, 넘으면 413 `TOO_LARGE`; bootstrap `policy.maxImageBytes`도 이 값).
- QR 내용 `goono-note://pair?server=<서버>&code=<XXXX-XXXX>` — 서버는 `app.base-url`(1단계에서 추가), 비었으면 요청의 scheme+host+context path.
- 기기 기록은 **(DEVICE_ID, USER_MNO)** 단위(`DEVICE_MNO` 대리키). 편집 위치는 `EDIT_DEVICE_MNO`로 가리킨다.
- 내용 해시(계약 §6): `SHA-256( UTF-8(noteContent) ‖ ref 오름차순 각 이미지마다 "\n" + ref + ":" + hex(SHA-256(바이트)) )`, 소문자 hex. 앱 `src/lib/images.ts`의 `contentHash`와 **같은 입력에 같은 값**.
- 이미지 ref는 `^[A-Za-z0-9-]{16,64}$`만 허용(아니면 400 `INVALID_REQUEST`). 해시 검증 **뒤** `blob:goono-app/{ref}` → `blob:goono-app/{noteMno}-{ref}`로 바꿔 저장(평면 디렉터리 파일명 충돌 방지).
- 앱이 올린 버전은 노트 이력(`PL_ELN_NOTE_HIST`)은 남기되 **사용자 알림·웹 푸시는 보내지 않는다**(5분마다 자동 버전).
- 편집 위치 `DEVICE`인 노트: 웹에서 쓰기 권한 없음(권한 SQL), 점검 요청 거부, 상세 화면에 `{기기 이름}에서 작성 중 · 마지막 동기화 {yyyy-MM-dd HH:mm}` 표시. 편집권 회수는 노트 주인 또는 관리자(`getViewManagerYn()=="Y"`)만, 사유 필수(200자 이하).
- Java 8. 이 환경에서 Goono-ELN 전체 빌드 불가(사설 패키지 401) — `./gradlew` 금지. 순수 도우미는 `java.*`만 import.

## 검증 방법 (이 환경)

- 순수 테스트: 1단계와 같은 `javac --release 8` + `junit.jar`/`assertj.jar`(scratch `lib/`) 명령, `/tmp/pure-sources.txt`에 파일 추가.
- SQL: 로컬 MariaDB(필요하면 `mysqld_safe --user=mysql`을 백그라운드로 띄움) + `scratchpad/sql/newdb.sh t_<태스크>` + `deploy/src/ddl/mariadb/7.inspection_nudge.sql` + `8.app_sync.sql`. 가능하면 실제 매퍼 XML을 MyBatis로 실행(1단계 하네스 방식).
- MockMvc·Mockito: 사설 클래스 최소 스텁 + Maven Central jar로 scratch에서 실행, Gradle로는 "미실행" 표시. 스텁·하네스 커밋 금지.
- 계약 일치: 2B의 모의 서버와 같은 시나리오를 실제 서버에 돌리는 것은 개발 서버 접속 정보가 생긴 뒤의 관문(배포 문서에 명시).
- scratch: `/tmp/claude-0/-home-user/615930a9-68d3-5bf4-b298-ba4142d5287c/scratchpad/`.

## Review Focus

1. **같은 사람이 PC 웹과 태블릿을 동시에** 쓸 때 웹 세션이 끊기지 않고, 앱 요청은 세션·쿠키를 만들지 않는다 — Task 3 `appChainCreatesNoSession`, `sessionCookieFilterSkipsAppPath`.
2. **네트워크가 끊겨 같은 버전을 다시 올리면**(같은 `clientVersionId`) 200 `duplicate:true`이고 편집기 버전 행이 하나만 생긴다 — Task 5 `retriedUploadIsIdempotent` + SQL 확인.
3. **웹에 열어 둔 옛 탭**에서 기기 작성 중 노트를 저장·점검 요청하면 거부되고 이유가 보인다 — Task 6 권한 SQL 픽스처 + `inspectionRejectedForDeviceNote`.
4. **분실 처리(사용 중지)된 기기·기한 지난 토큰**은 구분되는 401 코드로 거부된다(앱이 잠금 종류를 고름) — Task 3 `revokedDeviceGets401DeviceRevoked`, `expiredTokenGets401TokenExpired`.
5. **다른 노트가 쓴 것과 같은 ref**로 이미지를 올려도 기존 파일을 덮어쓰지 않는다 — Task 5 `refsArePrefixedWithNoteMno`.

---

### Task 1: 순수 도우미 — 연결 코드·토큰·내용 해시·ref·IP 제한

**Files:**
- Create: `src/main/java/so/goono/eln/app/support/{PairingCodes,AppTokens,AppContentHash,AppRefRules,PairAttemptLimiter}.java`
- Test: `src/test/java/so/goono/eln/app/support/*Test.java` (클래스마다 하나)

**Interfaces:**
- Produces:
  - `PairingCodes { static final String ALPHABET; static String generate(SecureRandom r); static String normalize(String input) /* null if invalid */; static String format(String normalized) /* XXXX-XXXX */; static String hash(String normalized) /* sha256 hex */ }`
  - `AppTokens { static String newToken(SecureRandom r) /* 43 chars base64url, no padding */; static String hash(String token) }`
  - `AppContentHash { static String compute(String noteContent, Map<String, byte[]> imagesByRef) }`
  - `AppRefRules { static boolean isValidRef(String ref); static String storedRef(long noteMno, String ref) /* noteMno + "-" + ref */ }`
  - `PairAttemptLimiter { PairAttemptLimiter(int maxFailures /*5*/, Duration window /*10m*/); boolean isBlocked(String ip, Instant now); void recordFailure(String ip, Instant now); long retryAfterSec(String ip, Instant now); void clear(String ip) }` — 스레드 안전.

- [ ] **Step 1: 실패하는 테스트** — `PairingCodesTest`: 생성 결과 8자·알파벳만(1000회), `normalize(" k7q2-m9xd ")=="K7Q2M9XD"`, 모호 문자·길이 오류 → null, `format`, `hash`는 64자 hex. `AppTokensTest`: 43자·`[A-Za-z0-9_-]`만, 두 번 생성 값 다름, hash 64자. `AppContentHashTest`: **앱과 같은 값** — 고정 입력(`noteContent = "<figure class=\"rw-drawing\"><img src=\"blob:goono-app/bbbbbbbbbbbbbbbb\"><img src=\"blob:goono-app/aaaaaaaaaaaaaaaa\"></figure>"`, 이미지 `aaaaaaaaaaaaaaaa`→bytes `{1,2,3}`, `bbbbbbbbbbbbbbbb`→bytes `{4,5}`)의 기대 hex를 **앱 코드로 계산**해 테스트에 박는다(`node --experimental-strip-types`로 `handdrawing/app/src/lib/images.ts`의 `contentHash`를 실행; 명령과 출력은 보고에). `AppRefRulesTest`: 15자·65자·`/`·`.` 거부, `storedRef(7,"abc…")`. `PairAttemptLimiterTest`: 4회 실패 후 미차단, 5회 후 차단·`retryAfterSec` > 0, 10분 지나면 해제, `clear`.
- [ ] **Step 2: 실패 확인** → 컴파일 오류.
- [ ] **Step 3: 구현** — `java.*`만.
- [ ] **Step 4: 통과 확인** → 전부 통과(1단계 순수 테스트 포함).
- [ ] **Step 5: Commit** — `feat: 태블릿 연결용 코드·토큰·내용 해시·실패 제한 도우미`

### Task 2: DB·설정 + 기기·연결 코드 저장

**Files:**
- Create: `deploy/src/ddl/mariadb/8.app_sync.sql`, `src/main/java/so/goono/eln/app/vo/{AppDeviceVO,AppPairingCodeVO,AppDeviceInfo,AppTokenIssue}.java`, `src/main/java/so/goono/eln/app/service/{AppDeviceMapper,AppDeviceService}.java`, `src/main/resources/meta-mappers/eln/app/appDevice-mapper.xml`
- Modify: `src/main/resources/config/eln.properties`, `src/main/resources/messages/messages.properties`, `messages_en.properties`

**Interfaces:**
- Consumes: Task 1 전부.
- Produces:
  - 테이블(`8.app_sync.sql`, 다시 실행해도 안전 — `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `INSERT IGNORE`):
    - `PL_APP_DEVICE (DEVICE_MNO BIGINT UNSIGNED PK /*FN_SEQ('PL_APP_DEVICE.DEVICE_MNO')*/, DEVICE_ID VARCHAR(64) NOT NULL, USER_MNO BIGINT UNSIGNED NOT NULL, DEVICE_NM VARCHAR(100) NOT NULL, PLATFORM VARCHAR(20) NOT NULL, MODEL VARCHAR(100), APP_VERSION VARCHAR(30), TOKEN_HASH CHAR(64) UNIQUE, TOKEN_EXPIRES_DT DATETIME, REVOKED_YN CHAR(1) NOT NULL DEFAULT 'N', REVOKED_DT DATETIME, LAST_SEEN_DT DATETIME, CREATE_DT DATETIME NOT NULL, MODIFY_DT DATETIME NOT NULL, UNIQUE(DEVICE_ID, USER_MNO))` + `PL_SEQ` 행.
    - `PL_APP_PAIRING_CODE (CODE_HASH CHAR(64) PK, USER_MNO BIGINT UNSIGNED NOT NULL, EXPIRES_DT DATETIME NOT NULL, USED_DT DATETIME, CREATE_DT DATETIME NOT NULL, KEY(USER_MNO))`.
    - `PL_ELN_NOTE` + `EDIT_LOCATION_CCD VARCHAR(10) NOT NULL DEFAULT 'WEB'`, `EDIT_DEVICE_MNO BIGINT UNSIGNED NULL`, `CREATE_DEVICE_MNO BIGINT UNSIGNED NULL`, `CLIENT_NOTE_ID VARCHAR(64) NULL`, `UNIQUE(OWNER_MNO, CLIENT_NOTE_ID)`.
    - `PL_ELN_NOTE_EDITOR` + `SOURCE_CCD VARCHAR(10) NOT NULL DEFAULT 'WEB'`, `DEVICE_MNO BIGINT UNSIGNED NULL`, `DEVICE_WRITTEN_DT DATETIME NULL`, `CLIENT_VERSION_ID VARCHAR(64) NULL UNIQUE`, `CONTENT_HASH CHAR(64) NULL`.
    - `VW_ELN_NOTE`를 `3.VW_ELN_NOTE.sql`과 같은 정의로 `CREATE OR REPLACE VIEW`(새 컬럼이 보이게).
    - `PL_COM_CD`: `ELN_HIST_SE_CCD`/`NOTE_EDIT_RECLAIM`/'편집권 회수'.
    - 메뉴: `MAIN_MYPAGE_DEVICES` → `/eln/mypageDevices`, '태블릿 연결', `i18n.menu.mypage.devices`, 상위·LEVEL·형식은 기존 `MAIN_MYPAGE_*` 행과 같게; 권한 `ROLE_OPMS_ADMIN`, `ROLE_USER_MANAGER`, `ROLE_USER_RSPNSBLTY`, `ROLE_USER_RESEARCHER`(+ 1단계처럼 상위 메뉴 권한이 없는 역할엔 상위 권한도).
  - 설정 키 4개(Global Constraints 값, 한국어 주석 유니코드 이스케이프), i18n `i18n.menu.mypage.devices` = 태블릿 연결 / Tablet connection.
  - `AppDeviceService`:
    - `AppPairingCodeVO issuePairingCode(long userMno, String serverUrl)` → `{code(표시형), qrPayload, expiresAt}`; 같은 사용자 미사용 코드 삭제 후 발급.
    - `AppTokenIssue pair(String rawCode, AppDeviceInfo device)` — 정규화 실패·사용 실패 시 `AppApiException(401,"INVALID_PAIRING_CODE")`; 성공 시 (DEVICE_ID, USER_MNO) upsert(이름·플랫폼·모델·앱 버전 갱신, `REVOKED_YN='N'`), 새 토큰 → `{token, tokenExpiresAt, offlineGraceDays, userMno}`.
    - `AppTokenIssue refresh(AppDeviceVO current)`; `AppDeviceVO authenticate(String rawToken)`(없음 → null; 결과에 revoked/expired 판정용 값 포함, `LAST_SEEN_DT` 갱신); `List<AppDeviceVO> selectMyDevices(long userMno)`; `int revoke(long deviceMno, long userMno)`(본인 기기만, 토큰 무효화 = `TOKEN_HASH=NULL`).
  - `AppApiException extends RuntimeException { AppApiException(int status, String code, String message) }` — 패키지 `so.goono.eln.app.support`(Task 3이 처리기를 만든다).

- [ ] **Step 1: DDL·설정 작성** → 새 DB에 7·8 스크립트 두 번 적용, `SHOW CREATE TABLE`·뷰 컬럼 확인.
- [ ] **Step 2: 매퍼 SQL 검증(실패→통과)** — 코드 발급 2회(첫 코드 무효), 같은 코드 동시 사용 시 영향 행 합 1, 만료 코드 0, 기기 upsert(같은 사용자 재연결 = 같은 DEVICE_MNO·새 TOKEN_HASH, 다른 사용자 = 새 행), revoke 후 TOKEN_HASH NULL.
- [ ] **Step 3: 자바 구현** — Interfaces대로, `@Transactional`(쓰기 메서드).
- [ ] **Step 4: Mockito 테스트(미실행 표시)** — `pairRejectsUsedCode`, `pairUpsertsSameUserDevice`, `issueInvalidatesPrevious`, `revokeOnlyOwnDevice`.
- [ ] **Step 5: Commit** — `feat: 태블릿 기기·연결 코드 저장과 편집 위치 컬럼(8.app_sync.sql)`

### Task 3: 보안 체인 + 연결 API

**Files:**
- Create: `src/main/java/so/goono/eln/app/config/AppSecurityConfig.java`, `src/main/java/so/goono/eln/app/security/{AppTokenFilter,AppAuthEntryPoint}.java`, `src/main/java/so/goono/eln/app/controller/{AppDeviceController,AppPairingWebController,AppApiExceptionHandler}.java`
- Modify: `src/main/resources/meta-mappers/framework/secutiry/userDetails-mapper.xml:45-52`(`userMno` 분기), `src/main/java/so/goono/framework/security/service/UserDetailsServiceImpl.java`(`loadUserByUserMno`), `src/main/java/egovframework/com/cmm/filter/SessionTimeoutCookieFilter.java`(`/api/app/v1/` 건너뜀)

**Interfaces:**
- Consumes: Task 2 `AppDeviceService`, `AppApiException`.
- Produces:
  - 체인: Global Constraints 그대로. `AppTokenFilter`(빈 등록 안 함, 체인에서 `new`) — 토큰 → `authenticate` → 무효면 entry point가 401 코드 선택(요청 속성으로 전달) → 유효면 `loadUserByUserMno`로 `UserDetailsVO` 만들어 `UsernamePasswordAuthenticationToken(userId, null, [ROLE_USER, authGrpCd])` + `setDetails(vo)`(기존 `DaoAuthenticationProvider` 70-84와 같은 방식, `realAuthGrpCd`·`loginIp` 포함), 요청 속성 `appDevice`에 `AppDeviceVO`. `app.device.enabled=false`면 필터가 바로 403 `APP_DISABLED`.
  - `AppApiExceptionHandler`(`@RestControllerAdvice(basePackageClasses = AppDeviceController.class)`, 높은 우선순위): `AppApiException` → 해당 상태·형식, 그 밖의 예외 → 500 `INTERNAL`(스택 없음).
  - `AppDeviceController`(`@RestController @RequestMapping("/api/app/v1/devices")`): `POST /pair`(IP 제한 확인 → 실패 시 `recordFailure`·429, 성공 시 `clear`; 응답에 `user{userMno, loginId, name}`, `serverTime`), `POST /register`(설정 꺼짐 403 `PASSWORD_LOGIN_DISABLED`; 켜짐 — `AuthenticationManager` + `WebAuthenticationDetailsSource().buildDetails(req)`, 실패 401 `INVALID_CREDENTIALS`), `POST /refresh`.
  - `AppPairingWebController`(웹 세션, `/api/eln/app/**`, JSON_VIEW 관례): `POST /api/eln/app/pairing-code` → `{code, qrPayload, expiresAt}`(세션 사용자 없으면 기존 `i18n.error.read` 예외, 기능 꺼짐이면 `appEnabled=false`로 응답).

- [ ] **Step 1: MockMvc·필터 테스트(미실행 표시, 스텁 하네스로 실제 실행)** — `pairReturnsTokenShape`, `usedCodeReturns401InvalidPairingCode`, `fifthFailureReturns429WithRetryAfter`, `appDisabledReturns403`, `registerDisabledByDefault`, `revokedDeviceGets401DeviceRevoked`, `expiredTokenGets401TokenExpired`, `missingTokenGets401Unauthorized`(본문 JSON 형식 확인), `appChainCreatesNoSession`(요청 후 `request.getSession(false)==null`), `sessionCookieFilterSkipsAppPath`, `pairingCodeRequiresWebSession`.
- [ ] **Step 2: 구현** — Interfaces대로.
- [ ] **Step 3: 통과 확인** — 하네스 결과 보고.
- [ ] **Step 4: Commit** — `feat: 태블릿 기기 API 보안 체인과 QR 연결(pair·refresh·pairing-code)`

### Task 4: bootstrap + 노트 목록·생성

**Files:**
- Create: `src/main/java/so/goono/eln/app/controller/AppNoteController.java`, `src/main/java/so/goono/eln/app/service/{AppNoteService,AppNoteMapper}.java`, `src/main/resources/meta-mappers/eln/app/appNote-mapper.xml`, `src/main/java/so/goono/eln/app/vo/AppServerNoteVO.java`

**Interfaces:**
- Consumes: 요청 속성 `appDevice`(Task 3), `ElnProjectService.selectProjectList`(`schUserMno`, `schPageYn="N"`; `writable = prtcptnYn=='Y' && editableStatusYn=='Y'`), `ElnNoteService.createNote`.
- Produces:
  - `GET /api/app/v1/bootstrap` → `{ user, projects:[{projectMno,name,writable}], policy:{offlineGraceDays, maxImageBytes}, serverTime }`.
  - `GET /api/app/v1/notes` → 이 기기가 만들었거나(`CREATE_DEVICE_MNO`) 편집 위치가 이 기기인 노트 `[{noteMno, clientNoteId, title, projectMno, status, editLocation:{type, deviceId?}, latestVersionId, updatedAt}]`(`deviceId`는 앱이 보낸 DEVICE_ID).
  - `POST /api/app/v1/notes {clientNoteId, projectMno, title, deviceCreatedAt}` → 201 `{noteMno, status:"WRITING", editLocation:{type:"DEVICE", deviceId}}`; 같은 (주인, clientNoteId)면 200 기존 값; 프로젝트가 멤버·편집 가능 아니면 403 `PROJECT_NOT_WRITABLE`. 노트는 작성 방식 EDITOR, 보안 등급은 **웹 프로젝트 노트 생성 화면의 기본값과 같은 규칙**, `editorAutoSaveMin=0`, 제목이 비면 `제목 없음`, 편집 위치 DEVICE·`EDIT_DEVICE_MNO`·`CREATE_DEVICE_MNO`·`CLIENT_NOTE_ID` 저장.

- [ ] **Step 1: SQL 픽스처로 쿼리 검증** — 이 기기 노트/다른 기기 노트/반납된 노트 목록 포함 여부, 멱등 생성(같은 clientNoteId 두 번 → 1행).
- [ ] **Step 2: MockMvc 테스트(미실행 표시)** — `bootstrapListsWritableProjects`, `createNoteIsIdempotent`, `createNoteRejectsCompletedProject`, `notesListsOnlyThisDevice`.
- [ ] **Step 3: 구현** → 통과 확인.
- [ ] **Step 4: Commit** — `feat: 태블릿 기기 API — 기준 정보·노트 목록·노트 생성`

### Task 5: 버전 올리기 + 작성 완료(반납)

**Files:**
- Modify: `AppNoteController`, `AppNoteService`, `appNote-mapper.xml`, `src/main/java/so/goono/eln/note/service/ElnNoteEditorService.java:168-225`(오버로드 추가)

**Interfaces:**
- Consumes: Task 1 `AppContentHash`, `AppRefRules`; `ElnNoteEditorService.createNoteEditorDtl`.
- Produces:
  - `ElnNoteEditorService.createNoteEditorDtl(long noteMno, String noteContent, String autoSaveYn, Map<URI, MultipartFile> inlineImages, boolean notifyOwner)` — 기존 4인자 메서드는 `true`로 위임(웹 동작 불변). `false`면 `PL_USER_NOTI`·웹 푸시를 건너뛰고 이력은 남긴다.
  - `POST /api/app/v1/notes/{noteMno}/versions`(multipart: `meta`, `noteContent`, `inlineImages[blob:goono-app/{ref}]`) — 검사 순서: 노트 없음·주인 아님 404 `NOT_FOUND` → 편집 위치가 이 기기 아님 409 `NOT_EDIT_OWNER` → 상태(WRITING·REJECT)·프로젝트 편집 가능 아님 409 `NOT_WRITABLE` → 같은 `clientVersionId` 있음 200 `{versionId, receivedAt, duplicate:true}` → `baseVersionId` ≠ 최신(없으면 null) 409 `STALE_BASE` → 전체 크기 > 상한 413 `TOO_LARGE` → ref 형식 400 `INVALID_REQUEST` → 해시 불일치 422 `HASH_MISMATCH` → ref 접두어 변환 → `createNoteEditorDtl(..., false)` → 새 편집기 행에 `SOURCE_CCD='APP'`, `DEVICE_MNO`, `DEVICE_WRITTEN_DT`, `CLIENT_VERSION_ID`, `CONTENT_HASH` 기록 → `meta.title`이 있으면 노트 제목 갱신 → 201 `{versionId, receivedAt}`. 한 트랜잭션.
  - `POST /api/app/v1/notes/{noteMno}/release {lastVersionId}` → 편집 위치 이 기기 아님 409 `NOT_EDIT_OWNER`, 최신 ≠ lastVersionId 409 `VERSION_MISMATCH`, 성공 시 편집 위치 WEB·`EDIT_DEVICE_MNO=NULL` → `{status, editLocation:{type:"WEB"}}`.

- [ ] **Step 1: 테스트(미실행 표시, 하네스 실행)** — `uploadCreatesAppVersion`, `retriedUploadIsIdempotent`, `staleBaseRejected`, `hashMismatchRejected`, `oversizeRejected413`, `refsArePrefixedWithNoteMno`(저장 HTML의 img src가 `/editor-inline-images/{noteMno}-{ref}…`), `reclaimedNoteRejectsUpload`, `releaseRequiresLatestVersion`, `webSaveStillNotifies`(4인자 경로는 알림 호출).
- [ ] **Step 2: SQL 확인** — 업로드 후 편집기 행 1개·APP 컬럼 값, 재시도 후에도 1개.
- [ ] **Step 3: 구현** → 통과 확인.
- [ ] **Step 4: Commit** — `feat: 태블릿 기기 API — 버전 올리기와 작성 완료(편집권 반납)`

### Task 6: 웹 — 편집 위치 강제·표시·편집권 회수

**Files:**
- Modify: `src/main/resources/meta-mappers/eln/com/elnPermission-mapper.xml:165,269`(NOTE_WRITE에 `EDIT_LOCATION_CCD='WEB'`), `src/main/java/so/goono/eln/note/controller/ElnNoteController.java:154-248`(DEVICE면 READ로 낮추고 배너 정보), `src/main/resources/templates/basic/_layout/note/layout.html`(제목 근처 배너·회수 버튼, 이력 목록의 "태블릿" 표시), `src/main/java/so/goono/eln/note/service/ElnNoteInspctnService.java:71`(DEVICE 거부), `src/main/resources/meta-mappers/eln/note/elnNote-mapper.xml`(`sqlNoteList`에 편집 위치·기기 이름·마지막 동기화), `elnNoteHist-mapper.xml`(이력 목록에 SOURCE_CCD·DEVICE_WRITTEN_DT), `ElnNoteVO`
- Create: `src/main/java/so/goono/eln/app/controller/AppEditLocationWebController.java`

**Interfaces:**
- Produces: `POST /api/eln/note/app/reclaimEditLocation {noteMno, reason}`(세션 사용자 필수; 주인 또는 관리자; 사유 필수·200자; 편집 위치 WEB·`EDIT_DEVICE_MNO=NULL`; 이력 `NOTE_EDIT_RECLAIM`에 사유) → 결과 코드 1. `ElnNoteVO`: `editLocationCcd`, `editDeviceNm`, `lastSyncDt`. 점검 거부 메시지 `기기에서 작성 중인 노트는 점검을 요청할 수 없습니다. 기기에서 작성 완료하거나 편집권을 회수하세요.`

- [ ] **Step 1: 권한 SQL 픽스처** — DEVICE 노트의 주인 권한 문자열에 `:NOTE_WRITE` 없음, WEB이면 있음(기존 규칙 유지).
- [ ] **Step 2: 테스트(미실행 표시)** — `inspectionRejectedForDeviceNote`, `reclaimRequiresOwnerOrAdmin`, `reclaimRequiresReason`, `reclaimSetsWebAndWritesHistory`, `noteDetailsDowngradesDeviceNoteToRead`.
- [ ] **Step 3: 구현** — 화면: 배너 `{editDeviceNm}에서 작성 중 · 마지막 동기화 {lastSyncDt}` + (주인·관리자) `편집권 회수` 버튼(사유 입력 대화상자). 이력 목록: APP 버전에 "태블릿" 표시와 기기 작성 시각.
- [ ] **Step 4: Commit** — `feat: 웹에서 기기 작성 중 노트 읽기 전용·점검 차단·편집권 회수`

### Task 7: 마이페이지 "태블릿 연결" + 배포 문서

**Files:**
- Create: `src/main/resources/templates/basic/system/user/mypageDevices.html`, `src/main/resources/static/lib/qrcode/qrcode.js`(npm `qrcode-generator@1.4.4`의 `qrcode.js`, 상단 MIT 고지 유지), `deploy/doc/app-sync-upgrade.md`
- Modify: `src/main/java/so/goono/system/user/controller/MypageController.java`(`GET /eln/mypageDevices`), `src/main/resources/templates/basic/system/user/mypage.html`(사이드바 항목), `AppPairingWebController`(`POST /api/eln/app/myDevices`, `POST /api/eln/app/revokeDevice {deviceMno}`)

**Interfaces:**
- Consumes: Task 2 `selectMyDevices`, `revoke`; Task 3 pairing-code.
- Produces: 화면 — `QR 만들기` → QR(`qrcode-generator`로 canvas/img) + 코드 `XXXX-XXXX` + 남은 시간(5:00부터) + `새 QR`; 기능 꺼짐이면 `이 기관은 태블릿 연결을 사용하지 않습니다.`; 내 기기 목록(이름, 플랫폼·모델, 앱 버전, 마지막 접속, 오프라인 기한, 상태) + `사용 중지`(확인 대화상자). 모든 값 `.text()`로.

- [ ] **Step 1: 테스트(미실행 표시)** — `myDevicesRequiresSession`, `revokeOnlyOwnDevice`.
- [ ] **Step 2: 화면 확인(scratch)** — `node --check`(Thymeleaf 인라인 치환 후), jsdom에서 QR 렌더 후 `jsqr`로 디코드한 문자열 = `qrPayload`, 카운트다운이 0이면 QR 숨김, XSS 문자열이 `.text()`로 들어감.
- [ ] **Step 3: 배포 문서** — `app-sync-upgrade.md`(한국어, 짧게): `8.app_sync.sql`을 WAR보다 먼저; `app.device.enabled=true`로 켜기; HTTPS 필수·사내 인증서는 기기에 신뢰 등록; nginx `client_max_body_size` ≥ `app.device.max-upload-bytes`; `app.base-url`(QR 서버 주소); 같은 기기 다른 사용자 연결 시 이전 사용자 노트는 편집권 회수; 병합 전 관문(`./gradlew test`, 실제 기동, 앱 E2E를 실제 개발 서버에, 화면 확인).
- [ ] **Step 4: Commit** — `feat: 마이페이지 태블릿 연결(QR·기기 관리)과 배포 문서`
