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
| **A1. 에디터 본문 블록** | editor-ai(NewEditor)의 커스텀 노드(`img[data-strokes]`) + iframe 편집 모달 — 노트 본문 안에 글·손글씨 혼합 | **구현 완료** (editor-ai SDK) | ★ **권장·적용됨** |
| A2. 전면 iframe 페이지 | ELN에 별도 write mode 페이지를 만들어 손글씨 전용 노트로 사용 | ELN 쪽 페이지 + 저장 API | 손글씨 전용 노트 필요 시 |
| B. 첨부파일 워크플로 | 에디터를 별도 페이지로 쓰고 PNG/PDF/JSON을 ELN에 첨부 | 거의 없음 (현재도 가능) | 임시 방편 |
| C. 컴포넌트 이식 | 엔진(engine.js)을 ELN 프런트(React)에 네이티브 포팅 | 큼 (빌드 체계·상태 관리 통합) | 장기 검토 |

**A1안이 적용된 이유**: 구축형 구노의 실제 노트 편집은 editor-ai standalone 번들이
전면 마운트되어 `editor.getHTML()`을 저장하는 구조다. editor-ai의 Tiptap 스키마에는
iframe 노드가 없어(파싱 시 드롭) 본문 임베드는 커스텀 노드로만 가능하고, 이는
Ketcher 화학 구조식(`img[data-molfile]` + 재편집 모달)과 동일한 패턴이다.
editor-ai에 `config.drawingEditorUrl` 옵션·`DrawingImage` 노드·`DrawingModal`
(iframe + postMessage 호스트)이 추가되어, 본 에디터를 정적 자산으로 서빙하기만 하면
본문에 손글씨 블록을 삽입·재편집할 수 있다. 삽입 결과는
`<img src="data:image/png..." data-strokes="{…}" data-drawing-sha256="…">`로
저장되어 노트 HTML → PDF 증적 경로에 이미지로 포함된다.

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
| `handdrawing:export-result` | `requestId`, `format`, `dataUrl`(png/pdf) 또는 `json`, 실패 시 `error` | `export` 요청 응답 |

ELN → 에디터:

| type | payload | 용도 |
| --- | --- | --- |
| `handdrawing:load` | `note{title,strokes}` 또는 `null`(새 노트), `rev`(선택) | 저장된 노트 주입 |
| `handdrawing:ack-save` | `rev` | 저장 성공 통지 — 이후 `change.baseRev` 갱신 |
| `handdrawing:set-readonly` | `readonly: boolean` | 열람/편집 전환 |
| `handdrawing:export` | `requestId`, `format: 'png'\|'pdf'\|'json'` | 렌더링 결과 요청 |

**동시 편집 충돌 감지**: `load`에 저장본 리비전 `rev`를 실어 보내면 이후 모든
`change`에 `baseRev`로 되돌아온다. ELN 서버는 저장 시 `baseRev ≠ 현재 리비전`이면
충돌(다른 세션이 먼저 저장)로 처리하고, 저장 성공 시 `ack-save`로 새 리비전을
내려 다음 변경부터 갱신된 `baseRev`가 실리게 한다.

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
- **PDF 증적 포함** — 손글씨가 렌더된 PNG `<img>`로 본문에 존재하므로 기존
  노트 → Synap PDF 변환 → Amano TSA 경로에 자동 포함된다.
- **프레이밍 보안** — 같은 오리진 서빙(`/lib/handdrawing/`) +
  `X-Frame-Options: sameOrigin` + `embedAllowedOrigins` 기본값(동일 오리진)이
  그대로 맞물린다. 추가 설정 불요.

**남은 확인/개선 사항 (우선순위순)**:

1. **Synap 변환기의 `data:` URL 렌더 검증** — 손글씨 PNG는 data URL로 본문에
   저장된다. Synap 서버가 HTML 변환 시 data URL 이미지를 렌더하는지 실환경
   검증 필요 (기존 화학 구조식 SVG data URL도 동일 조건이므로 함께 확인).
   미지원이면 저장 시 data URL을 인라인 이미지 파일 경로로 치환하는 처리를
   `createNoteEditorDtl`의 Jsoup 단계에 추가하면 된다.
2. **PNG를 파일 업로드 경로로 전환 (권장)** — 현재 data URL 방식은 사진 포함
   노트에서 HTML이 수 MB로 커진다. `saveEditor`의 blob 인라인 이미지 업로드
   경로(`img[src*="blob:"]` → 파일 저장)를 재활용해 PNG는 파일로, 획 JSON만
   속성으로 유지하는 최적화를 검토.
3. **권한 매핑 일관성** — editor-ai `readOnly`(또는 standalone
   `handle.setReadOnly`)를 ELN `notePermission`과 연결할 것. 현재 ELN 에디터
   페이지는 읽기 권한일 때 저장만 막고 에디터를 읽기 전용으로 전환하지 않는
   기존 공백이 있다 — 손글씨 모달도 `editable` 게이트를 따르므로 이 연결만
   되면 함께 잠긴다.
4. **필기 인식 서버 공용화 (선택)** — 폐쇄망 고객사에서 필기 인식이 필요하면
   구노 백엔드에 인식 엔드포인트를 두고 `config.js`의 `recognizerEndpoint`로
   지정 (README의 API 사양 참고). iPad Safari 사용자도 이 경로로 인식 가능.
5. **교차 오리진 배포 시에만** — 에디터를 별도 오리진에 두는 경우 ELN
   `frame-src`(CSP 도입 시)에 에디터 오리진 추가 + `embedAllowedOrigins`에
   ELN 오리진 명시(양방향 화이트리스트).

**A2(전면 iframe 페이지)로 확장할 경우에만** 저장 API·손글씨 전용 write mode가
추가로 필요하며, 그때는 400ms `change`마다 저장하지 말고 ELN의 기존 autosave
주기(분 단위)·수동 저장에 맞춰 **호스트가 버퍼링**해야 한다 (저장 1회 = 파일
1개 + 버전 1개인 구조라 change마다 저장하면 파일이 폭증한다).

## 4. 에디터 쪽 개선 항목 진행 현황

- ✅ **editor-ai(NewEditor) 본문 블록 통합**: `DrawingImage` 노드 +
  `DrawingModal`(iframe postMessage 호스트) + `config.drawingEditorUrl` 옵션.
  삽입 시 json export(디바운스 무관 최신 획) + png export를 받아
  `img[data-strokes][data-drawing-sha256]`로 본문에 저장, 더블클릭 재편집.
  구축형 구노에는 standalone 번들 교체 + 정적 자산(`/lib/handdrawing/`) 배치로
  적용됨.
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
