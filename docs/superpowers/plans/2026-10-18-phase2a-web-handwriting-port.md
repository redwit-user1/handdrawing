# 2A단계 — 웹 손글씨·Synap 이미지 수정 `main` 이식 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Goono-ELN `main`의 웹 에디터에서 손글씨 블록(태블릿 앱 페이지 노트 포함)을 보고·편집할 수 있게 하고, Synap PDF 변환(시점인증·미리보기)에서 본문 이미지와 손글씨가 빠지지 않게 한다.

**Architecture:** KBSI 계열 브랜치(`claude/handwriting-editor-integration-check-ktdg1j`)의 웹 손글씨 작업을 **복사하지 않고 다시 얹는다.** editor-ai는 redwit-editor 최신 `main`에 손글씨 커밋 5개를 이식해 새로 빌드하고, Goono-ELN에는 그 빌드 결과·handdrawing 정적 파일·템플릿 두 줄·권한 한 줄·Synap 이미지 내장기(파일 저장소 추상화 사용)를 넣는다.

**Tech Stack:** redwit-editor(React 19 + Tiptap 3 + Vite, npm workspaces), Goono-ELN(Java 8, Spring Boot 2.7, Thymeleaf, jsoup 1.18.3, tika-core), handdrawing(순수 JS).

**Spec:** `handdrawing/docs/superpowers/specs/2026-10-17-goono-tablet-app-design.md` §7.0(이식 표), §7.3(Synap 설정 기관에서도 손글씨 표시). 2B(서버 기기 API)·2C(앱 QR 연결)는 별도 계획.

**저장소/브랜치:** redwit-editor `/home/user/redwit-editor`, Goono-ELN `/home/user/Goono-ELN` — 둘 다 브랜치 `claude/tablet-app-hand-drawing-sync-ofo0oi`. redwit-editor 브랜치는 현재 `origin/main`(edf6d03)과 같다.

## Global Constraints

- **번들은 복사 금지.** `src/main/resources/static/lib/standalone/`은 redwit-editor `main` + 손글씨 커밋 5개(fc1a56c, 8563f9c, 153efc8, d7dea5b, 80b897d)로 **새로 빌드한 결과로 통째 교체**한다. KBSI 번들을 쓰면 `main`의 다국어(i18n)·표·이미지 수정이 사라진다.
- editor-ai에 새로 생기는 화면 문구는 `t()`를 거치고 `i18n.ts`의 `EN` 표에 영문을 넣는다.
- `config.drawingEditorUrl`가 비어 있으면 손글씨 UI(툴바 펜 버튼, `/손글씨` 슬래시 항목)는 보이지 않는다(다른 호스트 영향 없음).
- handdrawing 정적 파일은 handdrawing 저장소 같은 브랜치 HEAD의 `index.html, styles.css, config.js, sw.js, manifest.webmanifest, icon.svg, apple-touch-icon.png, js/app.js, js/bridge.js, js/engine.js, js/pdf.js, js/recognize.js, js/store.js` 13개를 **바이트 그대로** `src/main/resources/static/lib/handdrawing/`에 둔다. `config.js`는 수정하지 않는다(`embedAllowedOrigins: null` = 같은 오리진만).
- `EditorHtmlImageInliner`는 이미지를 **`FileManager`로 읽는다**(일부 기관은 `sftpFileManagerImpl`) — 로컬 디스크 경로를 직접 읽지 않는다. 기본 모드 `synap.editor.inline.image.mode=data`.
- 내장기는 어떤 실패에도 원본 HTML로 돌아간다(변환 자체를 막지 않는다).
- Java 8 문법. Goono-ELN 전체 빌드는 이 환경에서 불가(사설 패키지 401) — `./gradlew` 실행 금지.

## 검증 방법 (이 환경)

