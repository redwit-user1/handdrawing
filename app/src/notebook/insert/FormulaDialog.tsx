import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '../../ui.tsx';
import type { TexImage } from './tex.ts';

/**
 * 수식(LaTeX)·화학식(mhchem) 넣기·고치기.
 *
 *  - 수식: MathLive 입력칸 — 태블릿에서는 수식 전용 화면 키보드(분수·근호·첨자·그리스 문자)가 뜬다.
 *  - 화학식: 보통 글자로 "2H2 + O2 -> 2H2O" 처럼 쓰면 아래첨자·화살표가 붙는다.
 *
 * 아래 미리보기가 페이지에 들어갈 그림 그대로다(MathJax SVG).
 */
export type FormulaKind = 'math' | 'ce';

type TexModule = typeof import('./tex.ts');
let texPromise: Promise<TexModule> | null = null;
export const loadTex = () => (texPromise ??= import('./tex.ts'));

let mathlivePromise: Promise<unknown> | null = null;
function loadMathLive() {
  mathlivePromise ??= import('mathlive').then((m) => {
    // 오프라인에서도 쓰도록 앱 안의 글꼴을 쓴다 (scripts/copy-assets.mjs 가 public/mathlive 로 복사)
    m.MathfieldElement.fontsDirectory = new URL('mathlive/fonts/', document.baseURI).href;
    m.MathfieldElement.soundsDirectory = null;
    return m;
  });
  return mathlivePromise;
}

const CE_EXAMPLES = ['H2SO4', '2H2 + O2 -> 2H2O', 'CuSO4.5H2O', 'N2 + 3H2 <=> 2NH3', 'Fe^3+ + 3OH- -> Fe(OH)3 v', 'CH3COOH'];
const MATH_EXAMPLES: { label: string; tex: string }[] = [
  { label: '분수', tex: '\\frac{a}{b}' },
  { label: '근의 공식', tex: 'x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}' },
  { label: '합', tex: '\\sum_{i=1}^{n} x_i' },
  { label: '평균·표준편차', tex: '\\bar{x}\\pm s' },
  { label: '적분', tex: '\\int_0^\\infty f(x)\\,dx' },
  { label: '몰농도', tex: 'C=\\frac{n}{V}' },
];

interface MathFieldEl extends HTMLElement { value: string; executeCommand?: (c: unknown) => boolean }

export default function FormulaDialog({ kind, initial, onSubmit, onClose }: {
  kind: FormulaKind;
  initial?: string;
  onSubmit: (source: string, img: TexImage) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState(initial ?? '');
  const [tex, setTex] = useState<TexModule | null>(null);
  const [mlReady, setMlReady] = useState(kind !== 'math');
  const fieldRef = useRef<MathFieldEl | null>(null);

  useEffect(() => { void loadTex().then(setTex); }, []);
  useEffect(() => { if (kind === 'math') void loadMathLive().then(() => setMlReady(true)); }, [kind]);

  // MathLive 입력칸 ↔ source
  useEffect(() => {
    const el = fieldRef.current;
    if (!el || !mlReady) return;
    if (el.value !== source) el.value = source;
    const onInput = () => setSource(el.value);
    el.addEventListener('input', onInput);
    const t = setTimeout(() => el.focus(), 50);
    return () => { el.removeEventListener('input', onInput); clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mlReady]);

  const preview = useMemo(() => {
    if (!tex || !source.trim()) return null;
    try {
      return { img: kind === 'math' ? tex.renderTex(source) : tex.renderCe(source), error: '' };
    } catch (e) {
      return { img: null, error: (e as Error).message };
    }
  }, [tex, source, kind]);

  const title = `${kind === 'math' ? '수식' : '화학식'} ${initial ? '고치기' : '넣기'}`;
  const setFromExample = (v: string) => {
    setSource(v);
    if (fieldRef.current) fieldRef.current.value = v;
  };

  return (
    <Dialog title={title} onClose={onClose} testId="formula-dialog" wide>
      {kind === 'math' ? (
        <>
          {mlReady ? (
            createElement('math-field', {
              ref: fieldRef, class: 'math-input', 'data-testid': 'math-input',
              'math-virtual-keyboard-policy': 'auto', 'aria-label': '수식 입력',
            })
          ) : <div className="math-input muted">수식 입력기를 여는 중…</div>}
          <details className="tex-source">
            <summary>LaTeX로 직접 쓰기</summary>
            <input className="mono-input" value={source} onChange={(e) => setFromExample(e.target.value)} spellCheck={false}
              autoCapitalize="off" autoCorrect="off" aria-label="LaTeX" data-testid="tex-source" />
          </details>
          <div className="chip-row" aria-label="예시">
            {MATH_EXAMPLES.map((x) => <button key={x.label} type="button" className="btn small" onClick={() => setFromExample(x.tex)}>{x.label}</button>)}
          </div>
        </>
      ) : (
        <>
          <label className="field">화학식
            <input className="mono-input" value={source} onChange={(e) => setSource(e.target.value)} spellCheck={false}
              autoCapitalize="off" autoCorrect="off" autoFocus placeholder="예: 2H2 + O2 -> 2H2O" data-testid="ce-input" />
          </label>
          <p className="muted small">숫자는 아래첨자로, <code>-&gt;</code>는 화살표, <code>&lt;=&gt;</code>는 평형, <code>^2+</code>는 전하, <code>.</code>은 수화물 점이 됩니다.</p>
          <div className="chip-row" aria-label="예시">
            {CE_EXAMPLES.map((x) => <button key={x} type="button" className="btn small mono" onClick={() => setSource(x)}>{x}</button>)}
          </div>
        </>
      )}
      <div className="formula-preview" aria-live="polite" data-testid="formula-preview">
        {!source.trim() ? <span className="muted small">미리보기</span>
          : preview?.img ? <img src={preview.img.src} alt="" style={{ width: Math.min(preview.img.w * 1.4, 640), height: 'auto' }} />
          : preview?.error ? <span className="small danger-text">고칠 곳이 있습니다: {preview.error}</span>
          : <span className="muted small">그리는 중…</span>}
      </div>
      <div className="row end">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary" disabled={!preview?.img} onClick={() => preview?.img && onSubmit(source, preview.img)} data-testid="formula-submit">
          {initial ? '고치기' : '넣기'}
        </button>
      </div>
    </Dialog>
  );
}
