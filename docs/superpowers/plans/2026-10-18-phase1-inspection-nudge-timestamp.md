# 1단계 — 시점인증 누락 수정 + 점검 유도 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 구노(Goono-ELN `main`)에서 점검 완료 노트의 시점인증이 빠지지 않게 하고, 모든 노트에 대해 연구원·점검자·책임자가 점검을 자주 받도록 이끄는 기능을 넣는다(태블릿 없이 동작).

**Architecture:** 시점인증 스케줄러는 "하루 창" 대신 기준일 + 재시도 기록 테이블로 대상을 고르고, 노트 단위 트랜잭션으로 처리한다. 점검 유도는 새 패키지 `so.goono.eln.nudge`에 정책(순수 Java)·매퍼·서비스·스케줄러·컨트롤러를 두고, 기존 사용자 알림(`PL_USER_NOTI` + 웹 푸시)에 "시스템 알림" 경로를 추가해 하루 한 번 묶음 알림을 보낸다. 중복 발송은 `PL_ELN_NUDGE_LOG`의 기본키로 막는다.

**Tech Stack:** Java 8, Spring Boot 2.7, eGovFrame 4 `@Mapper`, MyBatis XML(`meta-mappers/**`), MariaDB 10.x, Thymeleaf + jQuery(`ajaxPost`, `S2Util`), JUnit 5 + AssertJ.

**Spec:** `handdrawing/docs/superpowers/specs/2026-10-17-goono-tablet-app-design.md` (§7.4 점검 유도, §7.5 시점인증 누락 수정, §11 사용자 답변). 2·3단계(이식, QR 연결, 동기화 API, 태블릿 기능)는 이 계획 범위 밖.

**저장소/브랜치:** 코드는 `/home/user/Goono-ELN`, 브랜치 `claude/tablet-app-hand-drawing-sync-ofo0oi`(현재 `main`과 같음). 이 계획 문서는 handdrawing 저장소에 있다.

## Global Constraints

- 대상 코드 라인은 Goono-ELN `main`. Java 8 문법만(`var`, `List.of` 금지).
- 정책 값은 `config/eln.properties`(+`app.properties`)에 둔다. 키와 기본값(정확히 이 이름):
  `note.inspection.cycle.days=7`, `note.inspection.remind.after.days=3`, `note.inspection.nudge.since=`(비어 있음),
  `note.inspection.nudge.cron=0 50 8 * * *`, `note.timestamp.since=`(비어 있음), `note.timestamp.batch-size=20`, `app.base-url=`(비어 있음, app.properties).
- `note.inspection.nudge.since`가 비었거나 형식(yyyy-MM-dd)이 틀리면 **점검 유도 전체가 꺼진다**(알림·대시보드 카드·현황 집계 없음, WARN 로그 1회). 기존 작성 중 노트가 첫날 한꺼번에 "기한 지남"이 되지 않게 하기 위함.
- `note.timestamp.since`가 비었거나 틀리면 **기존 동작(점검 완료 후 1일 창)** 을 유지하고 WARN 로그. 소급 시점인증은 하지 않는다.
- 점검 기한 = 노트 생성일(`DATE(CREATE_DT)`) + `note.inspection.cycle.days`. 대상 노트 = `WRITE_STATUS_CCD IN ('WRITING','REJECT')`, 생성일 ≥ nudge.since, 프로젝트가 편집 가능(`PROJECT_PRGRST_CCD NOT IN ('COMPLETE','STOP')` 또는 유예 기간 중) 또는 프로젝트 없음.
- 연구원 묶음 알림 대상 = 기한이 **내일까지이거나 지난** 노트(`DAYS_UNTIL_DUE <= 1`). 책임자 현황의 "기한 지남" = `DAYS_UNTIL_DUE < 0`.
- 점검자 재알림 대상 = 현재 요청(`EXCLUSION_DT IS NULL`, `DELETE_DT IS NULL`)이 `UNCONFIRM`/`CHECKING`이고 그 점검자 행도 `UNCONFIRM`/`CHECKING`이며, 요청 생성 후 `remind.after.days`일이 지나고 요청 생성일 ≥ nudge.since.
- 알림은 사람당 종류별 **하루 한 번**. 시스템 알림의 `CREATE_USER_MNO`는 `0`(`Constants.SYSTEM_USER_MNO`).
- 시점인증 재시도: 실패 n회째 다음 시도 = 지금 + min(5분 × 2^(n−1), 6시간). **10회** 실패하면 자동 재시도 중단, 관리자 현황에만 표시.
- 순수 정책 클래스(`TimestampPolicy`, `InspectionNudgePolicy`, `NotiLinks`)는 `java.*`만 import한다 — 이 환경에서는 사설 패키지(`kr.s2.*`, `maven.pkg.github.com/Placelink-HUB` 401) 때문에 서버 전체를 컴파일할 수 없어, 이 클래스들만 단독으로 테스트를 돌린다.
- 새 `/api/**` 엔드포인트는 반드시 코드에서 권한을 검사한다(`AuthorizationChecker`가 `/api/`를 무조건 통과시킴).
- 화면 문구(정확히): 연구원 알림 `점검 기한이 지났거나 내일까지인 연구노트가 {n}건 있습니다.` / 점검자 알림 `{d}일 넘게 승인을 기다리는 점검 요청이 {n}건 있습니다.` / 알림 발신자 표시 `구노 알림`.