- redwit-editor: `cd /home/user/redwit-editor && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci`, 타입 검사 `npx tsc -p packages/editor-ai/tsconfig.json --noEmit`, 빌드 `npm -w @redwit/editor-ai run build:standalone` (출력 `packages/editor-ai/dist/standalone/`). `NODE_OPTIONS=--max-old-space-size=8192`는 이미 설정됨.
- 내장기 테스트: JUnit 5 + jsoup 1.18.3 + tika-core(버전은 Goono-ELN `build.gradle`의 값) jar를 Maven Central에서 받아 scratch에서 `javac --release 8`로 실행. `FileManager`는 private jar 소속이라 scratch에 최소 스텁만 둔다(커밋 금지).
- 화면 스모크: Playwright(크로미움 `/opt/pw-browsers/chromium`)로 scratch 정적 서버에서 Goono-ELN에 복사된 번들·handdrawing을 실제 경로(`/lib/standalone/…`, `/lib/handdrawing/index.html`)로 띄워 확인. 스모크 스크립트는 scratch에 둔다(커밋 금지).
- scratch: `/tmp/claude-0/-home-user/615930a9-68d3-5bf4-b298-ba4142d5287c/scratchpad/`.

## Review Focus

1. **손글씨 없는 기존 노트**가 새 번들에서 이전과 똑같이 열리고 저장된다(다국어 문구, 표·이미지 동작 유지) — Task 3 스모크 `plainNoteRoundTrip`.
2. **태블릿 앱이 올린 페이지 노트**(`figure.rw-drawing[data-strokes][data-drawing-sha256]` 안에 페이지 `<img>` 여러 장)를 열면 페이지 이미지가 보이고, 손대지 않고 다시 저장해도 `data-strokes`·`data-drawing-sha256`이 바이트 그대로 남는다(안 그러면 재저장 때 획이 사라짐) — Task 3 스모크 `drawingBlockSurvivesResave`.
3. **읽기 권한 사용자**(점검자, 편집 불가 프로젝트)는 손글씨 이미지를 볼 수 있지만(본문 이미지 GET이 `hasReadable`) 편집기는 읽기 전용이고 손글씨 편집 창을 열 수 없다 — Task 3 스모크 `readOnlyCannotOpenDrawing` + 컨트롤러 한 줄 검토.
4. **Synap 변환 중 본문 이미지 파일이 없거나 `FileManager`가 예외**를 내도 원본 HTML로 변환이 진행된다(시점인증이 통째로 실패하지 않음) — Task 2 `missingImageFallsBackToOriginal`, `loaderExceptionFallsBackToOriginal`.
5. **여러 쪽 손글씨**의 PDF에서 한 페이지 이미지가 쪽 경계에서 잘리지 않고(page-break 규칙), 이미지 폭이 620px로 제한된다 — Task 2 `drawingAddsPageBreakStyle`, `widthCappedAt620`.

---

### Task 1: redwit-editor — 손글씨 커밋 5개를 최신 `main`에 이식하고 번들 빌드

**Files (redwit-editor):**
- Create: `packages/editor-ai/src/DrawingImage.ts`, `packages/editor-ai/src/DrawingModal.tsx` (KBSI 커밋에서 가져와 `main`에 맞춤)
- Modify: `packages/editor-ai/src/EditorAI.tsx`, `SlashMenu.ts`, `Toolbar.tsx`, `Icons.tsx`, `config.ts`, `index.ts`, `styles.css`, `types.ts`, `i18n.ts`, `README.md`, `docs/integration-guide.md`

**Interfaces:**
- Produces: 번들 `packages/editor-ai/dist/standalone/{editor-ai.standalone.js, style.css, chunks/*, assets/*}`; 공개 설정 `config.drawingEditorUrl?: string`; 노드 직렬화 형식 `<figure class="rw-drawing" data-strokes="{title,strokes,layout}" data-drawing-sha256="…"><img …>…</figure>`(80b897d 형식, 대체 텍스트 "손글씨 n/m쪽"); `handle.setReadOnly(boolean)`(기존, 유지).

