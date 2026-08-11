/**
 * bridge.js — ELN 임베드용 postMessage 브리지.
 *
 * `index.html?embed=1`로 iframe에 띄우면 호스트(ELN)와 아래 프로토콜로 통신한다.
 * 자세한 명세와 호스트 예시는 docs/ELN-INTEGRATION.md 참고.
 *
 *  자식 → 호스트
 *   { type:'handdrawing:ready', version }                       초기화 완료
 *   { type:'handdrawing:change', note, sha256, strokeCount,
 *     baseRev }                                                 내용 변경(저장 요청)
 *   { type:'handdrawing:export-result', requestId, format,
 *     dataUrl? | json?, error? }                                내보내기 응답
 *
 *  호스트 → 자식
 *   { type:'handdrawing:load', note:{title, strokes} | null,
 *     rev? }                                                    노트 데이터 주입
 *   { type:'handdrawing:ack-save', rev }                        저장 완료 통지(새 리비전)
 *   { type:'handdrawing:set-readonly', readonly:boolean }       열람 모드 전환
 *   { type:'handdrawing:export', requestId, format:'png'|'pdf'|'json' }
 *
 * 동시 편집 충돌 감지: 호스트가 load에 rev(저장본 리비전)를 실어 보내면 이후
 * 모든 change에 baseRev로 그대로 되돌아온다. 호스트는 저장 시 baseRev가 현재
 * 서버 리비전과 다르면 충돌로 판단하고, 저장 성공 후 ack-save로 새 rev를
 * 알려 다음 change부터 갱신된 baseRev가 실리게 한다.
 *
 * 허용 오리진은 config.js의 embedAllowedOrigins로 제한한다
 * (null = 동일 오리진만, ['*'] = 모두 허용).
 */
const Bridge = (() => {
  let hooks = null;
  let hostOrigin = null; // 첫 유효 메시지의 오리진으로 고정
  let currentRev = null; // 호스트가 알려준 저장본 리비전 (충돌 감지용)

  function isEmbedded() {
    return window.parent !== window;
  }

  function originAllowed(origin) {
    const cfg = window.APP_CONFIG ? window.APP_CONFIG.embedAllowedOrigins : null;
    if (cfg == null) return origin === location.origin;
    if (Array.isArray(cfg)) return cfg.includes('*') || cfg.includes(origin);
    return false;
  }

  function post(msg) {
    if (!isEmbedded()) return;
    // 호스트 오리진을 알기 전(ready)에는 '*'로 보내되, 그 메시지에는 노트 데이터를 담지 않는다
    window.parent.postMessage(msg, hostOrigin || '*');
  }

  async function onMessage(e) {
    const d = e.data;
    if (!d || typeof d.type !== 'string' || !d.type.startsWith('handdrawing:')) return;
    if (!originAllowed(e.origin)) return;
    hostOrigin = e.origin;

    switch (d.type) {
      case 'handdrawing:load':
        currentRev = 'rev' in d ? d.rev : null;
        hooks.load(d.note || null);
        break;
      case 'handdrawing:ack-save':
        currentRev = d.rev;
        break;
      case 'handdrawing:set-readonly':
        hooks.setReadonly(!!d.readonly);
        break;
      case 'handdrawing:export': {
        let result;
        try {
          result = await hooks.export(d.format);
        } catch (err) {
          result = { error: err.message };
        }
        post(Object.assign(
          { type: 'handdrawing:export-result', requestId: d.requestId, format: d.format },
          result));
        break;
      }
    }
  }

  /** 시점인증(TSA) 연계용 콘텐츠 해시 — HTTPS/localhost가 아니면 null */
  async function sha256(text) {
    if (!window.crypto || !crypto.subtle) return null;
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function init(h) {
    hooks = h;
    window.addEventListener('message', onMessage);
    post({ type: 'handdrawing:ready', version: 1 });
  }

  async function sendChange(note) {
    if (!isEmbedded()) return;
    const canonical = JSON.stringify({ title: note.title, strokes: note.strokes });
    post({
      type: 'handdrawing:change',
      note: { title: note.title, strokes: note.strokes, updated: note.updated },
      sha256: await sha256(canonical),
      strokeCount: note.strokes.length,
      baseRev: currentRev,
    });
  }

  return { init, sendChange, isEmbedded };
})();