## 검증 방법 (이 환경)

- **순수 테스트:** JUnit 독립 실행.
  ```bash
  L=/tmp/claude-0/-home-user/615930a9-68d3-5bf4-b298-ba4142d5287c/scratchpad/lib   # 최초 1회: 아래 두 jar를 Maven Central에서 받음
  # curl -sSLo $L/junit.jar https://repo1.maven.org/maven2/org/junit/platform/junit-platform-console-standalone/1.9.3/junit-platform-console-standalone-1.9.3.jar
  # curl -sSLo $L/assertj.jar https://repo1.maven.org/maven2/org/assertj/assertj-core/3.24.2/assertj-core-3.24.2.jar
  cd /home/user/Goono-ELN && rm -rf /tmp/pt && mkdir /tmp/pt
  javac --release 8 -d /tmp/pt -cp "$L/junit.jar:$L/assertj.jar" $(cat /tmp/pure-sources.txt)
  java -jar $L/junit.jar -cp "/tmp/pt:$L/assertj.jar" --select-package so.goono --disable-banner
  ```
  `/tmp/pure-sources.txt`에는 순수 클래스와 그 테스트 파일 경로를 한 줄씩 넣는다(태스크마다 추가).
- **SQL:** 로컬 MariaDB(`mariadb -uroot db_goono_eln`, 스키마 적재 완료)에 픽스처를 넣고 새 SQL의 `#{}`를 값으로 바꿔 실행해 기대 행을 확인한다. 픽스처는 `scratchpad/sql/`에 둔다(커밋하지 않음).
- **전체 빌드·Mockito 테스트:** 사설 저장소 인증이 있는 환경에서 `./gradlew test`. 이 환경에서는 실행 불가 — 각 태스크 보고에 "미실행"으로 적는다.

## Review Focus

1. **두 인스턴스가 같은 DB에서 스케줄러를 돌림**(배포에 `eln-sync` 인스턴스 존재) → 같은 사람에게 같은 날 알림이 두 번 가면 안 된다. Task 5의 `insertNudgeLogIgnore` 두 번째 호출이 0을 반환하는 SQL 검증으로 고정.
2. **nudge.since 미설정·오타** → 대량 알림 없이 기능이 꺼져야 한다. Task 1 `InspectionNudgePolicyTest`에서 고정.
3. **완료·중지된 프로젝트의 작성 중 노트** → 점검 요청을 할 수 없으니 알림·현황에서 빠져야 한다(유예 기간 중이면 포함). Task 5 SQL 픽스처로 고정.
4. **TSA가 계속 실패** → 매분 PDF·파일 행을 새로 만들며 무한 재시도하면 안 된다. Task 1 `TimestampPolicyTest` + Task 3 SQL 픽스처(10회 실패 노트 제외)로 고정.
5. **HTTP 요청이 없는 스케줄러에서 알림 생성** → 기존 `insertUserNoti`는 `fromCurrentContextPath()`·세션 사용자 때문에 실패한다. 시스템 알림 경로는 요청·세션 없이 동작하고 `app.base-url`이 비면 상대 경로 링크를 쓴다. Task 1 `NotiLinksTest` + Task 4 매퍼 검증으로 고정.

---

### Task 1: 순수 정책 클래스 3개

**Files:**
- Create: `src/main/java/so/goono/eln/schedule/TimestampPolicy.java`
- Create: `src/main/java/so/goono/eln/nudge/InspectionNudgePolicy.java`
- Create: `src/main/java/so/goono/system/user/service/NotiLinks.java`
- Test: `src/test/java/so/goono/eln/schedule/TimestampPolicyTest.java`, `src/test/java/so/goono/eln/nudge/InspectionNudgePolicyTest.java`, `src/test/java/so/goono/system/user/service/NotiLinksTest.java`

**Interfaces:**
- Produces:
  - `final class TimestampPolicy { static final int MAX_FAIL_CNT = 10; static LocalDateTime nextTryAt(int failCnt, LocalDateTime now); static boolean givenUp(int failCnt); static LocalDateTime resolveSince(String sinceProp, LocalDateTime now); static boolean isLegacyWindow(String sinceProp); }`
  - `final class InspectionNudgePolicy { static InspectionNudgePolicy of(String cycleDays, String remindAfterDays, String since); boolean enabled(); int cycleDays(); int remindAfterDays(); LocalDate since(); /* null이면 꺼짐 */ static final int DIGEST_LEAD_DAYS = 1; }`
  - `final class NotiLinks { static String resolve(String baseUrl, String path); }`

- [ ] **Step 1: 실패하는 테스트 작성**

