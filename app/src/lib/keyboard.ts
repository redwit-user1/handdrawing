/**
 * 화상 키보드가 가리는 자리 → CSS 변수 --kb(아래에서 가리는 높이)·--kb-top(위로 밀린 높이).
 *
 * iPad(WKWebView·Safari)는 키보드가 떠도 창 높이(innerHeight)는 그대로이고 visualViewport 만 줄어든다 — 그래서
 * 가운데 정렬한 대화상자의 '넣기' 버튼이 키보드 밑에 숨었다. 대화상자 바탕(.dialog-backdrop)·구조식 시트가 이
 * 변수만큼 비켜 앉는다. 수식 입력기(MathLive)의 화면 키보드는 visualViewport 를 줄이지 않으므로 그 높이도 더한다.
 * (갤럭시 탭처럼 키보드가 창 자체를 줄이는 환경에서는 innerHeight 가 같이 줄어 값이 0 — 따로 비킬 필요 없음)
 */

export interface ViewportSample {
  innerHeight: number;
  /** visualViewport.height / offsetTop / scale — 없으면 창 전체가 보이는 것으로 */
  vvHeight?: number;
  vvTop?: number;
  vvScale?: number;
  /** 수식 입력기 화면 키보드 높이 (안 떠 있으면 0) */
  mathKeyboard?: number;
}

export interface KeyboardInsets { top: number; bottom: number }

/** 이보다 작게 가리는 것은 무시 (주소창·둥근 모서리 같은 몇 px 차이) */
export const KB_MIN_PX = 40;

export function keyboardInsets(s: ViewportSample): KeyboardInsets {
  const math = Math.max(0, Math.round(s.mathKeyboard ?? 0));
  // 손가락으로 확대해 보는 중이면 visualViewport 가 줄어든 것은 키보드 때문이 아니다
  if (s.vvHeight == null || (s.vvScale ?? 1) > 1.01) return { top: 0, bottom: math >= KB_MIN_PX ? math : 0 };
  const top = Math.max(0, Math.round(s.vvTop ?? 0));
  const covered = Math.max(0, Math.round(s.innerHeight - top - s.vvHeight));
  const bottom = Math.max(covered, math);
  return bottom >= KB_MIN_PX ? { top, bottom } : { top: 0, bottom: 0 };
}

type MathKeyboard = EventTarget & { visible?: boolean; boundingRect?: DOMRect; hide?: (options?: { animate?: boolean }) => void };
const mathKeyboard = () => (window as unknown as { mathVirtualKeyboard?: MathKeyboard }).mathVirtualKeyboard;

let started = false;
let watchingMath = false;
let last: KeyboardInsets = { top: 0, bottom: 0 };

function sample(): ViewportSample {
  const vv = window.visualViewport;
  const mk = mathKeyboard();
  return {
    innerHeight: window.innerHeight,
    vvHeight: vv?.height, vvTop: vv?.offsetTop, vvScale: vv?.scale,
    mathKeyboard: mk?.visible ? mk.boundingRect?.height ?? 0 : 0,
  };
}

export function updateKeyboardInsets() {
  const next = keyboardInsets(sample());
  if (next.top === last.top && next.bottom === last.bottom) return;
  const opened = next.bottom > last.bottom;
  last = next;
  const root = document.documentElement.style;
  root.setProperty('--kb', `${next.bottom}px`);
  root.setProperty('--kb-top', `${next.top}px`);
  // 키보드가 올라오면 대화상자 안에서 쓰는 칸이 보이도록 (대화상자 높이가 줄어 스크롤된다)
  if (opened) {
    requestAnimationFrame(() => {
      const el = document.activeElement as HTMLElement | null;
      if (el && el !== document.body && el.closest('.dialog, .sheet-full')) el.scrollIntoView({ block: 'nearest' });
    });
  }
}

/** 앱 시작 시 한 번 */
export function startKeyboardInsets() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const vv = window.visualViewport;
  vv?.addEventListener('resize', updateKeyboardInsets);
  vv?.addEventListener('scroll', updateKeyboardInsets);
  window.addEventListener('resize', updateKeyboardInsets);
  updateKeyboardInsets();
}

/** 수식 입력기(MathLive)를 불러온 뒤 — 그 화면 키보드가 뜨고 내릴 때도 다시 잰다 */
export function watchMathKeyboard() {
  const mk = mathKeyboard();
  if (!mk || watchingMath) return;
  watchingMath = true;
  mk.addEventListener('geometrychange', updateKeyboardInsets);
  mk.addEventListener('virtual-keyboard-toggle', updateKeyboardInsets);
}

/** 수식 대화상자를 닫을 때 — 떠 있는 수식 화면 키보드를 내리고 가림 높이를 다시 잰다 */
export function hideMathKeyboard() {
  const mk = mathKeyboard();
  if (mk?.visible) mk.hide?.({ animate: false });
  updateKeyboardInsets();
}
