import { useEffect, useState, type FormEvent } from 'react';
import { defaultDeviceName, pair } from '../lib/session.ts';
import { isDemoServer } from '../lib/demo.ts';
import { sessionLock } from '../lib/rules.ts';
import {
  BAD_CODE_INPUT_MESSAGE, PARSE_ERROR_MESSAGES, formatCode, normalizeCode, normalizeServerUrl, pairErrorMessage, parsePairingUri,
  type PairingTarget,
} from '../lib/pairing.ts';
import { canScanQr, scanPairingQr } from '../lib/scan.ts';
import type { Session } from '../lib/types.ts';
import { IcQr } from '../icons.tsx';
import Login, { ALLOW_DEMO, DEFAULT_SERVER, DEMO_ONLY, lastServer, rememberServer, startDemo } from './Login.tsx';

/** QR 의 http 서버 주소는 개발·체험 빌드에서만 받는다 (운영 구노는 https) */
const ALLOW_HTTP = ALLOW_DEMO;

type Stage = 'start' | 'manual' | 'confirm' | 'password';
type Failure = Error & { status?: number; code?: string; retryAfterSec?: number };

const hostOf = (url: string) => { try { return new URL(url).host || url; } catch { return url; } };

/**
 * 연결 화면 — 구노 웹에서 띄운 QR(또는 그 아래 8자 코드)로 이 기기를 연결한다.
 *  첫 화면(QR로 연결) → [QR 읽기 | 코드 직접 입력] → (QR·딥링크면) 확인 단계 "이 서버에 연결할까요?" → 연결 중 → 끝 / 오류
 * relogin(다시 연결)이면 서버 주소를 고정한다. 같은 계정이면 기기 데이터를 이어 쓰고, 다른 계정이면
 * 올리지 않은 기록이 있는 한 거부한다(session.ts).
 * target: 앱 밖에서 받은 QR 내용(딥링크) — 곧바로 확인 단계로 간다.
 */
