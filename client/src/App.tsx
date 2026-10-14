import { useEffect, useState } from 'react';
import { Lobby } from './pages/Lobby';
import { Room } from './pages/Room';
import { normalizeRoomCode } from '@shared/protocol';

function parse(path: string) {
  const m = path.match(/^\/r\/([A-Za-z0-9-]{4,10})\/?$/);
  return m ? normalizeRoomCode(m[1]) : null;
}

export function navigate(to: string) {
  history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const code = parse(path);
  return code ? <Room key={code} code={code} /> : <Lobby />;
}
