import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 앱 웹뷰에서 상대 경로로 자산을 찾도록
  base: './',
  build: { outDir: 'dist', target: 'es2020' },
  // 손글씨 엔진은 저장소 루트의 js/engine.js 를 그대로 가져온다 (웹 구노와 같은 파일)
  server: { port: 5173, host: true, fs: { allow: ['..'] } },
});
