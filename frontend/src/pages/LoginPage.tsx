import { useState } from 'react';
import { APP_VERSION, api, AuthenticatedUser } from '../api';

interface Props {
  onSignedIn: (user: AuthenticatedUser) => void;
}

export function LoginPage({ onSignedIn }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      onSignedIn(await api.login(email, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="centre">
      <section className="card" aria-labelledby="sign-in-heading">
        <p className="eyebrow">Ministry of Justice and Police</p>
        <h1 id="sign-in-heading">JusPol EDRMS</h1>
        <p className="muted">Sign in with your individual account.</p>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <label htmlFor="email">Email address</label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />

        <button type="button" className="primary" onClick={submit} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="footnote">Test environment. Version {APP_VERSION}.</p>
      </section>
    </main>
  );
}
