import { useState } from 'react';
import { Dialog } from '../../ui.tsx';
import { IcMinus, IcPlus } from '../../icons.tsx';

/**
 * 표 넣기·고치기. 칸 글은 비워 둬도 된다 — 표는 칸 선이 그려진 채 페이지에 들어가고,
 * 펜으로 칸에 바로 써 넣을 수 있다.
 */
export interface TableValue { rows: number; cols: number; header: boolean; cells: string[][] }

const MAX_ROWS = 20;
const MAX_COLS = 8;

function resize(cells: string[][], rows: number, cols: number): string[][] {
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => cells[r]?.[c] ?? ''));
}

function Stepper({ label, value, min, max, onChange, testId }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; testId: string }) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <span className="stepper-label">{label}</span>
      <button type="button" className="icon-btn" aria-label={`${label} 줄이기`} disabled={value <= min} onClick={() => onChange(value - 1)}><IcMinus /></button>
      <output className="stepper-value" data-testid={testId}>{value}</output>
      <button type="button" className="icon-btn" aria-label={`${label} 늘리기`} disabled={value >= max} onClick={() => onChange(value + 1)} data-testid={`${testId}-plus`}><IcPlus /></button>
    </div>
  );
}

export default function TableDialog({ initial, onSubmit, onClose }: { initial?: TableValue; onSubmit: (v: TableValue) => void; onClose: () => void }) {
  const [rows, setRows] = useState(initial?.rows ?? 3);
  const [cols, setCols] = useState(initial?.cols ?? 3);
  const [header, setHeader] = useState(initial?.header ?? true);
  const [cells, setCells] = useState<string[][]>(() => resize(initial?.cells ?? [], initial?.rows ?? 3, initial?.cols ?? 3));

  const setSize = (r: number, c: number) => {
    setRows(r);
    setCols(c);
    setCells((cur) => resize(cur, r, c));
  };
  const setCell = (r: number, c: number, v: string) =>
    setCells((cur) => cur.map((row, ri) => (ri === r ? row.map((x, ci) => (ci === c ? v : x)) : row)));

  return (
    <Dialog title={initial ? '표 고치기' : '표 넣기'} onClose={onClose} testId="table-dialog" wide>
      <div className="row table-controls">
        <Stepper label="줄" value={rows} min={1} max={MAX_ROWS} onChange={(v) => setSize(v, cols)} testId="table-rows" />
        <Stepper label="칸" value={cols} min={1} max={MAX_COLS} onChange={(v) => setSize(rows, v)} testId="table-cols" />
        <label className="check">
          <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> 첫 줄은 머리글
        </label>
      </div>
      <p className="muted small">칸은 비워 둬도 됩니다. 페이지에 넣은 뒤 펜으로 칸에 바로 쓸 수 있습니다.</p>
      <div className="table-edit" style={{ gridTemplateColumns: `repeat(${cols}, minmax(96px, 1fr))` }} data-testid="table-grid">
        {cells.map((row, r) => row.map((v, c) => (
          <input key={`${r}-${c}`} className={`cell${header && r === 0 ? ' head' : ''}`} value={v}
            aria-label={`${r + 1}줄 ${c + 1}칸`} onChange={(e) => setCell(r, c, e.target.value)} />
        )))}
      </div>
      <div className="row end">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary" onClick={() => onSubmit({ rows, cols, header, cells })} data-testid="table-submit">{initial ? '고치기' : '넣기'}</button>
      </div>
    </Dialog>
  );
}
