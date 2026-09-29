import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../lib/api.ts';
import { defaultDeviceName, login } from '../lib/session.ts';
import type { Session } from '../lib/types.ts';

const LAST_SERVER_KEY = 'goono-note.last-server';
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
      </form>
    </div>
  );
}
