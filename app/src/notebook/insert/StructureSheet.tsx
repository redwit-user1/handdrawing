import './ketcher-shim.ts'; // 반드시 Ketcher 보다 먼저
import { useEffect, useRef, useState } from 'react';
import { Editor as KetcherEditor } from 'ketcher-react';
import { MolSerializer, type Ketcher } from 'ketcher-core';
// 스타일시트를 별도 파일(<link>)로 받지 않고 JS 안에 넣어 <style> 로 붙인다 —
// 외부·별도 스타일시트를 막는 환경(웹 체험판 등)에서도 편집기 모듈 로딩이 실패하지 않게
import ketcherCss from 'ketcher-react/dist/index.css?inline';
import { IcClose } from '../../icons.tsx';

if (typeof document !== 'undefined' && !document.getElementById('ketcher-css')) {
  const st = document.createElement('style');
  st.id = 'ketcher-css';
  st.textContent = ketcherCss;
  document.head.appendChild(st);
}

/**
 * 화학 구조식 그리기 — Ketcher(EPAM, Apache-2.0), 계산은 기기 안에서 하므로 오프라인에서도 된다.
 * 화면 전체를 쓰는 시트로 연다. 결과: SVG 그림 + molfile(다시 고치기용) + SMILES.
 *
 * 계산 엔진(Indigo)은 WASM 이다. WASM 을 쓸 수 있으면 엔진을 붙이고(SMILES·정리·그림 생성),
 * WASM 이 막힌 환경(웹 체험판의 보안 정책, Safari 잠금 모드 등)에서는 엔진 없이 연다 — 직접 그리기·molfile 저장은
 * 편집기 자체(JS)로 되고, 그림은 편집기 화면의 SVG 를 잘라 쓴다. 엔진이 필요한 기능은 안내만 한다.
 */
type Provider = { provider: unknown; render: boolean; engine: boolean };

const NO_ENGINE_MESSAGE = '이 환경에서는 구조 계산 엔진을 쓸 수 없어 이 기능은 동작하지 않습니다. 구조는 직접 그려서 넣을 수 있습니다.';

/** 엔진 없는 구조 서비스 — 계산 요청은 안내 메시지로 거절한다 */
function engineLessProvider() {
  const unavailable = () => Promise.reject(new Error(NO_ENGINE_MESSAGE));
  const base: Record<string, unknown> = {
    addKetcherId() {},
    destroy() {},
    info: () => Promise.resolve({ indigoVersion: '', imagoVersions: [], isAvailable: false }),
  };
  const service = new Proxy(base, { get: (t, k) => (typeof k === 'string' && k in t ? t[k] : unavailable) });
  return { mode: 'standalone', createStructService: () => service };
}
let providerPromise: Promise<Provider> | null = null;

