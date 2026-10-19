import { useEffect, useState } from 'react';
import { clearPairLink, reload, start, sync, useApp } from './lib/store.ts';
import { PARSE_ERROR_MESSAGES, pairingFromUrl } from './lib/pairing.ts';
import Connect from './screens/Connect.tsx';
import { ALLOW_DEMO } from './screens/Login.tsx';
import Notes from './screens/Notes.tsx';
import Note from './screens/Note.tsx';

type Route = { name: 'list' } | { name: 'note'; id: string } | { name: 'relogin'; back: Route };

export default function App() {
  const { loaded, session, pairLink } = useApp();
  const [route, setRoute] = useState<Route>({ name: 'list' });

  useEffect(() => { void start(); }, []);
  // 딥링크(goono-note://pair…)는 연결 화면(처음 연결·다시 연결)에서만 받는다. 이미 연결된 채 다른 화면이면 무시
  useEffect(() => {
    if (loaded && session && route.name !== 'relogin') clearPairLink();
  }, [loaded, session, route.name, pairLink]);

  if (!loaded) return <div className="splash">구노 연구노트</div>;
  // 새 링크가 올 때마다 key 가 바뀌어 연결 화면이 새로 열리고 곧바로 확인 단계로 간다
  const link = pairLink ? pairingFromUrl(pairLink.url, { allowHttp: ALLOW_DEMO }) : null;
  const linkProps = {
    key: pairLink?.id ?? 0,
    target: link && !('error' in link) ? link : null,
    linkError: link && 'error' in link ? PARSE_ERROR_MESSAGES[link.error] : undefined,
  };
  if (!session) return <Connect {...linkProps} onDone={() => { clearPairLink(); void reload().then(sync); setRoute({ name: 'list' }); }} />;
  if (route.name === 'relogin') {
    return (
      <Connect {...linkProps} relogin={session} onCancel={() => { clearPairLink(); setRoute(route.back); }}
        onDone={() => { clearPairLink(); void reload().then(sync); setRoute(route.back); }} />
    );
  }
  const relogin = () => setRoute({ name: 'relogin', back: route });
  if (route.name === 'note') {
    return <Note key={route.id} id={route.id} onBack={() => setRoute({ name: 'list' })} onOpen={(id) => setRoute({ name: 'note', id })} onRelogin={relogin} />;
  }
  return <Notes onOpen={(id) => setRoute({ name: 'note', id })} onRelogin={relogin} onLoggedOut={() => setRoute({ name: 'list' })} />;
}