- [ ] **Step 1: 이식** — `git cherry-pick fc1a56c 8563f9c 153efc8 d7dea5b 80b897d`(redwit-editor `origin/claude/handwriting-editor-integration-check-ktdg1j`의 커밋; 먼저 `git fetch origin claude/handwriting-editor-integration-check-ktdg1j`). 충돌 예상: `EditorAI.tsx` 4곳, `SlashMenu.ts` 2곳, `Toolbar.tsx` 4곳. 해결 원칙: `main`의 코드(i18n `t()`, 바뀐 `openMath` 시그니처, 표·이미지 수정)를 살리고 손글씨 추가분만 얹는다. 새 문구(툴바 펜 버튼 툴팁, 슬래시 항목 "손글씨", 모달 제목·버튼, 대체 텍스트)는 `t('…')`로 감싸고 `i18n.ts` `EN` 표에 영문 추가.
- [ ] **Step 2: 타입 검사** — Run: `npx tsc -p packages/editor-ai/tsconfig.json --noEmit` → Expected: 오류 0.
- [ ] **Step 3: 빌드** — Run: `npm -w @redwit/editor-ai run build:standalone` → Expected: 성공, `dist/standalone/editor-ai.standalone.js` 존재. 확인: `grep -c "rw-drawing" dist/standalone/editor-ai.standalone.js` ≥ 1, `grep -c "drawingEditorUrl"` ≥ 1, `ls dist/standalone/chunks | grep -c i18n` ≥ 1(다국어 유지).
- [ ] **Step 4: Commit + 보고** — 충돌 해결이 들어간 커밋은 메시지에 "main 기준으로 충돌 해결"을 적는다. `dist/`는 `.gitignore` 대상이라 커밋하지 않는다(Task 3가 빌드 결과를 Goono-ELN에 복사).

### Task 2: Goono-ELN — Synap 변환용 본문 이미지 내장기 (파일 저장소 추상화)

**Files (Goono-ELN):**
- Create: `src/main/java/so/goono/eln/com/pdf/service/EditorHtmlImageInliner.java`
- Modify: `src/main/java/so/goono/eln/com/pdf/service/SynapViewerService.java:473-481`(`getSynapParam`의 `diskFullPath`), `src/main/resources/config/synap.properties`
- Test: `src/test/java/so/goono/eln/com/pdf/service/EditorHtmlImageInlinerTest.java`

**Interfaces:**
- Produces:
  - `public final class EditorHtmlImageInliner { public interface ImageLoader { byte[] load(String inlineImagePath) throws IOException; } public static Result inline(String html, String mode, ImageLoader loader); public static final int MAX_IMAGE_WIDTH_PX = 620; public static final class Result { public final String html; public final int inlined; public final int missing; public final int sized; public final boolean changed; } }` — `mode`는 `data`(data URI로 내장) | `none`(그대로). KBSI 2e507ea10·0ad7f510d의 로직(`/editor-inline-images/…` src → data URI, `figure.rw-drawing`이 있으면 page-break `<style>` 추가, width/height 부여·620px 제한, 실패 시 원본)을 그대로 따르되 디스크 읽기를 `loader`로 바꾼다. `file` 모드는 넣지 않는다(pdf-viewer-server에서 동작 안 함).
  - `SynapViewerService`: `prepareLocalFileForSynap(FileDtlVO)`가 HTML 파일이면 `FileManager`로 읽어 `EditorHtmlImageInliner.inline(...)` 후 `<root>/synap-html/data/<sha256>.html` 사본을 쓰고 그 경로를 돌려준다. 이미지 로더는 `ElnNoteEditorController.getAttachment`가 `/editor-inline-images/{*filePath}`를 읽는 것과 **같은 디렉터리·이름 규칙**으로 `fileManager.readFile(dir, name)`을 호출한다. HTML이 아니거나 변경이 없으면 원래 경로.
  - `synap.properties`: `synap.editor.inline.image.mode=data` + 주석(`none`이면 끔).

- [ ] **Step 1: 실패하는 테스트 작성** — KBSI의 `EditorHtmlImageInlinerTest`(206줄)를 옮기되 `@TempDir` 디스크 대신 메모리 `ImageLoader`(Map) 사용. 반드시 포함: `inlinesEditorImageAsDataUri`, `missingImageFallsBackToOriginal`(로더가 `NoSuchFileException`), `loaderExceptionFallsBackToOriginal`(로더가 `RuntimeException`), `drawingAddsPageBreakStyle`, `widthCappedAt620`(1240px PNG → width=620, height 비례), `existingWidthRespected`, `noneModeReturnsOriginal`, `externalImageUntouched`(http/data src는 건드리지 않음), `pathTraversalRejected`(`/editor-inline-images/../x` → 로더 호출 안 함).
- [ ] **Step 2: 실패 확인** — scratch에서 jsoup/tika/JUnit jar로 컴파일 → Expected: 클래스 없음 컴파일 오류.
- [ ] **Step 3: 구현** — 위 Interfaces. 로더 예외·이미지 해석 실패는 모두 해당 이미지만 원본 유지 + `missing` 증가, HTML 파싱 실패는 원본 HTML 반환.
- [ ] **Step 4: 통과 확인** — Expected: 전부 통과.
- [ ] **Step 5: `SynapViewerService` 연결** — `getSynapParam`의 `diskFullPath`를 `prepareLocalFileForSynap(fileDtl)`로. 로그는 KBSI처럼 inlined/missing/sized 개수(정보 수준). 미리보기·시점인증(`ElnNoteTimestampJobService`) 둘 다 이 경로를 탄다.
- [ ] **Step 6: Commit** — `git commit -m "fix: Synap PDF 변환 시 웹에디터 본문 이미지·손글씨 내장 (파일 저장소 추상화 사용)"`

