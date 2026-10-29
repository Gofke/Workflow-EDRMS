import { BellRing, KeyRound, LogIn, Plane, ShieldCheck, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { addDays, date, dateTime, today } from '../lib/format';
import { useApi } from '../lib/hooks';
import { ROLE } from '../lib/labels';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { Avatar, Badge, ErrorNote, Field, KV, Loading, Notice, PageHead, Panel, Tabs, useToast } from '../ui';
import { PersonSelect } from '../ui/people';

type Tab = 'profiel' | 'beveiliging' | 'meldingen' | 'afwezigheid';

const KINDS: Record<string, [string, string]> = {
  TASK_ASSIGNED: ['Een taak is aan mij toegewezen', 'A task is assigned to me'],
  TASK_UPDATED: ['Een taak van mij is gewijzigd', 'A task of mine is changed'],
  TASK_COMMENT: ['Opmerking bij mijn taak', 'Comment on my task'],
  TASK_MENTION: ['Iemand noemt mij in een opmerking', 'Someone mentions me in a comment'],
  TASK_COMPLETED: ['Een taak die ik uitzette is afgerond', 'A task I assigned is completed'],
  TASK_REJECTED: ['Een taak die ik uitzette is geweigerd', 'A task I assigned is declined'],
  TASK_CANCELLED: ['Een taak van mij is geannuleerd', 'A task of mine is cancelled'],
  REVIEW_REQUESTED: ['Een zaak wacht op mijn beoordeling', 'A matter awaits my review'],
  MATTER_RETURNED: ['Mijn zaak is teruggestuurd', 'My matter is returned'],
  MATTER_APPROVED: ['Mijn zaak is goedgekeurd', 'My matter is approved'],
  MATTER_FINALISED: ['Mijn zaak is afgerond', 'My matter is finalised'],
  RESPONSIBILITY_ASSIGNED: ['Ik ben verantwoordelijk voor een zaak', 'I am made responsible for a matter'],
  ADVICE_REQUESTED: ['Mijn advies wordt gevraagd', 'My advice is requested'],
  ADVICE_GIVEN: ['Er is advies gegeven op mijn vraag', 'Advice was given on my request'],
  DEADLINE_REMINDER: ['Een termijn nadert', 'A deadline is near'],
  DEADLINE_OVERDUE: ['Een termijn is verstreken', 'A deadline has passed'],
  DEADLINE_ESCALATION: ['Een termijn in mijn afdeling is verstreken', 'A deadline in my department has passed'],
  SECURITY_ALERT: ['Beveiligingsmelding over mijn account', 'Security alert about my account'],
  OUT_OF_OFFICE: ['Ik vervang iemand', 'I am standing in for someone'],
  WEEKLY_REPORT: ['Weekrapport', 'Weekly report'],
  INTAKE_RECEIVED: ['Post binnengekomen via e-mail of WijSamen', 'Post received by e-mail or WijSamen'],
};

export default function ProfilePage() {
  const { t } = usePrefs();
  const { user, business } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'profiel';
  if (!user) return null;
  return (
    <>
      <PageHead title={t('Mijn profiel', 'My profile')} />
      <Tabs
        label={t('Profiel', 'Profile')}
        value={tab}
        onChange={(v) => setParams(v === 'profiel' ? {} : { tab: v }, { replace: true })}
        tabs={[
          { value: 'profiel', label: t('Profiel', 'Profile') },
          { value: 'beveiliging', label: t('Wachtwoord en beveiliging', 'Password and security') },
          { value: 'meldingen', label: t('Meldingen', 'Notifications') },
          { value: 'afwezigheid', label: t('Afwezigheid', 'Out of office'), hidden: !business },
        ]}
      />
      <div style={{ marginTop: 20 }}>
        {tab === 'profiel' && <ProfileTab />}
        {tab === 'beveiliging' && <SecurityTab />}
        {tab === 'meldingen' && <NotificationsTab />}
        {tab === 'afwezigheid' && <AbsenceTab />}
      </div>
    </>
  );
}

function ProfileTab() {
  const { t, language, setLanguage, theme, setTheme, textSize, setTextSize } = usePrefs();
  const { user } = useSession();
  if (!user) return null;
  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <Panel>
        <div className="row" style={{ gap: 16, marginBottom: 16 }}>
          <Avatar name={user.personName} />
          <div className="stack" style={{ gap: 2 }}>
            <strong style={{ fontSize: '1.2rem' }}>{user.personName}</strong>
            <span className="muted small">{user.jobPosition ?? ''}</span>
          </div>
        </div>
        <KV
          rows={[
            [t('Aanmeldnaam', 'Sign-in name'), user.email],
            [t('Afdeling', 'Department'), user.organisationalUnit ?? '—'],
            [
              t('Rollen', 'Roles'),
              <span key="r" className="chips">
                {user.roles.map((r) => (
                  <Badge key={r.code}>{ROLE[r.code] ? t(ROLE[r.code][0], ROLE[r.code][1]) : r.name}</Badge>
                ))}
              </span>,
            ],
          ]}
        />
        <p className="xs muted" style={{ marginBottom: 0 }}>
          {t('Naam, afdeling en rollen worden door de beheerder bijgehouden.', 'Name, department and roles are kept by the administrator.')}
        </p>
      </Panel>
      <Panel title={t('Weergave', 'Display')}>
        <div className="stack">
          <Field label={t('Taal', 'Language')}>
            <select className="select" value={language} onChange={(e) => setLanguage(e.target.value as 'nl' | 'en')}>
              <option value="nl">Nederlands</option>
              <option value="en">English</option>
            </select>
          </Field>
          <Field label={t('Kleuren', 'Colours')}>
            <select className="select" value={theme} onChange={(e) => setTheme(e.target.value as 'light' | 'dark' | 'contrast')}>
              <option value="light">{t('Licht', 'Light')}</option>
              <option value="dark">{t('Donker', 'Dark')}</option>
              <option value="contrast">{t('Hoog contrast', 'High contrast')}</option>
            </select>
          </Field>
          <Field label={t('Tekstgrootte', 'Text size')}>
            <select className="select" value={textSize} onChange={(e) => setTextSize(e.target.value as 'normal' | 'large' | 'larger')}>
              <option value="normal">{t('Normaal', 'Normal')}</option>
              <option value="large">{t('Groot', 'Large')}</option>
              <option value="larger">{t('Extra groot', 'Extra large')}</option>
            </select>
          </Field>
          <p className="xs muted" style={{ margin: 0 }}>
            {t('Deze keuzes gelden op dit apparaat.', 'These choices apply on this device.')}
          </p>
        </div>
      </Panel>
    </div>
  );
}

