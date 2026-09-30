# 구노 연구노트 태블릿 앱

iPad·갤럭시 탭에서 **오프라인으로, 펜으로 연구노트를 쓰고** 연결될 때 **구노 전자연구노트(ELN)로 단방향 동기화**하는 앱.
Capacitor 8 + React 19 + TypeScript.

**손글씨가 중심이다.** 노트를 열면 A4 본문 비율의 모눈 페이지가 화면을 채우고(화면의 92–95%), 펜을 대면 바로 써진다.
손가락은 넘기기·확대, 키보드 글은 페이지 위 **글상자**로 쓴다. 도구는 떠 있는 팔레트(가로: 왼쪽 레일, 세로: 아래 막대) 하나에
모았고, 상단에는 제목·저장 상태·버전·작성 완료만 둔다. 필기 엔진은 웹 구노의 손글씨 편집기와 같은 파일(`../js/engine.js`)이다.

| 화면 | 내용 |
|---|---|
| 노트 선반 | 첫 페이지 썸네일, 프로젝트·수정 시각·상태(작성 중/올릴 버전/미반영/점검 중) |
| 새 노트 | 프로젝트 하나면 바로, 여럿이면 고르고 "쓰기 시작". 제목은 날짜로 채우고 나중에 고친다(첫 획 전에 키보드 없음) |
| 필기 | 펜·형광펜·지우개·올가미·글상자·도형 · 색/굵기 · 실행 취소 · 손가락 쓰기. 페이지 머리글에 제목·날짜·쪽 |
| + 넣기 | **사진**, **표**(줄·칸 수, 머리글, 칸 글 — 비워 두고 펜으로 칸에 써도 됨), **수식**(MathLive 수식 키보드, LaTeX), **화학식**(`2H2 + O2 -> 2H2O` 같은 보통 글자 → mhchem), **구조식**(Ketcher, SMILES 불러오기), **날짜·시각 도장**. 넣은 객체는 올가미로 한 번 누르면 선택되고 "○○ 고치기"로 다시 연다. 모두 오프라인에서 동작 |
| 상태 알약 | 기기 저장 시각·올릴 버전·오프라인 여부. 누르면 동기화 상세(마지막 동기화, 작성 기한, 지금 동기화) |
| 버전 기록 | 기기에서 쓴 시각·구노가 받은 시각·구노 버전·쪽수, 미반영 사유, 보기, 새 노트로 복원 |

- 동기화 계약(서버 구현 기준): [`docs/SYNC-API.md`](docs/SYNC-API.md)
- 모의 서버(개발·E2E용): [`mock-server/server.mjs`](mock-server/server.mjs)

## 동작 방식

| 항목 | 규칙 |
|---|---|
| 편집 위치 | 노트마다 하나(이 기기 또는 웹). 앱에서 만든 노트는 만든 기기가 편집 위치. 동시 편집 없음 |
| 작업본 | 필기(획 JSON)를 기기에 암호화 저장. 획마다 저장하지 않고 손을 4초 멈추면 저장(펜이 닿아 있는 동안은 저장 안 함, 쉬지 않고 쓰면 1분이 지난 뒤 잠깐 멈출 때 저장). 앱을 내리거나 노트를 떠나거나 버전을 만들 때는 즉시. 서버로는 가지 않음 |
| 버전 | 서버로 올라가는 단위(전체 스냅숏). 노트를 떠날 때, 앱이 백그라운드로 갈 때, 5분마다 저절로, 버전 기록에서 "지금 버전 만들기" |
| 버전 형식 | 페이지마다 PNG(1440×2136, A4 본문 비율) + `figure.rw-drawing[data-strokes={title,strokes,layout}][data-drawing-sha256]` — 웹 구노 손글씨 블록과 같아 서버·웹 편집기·PDF 변환이 그대로 받는다. 제목은 버전과 함께 서버 노트 제목에 반영 |
| 동기화 | 온라인이 되면·1분마다·버전 저장 직후. 버전은 순서대로, `clientVersionId`로 재전송 안전, 내용 해시로 손상 검출 |
| 작성 완료 | 남은 버전을 모두 올리고 편집권을 웹에 반납 → 앱은 읽기 전용, **점검 요청·시점인증은 구노 웹에서 기존대로** |
| 점검 차단 | 편집 위치가 기기인 노트는 웹에서 점검 요청 불가(누락 방지) |
| 미반영 기록 | 서버가 받지 않은 버전(편집권 회수·점검 이후 등)은 지우지 않고 보관. "새 노트로 복원" 가능 |
| 오프라인 기한 | 기기 토큰 만료 시각 = 오프라인 작성 기한(기본 14일, 서버 정책). 지나면 편집 잠금, 기록은 보존. 시계를 되돌리면 잠금 |
| 재로그인 | 토큰 만료 후 연결되면 재로그인 요구. 같은 계정이면 기기 데이터를 이어 쓰고 대기 기록을 올림 |
| 기기 폐기 | 서버에서 기기를 사용 중지하면 편집 잠금 |
| 기기 저장 | 앱 데이터 영역에 AES-GCM 256 암호화. 키는 iOS 키체인 / Android 키스토어. Android 백업·기기 이전 제외 |
| 로그아웃 | 올리지 않은 기록이 있으면 거부. 로그아웃 시 기기 데이터 삭제 |

