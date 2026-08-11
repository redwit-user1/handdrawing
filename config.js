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
};