export default function Connect({ relogin, target, onDone, onCancel }: {
  relogin?: Session | null; target?: PairingTarget | null; onDone: () => void; onCancel?: () => void;
}) {
  /** 다시 연결 중이면 지금 서버의 QR 만 받는다 */
  const wrongServer = (t: PairingTarget) => (relogin && normalizeServerUrl(relogin.serverUrl) !== t.serverUrl
    ? `이 기기는 ${hostOf(relogin.serverUrl)}에 연결되어 있습니다. 그 서버의 구노 웹에서 띄운 QR을 읽어 주세요.`
    : '');
  const [stage, setStage] = useState<Stage>(() => (target && !wrongServer(target) ? 'confirm' : 'start'));
  const [picked, setPicked] = useState<PairingTarget | null>(() => (target && !wrongServer(target) ? target : null));
  const [error, setError] = useState(() => (target ? wrongServer(target) : ''));
  const [serverUrl, setServerUrl] = useState(() => relogin?.serverUrl ?? lastServer() ?? DEFAULT_SERVER);
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState(relogin?.deviceName ?? '');
  const [scannable, setScannable] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void canScanQr().then(setScannable).catch(() => setScannable(false)); }, []);
  useEffect(() => {
    if (!deviceName) void defaultDeviceName().then((n) => setDeviceName((cur) => cur || n));
  }, [deviceName]);

  if (DEMO_ONLY || (relogin && isDemoServer(relogin.serverUrl))) {
    return <Login demoOnly relogin={relogin} onDone={onDone} onCancel={onCancel} />;
  }
  if (stage === 'password') {
    return <Login relogin={relogin} onDone={onDone} onCancel={() => setStage('start')} />;
  }

  const go = (next: Stage) => { setError(''); setStage(next); };

  /** QR 내용(스캔·붙여넣기) → 확인 단계. 엉뚱한 QR 이면 연결을 시도하지 않고 원인을 알린다 */
  const acceptQr = (text: string) => {
    const r = parsePairingUri(text, { allowHttp: ALLOW_HTTP });
    if ('error' in r) { setError(PARSE_ERROR_MESSAGES[r.error]); return; }
    const wrong = wrongServer(r);
    if (wrong) { setError(wrong); return; }
    setPicked(r);
    go('confirm');
  };

  const scan = async () => {
    setError('');
    try {
      const text = await scanPairingQr();
      if (text) acceptQr(text);
    } catch {
      setError('카메라로 QR을 읽지 못했습니다. "코드 직접 입력"으로 연결하세요.');
    }
  };

  const run = async (url: string, pairingCode: string) => {
    setBusy(true);
    setError('');
    try {
      await pair(url, pairingCode, deviceName.trim() || '태블릿');
      rememberServer(normalizeServerUrl(url));
      onDone();
    } catch (e) {
      setError(pairErrorMessage(e as Failure));
    } finally {
      setBusy(false);
    }
  };

  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    const text = code.trim();
    // QR 내용(goono-note://pair?…)을 통째로 붙여 넣어도 받는다
    if (/^goono-note:/i.test(text)) { acceptQr(text); return; }
    const c = normalizeCode(text);
    if (!c) { setError(BAD_CODE_INPUT_MESSAGE); return; }
    const url = relogin ? relogin.serverUrl : serverUrl;
    if (!normalizeServerUrl(url)) { setError('기관 구노 서버 주소를 입력하세요.'); return; }
    void run(url, c);
  };

  const demo = async () => {
    setBusy(true);
    setError('');
    try {
      await startDemo(deviceName);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const lock = relogin ? sessionLock(relogin, Date.now()) : null;
  const intro = !relogin
    ? '태블릿에서 손으로 쓰고, 연결되면 구노 전자연구노트에 올립니다. 비밀번호 대신 구노 웹에서 띄운 QR로 이 기기를 연결합니다.'
    : lock === 'REVOKED'
      ? '이 기기는 구노에서 사용 중지되었습니다. 새 QR로 다시 연결하면 기기에 남은 기록을 이어 씁니다.'
      : '연결이 만료되었습니다. 새 QR로 다시 연결하면 기기에 남은 기록을 이어 씁니다.';
  const errorBanner = error && <div className="banner danger" role="alert" data-testid="connect-error">{error}</div>;
  const deviceField = (
    <label className="field">이 기기 이름
      <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} data-testid="connect-device" />
      <span className="muted small hint">구노 웹에 "○○에서 작성 중"으로 보이고, 기기를 관리할 때 씁니다.</span>
    </label>
  );

  if (stage === 'confirm' && picked) {
    return (
      <div className="login">
        <div className="login-card" data-testid="connect-confirm">
          {relogin && <span className="chip info">다시 연결</span>}
          <h1>이 서버에 연결할까요?</h1>
          <div className="connect-host" data-testid="connect-confirm-host">{hostOf(picked.serverUrl)}</div>
          <p className="muted small">{picked.serverUrl} · 연결 코드 <span className="mono">{formatCode(picked.code)}</span></p>
          <p className="muted small">구노 웹에서 직접 띄운 QR이 맞는지 확인하세요. 모르는 서버라면 연결하지 마세요.</p>
          {deviceField}
          {errorBanner}
          <div className="row end">
            <button type="button" className="btn" disabled={busy} onClick={() => { setPicked(null); go('start'); }}>취소</button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void run(picked.serverUrl, picked.code)} data-testid="connect-confirm-ok">
              {busy ? '연결 중…' : '연결'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (stage === 'manual') {
    return (
      <div className="login">
        <form className="login-card" onSubmit={submitManual} data-testid="connect-form">
          {relogin && <span className="chip info">다시 연결</span>}
          <h1>코드 직접 입력</h1>
          <p className="muted">구노 웹의 QR 아래에 적힌 8자 코드를 넣으세요. 대소문자·하이픈은 상관없습니다. 코드는 5분 동안 한 번만 쓸 수 있습니다.</p>
          <label className="field">연결 코드
            <input className="mono-input connect-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="K7Q2-M9XD"
              autoCapitalize="characters" autoCorrect="off" autoComplete="one-time-code" spellCheck={false} data-testid="connect-code" required />
          </label>
          {deviceField}
          <div className="server">
            <label className="field">기관 구노 서버 주소
              <input value={relogin ? relogin.serverUrl : serverUrl} onChange={(e) => setServerUrl(e.target.value)} disabled={!!relogin}
                inputMode="url" autoCapitalize="off" autoCorrect="off" data-testid="connect-server" required />
              {relogin && <span className="muted small hint">다시 연결할 때는 지금 서버로만 연결합니다.</span>}
            </label>
          </div>
          {errorBanner}
          <div className="row end">
            <button type="button" className="btn" disabled={busy} onClick={() => go('start')}>뒤로</button>
            <button className="btn primary" disabled={busy} data-testid="connect-submit">{busy ? '연결 중…' : '연결'}</button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="login">
      <div className="login-card" data-testid="connect">
        {relogin && <span className="chip info">다시 연결</span>}
        <h1>QR로 연결</h1>
        <p className="muted">{intro}</p>
        {relogin && (
          <p className="muted small" data-testid="connect-account">{relogin.user.name}({relogin.user.loginId}) · {hostOf(relogin.serverUrl)}</p>
        )}
        <ol className="connect-steps small">
          <li>PC에서 구노 웹에 로그인해 <b>내 설정 ▸ 태블릿 연결</b>에서 QR을 띄웁니다.</li>
          <li>{scannable ? '"QR 읽기"를 누르고 카메라로 QR을 비춥니다.' : 'QR 아래에 적힌 8자 코드를 "코드 직접 입력"에 넣습니다.'}</li>
        </ol>
        {errorBanner}
        <div className="connect-actions">
          {scannable && (
            <button className="btn primary block" disabled={busy} onClick={() => void scan()} data-testid="connect-scan"><IcQr /> QR 읽기</button>
          )}
          <button className={`btn block${scannable ? '' : ' primary'}`} disabled={busy} onClick={() => go('manual')} data-testid="connect-manual">코드 직접 입력</button>
          {onCancel && <button className="btn ghost block" disabled={busy} onClick={onCancel}>취소</button>}
        </div>
        {ALLOW_DEMO && (
          <div className="demo-link">
            {!relogin && (
              <button type="button" className="btn ghost small" disabled={busy} onClick={() => void demo()} data-testid="connect-demo">서버 없이 체험하기</button>
            )}
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => go('password')} data-testid="connect-password">비밀번호로 연결 (개발용)</button>
            <span className="muted small">개발·체험 빌드에만 보입니다.</span>
          </div>
        )}
      </div>
    </div>
  );
}
