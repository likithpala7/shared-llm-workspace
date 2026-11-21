import { useCallback, useEffect, useState } from 'react';
import { Home } from './pages/Home';
import { Join } from './pages/Join';
import { WorkspacePage } from './pages/WorkspacePage';

export function App() {
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((path: string) => {
    window.history.pushState({}, '', path);
    setPathname(path);
  }, []);

  const workspaceMatch = pathname.match(/^\/w\/([^/]+)$/);
  if (workspaceMatch) {
    return <WorkspacePage workspaceId={workspaceMatch[1]} navigate={navigate} />;
  }

  const joinMatch = pathname.match(/^\/join\/([^/]+)$/);
  if (joinMatch) {
    return <Join inviteToken={joinMatch[1]} navigate={navigate} />;
  }

  return <Home navigate={navigate} />;
}