async function wasmAllowed(): Promise<boolean> {
  try {
    await WebAssembly.compile(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    return true;
  } catch {
    return false;
  }
}

function loadProvider(): Promise<Provider> {
  providerPromise ??= (async () => {
    if (typeof WebAssembly === 'object' && await wasmAllowed()) {
      const m = await import('ketcher-standalone');
      return { provider: new m.StandaloneStructServiceProvider(), render: true, engine: true };
    }
    return { provider: engineLessProvider(), render: false, engine: false };
  })();
  providerPromise.catch(() => { providerPromise = null; });
  return providerPromise;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const SHAPES = new Set(['path', 'text', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect']);

/** 편집기 화면의 구조식 SVG 를 내용 크기로 잘라 낸다 (JS 엔진이라 그림 생성이 안 될 때) */
function captureCanvasSvg(host: HTMLElement): { svg: string; w: number; h: number } | null {
  const el = host.querySelector('[class*="intermediateCanvas"] svg') as SVGSVGElement | null;
  if (!el) return null;
  const box = el.getBoundingClientRect();
  const clone = el.cloneNode(true) as SVGSVGElement;
  const src = [...el.querySelectorAll('*')];
  const dst = [...clone.querySelectorAll('*')];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  src.forEach((node, i) => {
    const cs = getComputedStyle(node);
    const hidden = cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0
      || (node.getAttribute('opacity') === '0') || (node.getAttribute('fill-opacity') === '0' && node.getAttribute('stroke-opacity') === '0');
    if (hidden) { dst[i]?.setAttribute('data-drop', '1'); return; }
    if (!SHAPES.has(node.tagName.toLowerCase())) return;
    const b = (node as SVGGraphicsElement).getBBox?.();
    if (!b || (!b.width && !b.height)) return;
    // 편집 영역 전체를 덮는 바탕 사각형은 빼고
    if (b.width >= box.width * 0.9 && b.height >= box.height * 0.9) { dst[i]?.setAttribute('data-drop', '1'); return; }
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
  });
  if (!isFinite(minX)) return null;
  clone.querySelectorAll('[data-drop]').forEach((n) => n.remove());
  const pad = 10;
  const w = maxX - minX + pad * 2, h = maxY - minY + pad * 2;
  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('viewBox', `${minX - pad} ${minY - pad} ${w} ${h}`);
  clone.setAttribute('width', String(Math.round(w)));
  clone.setAttribute('height', String(Math.round(h)));
  clone.removeAttribute('style');
  clone.removeAttribute('class');
  return { svg: new XMLSerializer().serializeToString(clone), w, h };
}

export interface StructureResult { svg: string; w: number; h: number; molfile: string; smiles: string }

/** Ketcher SVG 의 고유 크기(px). 없으면 viewBox */
function svgSize(svg: string): { w: number; h: number } {
  const w = /<svg[^>]*\swidth="([\d.]+)(?:px)?"/.exec(svg);
  const h = /<svg[^>]*\sheight="([\d.]+)(?:px)?"/.exec(svg);
  if (w && h) return { w: parseFloat(w[1]), h: parseFloat(h[1]) };
  const vb = /viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"/.exec(svg);
  return vb ? { w: parseFloat(vb[1]), h: parseFloat(vb[2]) } : { w: 300, h: 200 };
}

type EditorWithStruct = { struct(s?: unknown): { isBlank(): boolean } };
const editorOf = (k: Ketcher) => k.editor as unknown as EditorWithStruct;

/** molfile — 엔진이 있으면 Ketcher 기본(엔진 변환), 없으면 편집기 구조를 JS 로 직렬화 */
async function readMolfile(k: Ketcher, engine: boolean): Promise<string> {
  if (engine) return k.getMolfile();
  return new MolSerializer().serialize(editorOf(k).struct() as never);
}

/** 다시 고칠 때 molfile 불러오기 — 엔진이 없으면 JS 로 읽어 편집기에 넣는다 */
async function loadMolfile(k: Ketcher, molfile: string, engine: boolean): Promise<void> {
  if (engine) { await k.setMolecule(molfile); return; }
  editorOf(k).struct(new MolSerializer().deserialize(molfile));
}

/** 빈 캔버스인지 — Ketcher 구조 객체로 보고, 안 되면 molfile 원자 수(V2000 넷째 줄)로 */
function isBlank(k: Ketcher, molfile: string): boolean {
  try {
    const struct = (k.editor as unknown as { struct(): { isBlank(): boolean } }).struct();
    return struct.isBlank();
  } catch {
    const counts = molfile.split('\n')[3] ?? '';
    return !molfile.trim() || parseInt(counts.slice(0, 3), 10) === 0;
  }
}

export default function StructureSheet({ initialMolfile, onSubmit, onClose }: {
  initialMolfile?: string;
  onSubmit: (r: StructureResult) => void;
  onClose: () => void;
}) {
  const ketcherRef = useRef<Ketcher | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [prov, setProv] = useState<Provider | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [smiles, setSmiles] = useState('');

  useEffect(() => {
    let alive = true;
    loadProvider().then((p) => { if (alive) setProv(p); }, (e) => { if (alive) setError(`구조식 계산 엔진을 불러오지 못했습니다: ${(e as Error).message}`); });
    return () => { alive = false; ketcherRef.current = null; };
  }, []);

  const loadSmiles = async () => {
    const s = smiles.trim();
    if (!s || !ketcherRef.current) return;
    setError('');
    try { await ketcherRef.current.setMolecule(s); } catch (e) { setError(`SMILES를 읽지 못했습니다: ${(e as Error).message}`); }
  };

  const submit = async () => {
    const k = ketcherRef.current;
    if (!k) return;
    setBusy(true);
    setError('');
    try {
      const engine = prov?.engine !== false;
      const molfile = await readMolfile(k, engine);
      if (isBlank(k, molfile)) { setError('넣을 구조가 없습니다. 구조를 그리거나 SMILES를 불러오세요.'); return; }
      const smi = engine ? await k.getSmiles().catch(() => '') : '';
      let svg = '';
      let size = { w: 0, h: 0 };
      if (prov?.render) {
        try { svg = await (await k.generateImage(molfile, { outputFormat: 'svg' })).text(); size = svgSize(svg); } catch { svg = ''; }
      }
      if (!svg) {
        const cap = hostRef.current && captureCanvasSvg(hostRef.current);
        if (!cap) { setError('구조식 그림을 만들지 못했습니다.'); return; }
        svg = cap.svg;
        size = { w: cap.w, h: cap.h };
      }
      onSubmit({ svg, w: size.w, h: size.h, molfile, smiles: smi });
    } catch (e) {
      setError(`그림을 만들지 못했습니다: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-full" role="dialog" aria-modal="true" aria-label="구조식 그리기" data-testid="structure-sheet">
      <header className="sheet-head">
        <button className="icon-btn" onClick={onClose} aria-label="닫기"><IcClose /></button>
        <h2 className="grow">구조식 {initialMolfile ? '고치기' : '그리기'}</h2>
        {prov?.engine !== false && <>
        <input className="smiles-input" value={smiles} onChange={(e) => setSmiles(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void loadSmiles()}
          placeholder="SMILES로 불러오기 (예: CC(=O)Oc1ccccc1C(=O)O)" aria-label="SMILES" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-testid="smiles-input" />
        <button className="btn" onClick={() => void loadSmiles()} disabled={!ready || !smiles.trim()} data-testid="smiles-load">불러오기</button>
        </>}
        <button className="btn primary" onClick={() => void submit()} disabled={!ready || busy} data-testid="structure-submit">{busy ? '만드는 중…' : initialMolfile ? '고치기' : '넣기'}</button>
      </header>
      {prov && !prov.engine && (
        <div className="banner info" data-testid="no-engine">
          이 브라우저 환경은 보안 정책상 구조 계산 엔진(WASM)을 막고 있어 직접 그리기만 됩니다. SMILES 불러오기·구조 정리는 설치한 앱에서 쓸 수 있습니다.
        </div>
      )}
      {error && <div className="banner danger" role="alert">{error}</div>}
      <div className="ketcher-host" ref={hostRef}>
        {prov && <KetcherEditor
          staticResourcesUrl=""
          structServiceProvider={prov.provider as never}
          errorHandler={(msg: unknown) => setError(String(msg))}
          onInit={async (ketcher: Ketcher) => {
            ketcherRef.current = ketcher;
            (window as unknown as { ketcher: Ketcher }).ketcher = ketcher;
            if (initialMolfile) { try { await loadMolfile(ketcher, initialMolfile, prov.engine); } catch { /* 손상된 molfile 은 빈 캔버스 */ } }
            setReady(true);
          }}
        />}
        {!ready && <div className="canvas-loading muted">구조식 편집기를 여는 중…</div>}
      </div>
    </div>
  );
}
