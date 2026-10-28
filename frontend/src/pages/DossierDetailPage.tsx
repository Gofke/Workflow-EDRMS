import { Archive, CalendarClock, Download, Eye, FileDown, Gavel, Link2, Lock, MessageCircleQuestion, Plus, Send, ShieldOff, Sparkles, Undo2, UserCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { date, dateTime, longDate } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { ADVICE_STATUS, CLASSIFICATION, DIRECTION, RELATION, RETENTION_ACTION } from '../lib/labels';
import { usePrefs } from '../lib/prefs';
import { ASSIGNERS, DECISION, useSession } from '../lib/session';
import { useAssistant, useRecordContext } from '../shell/context';
import { Badge, ClassStamp, Confirm, Dialog, Due, Empty, EngineInfo, ErrorNote, Field, KV, Loading, Notice, PageHead, Panel, ProcessingBadge, Proposal, Stamp, Tabs, useToast } from '../ui';
import { PersonSelect } from '../ui/people';
import { TaskRow, TaskView } from '../ui/records';
import { NewTaskDialog } from '../ui/tasks';

export interface DossierView {
  id: string;
  dossierIdentity: string;
  subject: string;
  state: string;
  processingState: string;
  dueDate: string | null;
  responsibleName: string | null;
  responsibleAccountId: string | null;
  classification: string;
  categoryId: string | null;
  legalHold: boolean;
  retentionState: string;
  retentionDueDate: string | null;
  owningUnit: string | null;
  createdAt: string;
  version: number;
  createdByName: string;
  linkedItems: { id: string; registrationIdentity: string | null; subject: string; direction: string; linkedAt: string }[];
}

interface Category {
  id: string;
  code: string;
  name: string;
  retentionYears: number | null;
  retentionAction: string | null;
  handlingWorkingDays: number | null;
  defaultRouteId: string | null;
}

type Tab = 'overzicht' | 'stukken' | 'taken' | 'besluit' | 'advies' | 'tijdlijn' | 'archief' | 'toegang';

export default function DossierDetailPage() {
  const { id } = useParams() as { id: string };
  const { t, language } = usePrefs();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'overzicht';
  const setTab = (v: Tab) => setParams({ tab: v }, { replace: true });
  const d = useApi<DossierView>(`/api/dossiers/${id}`);
  const categories = useApi<Category[]>('/api/casefiles/categories');
  const advice = useApi<Advice[]>(`/api/dossiers/${id}/advice`);
  const tasks = useApi<{ data: TaskView[]; total: number }>(`/api/tasks?dossierId=${id}&scope=all&limit=200&includeClosed=true`);
  const dossier = d.data;
  useRecordContext(dossier ? { type: 'DOSSIER', id: dossier.id, label: dossier.dossierIdentity } : null);

  const reload = async () => {
    await Promise.all([d.reload(), advice.reload(), tasks.reload()]);
    window.dispatchEvent(new CustomEvent('juspol:changed'));
  };

  if (d.error) return <ErrorNote error={d.error} />;
  if (!dossier) return <Loading lines={8} />;
  const category = categories.data?.find((c) => c.id === dossier.categoryId) ?? null;
  const closed = dossier.state === 'CLOSED';
  const openTasks = tasks.data?.data.filter((x) => ['OPEN', 'ACCEPTED', 'IN_PROGRESS', 'WAITING', 'IN_REVIEW'].includes(x.status)).length ?? 0;
  const openAdvice = advice.data?.filter((a) => a.status === 'OPEN').length ?? 0;

  return (
    <>
      <PageHead
        crumbs={[{ to: '/zaken', label: t('Zaken', 'Matters') }]}
        title={
          <span className="stack" style={{ gap: 8 }}>
            <span className="row" style={{ gap: 10 }}>
              <Stamp value={dossier.dossierIdentity} />
              <ClassStamp level={dossier.classification} />
              <ProcessingBadge state={dossier.processingState} closed={closed} />
              {dossier.legalHold && (
                <Badge tone="danger">
                  <Lock size={12} /> {t('Juridische blokkade', 'Legal hold')}
                </Badge>
              )}
            </span>
            <span>{dossier.subject}</span>
          </span>
        }
        lead={`${category ? `${category.name}. ` : ''}${t('Verantwoordelijk', 'Responsible')}: ${dossier.responsibleName ?? t('nog niemand', 'nobody yet')}${dossier.dueDate ? `. ${t('Termijn', 'Deadline')} ${longDate(dossier.dueDate, language)}` : ''}.`}
      />
      <Tabs
        label={t('Onderdelen van de zaak', 'Parts of the matter')}
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overzicht', label: t('Overzicht', 'Overview') },
          { value: 'stukken', label: t('Stukken', 'Records'), count: dossier.linkedItems.length },
          { value: 'taken', label: t('Taken', 'Tasks'), count: openTasks },
          { value: 'besluit', label: t('Besluitvorming', 'Decision') },
          { value: 'advies', label: t('Advies', 'Advice'), count: openAdvice },
          { value: 'tijdlijn', label: t('Tijdlijn', 'Timeline') },
          { value: 'archief', label: t('Archief en relaties', 'Archive and relations') },
          { value: 'toegang', label: t('Toegang', 'Access') },
        ]}
      />
      {tab === 'overzicht' && <Overview dossier={dossier} category={category} tasks={tasks.data?.data ?? []} advice={advice.data ?? []} onChanged={reload} goto={setTab} />}
      {tab === 'stukken' && <Records dossier={dossier} onChanged={reload} />}
      {tab === 'taken' && <Tasks dossier={dossier} tasks={tasks.data?.data ?? null} onChanged={reload} />}
      {tab === 'besluit' && <Decision dossier={dossier} category={category} openAdvice={openAdvice} onChanged={reload} />}
      {tab === 'advies' && <AdvicePanel dossier={dossier} advice={advice.data} onChanged={reload} />}
      {tab === 'tijdlijn' && <Timeline dossier={dossier} />}
      {tab === 'archief' && <ArchiveTab dossier={dossier} category={category} categories={categories.data ?? []} onChanged={reload} />}
      {tab === 'toegang' && <AccessPanel type="dossiers" id={dossier.id} classification={dossier.classification} onChanged={reload} />}
    </>
  );
}

/* ------------------------------------------------------------------ overview */

