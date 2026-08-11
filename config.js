/**
 * config.js — 배포 환경별 설정 (온프레미스 배포 시 이 파일만 수정하면 됨)
 */
window.APP_CONFIG = {
  /**
   * 필기 인식 서버 엔드포인트 (선택).
   *
   * 브라우저 내장 Handwriting Recognition API가 없는 환경(iPad Safari, Firefox,
   * 구형 Chrome 등)에서 사용할 자체 호스팅 인식 서버의 URL을 지정한다.
   * null이면 내장 API만 시도하고, 미지원 시 안내 메시지를 띄운다.
   *
   * 요청:  POST {endpoint}
   *        Content-Type: application/json
   *        { "languages": ["ko", "en"],
   *          "strokes": [ { "points": [[x, y], ...] }, ... ] }
   * 응답:  { "text": "인식된 문자열" }
   *
   * 예: recognizerEndpoint: '/api/recognize'
   *     recognizerEndpoint: 'https://ocr.internal.example.com/recognize'
   */
  recognizerEndpoint: null,

  /**
   * ELN 임베드(postMessage) 허용 오리진 (선택).
   *
   * `index.html?embed=1`을 iframe으로 띄우는 호스트(ELN)의 오리진 목록.
   *  - null: 동일 오리진만 허용 (기본, ELN과 같은 도메인에서 서빙할 때)
   *  - ['https://eln.example.com']: 지정한 오리진만 허용
   *  - ['*']: 모든 오리진 허용 (개발용 — 운영에서는 사용하지 말 것)
   */
  embedAllowedOrigins: null,

  /**
   * 노트 저장 REST API 베이스 URL (선택).
   *
   * 지정하면 단독 실행 모드에서 localStorage 캐시와 함께 서버에도 저장한다
   * (임베드 모드에서는 사용하지 않음 — 저장은 호스트 ELN 책임).
   *  - GET    {apiBase}/notes           → { "notes": [note, ...] } 또는 [note, ...]
   *  - PUT    {apiBase}/notes/{id}      → 본문: note JSON
   *  - DELETE {apiBase}/notes/{id}
   * 서버 연결에 실패하면 로컬 저장만 유지하고 안내를 띄운다.
   *
   * 예: apiBase: '/api'
   */
  apiBase: null,
};
