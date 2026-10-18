# 2B단계 — 앱 QR 연결 + 동기화 계약 갱신 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 태블릿 앱이 비밀번호 대신 구노 웹에서 띄운 QR(일회용 연결 코드)로 연결되게 하고, 그 계약을 `SYNC-API.md`와 모의 서버에 먼저 확정한다(2C 서버 구현의 기준).

**Architecture:** 계약 문서와 모의 서버를 먼저 바꾸고(Task 1), 앱의 연결 로직을 순수 모듈(`pairing.ts`) + `api.pair` + `session.pair`로 나눈 뒤(Task 2), 연결 화면과 E2E를 바꾸고(Task 3), 마지막에 네이티브 카메라 스캐너·딥링크 설정을 붙인다(Task 4).

**Tech Stack:** Capacitor 8, React 19, TypeScript, Vite, Express 모의 서버, node --test, Playwright(크로미움 `/opt/pw-browsers/chromium`), `@capacitor/barcode-scanner@3.1.3`.

**Spec:** `handdrawing/docs/superpowers/specs/2026-10-17-goono-tablet-app-design.md` §6.0(QR 연결), §7.1·§7.2(pair·pairing-code), §4(계정 연결 변경). 기존 계약: `app/docs/SYNC-API.md`.

**저장소/브랜치:** `/home/user/handdrawing`, 브랜치 `claude/tablet-app-hand-drawing-sync-ofo0oi`, 작업 위치 `app/`.

## Global Constraints

- 연결 코드: **8자**, 문자 집합 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`(0·O·1·I·L 제외), 화면 표시는 `XXXX-XXXX`, 서버·앱 모두 **대문자로 바꾸고 `-`·공백을 지운 뒤** 비교. **일회용, 5분 유효.** 같은 사용자가 새 코드를 받으면 이전 미사용 코드는 무효.
- QR 내용: `goono-note://pair?server=<https URL>&code=<XXXX-XXXX>` (URL 인코딩). 앱은 scheme `goono-note`·host `pair`가 아니거나 server가 https가 아니면 거부(개발 빌드만 http 허용).
- 웹(로그인 세션) `POST /api/eln/app/pairing-code` → `{ "code": "K7Q2-M9XD", "qrPayload": "goono-note://pair?server=…&code=K7Q2-M9XD", "expiresAt": "…Z" }`.
- 앱 `POST /api/app/v1/devices/pair` (익명) 요청 `{ "pairingCode", "device": { "id", "name", "platform", "model", "appVersion" } }` → 응답은 기존 `/devices/register`와 같은 형식(`token, tokenExpiresAt, offlineGraceDays, user, serverTime`). 오류: 401 `INVALID_PAIRING_CODE`(없음·만료·사용됨), 403 `APP_DISABLED`(기관이 태블릿 연결을 끔), 403 `DEVICE_NOT_ALLOWED`, 429 `TOO_MANY_ATTEMPTS`(+ `Retry-After` 초).
- 연결 실패 제한: **같은 IP에서 10분 안에 5번 실패하면 429.** (틀린 코드는 어느 코드의 시도인지 알 수 없으므로 코드 단위가 아니라 IP 단위 — 설계 §6.0 "틀린 시도 5회면 폐기"의 구현 방식.)
- `POST /devices/register`(아이디·비밀번호)는 서버 설정으로만 켜지는 보조 경로. 꺼져 있으면 403 `PASSWORD_LOGIN_DISABLED`. 앱의 비밀번호 화면은 **개발·체험 빌드(`ALLOW_DEMO`)에만** 보인다.
- 기기 묶음: 서버의 기기 기록은 **(기기 ID, 사용자)** 단위. 같은 사용자가 같은 기기를 다시 연결하면 토큰만 새로 발급. 다른 사용자가 같은 기기를 연결하면 새 묶음이 생기고, 이전 사용자의 "기기에서 작성 중" 노트는 웹에서 편집권 회수로 정리한다.
- 다시 연결: 토큰 만료(`NEEDS_LOGIN`)·기기 사용 중지(`REVOKED`) 모두 "다시 연결" 버튼 → 새 QR. 같은 계정이면 기기 데이터를 이어 쓰고, 다른 계정이면 올리지 않은 기록이 있는 한 거부(기존 규칙).
- 화면 문구(정확히): 첫 화면 제목 `QR로 연결`, 보조 버튼 `코드 직접 입력`, 확인 문구 `이 서버에 연결할까요?`, 오류 — `INVALID_PAIRING_CODE`: `코드가 맞지 않거나 만료되었습니다. 구노 웹에서 새 QR을 띄워 주세요.` / `APP_DISABLED`: `이 기관은 태블릿 연결을 사용하지 않습니다. 관리자에게 문의하세요.` / `DEVICE_NOT_ALLOWED`: `이 기기는 연결할 수 없습니다. 관리자에게 문의하세요.` / `TOO_MANY_ATTEMPTS`: `시도가 너무 많습니다. 잠시 후 다시 시도하세요.` / 잠금 버튼 `다시 연결`.
- 기존 E2E 15단계의 의미(오프라인 작성·암호화·동기화·반납·회수·기한·폐기)는 그대로 통과해야 한다.