```java
// TimestampPolicyTest
@Test void backoffDoublesFromFiveMinutes() {
  LocalDateTime now = LocalDateTime.of(2026, 10, 18, 9, 0);
  assertThat(TimestampPolicy.nextTryAt(1, now)).isEqualTo(now.plusMinutes(5));
  assertThat(TimestampPolicy.nextTryAt(2, now)).isEqualTo(now.plusMinutes(10));
  assertThat(TimestampPolicy.nextTryAt(4, now)).isEqualTo(now.plusMinutes(40));
}
@Test void backoffCapsAtSixHours() {
  LocalDateTime now = LocalDateTime.of(2026, 10, 18, 9, 0);
  assertThat(TimestampPolicy.nextTryAt(8, now)).isEqualTo(now.plusHours(6));
  assertThat(TimestampPolicy.nextTryAt(30, now)).isEqualTo(now.plusHours(6)); // 오버플로 없음
}
@Test void givesUpAtTen() {
  assertThat(TimestampPolicy.givenUp(9)).isFalse();
  assertThat(TimestampPolicy.givenUp(10)).isTrue();
}
@Test void sinceParsesDateAsStartOfDay() {
  LocalDateTime now = LocalDateTime.of(2026, 10, 18, 9, 0);
  assertThat(TimestampPolicy.resolveSince("2026-10-20", now)).isEqualTo(LocalDateTime.of(2026, 10, 20, 0, 0));
  assertThat(TimestampPolicy.isLegacyWindow("2026-10-20")).isFalse();
}
@Test void blankOrBadSinceFallsBackToOneDayWindow() {
  LocalDateTime now = LocalDateTime.of(2026, 10, 18, 9, 0);
  assertThat(TimestampPolicy.resolveSince("", now)).isEqualTo(now.minusDays(1));
  assertThat(TimestampPolicy.resolveSince(null, now)).isEqualTo(now.minusDays(1));
  assertThat(TimestampPolicy.resolveSince("2026/10/20", now)).isEqualTo(now.minusDays(1));
  assertThat(TimestampPolicy.isLegacyWindow(" ")).isTrue();
}

// InspectionNudgePolicyTest
@Test void enabledWithValidSince() {
  InspectionNudgePolicy p = InspectionNudgePolicy.of("7", "3", "2026-10-20");
  assertThat(p.enabled()).isTrue();
  assertThat(p.cycleDays()).isEqualTo(7);
  assertThat(p.remindAfterDays()).isEqualTo(3);
  assertThat(p.since()).isEqualTo(LocalDate.of(2026, 10, 20));
}
@Test void disabledWhenSinceBlankOrMalformed() {
  assertThat(InspectionNudgePolicy.of("7", "3", "").enabled()).isFalse();
  assertThat(InspectionNudgePolicy.of("7", "3", null).enabled()).isFalse();
  assertThat(InspectionNudgePolicy.of("7", "3", "20261020").enabled()).isFalse();
}
@Test void badNumbersFallBackToDefaults() {
  InspectionNudgePolicy p = InspectionNudgePolicy.of("abc", "0", "2026-10-20");
  assertThat(p.cycleDays()).isEqualTo(7);       // 숫자 아님 → 기본값
  assertThat(p.remindAfterDays()).isEqualTo(3); // 1 미만 → 기본값
}

// NotiLinksTest
@Test void relativeWhenBaseBlank() {
  assertThat(NotiLinks.resolve("", "/eln/dashboard")).isEqualTo("/eln/dashboard");
  assertThat(NotiLinks.resolve(null, "/eln/dashboard")).isEqualTo("/eln/dashboard");
}
@Test void joinsBaseWithoutDoubleSlash() {
  assertThat(NotiLinks.resolve("https://eln.example.ac.kr/", "/eln/dashboard")).isEqualTo("https://eln.example.ac.kr/eln/dashboard");
  assertThat(NotiLinks.resolve("https://eln.example.ac.kr", "eln/dashboard")).isEqualTo("https://eln.example.ac.kr/eln/dashboard");
}
```

- [ ] **Step 2: 실패 확인** — 세 테스트 파일 경로를 `/tmp/pure-sources.txt`에 넣고 "검증 방법"의 명령 실행. Expected: 컴파일 오류(클래스 없음).
- [ ] **Step 3: 세 클래스 구현** — 시그니처는 Interfaces 그대로, `java.time`만 사용. `nextTryAt`은 지수를 30 이상에서 자르고 시프트 전에 상한과 비교해 오버플로를 막는다. `of(...)`의 숫자 파싱 실패·1 미만은 기본값(7, 3).
- [ ] **Step 4: 통과 확인** — 같은 명령. Expected: `[ 10 tests successful ]`, 실패 0.
- [ ] **Step 5: Commit**
```bash
git add src/main/java/so/goono/eln/schedule/TimestampPolicy.java src/main/java/so/goono/eln/nudge/InspectionNudgePolicy.java src/main/java/so/goono/system/user/service/NotiLinks.java src/test/java/so/goono/eln/schedule src/test/java/so/goono/eln/nudge src/test/java/so/goono/system/user/service/NotiLinksTest.java
git commit -m "feat: 시점인증 재시도·점검 유도·알림 링크 정책 클래스"
```

### Task 2: DB 변경 스크립트 + 설정 키

**Files:**
- Create: `deploy/src/ddl/mariadb/7.inspection_nudge.sql`
- Modify: `src/main/resources/config/eln.properties`(끝에 키 추가), `src/main/resources/config/app.properties`(`app.base-url=`)
- Modify: `src/main/resources/messages/messages.properties`, `messages_en.properties`