## 개발

```bash
cd handdrawing/app
npm install
npm run mock        # 모의 구노 서버 http://localhost:8787 (researcher1 / goono1234)
npm run dev         # http://localhost:5173 — 브라우저에서 바로 확인(태블릿 크기로)
```

모의 서버 화면 `http://localhost:8787/` 에서 앱이 올린 노트·버전(서버 수신 시각, 기기 작성 시각, 손글씨 이미지)을 확인할 수 있다.
테스트용 관리 API: `POST /__admin/notes/{noteMno}/reclaim`(편집권 회수), `/__admin/notes/{noteMno}/status`(점검 요청 흉내),
`/__admin/devices/{deviceId}/revoke`(기기 폐기), `/__admin/config {"tokenTtlMs":8000}`(오프라인 기한 단축).

## 테스트

```bash
npm test            # 단위: 편집 가능 규칙, 서버 상태 반영, 오류 분류, 이미지 변환, 내용 해시(서버 규칙과 일치)
npm run build && npm run test:e2e   # 태블릿(iPad 11" 가로) 에뮬레이션 E2E, 15단계
```

E2E 시나리오: 로그인 → **새 노트가 곧바로 펜 필기 페이지**(키보드 없음) → 오프라인에서 펜 필기 + 글상자 → 버전(기기 대기) →
저장소 암호화 확인 → 오프라인 재시작 후 필기·글상자 복원 → 웹 점검 요청 거부 → 온라인 복귀 자동 동기화(웹과 같은 손글씨 블록,
A4 본문 비율 페이지 PNG) → 제목 변경·2쪽 필기 → 작성 완료·반납(도구 사라짐) → 편집권 회수 후 미반영 보관 → 새 노트로 복원 →
오프라인 기한 만료 잠금 → 재로그인 후 대기 버전 업로드 → 기기 폐기 잠금.
스크린숏은 `tests/e2e/out/`.

## 네이티브 빌드

```bash
npm run cap:sync            # build + cap sync (android, ios)
# Android: JDK 21, Android SDK(platform 36, build-tools 36)
cd android && ./gradlew assembleDebug      # → app/build/outputs/apk/debug/app-debug.apk
# iOS: macOS + Xcode
npx cap open ios
```

개발 중 같은 망의 **http** 모의 서버에 실제 기기로 붙으려면 `GOONO_DEV_HTTP=1 npx cap sync` (Android 평문·혼합 콘텐츠 허용),
iOS는 `ios/App/App/Info.plist`에 `NSAppTransportSecurity › NSAllowsLocalNetworking = YES`를 개발용으로만 추가한다.
운영 구노 서버는 https.

### 갤럭시 탭에서 바로 해 보기 (개발용 APK)

```bash
npm run build && GOONO_DEV_HTTP=1 npx cap sync android
cd android && ./gradlew assembleDebug        # http 서버 접속 허용 빌드
npm run mock                                  # PC에서 모의 서버 (0.0.0.0:8787)
```
태블릿과 PC를 같은 Wi-Fi에 두고 APK 설치 → 로그인 화면 서버 주소에 `http://<PC IP>:8787`, `researcher1 / goono1234`.
PC 브라우저 `http://localhost:8787/` 에서 올라온 노트를 본다. 태블릿 비행기 모드로 오프라인 작성을 시험할 수 있다.
배포용 빌드는 반드시 `GOONO_DEV_HTTP` 없이 `npx cap sync` 한다.

## 내 iPad에서 쓰기

### 1) 바로 체험 — Mac 없이 (웹 체험판)

체험판 빌드(`npm run build:demo` → `dist-demo/`)는 로그인·서버 없이 브라우저 안에서만 동작한다. 앱 안의 체험 서버(`src/lib/demo.ts`)가
동기화 API를 흉내 내므로 버전 만들기 → "구노에 올라감", 비행기 모드 → 오프라인 작성 → 연결 후 자동 동기화까지 그대로 해 볼 수 있다.
쓴 내용은 그 브라우저 저장소에만 남는다(Safari 기록·사이트 데이터를 지우면 사라짐). https 로 서빙해야 한다(WebCrypto).
보안 정책이 엄격한 곳(claude.ai 아티팩트 등)에서도 뜨도록: 나중에 불러오는 조각의 스타일은 JS 안에 넣고
(`inlineKetcherCss`), 구조식 계산 엔진의 문자열 코드 실행을 없앴으며(`scripts/vite-embind-no-eval.ts`),
WASM 까지 막힌 곳에서는 구조식 편집기를 엔진 없이 연다(직접 그리기·molfile 저장·그림은 됨, SMILES 불러오기는 안 됨).