## 검증 방법 (이 환경)

- `cd /home/user/handdrawing/app && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci` (최초 1회), 단위 `npm test`, 타입 `npm run typecheck`, 빌드 `npm run build`, E2E `npm run build && npm run test:e2e`(크로미움은 `run.mjs`가 `/opt/pw-browsers/chromium`을 자동 사용). 네이티브 빌드(Xcode·Android SDK)는 불가 — `npx cap sync`까지만.

## Review Focus

1. **엉뚱한 QR**(다른 앱의 QR, http 서버, 코드 없는 URL, 9자 코드)을 읽으면 연결을 시도하지 않고 원인을 알려 준다 — Task 2 `parsePairingUri` 단위 테스트.
2. **사람이 코드를 소문자·하이픈 없이·앞뒤 공백과 함께** 입력해도 같은 코드로 인식된다 — Task 2 `normalizeCode` 테스트 + Task 3 E2E에서 소문자 입력.
3. **같은 코드를 두 번** 쓰거나 5분이 지난 코드를 쓰면 401 `INVALID_PAIRING_CODE`와 안내 문구 — Task 1 모의 서버 + Task 3 E2E.
4. **기기 사용 중지 후** 잠금 배너에서 "다시 연결" → 새 코드로 연결하면 같은 계정의 기기 데이터(필기·대기 버전)가 그대로 이어진다 — Task 3 E2E.
5. **다른 계정의 QR**로 다시 연결하는데 올리지 않은 기록이 있으면 거부되고 기록은 남는다 — Task 3 E2E(`researcher2`).

---

### Task 1: 계약 문서 + 모의 서버

**Files:** Modify `app/docs/SYNC-API.md`, `app/mock-server/server.mjs`, `app/README.md`(모의 서버 계정·관리 API 안내)

**Interfaces:**
- Produces (모의 서버): `POST /__admin/pairing-code {loginId, ttlMs?} → {code, qrPayload, expiresAt}`; `POST /api/app/v1/devices/pair`; `POST /__admin/config {passwordLogin?: boolean, appEnabled?: boolean, blockedDeviceIds?: string[]}`; 사용자 `researcher1/goono1234`(userMno 12), `researcher2/goono1234`(userMno 13); `GET /__admin/state`에 `pairingCodes` 포함. 기존 엔드포인트·관리 API는 유지.

- [ ] **Step 1: SYNC-API.md** — 맨 앞에 "0. 연결(QR)" 절: 웹 pairing-code, 코드 형식·정규화·만료·일회성·재발급 무효화, QR 형식, `/devices/pair` 요청·응답·오류, IP 실패 제한(5회/10분, `Retry-After`), 기기 묶음 규칙(Global Constraints 문장 그대로). §1 `/devices/register`는 "서버 설정(`app.device.password-login.enabled`)이 켜졌을 때만, 꺼지면 403 `PASSWORD_LOGIN_DISABLED`"로 수정. 모든 `/api/app/v1` 요청에 403 `APP_DISABLED` 가능 문장 추가. DB 변경안 표의 `PL_APP_DEVICE`를 `DEVICE_MNO`(대리키) + `UNIQUE(DEVICE_ID, USER_MNO)` + 편집 위치는 `EDIT_DEVICE_MNO`로, `PL_APP_PAIRING_CODE (CODE_HASH PK, USER_MNO, EXPIRES_DT, USED_DT, CREATE_DT)` 추가.
- [ ] **Step 2: 모의 서버** — Interfaces대로. 코드 생성은 Global Constraints 문자 집합, 저장은 정규화 값. `/devices/pair` 성공 시 기존 register와 같은 기기 upsert(키를 `${deviceId}:${userMno}`로)·토큰 발급. `passwordLogin` 기본 `true`(기존 E2E 호환은 Task 3에서 pair로 바꾼 뒤 기본 `false`로 전환).
- [ ] **Step 3: 확인** — 모의 서버를 띄우고 curl로: 코드 발급 → pair 성공 → 같은 코드 재사용 401 → 틀린 코드 5번 후 429(+Retry-After) → `appEnabled:false`면 403 `APP_DISABLED`. 출력 보고.
- [ ] **Step 4: Commit** — `docs: 동기화 계약에 QR 연결(pair) 추가, 모의 서버 반영`

