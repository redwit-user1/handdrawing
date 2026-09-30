import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './styles.css';

// 나중에 불러오는 조각이 이미 페이지에 인라인된 스타일시트를 다시 받으려다 막히면(웹 체험판) 무시하고 계속한다.
// JS 조각 자체를 못 받으면 import 가 실패하므로 각 부품의 오류 안내가 뜬다.
window.addEventListener('vite:preloadError', (e) => {
  const msg = String((e as Event & { payload?: Error }).payload?.message ?? '');
  if (/preload CSS/i.test(msg)) e.preventDefault();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
