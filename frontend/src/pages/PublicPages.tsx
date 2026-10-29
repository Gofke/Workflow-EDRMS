import { Check, FileCheck2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { dateTime, longDate, today } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { ErrorNote, Field, Mark, Panel } from '../ui';

function PublicShell({ children }: { children: ReactNode }) {
  const { t, language, setLanguage } = usePrefs();
  const { pub } = useSession();
  return (
    <div className="public">
      <header className="public-head">
        <Mark size={38} />
        <div className="grow">
          <strong>{pub?.branding.organisationName ?? 'Ministerie van Justitie en Politie'}</strong>
          <div className="small" style={{ color: 'var(--rail-muted)' }}>
            {t('Openbare dienstverlening', 'Public service')}
          </div>
        </div>
        <button type="button" className="btn sm" onClick={() => setLanguage(language === 'nl' ? 'en' : 'nl')}>
          {language === 'nl' ? 'English' : 'Nederlands'}
        </button>
      </header>
      <main>
        <div className="card stack" style={{ '--gap': '18px' } as React.CSSProperties}>
          {children}
          <Link to="/" className="small">
            {t('Medewerkers: aanmelden', 'Staff: sign in')}
          </Link>
        </div>
      </main>
    </div>
  );
}

interface TrackResult {
  reference: string;
  status: 'RECEIVED' | 'IN_PROGRESS' | 'COMPLETED';
  receivedOn: string;
  expectedBy: string | null;
  lastUpdate: string;
}

/** For the sender: where is my letter? Status only, never content. */
export function TrackPage() {
  const { t, language } = usePrefs();
  const [params] = useSearchParams();
  const [reference, setReference] = useState(params.get('nummer') ?? '');
  const [code, setCode] = useState(params.get('code') ?? '');
  const [result, setResult] = useState<TrackResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const lookup = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await api.post<TrackResult>('/api/public/track', { reference: reference.trim(), code: code.trim() }));
    } catch (err) {
      setResult(null);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (params.get('nummer') && params.get('code')) void lookup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stages: [TrackResult['status'], string][] = [
    ['RECEIVED', t('Ontvangen en geregistreerd', 'Received and registered')],
    ['IN_PROGRESS', t('In behandeling', 'In progress')],
    ['COMPLETED', t('Afgehandeld', 'Completed')],
  ];
  const at = result ? stages.findIndex(([s]) => s === result.status) : -1;

  return (
    <PublicShell>
      <div>
        <h1>{t('Status van uw brief', 'Status of your letter')}</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          {t('Vul het registratienummer en de volgcode in van het ontvangstbewijs dat u kreeg.', 'Enter the registration number and tracking code from the receipt you were given.')}
        </p>
      </div>
      <Panel>
        <form onSubmit={lookup} className="form-grid">
          <Field label={t('Registratienummer', 'Registration number')}>
            <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="IN-2026-00012" required />
          </Field>
          <Field label={t('Volgcode', 'Tracking code')}>
            <input className="input" value={code} onChange={(e) => setCode(e.target.value)} required autoComplete="off" />
          </Field>
          <div className="wide">
            <button className="btn primary" type="submit" disabled={busy}>
              {t('Status opvragen', 'Look up status')}
            </button>
          </div>
        </form>
      </Panel>
      <ErrorNote error={error} />
      {result && (
        <Panel title={`${t('Brief', 'Letter')} ${result.reference}`}>
          <ol className="progress-steps">
            {stages.map(([s, label], i) => (
              <li key={s} className={i < at || (i === at && s === 'COMPLETED') ? 'done' : i === at ? 'current' : ''}>
                <span className="tick">{i < at || (i === at && s === 'COMPLETED') ? <Check size={16} /> : i + 1}</span>
                {label}
              </li>
            ))}
          </ol>
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>{t('Ontvangen op', 'Received on')}</dt>
            <dd>{longDate(result.receivedOn, language)}</dd>
            {result.expectedBy && (
              <>
                <dt>{t('Verwachte afhandeling', 'Expected completion')}</dt>
                <dd>
                  {t('uiterlijk', 'by')} {longDate(result.expectedBy, language)}
                  {result.expectedBy < today() && (
                    <span className="small muted" style={{ display: 'block', fontWeight: 400 }}>
                      {t('Deze datum is verstreken; uw brief is nog in behandeling.', 'This date has passed; your letter is still being handled.')}
                    </span>
                  )}
                </dd>
              </>
            )}
            <dt>{t('Laatst bijgewerkt', 'Last updated')}</dt>
            <dd>{dateTime(result.lastUpdate, language)}</dd>
          </dl>
        </Panel>
      )}
    </PublicShell>
  );
}

