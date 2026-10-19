import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../lib/api.ts';
import { defaultDeviceName, login } from '../lib/session.ts';
import { DEMO_SERVER } from '../lib/demo.ts';
import { NETWORK_ERROR_MESSAGE } from '../lib/pairing.ts';
import type { Session } from '../lib/types.ts';

export const LAST_SERVER_KEY = 'goono-note.last-server';
/** 체험판 빌드(VITE_DEMO=1): 서버 없이 체험 서버로만. VITE_ALLOW_DEMO=1·개발 서버: 연결 화면에 "서버 없이 체험하기"·비밀번호 연결 */
export const DEMO_ONLY = import.meta.env.VITE_DEMO === '1';
export const ALLOW_DEMO = DEMO_ONLY || import.meta.env.VITE_ALLOW_DEMO === '1' || import.meta.env.DEV;
/** 서버 주소 입력칸의 처음 값. 운영 빌드는 비워 둔다(기관 주소를 직접 넣는다). 개발·체험 빌드만 로컬 모의 서버 */
export const DEFAULT_SERVER = (import.meta.env.VITE_DEFAULT_SERVER as string | undefined) ?? (ALLOW_DEMO ? 'http://localhost:8787' : '');

export function lastServer(): string | null {
  try { return localStorage.getItem(LAST_SERVER_KEY); } catch { return null; }
}
export function rememberServer(url: string): void {
  try { localStorage.setItem(LAST_SERVER_KEY, url); } catch { /* 무시 */ }
}

/** 체험 서버로 시작 (기기 안 모의 서버 — 코드·비밀번호를 따지지 않는다) */
export function startDemo(deviceName: string): Promise<Session> {
  return login(DEMO_SERVER, 'demo', 'demo', deviceName.trim() || '내 태블릿');
}

/**
 * 개발·체험 빌드 전용 화면 (연결 화면에서만 들어온다):
 *  - demoOnly: 체험판 빌드(VITE_DEMO=1)의 "체험 시작" 카드
 *  - 그 밖: 아이디·비밀번호 연결(`/devices/register`, 서버 설정으로 켰을 때만 동작). relogin 이면 서버·아이디 고정
 */
export default function Login({ relogin, demoOnly, onDone, onCancel }: {
  relogin?: Session | null; demoOnly?: boolean; onDone: (s: Session) => void; onCancel?: () => void;
}) {
  const [serverUrl, setServerUrl] = useState(() => relogin?.serverUrl ?? lastServer() ?? DEFAULT_SERVER);
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
      const s = await login(serverUrl, loginId.trim(), password, deviceName.trim() || '태블릿');
      rememberServer(serverUrl);
      onDone(s);
    } catch (err) {
      setError(err instanceof ApiError && err.isNetwork ? NETWORK_ERROR_MESSAGE : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const demo = async () => {
    setBusy(true);
    setError('');
    try {
      onDone(await startDemo(deviceName));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (demoOnly) {
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
            {onCancel && <button type="button" className="btn" onClick={onCancel}>취소</button>}
            <button className="btn primary" disabled={busy} onClick={() => void demo()} data-testid="demo-submit">{busy ? '준비 중…' : '체험 시작'}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit} data-testid="login-form">
        <span className="chip warn">개발용</span>
        <h1>비밀번호로 연결</h1>
        <p className="muted">개발·체험 빌드 전용입니다. 서버에서 비밀번호 연결을 켠 경우에만 동작합니다 — 평소에는 QR로 연결하세요.
          {relogin && ' 같은 계정이면 기기에 남은 기록을 이어 씁니다.'}</p>
        <label className="field">아이디
          <input value={loginId} onChange={(e) => setLoginId(e.target.value)} disabled={!!relogin} autoCapitalize="off" autoCorrect="off" autoComplete="username" data-testid="login-id" required />
        </label>
        <label className="field">비밀번호
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" data-testid="login-pw" required />
        </label>
        <label className="field">이 기기 이름
          <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} data-testid="login-device" />
        </label>
        <div className="server">
          <label className="field">기관 구노 서버 주소
            <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} disabled={!!relogin} inputMode="url" autoCapitalize="off" autoCorrect="off" data-testid="login-server" required />
          </label>
        </div>
        {error && <div className="banner danger" data-testid="login-error">{error}</div>}
        <div className="row end">
          {onCancel && <button type="button" className="btn" onClick={onCancel}>QR 연결로 돌아가기</button>}
          <button className="btn primary" disabled={busy} data-testid="login-submit">{busy ? '연결 중…' : '연결'}</button>
        </div>
      </form>
    </div>
  );
}
