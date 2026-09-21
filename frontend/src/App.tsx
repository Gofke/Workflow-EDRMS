import { useEffect, useState } from 'react';
import { api, AuthenticatedUser } from './api';
import { IdentityPage } from './pages/IdentityPage';
import { LoginPage } from './pages/LoginPage';

type State = 'checking' | 'signed-out' | 'signed-in';

export function App() {
  const [state, setState] = useState<State>('checking');
  const [user, setUser] = useState<AuthenticatedUser | null>(null);

  // On load, ask the server who we are. An existing valid session restores the
  // signed-in view; anything else shows the sign-in screen.
  useEffect(() => {
    api
      .me()
      .then((me) => {
        setUser(me);
        setState('signed-in');
      })
      .catch(() => setState('signed-out'));
  }, []);

  const handleSignedIn = (me: AuthenticatedUser) => {
    setUser(me);
    setState('signed-in');
  };

  const handleSignOut = async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
    setState('signed-out');
  };

  if (state === 'checking') {
    return (
      <main className="centre">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (state === 'signed-in' && user) {
    return <IdentityPage user={user} onSignOut={handleSignOut} />;
  }

  return <LoginPage onSignedIn={handleSignedIn} />;
}
