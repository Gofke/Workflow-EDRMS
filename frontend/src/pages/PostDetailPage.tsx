import { Camera, Check, FilePlus2, FileSignature, FolderPlus, Link2, Plus, Printer, Reply, Save, Sparkles, Stamp as StampIcon, Tag, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { date, dateTime, longDate } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { CLASSIFICATION, DIRECTION, SOURCE } from '../lib/labels';
import { usePrefs } from '../lib/prefs';
import { DECISION, useSession } from '../lib/session';
import { useRecordContext } from '../shell/context';
import { Badge, ClassStamp, Confidence, Confirm, Dialog, Due, Empty, EngineInfo, ErrorNote, Field, KV, Loading, Notice, PageHead, Panel, ProcessingBadge, Proposal, Stamp, Tabs, useToast } from '../ui';
import { DocumentRow, DocumentViewer } from '../ui/DocumentViewer';
import { PersonSelect } from '../ui/people';
import { TaskRow, TaskView } from '../ui/records';
import { NewTaskDialog } from '../ui/tasks';
import { CameraCapture, ItemView } from './PostListPage';
import { AccessPanel } from './DossierDetailPage';

interface Context {
  dossiers: { id: string; dossierIdentity: string; subject: string; processingState: string; state: string; dueDate: string | null }[];
  replies: { id: string; registrationIdentity: string | null; subject: string; state: string; createdAt: string }[];
  inReplyTo: { id: string; registrationIdentity: string | null; subject: string } | null;
  tasks: number;
  versions: number;
}

export default function PostDetailPage() {
  const { id } = useParams() as { id: string };
  const { t, language } = usePrefs();
  const [params] = useSearchParams();
  const item = useApi<ItemView>(`/api/records/${id}`);
  const docs = useApi<DocumentRow[]>(`/api/records/${id}/documents`);
  const ctx = useApi<Context>(`/api/records/${id}/context`);
  const [tab, setTab] = useState<'gegevens' | 'antwoord' | 'taken' | 'toegang'>((params.get('tab') as 'antwoord') ?? 'gegevens');
  const i = item.data;
  useRecordContext(i ? { type: 'ITEM', id: i.id, label: i.registrationIdentity ?? i.subject } : null);

  const reloadAll = async () => {
    await Promise.all([item.reload(), docs.reload(), ctx.reload()]);
    window.dispatchEvent(new CustomEvent('juspol:changed'));
  };

  if (item.error) return <ErrorNote error={item.error} />;
  if (!i) return <Loading lines={8} />;
  const draft = i.state === 'DRAFT';
  const isLetterOut = i.direction === 'OUTGOING';

  return (
    <>
      <PageHead
        crumbs={[{ to: '/post', label: t('Post', 'Mail') }]}
        title={
          <span className="stack" style={{ gap: 8 }}>
            <span className="row" style={{ gap: 10 }}>
              <Stamp value={i.registrationIdentity} />
              <ClassStamp level={i.classification} />
              <Badge tone={draft ? 'warn' : 'ok'}>{draft ? t('Concept, nog niet geregistreerd', 'Draft, not yet registered') : t('Geregistreerd', 'Registered')}</Badge>
            </span>
            <span>{i.subject}</span>
          </span>
        }
        lead={`${DIRECTION(t, i.direction)}${i.party ? `, ${i.direction === 'OUTGOING' ? t('aan', 'to') : t('van', 'from')} ${i.party}` : ''}${i.registeredAt ? `. ${t('Geregistreerd', 'Registered')} ${dateTime(i.registeredAt, language)}` : ''}`}
        actions={<HeaderActions item={i} ctx={ctx.data} onChanged={reloadAll} />}
      />
      {ctx.data?.inReplyTo && (
        <div style={{ marginBottom: 16 }}>
          <Notice tone="info">
            {t('Antwoord op', 'Reply to')} <Link to={`/post/${ctx.data.inReplyTo.id}`}>{ctx.data.inReplyTo.registrationIdentity} — {ctx.data.inReplyTo.subject}</Link>
          </Notice>
        </div>
      )}
      <Tabs
        label={t('Onderdelen', 'Sections')}
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'gegevens', label: t('Stuk en gegevens', 'Record and details') },
          { value: 'antwoord', label: isLetterOut ? t('Brieftekst', 'Letter text') : t('Antwoord', 'Reply'), count: isLetterOut ? ctx.data?.versions : ctx.data?.replies.length, hidden: i.direction === 'INTERNAL' },
          { value: 'taken', label: t('Taken', 'Tasks'), count: ctx.data?.tasks },
          { value: 'toegang', label: t('Toegang', 'Access') },
        ]}
      />
      {tab === 'gegevens' && (
        <div className="split">
          <div className="stack">
            <Panel title={t('Document', 'Document')} actions={<AddDocument itemId={i.id} onAdded={reloadAll} />}>
              {docs.data ? <DocumentViewer itemId={i.id} documents={docs.data} /> : <Loading />}
            </Panel>
          </div>
          <div className="stack side-sticky" style={{ '--gap': '18px' } as React.CSSProperties}>
            {draft ? (
              <DraftForm item={i} hasDocument={(docs.data?.length ?? 0) > 0} autoPropose={params.get('voorstel') === '1'} onChanged={reloadAll} />
            ) : (
              <RegisteredSide item={i} ctx={ctx.data} onChanged={reloadAll} />
            )}
          </div>
        </div>
      )}
      {tab === 'antwoord' && (isLetterOut ? <LetterEditor item={i} onChanged={reloadAll} /> : <Replies item={i} ctx={ctx.data} onChanged={reloadAll} />)}
      {tab === 'taken' && <ItemTasks item={i} />}
      {tab === 'toegang' && <AccessPanel type="items" id={i.id} classification={i.classification} onChanged={reloadAll} />}
    </>
  );
}

