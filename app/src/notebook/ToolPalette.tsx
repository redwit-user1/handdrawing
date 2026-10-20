import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Engine, ShapeKind, Tool } from './engine.ts';
import {
  IcArrow, IcClock, IcEllipse, IcEraser, IcFlask, IcHand, IcHighlighter, IcLasso, IcLine, IcMolecule, IcMore, IcPen, IcPhoto, IcPlus, IcRect,
  IcRedo, IcShapes, IcSigma, IcTable, IcText, IcUndo,
} from '../icons.tsx';
import { paletteLayout, type PalItem } from './paletteLayout.ts';

/** "+" 로 넣는 것들 */
export type InsertKind = 'photo' | 'table' | 'math' | 'ce' | 'chem' | 'stamp';
const INSERTS: { kind: InsertKind; label: string; hint: string; Icon: typeof IcPen }[] = [
  { kind: 'photo', label: '사진', hint: '카메라·앨범', Icon: IcPhoto },
  { kind: 'table', label: '표', hint: '칸 선 + 글', Icon: IcTable },
  { kind: 'math', label: '수식', hint: '분수·근호·첨자', Icon: IcSigma },
  { kind: 'ce', label: '화학식', hint: '분자식·반응식', Icon: IcFlask },
  { kind: 'chem', label: '구조식', hint: '분자 구조 그리기', Icon: IcMolecule },
  { kind: 'stamp', label: '날짜·시각', hint: '지금 시각 도장', Icon: IcClock },
];

/**
 * 떠 있는 필기 도구 — 가로 화면은 왼쪽 세로 레일, 세로 화면은 아래쪽 가로 막대.
 * 모든 버튼 48px (장갑 낀 손가락·펜 끝 기준). 색·굵기는 한 버튼 뒤 팝오버로 묶는다.
 * 막대가 다 들어가지 않는 좁은 화면(Split View·Slide Over)에서는 버튼을 44px 로 줄이고, 그래도 넘치는 것은
 * "더보기"(⋯) 메뉴로 넣는다 (paletteLayout.ts).
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

type Pop = 'shape' | 'ink' | 'insert' | 'more';
type ToolItem = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'text';

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

const TOOL_ITEMS: Record<ToolItem, { label: string; Icon: typeof IcPen }> = {
  pen: { label: '펜', Icon: IcPen },
  highlighter: { label: '형광펜', Icon: IcHighlighter },
  eraser: { label: '지우개', Icon: IcEraser },
  lasso: { label: '올가미 선택', Icon: IcLasso },
  text: { label: '글상자 (키보드)', Icon: IcText },
};
const isToolItem = (i: PalItem): i is ToolItem => i in TOOL_ITEMS;
/** 넓을 때 이 앞에 구분선 */
const SEP_BEFORE = new Set<PalItem>(['ink', 'undo', 'touch']);

