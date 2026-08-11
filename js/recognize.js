/**
 * recognize.js — 필기 텍스트 인식.
 * 브라우저 내장 Handwriting Recognition API(Chrome/ChromeOS 등)를 사용한다.
 * 외부 서버로 데이터를 보내지 않고 온디바이스로 처리되며,
 * 미지원 브라우저에서는 null을 반환해 앱이 안내 메시지를 띄운다.
 */
const Recognizer = (() => {
  function isSupported() {
    return typeof navigator.createHandwritingRecognizer === 'function' &&
      typeof window.HandwritingStroke === 'function';
  }

  /**
   * strokes: 엔진의 획 배열 (도형은 제외하고 자유 곡선만 사용)
   * 반환: 인식된 문자열 (실패/미지원 시 null)
   */
  async function recognize(strokes) {
    if (!isSupported()) return null;

    const inkStrokes = strokes.filter(s => s.tool !== 'shape' && s.points.length > 0);
    if (inkStrokes.length === 0) return '';

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

  return { isSupported, recognize };
})();