**Interfaces:**
- Produces (테이블):
  - `PL_ELN_NOTE_TIMESTAMP_RETRY (NOTE_MNO BIGINT UNSIGNED PK, FAIL_CNT SMALLINT UNSIGNED NOT NULL, LAST_FAIL_DT DATETIME NOT NULL, NEXT_TRY_DT DATETIME NOT NULL, LAST_ERROR VARCHAR(1000) NULL)`
  - `PL_ELN_NUDGE_LOG (NUDGE_SE_CCD VARCHAR(30), USER_MNO BIGINT UNSIGNED, NUDGE_DE CHAR(8), ITEM_CNT INT NOT NULL, CREATE_DT DATETIME NOT NULL, PRIMARY KEY (NUDGE_SE_CCD, USER_MNO, NUDGE_DE))`
  - `PL_COM_CD` 행: (`USER_NOTI_SE_CCD`,`NOTE_INSPECTION_DUE`,'점검 기한'), (`USER_NOTI_SE_CCD`,`NOTE_INSPECTION_REMIND`,'점검 대기'), (`ELN_HIST_SE_CCD`,`NOTE_INSPCTN_DUE`,'점검 기한 알림'), (`ELN_HIST_SE_CCD`,`NOTE_INSPCTN_REMIND`,'점검 승인 대기 알림'). 생성자 0, `NOW()`.
  - `PL_MENU` 행: (`MAIN_NOTE_INFO_INSPCTN_STATUS`, `/eln/note/inspctnStatus`, '점검 현황', `i18n.menu.eln.note.info.inspection.status`, 상위 `MAIN_NOTE_INFO`, LEVEL 4, USE_YN 'Y', HIDDEN_YN 'N', ORDER_NO 9, DEL_YN 'N') + `PL_MENU_AUTH_GROUP`에 `ROLE_OPMS_ADMIN`, `ROLE_USER_MANAGER`, `ROLE_USER_RSPNSBLTY` × `MENU_SE_CCD='ROLE_USER'`.
  - i18n 키: `i18n.menu.eln.note.info.inspection.status`=점검 현황 / Inspection status.
- 모든 INSERT는 다시 실행해도 안전하게 `INSERT IGNORE`, 테이블은 `CREATE TABLE IF NOT EXISTS`.

- [ ] **Step 1: 스크립트 작성** — 위 테이블·행. 컬럼 주석은 기존 DDL처럼 한국어 `COMMENT`.
- [ ] **Step 2: 로컬 적용·재적용 확인**
  Run: `mariadb -uroot db_goono_eln < deploy/src/ddl/mariadb/7.inspection_nudge.sql && mariadb -uroot db_goono_eln < deploy/src/ddl/mariadb/7.inspection_nudge.sql && mariadb -uroot db_goono_eln -N -e "select count(*) from PL_COM_CD where COM_CD in ('NOTE_INSPECTION_DUE','NOTE_INSPECTION_REMIND','NOTE_INSPCTN_DUE','NOTE_INSPCTN_REMIND'); select count(*) from PL_MENU_AUTH_GROUP where MENU_CD='MAIN_NOTE_INFO_INSPCTN_STATUS'"`
  Expected: 오류 없이 `4`, `3`.
- [ ] **Step 3: 설정 키·i18n 추가** — Global Constraints의 키를 주석(한국어, 기존 유니코드 이스케이프 형식 유지)과 함께 추가.
- [ ] **Step 4: Commit** — `git commit -m "feat: 점검 유도·시점인증 재시도 테이블, 알림 코드, 점검 현황 메뉴"`

### Task 3: 시점인증 스케줄러 — 기준일·재시도·노트 단위 트랜잭션

**Files:**
- Create: `src/main/java/so/goono/eln/schedule/ElnNoteTimestampJobService.java` (기존 `ElnScheduler.convertNoteToTsaPdf` 본문 이동)
- Create: `src/main/java/so/goono/eln/schedule/TimestampResult.java`
- Create: `src/main/java/so/goono/eln/cert/timestamp/service/ElnNoteTimestampRetryMapper.java`, `ElnNoteTimestampRetryService.java`, `src/main/java/so/goono/eln/cert/timestamp/vo/ElnNoteTimestampRetryVO.java`(extends `SearchVO`: `noteMno, noteNm, inspctnCompleteDt, failCnt, lastFailDt, nextTryDt, lastError`)
- Create: `src/main/resources/meta-mappers/eln/cert/elnNoteTimestampRetry-mapper.xml`
- Modify: `src/main/java/so/goono/eln/schedule/ElnScheduler.java:85-115`, `src/main/java/so/goono/eln/note/service/ElnNoteMapper.java:143`, `ElnNoteService.java:480`, `src/main/resources/meta-mappers/eln/note/elnNote-mapper.xml:742-765`

**Interfaces:**
- Consumes: `TimestampPolicy` (Task 1), `PL_ELN_NOTE_TIMESTAMP_RETRY` (Task 2).
- Produces:
  - `ElnNoteMapper.selectListConfirmOKConvertPDF(Map<String,Object> param)` — 키 `since`(LocalDateTime), `maxFailCnt`(int), `batchSize`(int). `ElnNoteService.selectListConfirmOKConvertPDF(LocalDateTime since, int batchSize)`.
  - `final class TimestampResult { static TimestampResult ok(); static TimestampResult fail(String reason); boolean isSuccess(); String getReason(); }`
  - `ElnNoteTimestampJobService.timestampNote(ElnNoteVO note): TimestampResult` — `@Transactional(rollbackFor = Exception.class)`. 기존 로직 그대로, 조용히 끝나던 분기(파일 목록 없음, PDF null, 파일 쓰기 실패, TSA 실패, IOException)는 각각 `fail("사유")`.
  - `ElnNoteTimestampRetryService.recordFailure(long noteMno, String reason)` — `@Transactional(propagation = REQUIRES_NEW)`, 현재 FAIL_CNT 조회 → +1 → `TimestampPolicy.nextTryAt`로 upsert, reason은 1000자로 자름. `clear(long noteMno)` — 성공 시 행 삭제. `selectGivenUpList(SearchVO): List<ElnNoteTimestampRetryVO>`, `selectGivenUpListCnt(SearchVO): int`(Task 8에서 사용).