function SecurityTab() {
  const { t, language } = usePrefs();
  const toast = useToast();
  const mfa = useApi<{ enabled: boolean; recoveryCodesLeft: number }>('/api/security/mfa');
  const history = useApi<{ occurredAt: string; succeeded: boolean; reason: string | null; ipAddress: string | null; userAgent: string | null }[]>('/api/security/login-history');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [pwError, setPwError] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const device = (ua: string | null) => {
    if (!ua) return t('onbekend apparaat', 'unknown device');
    const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
    const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /curl/.test(ua) ? t('systeemkoppeling', 'system link') : '';
    return [br, os].filter(Boolean).join(t(' op ', ' on ')) || t('onbekend apparaat', 'unknown device');
  };
  // An address inside the ministry's own network says so, rather than showing a bare number.
  const where = (ip: string | null) => {
    if (!ip) return '';
    const bare = ip.replace(/^::ffff:/, '');
    if (bare === '127.0.0.1' || bare === '::1') return t('intern netwerk', 'internal network');
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(bare)) return `${t('intern netwerk', 'internal network')}, ${bare}`;
    return bare;
  };
  return (
    <div className="split">
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <Panel title={t('Wachtwoord wijzigen', 'Change password')}>
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setPwError(null);
              if (next !== again) return setPwError(t('De twee nieuwe wachtwoorden zijn niet gelijk.', 'The two new passwords differ.'));
              try {
                await api.post('/api/security/password', { currentPassword: current, newPassword: next });
                setCurrent('');
                setNext('');
                setAgain('');
                toast(t('Wachtwoord gewijzigd. Andere sessies zijn afgemeld.', 'Password changed. Other sessions were signed out.'));
              } catch (err) {
                setPwError(errorText(err));
              }
            }}
          >
            <div className="form-grid">
              <Field label={t('Huidig wachtwoord', 'Current password')}>
                <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
              </Field>
              <Field label={t('Nieuw wachtwoord', 'New password')} hint={t('Minstens 12 tekens. Een zin van een paar woorden werkt goed.', 'At least 12 characters. A sentence of a few words works well.')}>
                <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
              </Field>
              <Field label={t('Nieuw wachtwoord nogmaals', 'New password again')}>
                <input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
              </Field>
            </div>
            <div className="row">
              <button type="submit" className="btn primary" disabled={!current || next.length < 8}>
                <KeyRound size={16} /> {t('Wachtwoord wijzigen', 'Change password')}
              </button>
            </div>
            <ErrorNote error={pwError} />
          </form>
        </Panel>
        <Panel title={t('Tweestapsverificatie', 'Two-step verification')}>
          {!mfa.data ? (
            <Loading />
          ) : codes ? (
            <Notice tone="warn" title={t('Bewaar deze herstelcodes op papier', 'Keep these recovery codes on paper')}>
              <p className="small" style={{ marginTop: 0 }}>
                {t('Elke code werkt één keer, als u uw telefoon niet bij de hand hebt. Ze worden niet opnieuw getoond.', 'Each code works once, when your phone is not at hand. They are not shown again.')}
              </p>
              <div className="recovery-codes mono">
                {codes.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
              <button type="button" className="btn sm" style={{ marginTop: 10 }} onClick={() => (setCodes(null), void mfa.reload())}>
                {t('Ik heb ze bewaard', 'I have kept them')}
              </button>
            </Notice>
          ) : mfa.data.enabled ? (
            <div className="stack">
              <p style={{ margin: 0 }}>
                <ShieldCheck size={18} style={{ color: 'var(--ok)', verticalAlign: '-3px' }} /> {t('Aan. Bij aanmelden vraagt het systeem ook een code uit uw app.', 'On. When signing in, the system also asks for a code from your app.')}
              </p>
              <span className="small muted">{t(`${mfa.data.recoveryCodesLeft} herstelcodes over.`, `${mfa.data.recoveryCodesLeft} recovery codes left.`)}</span>
              <div className="row">
                <input className="input" style={{ maxWidth: 180 }} inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder={t('code uit de app', 'code from the app')} aria-label={t('Code', 'Code')} />
                <button
                  type="button"
                  className="btn ghost"
                  disabled={code.length < 6}
                  onClick={async () => {
                    setMfaError(null);
                    try {
                      await api.post('/api/security/mfa/disable', { code });
                      setCode('');
                      void mfa.reload();
                      toast(t('Tweestapsverificatie uitgezet', 'Two-step verification turned off'));
                    } catch (e) {
                      setMfaError(errorText(e));
                    }
                  }}
                >
                  {t('Uitzetten', 'Turn off')}
                </button>
              </div>
            </div>
          ) : setup ? (
            <div className="row" style={{ alignItems: 'flex-start', gap: 20 }}>
              <img src={setup.qrDataUrl} alt={t('QR-code om in de authenticator-app te scannen', 'QR code to scan in the authenticator app')} width={180} height={180} className="qr" />
              <div className="stack grow" style={{ minWidth: 220 }}>
                <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
                  <li>{t('Open een authenticator-app (bijv. Microsoft of Google Authenticator).', 'Open an authenticator app (e.g. Microsoft or Google Authenticator).')}</li>
                  <li>{t('Scan de code, of typ de sleutel hieronder.', 'Scan the code, or type the key below.')}</li>
                  <li>{t('Vul de zescijferige code in die de app toont.', 'Enter the six-digit code the app shows.')}</li>
                </ol>
                <span className="xs mono" style={{ wordBreak: 'break-all' }}>
                  {setup.secret}
                </span>
                <div className="row">
                  <input className="input" style={{ maxWidth: 160 }} inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" aria-label={t('Code', 'Code')} />
                  <button
                    type="button"
                    className="btn primary"
                    disabled={code.length < 6}
                    onClick={async () => {
                      setMfaError(null);
                      try {
                        const r = await api.post<{ recoveryCodes: string[] }>('/api/security/mfa/enable', { code });
                        setCodes(r.recoveryCodes);
                        setSetup(null);
                        setCode('');
                      } catch (e) {
                        setMfaError(errorText(e));
                      }
                    }}
                  >
                    {t('Aanzetten', 'Turn on')}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="stack">
              <p style={{ margin: 0 }}>{t('Met tweestapsverificatie is een gestolen wachtwoord alleen niet genoeg om in uw account te komen.', 'With two-step verification a stolen password alone is not enough to get into your account.')}</p>
              <div className="row">
                <button type="button" className="btn primary" onClick={async () => setSetup(await api.post('/api/security/mfa/setup'))}>
                  <Smartphone size={16} /> {t('Instellen', 'Set up')}
                </button>
              </div>
            </div>
          )}
          <ErrorNote error={mfaError} />
        </Panel>
      </div>
      <Panel title={t('Laatste aanmeldingen', 'Recent sign-ins')} flush>
        <p className="xs muted" style={{ padding: '0 20px', margin: '0 0 6px' }}>
          {t('Ziet u een aanmelding die u niet herkent? Wijzig uw wachtwoord en meld het aan de beheerder.', 'See a sign-in you do not recognise? Change your password and tell the administrator.')}
        </p>
        <ul className="list">
          {(history.data ?? []).slice(0, 12).map((h, i) => (
            <li key={i} className="row" style={{ gap: 10, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
              <LogIn size={16} style={{ marginTop: 3, color: h.succeeded ? 'var(--ok)' : 'var(--danger)', flex: 'none' }} aria-hidden="true" />
              <span className="stack" style={{ gap: 1 }}>
                <span className="small">
                  {dateTime(h.occurredAt, language)} {!h.succeeded && <Badge tone="danger">{t('mislukt', 'failed')}</Badge>}
                </span>
                <span className="xs muted">
                  {device(h.userAgent)}
                  {h.ipAddress ? `, ${where(h.ipAddress)}` : ''}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

interface Prefs { kinds: Record<string, { email: boolean; sms: boolean; push: boolean }>; emailMode: 'IMMEDIATE' | 'DIGEST' | 'OFF'; mobileNumber: string | null; language: 'nl' | 'en' }

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function NotificationsTab() {
  const { t } = usePrefs();
  const { client } = useSession();
  const toast = useToast();
  const { data, reload } = useApi<Prefs>('/api/notifications/preferences');
  const [draft, setDraft] = useState<Prefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pushState, setPushState] = useState<string | null>(null);
  const v = draft ?? data;
  if (!v) return <Loading lines={6} />;
  const set = (patch: Partial<Prefs>) => setDraft({ ...v, ...patch });
  const toggle = (kind: string, channel: 'email' | 'sms' | 'push', on: boolean) => set({ kinds: { ...v.kinds, [kind]: { ...v.kinds[kind], [channel]: on } } });
  const smsOn = client?.notifications.smsEnabled;
  const pushOn = client?.notifications.pushEnabled;
  const enablePush = async () => {
    setPushState(null);
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error(t('Deze browser ondersteunt geen pushmeldingen.', 'This browser does not support push notifications.'));
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) throw new Error(t('Installeer de app eerst (of open de beveiligde productieversie); dan kunnen pushmeldingen worden aangezet.', 'Install the app first (or open the secure production version); then push notifications can be turned on.'));
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error(t('Toestemming voor meldingen is niet gegeven.', 'Permission for notifications was not given.'));
      const { publicKey } = await api.get<{ publicKey: string }>('/api/notifications/push/public-key');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource });
      const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      await api.post('/api/notifications/push/subscribe', { endpoint: json.endpoint, keys: json.keys });
      await api.post('/api/notifications/push/test');
      setPushState(t('Pushmeldingen staan aan op dit apparaat. Er is een testmelding verstuurd.', 'Push notifications are on for this device. A test notification was sent.'));
    } catch (e) {
      setPushState((e as Error).message);
    }
  };
  return (
    <div className="split">
      <Panel
        title={t('Waarover wilt u een bericht', 'What do you want a message about')}
        flush
        actions={
          <button
            type="button"
            className="btn sm primary"
            disabled={!draft}
            onClick={async () => {
              setError(null);
              try {
                await api.put('/api/notifications/preferences', { kinds: v.kinds, emailMode: v.emailMode, mobileNumber: v.mobileNumber || null, language: v.language });
                setDraft(null);
                void reload();
                toast(t('Voorkeuren opgeslagen', 'Preferences saved'));
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            {t('Opslaan', 'Save')}
          </button>
        }
      >
        <p className="xs muted" style={{ padding: '0 20px', margin: '0 0 8px' }}>
          {smsOn
            ? t('In het systeem (de bel) krijgt u altijd alles. Hier kiest u wat u daarnaast per e-mail, sms of pushmelding wilt.', 'In the system (the bell) you always get everything. Here you choose what you also want by e-mail, text message or push notification.')
            : t('In het systeem (de bel) krijgt u altijd alles. Hier kiest u wat u daarnaast per e-mail of pushmelding wilt.', 'In the system (the bell) you always get everything. Here you choose what you also want by e-mail or push notification.')}
        </p>
        <ErrorNote error={error} />
        <div className="table-wrap">
          <table className="table pref-table">
            <thead>
              <tr>
                <th>{t('Gebeurtenis', 'Event')}</th>
                <th>{t('E-mail', 'E-mail')}</th>
                {smsOn && <th>SMS</th>}
                {pushOn && <th>Push</th>}
              </tr>
            </thead>
            <tbody>
              {Object.keys(v.kinds).map((k) => (
                <tr key={k}>
                  <td className="small">{KINDS[k] ? t(KINDS[k][0], KINDS[k][1]) : k}</td>
                  <td>
                    <input type="checkbox" checked={v.kinds[k].email} onChange={(e) => toggle(k, 'email', e.target.checked)} aria-label={`${KINDS[k]?.[0] ?? k}: e-mail`} />
                  </td>
                  {smsOn && (
                    <td>
                      <input type="checkbox" checked={v.kinds[k].sms} onChange={(e) => toggle(k, 'sms', e.target.checked)} aria-label={`${KINDS[k]?.[0] ?? k}: sms`} />
                    </td>
                  )}
                  {pushOn && (
                    <td>
                      <input type="checkbox" checked={v.kinds[k].push} onChange={(e) => toggle(k, 'push', e.target.checked)} aria-label={`${KINDS[k]?.[0] ?? k}: push`} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <Panel title={t('E-mail', 'E-mail')}>
          <div className="stack">
            {(
              [
                ['IMMEDIATE', t('Direct, per gebeurtenis', 'Immediately, per event')],
                ['DIGEST', t('Eén overzicht per dag', 'One overview per day')],
                ['OFF', t('Geen e-mail', 'No e-mail')],
              ] as const
            ).map(([m, label]) => (
              <label key={m} className="check">
                <input type="radio" name="emailMode" checked={v.emailMode === m} onChange={() => set({ emailMode: m })} /> {label}
              </label>
            ))}
            <Field label={t('Taal van berichten', 'Language of messages')}>
              <select className="select" value={v.language} onChange={(e) => set({ language: e.target.value as 'nl' | 'en' })}>
                <option value="nl">Nederlands</option>
                <option value="en">English</option>
              </select>
            </Field>
          </div>
        </Panel>
        {smsOn && (
          <Panel title="SMS">
            <Field label={t('Mobiel nummer', 'Mobile number')} hint={t('Met landcode, bijv. +597 8123456', 'With country code, e.g. +597 8123456')}>
              <input className="input" value={v.mobileNumber ?? ''} onChange={(e) => set({ mobileNumber: e.target.value })} />
            </Field>
          </Panel>
        )}
        {pushOn && (
          <Panel title={t('Pushmeldingen op dit apparaat', 'Push notifications on this device')}>
            <p className="small muted" style={{ marginTop: 0 }}>
              {t('Op een telefoon: zet het systeem eerst op het beginscherm (Delen → Zet op beginscherm). Daarna komen meldingen binnen als bij een gewone app.', 'On a phone: first add the system to the home screen (Share → Add to Home Screen). Notifications then arrive as with a normal app.')}
            </p>
            <button type="button" className="btn" onClick={() => void enablePush()}>
              <BellRing size={16} /> {t('Pushmeldingen aanzetten', 'Turn on push notifications')}
            </button>
            {pushState && (
              <p className="small" style={{ marginBottom: 0 }}>
                {pushState}
              </p>
            )}
          </Panel>
        )}
      </div>
    </div>
  );
}

function AbsenceTab() {
  const { t, language } = usePrefs();
  const toast = useToast();
  const { decision } = useSession();
  const mine = useApi<{ id: string; startsOn: string; endsOn: string; standInName: string; message: string | null; endedAt: string | null; active?: boolean }[]>('/api/out-of-office/mine');
  const [from, setFrom] = useState(today());
  const [until, setUntil] = useState(addDays(today(), 7));
  const [standIn, setStandIn] = useState('');
  const [message, setMessage] = useState('');
  const [delegate, setDelegate] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const current = (mine.data ?? []).filter((m) => !m.endedAt && m.endsOn >= today());
  return (
    <div className="split">
      <Panel title={t('Afwezigheid melden', 'Report absence')}>
        <div className="stack">
          <p className="small muted" style={{ marginTop: 0 }}>
            {t('Uw vervanger krijgt uw meldingen en beoordelingen in deze periode, en wie u een taak geeft, ziet dat u afwezig bent.', 'Your stand-in receives your notifications and reviews in this period, and anyone giving you a task sees that you are away.')}
          </p>
          <div className="form-grid">
            <Field label={t('Van', 'From')}>
              <input className="input" type="date" value={from} min={today()} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label={t('Tot en met', 'Until')}>
              <input className="input" type="date" value={until} min={from} onChange={(e) => setUntil(e.target.value)} />
            </Field>
          </div>
          <Field label={t('Vervanger', 'Stand-in')}>
            <PersonSelect value={standIn} onChange={setStandIn} />
          </Field>
          <Field label={t('Bericht (niet verplicht)', 'Message (optional)')}>
            <input className="input" value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t('bijv. Op dienstreis naar Nickerie', 'e.g. On official travel to Nickerie')} />
          </Field>
          {decision && (
            <label className="check">
              <input type="checkbox" checked={delegate} onChange={(e) => setDelegate(e.target.checked)} />
              {t('Mijn vervanger mag in deze periode ook verantwoordelijken aanwijzen en termijnen zetten (delegatie)', 'My stand-in may also assign responsibility and set deadlines in this period (delegation)')}
            </label>
          )}
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={!standIn || until < from}
              onClick={async () => {
                setError(null);
                try {
                  await api.post('/api/out-of-office', { startsOn: from, endsOn: until, standInAccountId: standIn, message: message || undefined, delegate: decision ? delegate : false });
                  toast(t('Afwezigheid vastgelegd', 'Absence recorded'));
                  setMessage('');
                  void mine.reload();
                } catch (e) {
                  setError(errorText(e));
                }
              }}
            >
              <Plane size={16} /> {t('Afwezigheid vastleggen', 'Record absence')}
            </button>
          </div>
          <ErrorNote error={error} />
        </div>
      </Panel>
      <Panel title={t('Uw afwezigheid', 'Your absence')} flush>
        {!mine.data ? (
          <Loading />
        ) : mine.data.length === 0 ? (
          <p className="small muted" style={{ padding: '4px 20px 14px' }}>
            {t('Geen afwezigheid gepland.', 'No absence planned.')}
          </p>
        ) : (
          <ul className="list">
            {mine.data.map((m) => (
              <li key={m.id} className="row between">
                <span className="stack" style={{ gap: 2 }}>
                  <strong className="small">
                    {date(m.startsOn, language)} – {date(m.endsOn, language)}
                  </strong>
                  <span className="xs muted">
                    {t('vervanger', 'stand-in')}: {m.standInName}
                    {m.message ? `, “${m.message}”` : ''}
                  </span>
                </span>
                {current.includes(m) ? (
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={async () => {
                      await api.post(`/api/out-of-office/${m.id}/end`);
                      void mine.reload();
                    }}
                  >
                    {t('Beëindigen', 'End')}
                  </button>
                ) : (
                  <Badge>{m.endedAt ? t('beëindigd', 'ended') : t('voorbij', 'past')}</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
