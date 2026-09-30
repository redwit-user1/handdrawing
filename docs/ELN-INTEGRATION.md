# 구노(GOONO) ELN 연계 분석 및 통합 가이드

이 문서는 손글씨 노트(handdrawing)를 기존 구노 ELN에 연계하기 위한 분석 결과,
에디터 쪽에 이미 구현된 연계 인터페이스, 그리고 ELN 쪽에서 개선/추가해야 하는
사항을 정리한다.

## 0. 분석 범위와 전제

- 이 문서는 **실제 저장소 대조를 마친 상태**다: 온프레미스 구축형 구노
  ([Goono-ELN](https://github.com/redwit-dev/Goono-ELN), Spring Boot + Thymeleaf)와
  실제 노트 에디터([NewEditor / editor-ai](https://github.com/redwit-dev/NewEditor),
  Tiptap 기반 standalone 번들)를 직접 분석해 반영했다. 초기 버전에서 일반적인
  제품 구조를 전제로 썼던 항목(특히 시점인증 연계, §2.3·§3-4)은 실제 파이프라인에
  맞게 수정되었다.
- 참고한 사내 자료: 화학 에디터 PoC(chemeditor)의 ELN 요구사항 문서 —
  "노트 본문에 에디터 **임베드**(P0)", "연구노트 **법적 무결성**(전자연구노트
  관리지침, TSA/타임스탬프)", "폐쇄망 온프레미스, 외부 CDN 의존 없음".
  손글씨 에디터도 같은 제약 아래 설계했다.

## 1. 연계 시나리오 비교

| 시나리오 | 설명 | 공수 | 권장도 |
| --- | --- | --- | --- |
| **A1. 에디터 본문 블록** | editor-ai(NewEditor)의 커스텀 노드(`figure[data-strokes]`) + iframe 편집 모달 — 노트 본문 안에 글·손글씨 혼합 | **구현 완료** (editor-ai SDK) | ★ **권장·적용됨** |
| A2. 전면 iframe 페이지 | ELN에 별도 write mode 페이지를 만들어 손글씨 전용 노트로 사용 | ELN 쪽 페이지 + 저장 API | 손글씨 전용 노트 필요 시 |
| B. 첨부파일 워크플로 | 에디터를 별도 페이지로 쓰고 PNG/PDF/JSON을 ELN에 첨부 | 거의 없음 (현재도 가능) | 임시 방편 |
| C. 컴포넌트 이식 | 엔진(engine.js)을 ELN 프런트(React)에 네이티브 포팅 | 큼 (빌드 체계·상태 관리 통합) | 장기 검토 |

**A1안이 적용된 이유**: 구축형 구노의 실제 노트 편집은 editor-ai standalone 번들이
전면 마운트되어 `editor.getHTML()`을 저장하는 구조다. editor-ai의 Tiptap 스키마에는
iframe 노드가 없어(파싱 시 드롭) 본문 임베드는 커스텀 노드로만 가능하고, 이는
Ketcher 화학 구조식(`img[data-molfile]` + 재편집 모달)과 동일한 패턴이다.
editor-ai에 `config.drawingEditorUrl` 옵션·`DrawingImage` 노드·`DrawingModal`
(iframe + postMessage 호스트)이 추가되어, 본 에디터를 정적 자산으로 서빙하기만 하면
본문에 손글씨 블록을 삽입·재편집할 수 있다. 삽입 결과는 용지 비율로 나뉜 페이지
이미지들을 감싼 블록으로 저장되어 노트 HTML → PDF 증적 경로에 이미지로 포함된다:

```html
<figure class="rw-drawing" data-strokes="{…}" data-drawing-sha256="…">
  <img src="/editor-inline-images/…p1.png?noteMno=…" style="display:block;width:100%;…">
  <img src="/editor-inline-images/…p2.png?noteMno=…" style="…">
</figure>
```

초기 버전 형식(`<img data-strokes src=…>` 한 장)도 그대로 읽히며, 재편집 후 삽입하면
새 형식으로 바뀐다.

## 2. 에디터 쪽에 구현되어 있는 연계 인터페이스

### 2.1 임베드 모드

```
<iframe src="https://.../handdrawing/index.html?embed=1"></iframe>
```

- `?embed=1`: localStorage를 쓰지 않고 호스트가 postMessage로 데이터를 관리
  (노트 목록 UI 숨김, 서비스 워커 미등록 — 버전 관리는 호스트 배포를 따름)
- `?readonly=1` 또는 `set-readonly` 메시지: 열람 전용(이동·줌·내보내기·인식만 가능)
- 허용 오리진은 `config.js`의 `embedAllowedOrigins`로 제한
  (기본 null = 동일 오리진만; 교차 도메인 배포 시 ELN 오리진을 명시)

### 2.2 postMessage 프로토콜 (v1)

에디터 → ELN:

| type | payload | 시점 |
| --- | --- | --- |
| `handdrawing:ready` | `version` | 에디터 초기화 완료 (이후 `load`를 보낼 것) |
| `handdrawing:change` | `note{title,strokes,updated}`, `sha256`, `strokeCount`, `baseRev` | 편집 후 400ms 디바운스 |
| `handdrawing:export-result` | `requestId`, `format`, `dataUrl`(png/pdf) · `dataUrls`(png-pages) · `json` 중 하나, 실패 시 `error` | `export` 요청 응답 |

ELN → 에디터:

| type | payload | 용도 |
| --- | --- | --- |
| `handdrawing:load` | `note{title,strokes}` 또는 `null`(새 노트), `rev`(선택) | 저장된 노트 주입 |
| `handdrawing:ack-save` | `rev` | 저장 성공 통지 — 이후 `change.baseRev` 갱신 |
| `handdrawing:set-readonly` | `readonly: boolean` | 열람/편집 전환 |
| `handdrawing:export` | `requestId`, `format: 'png'\|'png-pages'\|'pdf'\|'json'`, `aspect`(png-pages, 선택) | 렌더링 결과 요청 |

**동시 편집 충돌 감지**: `load`에 저장본 리비전 `rev`를 실어 보내면 이후 모든
`change`에 `baseRev`로 되돌아온다. ELN 서버는 저장 시 `baseRev ≠ 현재 리비전`이면
충돌(다른 세션이 먼저 저장)로 처리하고, 저장 성공 시 `ack-save`로 새 리비전을
내려 다음 변경부터 갱신된 `baseRev`가 실리게 한다.

내보내기 형식:

| format | 결과 | 용도 |
| --- | --- | --- |
| `png` | 전체를 한 장 (`dataUrl`) | 미리보기·썸네일 |
| `png-pages` | 페이지 단위로 나눈 여러 장 (`dataUrls`) | **연구노트 본문 삽입(권장)** — `aspect`(세로/가로)로 호스트 용지 본문 비율 지정, 생략 시 A4 본문 비율 |
| `pdf` | A4 여러 페이지 PDF (`dataUrl`) | 단독 증빙 파일 |
| `json` | 획 원본 `{title, strokes}` | 저장·재편집 |

페이지 경계는 각 페이지 아래쪽 25% 안에서 **필기가 없는 가로 여백**을 찾아 자르므로
글씨가 두 페이지에 걸쳐 잘리지 않는다(여백이 없을 만큼 빽빽하면 그 자리에서 자름).
페이지마다 따로 렌더해 해상도도 유지된다 — 한 장으로 내보내면 긴 변 4096px 제한 때문에
세로로 긴 노트일수록 전체 해상도가 떨어진다.

동작하는 호스트 예시: [`examples/eln-host-demo.html`](../examples/eln-host-demo.html)

### 2.3 무결성·증적 지원

- **실제 구노 시점인증 파이프라인과의 관계 (중요)**: 구축형 Goono-ELN의 TSA는
  클라이언트 해시를 받지 않는다. `ElnScheduler`가 1분 주기로 점검완료 노트의
  파일들을 Synap 변환 서버로 **PDF 병합·변환**한 뒤, 그 **PDF를 Amano TSA에
  전달**하고 PDF의 SHA-256을 **서버가 직접 계산·저장**한다. 즉 법적 증적의
  단위는 서버 생성 PDF다. 따라서 손글씨 내용이 증적에 포함되려면 노트 HTML 안에
  렌더된 PNG(`<img>`)로 존재해야 하며, A1 통합(본문 블록)이 정확히 이 조건을
  만족한다.
- **`change`/블록의 `sha256`**: `{title, strokes}` 정규화 JSON의 SHA-256.
  TSA 입력이 아니라 **보조 감사 메타데이터**다 — 획 원본(`data-strokes`)이
  사후 수정되지 않았는지 검증하는 용도로 블록 속성(`data-drawing-sha256`)에
  함께 저장된다. (Web Crypto 사용 — HTTPS/localhost 필수, 아니면 null)
- **획 단위 작성 시각**: 모든 획에 `t`(epoch ms)가 기록되어 작성 과정의
  감사 추적(audit trail)이 가능하다. 해시 대상에 포함되므로 사후 조작하면
  해시가 달라진다.
- **결정적 PDF/PNG 렌더링**: 콘텐츠 경계 기반 렌더링이라 동일 데이터는 동일
  이미지가 나온다. 연구노트 PDF 증빙 생성에 사용.

### 2.4 데이터 스키마

```jsonc
// note (load/change/export json에서 공통)
{
  "title": "실험 스케치 #42",
  "strokes": [
    { "tool": "pen",          // pen | highlighter | shape
      "color": "#1f2328",
      "size": 5,
      "t": 1770000000000,     // 작성 시각 (epoch ms)
      "points": [[x, y, pressure], ...] },   // 월드 좌표, 소수 2자리
    { "tool": "shape", "shape": "rect",       // line | arrow | rect | ellipse
      "color": "#2563eb", "size": 5, "t": 1770000000000,
      "points": [[x0, y0], [x1, y1]] },
    { "tool": "image",                        // 삽입된 이미지 (실험 사진 등)
      "src": "data:image/jpeg;base64,...",    // 긴 변 1600px 이하로 축소 저장
      "size": 0, "t": 1770000000000,
      "points": [[x0, y0], [x1, y1]] }        // 배치 사각형 (월드 좌표)
  ]
}
```

버전 마이그레이션을 위해 ELN 저장 시 `schemaVersion: 1`을 함께 저장할 것을 권장.

## 3. ELN 쪽 현황과 남은 확인/개선 사항 (실코드 대조 결과)

**추가 개발 없이 이미 충족되는 것** (A1 통합 기준):

- **손글씨 블록 타입 / 호스트 컴포넌트** — editor-ai에 `DrawingImage` 노드와
  `DrawingModal`(iframe postMessage 호스트)로 구현 완료. ELN은 standalone 번들
  교체 + `config.drawingEditorUrl` 한 줄로 활성화된다
  (`note_details_editor.html` 반영).
- **저장/버전 보존** — 블록이 노트 HTML에 포함되므로 기존
  `/api/eln/note/editor/saveEditor`가 그대로 처리한다. 저장마다 새 HTML 파일 +
  에디터 이력 행을 만드는 기존 구조가 "덮어쓰기 금지·버전 체인" 요건을 충족.
- **PDF 증적 포함** — 손글씨가 페이지 단위 PNG `<img>`로 본문에 존재하므로 기존
  노트 → Synap PDF 변환 → Amano TSA 경로에 포함된다. 긴 필기도 쪽마다 한 장씩
  A4 페이지에 맞춰 들어간다 (아래 1번의 변환 사본 처리와 함께 동작).
- **프레이밍 보안** — 같은 오리진 서빙(`/lib/handdrawing/`) +
  `X-Frame-Options: sameOrigin` + `embedAllowedOrigins` 기본값(동일 오리진)이
  그대로 맞물린다. 추가 설정 불요.

**남은 확인/개선 사항 (우선순위순)**:

1. ~~Synap 변환 시 본문 이미지 누락~~ — **수정됨, 실 Synap 1회 확인 필요**:
   저장된 노트 HTML의 이미지 주소는 `/editor-inline-images/…?noteMno=…`(호스트 없는
   경로 + 로그인 세션 필요)인데 Synap은 HTML을 **로컬 파일 경로**로 받아 변환한다.
   파일 기반 변환에서는 이 주소를 해석할 기준도 세션도 없어 이미지가 빠진다 —
   Chromium으로 같은 조건을 재현하면 이미지 0/3 로드. 이는 손글씨뿐 아니라 **기존
   웹에디터 본문 이미지 전체**에 해당하는 문제였다.
   Goono-ELN `SynapViewerService.getSynapParam`(시점인증 스케줄러·미리보기 공통 경로)이
   이제 HTML이면 이미지를 디스크에서 읽어 **data URI로 내장한 변환용 사본**을 만들어
   Synap에 넘긴다 (`EditorHtmlImageInliner`, 원본 HTML은 그대로). 손글씨 블록이 있으면
   구형 변환기용 페이지 나눔 규칙(`page-break-inside`)도 `<style>`로 넣는다. 재현
   조건에서 이미지 3/3 로드, A4 3쪽에 쪽마다 한 장.
   **남은 확인**: 실제 Synap이 data URI 이미지를 렌더하는지 한 번 확인할 것
   (점검완료 노트 1건의 시점인증 PDF에 이미지가 나오는지). 안 나오면
   `synap.properties`의 `synap.editor.inline.image.mode=file`(같은 파일시스템일 때,
   `file://` 절대경로)로 바꾸고, 문제가 생기면 `none`으로 기존 동작 복귀.
2. ~~PNG를 파일 업로드 경로로 전환~~ — **완료**: editor-ai `insertDrawing`이
   호스트 `onImageUpload`가 있으면 PNG를 파일로 업로드해(ELN에서는 blob: URL →
   저장 시 인라인 이미지 파일) 본문 HTML 크기를 줄인다. 업로드 실패 시 data URL
   폴백. 획 JSON(`data-strokes`)은 여전히 본문 속성에 남으므로, 사진을 많이
   포함한 초대형 노트는 추후 획 JSON 별도 저장(프로토콜 v2)과 함께 검토.
3. ~~권한 매핑 일관성~~ — **완료**: ELN 에디터 페이지가 읽기 권한이면
   `editor.setReadOnly(true)`로 뷰어 모드 전환(손글씨 모달 포함 편집 표면 전체가
   `editable` 게이트로 잠김). 읽기 전용 열람자도 본문 인라인 이미지를 볼 수
   있도록 이미지 조회 엔드포인트 권한을 쓰기(hasWritable) → 조회(hasReadable)
   기준으로 완화.
4. **필기 인식 서버 공용화 (선택)** — 폐쇄망 고객사에서 필기 인식이 필요하면
   [`server/recognizer/`](../server/recognizer/)(PaddleOCR 기반 무료 참조 구현,
   Docker 이미지에 모델 포함)를 ELN 서버 옆에 띄우고, ELN 리버스 프록시의
   `/api/recognize`로 노출한 뒤 `config.js`의 `recognizerEndpoint`로 지정한다.
   같은 오리진이 되므로 CORS 설정이 필요 없고, iPad Safari 사용자도 이 경로로
   인식 가능.
5. **교차 오리진 배포 시에만** — 에디터를 별도 오리진에 두는 경우 ELN
   `frame-src`(CSP 도입 시)에 에디터 오리진 추가 + `embedAllowedOrigins`에
   ELN 오리진 명시(양방향 화이트리스트).

**Synap 대체 변환 서버(pdf-viewer-server) 호환성** — `redwit-dev/PDF`
`claude/pdf-viewer-replacement-f4ubgl` 기준으로 점검(2026-09-28):

- 새 서버는 Synap과 같은 `file{i}_type=Local` 계약으로 받은 `.html`을 Gotenberg
  **LibreOffice** 경로로 변환한다(Chromium은 URL로 받은 HTML에만 사용).
- 저장본 HTML을 그대로 넘기면 LibreOffice에서도 본문 이미지가 **0개** — Synap 때의
  누락이 새 서버에도 그대로 있다. 변환 사본(이미지 내장)이 필요하다.
- LibreOffice는 CSS `width:100%`를 무시하고 HTML `width`/`height` 속성만 따라, 속성이
  없으면 쪽 이미지가 원래 픽셀 크기로 놓여 잘린다. 변환 사본이 이미지 실제 크기로 계산한
  `width="620" height="…"`를 넣도록 수정해 LibreOffice·Chromium 모두 A4 3쪽 정상.
- 변환 시간 1.6~2.1초(구노 10초 소켓 타임아웃 이내), 사본 3.2MB(한도 100MB), 사본
  경로는 파일 저장소 루트 아래라 허용 루트 안.
- `synap.editor.inline.image.mode=file`은 새 서버에서 쓸 수 없다(Gotenberg에는 파일
  내용만 전달). 기본값 `data` 유지.
- Goono-ELN 병합: `SynapViewerService.java` 한 곳 충돌(양쪽이 인접 위치에 추가,
  둘 다 유지하면 됨). 인라인 이미지 권한·보안 설정은 자동 병합.
- pdf-viewer(뷰어) 결함 2건 발견 — 손글씨와 무관, 그쪽 브랜치에서 수정 필요:
  ① pdf.js 6.3에서 없어진 `PDFDocumentProxy.destroy()`를 호출해 문서 교체·닫기마다
  오류와 누수(한 번 걸러 빈 화면), ② 첫 문서를 여는 도중 교체하면 이전 문서 쪽이 섞임.
  수정안(`loadingTask.destroy()` + 렌더별 쪽 묶음)으로 그쪽 테스트 0 실패·뷰어 검증 PASS.

**A2(전면 iframe 페이지)로 확장할 경우에만** 저장 API·손글씨 전용 write mode가
추가로 필요하며, 그때는 400ms `change`마다 저장하지 말고 ELN의 기존 autosave
주기(분 단위)·수동 저장에 맞춰 **호스트가 버퍼링**해야 한다 (저장 1회 = 파일
1개 + 버전 1개인 구조라 change마다 저장하면 파일이 폭증한다).

## 4. 에디터 쪽 개선 항목 진행 현황

- ✅ **editor-ai(NewEditor) 본문 블록 통합**: `DrawingImage` 노드 +
  `DrawingModal`(iframe postMessage 호스트) + `config.drawingEditorUrl` 옵션.
  삽입 시 json export(디바운스 무관 최신 획) + png-pages export(에디터 용지 본문
  비율 × 0.95)를 받아 `figure[data-strokes][data-drawing-sha256]` 안에 페이지
  이미지들로 저장, 더블클릭 재편집.
  구축형 구노에는 standalone 번들 교체 + 정적 자산(`/lib/handdrawing/`) 배치로
  적용됨.
- ✅ **A4 페이지 분할 내보내기**: `png-pages` 형식과 A4 여러 페이지 PDF.
  필기 없는 가로 여백에서 자르고, 페이지별 렌더로 해상도 유지 (§2.2).
- ✅ **동시 편집 충돌 감지**: `rev`/`baseRev`/`ack-save` 프로토콜 구현 (§2.2).
  서버 쪽 충돌 판정·잠금 정책은 ELN 몫.
- ✅ **이미지 삽입**: 파일 선택·클립보드 붙여넣기로 실험 사진을 노트에 넣고
  위에 주석 필기 가능. 긴 변 1600px로 축소 저장, 올가미로 이동/삭제,
  지우개는 이미지를 지우지 않음(주석만 지워짐), PNG/PDF 내보내기에 포함.
- ✅ **서버 저장 어댑터**: `config.js`의 `apiBase` 설정 시 단독 실행 모드에서
  localStorage 캐시 + REST 서버(`GET/PUT/DELETE {apiBase}/notes`) 동시 저장.
  서버 장애 시 로컬 저장으로 자동 유지.
- ⬜ **대용량 노트 증분 전송**: 획 수천 개 이상이면 postMessage 페이로드가
  커진다. 필요 시 추가/삭제된 획만 보내는 프로토콜 v2로 확장 (현재는 이미지
  포함 노트도 수 MB 수준까지는 문제없음).

## 5. 페이지 노트와 글상자 (태블릿 앱)

태블릿 앱(`app/`)은 무한 캔버스 대신 **페이지 노트**를 쓴다. 같은 엔진(`js/engine.js`)의 기능이라 웹 손글씨 편집기에서도 그대로 열린다.

- 노트 JSON에 `layout`이 추가된다: `{ "type": "pages", "pageW": 720, "pageH": 1068, "gap": 28, "date": "2026-09-29" }`
  (`pageH/pageW` = A4 본문 비율 267/180). `layout`이 있으면 엔진은 페이지를 세로로 잇고, 모눈·머리글(제목 / `날짜 · N쪽`)을
  그리며, `png-pages` 내보내기는 **보이는 페이지 그대로**(필기가 있는 마지막 쪽까지) 자른다. `aspect` 인자는 무시한다.
- 글상자: `{ "tool": "text", "text": "…", "fontSize": 18, "color": "…", "t": …, "points": [[x0,y0],[x1,y1]] }`.
  글상자 도구(`t`)로 누른 곳에 만들고, 누르면 다시 고친다. 올가미로 옮기고 지우며, 지우개로는 지워지지 않는다(이미지와 같음).
- 브리지: `handdrawing:load`의 `note.layout`을 받아 페이지 모드로 열고, `json` 내보내기·`handdrawing:change`에 `layout`을 싣는다.
  editor-ai `DrawingModal`은 `layout`이 있으면 `data-strokes`에 함께 보존한다(없으면 기존 `{title, strokes}` 그대로).
- 페이지 이미지 대체 텍스트는 `손글씨 N/M쪽`.

### 5.1 삽입 객체 (태블릿 앱 "+ 넣기")

모두 노트 JSON(`data-strokes`)의 `strokes` 안에 원본과 함께 들어가고, 페이지 PNG 에는 그림으로 찍힌다. 올가미로 옮기고 지우며 지우개로는 지워지지 않는다.

| 종류 | 형식 |
|---|---|
| 표 | `{ "tool": "table", "rows": 4, "cols": 3, "header": true, "cells": [["시료","온도(℃)",…],…], "colW": […], "rowH": […], "points": [[x0,y0],[x1,y1]] }` — 칸 선과 칸 글을 엔진이 그린다(웹 손글씨 편집기에서도 보인다) |
| 수식 | `{ "tool": "image", "kind": "math", "latex": "x=\\frac{…}", "src": "data:image/svg+xml;base64,…", "points": … }` (MathJax SVG) |
| 화학식 | `{ "tool": "image", "kind": "ce", "ce": "2H2 + O2 -> 2H2O", "src": …svg }` (mhchem) |
| 구조식 | `{ "tool": "image", "kind": "chem", "molfile": "…M  END", "smiles": "…", "src": …svg }` (Ketcher) |
| 날짜·시각 | 글상자(`tool: "text"`) |

웹 손글씨 편집기는 이 객체들을 그리고 옮길 수 있지만 내용 고치기(표 칸 글·수식 원문 등)는 앱에서만 한다.
