/**
 * LaTeX(수식) · mhchem(화학식) → SVG 그림.
 * 필기 페이지(캔버스)에 그대로 그릴 수 있게 글꼴을 경로로 풀어 넣은 SVG 를 만든다(fontCache 'none').
 * 번들이 커서(약 2MB) 수식·화학식을 처음 넣을 때만 불러온다.
 */
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const doc = mathjax.document('', {
  InputJax: new TeX({
    packages: AllPackages.filter((p: string) => p !== 'bussproofs'),
    // 문법 오류는 빨간 글씨 대신 예외로 — 대화상자에서 알려 준다
    formatError: (_jax: unknown, err: Error) => { throw err; },
  }),
  OutputJax: new SVG({ fontCache: 'none' }),
});

/** 페이지 글자 크기(월드 단위) 기준 — 글상자(18)보다 조금 크게 */
export const MATH_FONT = 22;
const EX = MATH_FONT * 0.44;
/** 확대·고해상도 내보내기에서도 선명하도록 그림 고유 크기를 3배로 */
const OVERSAMPLE = 3;

export interface TexImage { src: string; w: number; h: number; svg: string }

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function renderTex(latex: string, color = '#1f2328', display = true): TexImage {
  const node = doc.convert(latex, { display, em: 16, ex: 8, containerWidth: 1600 });
  let svg = adaptor.innerHTML(node);
  const wm = /width="([\d.]+)ex"/.exec(svg);
  const hm = /height="([\d.]+)ex"/.exec(svg);
  if (!wm || !hm) throw new Error('수식을 그리지 못했습니다.');
  const w = Math.max(4, parseFloat(wm[1]) * EX);
  const h = Math.max(4, parseFloat(hm[1]) * EX);
  svg = svg
    .replace(/width="[\d.]+ex"/, `width="${(w * OVERSAMPLE).toFixed(1)}"`)
    .replace(/height="[\d.]+ex"/, `height="${(h * OVERSAMPLE).toFixed(1)}"`)
    .replace(/style="vertical-align:[^"]*"/, '')
    .replace(/currentColor/g, color);
  if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg)) svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  return { src: `data:image/svg+xml;base64,${toBase64(svg)}`, w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100, svg };
}

/** mhchem: "2H2 + O2 -> 2H2O", "H2SO4", "CuSO4.5H2O", "A <=> B" */
export function renderCe(ce: string, color?: string): TexImage {
  return renderTex(`\\ce{${ce}}`, color);
}