function HeaderActions({ item, ctx, onChanged }: { item: ItemView; ctx: Context | null; onChanged: () => void }) {
  const { t } = usePrefs();
  const navigate = useNavigate();
  const [link, setLink] = useState(false);
  const registered = item.state === 'REGISTERED';
  return (
    <>
      {registered && item.direction === 'INCOMING' && (
        <>
          <button type="button" className="btn" onClick={() => void api.download(`/api/records/${item.id}/receipt.pdf`, 'ontvangstbewijs.pdf')}>
            <Printer size={18} /> {t('Ontvangstbewijs', 'Receipt')}
          </button>
          <button type="button" className="btn" onClick={() => void api.download(`/api/records/${item.id}/label.pdf`, 'etiket.pdf')}>
            <Tag size={18} /> {t('Etiket', 'Label')}
          </button>
        </>
      )}
      {registered && (
        <button type="button" className="btn primary" onClick={() => setLink(true)}>
          <FolderPlus size={18} /> {ctx?.dossiers.length ? t('Ook aan zaak koppelen', 'Also link to a matter') : t('Aan zaak koppelen', 'Link to a matter')}
        </button>
      )}
      {link && <LinkDialog item={item} onClose={() => setLink(false)} onLinked={(dossierId) => (setLink(false), onChanged(), navigate(`/zaken/${dossierId}`))} />}
    </>
  );
}

