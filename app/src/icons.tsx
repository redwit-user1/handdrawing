import type { SVGProps } from 'react';

/**
 * 아이콘 — 24 격자, 선 굵기 1.75, 둥근 끝. 필기 도구 모양은 손글씨 편집기(handdrawing)와 같다.
 */
type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({
  width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.75, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, ...p,
});

export const IcPen = (p: P) => <svg {...base(p)}><path d="M17 3a2.8 2.8 0 0 1 4 4L8 20l-5 1 1-5Z" /><path d="m15 5 4 4" /></svg>;
export const IcHighlighter = (p: P) => <svg {...base(p)}><path d="m9 11 6 6M4 21l3-1 12-12a2.1 2.1 0 0 0-3-3L4 17l-1 3Z" /><path d="M3 21h7" opacity=".5" /></svg>;
export const IcEraser = (p: P) => <svg {...base(p)}><path d="m7 21-4-4a2 2 0 0 1 0-3L14 3a2 2 0 0 1 3 0l4 4a2 2 0 0 1 0 3L11 21Z" /><path d="M7 21h14M9.5 7.5l7 7" /></svg>;
export const IcLasso = (p: P) => <svg {...base(p)}><path d="M12 4c4.4 0 8 2 8 5s-3.6 5-8 5c-1 0-2-.1-2.9-.3M4.6 11.3C4.2 10.6 4 9.8 4 9c0-3 3.6-5 8-5" strokeDasharray="3 2.4" /><path d="M7 13a2 2 0 1 0 0 4c1.5 0 2-1.5 2-3s.5-3 2-3" /></svg>;
export const IcText = (p: P) => <svg {...base(p)}><path d="M5 7V5h14v2M12 5v14M9 19h6" /></svg>;
export const IcShapes = (p: P) => <svg {...base(p)}><rect x="3" y="4" width="9" height="9" rx="1" /><circle cx="16" cy="16" r="5" /></svg>;
export const IcPhoto = (p: P) => <svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m5 19 5-5 3 3 4-4 4 4" /></svg>;
export const IcUndo = (p: P) => <svg {...base(p)}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>;
export const IcRedo = (p: P) => <svg {...base(p)}><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></svg>;
export const IcHand = (p: P) => <svg {...base(p)}><path d="M18 11V6.5a1.5 1.5 0 0 0-3 0m3 4.5v-2a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1c-2.5 0-4-1-5.5-3L4 13.5a1.6 1.6 0 0 1 2.5-2L8 13V5a1.5 1.5 0 0 1 3 0m0 6V4a1.5 1.5 0 0 1 3 0v7" /></svg>;
export const IcBack = (p: P) => <svg {...base(p)}><path d="m15 18-6-6 6-6" /></svg>;
export const IcHistory = (p: P) => <svg {...base(p)}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></svg>;
export const IcCheck = (p: P) => <svg {...base(p)}><path d="m5 12 5 5 9-10" /></svg>;
export const IcPlus = (p: P) => <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>;
export const IcClose = (p: P) => <svg {...base(p)}><path d="M6 6l12 12M18 6 6 18" /></svg>;
export const IcTrash = (p: P) => <svg {...base(p)}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>;
export const IcCopy = (p: P) => <svg {...base(p)}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>;
export const IcSync = (p: P) => <svg {...base(p)}><path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 13a8 8 0 0 0 14.5 4.5L20 16" /><path d="M4 3v5h5M20 21v-5h-5" /></svg>;
export const IcLock = (p: P) => <svg {...base(p)}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;
export const IcLine = (p: P) => <svg {...base(p)}><path d="M5 19 19 5" /></svg>;
export const IcArrow = (p: P) => <svg {...base(p)}><path d="M5 19 19 5M10 5h9v9" /></svg>;
export const IcRect = (p: P) => <svg {...base(p)}><rect x="4" y="6" width="16" height="12" rx="1" /></svg>;
export const IcEllipse = (p: P) => <svg {...base(p)}><ellipse cx="12" cy="12" rx="8" ry="6" /></svg>;
export const IcGrid = (p: P) => <svg {...base(p)}><path d="M4 9h16M4 15h16M9 4v16M15 4v16" /><rect x="4" y="4" width="16" height="16" rx="1" /></svg>;
export const IcChevronDown = (p: P) => <svg {...base(p)}><path d="m6 9 6 6 6-6" /></svg>;
export const IcTable = (p: P) => <svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="1.5" /><path d="M3 9.5h18M3 15h18M9 4v16M15 4v16" /></svg>;
export const IcSigma = (p: P) => <svg {...base(p)}><path d="M18 5H6l6 7-6 7h12" /></svg>;
export const IcFlask = (p: P) => <svg {...base(p)}><path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3" /><path d="M7 15h10" /></svg>;
export const IcMolecule = (p: P) => <svg {...base(p)}><path d="m12 3 7.8 4.5v9L12 21l-7.8-4.5v-9Z" /><path d="M12 7.5 15.9 9.75v4.5L12 16.5" /></svg>;
export const IcClock = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
export const IcEdit = (p: P) => <svg {...base(p)}><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z" /><path d="m13.5 6.5 4 4" /></svg>;
export const IcMinus = (p: P) => <svg {...base(p)}><path d="M5 12h14" /></svg>;
