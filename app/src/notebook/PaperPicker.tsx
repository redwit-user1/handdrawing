import { papers, type PaperSpec } from './engine.ts';

/*
 * 종이(모눈) 고르기 — 새 노트 대화상자와 노트 화면의 "종이" 메뉴가 함께 쓴다.
 * 미리보기는 페이지 왼쪽 위(머리글 포함)를 크게 보여 준다 — 실제 종이는 아주 옅어서 미리보기만 한 단계 진하게 그린다.
 */
const VIEW_W = 240;
const VIEW_H = 330;
const HEAD = 44;
const C = { grid: '#d9e0ea', major: '#aab6c6', rule: '#c9d1dc', dot: '#98a5b6', head: '#cfd6e0', title: '#c3cad5' };

export function PaperPreview({ spec }: { spec: PaperSpec }) {
  const step = spec.step ?? 0;
  const fine: string[] = [];
  const major: string[] = [];
  const dots: [number, number][] = [];
  if (spec.kind === 'grid' && step) {
    for (let k = 1; k * step < VIEW_W; k++) (spec.major && k % spec.major === 0 ? major : fine).push(`M${k * step} ${HEAD}V${VIEW_H}`);
    for (let k = 1; HEAD + k * step < VIEW_H; k++) (spec.major && k % spec.major === 0 ? major : fine).push(`M0 ${HEAD + k * step}H${VIEW_W}`);
  } else if (spec.kind === 'lines' && step) {
    for (let y = HEAD + step; y < VIEW_H; y += step) fine.push(`M0 ${y}H${VIEW_W}`);
  } else if (spec.kind === 'dots' && step) {
    for (let y = HEAD + step; y < VIEW_H; y += step) for (let x = step; x < VIEW_W; x += step) dots.push([x, y]);
  }
  const line = spec.kind === 'lines' ? C.rule : C.grid;
  return (
    <svg className="paper-thumb" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} aria-hidden="true">
      <rect width={VIEW_W} height={VIEW_H} fill="#fff" />
      {fine.length > 0 && <path d={fine.join('')} stroke={line} strokeWidth={1} vectorEffect="non-scaling-stroke" fill="none" />}
      {major.length > 0 && <path d={major.join('')} stroke={C.major} strokeWidth={1} vectorEffect="non-scaling-stroke" fill="none" />}
      {dots.map(([x, y]) => <circle key={`${x},${y}`} cx={x} cy={y} r={3.2} fill={C.dot} />)}
      <rect x={16} y={16} width={86} height={12} rx={6} fill={C.title} />
      <path d={`M16 ${HEAD}H${VIEW_W}`} stroke={C.head} strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default function PaperPicker({ value, onChange, label = '종이' }: { value: string; onChange: (id: string) => void; label?: string }) {
  return (
    <div className="paper-pick" role="radiogroup" aria-label={label} data-testid="paper-picker">
      {papers().map((p) => (
        <button key={p.id} type="button" role="radio" aria-checked={value === p.id} className={`paper-opt${value === p.id ? ' active' : ''}`}
          onClick={() => onChange(p.id)} data-testid={`paper-option-${p.id}`}>
          <PaperPreview spec={p} />
          <span>{p.name}</span>
        </button>
      ))}
    </div>
  );
}
