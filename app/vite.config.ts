import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 앱 웹뷰에서 상대 경로로 자산을 찾도록
  base: './',
  build: { outDir: 'dist', target: 'es2020' },
  server: { port: 5173, host: true },
});
