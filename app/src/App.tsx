import { useEffect, useState } from 'react';
import { reload, start, sync, useApp } from './lib/store.ts';
import Login from './screens/Login.tsx';
import Notes from './screens/Notes.tsx';
import Note from './screens/Note.tsx';

type Route = { name: 'list' } | { name: 'note'; id: string } | { name: 'relogin'; back: Route };

export default function App() {
  const { loaded, session } = useApp();
  const [route, setRoute] = useState<Route>({ name: 'list' });

  useEffect(() => { void start(); }, []);

  if (!loaded) return <div className="splash">구노 연구노트</div>;
  if (!session) return <Login onDone={() => { void reload().then(sync); setRoute({ name: 'list' }); }} />;
  if (route.name === 'relogin') {
    return <Login relogin={session} onCancel={() => setRoute(route.back)} onDone={() => { void reload().then(sync); setRoute(route.back); }} />;
  }
  const relogin = () => setRoute({ name: 'relogin', back: route });
  if (route.name === 'note') {
    return <Note key={route.id} id={route.id} onBack={() => setRoute({ name: 'list' })} onOpen={(id) => setRoute({ name: 'note', id })} onRelogin={relogin} />;
  }
  return <Notes onOpen={(id) => setRoute({ name: 'note', id })} onRelogin={relogin} onLoggedOut={() => setRoute({ name: 'list' })} />;
}
