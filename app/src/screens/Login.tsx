import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../lib/api.ts';
import { defaultDeviceName, login } from '../lib/session.ts';
import { DEMO_SERVER, isDemoServer } from '../lib/demo.ts';
import type { Session } from '../lib/types.ts';

const LAST_SERVER_KEY = 'goono-note.last-server';
/** 체험판 빌드(VITE_DEMO=1): 로그인 없이 체험 서버로만. VITE_ALLOW_DEMO=1: 로그인 화면에 "서버 없이 체험하기" */
const DEMO_ONLY = import.meta.env.VITE_DEMO === '1';
const ALLOW_DEMO = DEMO_ONLY || import.meta.env.VITE_ALLOW_DEMO === '1' || import.meta.env.DEV;
const DEFAULT_SERVER = (import.meta.env.VITE_DEFAULT_SERVER as string | undefined) ?? 'http://localhost:8787';

/** 로그인(기기 등록). relogin 이면 서버·아이디를 고정하고 기기 데이터를 이어 쓴다 */
export default function Login({ relogin, onDone, onCancel }: { relogin?: Session | null; onDone: () => void; onCancel?: () => void }) {
  const [serverUrl, setServerUrl] = useState(() => relogin?.serverUrl ?? localStorage.getItem(LAST_SERVER_KEY) ?? DEFAULT_SERVER);
  const [loginId, setLoginId] = useState(relogin?.user.loginId ?? '');
  const [password, setPassword] = useState('');
  const [deviceName, setDeviceName] = useState(relogin?.deviceName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!deviceName) void defaultDeviceName().then((n) => setDeviceName((cur) => cur || n));
  }, [deviceName]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(serverUrl, loginId.trim(), password, deviceName.trim() || '태블릿');
      localStorage.setItem(LAST_SERVER_KEY, serverUrl);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.isNetwork) setError('서버에 연결할 수 없습니다. 처음 로그인과 다시 로그인은 인터넷 연결이 필요합니다.');
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startDemo = async () => {
    setBusy(true);
    setError('');
    try {
      await login(DEMO_SERVER, 'demo', 'demo', deviceName.trim() || '내 태블릿');
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (DEMO_ONLY || (relogin && isDemoServer(relogin.serverUrl))) {
    return (
      <div className="login">
        <div className="login-card" data-testid="demo-start">
          <span className="chip info">체험판</span>
          <h1>구노 연구노트</h1>
          <p className="muted">태블릿에서 펜으로 연구노트를 쓰고, 연결되면 구노 전자연구노트에 올리는 앱입니다.
            체험판은 서버 없이 이 브라우저 안에서만 동작합니다 — 쓴 내용은 이 기기에만 저장되고 어디로도 보내지 않습니다.</p>
          <ul className="plain-list small">
            <li>새 노트를 만들면 모눈 페이지가 열리고 Apple Pencil로 바로 씁니다.</li>
            <li>+ 로 표·수식·화학식·구조식·사진을 넣고, 버전을 만들면 "구노에 올라감"까지 체험할 수 있습니다.</li>
            <li>비행기 모드로 오프라인 작성 → 연결 후 자동 동기화도 해 볼 수 있습니다.</li>
          </ul>
          <label className="field">이 기기 이름
            <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} data-testid="login-device" />
          </label>
          {error && <div className="banner danger">{error}</div>}
          <div className="row end">
            <button className="btn primary" disabled={busy} onClick={() => void startDemo()} data-testid="demo-submit">{busy ? '준비 중…' : '체험 시작'}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit} data-testid="login-form">
        <h1>구노 연구노트</h1>
        <p className="muted">{relogin ? '로그인이 만료되었습니다. 비밀번호를 다시 입력하면 이어서 씁니다.' : '태블릿에서 손으로 쓰고, 연결되면 구노 전자연구노트에 올립니다.'}</p>
        <label className="field">아이디
          <input value={loginId} onChange={(e) => setLoginId(e.target.value)} disabled={!!relogin} autoCapitalize="off" autoCorrect="off" autoComplete="username" data-testid="login-id" required />
        </label>
        <label className="field">비밀번호
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" data-testid="login-pw" required />
        </label>
        <label className="field">이 기기 이름
          <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} data-testid="login-device" />
          <span className="muted small hint">구노 웹에 "○○에서 작성 중"으로 보이고, 기기를 관리할 때 씁니다.</span>
        </label>
        <div className="server">
          <label className="field">기관 구노 서버 주소
            <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} disabled={!!relogin} inputMode="url" autoCapitalize="off" autoCorrect="off" data-testid="login-server" required />
          </label>
        </div>
        {error && <div className="banner danger" data-testid="login-error">{error}</div>}
        <div className="row end">
          {onCancel && <button type="button" className="btn" onClick={onCancel}>취소</button>}
          <button className="btn primary" disabled={busy} data-testid="login-submit">{busy ? '로그인 중…' : '로그인'}</button>
        </div>
        {ALLOW_DEMO && !relogin && (
          <div className="demo-link">
            <button type="button" className="btn ghost small" onClick={() => void startDemo()} data-testid="demo-submit">서버 없이 체험하기</button>
            <span className="muted small">이 기기 안에서만 동작하는 체험 서버를 씁니다.</span>
          </div>
        )}
      </form>
    </div>
  );
}
