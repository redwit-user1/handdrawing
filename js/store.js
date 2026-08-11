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

  /**
   * REST 저장 어댑터 (config.js의 apiBase 설정 시 활성).
   * API 사양:
   *   GET    {apiBase}/notes      → { notes: [...] } 또는 [...]
   *   PUT    {apiBase}/notes/{id} → 본문: note JSON
   *   DELETE {apiBase}/notes/{id}
   */
  const remote = {
    base() {
      return (window.APP_CONFIG && window.APP_CONFIG.apiBase) || null;
    },
    enabled() {
      return !!remote.base();
    },
    async list() {
      const res = await fetch(remote.base() + '/notes');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return Array.isArray(data) ? data : data.notes;
    },
    async put(note) {
      const res = await fetch(remote.base() + '/notes/' + encodeURIComponent(note.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(note),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
    },
    async remove(id) {
      const res = await fetch(remote.base() + '/notes/' + encodeURIComponent(id), {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
    },
  };

  return { load, save, newNote, uid, remote };
})();