export default function ToolPalette({ engine, state, onChange, orientation, room, onPhoto, onInsert, canUndo, canRedo }: {
  engine: Engine;
  state: PaletteState;
  onChange: (next: Partial<PaletteState>) => void;
  orientation: 'rail' | 'bar';
  /** 막대가 쓸 수 있는 길이 (레일이면 높이, 막대면 폭, 화면 px) — 모자라면 버튼을 줄이고 "더보기"로 넣는다 */
  room?: number;
  onPhoto: (file: File) => void;
  onInsert: (kind: Exclude<InsertKind, 'photo'>) => void;
  canUndo: boolean;
  canRedo: boolean;
}) {
  const [pop, setPop] = useState<Pop | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const layout = paletteLayout(room ?? Infinity);
  const hidden = new Set<PalItem>(layout.more);

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
  const toggle = (p: Pop) => setPop(pop === p ? null : p);
  const ShapeIcon = SHAPES.find((s) => s.value === state.shape)?.Icon ?? IcShapes;
  const inkName = `${INK_COLORS.find((c) => c.value === state.color)?.name ?? ''}, ${INK_SIZES.find((s) => s.value === state.size)?.name ?? ''}`;
  const inkDot = <span className="ink-dot" style={{ background: state.color, width: 8 + state.size * 2, height: 8 + state.size * 2 }} />;

  /** 팝오버 내용 — 버튼이 막대에 있으면 그 버튼 옆, "더보기"에 들어가 있으면 더보기 버튼 옆에 뜬다 */
  const popFor = (p: Exclude<Pop, 'more'>) => {
    if (p === 'shape') {
      return (
        <div className="pal-pop" role="menu" aria-label="도형 종류">
          {SHAPES.map(({ value, name, Icon }) => (
            <button key={value} type="button" role="menuitemradio" aria-checked={state.shape === value}
              className={`pal-btn${state.shape === value ? ' active' : ''}`} aria-label={name} title={name}
              onClick={() => { onChange({ tool: 'shape', shape: value }); setPop(null); }}>
              <Icon />
            </button>
          ))}
        </div>
      );
    }
    if (p === 'insert') {
      return (
        <div className="pal-pop insert-pop" role="menu" aria-label="넣기">
          {INSERTS.map(({ kind, label, hint, Icon }) => (
            <button key={kind} type="button" role="menuitem" className="insert-item" data-testid={`insert-${kind}`}
              onClick={() => { setPop(null); if (kind === 'photo') fileRef.current?.click(); else onInsert(kind); }}>
              <Icon /><span><b>{label}</b><small>{hint}</small></span>
            </button>
          ))}
        </div>
      );
    }
    return (
      <div className="pal-pop ink-pop" aria-label="색과 굵기" data-testid="ink-pop">
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
    );
  };
  /** 버튼이 막대에 있을 때 그 자리의 팝오버 */
  const ownPop = (p: Exclude<Pop, 'more'>) => (pop === p && !hidden.has(p) ? popFor(p) : null);

  const button = (item: PalItem): ReactNode => {
    if (isToolItem(item)) {
      const { label, Icon } = TOOL_ITEMS[item];
      return <ToolButton label={label} active={state.tool === item} onClick={() => pick(item)} testId={`tool-${item}`}><Icon /></ToolButton>;
    }
    switch (item) {
      case 'shape':
        return (
          <div className="pal-anchor">
            <ToolButton label="도형" active={state.tool === 'shape'} onClick={() => { onChange({ tool: 'shape' }); toggle('shape'); }} testId="tool-shape">
              <ShapeIcon />
            </ToolButton>
            {ownPop('shape')}
          </div>
        );
      case 'insert':
        return (
          <div className="pal-anchor">
            <ToolButton label="넣기: 사진·표·수식·화학식" active={pop === 'insert'} onClick={() => toggle('insert')} testId="tool-insert" pressed={false}>
              <IcPlus />
            </ToolButton>
            {ownPop('insert')}
          </div>
        );
      case 'ink':
        return (
          <div className="pal-anchor">
            <button type="button" className="pal-btn ink" aria-label={`색·굵기: ${inkName}`} title="색·굵기" onClick={() => toggle('ink')} data-testid="tool-ink">
              {inkDot}
            </button>
            {ownPop('ink')}
          </div>
        );
      case 'undo':
        return <ToolButton label="실행 취소" onClick={() => engine.undo()} disabled={!canUndo} testId="undo" pressed={false}><IcUndo /></ToolButton>;
      case 'redo':
        return <ToolButton label="다시 실행" onClick={() => engine.redo()} disabled={!canRedo} testId="redo" pressed={false}><IcRedo /></ToolButton>;
      case 'touch':
        return (
          <ToolButton label={state.touchDraws ? '손가락으로 쓰기 켜짐' : '손가락으로 쓰기 꺼짐 (손가락은 넘기기·선택)'} active={state.touchDraws}
            onClick={() => onChange({ touchDraws: !state.touchDraws })} testId="tool-touch">
            <IcHand />
          </ToolButton>
        );
    }
    return null;
  };

  /** "더보기" 메뉴의 한 줄 (아이콘 + 이름) */
  const moreRow = (item: PalItem): ReactNode => {
    const row = (label: string, icon: ReactNode, onClick: () => void, extra: { checked?: boolean; disabled?: boolean } = {}) => (
      <button key={item} type="button" role={extra.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={extra.checked}
        className={`insert-item${extra.checked ? ' active' : ''}`} disabled={extra.disabled} onClick={onClick} data-testid={`more-${item}`}>
        {icon}<span><b>{label}</b></span>
      </button>
    );
    if (isToolItem(item)) {
      const { label, Icon } = TOOL_ITEMS[item];
      return row(label, <Icon />, () => { setPop(null); onChange({ tool: item }); }, { checked: state.tool === item });
    }
    switch (item) {
      case 'shape': return row('도형', <ShapeIcon />, () => { onChange({ tool: 'shape' }); setPop('shape'); }, { checked: state.tool === 'shape' });
      case 'insert': return row('넣기 (사진·표·수식)', <IcPlus />, () => setPop('insert'));
      case 'ink': return row(`색·굵기 (${inkName})`, <span className="ink-ic">{inkDot}</span>, () => setPop('ink'));
      // 실행 취소·다시 실행·손가락 쓰기는 메뉴를 닫지 않는다 (여러 번 누를 수 있게)
      case 'undo': return row('실행 취소', <IcUndo />, () => engine.undo(), { disabled: !canUndo });
      case 'redo': return row('다시 실행', <IcRedo />, () => engine.redo(), { disabled: !canRedo });
      case 'touch': return row('손가락으로 쓰기', <IcHand />, () => onChange({ touchDraws: !state.touchDraws }), { checked: state.touchDraws });
    }
    return null;
  };

  // 더보기 안의 도구를 쓰는 중이면 더보기 버튼을 켠 것처럼 보인다
  const moreActive = layout.more.some((i) => (isToolItem(i) || i === 'shape') && state.tool === i);

  return (
    <div ref={rootRef} className={`palette ${orientation}${layout.compact ? ' compact' : ''}`} role="toolbar" aria-label="필기 도구"
      data-testid="palette" data-more={layout.more.join(' ')}>
      {layout.shown.map((item) => (
        <Fragment key={item}>
          {!layout.compact && SEP_BEFORE.has(item) && <span className="pal-sep" aria-hidden="true" />}
          {button(item)}
        </Fragment>
      ))}
      {layout.more.length > 0 && (
        <div className="pal-anchor">
          <ToolButton label="더보기" active={pop === 'more' || moreActive} pressed={false} onClick={() => toggle('more')} testId="tool-more">
            <IcMore />
          </ToolButton>
          {pop === 'more' && (
            <div className="pal-pop insert-pop more-pop" role="menu" aria-label="더보기 도구" data-testid="more-pop">
              {layout.more.map(moreRow)}
            </div>
          )}
          {pop && pop !== 'more' && hidden.has(pop) && popFor(pop)}
        </div>
      )}
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) onPhoto(f);
      }} />
    </div>
  );
}