### Task 2: 연결 로직 — 순수 모듈 + api + session

**Files:**
- Create: `app/src/lib/pairing.ts`, `app/tests/unit/pairing.test.mjs`
- Modify: `app/src/lib/api.ts`, `app/src/lib/session.ts`, `app/src/lib/demo.ts`(체험 서버에 `/devices/pair` 추가)

**Interfaces:**
- Produces:
  - `pairing.ts`: `export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; export function normalizeCode(input: string): string | null` (대문자·`-`·공백 제거, 8자이고 모두 알파벳이면 그 값, 아니면 null); `export function formatCode(code: string): string` (`XXXX-XXXX`); `export type PairingTarget = { serverUrl: string; code: string }`; `export function parsePairingUri(text: string, opts?: { allowHttp?: boolean }): PairingTarget | { error: 'NOT_PAIRING_QR' | 'INSECURE_SERVER' | 'BAD_CODE' }` (serverUrl은 기존 `normalizeServerUrl` 규칙 적용).
  - `api.pair(serverUrl: string, pairingCode: string, device: DeviceInfo): Promise<RegisterResponse>`; `ApiError`에 `retryAfterSec?: number` (응답 `Retry-After` 헤더).
  - `session.pair(serverUrl: string, pairingCode: string, deviceName: string): Promise<Session>` — 기존 `login`의 기기 정보·같은 계정 확인·세션 저장 부분을 공통 함수로 빼서 `login`(개발·체험용)과 함께 쓴다.

- [ ] **Step 1: 실패하는 테스트** — `pairing.test.mjs`: `normalizes lowercase hyphen spaces`(`' k7q2-m9xd '` → `K7Q2M9XD`), `rejects ambiguous chars`(`K7Q2M9X0` → null), `rejects wrong length`, `formats code`, `parses valid uri`(서버 끝 슬래시 정리 포함), `rejects other scheme/host`(→ `NOT_PAIRING_QR`), `rejects http unless allowed`(→ `INSECURE_SERVER`, `allowHttp:true`면 통과), `rejects missing or bad code`(→ `BAD_CODE`).
- [ ] **Step 2: 실패 확인** — `npm test` → Expected: 새 테스트 실패(모듈 없음), 기존 10개 통과.
- [ ] **Step 3: 구현** — Interfaces대로. `session.pair`는 코드를 `normalizeCode` 후 전송, 응답 처리·같은 계정 확인은 `login`과 같은 공통 함수.
- [ ] **Step 4: 통과 확인** — `npm test`, `npm run typecheck` → 전부 통과.
- [ ] **Step 5: Commit** — `feat(app): QR 연결 로직 — 코드 정규화·QR 해석·pair API`

### Task 3: 연결 화면 + 다시 연결 + E2E

**Files:**
- Create: `app/src/screens/Connect.tsx`
- Modify: `app/src/App.tsx`(세션 없을 때·relogin 경로가 `Connect`), `app/src/screens/Login.tsx`(개발·체험 빌드 전용 비밀번호 화면으로 축소 — `Connect`의 보조 링크에서만 진입), `app/src/ui.tsx`(`LockBanner`: `NEEDS_LOGIN`·`REVOKED` 모두 `다시 연결` 버튼), `app/src/lib/rules.ts`(`LOCK_MESSAGES` 문구를 "다시 연결" 기준으로), `app/styles.css`, `app/tests/e2e/run.mjs`, `app/mock-server/server.mjs`(`passwordLogin` 기본 `false`), `app/README.md`

**Interfaces:**
- Consumes: Task 2 `parsePairingUri`, `normalizeCode`, `formatCode`, `session.pair`; Task 4가 제공할 `scanPairingQr()`·`canScanQr()`는 이 태스크에서 **임시 구현**(`canScanQr()`가 웹에서 false)으로 두고 Task 4가 채운다 → 파일 `app/src/lib/scan.ts`를 여기서 만들고 `export async function canScanQr(): Promise<boolean>`(웹 false), `export async function scanPairingQr(): Promise<string | null>`(웹 null)만 둔다.
- Produces (testid): `connect-scan`, `connect-manual`, `connect-server`, `connect-code`, `connect-device`, `connect-submit`, `connect-error`, `connect-confirm`(확인 단계 컨테이너), `connect-confirm-ok`, `connect-demo`, `connect-password`(개발 빌드만).

