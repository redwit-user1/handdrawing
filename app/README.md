# 구노 연구노트 태블릿 앱

iPad·갤럭시 탭에서 **오프라인으로 연구노트를 작성**하고, 연결될 때 **구노 전자연구노트(ELN)로 단방향 동기화**하는 앱.
Capacitor 8 + React 19 + TypeScript. 편집기는 웹 구노와 같은 editor-ai(손글씨는 handdrawing)를 앱에 내장한다.

- 동기화 계약(서버 구현 기준): [`docs/SYNC-API.md`](docs/SYNC-API.md)
- 모의 서버(개발·E2E용): [`mock-server/server.mjs`](mock-server/server.mjs)

## 동작 방식

| 항목 | 규칙 |
|---|---|
| 편집 위치 | 노트마다 하나(이 기기 또는 웹). 앱에서 만든 노트는 만든 기기가 편집 위치. 동시 편집 없음 |
| 작업본 | 편집 중 0.8초마다 기기에 암호화 저장. 서버로는 가지 않음 |
| 버전 | 서버로 올라가는 단위(전체 스냅숏). "버전 저장", 노트를 떠날 때, 앱이 백그라운드로 갈 때, 5분마다 자동 |
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
# 0) 편집기 번들 (NewEditor 저장소, 같은 상위 폴더에 있다고 가정)
cd ../../NewEditor && npm install && npm -w @redwit/editor-ai run build:standalone
# 다른 위치면 NEWEDITOR_STANDALONE_DIR=/path/to/dist/standalone

# 1) 앱
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

E2E 시나리오: 로그인 → 온라인 새 노트 → **오프라인에서 글+손글씨 작성·버전 저장** → 저장소 암호화 확인 →
오프라인 재시작 후 복원 → 웹 점검 요청 거부 → 온라인 복귀 자동 동기화(손글씨 이미지 포함) → 작성 완료·반납 →
편집권 회수 후 미반영 보관 → 새 노트로 복원 → 오프라인 기한 만료 잠금 → 재로그인 후 대기 기록 업로드 → 기기 폐기 잠금.
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

## 배포 (고객 기관 내부용)

- **iPad**: Apple Business Manager **Custom App**(기관 지정 비공개 배포). 앱 심사는 거치며, 고객 기관 ABM에 배정 → 기관 MDM으로 설치.
  Enterprise(In-House) 프로그램은 자사 직원용이라 고객 기관 배포에 쓸 수 없다.
- **갤럭시 탭**: 서명한 APK/AAB를 기관 MDM(Knox Manage 등) 또는 Managed Google Play 비공개 앱으로 배포.
- 앱 ID `kr.redwit.goono.note`. 서버 주소는 로그인 화면에서 기관별로 입력(MDM 관리형 설정으로 미리 채우는 것은 후속).

## 실기기에서 확인할 것 (에뮬레이션으로 검증 못 한 부분)

- iOS WKWebView(`capacitor://localhost`)에서 손글씨 iframe postMessage — 오리진이 `null`로 보이는 경우를 대비해
  handdrawing `bridge.js`·editor-ai `DrawingModal`을 보강해 두었다(부모 창·자기 iframe에서 온 메시지만 처리).
- Apple Pencil·S Pen 필압/손바닥 무시(handdrawing 엔진은 PointerEvent 기반으로 웹에서 검증됨).
- 구노 서버가 기관 내부망(사설 IP)일 때 WebView의 로컬 네트워크 접근 정책(Chromium LNA) — E2E에서는 헤드리스 검사를 껐다.
- 키체인/키스토어 키 보존: 앱 삭제 후 재설치 시 키가 사라지면 기기 데이터는 복구 불가(설계상 의도, 원본은 서버).

## 구노 ELN 쪽 남은 일

`docs/SYNC-API.md`의 서버 구현: 기기 토큰 필터 체인(웹 세션과 분리), `/api/app/v1/*`, 편집 위치 컬럼과
웹 에디터 읽기 전용 표시, **편집 위치가 기기인 노트의 점검 요청 거부**, 편집권 회수·기기 관리 화면, 버전 출처(APP) 표시.
버전 저장은 기존 `createNoteEditorDtl`(blob: 치환 규칙 동일)을 재사용한다.
