/**
 * app.js — UI와 엔진/저장소 연결
 */
(() => {
  const $ = sel => document.querySelector(sel);
  const $$ = sel => [...document.querySelectorAll(sel)];

  const COLORS = ['#1f2328', '#dc2626', '#ea580c', '#16a34a', '#2563eb', '#9333ea'];

  let state = Store.load();
  let saveTimer = null;

  const canvas = $('#board');
  const engine = new DrawingEngine(canvas, {
    onChange(userEdit) {
      updateUndoButtons();
      if (userEdit) scheduleSave();
    },
    onViewport(scale) {
      $('#zoom-label').textContent = Math.round(scale * 100) + '%';
    },
    onPenDetected() {
      // 펜이 감지되면 손가락 그리기를 자동으로 꺼서 팜 리젝션 강화
      setTouchDraws(false);
      toast('펜 감지됨 — 손가락은 화면 이동에 사용됩니다');
    },
  });

  /* ============== 저장 ============== */
  function currentNote() {
    return state.notes.find(n => n.id === state.currentId);
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    const note = currentNote();
    if (!note) return;
    note.strokes = engine.strokes;
    note.updated = Date.now();
    if (!Store.save(state)) toast('저장 공간이 부족합니다');
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });
  window.addEventListener('beforeunload', saveNow);

  /* ============== 노트 전환 ============== */
  function openNote(id) {
    saveNow();
    state.currentId = id;
    const note = currentNote();
    engine.setStrokes(note.strokes);
    engine.resetView();
    $('#note-title').value = note.title;
    Store.save(state);
    renderNotesList();
  }

  function renderNotesList() {
    const ul = $('#notes-list');
    ul.innerHTML = '';
    const sorted = [...state.notes].sort((a, b) => b.updated - a.updated);
    for (const note of sorted) {
      const li = document.createElement('li');
      if (note.id === state.currentId) li.classList.add('current');

      const info = document.createElement('div');
      info.className = 'note-info';
      const name = document.createElement('div');
      name.className = 'note-name';
      name.textContent = note.title || '제목 없음';
      const meta = document.createElement('div');
      meta.className = 'note-meta';
      meta.textContent = `${formatDate(note.updated)} · 획 ${note.strokes.length}개`;
      info.append(name, meta);

      const del = document.createElement('button');
      del.className = 'note-del';
      del.title = '노트 삭제';
      del.textContent = '🗑';
      del.addEventListener('click', ev => {
        ev.stopPropagation();
        deleteNote(note.id);
      });

      li.append(info, del);
      li.addEventListener('click', () => {
        openNote(note.id);
        closePanel();
      });
      ul.appendChild(li);
    }
  }

  function deleteNote(id) {
    const note = state.notes.find(n => n.id === id);
    if (!note) return;
    if (!confirm(`"${note.title}" 노트를 삭제할까요?`)) return;
    state.notes = state.notes.filter(n => n.id !== id);
    if (state.notes.length === 0) {
      const fresh = Store.newNote('새 노트');
      state.notes.push(fresh);
    }
    if (state.currentId === id) {
      openNote(state.notes[0].id);
    } else {
      Store.save(state);
      renderNotesList();
    }
  }

  function formatDate(ts) {
    const d = new Date(ts);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    if (sameDay) {
      return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
  }

  /* ============== 패널 ============== */
  function openPanel() {
    renderNotesList();
    $('#notes-panel').hidden = false;
    $('#panel-backdrop').hidden = false;
  }
  function closePanel() {
    $('#notes-panel').hidden = true;
    $('#panel-backdrop').hidden = true;
  }
  $('#btn-notes').addEventListener('click', openPanel);
  $('#panel-backdrop').addEventListener('click', closePanel);
  $('#btn-new-note').addEventListener('click', () => {
    saveNow();
    const note = Store.newNote('새 노트');
    state.notes.push(note);
    openNote(note.id);
    closePanel();
    $('#note-title').focus();
    $('#note-title').select();
  });

  /* ============== 제목 ============== */
  $('#note-title').addEventListener('input', () => {
    const note = currentNote();
    note.title = $('#note-title').value.trim() || '제목 없음';
    scheduleSave();
  });
  $('#note-title').addEventListener('keydown', e => {
    if (e.key === 'Enter') e.target.blur();
  });

  /* ============== 도구 ============== */
  function setTool(tool) {
    engine.tool = tool;
    engine.eraserPos = null;
    $$('#tool-group .tool').forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
    canvas.classList.toggle('tool-pan', tool === 'pan');
    engine.requestRender();
  }
  $$('#tool-group .tool').forEach(b =>
    b.addEventListener('click', () => setTool(b.dataset.tool)));

  /* ============== 색상 ============== */
  const colorGroup = $('#color-group');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'color-btn';
    b.style.background = c;
    b.dataset.color = c;
    b.title = c;
    b.addEventListener('click', () => setColor(c));
    colorGroup.appendChild(b);
  }
  const customColor = document.createElement('input');
  customColor.type = 'color';
  customColor.id = 'color-custom';
  customColor.title = '사용자 색상';
  customColor.value = '#0ea5e9';
  customColor.addEventListener('input', () => setColor(customColor.value, true));
  colorGroup.appendChild(customColor);

  function setColor(c, custom = false) {
    engine.color = c;
    $$('.color-btn').forEach(b =>
      b.classList.toggle('selected', !custom && b.dataset.color === c));
    customColor.classList.toggle('selected', custom);
    // 지우개/이동 상태에서 색을 고르면 펜으로 전환
    if (engine.tool === 'eraser' || engine.tool === 'pan') setTool('pen');
  }
  setColor(COLORS[0]);

  /* ============== 굵기 ============== */
  $$('#size-group .size').forEach(b =>
    b.addEventListener('click', () => {
      engine.size = parseFloat(b.dataset.size);
      $$('#size-group .size').forEach(x =>
        x.setAttribute('aria-pressed', String(x === b)));
    }));

  /* ============== 실행 취소 / 다시 실행 ============== */
  function updateUndoButtons() {
    $('#btn-undo').disabled = engine.undoStack.length === 0;
    $('#btn-redo').disabled = engine.redoStack.length === 0;
  }
  $('#btn-undo').addEventListener('click', () => engine.undo());
  $('#btn-redo').addEventListener('click', () => engine.redo());

  /* ============== 손가락 그리기 / 격자 ============== */
  function setTouchDraws(on) {
    engine.touchDraws = on;
    $('#btn-touchdraw').setAttribute('aria-pressed', String(on));
  }
  $('#btn-touchdraw').addEventListener('click', () => {
    setTouchDraws(!engine.touchDraws);
    toast(engine.touchDraws ? '손가락으로 그리기 켜짐' : '손가락은 화면 이동에 사용됩니다');
  });

  $('#btn-grid').addEventListener('click', () => {
    engine.showGrid = !engine.showGrid;
    $('#btn-grid').setAttribute('aria-pressed', String(engine.showGrid));
    engine.requestRender(true);
  });

  /* ============== 줌 ============== */
  $('#btn-zoom-in').addEventListener('click', () => engine.zoomBy(1.25));
  $('#btn-zoom-out').addEventListener('click', () => engine.zoomBy(1 / 1.25));
  $('#zoom-label').addEventListener('click', () => engine.resetView());

  /* ============== 내보내기 / 전체 지우기 ============== */
  $('#btn-export').addEventListener('click', () => {
    const ok = engine.exportPNG(currentNote().title);
    toast(ok ? 'PNG로 저장했습니다' : '내보낼 내용이 없습니다');
  });

  $('#btn-clear').addEventListener('click', () => {
    if (engine.strokes.length === 0) return;
    if (confirm('이 노트의 모든 내용을 지울까요? (실행 취소 가능)')) {
      engine.clearAll();
    }
  });

  /* ============== 키보드 단축키 ============== */
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); engine.undo(); }
    else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); engine.redo(); }
    else if (!mod && e.key === 'p') setTool('pen');
    else if (!mod && e.key === 'h') setTool('highlighter');
    else if (!mod && e.key === 'e') setTool('eraser');
    else if (!mod && e.key === ' ') { e.preventDefault(); setTool('pan'); }
    else if (mod && e.key === '0') { e.preventDefault(); engine.resetView(); }
    else if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); engine.zoomBy(1.25); }
    else if (mod && e.key === '-') { e.preventDefault(); engine.zoomBy(1 / 1.25); }
  });

  /* ============== 토스트 ============== */
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }

  /* ============== PWA ============== */
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  /* ============== 시작 ============== */
  const note = currentNote();
  engine.setStrokes(note.strokes);
  $('#note-title').value = note.title;
  updateUndoButtons();
})();