- [ ] **Step 1: 대상 쿼리 SQL 검증(실패 기대)** — `scratchpad/sql/ts_fixture.sql`에 노트 5개(VW_ELN_NOTE에 보이도록 `PL_ELN_NOTE` + 파일 `FILE_MNO` 세팅 또는 FILE_ID가 나오게) 와 점검 요청을 넣는다: A 완료 3일 전(기준일 이후), B 완료 3일 전 + 재시도 행 FAIL_CNT=10, C 완료 3일 전 + 재시도 행 NEXT_TRY_DT 미래, D 완료가 기준일 이전, E 이미 시점인증됨. 기존 쿼리 실행 → Expected: A도 안 나옴(1일 창) — 현재 버그 재현.
- [ ] **Step 2: 쿼리 변경** — `INSPCTN_COMPLETE_DT >= #{since}`, `LEFT JOIN PL_ELN_NOTE_TIMESTAMP_RETRY tr ON tr.NOTE_MNO = vn.NOTE_MNO`, `AND (tr.NOTE_MNO IS NULL OR (tr.FAIL_CNT < #{maxFailCnt} AND tr.NEXT_TRY_DT <= NOW()))`, `ORDER BY nir.INSPCTN_COMPLETE_DT ASC LIMIT #{batchSize}`. 같은 픽스처로 실행 → Expected: A만.
- [ ] **Step 3: 재시도 매퍼 SQL 검증** — upsert(`INSERT ... ON DUPLICATE KEY UPDATE`)를 두 번 실행해 FAIL_CNT가 1→2, delete 후 0행. given-up 목록은 FAIL_CNT ≥ 10인 행만(노트명·점검 완료일 조인).
- [ ] **Step 4: 자바 변경** — `ElnScheduler.pageConfirm`에서 `@Transactional` 제거. `since = TimestampPolicy.resolveSince(prop, now)`(legacy면 WARN 1회), 노트마다 `try { r = jobService.timestampNote(n); if (r.isSuccess()) retryService.clear(no) else retryService.recordFailure(no, r.getReason()); } catch (RuntimeException e) { retryService.recordFailure(no, e.getClass().getSimpleName() + ": " + e.getMessage()); }` — 한 노트의 예외가 다른 노트를 롤백하지 않는다. `@Value("${note.timestamp.since:}")`, `@Value("${note.timestamp.batch-size:20}")`.
- [ ] **Step 5: 순수 테스트 재실행 + Mockito 테스트 작성(이 환경 미실행)** — `src/test/java/so/goono/eln/schedule/ElnSchedulerTest.java`: `oneFailureDoesNotStopOthers`(첫 노트 `timestampNote`가 RuntimeException → recordFailure 1회, 둘째 노트 clear 1회), `failResultRecordsReason`. 순수 테스트 명령 → Expected: Task 1 테스트 모두 통과.
- [ ] **Step 6: Commit** — `git commit -m "fix: 시점인증 누락 — 기준일·재시도 기록·노트 단위 트랜잭션"`

### Task 4: 시스템 알림 경로 + 알림 표시

**Files:**
- Modify: `src/main/java/so/goono/system/com/util/Constants.java:240-256, 384, 872-877`
- Modify: `src/main/java/so/goono/system/user/service/UserNotiService.java`, `src/main/java/so/goono/system/user/service/UserNotiMapper.java`, `src/main/resources/meta-mappers/system/user/userNoti-mapper.xml`
- Modify: `src/main/resources/templates/basic/_layout/main/body_header.html:105-200`, `src/main/resources/static/core/js/service-worker.goono.js:10-13`

**Interfaces:**
- Consumes: `NotiLinks.resolve` (Task 1), 코드 행 (Task 2).
- Produces:
  - `Constants.SYSTEM_USER_MNO = 0L`, `CD_USER_NOTI_SE_NOTE_INSPECTION_DUE = "NOTE_INSPECTION_DUE"`, `CD_USER_NOTI_SE_NOTE_INSPECTION_REMIND = "NOTE_INSPECTION_REMIND"`(둘 다 `ARR_USER_NOTI_SE_CCD`에 추가), `CD_ELN_HIST_SE_NOTE_INSPCTN_DUE = "NOTE_INSPCTN_DUE"`, `CD_ELN_HIST_SE_NOTE_INSPCTN_REMIND = "NOTE_INSPCTN_REMIND"`.
  - `UserNotiService.insertSystemUserNoti(Long userMno, String userNotiSeCcd, String elnHistSeCcd, String content, String linkPath)` — `@Transactional`(쓰기). 요청·세션에 의존하지 않는다: `createUserMno = SYSTEM_USER_MNO`, `createUserNm = "구노 알림"`, `link = NotiLinks.resolve(appBaseUrl, linkPath)`(`@Value("${app.base-url:}")`), `trgtMno = null`. 저장 후 기존처럼 `serviceWorkerService.sendNotification(json, userMno)`.
  - 매퍼 `insertSystemUserNoti` — `PL_USER`를 조회하지 않는 selectKey(`SELECT (SELECT COM_CD_NM FROM PL_COM_CD WHERE GRP_CD='ELN_HIST_SE_CCD' AND COM_CD=#{elnHistSeCcd}) AS ELN_HIST_SE_CCD_NM FROM DUAL`) + 기존과 같은 INSERT.