function Overview({ dossier, category, tasks, advice, onChanged, goto }: { dossier: DossierView; category: Category | null; tasks: TaskView[]; advice: Advice[]; onChanged: () => void; goto: (t: Tab) => void }) {
  const { t, language } = usePrefs();
  const { ai, has, authority } = useSession();
  const assistant = useAssistant();
  const [summary, setSummary] = useState<{ headline: string; bullets: string[]; keySentences: { text: string; source: string }[]; engine: EngineInfo } | null>(null);
  const action = useAction();
  const canAssign = has(...ASSIGNERS) || authority.some((a) => a.action === 'ASSIGN_RESPONSIBILITY');
  const canDue = has(...ASSIGNERS) || authority.some((a) => a.action === 'SET_DUE_DATE');
  const [assign, setAssign] = useState(false);
  const [due, setDue] = useState(false);
  const open = tasks.filter((x) => ['OPEN', 'ACCEPTED', 'IN_PROGRESS', 'WAITING', 'IN_REVIEW'].includes(x.status));
  const finished = dossier.processingState === 'FINALISED' || dossier.state === 'CLOSED';

  return (
    <div className="split">
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        {ai('summary') && (
          <Proposal
            title={t('Samenvatting door de assistent', 'Summary by the assistant')}
            engine={summary?.engine}
            actions={
              <button type="button" className="btn sm assist solid" disabled={action.busy} onClick={() => void action.run(async () => setSummary(await api.post(`/api/ai/dossiers/${dossier.id}/summary`, { language })))} data-testid="summarise">
                <Sparkles size={15} /> {summary ? t('Opnieuw', 'Again') : action.busy ? t('Leest de stukken…', 'Reading the records…') : t('Vat de zaak samen', 'Summarise the matter')}
              </button>
            }
          >
            {!summary && <p className="small">{t('Wat de zaak inhoudt, wat er gevraagd wordt, hoe het ervoor staat — uit de stukken, taken, adviezen en besluiten die u mag zien.', 'What the matter is about, what is asked, where it stands — from the records, tasks, advice and decisions you may see.')}</p>}
            <ErrorNote error={action.error} />
            {summary && (
              <>
                <ul className="stack" style={{ paddingLeft: 18, margin: 0, gap: 6 }}>
                  {summary.bullets.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
                {summary.keySentences.length > 0 && (
                  <div className="stack" style={{ gap: 4 }}>
                    <span className="small strong">{t('Letterlijk uit de stukken', 'Verbatim from the records')}</span>
                    {summary.keySentences.map((k) => (
                      <blockquote key={k.text} className="small" style={{ margin: 0, paddingLeft: 10, borderLeft: '3px solid var(--assist)' }}>
                        {k.text} <span className="faint">({k.source})</span>
                      </blockquote>
                    ))}
                  </div>
                )}
              </>
            )}
          </Proposal>
        )}
        <Panel
          title={t('Open taken', 'Open tasks')}
          actions={
            <button type="button" className="btn sm ghost" onClick={() => goto('taken')}>
              {t('Alle taken', 'All tasks')}
            </button>
          }
          flush
        >
          {open.length === 0 ? (
            <p className="muted small" style={{ padding: '4px 20px 14px' }}>
              {t('Geen open taken.', 'No open tasks.')}
            </p>
          ) : (
            <ul className="list">
              {open.slice(0, 6).map((task) => (
                <li key={task.id}>
                  <TaskRow task={task} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel
          title={t('Stukken', 'Records')}
          actions={
            <button type="button" className="btn sm ghost" onClick={() => goto('stukken')}>
              {t('Alle stukken', 'All records')}
            </button>
          }
          flush
        >
          <ul className="list">
            {dossier.linkedItems.slice(0, 6).map((i) => (
              <li key={i.id}>
                <Link to={`/post/${i.id}`} className="list-link">
                  <Stamp value={i.registrationIdentity} />
                  <span className="grow list-title">{i.subject}</span>
                  <span className="small muted nowrap">{DIRECTION(t, i.direction)}</span>
                </Link>
              </li>
            ))}
            {dossier.linkedItems.length === 0 && <li className="muted small">{t('Nog geen stukken gekoppeld.', 'No records linked yet.')}</li>}
          </ul>
        </Panel>
      </div>
      <div className="stack side-sticky" style={{ '--gap': '18px' } as React.CSSProperties}>
        <Panel title={t('Zaakgegevens', 'Matter details')}>
          <KV
            rows={[
              [t('Nummer', 'Number'), <Stamp key="s" value={dossier.dossierIdentity} />],
              [t('Categorie', 'Category'), category ? `${category.code} — ${category.name}` : '—'],
              [
                t('Verantwoordelijk', 'Responsible'),
                <span key="r" className="row" style={{ gap: 6 }}>
                  {dossier.responsibleName ?? t('nog niemand', 'nobody yet')}
                  {canAssign && !finished && (
                    <button type="button" className="btn link small" onClick={() => setAssign(true)}>
                      {t('wijzigen', 'change')}
                    </button>
                  )}
                </span>,
              ],
              [
                t('Termijn', 'Deadline'),
                <span key="d" className="row" style={{ gap: 6 }}>
                  {dossier.dueDate ? <Due date={dossier.dueDate} done={finished} /> : '—'}
                  {canDue && !finished && (
                    <button type="button" className="btn link small" onClick={() => setDue(true)}>
                      {dossier.dueDate ? t('wijzigen', 'change') : t('vaststellen', 'set')}
                    </button>
                  )}
                </span>,
              ],
              [t('Afdeling', 'Department'), dossier.owningUnit],
              [t('Geopend', 'Opened'), `${date(dossier.createdAt, language)}, ${dossier.createdByName}`],
              [t('Vertrouwelijkheid', 'Confidentiality'), <ClassStamp key="c" level={dossier.classification} always />],
              [t('Adviezen', 'Advice'), `${advice.filter((a) => a.status === 'ANSWERED').length} ${t('gegeven', 'given')}, ${advice.filter((a) => a.status === 'OPEN').length} ${t('open', 'open')}`],
            ]}
          />
        </Panel>
        {ai('chat') && (
          <Panel title={t('Vraag over deze zaak', 'Ask about this matter')}>
            <div className="chips">
              {[t('Waar gaat deze zaak over?', 'What is this matter about?'), t('Maak een taak voor mij om de stukken door te nemen, morgen', 'Create a task for me to review the records, tomorrow')].map((q) => (
                <button key={q} type="button" className="chip-btn" onClick={() => assistant.ask(q)}>
                  <Sparkles size={13} /> {q}
                </button>
              ))}
            </div>
          </Panel>
        )}
      </div>
      {assign && <AssignDialog dossier={dossier} onClose={() => setAssign(false)} onDone={() => (setAssign(false), onChanged())} />}
      {due && <DueDialog dossier={dossier} category={category} onClose={() => setDue(false)} onDone={() => (setDue(false), onChanged())} />}
    </div>
  );
}

function AssignDialog({ dossier, onClose, onDone }: { dossier: DossierView; onClose: () => void; onDone: () => void }) {
  const { t } = usePrefs();
  const officials = useApi<{ accountId: string; personName: string; roles: string[] }[]>('/api/dossiers/assignable-officials');
  const [who, setWho] = useState(dossier.responsibleAccountId ?? '');
  const { busy, error, run } = useAction();
  return (
    <Confirm
      title={t('Verantwoordelijke toewijzen', 'Assign the responsible official')}
      confirmLabel={t('Toewijzen', 'Assign')}
      onClose={onClose}
      busy={busy}
      error={error}
      disabled={!who}
      onConfirm={() => void run(async () => (await api.post(`/api/dossiers/${dossier.id}/responsibility`, { responsibleAccountId: who, version: dossier.version }), onDone()))}
    >
      <Field label={t('Wie wordt verantwoordelijk?', 'Who becomes responsible?')} hint={t('Alleen wie officiële verantwoordelijkheid kan dragen, staat in de lijst.', 'Only those who can carry official responsibility are listed.')}>
        <select className="select" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">{t('Kies…', 'Choose…')}</option>
          {(officials.data ?? []).map((o) => (
            <option key={o.accountId} value={o.accountId}>
              {o.personName}
            </option>
          ))}
        </select>
      </Field>
    </Confirm>
  );
}

function DueDialog({ dossier, category, onClose, onDone }: { dossier: DossierView; category: Category | null; onClose: () => void; onDone: () => void }) {
  const { t, language } = usePrefs();
  const [dueDate, setDueDate] = useState(dossier.dueDate ?? '');
  const [reason, setReason] = useState('');
  const [suggested, setSuggested] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    if (category?.handlingWorkingDays) api.get<{ date: string }>(`/api/calendar/working-days?days=${category.handlingWorkingDays}`).then((r) => setSuggested(r.date)).catch(() => null);
  }, [category]);
  return (
    <Confirm
      title={t('Termijn vaststellen', 'Set the deadline')}
      confirmLabel={t('Vaststellen', 'Set')}
      onClose={onClose}
      busy={busy}
      error={error}
      disabled={!dueDate}
      onConfirm={() => void run(async () => (await api.post(`/api/dossiers/${dossier.id}/due-date`, { dueDate, reason: reason.trim() || undefined, version: dossier.version }), onDone()))}
    >
      <Field label={t('Termijn', 'Deadline')}>
        <input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </Field>
      {suggested && (
        <p className="small">
          {t(`Volgens de categorie: ${category!.handlingWorkingDays} werkdagen, dat is`, `By the category: ${category!.handlingWorkingDays} working days, which is`)}{' '}
          <button type="button" className="btn link" onClick={() => setDueDate(suggested)}>
            {longDate(suggested, language)}
          </button>{' '}
          {t('(zonder weekends en Surinaamse feestdagen).', '(excluding weekends and Surinamese holidays).')}
        </p>
      )}
      <Field label={t('Reden', 'Reason')} hint={dossier.dueDate ? t('Een gewijzigde termijn vraagt een reden.', 'A changed deadline needs a reason.') : undefined}>
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Confirm>
  );
}

/* ------------------------------------------------------------------ records */

function Records({ dossier, onChanged }: { dossier: DossierView; onChanged: () => void }) {
  const { t, language } = usePrefs();
  const [open, setOpen] = useState(false);
  return (
    <Panel
      title={t('Stukken in deze zaak', 'Records in this matter')}
      actions={
        dossier.state !== 'CLOSED' && (
          <button type="button" className="btn sm primary" onClick={() => setOpen(true)}>
            <Link2 size={16} /> {t('Stuk koppelen', 'Link a record')}
          </button>
        )
      }
      flush
    >
      {dossier.linkedItems.length === 0 ? (
        <Empty title={t('Nog geen stukken', 'No records yet')}>{t('Koppel geregistreerde brieven aan deze zaak.', 'Link registered letters to this matter.')}</Empty>
      ) : (
        <table className="table responsive">
          <thead>
            <tr>
              <th>{t('Nummer', 'Number')}</th>
              <th>{t('Onderwerp', 'Subject')}</th>
              <th>{t('Richting', 'Direction')}</th>
              <th>{t('Gekoppeld', 'Linked')}</th>
            </tr>
          </thead>
          <tbody>
            {dossier.linkedItems.map((i) => (
              <tr key={i.id}>
                <td>
                  <Stamp value={i.registrationIdentity} to={`/post/${i.id}`} />
                </td>
                <td className="title-cell">
                  <Link to={`/post/${i.id}`}>{i.subject}</Link>
                </td>
                <td>{DIRECTION(t, i.direction)}</td>
                <td className="nowrap">{date(i.linkedAt, language)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <LinkRecordDialog dossier={dossier} onClose={() => setOpen(false)} onDone={() => (setOpen(false), onChanged())} />}
    </Panel>
  );
}

function LinkRecordDialog({ dossier, onClose, onDone }: { dossier: DossierView; onClose: () => void; onDone: () => void }) {
  const { t } = usePrefs();
  const items = useApi<{ id: string; registrationIdentity: string | null; subject: string; state: string; party: string | null }[]>('/api/records');
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState('');
  const { busy, error, run } = useAction();
  const linked = new Set(dossier.linkedItems.map((i) => i.id));
  const list = (items.data ?? []).filter((i) => i.state === 'REGISTERED' && !linked.has(i.id) && (!q || `${i.registrationIdentity} ${i.subject} ${i.party}`.toLowerCase().includes(q.toLowerCase()))).slice(0, 40);
  const drafts = (items.data ?? []).filter((i) => i.state === 'DRAFT').length;
  return (
    <Confirm title={t('Stuk koppelen', 'Link a record')} confirmLabel={t('Koppelen', 'Link')} onClose={onClose} busy={busy} error={error} disabled={!chosen} onConfirm={() => void run(async () => (await api.post(`/api/dossiers/${dossier.id}/links`, { itemId: chosen }), onDone()))}>
      <input className="input" placeholder={t('Zoek op nummer, onderwerp of afzender', 'Search by number, subject or sender')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Zoeken', 'Search')} />
      <div className="stack" style={{ maxHeight: 320, overflowY: 'auto', gap: 4 }}>
        {list.map((i) => (
          <label key={i.id} className="check" style={{ padding: '6px 8px', border: '1px solid var(--line)', borderRadius: 8 }}>
            <input type="radio" name="item" checked={chosen === i.id} onChange={() => setChosen(i.id)} />
            <Stamp value={i.registrationIdentity} /> <span>{i.subject}</span>
          </label>
        ))}
      </div>
      {drafts > 0 && <p className="xs muted">{t(`Concepten staan hier niet: een stuk wordt pas gekoppeld als het geregistreerd is (${drafts} concept${drafts === 1 ? '' : 'en'}).`, `Drafts are not listed: a record is linked once registered (${drafts} draft${drafts === 1 ? '' : 's'}).`)}</p>}
    </Confirm>
  );
}

/* ------------------------------------------------------------------ tasks */

function Tasks({ dossier, tasks, onChanged }: { dossier: DossierView; tasks: TaskView[] | null; onChanged: () => void }) {
  const { t } = usePrefs();
  const [open, setOpen] = useState(false);
  return (
    <Panel
      title={t('Taken in deze zaak', 'Tasks in this matter')}
      actions={
        dossier.state !== 'CLOSED' && (
          <button type="button" className="btn sm primary" onClick={() => setOpen(true)}>
            <Plus size={16} /> {t('Taak', 'Task')}
          </button>
        )
      }
      flush
    >
      {!tasks ? (
        <div style={{ padding: 20 }}>
          <Loading />
        </div>
      ) : tasks.length === 0 ? (
        <Empty title={t('Geen taken', 'No tasks')} />
      ) : (
        <ul className="list">
          {tasks.map((task) => (
            <li key={task.id}>
              <TaskRow task={task} />
            </li>
          ))}
        </ul>
      )}
      {open && <NewTaskDialog dossierId={dossier.id} onClose={() => setOpen(false)} onCreated={() => onChanged()} />}
    </Panel>
  );
}

/* ------------------------------------------------------------------ decision */

interface WorkflowEvent {
  eventType: string;
  actorName: string;
  onBehalfOfName: string | null;
  reviewerName: string | null;
  reason: string | null;
  occurredAt: string;
}
interface RouteState {
  id: string;
  name: string;
  currentStep: number;
  completedAt: string | null;
  endedReason: string | null;
  currentReviewerAccountId: string | null;
  currentReviewerName: string | null;
  steps: { role: string; label: string; index: number; status: string }[];
  decisions: { stepIndex: number; stepLabel: string; decision: string; note: string | null; occurredAt: string; actorName: string; nextReviewerName: string | null }[];
}

function Decision({ dossier, category, openAdvice, onChanged }: { dossier: DossierView; category: Category | null; openAdvice: number; onChanged: () => void }) {
  const { t, language } = usePrefs();
  const { has, user, client } = useSession();
  const toast = useToast();
  const history = useApi<WorkflowEvent[]>(`/api/dossiers/${dossier.id}/workflow`);
  const route = useApi<RouteState | null>(`/api/dossiers/${dossier.id}/route`);
  const queue = useApi<{ dossierId: string }[]>('/api/dossiers/review-queue');
  const reviewers = useApi<{ accountId: string; personName: string }[]>('/api/dossiers/eligible-reviewers');
  const routes = useApi<{ id: string; name: string; description: string | null; steps: { role: string; label: string }[]; isActive: boolean }[]>('/api/approval-routes');
  const [mode, setMode] = useState<'submit' | 'route'>('route');
  const [reviewer, setReviewer] = useState('');
  const [routeId, setRouteId] = useState('');
  const [next, setNext] = useState('');
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState<null | 'approve' | 'finalise' | 'close' | 'return' | 'reopen' | 'reopenDossier'>(null);
  const [reason, setReason] = useState('');
  const action = useAction();
  useEffect(() => setRouteId((r) => r || category?.defaultRouteId || ''), [category]);

  const r = route.data && !route.data.completedAt && !route.data.endedReason ? route.data : null;
  const iAmReviewer = r ? r.currentReviewerAccountId === user?.accountId : (queue.data ?? []).some((q) => q.dossierId === dossier.id);
  const st = dossier.processingState;
  const closed = dossier.state === 'CLOSED';
  const decisionMaker = has(...DECISION);
  const nextStep = r ? r.steps[r.currentStep + 1] : null;
  const chosenRoute = routes.data?.find((x) => x.id === routeId);

  const done = async (message: string) => {
    toast(message);
    setConfirm(null);
    setReason('');
    setNote('');
    await Promise.all([history.reload(), route.reload(), queue.reload()]);
    onChanged();
  };
  const post = (path: string, body: object, message: string) =>
    action.run(async () => {
      await api.post(`/api/dossiers/${dossier.id}${path}`, { ...body, version: dossier.version });
      await done(message);
    });

  return (
    <div className="split">
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        {r && (
          <Panel title={`${t('Goedkeuringsroute', 'Approval route')}: ${r.name}`}>
            <ol className="steps" aria-label={t('Stappen', 'Steps')}>
              {r.steps.map((s, i) => (
                <li key={s.index} className={s.status === 'DONE' ? 'done' : i === r.currentStep ? 'current' : ''}>
                  <span className="n">{i + 1}</span>
                  <span className="stack" style={{ gap: 2 }}>
                    <strong className="small">{s.label}</strong>
                    <span className="xs muted">
                      {s.status === 'DONE'
                        ? r.decisions.find((x) => x.stepIndex === i)?.actorName
                        : i === r.currentStep
                          ? `${t('bij', 'with')} ${r.currentReviewerName}`
                          : t('volgt', 'next')}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
        )}

        <Panel title={t('Wat er nu kan', 'What can be done now')}>
          <div className="stack" style={{ '--gap': '14px' } as React.CSSProperties}>
            {closed && (
              <>
                <Notice tone="info">{t('Het dossier is gesloten. Er kan niets meer aan worden veranderd tot het wordt heropend.', 'The file is closed. Nothing can be changed until it is reopened.')}</Notice>
                {decisionMaker && (
                  <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setConfirm('reopenDossier')}>
                    <Undo2 size={17} /> {t('Dossier heropenen', 'Reopen the file')}
                  </button>
                )}
              </>
            )}
            {!closed && (st === 'ACTIVE' || st === 'RETURNED') && (
              <>
                {st === 'RETURNED' && (
                  <Notice tone="warn" title={t('Teruggestuurd', 'Returned')}>
                    {history.data?.filter((h) => h.eventType === 'RETURNED').slice(-1)[0]?.reason}
                  </Notice>
                )}
                {openAdvice > 0 && (
                  <Notice tone={client?.workflow.blockSubmitWithOpenAdvice ? 'danger' : 'warn'}>
                    {t(`Er staat nog ${openAdvice} adviesaanvraag open.`, `${openAdvice} advice request(s) are still open.`)}
                    {client?.workflow.blockSubmitWithOpenAdvice ? ` ${t('Indienen kan pas als het advies er is.', 'Submitting waits for the advice.')}` : ''}
                  </Notice>
                )}
                <div className="segmented" role="group" aria-label={t('Hoe aanbieden', 'How to submit')}>
                  <button type="button" aria-pressed={mode === 'route'} onClick={() => setMode('route')}>
                    {t('Via een goedkeuringsroute', 'Along an approval route')}
                  </button>
                  <button type="button" aria-pressed={mode === 'submit'} onClick={() => setMode('submit')}>
                    {t('Aan één beoordelaar', 'To one reviewer')}
                  </button>
                </div>
                {mode === 'submit' ? (
                  <div className="row top">
                    <Field label={t('Beoordelaar', 'Reviewer')} className="grow">
                      <select className="select" value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
                        <option value="">{t('Kies…', 'Choose…')}</option>
                        {(reviewers.data ?? []).map((x) => (
                          <option key={x.accountId} value={x.accountId}>
                            {x.personName}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <button type="button" className="btn primary" style={{ marginTop: 24 }} disabled={!reviewer || action.busy} onClick={() => void post('/submit', { reviewerAccountId: reviewer }, t('Ter beoordeling aangeboden', 'Submitted for review'))} data-testid="submit">
                      <Send size={17} /> {t('Indienen', 'Submit')}
                    </button>
                  </div>
                ) : (
                  <div className="stack">
                    <div className="form-grid">
                      <Field label={t('Route', 'Route')} hint={chosenRoute?.description ?? undefined}>
                        <select className="select" value={routeId} onChange={(e) => setRouteId(e.target.value)}>
                          <option value="">{t('Kies…', 'Choose…')}</option>
                          {(routes.data ?? [])
                            .filter((x) => x.isActive)
                            .map((x) => (
                              <option key={x.id} value={x.id}>
                                {x.name}
                              </option>
                            ))}
                        </select>
                      </Field>
                      <Field label={chosenRoute ? `${t('Eerste stap', 'First step')}: ${chosenRoute.steps[0].label}` : t('Eerste beoordelaar', 'First reviewer')}>
                        <PersonSelect value={reviewer} onChange={setReviewer} roles={chosenRoute ? [chosenRoute.steps[0].role] : ['ONDER_DIRECTEUR', 'DIRECTEUR', 'MINISTER']} />
                      </Field>
                    </div>
                    {chosenRoute && (
                      <p className="small muted">
                        {t('Stappen', 'Steps')}: {chosenRoute.steps.map((s) => s.label).join(' → ')}
                      </p>
                    )}
                    <button type="button" className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={!routeId || !reviewer || action.busy} onClick={() => void post('/route/submit', { routeId, reviewerAccountId: reviewer }, t('Route gestart', 'Route started'))}>
                      <Send size={17} /> {t('Route starten', 'Start route')}
                    </button>
                  </div>
                )}
              </>
            )}
            {!closed && st === 'UNDER_REVIEW' && (
              <>
                {iAmReviewer ? (
                  <>
                    <Notice tone="warn" title={t('Uw besluit wordt gevraagd', 'Your decision is asked')}>
                      {r ? `${t('Stap', 'Step')} ${r.currentStep + 1}: ${r.steps[r.currentStep].label}` : t('U bent de aangewezen beoordelaar.', 'You are the designated reviewer.')}
                    </Notice>
                    {r && nextStep && (
                      <Field label={`${t('Volgende stap', 'Next step')}: ${nextStep.label}`}>
                        <PersonSelect value={next} onChange={setNext} roles={[nextStep.role]} />
                      </Field>
                    )}
                    {r && (
                      <Field label={t('Toelichting (optioneel)', 'Note (optional)')}>
                        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
                      </Field>
                    )}
                    <div className="row">
                      <button type="button" className="btn ok solid" disabled={action.busy || Boolean(r && nextStep && !next)} onClick={() => setConfirm('approve')} data-testid="approve">
                        <UserCheck size={17} /> {r && nextStep ? t('Akkoord en doorsturen', 'Approve and forward') : t('Goedkeuren', 'Approve')}
                      </button>
                      <button type="button" className="btn danger" onClick={() => setConfirm('return')}>
                        <Undo2 size={17} /> {t('Terugsturen', 'Return')}
                      </button>
                    </div>
                  </>
                ) : (
                  <Notice tone="info">
                    {t('Ter beoordeling bij', 'Under review by')} <strong>{r?.currentReviewerName ?? history.data?.filter((h) => h.eventType === 'SUBMITTED').slice(-1)[0]?.reviewerName}</strong>. {t('Alleen de aangewezen beoordelaar kan beslissen.', 'Only the designated reviewer can decide.')}
                  </Notice>
                )}
              </>
            )}
            {!closed && st === 'APPROVED' && (
              <>
                <Notice tone="ok">{t('Goedgekeurd. Afronden legt de beslissing vast en sluit de behandeling af.', 'Approved. Finalising records the decision and ends the handling.')}</Notice>
                {decisionMaker && (
                  <button type="button" className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={() => setConfirm('finalise')} data-testid="finalise">
                    <Gavel size={17} /> {t('Afronden', 'Finalise')}
                  </button>
                )}
              </>
            )}
            {!closed && st === 'FINALISED' && (
              <>
                <Notice tone="ok">{t('Afgerond. Wat is beslist, kan niet meer stilletjes worden gewijzigd.', 'Finalised. What was decided can no longer be changed without a trace.')}</Notice>
                {decisionMaker && (
                  <div className="row">
                    <button type="button" className="btn" onClick={() => setConfirm('close')}>
                      <Archive size={17} /> {t('Dossier sluiten', 'Close the file')}
                    </button>
                    <button type="button" className="btn" onClick={() => setConfirm('reopen')}>
                      <Undo2 size={17} /> {t('Heropenen', 'Reopen')}
                    </button>
                  </div>
                )}
              </>
            )}
            <ErrorNote error={action.error} />
          </div>
        </Panel>
      </div>
      <Panel title={t('Verloop', 'History')}>
        <ol className="timeline">
          {[
            ...(history.data ?? [])
              .filter((h) => !(h.eventType === 'SUBMITTED' && h.reason?.startsWith('Step approved')))
              .map((h) => ({
                at: h.occurredAt,
                tone: h.eventType === 'APPROVED' || h.eventType === 'FINALISED' ? 'ok' : h.eventType === 'RETURNED' ? 'danger' : '',
                title: workflowLabel(t, h.eventType),
                who: `${h.actorName}${h.onBehalfOfName ? ` ${t('namens', 'on behalf of')} ${h.onBehalfOfName}` : ''}${h.reviewerName && h.eventType === 'SUBMITTED' ? ` → ${h.reviewerName}` : ''}`,
                note: h.reason,
              })),
            ...(route.data?.decisions ?? []).map((x) => ({
              at: x.occurredAt,
              tone: 'ok',
              title: `${t('Akkoord', 'Approved')}: ${x.stepLabel}`,
              who: `${x.actorName}${x.nextReviewerName ? ` → ${x.nextReviewerName}` : ''}`,
              note: x.note,
            })),
          ]
            .sort((a, b) => b.at.localeCompare(a.at))
            .map((e, i) => (
              <li key={`${e.at}-${i}`} className={e.tone}>
                <strong>{e.title}</strong>
                <div className="small">{e.who}</div>
                {e.note && <div className="small muted">“{e.note}”</div>}
                <div className="when">{dateTime(e.at, language)}</div>
              </li>
            ))}
          {history.data?.length === 0 && !route.data && <li>{t('Nog niet ingediend.', 'Not yet submitted.')}</li>}
        </ol>
      </Panel>

      {confirm === 'approve' && (
        <Confirm
          title={r && nextStep ? t('Akkoord geven en doorsturen', 'Approve and forward') : t('Goedkeuren', 'Approve')}
          confirmLabel={t('Bevestigen', 'Confirm')}
          onClose={() => setConfirm(null)}
          busy={action.busy}
          error={action.error}
          onConfirm={() => void (r ? post('/route/approve', { ...(nextStep ? { nextReviewerAccountId: next } : {}), note: note.trim() || undefined }, t('Akkoord vastgelegd', 'Approval recorded')) : post('/approve', {}, t('Goedgekeurd', 'Approved')))}
        >
          <p>{t('U geeft akkoord op de zaak zoals die nu is (versie ' + dossier.version + '). Verandert er daarna iets, dan is een nieuwe beoordeling nodig.', 'You approve the matter as it now stands (version ' + dossier.version + '). If anything changes afterwards, a new review is needed.')}</p>
        </Confirm>
      )}
      {(confirm === 'return' || confirm === 'reopen' || confirm === 'reopenDossier') && (
        <Confirm
          title={confirm === 'return' ? t('Terugsturen', 'Return') : confirm === 'reopen' ? t('Heropenen', 'Reopen') : t('Dossier heropenen', 'Reopen the file')}
          confirmLabel={confirm === 'return' ? t('Terugsturen', 'Return') : t('Heropenen', 'Reopen')}
          danger={confirm === 'return'}
          onClose={() => setConfirm(null)}
          busy={action.busy}
          error={action.error}
          disabled={!reason.trim()}
          onConfirm={() =>
            void (confirm === 'return'
              ? post('/return', { reason }, t('Teruggestuurd', 'Returned'))
              : confirm === 'reopen'
                ? post('/reopen', { reason }, t('Heropend', 'Reopened'))
                : post('/dossier-state/reopen', { reason }, t('Dossier heropend', 'File reopened')))
          }
        >
          <Field label={t('Reden', 'Reason')} hint={t('De reden wordt vastgelegd en is zichtbaar voor wie de zaak behandelt.', 'The reason is recorded and visible to those handling the matter.')}>
            <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </Confirm>
      )}
      {confirm === 'finalise' && (
        <Confirm title={t('Afronden', 'Finalise')} confirmLabel={t('Afronden', 'Finalise')} onClose={() => setConfirm(null)} busy={action.busy} error={action.error} onConfirm={() => void post('/finalise', {}, t('Afgerond', 'Finalised'))}>
          <p>{t('Na afronden kunnen de stukken, de termijn en de verantwoordelijke niet meer worden gewijzigd zonder heropening.', 'After finalising, records, deadline and responsible official cannot be changed without reopening.')}</p>
        </Confirm>
      )}
      {confirm === 'close' && (
        <Confirm title={t('Dossier sluiten', 'Close the file')} confirmLabel={t('Sluiten', 'Close')} onClose={() => setConfirm(null)} busy={action.busy} error={action.error} onConfirm={() => void post('/dossier-state/close', { reason: reason.trim() || undefined }, t('Dossier gesloten', 'File closed'))}>
          <p>{t('Vanaf het sluiten loopt de bewaartermijn van de categorie.', 'From closing, the retention period of the category runs.')}</p>
          <Field label={t('Toelichting (optioneel)', 'Note (optional)')}>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </Confirm>
      )}
    </div>
  );
}

export function workflowLabel(t: (nl: string, en: string) => string, e: string): string {
  return (
    {
      SUBMITTED: t('Ingediend ter beoordeling', 'Submitted for review'),
      APPROVED: t('Goedgekeurd', 'Approved'),
      RETURNED: t('Teruggestuurd', 'Returned'),
      FINALISED: t('Afgerond', 'Finalised'),
      REOPENED: t('Heropend', 'Reopened'),
      FORWARDED: t('Doorgestuurd', 'Forwarded'),
    }[e] ?? e
  );
}

/* ------------------------------------------------------------------ advice */

interface Advice {
  id: string;
  question: string;
  dueDate: string | null;
  status: string;
  answer: string | null;
  requestedAt: string;
  answeredAt: string | null;
  withdrawnReason: string | null;
  requestedFromName: string | null;
  requestedFromAccountId: string | null;
  requestedFromUnit: string | null;
  requestedByName: string;
  requestedByAccountId: string;
  answeredByName: string | null;
}

function AdvicePanel({ dossier, advice, onChanged }: { dossier: DossierView; advice: Advice[] | null; onChanged: () => void }) {
  const { t, language } = usePrefs();
  const { user } = useSession();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [who, setWho] = useState('');
  const [question, setQuestion] = useState('');
  const [due, setDue] = useState('');
  const [answering, setAnswering] = useState<Advice | null>(null);
  const [answer, setAnswer] = useState('');
  const action = useAction();
  return (
    <div className="stack" style={{ '--gap': '18px' } as React.CSSProperties}>
      <div className="row between">
        <p className="muted">{t('Vraag een collega of afdeling om advies. Het antwoord wordt deel van de zaak.', 'Ask a colleague or department for advice. The answer becomes part of the matter.')}</p>
        {dossier.state !== 'CLOSED' && (
          <button type="button" className="btn primary" onClick={() => setAsking(true)}>
            <MessageCircleQuestion size={17} /> {t('Advies vragen', 'Request advice')}
          </button>
        )}
      </div>
      {!advice ? (
        <Loading />
      ) : advice.length === 0 ? (
        <Panel>
          <Empty title={t('Nog geen adviezen', 'No advice yet')} />
        </Panel>
      ) : (
        advice.map((a) => {
          const [nl, en, tone] = ADVICE_STATUS[a.status] ?? [a.status, a.status, 'neutral'];
          return (
            <Panel key={a.id}>
              <div className="stack" style={{ gap: 8 }}>
                <div className="row between">
                  <span className="row" style={{ gap: 8 }}>
                    <Badge tone={tone}>{language === 'en' ? en : nl}</Badge>
                    <span className="small muted">
                      {a.requestedByName} → {a.requestedFromName ?? a.requestedFromUnit}, {date(a.requestedAt, language)}
                    </span>
                  </span>
                  {a.status === 'OPEN' && <Due date={a.dueDate} />}
                </div>
                <p>
                  <strong>{t('Vraag', 'Question')}:</strong> {a.question}
                </p>
                {a.answer && (
                  <blockquote style={{ margin: 0, padding: '10px 14px', background: 'var(--surface-sunk)', borderLeft: '3px solid var(--ok)', borderRadius: 6 }}>
                    {a.answer}
                    <div className="xs muted" style={{ marginTop: 6 }}>
                      {a.answeredByName}, {dateTime(a.answeredAt, language)}
                    </div>
                  </blockquote>
                )}
                {a.status === 'OPEN' && a.requestedFromAccountId === user?.accountId && (
                  <button type="button" className="btn sm primary" style={{ alignSelf: 'flex-start' }} onClick={() => setAnswering(a)}>
                    {t('Advies geven', 'Give advice')}
                  </button>
                )}
              </div>
            </Panel>
          );
        })
      )}
      {asking && (
        <Confirm
          title={t('Advies vragen', 'Request advice')}
          confirmLabel={t('Vraag versturen', 'Send request')}
          onClose={() => setAsking(false)}
          busy={action.busy}
          error={action.error}
          disabled={!who || !question.trim()}
          onConfirm={() =>
            void action.run(async () => {
              await api.post(`/api/dossiers/${dossier.id}/advice`, { requestedFromAccountId: who, question: question.trim(), dueDate: due || null });
              toast(t('Adviesaanvraag verstuurd', 'Advice request sent'));
              setAsking(false);
              setQuestion('');
              onChanged();
            })
          }
        >
          <Field label={t('Aan wie', 'To whom')}>
            <PersonSelect value={who} onChange={setWho} exclude={user ? [user.accountId] : []} />
          </Field>
          <Field label={t('Uw vraag', 'Your question')}>
            <textarea className="textarea" value={question} onChange={(e) => setQuestion(e.target.value)} />
          </Field>
          <Field label={t('Graag vóór', 'Please by')}>
            <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
        </Confirm>
      )}
      {answering && (
        <Confirm
          title={t('Advies geven', 'Give advice')}
          confirmLabel={t('Advies versturen', 'Send advice')}
          onClose={() => setAnswering(null)}
          busy={action.busy}
          error={action.error}
          disabled={!answer.trim()}
          onConfirm={() =>
            void action.run(async () => {
              await api.post(`/api/advice/${answering.id}/answer`, { answer: answer.trim() });
              toast(t('Advies gegeven', 'Advice given'));
              setAnswering(null);
              onChanged();
            })
          }
        >
          <p className="small">{answering.question}</p>
          <Field label={t('Uw advies', 'Your advice')}>
            <textarea className="textarea" style={{ minHeight: 160 }} value={answer} onChange={(e) => setAnswer(e.target.value)} />
          </Field>
        </Confirm>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ timeline */

interface Entry {
  occurredAt: string;
  kind: string;
  headline: string;
  actorName: string | null;
  onBehalfOfName: string | null;
  detail: string | null;
}

export function translateHeadline(text: string, language: string): string {
  if (language === 'en') return text;
  const rules: [RegExp, string][] = [
    [/^Dossier opened$/, 'Zaak geopend'],
    [/^Responsibility assigned to (.+)$/, 'Verantwoordelijkheid toegewezen aan $1'],
    [/^Official due date set to (.+)$/, 'Termijn vastgesteld op $1'],
    [/^Official due date changed to (.+)$/, 'Termijn gewijzigd naar $1'],
    [/^Official due date removed$/, 'Termijn verwijderd'],
    [/^Record (.+) filed in this matter$/, 'Stuk $1 aan de zaak toegevoegd'],
    [/^Record (.+) registered$/, 'Stuk $1 geregistreerd'],
    [/^Document captured: (.+)$/, 'Document vastgelegd: $1'],
    [/^Submitted for review to (.+)$/, 'Ter beoordeling aangeboden aan $1'],
    [/^Returned for correction$/, 'Teruggestuurd ter correctie'],
    [/^Approved$/, 'Goedgekeurd'],
    [/^Finalised$/, 'Afgerond'],
    [/^Reopened$/, 'Heropend'],
    [/^Dossier closed$/, 'Dossier gesloten'],
    [/^Dossier reopened$/, 'Dossier heropend'],
    [/^Task (\S+) created for (.+)$/, 'Taak $1 aangemaakt voor $2'],
    [/^Task (\S+) completed$/, 'Taak $1 afgerond'],
    [/^Task (\S+) cancelled$/, 'Taak $1 geannuleerd'],
    [/^Task (\S+) reassigned to (.*)$/, 'Taak $1 overgedragen aan $2'],
    [/^Task (\S+) declined$/, 'Taak $1 geweigerd'],
    [/^Advice requested from (.+)$/, 'Advies gevraagd aan $1'],
    [/^Advice given by (.+)$/, 'Advies gegeven door $1'],
    [/^Step approved: (.+)$/, 'Stap goedgekeurd: $1'],
    [/^Classification changed from (.+) to (.+)$/, 'Vertrouwelijkheid gewijzigd van $1 naar $2'],
    [/^Legal hold placed$/, 'Juridische blokkade ingesteld'],
    [/^Legal hold released$/, 'Juridische blokkade opgeheven'],
  ];
  for (const [re, nl] of rules) if (re.test(text)) return text.replace(re, nl).replace(/(\d{4})-(\d{2})-(\d{2})/, '$3-$2-$1');
  return text;
}

function Timeline({ dossier }: { dossier: DossierView }) {
  const { t, language } = usePrefs();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const action = useAction();
  const load = (c: string | null) =>
    action.run(async () => {
      const r = await api.get<{ entries: Entry[]; total: number; nextCursor: string | null }>(`/api/dossiers/${dossier.id}/timeline/page?limit=40${c ? `&cursor=${encodeURIComponent(c)}` : ''}`);
      setEntries((e) => (c ? [...e, ...r.entries] : r.entries));
      setCursor(r.nextCursor);
      setTotal(r.total);
    });
  useEffect(() => {
    void load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dossier.id]);
  return (
    <Panel
      title={t('Alles wat er in deze zaak gebeurde', 'Everything that happened in this matter')}
      actions={
        <>
          <button type="button" className="btn sm" onClick={() => void api.download(`/api/dossiers/${dossier.id}/timeline/export.pdf`, `tijdlijn-${dossier.dossierIdentity}.pdf`)}>
            <FileDown size={16} /> PDF
          </button>
          <button type="button" className="btn sm" onClick={() => void api.download(`/api/dossiers/${dossier.id}/timeline/export`, `tijdlijn-${dossier.dossierIdentity}.csv`)}>
            <Download size={16} /> CSV
          </button>
        </>
      }
    >
      <ErrorNote error={action.error} />
      <ol className="timeline" style={{ marginTop: 8 }}>
        {entries.map((e, i) => (
          <li key={`${e.occurredAt}-${i}`} className={/APPROVED|FINALISED|GIVEN|COMPLETED/.test(e.kind) ? 'ok' : /RETURNED|HOLD/.test(e.kind) ? 'danger' : ''}>
            <strong>{translateHeadline(e.headline, language)}</strong>
            {(e.actorName || e.detail) && (
              <div className="small">
                {e.actorName}
                {e.onBehalfOfName ? ` ${t('namens', 'on behalf of')} ${e.onBehalfOfName}` : ''}
                {e.detail ? <span className="muted"> — {e.detail}</span> : null}
              </div>
            )}
            <div className="when">{dateTime(e.occurredAt, language)}</div>
          </li>
        ))}
      </ol>
      <div className="row between small muted">
        <span>{t(`${entries.length} van ${total} gebeurtenissen`, `${entries.length} of ${total} events`)}</span>
        {cursor && (
          <button type="button" className="btn sm" disabled={action.busy} onClick={() => void load(cursor)}>
            {t('Meer laden', 'Load more')}
          </button>
        )}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ archive & relations */

function ArchiveTab({ dossier, category, categories, onChanged }: { dossier: DossierView; category: Category | null; categories: Category[]; onChanged: () => void }) {
  const { t, language } = usePrefs();
  const { has } = useSession();
  const toast = useToast();
  const retention = useApi<{ legalHold: boolean; retentionState: string; retentionDueDate: string | null; retentionYears: number | null; retentionAction: string | null; decisions: { decision: string; reason: string; decidedByName: string; decidedAt: string }[]; holds: { action: string; reason: string; actorName: string; occurredAt: string }[] }>(`/api/dossiers/${dossier.id}/retention`);
  const relations = useApi<{ id: string; relation: string; dossierId: string; dossierIdentity: string; subject: string; note: string | null; outgoing: boolean }[]>(`/api/dossiers/${dossier.id}/relations`);
  const partners = useApi<{ code: string; name: string; isActive: boolean }[]>('/api/exchange/partners');
  const [dialog, setDialog] = useState<null | 'category' | 'relation' | 'hold' | 'exchange'>(null);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [relation, setRelation] = useState('RELATED');
  const allDossiers = useApi<{ id: string; dossierIdentity: string; subject: string }[]>(dialog === 'relation' ? '/api/dossiers' : null);
  const action = useAction();
  const close = () => (setDialog(null), setValue(''), setReason(''));
  const canHold = has('MINISTER', 'DIRECTEUR', 'RECORDS_MANAGER');
  return (
    <div className="grid-2">
      <Panel title={t('Archiefplan en bewaren', 'File plan and retention')}>
        <div className="stack">
          <KV
            rows={[
              [t('Categorie', 'Category'), category ? `${category.code} — ${category.name}` : t('geen', 'none')],
              [t('Bewaartermijn', 'Retention period'), category?.retentionYears !== null && category?.retentionYears !== undefined ? t(`${category.retentionYears} jaar na sluiten`, `${category.retentionYears} years after closing`) : '—'],
              [t('Daarna', 'Then'), RETENTION_ACTION(t, category?.retentionAction ?? null)],
              [t('Juridische blokkade', 'Legal hold'), dossier.legalHold ? <Badge key="h" tone="danger">{t('Ja, niets mag worden vernietigd', 'Yes, nothing may be destroyed')}</Badge> : t('Nee', 'No')],
            ]}
          />
          <div className="row">
            {dossier.state !== 'CLOSED' && (
              <button type="button" className="btn sm" onClick={() => (setValue(dossier.categoryId ?? ''), setDialog('category'))}>
                {t('Categorie wijzigen', 'Change category')}
              </button>
            )}
            {canHold && (
              <button type="button" className="btn sm" onClick={() => setDialog('hold')}>
                {dossier.legalHold ? <ShieldOff size={15} /> : <Lock size={15} />} {dossier.legalHold ? t('Blokkade opheffen', 'Release hold') : t('Juridische blokkade', 'Legal hold')}
              </button>
            )}
            <button type="button" className="btn sm" onClick={() => void api.download(`/api/dossiers/${dossier.id}/archive-package`, `archiefpakket-${dossier.dossierIdentity}.zip`)}>
              <Archive size={15} /> {t('Archiefpakket', 'Archive package')}
            </button>
          </div>
          {(retention.data?.holds ?? []).length > 0 && (
            <ol className="timeline">
              {retention.data!.holds.map((h, i) => (
                <li key={i} className="danger">
                  <strong>{h.action === 'SET' ? t('Blokkade ingesteld', 'Hold placed') : t('Blokkade opgeheven', 'Hold released')}</strong>
                  <div className="small">
                    {h.actorName}: “{h.reason}”
                  </div>
                  <div className="when">{dateTime(h.occurredAt, language)}</div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </Panel>
      <div className="stack">
        <Panel
          title={t('Verwante zaken', 'Related matters')}
          actions={
            <button type="button" className="btn sm" onClick={() => setDialog('relation')}>
              <Plus size={15} /> {t('Relatie', 'Relation')}
            </button>
          }
          flush
        >
          {(relations.data ?? []).length === 0 ? (
            <p className="muted small" style={{ padding: '4px 20px 14px' }}>
              {t('Geen verwante zaken.', 'No related matters.')}
            </p>
          ) : (
            <ul className="list">
              {relations.data!.map((r) => (
                <li key={r.id}>
                  <Link to={`/zaken/${r.dossierId}`} className="list-link">
                    <Stamp value={r.dossierIdentity} />
                    <span className="grow stack" style={{ gap: 2 }}>
                      <span className="list-title">{r.subject}</span>
                      <span className="small muted">
                        {RELATION(t, r.relation)}
                        {r.note ? ` — ${r.note}` : ''}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title={t('Naar een ander ministerie sturen', 'Send to another ministry')}>
          <div className="stack">
            <p className="small muted">{t('De geregistreerde stukken gaan als ondertekend pakket; de ontvanger controleert handtekening en vingerafdrukken voordat iets wordt ingelezen.', 'The registered records go as a signed package; the recipient checks signature and fingerprints before anything is taken in.')}</p>
            <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setDialog('exchange')} disabled={dossier.classification === 'SECRET'}>
              <Send size={15} /> {t('Uitwisselingspakket maken', 'Create exchange package')}
            </button>
          </div>
        </Panel>
      </div>

      {dialog === 'category' && (
        <Confirm
          title={t('Categorie wijzigen', 'Change category')}
          confirmLabel={t('Opslaan', 'Save')}
          onClose={close}
          busy={action.busy}
          error={action.error}
          onConfirm={() => void action.run(async () => (await api.post(`/api/dossiers/${dossier.id}/category`, { categoryId: value || null }), toast(t('Categorie opgeslagen', 'Category saved')), close(), onChanged()))}
        >
          <select className="select" value={value} onChange={(e) => setValue(e.target.value)} aria-label={t('Categorie', 'Category')}>
            <option value="">{t('Geen categorie', 'No category')}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
        </Confirm>
      )}
      {dialog === 'relation' && (
        <Confirm
          title={t('Relatie met een andere zaak', 'Relation to another matter')}
          confirmLabel={t('Vastleggen', 'Record')}
          onClose={close}
          busy={action.busy}
          error={action.error}
          disabled={!value}
          onConfirm={() => void action.run(async () => (await api.post(`/api/dossiers/${dossier.id}/relations`, { relatedDossierId: value, relation, note: reason.trim() || undefined }), close(), void relations.reload()))}
        >
          <select className="select" value={relation} onChange={(e) => setRelation(e.target.value)} aria-label={t('Soort relatie', 'Kind of relation')}>
            {['RELATED', 'SAME_SUBJECT', 'FOLLOW_UP', 'PRECEDES'].map((r) => (
              <option key={r} value={r}>
                {RELATION(t, r)}
              </option>
            ))}
          </select>
          <select className="select" value={value} onChange={(e) => setValue(e.target.value)} aria-label={t('Zaak', 'Matter')}>
            <option value="">{t('Kies een zaak…', 'Choose a matter…')}</option>
            {(allDossiers.data ?? [])
              .filter((d) => d.id !== dossier.id)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.dossierIdentity} — {d.subject}
                </option>
              ))}
          </select>
          <input className="input" placeholder={t('Toelichting (optioneel)', 'Note (optional)')} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Confirm>
      )}
      {dialog === 'hold' && (
        <Confirm
          title={dossier.legalHold ? t('Juridische blokkade opheffen', 'Release legal hold') : t('Juridische blokkade instellen', 'Place a legal hold')}
          confirmLabel={dossier.legalHold ? t('Opheffen', 'Release') : t('Instellen', 'Place')}
          danger={!dossier.legalHold}
          onClose={close}
          busy={action.busy}
          error={action.error}
          disabled={!reason.trim()}
          onConfirm={() => void action.run(async () => (await api.post(`/api/dossiers/${dossier.id}/legal-hold`, { action: dossier.legalHold ? 'RELEASED' : 'SET', reason }), close(), onChanged(), void retention.reload()))}
        >
          <p className="small">{t('Zolang een blokkade geldt, kan de zaak niet worden vernietigd of overgebracht.', 'While a hold applies, the matter cannot be destroyed or transferred.')}</p>
          <Field label={t('Reden', 'Reason')}>
            <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </Confirm>
      )}
      {dialog === 'exchange' && (
        <Confirm
          title={t('Uitwisselingspakket maken', 'Create exchange package')}
          confirmLabel={t('Pakket maken', 'Create package')}
          onClose={close}
          busy={action.busy}
          error={action.error}
          disabled={!value}
          onConfirm={() => void action.run(async () => (await api.download(`/api/exchange/dossiers/${dossier.id}/export`, `uitwisseling-${dossier.dossierIdentity}.zip`, { method: 'POST', body: { partnerCode: value } }), toast(t('Pakket gemaakt en vastgelegd', 'Package created and recorded')), close()))}
        >
          <Field label={t('Aan', 'To')}>
            <select className="select" value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="">{t('Kies…', 'Choose…')}</option>
              {(partners.data ?? [])
                .filter((p) => p.isActive)
                .map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name}
                  </option>
                ))}
            </select>
          </Field>
        </Confirm>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ access */

/** Who may see this record: its level, need-to-know grants and the view log. */
export function AccessPanel({ type, id, classification, onChanged }: { type: 'items' | 'dossiers'; id: string; classification: string; onChanged: () => void }) {
  const { t, language } = usePrefs();
  const { has } = useSession();
  const toast = useToast();
  const grants = useApi<{ id: string; accountId: string; personName: string; reason: string; grantedByName: string; grantedAt: string; revokedAt: string | null }[]>(`/api/access/${type}/${id}/grants`);
  const canViewLog = has('AUDITOR', 'MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR');
  const views = useApi<{ occurredAt: string; personName: string; kind: string; unit: string | null }[]>(canViewLog ? `/api/access/${type}/${id}/views` : null);
  const decide = has(...DECISION);
  const [dialog, setDialog] = useState<null | 'level' | 'grant'>(null);
  const [level, setLevel] = useState(classification);
  const [reason, setReason] = useState('');
  const [who, setWho] = useState('');
  const action = useAction();
  const close = () => (setDialog(null), setReason(''), setWho(''));
  return (
    <div className="grid-2">
      <div className="stack">
        <Panel title={t('Vertrouwelijkheid', 'Confidentiality')}>
          <div className="stack">
            <span className="row">
              <ClassStamp level={classification} always />
              {decide && (
                <button type="button" className="btn sm" onClick={() => setDialog('level')}>
                  {t('Wijzigen', 'Change')}
                </button>
              )}
            </span>
            <p className="small muted">
              {classification === 'SECRET'
                ? t('Alleen zichtbaar voor wie voor Geheim bevoegd is en wie bij de zaak betrokken is.', 'Visible only to those cleared for Secret and those involved.')
                : classification === 'CONFIDENTIAL'
                  ? t('Zichtbaar voor de bevoegde rollen, de eigen afdeling en wie bij de zaak betrokken is.', 'Visible to cleared roles, the owning department and those involved.')
                  : t('Zichtbaar voor iedereen met een werkrol in het systeem.', 'Visible to everyone with a business role in the system.')}
            </p>
          </div>
        </Panel>
        <Panel
          title={t('Toegang op basis van need-to-know', 'Need-to-know access')}
          actions={
            decide && (
              <button type="button" className="btn sm" onClick={() => setDialog('grant')}>
                <Plus size={15} /> {t('Toegang geven', 'Grant access')}
              </button>
            )
          }
          flush
        >
          <ul className="list">
            {(grants.data ?? []).map((g) => (
              <li key={g.id} className="row between">
                <span>
                  <strong>{g.personName}</strong>
                  <br />
                  <span className="small muted">
                    {g.reason} — {g.grantedByName}, {date(g.grantedAt, language)}
                  </span>
                </span>
                {g.revokedAt ? (
                  <Badge>{t('Ingetrokken', 'Revoked')}</Badge>
                ) : (
                  decide && (
                    <button type="button" className="btn sm" onClick={() => void action.run(async () => (await api.post(`/api/access/grants/${g.id}/revoke`), void grants.reload()))}>
                      {t('Intrekken', 'Revoke')}
                    </button>
                  )
                )}
              </li>
            ))}
            {grants.data?.length === 0 && <li className="small muted">{t('Geen extra toegang gegeven.', 'No extra access granted.')}</li>}
          </ul>
        </Panel>
      </div>
      <Panel title={t('Wie heeft dit geopend', 'Who opened this')} flush>
        {!canViewLog ? (
          <p className="small muted" style={{ padding: '4px 20px 14px' }}>
            {t('Het inzagelogboek is zichtbaar voor de leiding en de auditor.', 'The view log is visible to management and the auditor.')}
          </p>
        ) : (
          <ul className="list" style={{ maxHeight: 460, overflowY: 'auto' }}>
            {(views.data ?? []).map((v, i) => (
              <li key={i} className="row between">
                <span>
                  <Eye size={14} aria-hidden="true" /> <strong>{v.personName}</strong> <span className="small muted">{v.unit}</span>
                  <br />
                  <span className="small muted">{v.kind === 'OPENED' ? t('geopend', 'opened') : v.kind === 'PREVIEWED' ? t('document bekeken', 'document viewed') : v.kind === 'DOWNLOADED' ? t('gedownload', 'downloaded') : v.kind.toLowerCase()}</span>
                </span>
                <span className="small muted nowrap">{dateTime(v.occurredAt, language)}</span>
              </li>
            ))}
            {views.data?.length === 0 && <li className="small muted">{t('Nog door niemand geopend.', 'Not opened by anyone yet.')}</li>}
          </ul>
        )}
      </Panel>
      {dialog === 'level' && (
        <Confirm
          title={t('Vertrouwelijkheid wijzigen', 'Change confidentiality')}
          confirmLabel={t('Wijzigen', 'Change')}
          onClose={close}
          busy={action.busy}
          error={action.error}
          disabled={!reason.trim() || level === classification}
          onConfirm={() => void action.run(async () => (await api.post(`/api/access/${type}/${id}/classification`, { level, reason }), toast(t('Vertrouwelijkheid gewijzigd', 'Confidentiality changed')), close(), onChanged()))}
        >
          <select className="select" value={level} onChange={(e) => setLevel(e.target.value)} aria-label={t('Niveau', 'Level')}>
            {Object.entries(CLASSIFICATION).map(([k, v]) => (
              <option key={k} value={k}>
                {language === 'en' ? v[1] : v[0]}
              </option>
            ))}
          </select>
          <Field label={t('Reden', 'Reason')}>
            <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </Confirm>
      )}
      {dialog === 'grant' && (
        <Confirm
          title={t('Toegang geven', 'Grant access')}
          confirmLabel={t('Toegang geven', 'Grant access')}
          onClose={close}
          busy={action.busy}
          error={action.error}
          disabled={!who || !reason.trim()}
          onConfirm={() => void action.run(async () => (await api.post(`/api/access/${type}/${id}/grants`, { accountId: who, reason }), close(), void grants.reload()))}
        >
          <Field label={t('Aan wie', 'To whom')}>
            <PersonSelect value={who} onChange={setWho} />
          </Field>
          <Field label={t('Waarom heeft deze persoon het nodig?', 'Why does this person need it?')}>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </Confirm>
      )}
    </div>
  );
}

export { CalendarClock, Dialog };