### 2) 앱으로 설치 — Mac + Xcode (무료 Apple ID 로도 가능)

```bash
git clone … && cd handdrawing && git checkout claude/handwriting-editor-integration-check-ktdg1j
cd app && npm install
npm run ios:dev        # 체험 모드 포함 빌드 → cap sync ios → Xcode 열기
```
1. Xcode ▸ App 타깃 ▸ **Signing & Capabilities** ▸ Team 에 본인 Apple ID(Personal Team) 추가.
   Bundle Identifier 는 겹치지 않게 바꾼다(예: `kr.redwit.goono.note.kim`).
2. iPad 를 케이블로 Mac 에 연결 → iPad 에서 "이 컴퓨터 신뢰".
   iPad **설정 ▸ 개인정보 보호 및 보안 ▸ 개발자 모드** 켜기(재시동).
3. Xcode 위쪽 실행 대상에서 iPad 를 고르고 ▶(Run). 처음이면 iPad **설정 ▸ 일반 ▸ VPN 및 기기 관리**에서 개발자 앱을 신뢰.
4. 앱이 뜨면 로그인 화면의 **서버 없이 체험하기**, 또는 https 구노 서버 주소로 로그인.
   - 무료 Apple ID 로 설치한 앱은 7일 뒤 실행이 막힌다 → 다시 ▶. 회사 Apple Developer 계정이면 1년.
   - Mac 에서 돌리는 http 모의 서버(`npm run mock`)에 붙이려면 개발용으로만 `ios/App/App/Info.plist` 에
     `NSAppTransportSecurity ▸ NSAllowsLocalNetworking = YES` 를 넣고 서버 주소를 `http://<Mac IP>:8787` 로.

### 3) 여러 명·기관에 나눠 주기

- 팀 안 시험: Apple Developer 계정 → App Store Connect **TestFlight** 내부 테스터(심사 없음, 90일).
- 고객 기관 배포: 아래 ABM Custom App.

## 배포 (고객 기관 내부용)

- **iPad**: Apple Business Manager **Custom App**(기관 지정 비공개 배포). 앱 심사는 거치며, 고객 기관 ABM에 배정 → 기관 MDM으로 설치.
  Enterprise(In-House) 프로그램은 자사 직원용이라 고객 기관 배포에 쓸 수 없다.
- **갤럭시 탭**: 서명한 APK/AAB를 기관 MDM(Knox Manage 등) 또는 Managed Google Play 비공개 앱으로 배포.
- 앱 ID `kr.redwit.goono.note`. 서버 주소는 로그인 화면에서 기관별로 입력(MDM 관리형 설정으로 미리 채우는 것은 후속).

## 실기기에서 확인할 것 (에뮬레이션으로 검증 못 한 부분)

- Apple Pencil·S Pen 필압/손바닥 무시, 펜이 닿으면 손가락이 넘기기로 바뀌는 동작(엔진은 PointerEvent 기반, 웹 에뮬레이션에서 검증).
- 글상자: iPad 소프트 키보드가 글상자를 가리지 않는지, 한글 입력기(조합) 동작. 필요하면 `@capacitor/keyboard` 로 캔버스를 올린다.
- iPad Scribble(펜으로 입력칸에 쓰면 글자로 바뀜)은 캔버스에서는 동작하지 않는다(의도: 필기는 필기로 남긴다).
- 구노 서버가 기관 내부망(사설 IP)일 때 WebView의 로컬 네트워크 접근 정책(Chromium LNA) — E2E에서는 헤드리스 검사를 껐다.
- 키체인/키스토어 키 보존: 앱 삭제 후 재설치 시 키가 사라지면 기기 데이터는 복구 불가(설계상 의도, 원본은 서버).

## 구노 ELN 쪽 남은 일

`docs/SYNC-API.md`의 서버 구현: 기기 토큰 필터 체인(웹 세션과 분리), `/api/app/v1/*`, 편집 위치 컬럼과
웹 에디터 읽기 전용 표시, **편집 위치가 기기인 노트의 점검 요청 거부**, 편집권 회수·기기 관리 화면, 버전 출처(APP) 표시.
버전 저장은 기존 `createNoteEditorDtl`(blob: 치환 규칙 동일)을 재사용한다.
