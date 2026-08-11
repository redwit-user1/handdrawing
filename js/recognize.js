/**
 * recognize.js — 필기 텍스트 인식.
 *
 * 폴백 체인:
 *  1. 브라우저 내장 Handwriting Recognition API (Chrome/ChromeOS — 온디바이스 처리)
 *  2. config.js의 recognizerEndpoint로 지정한 자체 호스팅 인식 서버
 *     (iPad Safari 등 내장 API가 없는 브라우저와 온프레미스 환경용)
 *  3. 둘 다 없으면 null 반환 → 앱이 안내 메시지를 띄움
 */
const Recognizer = (() => {
  function hasNativeAPI() {
    return typeof navigator.createHandwritingRecognizer === 'function' &&
      typeof window.HandwritingStroke === 'function';
  }

  function endpoint() {
    return (window.APP_CONFIG && window.APP_CONFIG.recognizerEndpoint) || null;
  }

  function isSupported() {
    return hasNativeAPI() || !!endpoint();
  }

  /** 어떤 경로로 인식되는지 안내용 라벨 */
  function backendName() {
    if (hasNativeAPI()) return 'browser';
    if (endpoint()) return 'server';
    return null;
  }

  async function recognizeNative(inkStrokes) {
    const recognizer = await navigator.createHandwritingRecognizer({
      languages: ['ko', 'en'],
    });
    try {
      const drawing = recognizer.startDrawing({
        recognitionType: 'text',
        alternatives: 1,
      });
      // 저장된 획에는 타임스탬프가 없으므로 순서 기반으로 합성
      let t = 0;
      for (const s of inkStrokes) {
        const hs = new HandwritingStroke();
        for (const [x, y] of s.points) {
          hs.addPoint({ x, y, t: (t += 8) });
        }
        drawing.addStroke(hs);
        t += 120; // 획 사이 간격
      }
      const predictions = await drawing.getPrediction();
      return predictions.length > 0 ? predictions[0].text : '';
    } finally {
      if (typeof recognizer.finish === 'function') recognizer.finish();
    }
  }

  async function recognizeRemote(inkStrokes) {
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        languages: ['ko', 'en'],
        strokes: inkStrokes.map(s => ({
          points: s.points.map(p => [p[0], p[1]]),
        })),
      }),
    });
    if (!res.ok) throw new Error('인식 서버 오류 (HTTP ' + res.status + ')');
    const data = await res.json();
    return typeof data.text === 'string' ? data.text : '';
  }

  /**
   * strokes: 엔진의 획 배열 (도형은 제외하고 자유 곡선만 사용)
   * 반환: 인식된 문자열 (미지원 시 null)
   */
  async function recognize(strokes) {
    const inkStrokes = strokes.filter(s => s.tool !== 'shape' && s.points.length > 0);
    if (inkStrokes.length === 0) return '';
    if (hasNativeAPI()) return recognizeNative(inkStrokes);
    if (endpoint()) return recognizeRemote(inkStrokes);
    return null;
  }

  return { isSupported, backendName, recognize };
})();