interface SealResult {
  valid: boolean;
  reason: string | null;
  issuer: string | null;
  kind: string | null;
  title: string | null;
  registrationIdentity: string | null;
  documentSha256: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  sealedBy: string;
  sealedAt: string;
  keyId: string;
}

/** For anyone holding a sealed document: is it genuine and unchanged? */
export function VerifyPage() {
  const { t, language } = usePrefs();
  const { id } = useParams();
  const navigate = useNavigate();
  const [input, setInput] = useState(id ?? '');
  const [result, setResult] = useState<SealResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    setResult(null);
    setError(null);
    api
      .get<SealResult>(`/api/public/seals/${id}`)
      .then(setResult)
      .catch((e) => setError(errorText(e)));
  }, [id]);
  return (
    <PublicShell>
      <div>
        <h1>{t('Echtheid controleren', 'Check authenticity')}</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          {t('Scan de QR-code op het document of vul het zegelnummer in.', 'Scan the QR code on the document or enter the seal number.')}
        </p>
      </div>
      <Panel>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) navigate(`/verifieren/${input.trim()}`);
          }}
        >
          <input className="input grow" value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('Zegelnummer', 'Seal number')} aria-label={t('Zegelnummer', 'Seal number')} />
          <button className="btn primary" type="submit">
            <FileCheck2 size={18} /> {t('Controleren', 'Check')}
          </button>
        </form>
      </Panel>
      {error && <ErrorNote error={t('Dit zegelnummer is niet bekend.', 'This seal number is not known.')} />}
      {result && (
        <div className={`verify-result ${result.valid ? 'valid' : 'invalid'}`}>
          <div className="row" style={{ gap: 14 }}>
            {result.valid ? <ShieldCheck size={40} color="var(--ok)" /> : <ShieldAlert size={40} color="var(--danger)" />}
            <div>
              <h2 style={{ fontSize: 'var(--text-xl)' }}>{result.valid ? t('Echt en ongewijzigd', 'Genuine and unchanged') : t('Niet geldig', 'Not valid')}</h2>
              <p>{result.valid
                  ? result.kind === 'LETTER' || !result.kind
                    ? t('Dit document is uitgegeven door het ministerie en sindsdien niet gewijzigd.', 'This document was issued by the ministry and has not been changed since.')
                    : t('Dit stuk is door het systeem van het ministerie gemaakt en gezegeld. Vergelijk de gegevens hieronder met uw exemplaar.', 'This document was produced and sealed by the ministry’s system. Compare the details below with your copy.')
                  : result.reason}</p>
            </div>
          </div>
          <dl className="kv" style={{ marginTop: 16 }}>
            {result.issuer && (
              <>
                <dt>{t('Uitgegeven door', 'Issued by')}</dt>
                <dd>{result.issuer}</dd>
              </>
            )}
            {result.kind && (
              <>
                <dt>{t('Soort stuk', 'Kind of document')}</dt>
                <dd>
                  {({ LETTER: t('Brief', 'Letter'), REPORT: t('Rapport', 'Report'), INTEGRITY_REPORT: t('Integriteitsverklaring', 'Integrity statement'), ARCHIVE_PACKAGE: t('Archiefpakket', 'Archive package') } as Record<string, string>)[result.kind] ?? result.kind}
                  {result.title && result.kind !== 'LETTER' ? `: ${result.title}` : ''}
                </dd>
              </>
            )}
            {result.registrationIdentity && (
              <>
                <dt>{t('Kenmerk', 'Reference')}</dt>
                <dd>{result.registrationIdentity}</dd>
              </>
            )}
            {result.approvedBy && (
              <>
                <dt>{t('Goedgekeurd door', 'Approved by')}</dt>
                <dd>{result.approvedBy}</dd>
              </>
            )}
            <dt>{t('Gezegeld', 'Sealed')}</dt>
            <dd>
              {dateTime(result.sealedAt, language)}, {result.sealedBy}
            </dd>
            {result.documentSha256 && (
              <>
                <dt>{t('Vingerafdruk', 'Fingerprint')}</dt>
                <dd className="xs mono" style={{ fontWeight: 400 }}>
                  {/* In groups of eight, so the long number wraps between groups and can be compared by eye. */}
                  SHA-256 {result.documentSha256.match(/.{1,8}/g)?.join(' ')}
                </dd>
              </>
            )}
            <dt>{t('Sleutel', 'Key')}</dt>
            <dd className="xs" style={{ fontWeight: 400 }}>
              Ed25519 {result.keyId}
            </dd>
          </dl>
          <p className="xs muted" style={{ marginTop: 12 }}>
            {t('Dit is een digitaal zegel van het systeem van het ministerie, geen gekwalificeerde elektronische handtekening.', 'This is a digital seal of the ministry’s system, not a qualified electronic signature.')}
          </p>
        </div>
      )}
    </PublicShell>
  );
}
