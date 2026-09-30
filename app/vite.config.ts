import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Ketcher 의존성 일부가 Node 전역 global 을 모듈 평가 시점에 읽는다 — 번들 단계에서 globalThis 로 바꾼다
  define: { global: 'globalThis' },
  resolve: {
    // Ketcher 계산 엔진은 WASM 을 JS 안 base64(21MB) 대신 별도 .wasm(8.9MB)+워커로 받는 판을 쓴다
    alias: [{ find: /^ketcher-standalone$/, replacement: 'ketcher-standalone/dist/binaryWasm' }],
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
