# 구노(GOONO) ELN 연계 분석 및 통합 가이드

이 문서는 손글씨 노트(handdrawing)를 기존 구노 ELN에 연계하기 위한 분석 결과,
에디터 쪽에 이미 구현된 연계 인터페이스, 그리고 ELN 쪽에서 개선/추가해야 하는
사항을 정리한다.

## 0. 분석 범위와 전제

- 구노 ELN 본체 코드는 별도 조직 저장소에 있어 이 분석 세션에서는 직접 열람하지
  못했다. 따라서 ELN 내부 구현에 대한 항목은 **일반적인 구노 제품 구조(웹 프런트 +
  메인 서버 + 시점인증 파이프라인)를 전제로 한 제안**이며, 실제 코드와 대조해
  확정해야 한다.
- 참고한 사내 자료: 화학 에디터 PoC(chemeditor)의 ELN 요구사항 문서 —
  "노트 본문에 에디터 **임베드**(P0)", "연구노트 **법적 무결성**(전자연구노트
  관리지침, TSA/타임스탬프)", "폐쇄망 온프레미스, 외부 CDN 의존 없음".
  손글씨 에디터도 같은 제약 아래 설계했다.

## 1. 연계 시나리오 비교

| 시나리오 | 설명 | 공수 | 권장도 |
| --- | --- | --- | --- |
| **A. iframe 임베드** | ELN 노트 화면에 iframe으로 삽입, postMessage로 로드/저장/내보내기 제어 | ELN 쪽 호스트 컴포넌트 1개 + 저장 API | ★ **권장** |
| B. 첨부파일 워크플로 | 에디터를 별도 페이지로 쓰고 PNG/PDF/JSON을 ELN에 첨부 | 거의 없음 (현재도 가능) | 임시 방편 |
| C. 컴포넌트 이식 | 엔진(engine.js)을 ELN 프런트(React)에 네이티브 포팅 | 큼 (빌드 체계·상태 관리 통합) | 장기 검토 |

**A안을 권장하는 이유**: 에디터가 프레임워크 독립(순수 JS)이라 ELN 프런트 기술
스택과 충돌하지 않고, 별도 배포·버전 관리가 가능하며, iframe 격리로 스타일/이벤트
간섭이 없다. chemeditor PoC(Ketcher 임베드)와 동일한 통합 패턴이므로 ELN 쪽에
비슷한 호스트 코드가 이미 있다면 재사용할 수 있다.

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
| `handdrawing:change` | `note{title,strokes,updated}`, `sha256`, `strokeCount` | 편집 후 400ms 디바운스 |
| `handdrawing:export-result` | `requestId`, `format`, `dataUrl`(png/pdf) 또는 `json`, 실패 시 `error` | `export` 요청 응답 |

ELN → 에디터:

| type | payload | 용도 |
| --- | --- | --- |
| `handdrawing:load` | `note{title,strokes}` 또는 `null`(새 노트) | 저장된 노트 주입 |
| `handdrawing:set-readonly` | `readonly: boolean` | 열람/편집 전환 |
| `handdrawing:export` | `requestId`, `format: 'png'\|'pdf'\|'json'` | 렌더링 결과 요청 |

동작하는 호스트 예시: [`examples/eln-host-demo.html`](../examples/eln-host-demo.html)

### 2.3 무결성·증적 지원

- **`change` 메시지의 `sha256`**: `{title, strokes}` 정규화 JSON의 SHA-256.
  ELN이 저장 시점에 이 해시를 시점인증(TSA) 파이프라인에 그대로 전달하면
  "이 시점에 이 내용이 존재했다"를 증명할 수 있다. (Web Crypto 사용 —
  HTTPS/localhost 필수, 아니면 null로 옴)
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
      "points": [[x0, y0], [x1, y1]] }
  ]
}
```

버전 마이그레이션을 위해 ELN 저장 시 `schemaVersion: 1`을 함께 저장할 것을 권장.

## 3. ELN 쪽 개선/추가 필요 사항 (우선순위순)

1. **손글씨 블록 타입 추가** — 노트 본문 블록(또는 첨부) 타입으로
   `handdrawing`을 추가하고, 위 JSON + 렌더링된 PNG 미리보기를 함께 저장.
   목록/검색 화면에서는 PNG 미리보기만 보여주면 된다.
2. **iframe 호스트 컴포넌트** — `ready → load → change 수신 → 저장 API 호출`
   흐름의 React 컴포넌트 1개. `examples/eln-host-demo.html`의 스크립트를
   그대로 옮기면 된다. 편집 종료 시 `export`(png)로 미리보기 갱신.
3. **저장 API/스키마** — 노트 JSON + sha256 + 사용자/시각을 저장하는 엔드포인트.
   구노의 기존 파일/블록 저장 구조에 맞춰 얹되, **수정 시 이전 버전을 보존**
   (연구노트 무결성 — 덮어쓰기 금지, 버전 체인).
4. **시점인증(TSA) 연계** — `change`의 sha256을 기존 구노 시점인증 파이프라인에
   전달. 획 데이터 원문을 다시 해시하지 말고 에디터가 준 해시를 쓰면
   에디터/서버 간 해시 불일치 문제를 피할 수 있다 (서버에서 재계산 검증은 권장).
5. **연구노트 PDF 병합** — 구노의 노트 → PDF 증빙 생성 시, 손글씨 블록은
   `export pdf` 결과(또는 저장해 둔 PNG)를 해당 위치에 삽입.
6. **권한 매핑** — ELN의 열람/편집 권한을 `?readonly=1` 또는 `set-readonly`
   메시지로 전달. 서명·잠금된 노트는 반드시 열람 모드로 띄울 것.
7. **필기 인식 서버 공용화 (선택)** — 폐쇄망 고객사에서 필기 인식이 필요하면
   구노 백엔드에 인식 엔드포인트를 두고 `config.js`의 `recognizerEndpoint`로
   지정 (README의 API 사양 참고). iPad Safari 사용자도 이 경로로 인식 가능.
8. **CSP/보안 헤더** — 에디터를 별도 오리진에 배포한다면 ELN의
   `frame-src`에 에디터 오리진 추가 + 에디터 `config.js`의
   `embedAllowedOrigins`에 ELN 오리진 명시(양방향 화이트리스트).

## 4. 에디터 쪽 남은 개선 항목 (연계 고도화 시)

- **동시 편집 잠금**: 현재 단일 사용자 전제. ELN에서 같은 노트를 두 명이 열면
  마지막 저장이 이긴다 → ELN 쪽 편집 잠금(체크아웃) 또는 버전 충돌 감지 필요.
- **대용량 노트**: 획 수천 개 이상이면 postMessage 페이로드가 커진다.
  필요 시 증분 전송(추가/삭제된 획만)으로 프로토콜 v2 확장 여지 있음.
- **이미지 배경 삽입**: 실험 사진 위에 주석을 다는 유스케이스가 있다면
  배경 이미지 레이어 추가 필요 (현재 미구현).
- **서버 저장 어댑터**: 임베드가 아닌 단독 실행에서도 REST 저장이 필요하면
  Store를 어댑터로 추상화해 `/api/notes` 연동 추가.
