/**
 * store.js — localStorage 기반 노트 저장소.
 * 저장 형식: { version, currentId, notes: [{ id, title, created, updated, strokes }] }
 * stroke: { tool, color, size, points: [[x, y, pressure], ...] }
 */
const Store = (() => {
  const KEY = 'handdrawing.notes.v1';

  function now() { return Date.now(); }

  function uid() {
    return now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function emptyState() {
    const note = newNote('새 노트');
    return { version: 1, currentId: note.id, notes: [note] };
  }

  function newNote(title) {
    return { id: uid(), title: title || '새 노트', created: now(), updated: now(), strokes: [] };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return emptyState();
      const state = JSON.parse(raw);
      if (!state || !Array.isArray(state.notes) || state.notes.length === 0) return emptyState();
      if (!state.notes.some(n => n.id === state.currentId)) {
        state.currentId = state.notes[0].id;
      }
      return state;
    } catch (e) {
      console.warn('저장된 노트를 불러오지 못했습니다:', e);
      return emptyState();
    }
  }

  function save(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.warn('노트 저장 실패(저장 공간 부족일 수 있음):', e);
      return false;
    }
  }

  return { load, save, newNote, uid };
})();