function AddDocument({ itemId, onAdded }: { itemId: string; onAdded: () => void }) {
  const { t } = usePrefs();
  const toast = useToast();
  const [camera, setCamera] = useState(false);
  const { busy, error, run } = useAction();
  const upload = (file: File) =>
    run(async () => {
      await api.upload(`/api/records/${itemId}/documents`, 'file', file);
      toast(t('Document toegevoegd', 'Document added'));
      onAdded();
    });
  return (
    <div className="row" style={{ gap: 6 }}>
      <label className="btn sm">
        <FilePlus2 size={16} /> {busy ? t('Bezig…', 'Working…') : t('Document toevoegen', 'Add document')}
        <input type="file" hidden accept="application/pdf,image/jpeg,image/png,image/tiff" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
      </label>
      <button type="button" className="btn sm" onClick={() => setCamera(true)} aria-label={t('Foto maken', 'Take a photo')}>
        <Camera size={16} />
      </button>
      {error && <span className="small" style={{ color: 'var(--danger)' }}>{error}</span>}
      {camera && (
        <Dialog title={t('Foto van de brief', 'Photo of the letter')} onClose={() => setCamera(false)}>
          <CameraCapture onCapture={(f) => (setCamera(false), void upload(f))} onCancel={() => setCamera(false)} />
        </Dialog>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ draft: the registration form */

interface Proposal<T> {
  value: T;
  confidence: number;
  basis: string;
}
interface Intake {
  interactionId: string;
  engine: EngineInfo;
  readable: boolean;
  proposals: {
    language: string;
    subject: Proposal<string> | null;
    party: Proposal<string> | null;
    documentDate: Proposal<string> | null;
    senderReference: Proposal<string> | null;
    deadlines: { phrase: string; dueDate: string; kind: string; confidence: number }[];
    classification: Proposal<string> | null;
    requests: string[];
  };
  routing: { unitName: string; confidence: number; reasons: string[]; person: { name: string; openTasks: number; basis: string } | null }[] | null;
  category: { name: string; confidence: number; reasons: string[] }[] | null;
  duplicates: Duplicate[] | null;
}
interface Duplicate {
  itemId: string;
  registrationIdentity: string;
  subject: string;
  party: string | null;
  score: number;
  reasons: string[];
}

function DraftForm({ item, hasDocument, autoPropose, onChanged }: { item: ItemView; hasDocument: boolean; autoPropose: boolean; onChanged: () => void }) {
  const { t, language } = usePrefs();
  const { ai } = useSession();
  const toast = useToast();
  const [f, setF] = useState({
    direction: item.direction,
    subject: item.subject,
    party: item.party ?? '',
    documentDate: item.documentDate ?? '',
    senderReference: item.senderReference ?? '',
    replyRequestedBy: item.replyRequestedBy ?? '',
    classification: item.classification,
  });
  const [intake, setIntake] = useState<Intake | null>(null);
  const [judged, setJudged] = useState(false);
  const save = useAction();
  const propose = useAction();
  const [checking, setChecking] = useState<{ exact: Duplicate[]; near: Duplicate[] } | null>(null);
  const register = useAction();
  const dirty = f.subject !== item.subject || f.party !== (item.party ?? '') || f.documentDate !== (item.documentDate ?? '') || f.senderReference !== (item.senderReference ?? '') || f.replyRequestedBy !== (item.replyRequestedBy ?? '') || f.classification !== item.classification || f.direction !== item.direction;

  const runIntake = () =>
    propose.run(async () => {
      setIntake(await api.post<Intake>(`/api/ai/items/${item.id}/intake`));
      setJudged(false);
    });
  useEffect(() => {
    if (autoPropose && hasDocument && ai('intake')) void runIntake();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPropose, hasDocument]);

  const persist = async () => {
    const body = {
      direction: f.direction,
      subject: f.subject.trim(),
      party: f.party.trim() || undefined,
      documentDate: f.documentDate || undefined,
      senderReference: f.senderReference.trim() || undefined,
      replyRequestedBy: f.replyRequestedBy || undefined,
      classification: f.classification,
      version: item.version,
    };
    return api.put<ItemView>(`/api/records/drafts/${item.id}`, body);
  };

  const applyAll = async () => {
    if (!intake) return;
    const p = intake.proposals;
    setF((x) => ({
      ...x,
      subject: p.subject?.value ?? x.subject,
      party: p.party?.value ?? x.party,
      documentDate: p.documentDate?.value ?? x.documentDate,
      senderReference: p.senderReference?.value ?? x.senderReference,
      replyRequestedBy: p.deadlines[0]?.dueDate ?? x.replyRequestedBy,
      classification: p.classification?.value ?? x.classification,
    }));
    await api.post(`/api/ai/interactions/${intake.interactionId}/feedback`, { outcome: 'ACCEPTED' }).catch(() => undefined);
    setJudged(true);
  };
  const reject = async () => {
    if (!intake) return;
    await api.post(`/api/ai/interactions/${intake.interactionId}/feedback`, { outcome: 'REJECTED' }).catch(() => undefined);
    setIntake(null);
  };

  const startRegister = () =>
    register.run(async () => {
      let current = item;
      if (dirty) current = await persist();
      const [exact, near] = await Promise.all([
        api.get<Duplicate[]>(`/api/records/${item.id}/possible-duplicates`).catch(() => null),
        ai('duplicates') ? api.post<{ candidates: Duplicate[] }>(`/api/ai/items/${item.id}/duplicates`).then((r) => r.candidates).catch(() => []) : Promise.resolve([]),
      ]);
      if ((exact && exact.length) || near.length) {
        setChecking({ exact: exact ?? [], near: near.filter((n) => !(exact ?? []).some((e) => e.itemId === n.itemId)) });
        onChanged();
        return;
      }
      await doRegister(current.version);
    });

  const doRegister = async (version: number) => {
    const r = await api.post<ItemView>(`/api/records/${item.id}/register`, { version });
    toast(t(`Geregistreerd als ${r.registrationIdentity}`, `Registered as ${r.registrationIdentity}`));
    setChecking(null);
    onChanged();
  };

  const p = intake?.proposals;
  const row = (label: string, prop: Proposal<string> | null | undefined, current: string, show?: (v: string) => string) =>
    prop && prop.value !== current ? (
      <div className="stack" style={{ gap: 2 }}>
        <span className="row between small">
          <span className="muted">{label}</span>
          <Confidence value={prop.confidence} />
        </span>
        <strong>{show ? show(prop.value) : prop.value}</strong>
        <span className="basis">{t('Op grond van', 'Based on')}: “{prop.basis}”</span>
      </div>
    ) : null;

  return (
    <>
      {ai('intake') && (
        <>
          {!intake && (
            <Proposal
              title={t('De assistent kan de velden voor u invullen', 'The assistant can fill in the fields for you')}
              actions={
                <button type="button" className="btn sm assist solid" disabled={propose.busy || !hasDocument} onClick={() => void runIntake()} data-testid="propose">
                  <Wand2 size={15} /> {propose.busy ? t('Leest de brief…', 'Reading the letter…') : t('Velden voorstellen', 'Propose fields')}
                </button>
              }
            >
              <p className="small">
                {hasDocument
                  ? t('Hij leest de brief en stelt onderwerp, afzender, datum, kenmerk, termijn en vertrouwelijkheid voor. U controleert en neemt over.', 'It reads the letter and proposes subject, sender, date, reference, deadline and confidentiality. You check and accept.')
                  : t('Voeg eerst het document toe.', 'Add the document first.')}
              </p>
              <ErrorNote error={propose.error} />
            </Proposal>
          )}
          {intake && p && (
            <Proposal
              engine={intake.engine}
              actions={
                !judged && (
                  <>
                    <button type="button" className="btn sm assist solid" onClick={() => void applyAll()}>
                      <Check size={15} /> {t('Overnemen', 'Accept')}
                    </button>
                    <button type="button" className="btn sm" onClick={() => void reject()}>
                      {t('Negeren', 'Ignore')}
                    </button>
                  </>
                )
              }
            >
              {!intake.readable && <p className="small">{t('Er is geen leesbare tekst in het document gevonden.', 'No readable text was found in the document.')}</p>}
              {judged && <Badge tone="assist">{t('Overgenomen — controleer en sla op', 'Accepted — check and save')}</Badge>}
              {row(t('Onderwerp', 'Subject'), p.subject, f.subject)}
              {row(t('Afzender', 'Sender'), p.party, f.party)}
              {row(t('Datum van de brief', 'Date of the letter'), p.documentDate, f.documentDate, (v) => longDate(v, language))}
              {row(t('Kenmerk afzender', 'Sender’s reference'), p.senderReference, f.senderReference)}
              {p.deadlines[0] && p.deadlines[0].dueDate !== f.replyRequestedBy && (
                <div className="stack" style={{ gap: 2 }}>
                  <span className="small muted">{t('Antwoord gevraagd vóór', 'Reply requested by')}</span>
                  <strong>{longDate(p.deadlines[0].dueDate, language)}</strong>
                  <span className="basis">
                    “{p.deadlines[0].phrase}”{p.deadlines[0].kind === 'RELATIVE_WORKING_DAYS' ? t(', in werkdagen met de Surinaamse feestdagen', ', in working days with Surinamese holidays') : ''}
                  </span>
                </div>
              )}
              {p.classification && p.classification.value !== f.classification && (
                <div className="stack" style={{ gap: 2 }}>
                  <span className="small muted">{t('Vertrouwelijkheid', 'Confidentiality')}</span>
                  <ClassStamp level={p.classification.value} always />
                  <span className="basis">{p.classification.basis}</span>
                </div>
              )}
              {intake.routing && intake.routing[0] && (
                <div className="stack" style={{ gap: 2 }}>
                  <span className="small muted">{t('Voorgestelde afdeling', 'Suggested department')}</span>
                  <strong>
                    {intake.routing[0].unitName}
                    {intake.routing[0].person ? `, ${intake.routing[0].person.name}` : ''}
                  </strong>
                  <span className="basis">{intake.routing[0].reasons.join('; ')}</span>
                </div>
              )}
              {intake.duplicates && intake.duplicates.length > 0 && (
                <Notice tone="warn" title={t('Lijkt op een eerder stuk', 'Resembles an earlier record')}>
                  {intake.duplicates.slice(0, 2).map((d) => (
                    <div key={d.itemId} className="small">
                      <Link to={`/post/${d.itemId}`}>{d.registrationIdentity}</Link> {d.subject} — {d.reasons.join(', ')}
                    </div>
                  ))}
                </Notice>
              )}
            </Proposal>
          )}
        </>
      )}

      <Panel title={t('Registratiegegevens', 'Registration details')}>
        <form
          className="stack"
          style={{ '--gap': '14px' } as React.CSSProperties}
          onSubmit={(e) => {
            e.preventDefault();
            void save.run(async () => {
              await persist();
              toast(t('Opgeslagen', 'Saved'));
              onChanged();
            });
          }}
        >
          <Field label={t('Onderwerp', 'Subject')}>
            <input className="input" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} required />
          </Field>
          <Field label={item.direction === 'OUTGOING' ? t('Geadresseerde', 'Addressee') : t('Afzender', 'Sender')}>
            <input className="input" value={f.party} onChange={(e) => setF({ ...f, party: e.target.value })} />
          </Field>
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <Field label={t('Datum van de brief', 'Date of the letter')}>
              <input className="input" type="date" value={f.documentDate} onChange={(e) => setF({ ...f, documentDate: e.target.value })} />
            </Field>
            <Field label={t('Antwoord gevraagd vóór', 'Reply requested by')}>
              <input className="input" type="date" value={f.replyRequestedBy} onChange={(e) => setF({ ...f, replyRequestedBy: e.target.value })} />
            </Field>
          </div>
          <Field label={t('Kenmerk van de afzender', 'Sender’s reference')}>
            <input className="input" value={f.senderReference} onChange={(e) => setF({ ...f, senderReference: e.target.value })} />
          </Field>
          <Field label={t('Vertrouwelijkheid', 'Confidentiality')} hint={t('Vertrouwelijk en geheim zijn alleen zichtbaar voor wie daartoe bevoegd is of bij de zaak betrokken is.', 'Confidential and secret are visible only to those cleared or involved.')}>
            <select className="select" value={f.classification} onChange={(e) => setF({ ...f, classification: e.target.value })}>
              {Object.entries(CLASSIFICATION).map(([k, v]) => (
                <option key={k} value={k}>
                  {language === 'en' ? v[1] : v[0]}
                </option>
              ))}
            </select>
          </Field>
          <ErrorNote error={save.error ?? register.error} />
          <div className="row">
            <button type="submit" className="btn" disabled={save.busy || !dirty}>
              <Save size={17} /> {t('Opslaan', 'Save')}
            </button>
            <button type="button" className="btn primary" disabled={register.busy || !f.subject.trim()} onClick={() => void startRegister()} data-testid="register">
              <StampIcon size={17} /> {register.busy ? t('Bezig…', 'Working…') : t('Registreren', 'Register')}
            </button>
          </div>
          <p className="xs muted">{t('Na registratie krijgt het stuk een nummer en kan het niet meer worden gewijzigd zonder dat dit wordt vastgelegd.', 'Once registered, the record gets a number and can no longer be changed without that being recorded.')}</p>
        </form>
      </Panel>

      {checking && (
        <Confirm
          title={t('Mogelijk een dubbel stuk', 'Possibly a duplicate')}
          confirmLabel={t('Toch registreren', 'Register anyway')}
          onClose={() => setChecking(null)}
          busy={register.busy}
          error={register.error}
          onConfirm={() => void register.run(async () => doRegister((await api.get<ItemView>(`/api/records/${item.id}`)).version))}
        >
          <p>{t('Dit stuk lijkt op wat al geregistreerd is. Controleer of het niet hetzelfde stuk is. Er wordt niets samengevoegd: registreren blijft uw beslissing.', 'This record resembles what is already registered. Check that it is not the same one. Nothing will be merged: registering remains your decision.')}</p>
          <ul className="stack" style={{ paddingLeft: 18 }}>
            {checking.exact.map((d) => (
              <li key={d.itemId}>
                <Link to={`/post/${d.itemId}`}>{d.registrationIdentity}</Link> {d.subject} — <strong>{t('zelfde document of zelfde onderwerp en afzender', 'same document or same subject and sender')}</strong>
              </li>
            ))}
            {checking.near.map((d) => (
              <li key={d.itemId}>
                <Link to={`/post/${d.itemId}`}>{d.registrationIdentity}</Link> {d.subject} — {d.reasons.join(', ')} <Badge tone="assist">{t('assistent', 'assistant')}</Badge>
              </li>
            ))}
          </ul>
        </Confirm>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ registered: details and the assistant */

function RegisteredSide({ item, ctx, onChanged }: { item: ItemView; ctx: Context | null; onChanged: () => void }) {
  const { t, language } = usePrefs();
  const { ai } = useSession();
  const tracking = useApi<{ code: string } | null>(item.direction === 'INCOMING' ? `/api/records/${item.id}/tracking` : null);
  const [summary, setSummary] = useState<{ bullets: string[]; keySentences: { text: string }[]; engine: EngineInfo } | null>(null);
  const [routing, setRouting] = useState<{ units: Intake['routing']; categories: Intake['category']; engine: EngineInfo } | null>(null);
  const [dups, setDups] = useState<Duplicate[] | null>(null);
  const action = useAction();
  void onChanged;
  return (
    <>
      <Panel title={t('Gegevens', 'Details')}>
        <KV
          rows={[
            [t('Nummer', 'Number'), <Stamp key="s" value={item.registrationIdentity} />],
            [item.direction === 'OUTGOING' ? t('Geadresseerde', 'Addressee') : t('Afzender', 'Sender'), item.party],
            [t('Datum van de brief', 'Date of the letter'), item.documentDate ? longDate(item.documentDate, language) : '—'],
            [t('Kenmerk afzender', 'Sender’s reference'), item.senderReference],
            [t('Antwoord gevraagd vóór', 'Reply requested by'), item.replyRequestedBy ? <Due key="d" date={item.replyRequestedBy} /> : '—'],
            [t('Geregistreerd', 'Registered'), `${dateTime(item.registeredAt, language)}, ${item.createdByName}`],
            [t('Afdeling', 'Department'), item.owningUnit],
            [t('Binnengekomen via', 'Received through'), SOURCE(t, item.source)],
            [t('Vertrouwelijkheid', 'Confidentiality'), <ClassStamp key="c" level={item.classification} always />],
            ...(tracking.data?.code ? ([[t('Volgcode afzender', 'Sender tracking code'), tracking.data.code]] as [string, string][]) : []),
          ]}
        />
      </Panel>
      <Panel title={t('Zaken', 'Matters')} flush>
        {ctx && ctx.dossiers.length > 0 ? (
          <ul className="list">
            {ctx.dossiers.map((d) => (
              <li key={d.id}>
                <Link to={`/zaken/${d.id}`} className="list-link">
                  <span className="grow stack" style={{ gap: 3 }}>
                    <span className="list-title">{d.subject}</span>
                    <span className="meta">
                      <Stamp value={d.dossierIdentity} />
                      <ProcessingBadge state={d.processingState} closed={d.state === 'CLOSED'} />
                    </span>
                  </span>
                  <Due date={d.dueDate} />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small" style={{ padding: '4px 20px 14px' }}>
            {t('Dit stuk hoort nog bij geen enkele zaak.', 'This record does not belong to any matter yet.')}
          </p>
        )}
      </Panel>
      {(ai('summary') || ai('routing') || ai('duplicates')) && (
        <Proposal title={t('Assistent', 'Assistant')} engine={summary?.engine ?? routing?.engine ?? null}>
          <div className="row" style={{ gap: 6 }}>
            {ai('summary') && (
              <button type="button" className="btn sm assist" disabled={action.busy} onClick={() => void action.run(async () => setSummary(await api.post(`/api/ai/items/${item.id}/summary`, { language })))}>
                <Sparkles size={15} /> {t('Samenvatten', 'Summarise')}
              </button>
            )}
            {ai('routing') && (
              <button type="button" className="btn sm assist" disabled={action.busy} onClick={() => void action.run(async () => setRouting(await api.post(`/api/ai/items/${item.id}/routing`)))}>
                {t('Afdeling voorstellen', 'Suggest department')}
              </button>
            )}
            {ai('duplicates') && (
              <button type="button" className="btn sm assist" disabled={action.busy} onClick={() => void action.run(async () => setDups((await api.post<{ candidates: Duplicate[] }>(`/api/ai/items/${item.id}/duplicates`)).candidates))}>
                {t('Dubbele stukken zoeken', 'Find duplicates')}
              </button>
            )}
          </div>
          <ErrorNote error={action.error} />
          {summary && (
            <ul className="stack small" style={{ paddingLeft: 18, margin: 0, gap: 6 }}>
              {summary.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          {routing && (
            <div className="stack small" style={{ gap: 8 }}>
              {(routing.units ?? []).length === 0 && <span className="muted">{t('Geen duidelijke afdeling gevonden.', 'No clear department found.')}</span>}
              {(routing.units ?? []).map((u) => (
                <div key={u.unitName}>
                  <span className="row between">
                    <strong>{u.unitName}</strong>
                    <Confidence value={u.confidence} />
                  </span>
                  {u.person && (
                    <span>
                      {u.person.name} ({u.person.basis}, {t(`${u.person.openTasks} open taken`, `${u.person.openTasks} open tasks`)})
                    </span>
                  )}
                  <div className="basis">{u.reasons.join('; ')}</div>
                </div>
              ))}
              {(routing.categories ?? []).length > 0 && (
                <span>
                  {t('Categorie', 'Category')}: <strong>{routing.categories![0].name}</strong>
                </span>
              )}
            </div>
          )}
          {dups && (
            <div className="small">
              {dups.length === 0 ? (
                t('Geen vergelijkbare stukken gevonden.', 'No similar records found.')
              ) : (
                <ul style={{ paddingLeft: 18, margin: 0 }}>
                  {dups.map((d) => (
                    <li key={d.itemId}>
                      <Link to={`/post/${d.itemId}`}>{d.registrationIdentity}</Link> {d.subject} — {d.reasons.join(', ')}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Proposal>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ linking to a matter */

interface DossierLite {
  id: string;
  dossierIdentity: string;
  subject: string;
  state: string;
  processingState: string;
}

function LinkDialog({ item, onClose, onLinked }: { item: ItemView; onClose: () => void; onLinked: (dossierId: string) => void }) {
  const { t } = usePrefs();
  const { ai } = useSession();
  const dossiers = useApi<DossierLite[]>('/api/dossiers');
  const categories = useApi<{ id: string; code: string; name: string; handlingWorkingDays: number | null }[]>('/api/casefiles/categories');
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [subject, setSubject] = useState(item.subject);
  const [categoryId, setCategoryId] = useState('');
  const [dossierId, setDossierId] = useState('');
  const [q, setQ] = useState('');
  const { busy, error, run } = useAction();
  useEffect(() => {
    if (ai('routing'))
      api
        .post<{ categories: { name: string }[] }>(`/api/ai/items/${item.id}/routing`)
        .then((r) => {
          const best = r.categories?.[0]?.name;
          const match = categories.data?.find((c) => c.name === best);
          if (match) setCategoryId((c) => c || match.id);
        })
        .catch(() => undefined);
  }, [ai, item.id, categories.data]);
  const open = (dossiers.data ?? []).filter((d) => d.state !== 'CLOSED' && (!q || `${d.dossierIdentity} ${d.subject}`.toLowerCase().includes(q.toLowerCase())));
  const submit = () =>
    run(async () => {
      let target = dossierId;
      if (mode === 'new') {
        const d = await api.post<{ id: string }>('/api/dossiers', { subject: subject.trim(), ...(categoryId ? { categoryId } : {}), classification: item.classification });
        target = d.id;
      }
      await api.post(`/api/dossiers/${target}/links`, { itemId: item.id });
      onLinked(target);
    });
  return (
    <Dialog
      title={t('Aan een zaak koppelen', 'Link to a matter')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Annuleren', 'Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={busy || (mode === 'new' ? !subject.trim() : !dossierId)} onClick={() => void submit()}>
            <Link2 size={17} /> {mode === 'new' ? t('Zaak openen en koppelen', 'Open matter and link') : t('Koppelen', 'Link')}
          </button>
        </>
      }
    >
      <div className="stack" style={{ '--gap': '14px' } as React.CSSProperties}>
        <div className="segmented" role="group">
          <button type="button" aria-pressed={mode === 'new'} onClick={() => setMode('new')}>
            {t('Nieuwe zaak', 'New matter')}
          </button>
          <button type="button" aria-pressed={mode === 'existing'} onClick={() => setMode('existing')}>
            {t('Bestaande zaak', 'Existing matter')}
          </button>
        </div>
        {mode === 'new' ? (
          <>
            <Field label={t('Onderwerp van de zaak', 'Subject of the matter')}>
              <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </Field>
            <Field label={t('Categorie uit het archiefplan', 'Category from the file plan')} hint={t('Bepaalt de termijn, de bewaartermijn en de goedkeuringsroute.', 'Sets the deadline, the retention period and the approval route.')}>
              <select className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">{t('Geen categorie', 'No category')}</option>
                {(categories.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} — {c.name}
                    {c.handlingWorkingDays ? ` (${c.handlingWorkingDays} ${t('werkdagen', 'working days')})` : ''}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : (
          <>
            <input className="input" placeholder={t('Zoek op nummer of onderwerp', 'Search by number or subject')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Zoeken', 'Search')} />
            <div className="stack" style={{ maxHeight: 300, overflowY: 'auto', gap: 4 }}>
              {open.map((d) => (
                <label key={d.id} className="check" style={{ padding: '6px 8px', border: '1px solid var(--line)', borderRadius: 8 }}>
                  <input type="radio" name="dossier" checked={dossierId === d.id} onChange={() => setDossierId(d.id)} />
                  <Stamp value={d.dossierIdentity} /> {d.subject}
                </label>
              ))}
            </div>
          </>
        )}
        <ErrorNote error={error} />
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ replies */

function Replies({ item, ctx, onChanged }: { item: ItemView; ctx: Context | null; onChanged: () => void }) {
  const { t, language } = usePrefs();
  const { ai } = useSession();
  const navigate = useNavigate();
  const templates = useApi<{ id: string; code: string; name: string; isActive: boolean }[]>('/api/letters/templates');
  const [templateId, setTemplateId] = useState('');
  const [draft, setDraft] = useState<{ interactionId: string; body: string; engine: EngineInfo; placeholders: number } | null>(null);
  const [body, setBody] = useState('');
  const action = useAction();
  if (item.state !== 'REGISTERED') return <Notice tone="info">{t('Registreer de brief eerst; daarna kunt u hem beantwoorden.', 'Register the letter first; then you can reply to it.')}</Notice>;
  const start = () =>
    action.run(async () => {
      const reply = await api.post<{ id: string }>(`/api/records/${item.id}/reply`, templateId ? { templateId } : {});
      onChanged();
      navigate(`/post/${reply.id}?tab=antwoord`);
    });
  const askDraft = () =>
    action.run(async () => {
      const r = await api.post<{ interactionId: string; body: string; engine: EngineInfo; placeholders: number }>(`/api/ai/items/${item.id}/draft-reply`, {});
      setDraft(r);
      setBody(r.body);
    });
  const useDraft = () =>
    action.run(async () => {
      const reply = await api.post<{ id: string }>(`/api/records/${item.id}/reply`, {});
      await api.post(`/api/ai/interactions/${draft!.interactionId}/feedback`, { outcome: body === draft!.body ? 'ACCEPTED' : 'EDITED', apply: { targetItemId: reply.id, body } });
      onChanged();
      navigate(`/post/${reply.id}?tab=antwoord`);
    });
  const reject = () =>
    action.run(async () => {
      await api.post(`/api/ai/interactions/${draft!.interactionId}/feedback`, { outcome: 'REJECTED' });
      setDraft(null);
    });
  return (
    <div className="split">
      <div className="stack">
        {draft ? (
          <Proposal
            title={t('Conceptantwoord van de assistent', 'Draft reply from the assistant')}
            engine={draft.engine}
            actions={
              <>
                <button type="button" className="btn sm assist solid" disabled={action.busy} onClick={() => void useDraft()}>
                  <Reply size={15} /> {t('Als antwoord opslaan', 'Save as reply')}
                </button>
                <button type="button" className="btn sm" disabled={action.busy} onClick={() => void reject()}>
                  {t('Afwijzen', 'Decline')}
                </button>
              </>
            }
          >
            <p className="small">
              {t(
                `De ${draft.placeholders} delen tussen [vierkante haken] vult u zelf in. De assistent neemt geen besluiten en doet geen toezeggingen.`,
                `You fill in the ${draft.placeholders} parts in [square brackets]. The assistant takes no decisions and makes no promises.`,
              )}
            </p>
            <textarea className="textarea letter-text" style={{ minHeight: 380, maxWidth: 'none' }} value={body} onChange={(e) => setBody(e.target.value)} aria-label={t('Tekst van het antwoord', 'Text of the reply')} />
          </Proposal>
        ) : (
          <Panel title={t('Antwoord opstellen', 'Draft a reply')}>
            <div className="stack">
              <p className="muted">{t('Begin met een sjabloon, of laat de assistent een concept maken op basis van de brief.', 'Start from a template, or let the assistant draft one from the letter.')}</p>
              <div className="row">
                <select className="select" style={{ maxWidth: 320 }} value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label={t('Sjabloon', 'Template')}>
                  <option value="">{t('Zonder sjabloon', 'No template')}</option>
                  {(templates.data ?? [])
                    .filter((x) => x.isActive !== false)
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                </select>
                <button type="button" className="btn primary" disabled={action.busy} onClick={() => void start()}>
                  <Reply size={17} /> {t('Antwoord opstellen', 'Draft reply')}
                </button>
                {ai('draftReply') && (
                  <button type="button" className="btn assist" disabled={action.busy} onClick={() => void askDraft()} data-testid="ai-draft">
                    <Sparkles size={17} /> {action.busy ? t('Schrijft…', 'Writing…') : t('Concept laten maken', 'Let the assistant draft')}
                  </button>
                )}
              </div>
              <ErrorNote error={action.error} />
            </div>
          </Panel>
        )}
      </div>
      <Panel title={t('Antwoorden op deze brief', 'Replies to this letter')} flush>
        {ctx && ctx.replies.length > 0 ? (
          <ul className="list">
            {ctx.replies.map((r) => (
              <li key={r.id}>
                <Link to={`/post/${r.id}?tab=antwoord`} className="list-link">
                  <Stamp value={r.registrationIdentity} />
                  <span className="grow stack" style={{ gap: 2 }}>
                    <span className="list-title">{r.subject}</span>
                    <span className="meta">{date(r.createdAt, language)}</span>
                  </span>
                  <Badge tone={r.state === 'DRAFT' ? 'warn' : 'ok'}>{r.state === 'DRAFT' ? t('Concept', 'Draft') : t('Verzonden', 'Sent')}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small" style={{ padding: '4px 20px 14px' }}>
            {t('Nog geen antwoord.', 'No reply yet.')}
          </p>
        )}
      </Panel>
    </div>
  );
}

interface Version {
  versionNo: number;
  body: string;
  note: string | null;
  authorName: string;
  createdAt: string;
  aiInteractionId: string | null;
  templateName?: string | null;
}

/** The text of an outgoing letter: every version kept, then made into a PDF on letterhead, sealed if wanted. */
function LetterEditor({ item, onChanged }: { item: ItemView; onChanged: () => void }) {
  const { t, language } = usePrefs();
  const { has } = useSession();
  const toast = useToast();
  const versions = useApi<Version[]>(`/api/records/${item.id}/draft-versions`);
  const latest = useMemo(() => [...(versions.data ?? [])].sort((a, b) => b.versionNo - a.versionNo)[0], [versions.data]);
  const [body, setBody] = useState('');
  const [note, setNote] = useState('');
  const action = useAction();
  useEffect(() => setBody(latest?.body ?? ''), [latest]);
  const draft = item.state === 'DRAFT';
  const save = () =>
    action.run(async () => {
      await api.post(`/api/records/${item.id}/draft-versions`, { body, note: note.trim() || undefined });
      setNote('');
      toast(t('Nieuwe versie bewaard', 'New version saved'));
      await versions.reload();
      onChanged();
    });
  const compose = (seal: boolean) =>
    action.run(async () => {
      const r = await api.post<{ seal: { id: string } | null }>(`/api/records/${item.id}/compose`, { seal });
      toast(seal ? t('Brief gemaakt en gezegeld', 'Letter created and sealed') : t('Brief gemaakt als PDF', 'Letter created as PDF'));
      onChanged();
      void r;
    });
  return (
    <div className="split">
      <Panel
        title={t('Tekst van de brief', 'Text of the letter')}
        actions={latest ? <span className="small muted">{t(`Versie ${latest.versionNo}`, `Version ${latest.versionNo}`)}</span> : null}
      >
        <div className="stack">
          {draft ? (
            <>
              <textarea className="textarea letter-text" style={{ minHeight: 420, maxWidth: 'none' }} value={body} onChange={(e) => setBody(e.target.value)} aria-label={t('Tekst van de brief', 'Text of the letter')} />
              <div className="row">
                <input className="input" style={{ maxWidth: 360 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('Wat is er veranderd? (optioneel)', 'What changed? (optional)')} aria-label={t('Toelichting bij de versie', 'Note for the version')} />
                <button type="button" className="btn" disabled={action.busy || !body.trim() || body === latest?.body} onClick={() => void save()}>
                  <Save size={17} /> {t('Versie bewaren', 'Save version')}
                </button>
                <button type="button" className="btn primary" disabled={action.busy || !latest} onClick={() => void compose(false)}>
                  <FileSignature size={17} /> {t('Brief maken (PDF)', 'Create letter (PDF)')}
                </button>
              </div>
              <p className="xs muted">{t('Registreer het stuk op het tabblad Stuk en gegevens; daarna kan een beslisser de brief met een digitaal zegel uitbrengen.', 'Register the record on the Record tab; then a decision-maker can issue the letter with a digital seal.')}</p>
            </>
          ) : (
            <>
              <div className="letter-text">{latest?.body ?? t('Geen tekst.', 'No text.')}</div>
              {has(...DECISION) && (
                <button type="button" className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={action.busy || !latest} onClick={() => void compose(true)}>
                  <StampIcon size={17} /> {t('Brief maken met digitaal zegel', 'Create letter with digital seal')}
                </button>
              )}
            </>
          )}
          <ErrorNote error={action.error} />
        </div>
      </Panel>
      <Panel title={t('Versies', 'Versions')} flush>
        <ul className="list">
          {[...(versions.data ?? [])]
            .sort((a, b) => b.versionNo - a.versionNo)
            .map((v) => (
              <li key={v.versionNo}>
                <div className="row between">
                  <strong>
                    {t('Versie', 'Version')} {v.versionNo}
                  </strong>
                  {v.aiInteractionId && <Badge tone="assist">{t('met assistent', 'with assistant')}</Badge>}
                </div>
                <div className="small muted">
                  {v.authorName}, {dateTime(v.createdAt, language)}
                  {v.templateName ? ` — ${v.templateName}` : ''}
                </div>
                {v.note && <div className="small">{v.note}</div>}
              </li>
            ))}
          {versions.data?.length === 0 && <li className="muted small">{t('Nog geen versie.', 'No version yet.')}</li>}
        </ul>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ tasks of a letter */

function ItemTasks({ item }: { item: ItemView }) {
  const { t } = usePrefs();
  const tasks = useApi<{ data: TaskView[] }>(`/api/tasks?itemId=${item.id}&scope=all&limit=100`);
  const [open, setOpen] = useState(false);
  return (
    <Panel
      title={t('Taken bij deze brief', 'Tasks for this letter')}
      actions={
        <button type="button" className="btn sm primary" onClick={() => setOpen(true)}>
          <Plus size={16} /> {t('Taak', 'Task')}
        </button>
      }
      flush
    >
      {tasks.data?.data.length ? (
        <ul className="list">
          {tasks.data.data.map((task) => (
            <li key={task.id}>
              <TaskRow task={task} />
            </li>
          ))}
        </ul>
      ) : (
        <Empty title={t('Geen taken', 'No tasks')}>{t('Maak een taak om iemand met deze brief aan het werk te zetten.', 'Create a task to put someone to work on this letter.')}</Empty>
      )}
      {open && <NewTaskDialog itemId={item.id} defaultTitle={item.subject} onClose={() => setOpen(false)} onCreated={() => void tasks.reload()} />}
    </Panel>
  );
}

export { PersonSelect };
