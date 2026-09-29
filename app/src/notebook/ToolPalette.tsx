import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Engine, ShapeKind, Tool } from './engine.ts';
import {
  IcArrow, IcEllipse, IcEraser, IcHand, IcHighlighter, IcLasso, IcLine, IcPen, IcPhoto, IcRect, IcRedo, IcShapes, IcText, IcUndo,
} from '../icons.tsx';

/**
 * 떠 있는 필기 도구 — 가로 화면은 왼쪽 세로 레일, 세로 화면은 아래쪽 가로 막대.
 * 모든 버튼 48px (장갑 낀 손가락·펜 끝 기준). 색·굵기는 한 버튼 뒤 팝오버로 묶는다.
 */
export const INK_COLORS = [
  { value: '#1f2328', name: '검정' },
  { value: '#2f6bf2', name: '파랑' },
  { value: '#d92d20', name: '빨강' },
  { value: '#16803c', name: '초록' },
  { value: '#c2410c', name: '주황' },
  { value: '#7a3fd1', name: '보라' },
];
export const INK_SIZES = [
  { value: 2.5, name: '가늘게' },
  { value: 4, name: '보통' },
  { value: 7, name: '굵게' },
];
const SHAPES: { value: ShapeKind; name: string; Icon: typeof IcLine }[] = [
  { value: 'line', name: '직선', Icon: IcLine },
  { value: 'arrow', name: '화살표', Icon: IcArrow },
  { value: 'rect', name: '사각형', Icon: IcRect },
  { value: 'ellipse', name: '타원', Icon: IcEllipse },
];

export interface PaletteState { tool: Tool; shape: ShapeKind; color: string; size: number; touchDraws: boolean }

function ToolButton({ label, active, onClick, children, testId, disabled, pressed }: {
  label: string; active?: boolean; onClick: () => void; children: ReactNode; testId?: string; disabled?: boolean; pressed?: boolean;
}) {
  return (
    <button type="button" className={`pal-btn${active ? ' active' : ''}`} aria-label={label} title={label}
      aria-pressed={pressed ?? active} onClick={onClick} disabled={disabled} data-testid={testId}>
      {children}
    </button>
  );
}

export default function ToolPalette({ engine, state, onChange, orientation, onPhoto, canUndo, canRedo }: {
  engine: Engine;
  state: PaletteState;
  onChange: (next: Partial<PaletteState>) => void;
  orientation: 'rail' | 'bar';
  onPhoto: (file: File) => void;
  canUndo: boolean;
  canRedo: boolean;
}) {
  const [pop, setPop] = useState<'shape' | 'ink' | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pop) return;
    const close = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) setPop(null); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [pop]);

  const pick = (tool: Tool) => {
    // 이미 고른 펜·형광펜을 다시 누르면 색·굵기
    if (tool === state.tool && (tool === 'pen' || tool === 'highlighter')) { setPop(pop === 'ink' ? null : 'ink'); return; }
    setPop(null);
    onChange({ tool });
  };

  const tools: { tool: Tool; label: string; Icon: typeof IcPen }[] = [
    { tool: 'pen', label: '펜', Icon: IcPen },
    { tool: 'highlighter', label: '형광펜', Icon: IcHighlighter },
    { tool: 'eraser', label: '지우개', Icon: IcEraser },
    { tool: 'lasso', label: '올가미 선택', Icon: IcLasso },
    { tool: 'text', label: '글상자 (키보드)', Icon: IcText },
  ];
  const ShapeIcon = SHAPES.find((s) => s.value === state.shape)?.Icon ?? IcShapes;

  return (
    <div ref={rootRef} className={`palette ${orientation}`} role="toolbar" aria-label="필기 도구" data-testid="palette">
      {tools.map(({ tool, label, Icon }) => (
        <ToolButton key={tool} label={label} active={state.tool === tool} onClick={() => pick(tool)} testId={`tool-${tool}`}>
          <Icon />
        </ToolButton>
      ))}
      <div className="pal-anchor">
        <ToolButton label="도형" active={state.tool === 'shape'} onClick={() => { onChange({ tool: 'shape' }); setPop(pop === 'shape' ? null : 'shape'); }} testId="tool-shape">
          <ShapeIcon />
        </ToolButton>
        {pop === 'shape' && (
          <div className="pal-pop" role="menu" aria-label="도형 종류">
            {SHAPES.map(({ value, name, Icon }) => (
              <button key={value} type="button" role="menuitemradio" aria-checked={state.shape === value}
                className={`pal-btn${state.shape === value ? ' active' : ''}`} aria-label={name} title={name}
                onClick={() => { onChange({ tool: 'shape', shape: value }); setPop(null); }}>
                <Icon />
              </button>
            ))}
          </div>
        )}
      </div>
      <ToolButton label="사진 넣기" onClick={() => fileRef.current?.click()} testId="tool-photo" pressed={false}><IcPhoto /></ToolButton>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) onPhoto(f);
      }} />

      <span className="pal-sep" aria-hidden="true" />

      <div className="pal-anchor">
        <button type="button" className="pal-btn ink" aria-label={`색·굵기: ${INK_COLORS.find((c) => c.value === state.color)?.name ?? ''}, ${INK_SIZES.find((s) => s.value === state.size)?.name ?? ''}`}
          title="색·굵기" onClick={() => setPop(pop === 'ink' ? null : 'ink')} data-testid="tool-ink">
          <span className="ink-dot" style={{ background: state.color, width: 8 + state.size * 2, height: 8 + state.size * 2 }} />
        </button>
        {pop === 'ink' && (
          <div className="pal-pop ink-pop" aria-label="색과 굵기">
            <div className="ink-row" role="radiogroup" aria-label="색">
              {INK_COLORS.map((c) => (
                <button key={c.value} type="button" role="radio" aria-checked={state.color === c.value} aria-label={c.name} title={c.name}
                  className={`swatch${state.color === c.value ? ' active' : ''}`} onClick={() => onChange({ color: c.value })}>
                  <span style={{ background: c.value }} />
                </button>
              ))}
            </div>
            <div className="ink-row" role="radiogroup" aria-label="굵기">
              {INK_SIZES.map((s) => (
                <button key={s.value} type="button" role="radio" aria-checked={state.size === s.value} aria-label={s.name} title={s.name}
                  className={`width${state.size === s.value ? ' active' : ''}`} onClick={() => onChange({ size: s.value })}>
                  <span style={{ height: Math.max(2, s.value * 0.9), background: state.color }} />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <span className="pal-sep" aria-hidden="true" />

      <ToolButton label="실행 취소" onClick={() => engine.undo()} disabled={!canUndo} testId="undo" pressed={false}><IcUndo /></ToolButton>
      <ToolButton label="다시 실행" onClick={() => engine.redo()} disabled={!canRedo} testId="redo" pressed={false}><IcRedo /></ToolButton>

      <span className="pal-sep" aria-hidden="true" />

      <ToolButton label={state.touchDraws ? '손가락으로 쓰기 켜짐' : '손가락으로 쓰기 꺼짐 (손가락은 넘기기)'} active={state.touchDraws}
        onClick={() => onChange({ touchDraws: !state.touchDraws })} testId="tool-touch">
        <IcHand />
      </ToolButton>
    </div>
  );
}
