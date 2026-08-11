/**
 * engine.js — 캔버스 드로잉 엔진 (태블릿 최적화)
 *
 * - Pointer Events 기반: 펜(스타일러스) 필압, 펜 지우개 버튼 지원
 * - 팜 리젝션: 펜 사용 중이거나 직후에는 손바닥 터치 무시
 * - 손가락 두 개: 핀치 줌 + 패닝 / (손가락 그리기 꺼짐 시) 손가락 하나: 패닝
 * - getCoalescedEvents로 고주파 입력 샘플 수집 → 부드러운 곡선
 * - 완료된 획은 오프스크린 캔버스에 캐시하여 그리는 동안 60fps 유지
 * - 도형(직선/화살표/사각형/타원), 올가미 선택(이동·복제·삭제)
 * - 실행 취소 / 다시 실행 (추가·삭제·이동·전체 지우기)
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
    this.strokes = strokes || [];
    this.undoStack = [];
    this.redoStack = [];
    this._cancelInput();
    this.clearSelection();
    this.requestRender(true);
    this._emitChange(false);
  }

  resetView() {
    this.scale = 1; this.tx = 0; this.ty = 0;
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
    const op = this.undoStack.pop();
    if (!op) return;
    this.clearSelection();
    this._applyInverse(op);
    this.redoStack.push(op);
    this.requestRender(true);
    this._emitChange(true);
  }

  redo() {
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
    }
  }

  clearAll() {
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
    if (!this.selection) return;
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
    if (!this.selection) return;
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
      if (path && path.length >= 3) {
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
    // 종이는 항상 흰색 (다크 모드에서도 필기 대비 유지)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.bg.width, this.bg.height);

    if (this.showGrid) this._drawGrid(ctx);

    this._applyTransform(ctx);
    for (const s of this.strokes) this._drawStroke(ctx, s);
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

  /** 콘텐츠 경계를 계산해 흰 배경의 캔버스로 렌더링 (없으면 null) */
  renderExportCanvas() {
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
    const margin = 40;
    minX -= margin; minY -= margin; maxX += margin; maxY += margin;
    const w = maxX - minX, h = maxY - minY;
    const exportScale = Math.min(2, 4096 / Math.max(w, h));

    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(w * exportScale));
    out.height = Math.max(1, Math.round(h * exportScale));
    const octx = out.getContext('2d');
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, out.width, out.height);
    octx.setTransform(exportScale, 0, 0, exportScale, -minX * exportScale, -minY * exportScale);
    for (const s of this.strokes) this._drawStroke(octx, s);
    return out;
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
    if (this.opts.onChange) this.opts.onChange(userEdit);
  }
  _emitViewport() {
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

/* 선택 판정용 샘플 점: 자유 곡선은 자체 점, 도형은 외곽선 샘플 */
function strokeSamplePoints(stroke) {
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