- [ ] **Step 1: 매퍼 SQL 검증** — 로컬 DB에서 selectKey 문(코드 있음/없음 둘 다 1행 반환)과 INSERT(`CREATE_USER_MNO=0`)를 실행. 이어 기존 목록 쿼리 `sqlUserNotiList`를 해당 사용자로 실행 → Expected: 새 알림이 보이고 `CREATE_USER_NM`은 NULL(LEFT JOIN).
- [ ] **Step 2: 자바·매퍼 구현** — Interfaces대로.
- [ ] **Step 3: 헤더 표시** — `body_header.html` 알림 템플릿: `userNotiSeCcd`가 두 새 코드면 이름 자리에 `구노 알림`, 본문은 `${noti.content}` 한 줄(“님이 … 했습니다” 없음), 프로필 이미지는 기본 이미지. 클릭: `NOTE_INSPECTION_DUE` → `location.href='/eln/dashboard'`, `NOTE_INSPECTION_REMIND` → `location.href='/eln/note/noteManagementReceived'`(`trgtMno` 검사보다 먼저 분기).
- [ ] **Step 4: 푸시 표시** — `service-worker.goono.js`: `jsonData.userNotiSeCcd`가 두 새 코드면 `message = jsonData.content`.
- [ ] **Step 5: Mockito 테스트 작성(미실행)** — `UserNotiServiceTest.systemNotiNeedsNoRequestContext`: 요청 컨텍스트 없이 호출해도 예외 없음, 매퍼에 `createUserMno=0`, 링크 `/eln/dashboard`(base 비었을 때) 전달.
- [ ] **Step 6: Commit** — `git commit -m "feat: 스케줄러용 시스템 알림 경로와 점검 알림 표시"`

### Task 5: 점검 유도 데이터 계층

**Files:**
- Create: `src/main/java/so/goono/eln/nudge/vo/InspectionNudgeVO.java`(extends `so.goono.system.com.vo.SearchVO`)
- Create: `src/main/java/so/goono/eln/nudge/service/InspectionNudgeMapper.java`(`@Mapper`), `InspectionNudgeService.java`
- Create: `src/main/resources/meta-mappers/eln/nudge/inspectionNudge-mapper.xml`(namespace = 매퍼 FQCN)
- Create: `src/main/java/so/goono/eln/nudge/InspectionNudgeConfig.java` — `@Component`, `@Value`로 키를 읽어 `InspectionNudgePolicy policy()` 제공(시작 시 꺼져 있으면 WARN 1회)

**Interfaces:**
- Consumes: `InspectionNudgePolicy` (Task 1), `ElnProjectGracePeriodPolicy.isGracePeriodEnabled()`, `PL_ELN_NUDGE_LOG` (Task 2).
- Produces (`InspectionNudgeVO` 필드): 검색 — `cycleDays, remindAfterDays, since(LocalDate), leadDays(Integer), gracePeriodEnabled(boolean), schOwnerMno, schProjectMno, schProjectScopeUserMno(Long, 책임자 범위), schViewManagerYn`; 결과 — `noteMno, noteNm, projectMno, projectNm, ownerMno, ownerNm, createDt, inspctnDueDe(yyyyMMdd), daysUntilDue, inspctnUserMno, itemCnt, overdueNoteCnt, staleReqstCnt, inspctnReqstMno, reqstCreateDt`.
- Produces (매퍼/서비스):
  - `selectDueNoteList(vo)` / `selectDueNoteListCnt(vo)` — 기한 계산 컬럼 `INSPCTN_DUE_DE`, `DAYS_UNTIL_DUE = DATEDIFF(DATE_ADD(DATE(CREATE_DT), INTERVAL cycleDays DAY), CURDATE())`, 조건 `DAYS_UNTIL_DUE <= leadDays`(leadDays null이면 조건 없음), 정렬 `DAYS_UNTIL_DUE ASC`, 페이징 `common.sql.paging_header/footer`.
  - `selectDueOwnerCounts(vo): List<InspectionNudgeVO>` — `ownerMno, itemCnt` (leadDays=1).
  - `selectStaleInspectorCounts(vo): List<InspectionNudgeVO>` — `inspctnUserMno, itemCnt`.
  - `selectProjectStatusList(vo)` / `Cnt` — 프로젝트별 `overdueNoteCnt`(DAYS_UNTIL_DUE < 0), `staleReqstCnt`, 둘 다 0인 프로젝트는 제외. `schProjectScopeUserMno`가 있으면 그 사람이 `PL_ELN_PROJECT_MEMBER`에서 `PROJECT_MEMBER_ROLE_CCD IN ('PJ_MANAGER','PJ_LEAD_RESEARCHER') OR GNRL_YN='Y'`인 프로젝트만. 프로젝트 없는 노트는 현황에서 제외.
  - `selectStaleReqstList(vo)` / `Cnt` — 프로젝트 지정 시 요청 단위 목록(노트명, 작성자, 점검자, 요청일).
  - `insertNudgeLogIgnore(String nudgeSeCcd, long userMno, String nudgeDe, int itemCnt): int` — `INSERT IGNORE`, 1이면 새로, 0이면 이미 보냄.
  - `InspectionNudgeService.newSearch(): InspectionNudgeVO` — 정책 값·유예 설정을 채운 검색 VO.

