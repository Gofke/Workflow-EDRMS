import { FileCheck2, Search } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, errorText } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { DisplayButtons } from '../shell/Layout';
import { ErrorNote, Field, Mark, Notice } from '../ui';

interface Refusal {
  locked?: boolean;
  lockedUntil?: string | null;
  attemptsLeft?: number;
  lockoutMinutes?: number;
}

export function LoginPage() {
  const { t, language } = usePrefs();
  const { signIn, verifyMfa, pub } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [now, setNow] = useState(Date.now());
  const branding = pub?.branding;
  const lockedUntil = refusal?.lockedUntil ? new Date(refusal.lockedUntil).getTime() : null;
  const locked = !!refusal?.locked && lockedUntil !== null && lockedUntil > now;
  useEffect(() => {
    if (!locked) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [locked]);
  const secondsLeft = lockedUntil ? Math.max(0, Math.ceil((lockedUntil - now) / 1000)) : 0;
  const mmss = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setRefusal(null);
    try {
      if (step === 'password') {
        const r = await signIn(email.trim(), password);
        if (r.mfaRequired) setStep('code');
      } else {
        await verifyMfa(code.trim());
      }
    } catch (err) {
      const body = err instanceof ApiError && err.body && typeof err.body === 'object' ? (err.body as Refusal) : null;
      if (body && (body.locked || typeof body.attemptsLeft === 'number')) {
        setRefusal(body);
        setNow(Date.now());
        if (!body.locked) setError(errorText(err));
      } else {
        setError(errorText(err));
      }
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
      <div className="auth-display">
        <DisplayButtons />
      </div>
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
          <h2 id="signin-title" style={{ fontSize: 'var(--text-xl)' }}>
            {step === 'password' ? t('Aanmelden', 'Sign in') : t('Tweede stap', 'Second step')}
          </h2>
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
          {locked && (
            <Notice tone="danger">
              {t(`Dit e-mailadres is tijdelijk geblokkeerd na te veel verkeerde pogingen. Probeer het over ${mmss} opnieuw.`, `This e-mail address is temporarily locked after too many wrong attempts. Try again in ${mmss}.`)}
            </Notice>
          )}
          {!locked && refusal && typeof refusal.attemptsLeft === 'number' && (
            <Notice tone="warn">
              {t(
                `Nog ${refusal.attemptsLeft} ${refusal.attemptsLeft === 1 ? 'poging' : 'pogingen'} voordat dit adres ${refusal.lockoutMinutes ?? 15} minuten wordt geblokkeerd.`,
                `${refusal.attemptsLeft} ${refusal.attemptsLeft === 1 ? 'attempt' : 'attempts'} left before this address is locked for ${refusal.lockoutMinutes ?? 15} minutes.`,
              )}
            </Notice>
          )}
          <button type="submit" className="btn primary" disabled={busy || locked}>
            {busy ? t('Bezig…', 'Working…') : step === 'password' ? t('Aanmelden', 'Sign in') : t('Bevestigen', 'Confirm')}
          </button>
          <p className="small muted">
            {t('Elke aanmelding wordt vastgelegd.', 'Every sign-in is recorded.')}
          </p>
          <hr style={{ border: 'none', borderTop: '1px solid var(--line)', width: '100%' }} />
          <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
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
