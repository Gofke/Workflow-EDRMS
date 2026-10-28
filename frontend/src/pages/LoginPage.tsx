import { FileCheck2, Search } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { errorText } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { ErrorNote, Field, Mark } from '../ui';

export function LoginPage() {
  const { t, language, setLanguage } = usePrefs();
  const { signIn, verifyMfa, pub } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const branding = pub?.branding;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (step === 'password') {
        const r = await signIn(email.trim(), password);
        if (r.mfaRequired) setStep('code');
      } else {
        await verifyMfa(code.trim());
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const lifecycle: [string, string][] =
    language === 'en'
      ? [
          ['Received', 'A letter arrives by post, e-mail, WijSamen or from another ministry, and is registered with its own number.'],
          ['In progress', 'It becomes part of a matter with a responsible official, a deadline, tasks and advice.'],
          ['Decided', 'The matter passes the approval route, up to the Minister where needed.'],
          ['Archived', 'The file is kept for as long as the law requires, and every step stays traceable.'],
        ]
      : [
          ['Ontvangen', 'Een brief komt binnen per post, e-mail, WijSamen of van een ander ministerie en krijgt een eigen nummer.'],
          ['In behandeling', 'Hij hoort bij een zaak met een verantwoordelijke, een termijn, taken en adviezen.'],
          ['Besloten', 'De zaak doorloopt de goedkeuringsroute, waar nodig tot de Minister.'],
          ['Gearchiveerd', 'Het dossier wordt bewaard zolang de wet dat vraagt, en elke stap blijft na te gaan.'],
        ];

  return (
    <div className="auth">
      <section className="auth-art" aria-label={branding?.organisationName}>
        <div>
          <div className="row" style={{ gap: 14 }}>
            <Mark size={48} />
            <div>
              <div style={{ fontWeight: 700, fontSize: '1.15rem' }}>{branding?.organisationName ?? 'Ministerie van Justitie en Politie'}</div>
              <div style={{ color: 'var(--rail-muted)' }}>{branding?.productName ?? 'JusPol EDRMS'}</div>
            </div>
          </div>
          <h1>{t('Post, zaken en besluiten van het ministerie op één plek.', 'The ministry’s post, matters and decisions in one place.')}</h1>
          <ol className="ledger" style={{ listStyle: 'none', padding: 0 }}>
            {lifecycle.map(([title, text], i) => (
              <li key={title} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 14px', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 6 }}>
                <span className="stamp" style={{ flex: 'none' }}>
                  {i + 1}
                </span>
                <span>
                  <strong style={{ color: '#fff' }}>{title}</strong>
                  <br />
                  <span style={{ color: 'var(--rail-text)', fontSize: '0.92rem' }}>{text}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
        <p className="small" style={{ color: 'var(--rail-muted)' }}>
          {branding?.letterheadLines?.join(' — ')}
        </p>
      </section>
      <section className="auth-form">
        <form onSubmit={submit} className="stack" style={{ '--gap': '16px' } as React.CSSProperties} aria-labelledby="signin-title">
          <div className="row between">
            <h2 id="signin-title" style={{ fontSize: 'var(--text-xl)' }}>
              {step === 'password' ? t('Aanmelden', 'Sign in') : t('Tweede stap', 'Second step')}
            </h2>
            <button type="button" className="btn sm ghost" onClick={() => setLanguage(language === 'nl' ? 'en' : 'nl')}>
              {language === 'nl' ? 'English' : 'Nederlands'}
            </button>
          </div>
          {step === 'password' ? (
            <>
              <Field label={t('E-mailadres', 'E-mail address')}>
                <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </Field>
              <Field label={t('Wachtwoord', 'Password')}>
                <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </Field>
            </>
          ) : (
            <Field label={t('Code uit uw authenticator-app', 'Code from your authenticator app')} hint={t('Of een van uw herstelcodes.', 'Or one of your recovery codes.')}>
              <input className="input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
            </Field>
          )}
          <ErrorNote error={error} />
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? t('Bezig…', 'Working…') : step === 'password' ? t('Aanmelden', 'Sign in') : t('Bevestigen', 'Confirm')}
          </button>
          <p className="small muted">
            {t('Na vijf verkeerde pogingen wordt het account een kwartier geblokkeerd. Elke aanmelding wordt vastgelegd.', 'After five wrong attempts the account is locked for fifteen minutes. Every sign-in is recorded.')}
          </p>
          <hr style={{ border: 'none', borderTop: '1px solid var(--line)', width: '100%' }} />
          <div className="stack" style={{ gap: 8 }}>
            {pub?.publicTracking.enabled !== false && (
              <Link to="/volgen" className="row small" style={{ gap: 8 }}>
                <Search size={16} /> {t('Status van uw brief volgen', 'Track the status of your letter')}
              </Link>
            )}
            <Link to="/verifieren" className="row small" style={{ gap: 8 }}>
              <FileCheck2 size={16} /> {t('Echtheid van een document controleren', 'Check that a document is genuine')}
            </Link>
          </div>
        </form>
      </section>
    </div>
  );
}