- [ ] **Step 1: 픽스처 작성** — `scratchpad/sql/nudge_fixture.sql`: since=오늘−30일, cycle=7. 노트: N1 작성 중·10일 전 생성(지남), N2 작성 중·6일 전(내일 기한), N3 작성 중·3일 전(아님), N4 반려·20일 전(지남), N5 점검 중·20일 전(제외), N6 작성 중·40일 전(since 이전, 제외), N7 작성 중·10일 전·프로젝트 COMPLETE·유예 없음(제외), N8 작성 중·10일 전·프로젝트 COMPLETE·유예 내일까지(포함, gracePeriodEnabled=true일 때), N9 프로젝트 없음·10일 전(포함, 현황에선 제외). 점검 요청: R1 UNCONFIRM 5일 전(재알림), R2 CHECKING 1일 전(아님), R3 APPROVAL 5일 전(아님), R4 UNCONFIRM 5일 전이지만 EXCLUSION_DT 있음(아님).
- [ ] **Step 2: 각 SQL을 값 치환해 실행하며 작성** — Expected: `selectDueNoteList`(leadDays=1, 전체) = N1,N2,N4,N8,N9 / (leadDays=1, gracePeriodEnabled=false) = N1,N2,N4,N9 / `selectDueOwnerCounts` 소유자별 합이 위와 일치 / `selectStaleInspectorCounts` = R1의 점검자만 1건 / `selectProjectStatusList` = 픽스처 프로젝트만, `overdueNoteCnt`에 N2 미포함 / `insertNudgeLogIgnore` 같은 값으로 두 번 → `ROW_COUNT()` 1, 0.
- [ ] **Step 3: 자바(VO·매퍼 인터페이스·서비스·Config) 구현** — 서비스 읽기 메서드는 매퍼를 그대로 위임, `newSearch()`만 값 채움.
- [ ] **Step 4: Commit** — `git commit -m "feat: 점검 기한·승인 대기 집계 쿼리와 발송 기록"`

### Task 6: 하루 한 번 묶음 알림 스케줄러

**Files:**
- Create: `src/main/java/so/goono/eln/nudge/InspectionNudgeScheduler.java`(`@Component @Profile("!0_LOCAL")`)
- Modify: `src/main/java/so/goono/eln/nudge/service/InspectionNudgeService.java`
- Test: `src/test/java/so/goono/eln/nudge/InspectionNudgeSchedulerTest.java`(Mockito, 이 환경 미실행)

**Interfaces:**
- Consumes: Task 4 `insertSystemUserNoti`, Task 5 집계·`insertNudgeLogIgnore`.
- Produces:
  - `InspectionNudgeService.notifyOnce(String nudgeSeCcd, long userMno, LocalDate today, int itemCnt, String userNotiSeCcd, String elnHistSeCcd, String content, String linkPath): boolean` — `@Transactional`. 로그 INSERT IGNORE가 0이면 false(발송 안 함), 1이면 알림 저장 후 true. 알림이 실패하면 로그도 롤백.
  - `InspectionNudgeService.sendDailyDigests(LocalDate today): int[] {researchers, inspectors}`
  - 스케줄러 `runDaily()` — `@Scheduled(cron = "${note.inspection.nudge.cron:0 50 8 * * *}")`, 정책이 꺼져 있으면 즉시 반환. 수신자마다 `notifyOnce`를 따로 호출(한 사람 실패가 나머지를 막지 않게 RuntimeException은 잡아서 로그).
  - 로그 구분 코드: 연구원 `NOTE_INSPCTN_DUE`, 점검자 `NOTE_INSPCTN_REMIND`. 링크: 연구원 `/eln/dashboard`, 점검자 `/eln/note/noteManagementReceived`. 문구는 Global Constraints 그대로.

- [ ] **Step 1: Mockito 테스트 작성** — `disabledPolicySendsNothing`, `secondRunSameDaySendsNothing`(`insertNudgeLogIgnore`가 0 → `insertSystemUserNoti` 호출 0회), `oneRecipientFailureDoesNotStopOthers`, `contentUsesCountAndDays`(점검자 문구에 `3일 넘게`·`2건`).
- [ ] **Step 2: 구현**
- [ ] **Step 3: 로컬 DB로 흐름 확인** — Task 5 픽스처에서 `notifyOnce`가 만드는 두 SQL(INSERT IGNORE → INSERT PL_USER_NOTI)을 순서대로 두 번 실행. Expected: 알림 1행, 로그 1행.
- [ ] **Step 4: Commit** — `git commit -m "feat: 연구원 점검 기한·점검자 승인 대기 하루 묶음 알림"`

