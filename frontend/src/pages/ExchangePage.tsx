import { ArrowDownToLine, ArrowUpFromLine, Copy, KeyRound, PackageCheck, Plus, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { dateTime } from '../lib/format';
import { useApi } from '../lib/hooks';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { Badge, Dialog, Empty, ErrorNote, Field, Loading, Notice, PageHead, Panel, Stamp, useToast } from '../ui';

interface Identity { code: string; name: string; keyId: string; publicKeyPem: string; format: string }
interface Partner { id: string; code: string; name: string; isActive: boolean; createdAt: string; publicKeyPem: string }
interface LogRow { id: string; direction: 'IMPORTED' | 'EXPORTED'; partnerCode: string; partnerName: string | null; packageHash: string; occurredAt: string; actorName: string; dossierIdentity: string | null; items: number }
interface Checked { valid: boolean; from: { code: string; name: string }; packageHash: string; dossier: { identity: string; subject: string } | null; items: { registrationIdentity: string | null; subject: string; documents: number }[] }
interface Imported { from: { code: string; name: string }; dossier: { identity: string; subject: string } | null; items: { id: string; subject: string; documents: number }[] }

export default function ExchangePage() {
  const { t, language } = usePrefs();
  const { has, business } = useSession();
  const toast = useToast();
  const identity = useApi<Identity>('/api/exchange/identity');
  const partners = useApi<Partner[]>('/api/exchange/partners');
  const log = useApi<LogRow[]>('/api/exchange/log');
  const [adding, setAdding] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const [pkg, setPkg] = useState<File | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [imported, setImported] = useState<Imported | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const verify = async (f: File) => {
    setPkg(f);
    setChecked(null);
    setImported(null);
    setError(null);
    setBusy(true);
    try {
      setChecked(await api.upload<Checked>('/api/exchange/verify', 'package', f));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const take = async () => {
    if (!pkg) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.upload<Imported>('/api/exchange/import', 'package', pkg);
      setImported(r);
      setChecked(null);
      toast(t(`${r.items.length} stukken als concept opgenomen`, `${r.items.length} records taken in as drafts`));
      void log.reload();
      window.dispatchEvent(new CustomEvent('juspol:changed'));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const id = identity.data;
  return (
    <>
      <PageHead
        title={t('Uitwisseling met andere ministeries', 'Exchange with other ministries')}
        lead={t(
          'Een zaak gaat als ondertekend pakket naar een ander ministerie: elk document met zijn vingerafdruk, en het geheel ondertekend met de sleutel van dit ministerie. De ontvanger controleert de handtekening en neemt de stukken op als concept in de eigen registratie.',
          'A matter goes to another ministry as a signed package: every document with its fingerprint, and the whole signed with this ministry’s key. The receiver checks the signature and takes the records in as drafts in its own registry.',
        )}
      />
      <div className="split">
        <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
          {business && (
            <Panel title={t('Pakket ontvangen', 'Receive a package')}>
              <div className="stack">
                <p className="small muted" style={{ margin: 0 }}>
                  {t('Kies het .zip-pakket dat u van een ander ministerie kreeg. Eerst wordt alleen gecontroleerd; u beslist daarna of u het opneemt.', 'Choose the .zip package you received from another ministry. It is only checked first; you then decide whether to take it in.')}
                </p>
                <input ref={file} type="file" accept=".zip,application/zip" hidden onChange={(e) => e.target.files?.[0] && void verify(e.target.files[0])} />
                <div className="row">
                  <button type="button" className="btn" disabled={busy} onClick={() => file.current?.click()}>
                    <Upload size={16} /> {t('Pakket kiezen en controleren', 'Choose and check a package')}
                  </button>
                  {pkg && <span className="small muted">{pkg.name}</span>}
                </div>
                <ErrorNote error={error} />
                {checked && (
                  <Notice tone="ok" title={t(`Echt en ongewijzigd — van ${checked.from.name}`, `Genuine and unaltered — from ${checked.from.name}`)}>
                    <div className="stack" style={{ gap: 6 }}>
                      {checked.dossier && (
                        <span className="small">
                          {t('Zaak bij de afzender:', 'Matter at the sender:')} <Stamp value={checked.dossier.identity} /> {checked.dossier.subject}
                        </span>
                      )}
                      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                        {checked.items.map((i, n) => (
                          <li key={n}>
                            {i.registrationIdentity ?? ''} {i.subject} — {t(`${i.documents} document(en)`, `${i.documents} document(s)`)}
                          </li>
                        ))}
                      </ul>
                      <span className="xs muted mono" style={{ wordBreak: 'break-all' }}>
                        SHA-256 {checked.packageHash}
                      </span>
                      <div className="row">
                        <button type="button" className="btn primary" disabled={busy} onClick={() => void take()}>
                          <ArrowDownToLine size={16} /> {t('Opnemen als concepten', 'Take in as drafts')}
                        </button>
                      </div>
                    </div>
                  </Notice>
                )}
                {imported && (
                  <Notice tone="ok" title={t('Opgenomen', 'Taken in')}>
                    <span className="small">{t('Controleer en registreer de concepten in Post:', 'Check and register the drafts in Post:')}</span>
                    <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {imported.items.map((i) => (
                        <li key={i.id}>
                          <Link to={`/post/${i.id}`}>{i.subject}</Link>
                        </li>
                      ))}
                    </ul>
                  </Notice>
                )}
              </div>
            </Panel>
          )}
          <Panel title={t('Verzonden en ontvangen', 'Sent and received')} flush>
            {!log.data ? (
              <Loading />
            ) : log.data.length === 0 ? (
              <Empty title={t('Nog geen uitwisseling', 'No exchange yet')}>{t('Een zaak verstuurt u vanaf de zaak zelf, tab Archief.', 'You send a matter from the matter itself, Archive tab.')}</Empty>
            ) : (
              <table className="table responsive">
                <thead>
                  <tr>
                    <th>{t('Richting', 'Direction')}</th>
                    <th>{t('Ministerie', 'Ministry')}</th>
                    <th>{t('Zaak', 'Matter')}</th>
                    <th>{t('Wanneer en door wie', 'When and by whom')}</th>
                  </tr>
                </thead>
                <tbody>
                  {log.data.map((l) => (
                    <tr key={l.id}>
                      <td>
                        {l.direction === 'IMPORTED' ? (
                          <Badge tone="info">
                            <ArrowDownToLine size={12} /> {t('Ontvangen', 'Received')}
                          </Badge>
                        ) : (
                          <Badge tone="neutral">
                            <ArrowUpFromLine size={12} /> {t('Verzonden', 'Sent')}
                          </Badge>
                        )}
                      </td>
                      <td className="small">
                        {l.partnerName ?? l.partnerCode} <span className="xs muted">{l.partnerCode}</span>
                      </td>
                      <td className="small">
                        {l.dossierIdentity ? <Stamp value={l.dossierIdentity} /> : '—'} {t(`${l.items} stuk(ken)`, `${l.items} record(s)`)}
                        <div className="xs faint mono" title={l.packageHash}>
                          {l.packageHash.slice(0, 16)}…
                        </div>
                      </td>
                      <td className="small">
                        {dateTime(l.occurredAt, language)}
                        <div className="xs muted">{l.actorName}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
        <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
          <Panel title={t('Dit ministerie', 'This ministry')}>
            {!id ? (
              <Loading />
            ) : (
              <div className="stack" style={{ gap: 10 }}>
                <span>
                  <strong>{id.name}</strong> <span className="stamp">{id.code}</span>
                </span>
                <span className="small muted">
                  <KeyRound size={14} style={{ verticalAlign: '-2px' }} /> {t('Sleutel', 'Key')} <span className="mono">{id.keyId}</span> (Ed25519)
                </span>
                <p className="xs muted" style={{ margin: 0 }}>
                  {t('Geef deze openbare sleutel aan een ministerie dat met u wil uitwisselen. Met de openbare sleutel kan men alleen controleren, niet ondertekenen.', 'Give this public key to a ministry that wants to exchange with you. The public key can only check, not sign.')}
                </p>
                <div className="row">
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      void navigator.clipboard?.writeText(id.publicKeyPem).then(() => toast(t('Sleutel gekopieerd', 'Key copied')));
                    }}
                  >
                    <Copy size={14} /> {t('Kopiëren', 'Copy')}
                  </button>
                  <a className="btn sm" download={`${id.code}-openbare-sleutel.pem`} href={`data:application/x-pem-file;charset=utf-8,${encodeURIComponent(id.publicKeyPem)}`}>
                    <ArrowDownToLine size={14} /> .pem
                  </a>
                </div>
              </div>
            )}
          </Panel>
          <Panel
            title={t('Vertrouwde ministeries', 'Trusted ministries')}
            flush
            actions={
              has('SYS_ADMIN') && (
                <button type="button" className="btn sm" onClick={() => setAdding(true)}>
                  <Plus size={14} /> {t('Toevoegen', 'Add')}
                </button>
              )
            }
          >
            <ul className="list">
              {(partners.data ?? []).map((p) => (
                <li key={p.id}>
                  <div className="list-link">
                    <PackageCheck size={18} style={{ marginTop: 2, color: p.isActive ? 'var(--ok)' : 'var(--muted)', flex: 'none' }} aria-hidden="true" />
                    <span className="grow stack" style={{ gap: 2 }}>
                      <span className="list-title">{p.name}</span>
                      <span className="xs muted">
                        {p.code}, {p.isActive ? t('actief', 'active') : t('niet actief', 'inactive')}
                      </span>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
      {adding && <PartnerDialog onClose={() => setAdding(false)} onSaved={() => (setAdding(false), void partners.reload())} />}
    </>
  );
}

function PartnerDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = usePrefs();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [pem, setPem] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      await api.post('/api/exchange/partners', { code: code.trim(), name: name.trim(), publicKeyPem: pem.trim(), isActive: true });
      toast(t('Ministerie toegevoegd', 'Ministry added'));
      onSaved();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Dialog
      title={t('Vertrouwd ministerie toevoegen', 'Add a trusted ministry')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Annuleren', 'Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={code.trim().length < 2 || name.trim().length < 2 || pem.trim().length < 40} onClick={() => void save()}>
            {t('Toevoegen', 'Add')}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="form-grid">
          <Field label={t('Code', 'Code')} hint={t('Zoals het ministerie zich noemt, bijv. BIZA', 'As the ministry names itself, e.g. BIZA')}>
            <input className="input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </Field>
          <Field label={t('Naam', 'Name')}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <Field label={t('Openbare sleutel (PEM)', 'Public key (PEM)')} hint={t('Controleer de sleutel telefonisch of persoonlijk bij het andere ministerie voordat u hem toevoegt.', 'Confirm the key by phone or in person with the other ministry before you add it.')}>
          <textarea className="textarea mono" rows={5} value={pem} onChange={(e) => setPem(e.target.value)} placeholder="-----BEGIN PUBLIC KEY-----" />
        </Field>
        <ErrorNote error={error} />
      </div>
    </Dialog>
  );
}
