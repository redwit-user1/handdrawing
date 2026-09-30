import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { embindNoEval } from './scripts/vite-embind-no-eval.ts';

/**
 * 구조식 편집기(ketcher-react)가 의존성 스타일시트(draft-js, react-contexify)를 직접 import 한다.
 * 그대로 두면 나중에 불러오는 조각에 별도 CSS 파일(<link>)이 붙는데, 별도 스타일시트를 막는 환경
 * (웹 체험판)에서는 이 CSS 로딩이 실패해 편집기 모듈 전체가 실패한다 → JS 안의 <style> 주입으로 바꾼다.
 */
function inlineKetcherCss(): Plugin {
  return {
    name: 'inline-ketcher-css',
    enforce: 'pre',
    transform(code, id) {
      if (!/node_modules[\\/]ketcher-react[\\/]dist[\\/]index\.js$/.test(id)) return null;
      let n = 0;
      const out = code.replace(/import ['"]([^'"]+\.css)['"];?/g, (_m, spec: string) => {
        n++;
        return `import __kcss${n} from '${spec}?inline';` +
          `if (typeof document !== 'undefined') { const s = document.createElement('style'); s.textContent = __kcss${n}; document.head.appendChild(s); }`;
      });
      return n ? { code: out, map: null } : null;
    },
  };
}

export default defineConfig({
  plugins: [react(), inlineKetcherCss(), embindNoEval()],
  // 구조식 계산 워커(WASM 판)에도 같은 수정을 건다
  worker: { format: 'es', plugins: () => [embindNoEval()] },
  // Ketcher 의존성 일부가 Node 전역 global 을 모듈 평가 시점에 읽는다 — 번들 단계에서 globalThis 로 바꾼다
  define: { global: 'globalThis' },
  resolve: {
    // Ketcher 계산 엔진은 WASM 을 JS 안 base64(21MB) 대신 별도 .wasm(8.9MB)+워커로 받는 판을 쓴다
    alias: [
      { find: /^ketcher-standalone$/, replacement: 'ketcher-standalone/dist/binaryWasm' },
      // paper.js 전체판은 PaperScript 용 파서가 로드 시점에 문자열 코드를 실행한다(eval 금지 환경에서 실패).
      // Ketcher 는 PaperScript 를 쓰지 않으므로 코어판을 쓴다
      { find: /^paper$/, replacement: 'paper/dist/paper-core.js' },
    ],
  },
  // 앱 웹뷰에서 상대 경로로 자산을 찾도록
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2020',
    // 구조식 편집기(Ketcher, 약 9.5MB)·수식(MathJax·MathLive)은 처음 열 때만 불러오는 별도 파일로 나뉜다
    chunkSizeWarningLimit: 16000,
  },
  // 손글씨 엔진은 저장소 루트의 js/engine.js 를 그대로 가져온다 (웹 구노와 같은 파일)
  server: { port: 5173, host: true, fs: { allow: ['..'] } },
});
