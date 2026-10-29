import { Camera, FileUp, Mail, Plus, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { date } from '../lib/format';
import { useApi } from '../lib/hooks';
import { DIRECTION, ITEM_STATE, SOURCE } from '../lib/labels';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { Badge, ClassStamp, Dialog, Empty, ErrorNote, Field, Loading, PageHead, Panel, Segmented, Stamp, useToast } from '../ui';

export interface ItemView {
  id: string;
  registrationIdentity: string | null;
  state: string;
  direction: string;
  subject: string;
  party: string | null;
  documentDate: string | null;
  registeredAt: string | null;
  createdAt: string;
  version: number;
  createdByName: string;
  owningUnit: string | null;
  classification: string;
  source: string;
  senderReference: string | null;
  replyRequestedBy: string | null;
}

export default function PostListPage() {
  const { t, language } = usePrefs();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { data, error, loading } = useApi<ItemView[]>('/api/records');
  const [q, setQ] = useState('');
  const state = params.get('state') ?? 'ALL';
  const direction = params.get('direction') ?? 'ALL';
  const [newOpen, setNewOpen] = useState(params.get('nieuw') === '1');
  const [mailOpen, setMailOpen] = useState(false);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === 'ALL') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? [])
      .filter((i) => state === 'ALL' || i.state === state)
      .filter((i) => direction === 'ALL' || i.direction === direction)
      .filter((i) => !needle || [i.subject, i.party, i.registrationIdentity, i.senderReference].some((v) => v?.toLowerCase().includes(needle)))
      .sort((a, b) => (b.registeredAt ?? b.createdAt).localeCompare(a.registeredAt ?? a.createdAt));
  }, [data, q, state, direction]);

  const drafts = (data ?? []).filter((i) => i.state === 'DRAFT').length;

  return (
    <>
      <PageHead
        title={t('Post', 'Mail')}
        lead={t('Alle binnenkomende, uitgaande en interne stukken die u mag zien; vertrouwelijke stukken buiten uw werk ontbreken daarom in de nummering. Een concept wordt pas een officieel stuk als het geregistreerd is.', 'Every incoming, outgoing and internal record you may see; confidential records outside your work are therefore missing from the numbering. A draft becomes an official record once it is registered.')}
        actions={
          <>
            <button type="button" className="btn" onClick={() => setMailOpen(true)}>
              <Mail size={18} /> {t('E-mail inlezen', 'Take in an e-mail')}
            </button>
            <button type="button" className="btn primary" onClick={() => setNewOpen(true)} data-testid="new-item">
              <Plus size={18} /> {t('Nieuw poststuk', 'New item')}
            </button>
          </>
        }
      />
      <div className="filters">
        <Field label={t('Zoeken in de lijst', 'Filter the list')}>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Onderwerp, afzender of nummer', 'Subject, sender or number')} />
        </Field>
        <div className="field">
          <span className="label" style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>
            {t('Status', 'Status')}
          </span>
          <Segmented
            label={t('Status', 'Status')}
            value={state}
            onChange={(v) => set('state', v)}
            options={[
              { value: 'ALL', label: t('Alles', 'All') },
              { value: 'DRAFT', label: `${t('Concepten', 'Drafts')}${drafts ? ` (${drafts})` : ''}` },
              { value: 'REGISTERED', label: t('Geregistreerd', 'Registered') },
            ]}
          />
        </div>
        <div className="field">
          <span className="label" style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>
            {t('Richting', 'Direction')}
          </span>
          <Segmented
            label={t('Richting', 'Direction')}
            value={direction}
            onChange={(v) => set('direction', v)}
            options={[
              { value: 'ALL', label: t('Alles', 'All') },
              { value: 'INCOMING', label: t('Inkomend', 'Incoming') },
              { value: 'OUTGOING', label: t('Uitgaand', 'Outgoing') },
              { value: 'INTERNAL', label: t('Intern', 'Internal') },
            ]}
          />
        </div>
      </div>
      <ErrorNote error={error} />
      <Panel flush>
        {loading && !data ? (
          <div style={{ padding: 20 }}>
            <Loading lines={6} />
          </div>
        ) : rows.length === 0 ? (
          <Empty title={t('Niets gevonden', 'Nothing found')}>{t('Pas de filters aan, of registreer een nieuw poststuk.', 'Change the filters, or register a new item.')}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>{t('Nummer', 'Number')}</th>
                  <th>{t('Onderwerp en afzender', 'Subject and sender')}</th>
                  <th>{t('Richting', 'Direction')}</th>
                  <th>{t('Datum', 'Date')}</th>
                  <th>{t('Status', 'Status')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id} className="clickable" onClick={() => navigate(`/post/${i.id}`)}>
                    <td>
                      <Stamp value={i.registrationIdentity} />
                    </td>
                    <td className="title-cell">
                      <Link to={`/post/${i.id}`} onClick={(e) => e.stopPropagation()}>
                        {i.subject}
                      </Link>
                      <div className="row small muted" style={{ gap: 8, marginTop: 2 }}>
                        <span>{i.party ?? '—'}</span>
                        <ClassStamp level={i.classification} />
                        {i.source !== 'MANUAL' && i.source !== 'COMPOSED' && <Badge tone="info">{SOURCE(t, i.source)}</Badge>}
                      </div>
                    </td>
                    <td className="nowrap">{DIRECTION(t, i.direction)}</td>
                    <td className="nowrap">{date(i.registeredAt ?? i.createdAt, language)}</td>
                    <td>
                      <Badge tone={i.state === 'DRAFT' ? 'warn' : 'ok'}>{ITEM_STATE(t, i.state)}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {newOpen && <NewItemDialog onClose={() => (setNewOpen(false), set('nieuw', 'ALL'))} />}
      {mailOpen && <EmailIntakeDialog onClose={() => setMailOpen(false)} />}
    </>
  );
}

/**
 * A new item: choose its direction, add the scan, a photo or a file, and go to
 * the registration screen, where the assistant proposes the fields.
 */
function NewItemDialog({ onClose }: { onClose: () => void }) {
  const { t } = usePrefs();
  const { client } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const [direction, setDirection] = useState<'INCOMING' | 'OUTGOING' | 'INTERNAL'>('INCOMING');
  const [subject, setSubject] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const draft = await api.post<ItemView>('/api/records/drafts', {
        direction,
        subject: subject.trim() || (direction === 'INCOMING' ? t('Nieuw poststuk', 'New item') : t('Nieuw stuk', 'New record')),
        classification: client?.classification.defaultLevel,
      });
      if (file) await api.upload(`/api/records/${draft.id}/documents`, 'file', file);
      toast(t('Concept aangemaakt', 'Draft created'));
      window.dispatchEvent(new CustomEvent('juspol:changed'));
      navigate(`/post/${draft.id}${file ? '?voorstel=1' : ''}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t('Nieuw poststuk', 'New item')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Annuleren', 'Cancel')}
          </button>
          <button type="button" className="btn primary" onClick={() => void create()} disabled={busy}>
            {busy ? t('Bezig…', 'Working…') : t('Verder naar registratie', 'Continue to registration')}
          </button>
        </>
      }
    >
      <div className="stack" style={{ '--gap': '16px' } as React.CSSProperties}>
        <Segmented
          label={t('Richting', 'Direction')}
          value={direction}
          onChange={setDirection}
          options={[
            { value: 'INCOMING', label: t('Inkomend', 'Incoming') },
            { value: 'OUTGOING', label: t('Uitgaand', 'Outgoing') },
            { value: 'INTERNAL', label: t('Intern', 'Internal') },
          ]}
        />
        <Field label={t('Onderwerp (mag u later aanvullen)', 'Subject (you can complete it later)')}>
          <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <div className="field">
          <span className="label" style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>
            {t('Document', 'Document')}
          </span>
          {file ? (
            <div className="row">
              <Badge tone="info">{file.name}</Badge>
              <button type="button" className="btn sm ghost" onClick={() => setFile(null)}>
                {t('Ander bestand', 'Another file')}
              </button>
            </div>
          ) : (
            <div className="row">
              <label className="btn">
                <FileUp size={18} /> {t('Bestand of scan kiezen', 'Choose a file or scan')}
                <input type="file" accept="application/pdf,image/jpeg,image/png,image/tiff" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </label>
              <button type="button" className="btn" onClick={() => setCamera(true)}>
                <Camera size={18} /> {t('Foto maken', 'Take a photo')}
              </button>
            </div>
          )}
          <span className="hint">
            {t('PDF, JPEG of PNG. Bestanden worden op virussen gecontroleerd en de tekst wordt gelezen, ook van een scan of foto.', 'PDF, JPEG or PNG. Files are checked for viruses and their text is read, also from a scan or photo.')}
          </span>
        </div>
        {camera && <CameraCapture onCapture={(f) => (setFile(f), setCamera(false))} onCancel={() => setCamera(false)} />}
        <ErrorNote error={error} />
      </div>
    </Dialog>
  );
}

/** A photo of a letter, from the device camera — for registering on a phone or tablet. */
export function CameraCapture({ onCapture, onCancel }: { onCapture: (file: File) => void; onCancel: () => void }) {
  const { t } = usePrefs();
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
        }
      })
      .catch(() => setError(t('De camera kon niet worden gestart. Kies een bestand of gebruik de camera-app van uw telefoon.', 'The camera could not be started. Choose a file or use your phone’s camera app.')));
    return () => stream?.getTracks().forEach((tr) => tr.stop());
  }, [t]);
  const take = () => {
    const v = video.current;
    if (!v) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')!.drawImage(v, 0, 0);
    canvas.toBlob((b) => b && onCapture(new File([b], `foto-${Date.now()}.jpg`, { type: 'image/jpeg' })), 'image/jpeg', 0.9);
  };
  return (
    <div className="stack">
      {error ? (
        <>
          <ErrorNote error={error} />
          <label className="btn">
            <Camera size={18} /> {t('Camera-app openen', 'Open camera app')}
            <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => e.target.files?.[0] && onCapture(e.target.files[0])} />
          </label>
        </>
      ) : (
        <video ref={video} playsInline muted style={{ width: '100%', borderRadius: 8, background: '#000' }} />
      )}
      <div className="row">
        {!error && (
          <button type="button" className="btn primary" onClick={take}>
            <Camera size={18} /> {t('Foto nemen', 'Take photo')}
          </button>
        )}
        <button type="button" className="btn" onClick={onCancel}>
          {t('Annuleren', 'Cancel')}
        </button>
      </div>
    </div>
  );
}

/** An e-mail saved from the mail program (.eml) becomes a draft with its attachments. */
function EmailIntakeDialog({ onClose }: { onClose: () => void }) {
  const { t } = usePrefs();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ item: { id: string }; captured: unknown[]; skipped: { filename: string; reason: string }[] } | null>(null);
  const send = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.upload<{ item: { id: string }; captured: unknown[]; skipped: { filename: string; reason: string }[] }>('/api/intake/email', 'message', file);
      setResult(r);
      window.dispatchEvent(new CustomEvent('juspol:changed'));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('E-mail inlezen', 'Take in an e-mail')}
      onClose={onClose}
      footer={
        result ? (
          <button type="button" className="btn primary" onClick={() => navigate(`/post/${result.item.id}`)}>
            {t('Concept openen', 'Open draft')}
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={!file || busy} onClick={() => void send()}>
            <Upload size={18} /> {busy ? t('Bezig…', 'Working…') : t('Inlezen', 'Take in')}
          </button>
        )
      }
    >
      <div className="stack">
        <p>
          {t(
            'Sla de e-mail op vanuit uw mailprogramma (als .eml-bestand) en kies hem hier. Het bericht wordt een PDF, de bijlagen worden apart vastgelegd en er ontstaat een concept om te registreren. Dezelfde e-mail wordt nooit twee keer ingelezen.',
            'Save the e-mail from your mail program (as an .eml file) and choose it here. The message becomes a PDF, its attachments are captured separately and a draft is created to register. The same e-mail is never taken in twice.',
          )}
        </p>
        <p className="small muted">{t('De mailserver van het ministerie kan e-mails ook automatisch afleveren.', 'The ministry’s mail server can also deliver e-mails automatically.')}</p>
        <label className="btn" style={{ alignSelf: 'flex-start' }}>
          <FileUp size={18} /> {file ? file.name : t('E-mailbestand kiezen', 'Choose e-mail file')}
          <input type="file" accept=".eml,message/rfc822" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <ErrorNote error={error} />
        {result && (
          <div className="notice ok">
            {t(`Ingelezen: ${result.captured.length} ${result.captured.length === 1 ? 'document' : 'documenten'} vastgelegd.`, `Taken in: ${result.captured.length} ${result.captured.length === 1 ? 'document' : 'documents'} captured.`)}
            {result.skipped.length > 0 && ` ${t('Niet overgenomen:', 'Not taken:')} ${result.skipped.map((s) => `${s.filename} (${s.reason})`).join(', ')}`}
          </div>
        )}
      </div>
    </Dialog>
  );
}