### Task 7: 연구원 대시보드 "점검 기한" 카드

**Files:**
- Create: `src/main/java/so/goono/eln/nudge/controller/InspectionNudgeController.java`
- Modify: `src/main/resources/templates/basic/eln/dashboard/dashboard.html`(스크립트 13-102 영역 + 카드 마크업 186-208 근처)

**Interfaces:**
- Consumes: Task 5 `newSearch`, `selectDueNoteList/Cnt`.
- Produces: `POST /api/eln/note/inspctnDueList` — 로그인 사용자 본인 노트만(`schOwnerMno = SessionHelper.getUserMno()`, 클라이언트 값 무시), `leadDays = InspectionNudgePolicy.DIGEST_LEAD_DAYS`. 응답 `{ nudgeEnabled: boolean, dueListInfo: PaginationInfo }`, `s2ResultCode=1`. 정책이 꺼져 있으면 `nudgeEnabled=false`, 빈 목록.

- [ ] **Step 1: MockMvc standalone 테스트 작성(미실행)** — `InspectionNudgeControllerTest.dueListIgnoresClientOwner`(요청에 다른 `schOwnerMno`를 넣어도 서비스에 세션 사용자 번호가 전달), `disabledReturnsFlagFalse`.
- [ ] **Step 2: 컨트롤러 구현** — 기존 `ElnNoteMngController` 형식(`ModelMap` + `ViewConstant.JSON_VIEW`).
- [ ] **Step 3: 카드 추가** — 제목 "점검 기한", 행마다 노트명(클릭 시 `gfn_openNoteDetail('/eln/note/noteDetails', noteMno)`), 프로젝트명(없으면 "개인 노트"), 표시 `daysUntilDue > 0 → "D-n"`, `0 → "D-day"`, `< 0 → "n일 지남"`. `nudgeEnabled=false`이거나 0건이면 카드 숨김. 5건 + "더 보기" 페이징은 `S2Util.pagination` 사용.
- [ ] **Step 4: 화면 확인(가능하면)** — 서버 실행 불가 환경에서는 템플릿만 검토하고 보고에 "화면 미확인"으로 적는다.
- [ ] **Step 5: Commit** — `git commit -m "feat: 대시보드 점검 기한 카드"`

### Task 8: 점검 현황 화면(책임자·관리자) + 시점인증 실패 목록

**Files:**
- Modify: `src/main/java/so/goono/eln/nudge/controller/InspectionNudgeController.java`
- Create: `src/main/resources/templates/basic/eln/note/inspection_status.html`(레이아웃·표·페이징은 `note_management_received.html` 형식)

**Interfaces:**
- Consumes: Task 5 현황 쿼리, Task 3 `selectGivenUpList/Cnt`.
- Produces:
  - `GET /eln/note/inspctnStatus` → `eln/note/inspection_status` (메뉴는 Task 2에서 등록).
  - `POST /api/eln/note/inspctnStatusProjectList` → `projectStatusListInfo`. 권한: `SessionHelper.getViewManagerYn()=="Y"`이면 전체, 아니면 `schProjectScopeUserMno = 본인`. 책임자 범위에 프로젝트가 하나도 없는 일반 연구원도 빈 목록(오류 아님).
  - `POST /api/eln/note/inspctnStatusNoteList`(`schProjectMno` 필수) → 기한 지난 노트 목록 `overdueNoteListInfo` + 승인 대기 요청 목록 `staleReqstListInfo`. 관리자가 아니면 `ElnPermissionService.checkProjectMng(projectMno)`로 검사(실패 시 기존 예외 그대로).
  - `POST /api/eln/note/timestampFailList` → `timestampFailListInfo`. 관리자(`getViewManagerYn()=="Y"`)가 아니면 `S2RuntimeException(MessageSourceHelper.getMessage("i18n.error.read"))`.

- [ ] **Step 1: MockMvc standalone 테스트 작성(미실행)** — `nonManagerSeesOnlyOwnProjects`(서비스에 `schProjectScopeUserMno=세션 사용자`), `noteListChecksProjectMng`, `timestampFailListRejectsNonManager`.
- [ ] **Step 2: 컨트롤러 구현**
- [ ] **Step 3: 화면 구현** — 탭 1 "프로젝트별 현황"(프로젝트, 기한 지난 노트, 오래된 승인 대기 — 숫자 클릭 시 아래에 노트·요청 목록), 탭 2 "시점인증 실패"(관리자만 표시: 노트명, 점검 완료일, 실패 횟수, 마지막 오류, 마지막 시도). 정책이 꺼져 있으면 탭 1 위에 "점검 유도 기능이 설정되지 않았습니다(note.inspection.nudge.since)" 안내.
- [ ] **Step 4: Commit** — `git commit -m "feat: 책임자·관리자 점검 현황과 시점인증 실패 목록"`

### 마무리

- [ ] 순수 테스트 전체 재실행(Expected: 실패 0), 이번 작업의 SQL 픽스처 전부 재실행.
- [ ] 이 환경에서 실행하지 못한 검증 목록(전체 컴파일, Mockito·MockMvc 테스트, 화면, 실제 TSA)을 정리해 보고.
- [ ] `git push -u origin claude/tablet-app-hand-drawing-sync-ofo0oi` (Goono-ELN).