### Task 3: Goono-ELN — 손글씨 정적 파일·새 번들·템플릿·권한

**Files (Goono-ELN):**
- Create: `src/main/resources/static/lib/handdrawing/**` (13개, Global Constraints 목록)
- Replace (통째): `src/main/resources/static/lib/standalone/**` ← redwit-editor `packages/editor-ai/dist/standalone/**` (Task 1 결과; 참조 안 되는 옛 chunk 8개도 함께 사라짐)
- Modify: `src/main/resources/templates/basic/eln/note/note_details_editor.html` (options 60-66 근처, `isAutoSave` 94 근처), `src/main/java/so/goono/eln/note/controller/ElnNoteEditorController.java:99`

**Interfaces:**
- Consumes: Task 1 번들, `drawingEditorUrl` 설정, `handle.setReadOnly`.
- Produces: 편집 창 URL `/lib/handdrawing/index.html`(같은 오리진 iframe).

- [ ] **Step 1: 파일 배치** — handdrawing 13개 복사(`md5sum`으로 원본과 일치 확인), `lib/standalone` 디렉터리를 비우고 Task 1 `dist/standalone/` 내용으로 채움.
- [ ] **Step 2: 템플릿** — `options`에 `config: { drawingEditorUrl: /*[[@{/lib/handdrawing/index.html}]]*/'/static/lib/handdrawing/index.html' }` 추가(KBSI 897f1d32d 형태). 에디터 생성 뒤 `if (notePermission === readPermission) { editor.setReadOnly(true); }`(KBSI c21c03979 의미, `main`의 현재 구조에 맞춰 `readPermission` 선언 이후 위치).
- [ ] **Step 3: 권한** — `getAttachment`의 `@PreAuthorize`를 `hasWritable(#noteMno)` → `hasReadable(#noteMno)`(`ElnPermissionService.hasReadable`은 `main`에 이미 있음, 196행).
- [ ] **Step 4: 화면 스모크(scratch, 커밋 금지)** — 정적 서버로 Goono-ELN의 `static/` 아래를 `/lib/...` 경로에 띄우고, `note_details_editor.html`과 같은 방식(`new RedwitEditorAI(id, options)`)으로 마운트하는 최소 페이지에서 Playwright로:
  - `plainNoteRoundTrip`: 표·이미지가 있는 기존 형식 HTML을 넣고 `getContent()`가 의미상 같은 HTML(표 행·열 수, img src 동일)이고 콘솔 오류 0.
  - `drawingBlockSurvivesResave`: 태블릿 앱 형식 figure(페이지 img 2장, data-strokes에 layout 포함, data-drawing-sha256)를 넣으면 img 2장이 보이고, 편집 없이 `getContent()`한 결과에서 `data-strokes`·`data-drawing-sha256` 값이 입력과 바이트 동일.
  - `drawingEditorOpens`: 쓰기 모드에서 펜 버튼 클릭 → `/lib/handdrawing/index.html` iframe이 뜨고 `handdrawing:ready` 메시지 수신.
  - `readOnlyCannotOpenDrawing`: `setReadOnly(true)` 후 펜 버튼·슬래시 메뉴 없음, 블록 더블클릭해도 iframe 안 뜸.
  - `noDrawingUrlHidesPen`: `drawingEditorUrl` 없이 마운트하면 펜 버튼 없음.
  결과(통과/실패, 콘솔 오류)를 보고에 붙인다.
- [ ] **Step 5: Commit** — 두 커밋으로: `feat: 웹에디터 손글씨 블록 — handdrawing 정적 파일과 editor-ai 번들 재빌드(main 기준)`, `fix: 읽기 권한 사용자도 본문 이미지를 보고 에디터는 읽기 전용`.
