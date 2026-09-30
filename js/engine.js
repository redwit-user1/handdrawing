/**
 * engine.js — 캔버스 드로잉 엔진 (태블릿 최적화)
 *
 * - Pointer Events 기반: 펜(스타일러스) 필압, 펜 지우개 버튼 지원
 * - 팜 리젝션: 펜 사용 중이거나 직후에는 손바닥 터치 무시
 * - 손가락 두 개: 핀치 줌 + 패닝 / (손가락 그리기 꺼짐 시) 손가락 하나: 패닝
 * - getCoalescedEvents로 고주파 입력 샘플 수집 → 부드러운 곡선
 * - 완료된 획은 오프스크린 캔버스에 캐시하여 그리는 동안 60fps 유지
 * - 도형(직선/화살표/사각형/타원), 올가미 선택(이동·복제·삭제)
 * - 실행 취소 / 다시 실행 (추가·삭제·이동·전체 지우기·글 수정)
 * - 페이지 모드(layout.type = 'pages'): A4 본문 비율 페이지를 세로로 잇고, 페이지 단위로 내보낸다
 * - 글상자(tool 'text'): 페이지 위에 키보드로 쓰는 글. 편집은 캔버스 위 textarea 오버레이
 * - 표(tool 'table'): 칸 선만 긋고(손으로 채워 넣는다) 선택적으로 칸 글을 넣는다
 * - 삽입 객체(수식·화학식·구조식): tool 'image' + kind/원본(latex·ce·molfile) — 호스트가 그림을 만들고 다시 고친다
 * - 올가미 도구로 객체를 한 번 누르면 그 객체가 선택된다
 */
class DrawingEngine {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bg = document.createElement('canvas');       // 완료된 획 캐시
    this.bgCtx = this.bg.getContext('2d');
    this.opts = opts;   // { onChange, onViewport, onPenDetected, onSelection }

    // 뷰포트: screen = world * scale + (tx, ty)
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.minScale = 0.25;
    this.maxScale = 8;

    // 도구 상태
    this.tool = 'pen';            // pen | highlighter | eraser | pan | shape | lasso
    this.shape = 'line';          // line | arrow | rect | ellipse
    this.color = '#1f2328';
    this.size = 5;                // 월드 좌표 기준 기본 굵기
    this.touchDraws = true;       // 손가락으로 그리기 허용 여부
    this.showGrid = true;
    this.readonly = false;        // 읽기 전용(열람) 모드: 이동/줌만 허용

    // 데이터
    this.strokes = [];
    this.undoStack = [];
    this.redoStack = [];
    this.HISTORY_LIMIT = 100;

    // 입력 상태
    this.pointers = new Map();    // pointerId -> {x, y, type}
    this.drawing = null;          // 진행 중인 입력 상태
    this.gesture = null;          // 핀치/패닝 상태
    this.penLastSeen = 0;         // 팜 리젝션용: 마지막 펜 이벤트 시각
    this.eraserPos = null;        // 지우개 커서 표시용 (화면 좌표)
    this.erasedInDrag = [];       // 드래그 한 번 동안 지운 획 모음 (undo 단위)

    // 선택 상태
    this.selection = null;        // { strokes: Set, bbox: {minX,minY,maxX,maxY} }
    this.lassoPath = null;        // 진행 중인 올가미 경로 (월드 좌표)

    this._imgCache = new Map();   // 이미지 획의 src → HTMLImageElement

    // 페이지 모드 — null 이면 무한 캔버스(기존 동작)
    this.layout = null;           // { type: 'pages', pageW, pageH, gap, header? }
    this.insets = { top: 0, right: 0, bottom: 0, left: 0 }; // 화면 가장자리에 떠 있는 UI 여백(화면 px)
    this.pageHeader = null;       // (pageIndex, pageCount) => { left, right } — 없으면 제목 / "날짜 · N쪽"
    this.title = '';              // 기본 머리글 왼쪽에 쓰는 노트 제목

    // 글상자 편집 상태
    this.textEdit = null;         // { stroke, isNew, before }
    this.textInput = null;        // 오버레이 textarea (필요할 때 만든다)

    this._dirty = true;
    this._bgDirty = true;
    this._raf = null;

