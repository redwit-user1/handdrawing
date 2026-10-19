/**
 * 삽입 그림(수식·화학식·구조식)을 다시 고칠 때 사용자가 손잡이로 바꾼 크기를 지키기 위한 계산.
 * 저장된 그림(SVG data URL)의 고유 크기에서 "처음 만든 크기"를 되짚고, 지금 상자 폭과의 비율을 새 그림에도 쓴다.
 */

/** 수식 SVG 고유 크기 = 넣는 크기 × TEX_OVERSAMPLE (확대·고해상도 내보내기에서도 선명하게) */
export const TEX_OVERSAMPLE = 3;
/** 구조식은 이 안에 들어가게 줄여 넣는다 */
export const CHEM_MAX_W = 360;
export const CHEM_MAX_H = 280;

/** 구조식 넣는 크기 (페이지에 알맞게, 키우지 않음) */
export function chemFit(w: number, h: number): { w: number; h: number } {
  const k = Math.min(1, CHEM_MAX_W / w, CHEM_MAX_H / h);
  return { w: Math.round(w * k), h: Math.round(h * k) };
}

/** data:image/svg+xml(;base64) → SVG 글 (아니면 null) */
export function svgFromDataUrl(src: string): string | null {
  const m = /^data:image\/svg\+xml(;base64)?,(.*)$/s.exec(src);
  if (!m) return null;
  try {
    if (!m[1]) return decodeURIComponent(m[2]);
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** SVG 맨 바깥 width/height (없으면 viewBox) */
export function svgSize(svg: string): { w: number; h: number } | null {
  const w = /<svg[^>]*\swidth="([\d.]+)(?:px)?"/.exec(svg);
  const h = /<svg[^>]*\sheight="([\d.]+)(?:px)?"/.exec(svg);
  if (w && h) return { w: parseFloat(w[1]), h: parseFloat(h[1]) };
  const vb = /<svg[^>]*viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"/.exec(svg);
  return vb ? { w: parseFloat(vb[1]), h: parseFloat(vb[2]) } : null;
}

/** 그림 객체를 처음 넣었을 때의 크기 (모르면 null) */
export function madeSize(kind: string | undefined, src: string): { w: number; h: number } | null {
  const svg = svgFromDataUrl(src);
  const n = svg ? svgSize(svg) : null;
  if (!n || !(n.w > 0) || !(n.h > 0)) return null;
  if (kind === 'math' || kind === 'ce') return { w: n.w / TEX_OVERSAMPLE, h: n.h / TEX_OVERSAMPLE };
  if (kind === 'chem') return chemFit(n.w, n.h);
  return null;
}

/** 사용자가 손잡이로 바꾼 배율 = 지금 상자 폭 ÷ 처음 만든 폭 (모르면 1) */
export function userScale(obj: { kind?: unknown; src?: unknown; points: number[][] }): number {
  const made = typeof obj.src === 'string' ? madeSize(obj.kind as string | undefined, obj.src) : null;
  if (!made) return 1;
  const w = Math.abs(obj.points[1][0] - obj.points[0][0]);
  const k = w / made.w;
  return Number.isFinite(k) && k > 0.05 && k < 20 ? k : 1;
}
