import './ketcher-shim.ts'; // 반드시 Ketcher 보다 먼저
import { useEffect, useRef, useState } from 'react';
import { Editor as KetcherEditor } from 'ketcher-react';
import { StandaloneStructServiceProvider } from 'ketcher-standalone';
import type { Ketcher } from 'ketcher-core';
import 'ketcher-react/dist/index.css';
import { IcClose } from '../../icons.tsx';

/**
 * 화학 구조식 그리기 — Ketcher(EPAM, Apache-2.0), 계산은 기기 안(WASM)에서 하므로 오프라인에서도 된다.
 * 화면 전체를 쓰는 시트로 연다. 결과: SVG 그림 + molfile(다시 고치기용) + SMILES.
 */
const structServiceProvider = new StandaloneStructServiceProvider();

export interface StructureResult { svg: string; w: number; h: number; molfile: string; smiles: string }

/** Ketcher SVG 의 고유 크기(px). 없으면 viewBox */
function svgSize(svg: string): { w: number; h: number } {
  const w = /<svg[^>]*\swidth="([\d.]+)(?:px)?"/.exec(svg);
  const h = /<svg[^>]*\sheight="([\d.]+)(?:px)?"/.exec(svg);
  if (w && h) return { w: parseFloat(w[1]), h: parseFloat(h[1]) };
  const vb = /viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"/.exec(svg);
  return vb ? { w: parseFloat(vb[1]), h: parseFloat(vb[2]) } : { w: 300, h: 200 };
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
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [smiles, setSmiles] = useState('');

  useEffect(() => () => { ketcherRef.current = null; }, []);

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
      const molfile = await k.getMolfile();
      if (isBlank(k, molfile)) { setError('넣을 구조가 없습니다. 구조를 그리거나 SMILES를 불러오세요.'); return; }
      const smi = await k.getSmiles().catch(() => '');
      const svg = await (await k.generateImage(molfile, { outputFormat: 'svg' })).text();
      const { w, h } = svgSize(svg);
      onSubmit({ svg, w, h, molfile, smiles: smi });
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
        <input className="smiles-input" value={smiles} onChange={(e) => setSmiles(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void loadSmiles()}
          placeholder="SMILES로 불러오기 (예: CC(=O)Oc1ccccc1C(=O)O)" aria-label="SMILES" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-testid="smiles-input" />
        <button className="btn" onClick={() => void loadSmiles()} disabled={!ready || !smiles.trim()} data-testid="smiles-load">불러오기</button>
        <button className="btn primary" onClick={() => void submit()} disabled={!ready || busy} data-testid="structure-submit">{busy ? '만드는 중…' : initialMolfile ? '고치기' : '넣기'}</button>
      </header>
      {error && <div className="banner danger" role="alert">{error}</div>}
      <div className="ketcher-host">
        <KetcherEditor
          staticResourcesUrl=""
          structServiceProvider={structServiceProvider}
          errorHandler={(msg: unknown) => setError(String(msg))}
          onInit={async (ketcher: Ketcher) => {
            ketcherRef.current = ketcher;
            (window as unknown as { ketcher: Ketcher }).ketcher = ketcher;
            if (initialMolfile) { try { await ketcher.setMolecule(initialMolfile); } catch { /* 손상된 molfile 은 빈 캔버스 */ } }
            setReady(true);
          }}
        />
        {!ready && <div className="canvas-loading muted">구조식 편집기를 여는 중…</div>}
      </div>
    </div>
  );
}