- [ ] **Step 1: 화면** — 상태: 첫 화면(`QR로 연결` + 스캔 버튼(`canScanQr()`일 때만) + `코드 직접 입력`) → (스캔 결과 또는 딥링크) 확인 단계 `이 서버에 연결할까요?` + 호스트 표시 → 연결 중 → 오류(Global Constraints 문구, `TOO_MANY_ATTEMPTS`는 `retryAfterSec`가 있으면 "약 N초 후" 덧붙임, 네트워크 오류는 기존 문구). 직접 입력: 서버 주소(이전 서버 기억)·코드·기기 이름. 다시 연결 모드: 서버 주소 고정. 체험 링크 유지. 비밀번호 링크는 `ALLOW_DEMO`일 때만.
- [ ] **Step 2: E2E 재작성** — 로그인 단계를 "모의 서버 `/__admin/pairing-code`로 코드 발급 → `코드 직접 입력` → 소문자·하이픈 없이 입력 → 연결"로. 재로그인 단계를 "기한 만료 → `다시 연결` → 새 코드 → 같은 계정 이어 쓰기(대기 버전 업로드 확인)"로. 폐기 단계 뒤에 "`다시 연결` → 새 코드 → 잠금 해제·기록 유지" 추가. 추가 단계: 같은 코드 재사용 → `connect-error`에 INVALID 문구; `researcher2` 코드로 다시 연결 시 올리지 않은 기록이 있으면 거부 문구. 스크린숏 `tests/e2e/out/`.
- [ ] **Step 3: 확인** — `npm test`, `npm run typecheck`, `npm run build && npm run test:e2e` → Expected: 전 단계 통과(단계 수와 결과를 보고).
- [ ] **Step 4: Commit** — `feat(app): QR 연결 화면과 다시 연결 — 비밀번호 로그인은 개발 빌드 전용`

### Task 4: 네이티브 QR 스캐너 + 딥링크

**Files:**
- Modify: `app/package.json`(`@capacitor/barcode-scanner@3.1.3`), `app/src/lib/scan.ts`(실구현), `app/src/lib/store.ts`(`App.addListener('appUrlOpen')` → 연결 화면에 대상 전달), `app/android/variables.gradle`(`minSdkVersion 26`), `app/android/app/src/main/AndroidManifest.xml`, `app/ios/App/App/Info.plist`, `app/README.md`

**Interfaces:**
- Produces: `canScanQr()` — 네이티브(iOS·Android)면 true; `scanPairingQr()` — `CapacitorBarcodeScanner.scanBarcode({ hint: QR_CODE, scanInstructions: 'QR 코드를 화면 안에 맞춰 주세요' })`의 결과 문자열, 취소 시 null; 딥링크 `goono-note://pair?...` 수신 시 `parsePairingUri` → 확인 단계.

- [ ] **Step 1: 설정** — Android: `<uses-permission android:name="android.permission.CAMERA"/>`, `<uses-feature android:name="android.hardware.camera" android:required="false"/>`, `MainActivity`에 `goono-note` scheme·`pair` host intent-filter(VIEW, DEFAULT, BROWSABLE), minSdk 26. iOS: `NSCameraUsageDescription` = `구노 연구노트를 연결하는 QR 코드를 읽기 위해 카메라를 사용합니다.`, `CFBundleURLTypes`에 scheme `goono-note`.
- [ ] **Step 2: 구현** — Interfaces대로. 딥링크 처리는 순수 함수 `pairingFromUrl(url: string)`(= `parsePairingUri` 재사용)을 거치고, 세션이 이미 있으면 다시 연결 모드일 때만 반영(평소엔 무시).
- [ ] **Step 3: 확인** — `npm test`(딥링크 순수 함수 테스트 `ignores non-pair urls`, `routes pair url` 추가), `npm run typecheck`, `npm run build`, `npx cap sync` 성공(생성된 `ios/App/CapApp-SPM/Package.swift`·`android/capacitor.settings.gradle`에 플러그인 포함 확인). E2E 회귀 1회. 실기기 스캔은 미확인으로 보고.
- [ ] **Step 4: Commit** — `feat(app): 카메라 QR 스캔과 goono-note 딥링크`