    this._bindEvents();
    this.resize();
  }

  /* ============== 좌표 변환 ============== */
  screenToWorld(sx, sy) {
    return { x: (sx - this.tx) / this.scale, y: (sy - this.ty) / this.scale };
  }

  /* ============== 데이터 로드/변경 ============== */
  setStrokes(strokes) {
    this._endTextEdit(false);
    this.strokes = strokes || [];
    this.undoStack = [];
    this.redoStack = [];
    this._cancelInput();
    this.clearSelection();
    this.requestRender(true);
    this._emitChange(false);
  }

  resetView() {
    if (this.layout) { this.fitWidth(); return; }
    this.scale = 1; this.tx = 0; this.ty = 0;
    this.requestRender(true);
    this._emitViewport();
  }

  /* ============== 페이지 모드 ============== */

  /** 페이지 레이아웃 설정. null 이면 무한 캔버스 */
  setLayout(layout) {
    this._lastUsed = undefined;
    this.layout = layout && layout.type === 'pages' ? normalizePageLayout(layout) : null;
    this.minScale = this.layout ? 0.3 : 0.25;
    this.requestRender(true);
    if (this.layout) this.fitWidth();
  }

  _pageStride() { return this.layout.pageH + this.layout.gap; }

  pageRect(i) {
    const L = this.layout;
    return { x: 0, y: i * this._pageStride(), w: L.pageW, h: L.pageH };
  }

  /** 내용이 있는 마지막 페이지 번호(0부터). 내용이 없으면 -1 */
  lastUsedPage() {
    if (!this.layout) return -1;
    if (this._lastUsed !== undefined) return this._lastUsed;
    const b = this._contentBounds(0);
    this._lastUsed = b ? Math.max(0, Math.floor(Math.max(0, b.maxY) / this._pageStride())) : -1;
    return this._lastUsed;
  }

  /** 화면에 보이는 페이지 수 — 쓴 페이지 다음에 빈 페이지 하나를 늘 둔다 */
  pageCount() {
    if (!this.layout) return 0;
    return Math.max(this.layout.minPages || 1, this.lastUsedPage() + 2);
  }

  /** 페이지 폭을 화면 폭에 맞춘다 (가운데 정렬, 첫 페이지 위쪽) */
  fitWidth(maxScale = 1.25) {
    if (!this.layout) return;
    const I = this.insets;
    const availW = Math.max(100, this.cssW - I.left - I.right - 32);
    this.scale = Math.max(this.minScale, Math.min(maxScale, availW / this.layout.pageW));
    this.tx = I.left + (this.cssW - I.left - I.right - this.layout.pageW * this.scale) / 2;
    this.ty = I.top + 16;
    this.requestRender(true);
    this._emitViewport();
  }

  /** 페이지 모드에서 문서 밖으로 너무 멀리 나가지 않게 뷰를 묶는다 */
  _clampView() {
    if (!this.layout) return;
    const I = this.insets;
    const pad = 16;
    const docW = this.layout.pageW * this.scale;
    const docH = (this.pageCount() * this._pageStride() - this.layout.gap) * this.scale;
    const viewW = this.cssW - I.left - I.right;
    if (docW <= viewW) this.tx = I.left + (viewW - docW) / 2;
    else this.tx = Math.min(I.left + pad, Math.max(this.cssW - I.right - pad - docW, this.tx));
    const maxTy = I.top + pad;
    const minTy = Math.min(maxTy, this.cssH - I.bottom - pad - docH);
    this.ty = Math.min(maxTy, Math.max(minTy, this.ty));
  }

  /** 스크롤 (화면 px) — 페이지 모드 목록/버튼용 */
  scrollBy(dx, dy) {
    this.tx -= dx; this.ty -= dy;
    this.requestRender(true);
    this._emitViewport();
  }

  zoomBy(factor, cx, cy) {
    const rect = this.canvas.getBoundingClientRect();
    if (cx == null) { cx = rect.width / 2; cy = rect.height / 2; }
    const next = Math.min(this.maxScale, Math.max(this.minScale, this.scale * factor));
    const k = next / this.scale;
    // cx, cy(화면 좌표)를 고정점으로 확대/축소
    this.tx = cx - (cx - this.tx) * k;
    this.ty = cy - (cy - this.ty) * k;
    this.scale = next;
    this.requestRender(true);
    this._emitViewport();
  }

  /* ============== 실행 취소 / 다시 실행 ============== */
  _pushUndo(op) {
    this.undoStack.push(op);
    if (this.undoStack.length > this.HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    if (this.readonly) return;
    const op = this.undoStack.pop();
    if (!op) return;
    this.clearSelection();
    this._applyInverse(op);
    this.redoStack.push(op);
    this.requestRender(true);
    this._emitChange(true);
  }

  redo() {
    if (this.readonly) return;
    const op = this.redoStack.pop();
    if (!op) return;
    this.clearSelection();
    this._applyForward(op);
    this.undoStack.push(op);
    this.requestRender(true);
    this._emitChange(true);
  }

  _applyForward(op) {
    if (op.type === 'add') {
      this.strokes.push(op.stroke);
    } else if (op.type === 'add-multi') {
      this.strokes.push(...op.strokes);
    } else if (op.type === 'remove') {
      const ids = new Set(op.entries.map(e => e.stroke));
      this.strokes = this.strokes.filter(s => !ids.has(s));
    } else if (op.type === 'move') {
      for (const s of op.strokes) translateStroke(s, op.dx, op.dy);
    } else if (op.type === 'clear') {
      this.strokes = [];
    } else if (op.type === 'edit') {
      applyTextState(op.stroke, op.after);
    } else if (op.type === 'replace') {
      restoreSnapshot(op.stroke, op.after);
    }
  }

  _applyInverse(op) {
    if (op.type === 'add') {
      const i = this.strokes.lastIndexOf(op.stroke);
      if (i >= 0) this.strokes.splice(i, 1);
    } else if (op.type === 'add-multi') {
      const ids = new Set(op.strokes);
      this.strokes = this.strokes.filter(s => !ids.has(s));
    } else if (op.type === 'remove') {
      // 원래 위치(index)에 정렬 삽입하여 겹침 순서 유지
      const entries = [...op.entries].sort((a, b) => a.index - b.index);
      for (const e of entries) {
        const i = Math.min(e.index, this.strokes.length);
        this.strokes.splice(i, 0, e.stroke);
      }
    } else if (op.type === 'move') {
      for (const s of op.strokes) translateStroke(s, -op.dx, -op.dy);
    } else if (op.type === 'clear') {
      this.strokes = op.strokes.slice();
    } else if (op.type === 'edit') {
      applyTextState(op.stroke, op.before);
    } else if (op.type === 'replace') {
      restoreSnapshot(op.stroke, op.before);
    }
  }

  clearAll() {
    if (this.readonly) return;
    if (this.strokes.length === 0) return;
    this.clearSelection();
    this._pushUndo({ type: 'clear', strokes: this.strokes.slice() });
    this.strokes = [];
    this.requestRender(true);
    this._emitChange(true);
  }

  /* ============== 선택 (올가미) ============== */
  clearSelection() {
    if (!this.selection) return;
    this.selection = null;
    this.requestRender();
    this._emitSelection();
  }

  _setSelection(strokes) {
    if (!strokes || strokes.length === 0) {
      this.clearSelection();
      return;
    }
    this.selection = { strokes: new Set(strokes), bbox: this._bboxOf(strokes) };
    this.requestRender();
    this._emitSelection();
  }

  _bboxOf(strokes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokes) {
      const half = (s.size || 0) / 2 + 2;
      for (const [x, y] of strokeSamplePoints(s)) {
        if (x - half < minX) minX = x - half;
        if (y - half < minY) minY = y - half;
        if (x + half > maxX) maxX = x + half;
        if (y + half > maxY) maxY = y + half;
      }
    }
    return { minX, minY, maxX, maxY };
  }

  selectedStrokes() {
    return this.selection ? [...this.selection.strokes] : [];
  }

  deleteSelection() {
    if (this.readonly || !this.selection) return;
    const entries = [];
    for (let i = 0; i < this.strokes.length; i++) {
      if (this.selection.strokes.has(this.strokes[i])) {
        entries.push({ stroke: this.strokes[i], index: i });
      }
    }
    if (entries.length === 0) return;
    const ids = new Set(entries.map(e => e.stroke));
    this.strokes = this.strokes.filter(s => !ids.has(s));
    this._pushUndo({ type: 'remove', entries });
    this.clearSelection();
    this.requestRender(true);
    this._emitChange(true);
  }

  duplicateSelection() {
    if (this.readonly || !this.selection) return;
    const offset = 24;
    const clones = this.selectedStrokes().map(s => {
      const c = JSON.parse(JSON.stringify(s));
      translateStroke(c, offset, offset);
      return c;
    });
    this.strokes.push(...clones);
    this._pushUndo({ type: 'add-multi', strokes: clones });
    this._setSelection(clones);
    this.requestRender(true);
    this._emitChange(true);
  }

  /* ============== 이미지 삽입 ============== */

  /** 이미지를 뷰포트 중앙에 삽입하고 바로 선택 상태로 만든다 (올가미로 이동 가능) */
  addImage(src, naturalW, naturalH, extra = null) {
    if (this.readonly || !naturalW || !naturalH) return null;
    const rect = this.canvas.getBoundingClientRect();
    const center = this.screenToWorld(rect.width / 2, rect.height / 2);
    // 화면의 60%를 넘지 않게 축소 배치
    const maxW = (rect.width * 0.6) / this.scale;
    const maxH = (rect.height * 0.6) / this.scale;
    const k = Math.min(1, maxW / naturalW, maxH / naturalH);
    const w = naturalW * k, h = naturalH * k;
    const at = this._freeSpot(center.x - w / 2, center.y - h / 2, w, h);
    const stroke = Object.assign({
      tool: 'image', src, size: 0, t: Date.now(),
      points: [[round2(at.x), round2(at.y)], [round2(at.x + w), round2(at.y + h)]],
    }, extra || {});
    this.strokes.push(stroke);
    this._pushUndo({ type: 'add', stroke });
    this._setSelection([stroke]);
    this.requestRender(true);
    this._emitChange(true);
    return stroke;
  }

  /**
   * 표를 뷰포트 가운데(페이지 안)에 넣고 선택한다.
   * table: { rows, cols, cells?: string[][], header?: boolean, width? }
   */
  addTable(table) {
    if (this.readonly) return null;
    const rows = Math.max(1, table.rows | 0), cols = Math.max(1, table.cols | 0);
    const rect = this.canvas.getBoundingClientRect();
    const center = this.screenToWorld(rect.width / 2, rect.height / 2);
    let width = table.width || Math.min(600, (rect.width * 0.8) / this.scale);
    let x = center.x - width / 2, y = center.y - 60;
    if (this.layout) {
      const i = Math.max(0, Math.floor(center.y / this._pageStride()));
      const r = this.pageRect(i);
      width = Math.min(width, r.w - 48);
      x = Math.max(r.x + 24, Math.min(x, r.x + r.w - 24 - width));
      y = Math.max(r.y + PAGE_HEADER_H + 16, Math.min(y, r.y + r.h - 120));
    }
    const stroke = {
      tool: 'table', size: 0, t: Date.now(), color: '#1f2328', fontSize: TABLE_TEXT,
      header: table.header !== false,
      rows, cols,
      cells: normalizeCells(table.cells, rows, cols),
      colW: Array.from({ length: cols }, () => round2(width / cols)),
      rowH: [],
      points: [[round2(x), round2(y)], [round2(x + width), round2(y)]],
    };
    this.layoutTable(stroke);
    const th = stroke.points[1][1] - stroke.points[0][1];
    const at = this._freeSpot(stroke.points[0][0], stroke.points[0][1], width, th);
    translateStroke(stroke, at.x - stroke.points[0][0], at.y - stroke.points[0][1]);
    this.strokes.push(stroke);
    this._pushUndo({ type: 'add', stroke });
    this._setSelection([stroke]);
    this.requestRender(true);
    this._emitChange(true);
    return stroke;
  }

  /** 표의 줄 높이·오른쪽 아래 모서리를 칸 글에 맞춰 다시 계산한다 */
  layoutTable(s) {
    const ctx = this.bgCtx;
    ctx.save();
    ctx.font = `${s.fontSize || TABLE_TEXT}px ${TEXT_FONT}`;
    const lh = (s.fontSize || TABLE_TEXT) * TABLE_LINE;
    s.rowH = [];
    for (let r = 0; r < s.rows; r++) {
      let h = TABLE_ROW_MIN;
      for (let c = 0; c < s.cols; c++) {
        const text = (s.cells[r] && s.cells[r][c]) || '';
        if (!text) continue;
        const lines = wrapText(ctx, text, s.colW[c] - TABLE_PAD * 2);
        h = Math.max(h, lines.length * lh + TABLE_PAD * 2);
      }
      s.rowH.push(round2(h));
    }
    ctx.restore();
    const [x0, y0] = s.points[0];
    s.points[1] = [round2(x0 + s.colW.reduce((a, b) => a + b, 0)), round2(y0 + s.rowH.reduce((a, b) => a + b, 0))];
    return s;
  }

  /**
   * 객체(표·삽입 그림·글상자) 내용을 바꾼다 — 실행 취소 한 단위.
   * patch 의 키로 덮어쓰고, 표는 다시 배치한다.
   */
  updateObject(stroke, patch) {
    if (this.readonly || !stroke) return;
    const before = snapshotStroke(stroke);
    Object.assign(stroke, JSON.parse(JSON.stringify(patch)));
    if (stroke.tool === 'table') {
      stroke.cells = normalizeCells(stroke.cells, stroke.rows, stroke.cols);
      if (!Array.isArray(stroke.colW) || stroke.colW.length !== stroke.cols) {
        const w = Math.abs(before.points[1][0] - before.points[0][0]);
        stroke.colW = Array.from({ length: stroke.cols }, () => round2(w / stroke.cols));
      }
      this.layoutTable(stroke);
    }
    this._pushUndo({ type: 'replace', stroke, before, after: snapshotStroke(stroke) });
    if (this.selection && this.selection.strokes.has(stroke)) this.selection.bbox = this._bboxOf([stroke]);
    this.requestRender(true);
    this._emitChange(true);
    this._emitSelection();
  }

  /**
   * 새 객체 자리: 다른 객체와 겹치면 그 아래로 내리고, 페이지 모드에서는 페이지 경계를 넘지 않게
   * 다음 페이지 위쪽으로 보낸다(페이지 이미지가 둘로 잘리지 않게).
   */
  _freeSpot(x, y, w, h) {
    for (let n = 0; n < 40; n++) {
      if (this.layout) {
        const stride = this._pageStride();
        const i = Math.max(0, Math.floor(y / stride));
        const r = this.pageRect(i);
        if (y < r.y + PAGE_HEADER_H + 12) y = r.y + PAGE_HEADER_H + 12;
        if (y + h > r.y + r.h - 12 && h < r.h - PAGE_HEADER_H - 24) { y = r.y + stride + PAGE_HEADER_H + 12; continue; }
      }
      const hit = this.strokes.find((s) => {
        if (!isBoxObject(s)) return false;
        const [[ax, ay], [bx, by]] = s.points;
        return x < Math.max(ax, bx) && x + w > Math.min(ax, bx) && y < Math.max(ay, by) && y + h > Math.min(ay, by);
      });
      if (!hit) break;
      y = Math.max(hit.points[0][1], hit.points[1][1]) + 16;
    }
    return { x, y };
  }

  /** 월드 좌표에 있는 객체(그림·글상자·표) — 위에 있는 것 우선 */
  objectAt(wx, wy) {
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const s = this.strokes[i];
      if (!isBoxObject(s)) continue;
      const [[ax, ay], [bx, by]] = s.points;
      if (wx >= Math.min(ax, bx) && wx <= Math.max(ax, bx) && wy >= Math.min(ay, by) && wy <= Math.max(ay, by)) return s;
    }
    return null;
  }

  /** 확정된 글상자를 뷰포트 가운데에 바로 넣는다 (날짜·시각 도장 등) */
  addTextBox(text, opts = {}) {
    if (this.readonly || !text) return null;
    const rect = this.canvas.getBoundingClientRect();
    const c = this.screenToWorld(rect.width / 2, rect.height / 2);
    const fs = opts.fontSize || TEXT_SIZE;
    let x = c.x - 160, w = opts.width || 320;
    if (this.layout) {
      const r = this.pageRect(Math.max(0, Math.floor(c.y / this._pageStride())));
      x = Math.max(r.x + 24, Math.min(x, r.x + r.w - 24 - w));
    }
    const stroke = {
      tool: 'text', text, color: opts.color || this.color, fontSize: fs, size: 0, t: Date.now(),
      points: [[round2(x), round2(c.y)], [round2(x + w), round2(c.y + fs * TEXT_LINE + TEXT_PAD * 2)]],
    };
    this._fitTextHeight(stroke);
    const bh = stroke.points[1][1] - stroke.points[0][1];
    const at = this._freeSpot(stroke.points[0][0], stroke.points[0][1], w, bh);
    translateStroke(stroke, at.x - stroke.points[0][0], at.y - stroke.points[0][1]);
    this.strokes.push(stroke);
    this._pushUndo({ type: 'add', stroke });
    this._setSelection([stroke]);
    this.requestRender(true);
    this._emitChange(true);
    return stroke;
  }

  /** 객체 하나만 선택 (삽입 직후·다시 고친 뒤) */
  selectObject(stroke) {
    if (stroke && this.strokes.includes(stroke)) this._setSelection([stroke]);
  }

  _getImage(src) {
    let img = this._imgCache.get(src);
    if (!img) {
      img = new Image();
      img.onload = () => this.requestRender(true);
      img.src = src;
      this._imgCache.set(src, img);
    }
    return img;
  }

  _selectionContains(wx, wy) {
    if (!this.selection) return false;
    const m = 10 / this.scale; // 여유
    const b = this.selection.bbox;
    return wx >= b.minX - m && wx <= b.maxX + m && wy >= b.minY - m && wy <= b.maxY + m;
  }

  /* ============== 이벤트 바인딩 ============== */
  _bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => this._onPointerDown(e));
    c.addEventListener('pointermove', e => this._onPointerMove(e));
    c.addEventListener('pointerup', e => this._onPointerUp(e));
    c.addEventListener('pointercancel', e => this._onPointerUp(e));
    c.addEventListener('pointerleave', e => { if (!this.drawing) this.eraserPos = null, this.requestRender(); });
    c.addEventListener('wheel', e => this._onWheel(e), { passive: false });
    c.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('resize', () => this.resize());
  }

  _isPen(e) { return e.pointerType === 'pen'; }

  // 펜의 지우개 단(barrel eraser) 또는 지우개 버튼: buttons 비트 32
  _isPenEraser(e) { return e.pointerType === 'pen' && (e.buttons & 32) !== 0; }

  _rejectPalm(e) {
    // 펜이 활성/최근 사용 중이면 손바닥(터치) 입력 무시
    return e.pointerType === 'touch' &&
      (this._penPointerActive() || performance.now() - this.penLastSeen < 600);
  }

  _penPointerActive() {
    for (const p of this.pointers.values()) if (p.type === 'pen') return true;
    return false;
  }

  _pos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _onPointerDown(e) {
    if (e.button === 2) return; // 우클릭은 무시

    if (this._isPen(e)) {
      this.penLastSeen = performance.now();
      if (this.touchDraws && this.opts.onPenDetected) {
        // 펜이 감지되면 앱에 알려 손가락 그리기를 자동으로 끔
        this.opts.onPenDetected();
      }
    }
    if (this._rejectPalm(e)) return;

    // 글상자 편집 중에 캔버스를 누르면 먼저 확정한다
    if (this.textEdit) this._endTextEdit(true);

    const { x, y } = this._pos(e);
    this.pointers.set(e.pointerId, { x, y, type: e.pointerType });
    try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}

    const touchPointers = [...this.pointers.values()].filter(p => p.type === 'touch');

    // 손가락 두 개 → 핀치 제스처 시작 (직전에 시작된 짧은 획은 취소)
    if (e.pointerType === 'touch' && touchPointers.length === 2) {
      if (this.drawing && this.drawing.pointerType === 'touch') this._cancelStroke();
      this._startGesture();
      return;
    }
    if (this.gesture) return;

    // 읽기 전용 모드: 어떤 포인터든 화면 이동만 (핀치 줌은 위에서 처리됨)
    if (this.readonly) {
      this.gesture = { mode: 'pan', lastX: x, lastY: y, pointerId: e.pointerId };
      this.canvas.classList.add('dragging');
      return;
    }

    const isMiddlePan = e.pointerType === 'mouse' && e.button === 1;
    const touchPans = e.pointerType === 'touch' && !this.touchDraws;

    if (this.tool === 'pan' || isMiddlePan || touchPans) {
      this.gesture = { mode: 'pan', lastX: x, lastY: y, pointerId: e.pointerId };
      this.canvas.classList.add('dragging');
      return;
    }

    const w = this.screenToWorld(x, y);

    // 올가미 도구: 선택 영역 안이면 이동, 밖이면 새 올가미
    if (this.tool === 'lasso') {
      if (this.selection && this._selectionContains(w.x, w.y)) {
        this.drawing = {
          selMove: true, pointerId: e.pointerId, pointerType: e.pointerType,
          lastWX: w.x, lastWY: w.y, totalDx: 0, totalDy: 0,
        };
        return;
      }
      this.clearSelection();
      this.lassoPath = [[w.x, w.y]];
      this.drawing = { lasso: true, pointerId: e.pointerId, pointerType: e.pointerType };
      this.requestRender();
      return;
    }

    // 다른 도구를 쓰기 시작하면 선택 해제
    this.clearSelection();

    // 글상자: 누른 곳의 글상자를 고치거나 새로 만든다 (손가락 스크롤과 구분되도록 탭에서 처리)
    if (this.tool === 'text') {
      this.drawing = { textTap: true, pointerId: e.pointerId, pointerType: e.pointerType, sx: x, sy: y, wx: w.x, wy: w.y };
      return;
    }

    const erasing = this.tool === 'eraser' || this._isPenEraser(e);
    if (erasing) {
      this.erasedInDrag = [];
      this.drawing = { erasing: true, pointerId: e.pointerId, pointerType: e.pointerType };
      this._eraseAt(x, y);
      this.eraserPos = { x, y };
      this.requestRender();
      return;
    }

    // 도형 그리기 시작
    if (this.tool === 'shape') {
      this.drawing = {
        shapeDraw: true, pointerId: e.pointerId, pointerType: e.pointerType,
        stroke: {
          tool: 'shape', shape: this.shape, color: this.color, size: this.size,
          t: Date.now(), // 작성 시각 (연구노트 증적용)
          points: [[round2(w.x), round2(w.y)], [round2(w.x), round2(w.y)]],
        },
      };
      this.requestRender();
      return;
    }

    // 자유 곡선 그리기 시작
    const stroke = {
      tool: this.tool === 'highlighter' ? 'highlighter' : 'pen',
      color: this.color,
      size: this.tool === 'highlighter' ? this.size * 3.2 : this.size,
      t: Date.now(), // 작성 시각 (연구노트 증적용)
      points: [[round2(w.x), round2(w.y), round2(this._pressure(e))]],
    };
    this.drawing = {
      stroke,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      lastSX: x, lastSY: y,
      smoothP: this._pressure(e),
    };
    this.requestRender();
  }

  _pressure(e) {
    // 마우스/터치는 pressure가 0.5 고정이거나 0 → 중간값으로 정규화
    let p = e.pressure;
    if (e.pointerType !== 'pen' || !p) p = 0.5;
    return Math.min(1, Math.max(0.05, p));
  }

  _onPointerMove(e) {
    if (this.tool === 'eraser' && !this.drawing) {
      // 지우개 커서 미리보기
      this.eraserPos = this._pos(e);
      this.requestRender();
    }
    if (!this.pointers.has(e.pointerId)) return;
    if (this._isPen(e)) this.penLastSeen = performance.now();

    const { x, y } = this._pos(e);
    const rec = this.pointers.get(e.pointerId);
    rec.x = x; rec.y = y;

    if (this.gesture) {
      this._updateGesture(e, x, y);
      return;
    }

    const d = this.drawing;
    if (!d || d.pointerId !== e.pointerId) return;
    const w = this.screenToWorld(x, y);

    if (d.textTap) {
      // 많이 움직이면 탭이 아니라 스크롤로 본다
      if (Math.hypot(x - d.sx, y - d.sy) > 10) {
        this.drawing = null;
        this.gesture = { mode: 'pan', lastX: x, lastY: y, pointerId: e.pointerId };
        this.canvas.classList.add('dragging');
      }
      return;
    }

    if (d.erasing) {
      this._eraseAt(x, y);
      this.eraserPos = { x, y };
      this.requestRender();
      return;
    }

    if (d.shapeDraw) {
      d.stroke.points[1] = [round2(w.x), round2(w.y)];
      this.requestRender();
      return;
    }

    if (d.lasso) {
      const last = this.lassoPath[this.lassoPath.length - 1];
      const dx = w.x - last[0], dy = w.y - last[1];
      const min = 2 / this.scale;
      if (dx * dx + dy * dy > min * min) this.lassoPath.push([w.x, w.y]);
      this.requestRender();
      return;
    }

    if (d.selMove) {
      const dx = w.x - d.lastWX, dy = w.y - d.lastWY;
      if (dx === 0 && dy === 0) return;
      d.lastWX = w.x; d.lastWY = w.y;
      d.totalDx += dx; d.totalDy += dy;
      for (const s of this.selection.strokes) translateStroke(s, dx, dy);
      const b = this.selection.bbox;
      b.minX += dx; b.maxX += dx; b.minY += dy; b.maxY += dy;
      this.requestRender(true);
      this._emitSelection();
      return;
    }

    // 자유 곡선: 고주파 샘플까지 모두 사용해 부드럽게 (빈 배열이면 원본 이벤트 사용)
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    const events = coalesced && coalesced.length ? coalesced : [e];
    for (const ev of events) {
      const p = this._pos(ev);
      const dx = p.x - d.lastSX, dy = p.y - d.lastSY;
      if (dx * dx + dy * dy < 0.7 * 0.7) continue;  // 너무 촘촘한 점은 생략
      d.lastSX = p.x; d.lastSY = p.y;
      // 필압은 EMA로 완만하게
      d.smoothP = d.smoothP * 0.6 + this._pressure(ev) * 0.4;
      const wp = this.screenToWorld(p.x, p.y);
      d.stroke.points.push([round2(wp.x), round2(wp.y), round2(d.smoothP)]);
    }
    this.requestRender();
  }

  _onPointerUp(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    if (this._isPen(e)) this.penLastSeen = performance.now();

    if (this.gesture) {
      const touchLeft = [...this.pointers.values()].filter(p => p.type === 'touch').length;
      if (this.gesture.mode === 'pinch' && touchLeft < 2) this.gesture = null;
      if (this.gesture && this.gesture.mode === 'pan' && this.gesture.pointerId === e.pointerId) this.gesture = null;
      if (!this.gesture) this.canvas.classList.remove('dragging');
      return;
    }

    const d = this.drawing;
    if (!d || d.pointerId !== e.pointerId) return;

    if (d.textTap) {
      this.drawing = null;
      const hit = this.textAt(d.wx, d.wy);
      if (hit) this.editText(hit);
      else this.addText(d.wx, d.wy);
      return;
    }

    if (d.erasing) {
      if (this.erasedInDrag.length > 0) {
        this._pushUndo({ type: 'remove', entries: this.erasedInDrag });
        this._emitChange(true);
      }
      this.erasedInDrag = [];
      this.drawing = null;
      if (this.tool !== 'eraser') this.eraserPos = null;
      this.requestRender();
      return;
    }

    if (d.shapeDraw) {
      const [[x0, y0], [x1, y1]] = d.stroke.points;
      this.drawing = null;
      // 크기가 너무 작으면 무시 (탭 실수)
      if (Math.hypot(x1 - x0, y1 - y0) * this.scale > 4) {
        this.strokes.push(d.stroke);
        this._pushUndo({ type: 'add', stroke: d.stroke });
        this._emitChange(true);
      }
      this.requestRender(true);
      return;
    }

    if (d.lasso) {
      const path = this.lassoPath;
      this.lassoPath = null;
      this.drawing = null;
      if (path && pathExtent(path) * this.scale < 12) {
        // 짧게 누름 = 누른 곳의 객체 선택
        const [px, py] = path[0];
        const hit = this.objectAt(px, py);
        if (hit) this._setSelection([hit]);
      } else if (path && path.length >= 3) {
        this._setSelection(this._strokesInPolygon(path));
      }
      this.requestRender();
      return;
    }

    if (d.selMove) {
      this.drawing = null;
      if (d.totalDx !== 0 || d.totalDy !== 0) {
        this._pushUndo({
          type: 'move', strokes: this.selectedStrokes(),
          dx: d.totalDx, dy: d.totalDy,
        });
        this._emitChange(true);
      }
      this.requestRender(true);
      return;
    }

    // 탭 한 번 → 점 하나 찍기 허용
    this.strokes.push(d.stroke);
    this._pushUndo({ type: 'add', stroke: d.stroke });
    this.drawing = null;
    this.requestRender(true);
    this._emitChange(true);
  }

  _cancelStroke() {
    this.drawing = null;
    this.lassoPath = null;
    this.requestRender();
  }

  _cancelInput() {
    this.drawing = null;
    this.gesture = null;
    this.pointers.clear();
    this.eraserPos = null;
    this.lassoPath = null;
  }

  _strokesInPolygon(polygon) {
    const result = [];
    for (const s of this.strokes) {
      const pts = strokeSamplePoints(s);
      let inside = 0;
      for (const [x, y] of pts) {
        if (pointInPolygon(x, y, polygon)) inside++;
      }
      if (inside >= Math.max(1, pts.length * 0.55)) result.push(s);
    }
    return result;
  }

  /* ============== 제스처 (핀치 줌 / 패닝) ============== */
  _startGesture() {
    const touches = [...this.pointers.values()].filter(p => p.type === 'touch');
    if (touches.length < 2) return;
    const [a, b] = touches;
    this.gesture = {
      mode: 'pinch',
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
    };
  }

  _updateGesture(e, x, y) {
    const g = this.gesture;
    if (g.mode === 'pan') {
      if (g.pointerId !== e.pointerId) return;
      this.tx += x - g.lastX;
      this.ty += y - g.lastY;
      g.lastX = x; g.lastY = y;
      this.requestRender(true);
      this._emitViewport();
      return;
    }
    // pinch
    const touches = [...this.pointers.values()].filter(p => p.type === 'touch');
    if (touches.length < 2) return;
    const [a, b] = touches;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;

    if (g.dist > 0) {
      const factor = dist / g.dist;
      const next = Math.min(this.maxScale, Math.max(this.minScale, this.scale * factor));
      const k = next / this.scale;
      this.tx = cx - (cx - this.tx) * k;
      this.ty = cy - (cy - this.ty) * k;
      this.scale = next;
    }
    this.tx += cx - g.cx;
    this.ty += cy - g.cy;

    g.dist = dist; g.cx = cx; g.cy = cy;
    this.requestRender(true);
    this._emitViewport();
  }

  _onWheel(e) {
    e.preventDefault();
    const { x, y } = this._pos(e);
    if (e.ctrlKey || e.metaKey) {
      // 트랙패드 핀치 / Ctrl+휠 → 줌
      const factor = Math.exp(-e.deltaY * 0.002);
      this.zoomBy(factor, x, y);
    } else {
      this.tx -= e.deltaX;
      this.ty -= e.deltaY;
      this.requestRender(true);
      this._emitViewport();
    }
  }

  /* ============== 지우개 ============== */
  get eraserRadius() { return 16; } // 화면 픽셀 기준

  _eraseAt(sx, sy) {
    const w = this.screenToWorld(sx, sy);
    const r = this.eraserRadius / this.scale;
    let removedAny = false;
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const s = this.strokes[i];
      // 이미지는 지우개로 지우지 않는다 (사진 위 주석을 지우다 배경까지 지워지는 것 방지)
      // → 이미지 삭제는 올가미 선택 후 삭제로만
      if (isBoxObject(s)) continue;
      if (this._strokeHit(s, w.x, w.y, r + s.size / 2)) {
        this.erasedInDrag.push({ stroke: s, index: i });
        this.strokes.splice(i, 1);
        removedAny = true;
      }
    }
    if (removedAny) this.requestRender(true);
  }

  _strokeHit(stroke, x, y, r) {
    const r2 = r * r;
    if (isBoxObject(stroke)) {
      const [[ax, ay], [bx, by]] = stroke.points;
      return x >= Math.min(ax, bx) - r && x <= Math.max(ax, bx) + r &&
             y >= Math.min(ay, by) - r && y <= Math.max(ay, by) + r;
    }
    // 도형은 외곽선 샘플 선분과의 거리로 판정
    const pts = stroke.tool === 'shape' ? shapeOutline(stroke) : stroke.points;
    if (pts.length === 1) {
      const dx = pts[0][0] - x, dy = pts[0][1] - y;
      return dx * dx + dy * dy <= r2;
    }
    for (let i = 1; i < pts.length; i++) {
      if (distToSegmentSq(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= r2) {
        return true;
      }
    }
    return false;
  }

  /* ============== 렌더링 ============== */
  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.cssW = Math.max(1, rect.width);
    this.cssH = Math.max(1, rect.height);
    this.dpr = dpr;
    for (const c of [this.canvas, this.bg]) {
      c.width = Math.round(this.cssW * dpr);
      c.height = Math.round(this.cssH * dpr);
    }
    this.canvas.style.width = this.cssW + 'px';
    this.canvas.style.height = this.cssH + 'px';
    this._clampView();
    this._positionTextInput();
    this.requestRender(true);
  }

  requestRender(bgDirty = false) {
    if (bgDirty) this._bgDirty = true;
    this._dirty = true;
    if (this._raf == null) {
      this._raf = requestAnimationFrame(() => {
        this._raf = null;
        if (this._dirty) this._render();
      });
    }
  }

  _applyTransform(ctx) {
    ctx.setTransform(this.scale * this.dpr, 0, 0, this.scale * this.dpr,
      this.tx * this.dpr, this.ty * this.dpr);
  }

  _render() {
    this._dirty = false;

    if (this._bgDirty) {
      this._bgDirty = false;
      this._renderBackground();
    }

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.bg, 0, 0);

    // 진행 중인 획 / 도형 미리보기
    const d = this.drawing;
    if (d && d.stroke) {
      this._applyTransform(ctx);
      this._drawStroke(ctx, d.stroke);
    }

    // 올가미 미리보기
    if (this.lassoPath && this.lassoPath.length > 1) {
      this._applyTransform(ctx);
      ctx.beginPath();
      ctx.moveTo(this.lassoPath[0][0], this.lassoPath[0][1]);
      for (const [x, y] of this.lassoPath) ctx.lineTo(x, y);
      ctx.setLineDash([6 / this.scale, 5 / this.scale]);
      ctx.lineWidth = 1.5 / this.scale;
      ctx.strokeStyle = '#2563eb';
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 선택 표시: 반투명 강조 + 점선 테두리
    if (this.selection) {
      this._applyTransform(ctx);
      ctx.globalAlpha = 0.25;
      for (const s of this.selection.strokes) {
        this._drawStroke(ctx, s, { color: '#2563eb', widthBoost: 5 });
      }
      ctx.globalAlpha = 1;
      const b = this.selection.bbox;
      ctx.setLineDash([7 / this.scale, 5 / this.scale]);
      ctx.lineWidth = 1.5 / this.scale;
      ctx.strokeStyle = '#2563eb';
      ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
      ctx.setLineDash([]);
    }

    // 지우개 커서
    if (this.eraserPos && (this.tool === 'eraser' || (d && d.erasing))) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.beginPath();
      ctx.arc(this.eraserPos.x, this.eraserPos.y, this.eraserRadius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(120,126,134,.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = 'rgba(120,126,134,.15)';
      ctx.fill();
    }
  }

  _renderBackground() {
    const ctx = this.bgCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.layout) {
      this._renderPagesBackground(ctx);
    } else {
      // 종이는 항상 흰색 (다크 모드에서도 필기 대비 유지)
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.bg.width, this.bg.height);
      if (this.showGrid) this._drawGrid(ctx);
    }

    this._applyTransform(ctx);
    for (const s of this.strokes) {
      if (this.textEdit && s === this.textEdit.stroke) continue; // 편집 중인 글은 오버레이가 그린다
      this._drawStroke(ctx, s);
    }
  }

  /** 책상(바탕) + 보이는 페이지들 */
  _renderPagesBackground(ctx) {
    ctx.fillStyle = PAGE_DESK;
    ctx.fillRect(0, 0, this.bg.width, this.bg.height);
    const count = this.pageCount();
    const top = this.screenToWorld(0, 0).y, bottom = this.screenToWorld(0, this.cssH).y;
    const stride = this._pageStride();
    const first = Math.max(0, Math.floor(top / stride));
    const last = Math.min(count - 1, Math.floor(bottom / stride));
    for (let i = first; i <= last; i++) {
      const r = this.pageRect(i);
      // 종이 그림자 (아래로 살짝, 부드럽게)
      this._applyTransform(ctx);
      ctx.save();
      ctx.shadowColor = 'rgba(16, 24, 40, 0.10)';
      ctx.shadowBlur = 14 * this.dpr;
      ctx.shadowOffsetY = 3 * this.dpr;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.restore();
      this._drawPaper(ctx, i, count, 1 / this.scale);
    }
  }

  /** 페이지 i 의 모눈·머리글 (월드 좌표 변환이 걸린 ctx 에 그린다). hair = 1 화면 px 의 월드 길이 */
  _drawPaper(ctx, i, count, hair) {
    const r = this.pageRect(i);
    const hh = PAGE_HEADER_H;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    if (this.showGrid) {
      ctx.strokeStyle = PAGE_GRID;
      ctx.lineWidth = Math.max(hair, 0.6);
      ctx.beginPath();
      for (let gx = r.x + PAGE_GRID_STEP; gx < r.x + r.w; gx += PAGE_GRID_STEP) {
        ctx.moveTo(gx, r.y + hh); ctx.lineTo(gx, r.y + r.h);
      }
      for (let gy = r.y + hh + PAGE_GRID_STEP; gy < r.y + r.h; gy += PAGE_GRID_STEP) {
        ctx.moveTo(r.x, gy); ctx.lineTo(r.x + r.w, gy);
      }
      ctx.stroke();
    }
    // 머리글: 왼쪽 (제목·날짜), 오른쪽 (쪽 번호) + 가는 구분선
    const head = this.pageHeader ? this.pageHeader(i, count)
      : { left: this.title, right: `${this.layout.date ? this.layout.date + ' · ' : ''}${i + 1}쪽` };
    ctx.fillStyle = PAGE_HEAD_INK;
    ctx.font = `500 13px ${TEXT_FONT}`;
    ctx.textBaseline = 'middle';
    const my = r.y + hh / 2 + 2;
    if (head && head.left) {
      ctx.textAlign = 'left';
      ctx.fillText(ellipsize(ctx, head.left, r.w * 0.72), r.x + 24, my);
    }
    ctx.textAlign = 'right';
    ctx.fillText((head && head.right) || `${i + 1}쪽`, r.x + r.w - 24, my);
    ctx.textAlign = 'left';
    ctx.strokeStyle = PAGE_HEAD_RULE;
    ctx.lineWidth = Math.max(hair, 0.8);
    ctx.beginPath();
    ctx.moveTo(r.x + 24, r.y + hh); ctx.lineTo(r.x + r.w - 24, r.y + hh);
    ctx.stroke();
    ctx.restore();
  }

  _drawGrid(ctx) {
    const spacing = 40; // 월드 단위
    const step = spacing * this.scale;
    if (step < 9) return; // 너무 축소되면 생략
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = 'rgba(60,70,90,.18)';
    const x0 = ((this.tx % step) + step) % step;
    const y0 = ((this.ty % step) + step) % step;
    const r = Math.min(1.6, Math.max(1, this.scale));
    for (let x = x0; x <= this.cssW; x += step) {
      for (let y = y0; y <= this.cssH; y += step) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  _drawStroke(ctx, stroke, override) {
    const pts = stroke.points;
    if (pts.length === 0) return;

    const color = override && override.color ? override.color : stroke.color;
    const boost = override && override.widthBoost ? override.widthBoost : 0;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (stroke.tool === 'image') {
      this._drawImage(ctx, stroke, override);
      return;
    }

    if (stroke.tool === 'text') {
      this._drawText(ctx, stroke, override);
      return;
    }

    if (stroke.tool === 'table') {
      this._drawTable(ctx, stroke, override);
      return;
    }

    if (stroke.tool === 'shape') {
      this._drawShape(ctx, stroke, boost);
      return;
    }

    if (stroke.tool === 'highlighter') {
      if (!override) ctx.globalAlpha = 0.32;
      ctx.lineWidth = stroke.size + boost;
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0][0], pts[0][1], (stroke.size + boost) / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // 형광펜은 굵기 일정 → 한 패스로 그려 겹침 얼룩 방지
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i][0] + pts[i + 1][0]) / 2;
          const my = (pts[i][1] + pts[i + 1][1]) / 2;
          ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last[0], last[1]);
        ctx.stroke();
      }
      if (!override) ctx.globalAlpha = 1;
      return;
    }

    // 펜: 필압에 따라 굵기가 변함 → 구간별로 굵기를 바꿔 그림
    const widthAt = p => stroke.size * (0.35 + 1.1 * p) + boost;

    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], widthAt(pts[0][2]) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    let prevMidX = pts[0][0], prevMidY = pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      const [x, y, p] = pts[i];
      const midX = i < pts.length - 1 ? (x + pts[i + 1][0]) / 2 : x;
      const midY = i < pts.length - 1 ? (y + pts[i + 1][1]) / 2 : y;
      ctx.beginPath();
      ctx.moveTo(prevMidX, prevMidY);
      ctx.quadraticCurveTo(pts[i - 1][0], pts[i - 1][1], midX, midY);
      ctx.lineWidth = Math.max(0.4, widthAt((p + pts[i - 1][2]) / 2));
      ctx.stroke();
      prevMidX = midX; prevMidY = midY;
    }
  }

  _drawImage(ctx, stroke, override) {
    const [[ax, ay], [bx, by]] = stroke.points;
    const x = Math.min(ax, bx), y = Math.min(ay, by);
    const w = Math.abs(bx - ax), h = Math.abs(by - ay);
    if (override) {
      // 선택 강조: 반투명 덮개 (호출부에서 globalAlpha 적용됨)
      ctx.fillRect(x, y, w, h);
      return;
    }
    const img = this._getImage(stroke.src);
    if (img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, x, y, w, h);
    } else {
      // 로딩 중 자리표시
      ctx.strokeStyle = '#c3c9d1';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
    }
  }

  _drawText(ctx, stroke, override) {
    const [[ax, ay], [bx, by]] = stroke.points;
    const x = Math.min(ax, bx), y = Math.min(ay, by);
    const w = Math.abs(bx - ax), h = Math.abs(by - ay);
    if (override) {
      ctx.fillRect(x, y, w, h);
      return;
    }
    const fs = stroke.fontSize || TEXT_SIZE;
    ctx.save();
    ctx.fillStyle = stroke.color || '#1f2328';
    ctx.font = `${fs}px ${TEXT_FONT}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const lh = fs * TEXT_LINE;
    const lines = wrapText(ctx, stroke.text || '', w - TEXT_PAD * 2);
    lines.forEach((line, i) => ctx.fillText(line, x + TEXT_PAD, y + TEXT_PAD + i * lh + (lh - fs) / 2));
    ctx.restore();
  }

  _drawTable(ctx, s, override) {
    const [[x0, y0], [x1, y1]] = s.points;
    if (override) {
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      return;
    }
    const colW = s.colW || [], rowH = s.rowH || [];
    ctx.save();
    // 머리글 줄 바탕
    if (s.header && rowH.length) {
      ctx.fillStyle = TABLE_HEAD_FILL;
      ctx.fillRect(x0, y0, x1 - x0, rowH[0]);
    }
    // 칸 선
    ctx.strokeStyle = TABLE_RULE;
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    let y = y0;
    for (let r = 0; r <= rowH.length; r++) {
      ctx.moveTo(x0, y); ctx.lineTo(x1, y);
      if (r < rowH.length) y += rowH[r];
    }
    let x = x0;
    for (let c = 0; c <= colW.length; c++) {
      ctx.moveTo(x, y0); ctx.lineTo(x, y1);
      if (c < colW.length) x += colW[c];
    }
    ctx.stroke();
    // 칸 글
    const fs = s.fontSize || TABLE_TEXT;
    const lh = fs * TABLE_LINE;
    ctx.fillStyle = s.color || '#1f2328';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    y = y0;
    for (let r = 0; r < rowH.length; r++) {
      ctx.font = `${s.header && r === 0 ? 600 : 400} ${fs}px ${TEXT_FONT}`;
      x = x0;
      for (let c = 0; c < colW.length; c++) {
        const text = (s.cells[r] && s.cells[r][c]) || '';
        if (text) {
          const lines = wrapText(ctx, text, colW[c] - TABLE_PAD * 2);
          lines.forEach((line, i) => ctx.fillText(line, x + TABLE_PAD, y + TABLE_PAD + i * lh + (lh - fs) / 2));
        }
        x += colW[c];
      }
      y += rowH[r];
    }
    ctx.restore();
  }

  /* ============== 글상자 ============== */

  /** 월드 좌표의 글상자 (위에 있는 것 우선) */
  textAt(wx, wy) {
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const s = this.strokes[i];
      if (s.tool !== 'text') continue;
      const [[ax, ay], [bx, by]] = s.points;
      if (wx >= Math.min(ax, bx) && wx <= Math.max(ax, bx) && wy >= Math.min(ay, by) && wy <= Math.max(ay, by)) return s;
    }
    return null;
  }

  /** (wx, wy) 에 새 글상자를 열고 편집을 시작한다 */
  addText(wx, wy) {
    if (this.readonly) return null;
    const fs = TEXT_SIZE;
    let x = wx - TEXT_PAD, y = wy - fs * TEXT_LINE / 2 - TEXT_PAD;
    let w = 440;
    if (this.layout) {
      // 누른 페이지 안에 들어가도록 (머리글 아래, 좌우 여백 안)
      const i = Math.max(0, Math.floor(wy / this._pageStride()));
      const r = this.pageRect(i);
      x = Math.max(r.x + 16, Math.min(x, r.x + r.w - 136));
      y = Math.max(r.y + PAGE_HEADER_H + 6, y);
      w = Math.min(w, r.x + r.w - 16 - x);
    }
    const stroke = {
      tool: 'text', text: '', color: this.color, fontSize: fs, size: 0,
      t: Date.now(), // 작성 시각 (연구노트 증적용)
      points: [[round2(x), round2(y)], [round2(x + w), round2(y + fs * TEXT_LINE + TEXT_PAD * 2)]],
    };
    this._beginTextEdit(stroke, true);
    return stroke;
  }

  editText(stroke) {
    if (this.readonly || !stroke || stroke.tool !== 'text') return;
    this._beginTextEdit(stroke, false);
  }

  _ensureTextInput() {
    if (this.textInput) return this.textInput;
    const ta = document.createElement('textarea');
    ta.className = 'hd-text-input';
    ta.setAttribute('aria-label', '글상자');
    ta.spellcheck = false;
    Object.assign(ta.style, {
      position: 'absolute', zIndex: '5', margin: '0', resize: 'none', overflow: 'hidden',
      border: '0', outline: '2px solid ' + TEXT_EDIT_ACCENT, outlineOffset: '0', borderRadius: '4px',
      background: 'rgba(255,255,255,0.92)', boxSizing: 'border-box', whiteSpace: 'pre-wrap',
      wordBreak: 'keep-all', overflowWrap: 'anywhere', caretColor: TEXT_EDIT_ACCENT,
    });
    ta.addEventListener('input', () => this._growTextInput());
    ta.addEventListener('blur', () => this._endTextEdit(true));
    ta.addEventListener('keydown', e => {
      e.stopPropagation(); // 앱 단축키(p, e, Delete …)가 글자 입력을 가로채지 않게
      if (e.key === 'Escape') { e.preventDefault(); ta.blur(); }
    });
    const parent = this.canvas.parentElement;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    parent.appendChild(ta);
    this.textInput = ta;
    return ta;
  }

  _beginTextEdit(stroke, isNew) {
    this._endTextEdit(true);
    this.clearSelection();
    this.textEdit = { stroke, isNew, before: textState(stroke) };
    const ta = this._ensureTextInput();
    ta.value = stroke.text || '';
    ta.style.display = 'block';
    this._positionTextInput();
    this.requestRender(true);
    // 포인터 이벤트 처리가 끝난 뒤 포커스해야 iOS 에서 키보드가 뜬다
    ta.focus({ preventScroll: true });
    setTimeout(() => { if (this.textEdit && this.textEdit.stroke === stroke) ta.focus({ preventScroll: true }); }, 0);
    if (this.opts.onTextEdit) this.opts.onTextEdit(true);
  }

  _positionTextInput() {
    if (!this.textEdit || !this.textInput) return;
    const s = this.textEdit.stroke;
    const fs = (s.fontSize || TEXT_SIZE) * this.scale;
    const [[ax, ay], [bx]] = s.points;
    const ta = this.textInput;
    Object.assign(ta.style, {
      left: (Math.min(ax, bx) * this.scale + this.tx) + 'px',
      top: (ay * this.scale + this.ty) + 'px',
      width: (Math.abs(bx - ax) * this.scale) + 'px',
      font: `${fs}px ${TEXT_FONT}`,
      lineHeight: String(TEXT_LINE),
      padding: (TEXT_PAD * this.scale) + 'px',
      color: s.color || '#1f2328',
    });
    this._growTextInput();
  }

  _growTextInput() {
    const ta = this.textInput;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  /** 글상자 편집 종료. commit=false 면 변경을 버린다 */
  _endTextEdit(commit) {
    const te = this.textEdit;
    if (!te) return;
    this.textEdit = null;
    const ta = this.textInput;
    const value = ta ? ta.value.replace(/\s+$/, '') : te.stroke.text;
    if (ta) { ta.style.display = 'none'; if (document.activeElement === ta) ta.blur(); }
    const s = te.stroke;
    if (commit) {
      if (te.isNew) {
        if (value) {
          s.text = value;
          this._fitTextHeight(s);
          this.strokes.push(s);
          this._pushUndo({ type: 'add', stroke: s });
          this._emitChange(true);
        }
      } else if (!value) {
        const i = this.strokes.indexOf(s);
        if (i >= 0) {
          this.strokes.splice(i, 1);
          this._pushUndo({ type: 'remove', entries: [{ stroke: s, index: i }] });
          this._emitChange(true);
        }
      } else if (value !== te.before.text) {
        s.text = value;
        this._fitTextHeight(s);
        this._pushUndo({ type: 'edit', stroke: s, before: te.before, after: textState(s) });
        this._emitChange(true);
      }
    }
    this.requestRender(true);
    if (this.opts.onTextEdit) this.opts.onTextEdit(false);
  }

  /** 진행 중인 글상자 편집을 확정한다 (저장 직전에 호스트가 부른다) */
  commitText() { this._endTextEdit(true); }

  _fitTextHeight(s) {
    const ctx = this.bgCtx;
    ctx.save();
    const fs = s.fontSize || TEXT_SIZE;
    ctx.font = `${fs}px ${TEXT_FONT}`;
    const [[ax, ay], [bx]] = s.points;
    const lines = wrapText(ctx, s.text || '', Math.abs(bx - ax) - TEXT_PAD * 2);
    ctx.restore();
    s.points[1][1] = round2(ay + Math.max(1, lines.length) * fs * TEXT_LINE + TEXT_PAD * 2);
  }

  _drawShape(ctx, stroke, boost = 0) {
    const [[x0, y0], [x1, y1]] = stroke.points;
    ctx.lineWidth = stroke.size + boost;
    ctx.beginPath();
    switch (stroke.shape) {
      case 'rect':
        ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
        break;
      case 'ellipse':
        ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2,
          Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
        break;
      case 'arrow': {
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        const angle = Math.atan2(y1 - y0, x1 - x0);
        const len = Math.max(10, stroke.size * 3.5);
        for (const da of [Math.PI * 5 / 6, -Math.PI * 5 / 6]) {
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1 + Math.cos(angle + da) * len, y1 + Math.sin(angle + da) * len);
        }
        break;
      }
      default: // line
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
    }
    ctx.stroke();
  }

  /* ============== 내보내기 ============== */

  /** 콘텐츠 경계 (굵기·여백 포함, 월드 좌표) — 내용이 없으면 null */
  _contentBounds(margin = 40) {
    if (this.strokes.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of this.strokes) {
      const half = s.size; // 굵기 여유
      for (const [x, y] of strokeSamplePoints(s)) {
        if (x - half < minX) minX = x - half;
        if (y - half < minY) minY = y - half;
        if (x + half > maxX) maxX = x + half;
        if (y + half > maxY) maxY = y + half;
      }
    }
    return { minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin };
  }

  /** 월드 좌표 영역을 흰 배경 캔버스로 렌더 (긴 변 4096px, 최대 2배율) */
  _renderRegion(x, y, w, h, page = null) {
    const exportScale = Math.min(2, 4096 / Math.max(w, h));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(w * exportScale));
    out.height = Math.max(1, Math.round(h * exportScale));
    const octx = out.getContext('2d');
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, out.width, out.height);
    octx.setTransform(exportScale, 0, 0, exportScale, -x * exportScale, -y * exportScale);
    if (page) this._drawPaper(octx, page.index, page.count, 1 / exportScale);
    for (const s of this.strokes) this._drawStroke(octx, s);
    return out;
  }

  /** 페이지 모드: 첫 페이지부터 내용이 있는 마지막 페이지까지 페이지 그대로 렌더 */
  renderLayoutPages() {
    const last = this.lastUsedPage();
    const pages = [];
    for (let i = 0; i <= last; i++) {
      const r = this.pageRect(i);
      pages.push(this._renderRegion(r.x, r.y, r.w, r.h, { index: i, count: last + 1 }));
    }
    return pages;
  }

  /** 페이지 모드: 페이지 i 의 작은 미리보기 (목록 썸네일용) */
  renderPageThumbnail(i = 0, width = 240) {
    if (!this.layout) return null;
    const r = this.pageRect(i);
    const k = width / r.w;
    const out = document.createElement('canvas');
    out.width = Math.round(r.w * k);
    out.height = Math.round(r.h * k);
    const octx = out.getContext('2d');
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, out.width, out.height);
    octx.setTransform(k, 0, 0, k, -r.x * k, -r.y * k);
    this._drawPaper(octx, i, this.lastUsedPage() + 1, 1 / k);
    for (const s of this.strokes) this._drawStroke(octx, s);
    return out;
  }

  /** 페이지 렌더 전에 이미지(사진)가 모두 로드되길 기다린다 */
  whenImagesReady() {
    const waits = [];
    for (const s of this.strokes) {
      if (s.tool !== 'image') continue;
      const img = this._getImage(s.src);
      if (!img.complete) waits.push(new Promise(res => { img.addEventListener('load', res, { once: true }); img.addEventListener('error', res, { once: true }); }));
    }
    return Promise.all(waits);
  }

  /** 콘텐츠 경계를 계산해 흰 배경의 캔버스 한 장으로 렌더링 (없으면 null) */
  renderExportCanvas() {
    const b = this._contentBounds();
    if (!b) return null;
    return this._renderRegion(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
  }

  /**
   * 콘텐츠를 페이지(세로/가로 비율 = aspect) 단위로 나눠 페이지별 캔버스로 렌더링.
   *
   * 세로로 긴 노트를 한 장으로 내보내면 해상도가 긴 변 기준으로 떨어지고, 연구노트
   * PDF에 넣을 때 한 페이지에 작게 축소된다. 페이지마다 따로 렌더해 해상도를 지키고,
   * 경계는 가능한 한 필기가 없는 가로 여백에서 잘라 글씨가 두 페이지로 갈리지 않게 한다.
   *
   * 페이지 폭은 콘텐츠 폭과 minPageWidth 중 큰 값 — 좁은 메모가 종이 폭에 맞춰
   * 과도하게 확대되지 않도록 한다 (기본 700 ≈ A4 본문 폭을 화면 배율 1로 쓴 크기).
   * 반환: 캔버스 배열 (내용이 없으면 빈 배열)
   */
  renderExportPages(aspect = A4_BODY_ASPECT, minPageWidth = 700) {
    // 페이지 모드는 사용자가 본 페이지 그대로 내보낸다 (aspect 는 레이아웃이 이미 정함)
    if (this.layout) return this.renderLayoutPages();
    const b = this._contentBounds();
    if (!b) return [];
    const w = Math.max(b.maxX - b.minX, minPageWidth);
    const pageH = w * aspect;
    const occupied = mergeIntervals(this.strokes.map(s => {
      let y0 = Infinity, y1 = -Infinity;
      for (const [, y] of strokeSamplePoints(s)) {
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      return [y0 - s.size, y1 + s.size];
    }));

    const pages = [];
    let top = b.minY;
    while (b.maxY - top > pageH) {
      const ideal = top + pageH;
      // 페이지 아래쪽 25% 안에서 가장 아래에 있는 빈 가로 여백을 찾는다 (없으면 그냥 자름)
      const cut = findGapCut(occupied, top + pageH * 0.75, ideal) ?? ideal;
      pages.push(this._renderRegion(b.minX, top, w, cut - top));
      top = cut;
    }
    pages.push(this._renderRegion(b.minX, top, w, b.maxY - top));
    return pages;
  }

  exportPNG(title) {
    const out = this.renderExportCanvas();
    if (!out) return false;
    const a = document.createElement('a');
    a.download = (title || '노트') + '.png';
    a.href = out.toDataURL('image/png');
    a.click();
    return true;
  }

  /* ============== 콜백 ============== */
  _emitChange(userEdit) {
    this._lastUsed = undefined; // 페이지 수 다시 계산
    if (this.opts.onChange) this.opts.onChange(userEdit);
  }
  _emitViewport() {
    this._clampView();
    this._positionTextInput();
    if (this.opts.onViewport) this.opts.onViewport(this.scale);
  }
  _emitSelection() {
    if (this.opts.onSelection) this.opts.onSelection(this.selection);
  }
}

/* ============== 유틸 ============== */

/* 점-선분 거리 제곱 */
function distToSegmentSq(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  const ex = px - cx, ey = py - cy;
  return ex * ex + ey * ey;
}

function round2(n) { return Math.round(n * 100) / 100; }

/** A4 본문 비율 (세로/가로) — 297×210mm에서 사방 15mm 여백을 뺀 영역 */
const A4_BODY_ASPECT = (297 - 30) / (210 - 30);

/* 페이지 모드 기본값 — 폭 720 월드 단위, 높이는 A4 본문 비율 */
const PAGE_W = 720;
const PAGE_H = Math.round(PAGE_W * A4_BODY_ASPECT);
const PAGE_GAP = 28;
const PAGE_HEADER_H = 44;
const PAGE_GRID_STEP = 24;
const PAGE_DESK = '#e6e9ee';
const PAGE_GRID = '#e9edf3';
const PAGE_HEAD_INK = '#7a8494';
const PAGE_HEAD_RULE = '#cfd6e0';

/* 표 */
const TABLE_TEXT = 15;
const TABLE_LINE = 1.4;
const TABLE_PAD = 8;
const TABLE_ROW_MIN = 40;     // 손으로 써 넣을 수 있는 높이
const TABLE_RULE = '#5f6b7c';
const TABLE_HEAD_FILL = '#eef2f7';

/* 글상자 */
const TEXT_FONT = "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Noto Sans KR', 'Malgun Gothic', sans-serif";
const TEXT_SIZE = 18;
const TEXT_LINE = 1.5;
const TEXT_PAD = 6;
const TEXT_EDIT_ACCENT = '#2f6bf2';

function normalizePageLayout(l) {
  return {
    type: 'pages',
    pageW: Number(l.pageW) > 0 ? Number(l.pageW) : PAGE_W,
    pageH: Number(l.pageH) > 0 ? Number(l.pageH) : PAGE_H,
    gap: Number(l.gap) >= 0 ? Number(l.gap) : PAGE_GAP,
    minPages: Number(l.minPages) > 0 ? Number(l.minPages) : 1,
    // 노트를 만든 날 (페이지 머리글) — 웹에서 다시 열어 내보내도 같은 머리글이 나오게 레이아웃에 둔다
    ...(typeof l.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(l.date) ? { date: l.date } : {}),
  };
}

/** 새 페이지 노트의 기본 레이아웃 (저장 형식에 그대로 들어간다) */
function defaultPageLayout(date) {
  const l = { type: 'pages', pageW: PAGE_W, pageH: PAGE_H, gap: PAGE_GAP };
  if (date) l.date = date;
  return l;
}

/** 상자 모양 객체(지우개로 지우지 않고, 올가미로 옮긴다) */
function isBoxObject(s) {
  return s.tool === 'image' || s.tool === 'text' || s.tool === 'table';
}

function normalizeCells(cells, rows, cols) {
  const out = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push(String((cells && cells[r] && cells[r][c]) || ''));
    out.push(row);
  }
  return out;
}

function snapshotStroke(s) { return JSON.parse(JSON.stringify(s)); }

function restoreSnapshot(s, snap) {
  for (const k of Object.keys(s)) if (!(k in snap)) delete s[k];
  Object.assign(s, JSON.parse(JSON.stringify(snap)));
}

function pathExtent(path) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of path) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return Math.max(maxX - minX, maxY - minY);
}

function textState(s) {
  return { text: s.text || '', points: s.points.map(p => p.slice()) };
}

function applyTextState(s, st) {
  s.text = st.text;
  s.points = st.points.map(p => p.slice());
}

/** 글 줄바꿈 — 문단(\n) 안에서 공백 단위로, 너무 긴 낱말은 글자 단위로 나눈다 */
function wrapText(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (para === '') { out.push(''); continue; }
    let line = '';
    for (const token of para.split(/(\s+)/)) {
      if (!token) continue;
      const tryLine = line + token;
      if (ctx.measureText(tryLine).width <= maxW) { line = tryLine; continue; }
      if (line.trim()) { out.push(line.replace(/\s+$/, '')); line = ''; }
      if (/^\s+$/.test(token)) continue;
      // 낱말 하나가 줄보다 길면 글자 단위로
      for (const ch of token) {
        if (ctx.measureText(line + ch).width > maxW && line) { out.push(line); line = ''; }
        line += ch;
      }
    }
    out.push(line);
  }
  return out;
}

function ellipsize(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

/** [시작, 끝] 구간들을 정렬·병합 */
function mergeIntervals(spans) {
  const sorted = spans.filter(([a, b]) => b >= a).sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * [lo, hi] 범위에서 어떤 구간(필기)에도 걸치지 않는 y 중 가장 아래쪽 빈 틈의 중앙을
 * 반환한다. 틈이 없으면 null.
 */
function findGapCut(occupied, lo, hi) {
  let best = null;
  let prevEnd = -Infinity;
  for (const [a, b] of occupied.concat([[Infinity, Infinity]])) {
    // 빈 틈: (prevEnd, a)
    const g0 = Math.max(prevEnd, lo), g1 = Math.min(a, hi);
    if (g1 > g0) best = (g0 + g1) / 2;
    prevEnd = Math.max(prevEnd, b);
    if (prevEnd >= hi) break;
  }
  return best;
}

/* 획을 (dx, dy)만큼 평행 이동 */
function translateStroke(stroke, dx, dy) {
  for (const p of stroke.points) {
    p[0] = round2(p[0] + dx);
    p[1] = round2(p[1] + dy);
  }
}

/* 도형의 외곽선 샘플 점 (히트 테스트 / 선택 판정용) */
function shapeOutline(stroke) {
  const [[x0, y0], [x1, y1]] = stroke.points;
  switch (stroke.shape) {
    case 'rect':
      return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
    case 'ellipse': {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
      const out = [];
      for (let i = 0; i <= 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
      }
      return out;
    }
    default: // line, arrow
      return [[x0, y0], [x1, y1]];
  }
}

/* 선택 판정용 샘플 점: 자유 곡선은 자체 점, 도형/이미지는 외곽선 샘플 */
function strokeSamplePoints(stroke) {
  if (isBoxObject(stroke)) {
    const [[ax, ay], [bx, by]] = stroke.points;
    const cx = (ax + bx) / 2, cy = (ay + by) / 2;
    return [
      [ax, ay], [bx, ay], [bx, by], [ax, by],       // 꼭짓점
      [cx, ay], [bx, cy], [cx, by], [ax, cy],       // 변 중점
      [cx, cy],                                      // 중심
    ];
  }
  if (stroke.tool === 'shape') {
    const out = shapeOutline(stroke);
    // 선분 중점도 포함해 판정 정확도 향상
    const withMids = [];
    for (let i = 0; i < out.length; i++) {
      withMids.push(out[i]);
      if (i + 1 < out.length) {
        withMids.push([(out[i][0] + out[i + 1][0]) / 2, (out[i][1] + out[i + 1][1]) / 2]);
      }
    }
    return withMids;
  }
  return stroke.points;
}

/* 점이 다각형 내부인지 (ray casting) */
function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/* 모듈 없이 쓰는 호스트(태블릿 앱 등)를 위한 전역 노출 */
if (typeof window !== 'undefined') {
  window.DrawingEngine = DrawingEngine;
  window.HandDrawing = { DrawingEngine, defaultPageLayout, A4_BODY_ASPECT };
}
