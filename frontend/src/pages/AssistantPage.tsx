import { CalendarClock, Check, FileSearch, Languages, ListChecks, MessageSquare, MessagesSquare, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { ago, date, dateTime } from '../lib/format';
import { useApi } from '../lib/hooks';
import { AI_FEATURE } from '../lib/labels';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { useAssistant } from '../shell/context';
import { Badge, Confidence, Empty, EngineInfo, ErrorNote, Field, Loading, Notice, PageHead, Panel, Proposal, Stamp, Tabs, useToast } from '../ui';
import { HBars } from '../ui/charts';
import { PersonSelect } from '../ui/people';
import type { DossierView } from './DossierDetailPage';

type Tab = 'vragen' | 'notulen' | 'risico' | 'lezen' | 'vertalen' | 'geschiedenis';

interface Status { provider: string; model: string; local: boolean; free: boolean; features: Record<string, boolean>; canSeeEverything: boolean }

const OUTCOME: Record<string, [string, string, 'ok' | 'warn' | 'danger' | 'neutral']> = {
  ACCEPTED: ['Overgenomen', 'Accepted', 'ok'],
  EDITED: ['Aangepast overgenomen', 'Accepted with changes', 'warn'],
  REJECTED: ['Afgewezen', 'Rejected', 'danger'],
};

export default function AssistantPage() {
  const { t } = usePrefs();
  const { ai, has } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'vragen';
  const status = useApi<Status>('/api/ai/status');
  const setTab = (v: Tab) => setParams(v === 'vragen' ? {} : { tab: v }, { replace: true });
  const s = status.data;
  return (
    <>
      <PageHead
        title={t('Assistent', 'Assistant')}
        lead={t(
          'Een gratis assistent die op de eigen server van het ministerie draait. Hij ziet alleen wat u mag zien, doet voorstellen en laat de beslissing altijd aan u. Elk voorstel en wat u ermee doet, komt in het logboek.',
          'A free assistant that runs on the ministry’s own server. It sees only what you may see, makes suggestions and always leaves the decision to you. Every suggestion, and what you do with it, goes into the log.',
        )}
      />
      {s && (
        <div className="assist-status">
          <span className="assist-status-mark">
            <ShieldCheck size={22} aria-hidden="true" />
          </span>
          <div className="grow stack" style={{ gap: 2 }}>
            <strong>{s.provider === 'builtin' ? t('Ingebouwde assistent', 'Built-in assistant') : s.model}</strong>
            <span className="small muted">
              {s.provider === 'builtin'
                ? t('Draait volledig op de eigen server. Geen abonnement, geen internet nodig, er gaat geen tekst naar buiten.', 'Runs entirely on the ministry’s own server. No subscription, no internet needed, no text leaves it.')
                : s.local
                  ? t('Open-source taalmodel op het eigen netwerk, met de ingebouwde assistent als terugval.', 'Open-source language model on the ministry network, with the built-in assistant as fallback.')
                  : t('Externe dienst. Vertrouwelijke en geheime stukken gaan er nooit naartoe.', 'External service. Confidential and secret records never go there.')}
            </span>
          </div>
          <div className="chips" aria-label={t('Ingeschakelde functies', 'Features switched on')}>
            {Object.entries(s.features)
              .filter(([f, on]) => on && !(f === 'translate' && s.provider === 'builtin'))
              .map(([f]) => (
                <Badge key={f} tone="assist">
                  {AI_FEATURE(t, f)}
                </Badge>
              ))}
          </div>
        </div>
      )}
      <Tabs
        label={t('Onderdelen van de assistent', 'Parts of the assistant')}
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'vragen', label: t('Vragen over het werk', 'Questions about the work'), hidden: !ai('ask') && !ai('chat') },
          { value: 'notulen', label: t('Notulen naar taken', 'Notes into tasks'), hidden: !ai('meetingNotes') },
          { value: 'risico', label: t('Termijnrisico', 'Deadline risk'), hidden: !ai('risk') },
          { value: 'lezen', label: t('Brief laten lezen', 'Read a letter'), hidden: !ai('intake') },
          { value: 'vertalen', label: t('Vertalen', 'Translate'), hidden: !ai('translate') },
          { value: 'geschiedenis', label: t('Geschiedenis', 'History') },
        ]}
      />
      <div style={{ marginTop: 20 }}>
        {tab === 'vragen' && <AskTab />}
        {tab === 'notulen' && <NotesTab />}
        {tab === 'risico' && <RiskTab />}
        {tab === 'lezen' && <ReadTab />}
        {tab === 'vertalen' && <TranslateTab status={s} />}
        {tab === 'geschiedenis' && <HistoryTab showUsage={has('MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'SYS_ADMIN', 'AUDITOR')} />}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ ask

interface AskAnswer { answer: string; understood: string[]; count: number; rows: { id: string; identity: string | null; title: string; meta: string; date: string | null; link: string; type: string }[]; engine: EngineInfo }

function AskTab() {
  const { t, language } = usePrefs();
  const { ask } = useAssistant();
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const examples =
    language === 'en'
      ? ['Which letters from the Police came in this month?', 'Which matters are overdue?', 'Show my tasks due this week', 'How many matters were finished in September?', 'Which confidential letters are not yet linked to a matter?']
      : ['Welke brieven van de Politie kwamen deze maand binnen?', 'Welke zaken zijn over termijn?', 'Toon mijn taken met termijn deze week', 'Hoeveel zaken zijn in september afgerond?', 'Welke brieven over gratie zijn er?'];
  const run = async (question: string) => {
    if (!question.trim()) return;
    setQ(question);
    setBusy(true);
    setError(null);
    try {
      setAnswer(await api.post<AskAnswer>('/api/ai/ask', { question, language }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="split">
      <div className="stack" style={{ '--gap': '16px' } as React.CSSProperties}>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(q);
          }}
        >
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Stel een vraag in gewone taal', 'Ask a question in plain language')} aria-label={t('Vraag', 'Question')} />
          <button type="submit" className="btn assist solid" disabled={busy || !q.trim()}>
            <Sparkles size={16} /> {t('Vragen', 'Ask')}
          </button>
        </form>
        <div className="chips">
          {examples.map((x) => (
            <button key={x} type="button" className="chip-btn" onClick={() => void run(x)}>
              {x}
            </button>
          ))}
        </div>
        <ErrorNote error={error} />
        {busy && <Loading />}
        {answer && (
          <Proposal title={t('Antwoord', 'Answer')} engine={answer.engine}>
            <p style={{ margin: 0 }}>
              <strong>{answer.answer}</strong>
            </p>
            <p className="small muted" style={{ margin: 0 }}>
              {t('Zo begreep ik de vraag:', 'This is how I understood the question:')} {answer.understood.join('; ')}
            </p>
            {answer.rows.length > 0 && (
              <ul className="list" style={{ margin: '0 -16px' }}>
                {answer.rows.map((r) => (
                  <li key={r.id}>
                    <Link to={r.link} className="list-link">
                      {r.identity && <Stamp value={r.identity} />}
                      <span className="grow stack" style={{ gap: 2 }}>
                        <span className="list-title">{r.title}</span>
                        <span className="small muted">{r.meta}</span>
                      </span>
                      <span className="small muted nowrap">{r.date ? date(r.date, language) : ''}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Proposal>
        )}
      </div>
      <div className="stack">
        <Panel title={t('Of voer een gesprek', 'Or have a conversation')}>
          <p className="small" style={{ marginTop: 0 }}>
            {t('De chat-assistent staat op elke pagina rechtsboven. Hij kan ook een zaak samenvatten, een conceptantwoord schrijven, een taak klaarzetten en uitleggen hoe het systeem werkt.', 'The chat assistant is at the top right of every page. It can also summarise a matter, write a draft reply, prepare a task and explain how the system works.')}
          </p>
          <button type="button" className="btn assist" onClick={() => ask(language === 'en' ? 'What is waiting for me today?' : 'Wat staat er vandaag voor mij klaar?')}>
            <MessageSquare size={16} /> {t('Open de chat', 'Open the chat')}
          </button>
        </Panel>
        <Panel title={t('Wat de assistent niet doet', 'What the assistant does not do')}>
          <ul className="small stack" style={{ margin: 0, paddingLeft: 18, gap: 6 }}>
            <li>{t('Niets registreren, versturen of beslissen zonder uw bevestiging.', 'Register, send or decide anything without your confirmation.')}</li>
            <li>{t('Stukken tonen die u niet mag zien; ook niet als u erom vraagt.', 'Show records you may not see, not even when you ask.')}</li>
            <li>{t('Tekst naar internet sturen. Een extern model krijgt nooit vertrouwelijke of geheime stukken.', 'Send text to the internet. An external model never receives confidential or secret records.')}</li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ meeting notes

interface NoteProposal { line: number; original: string; title: string; assignee: { accountId: string; name: string } | null; assigneeText: string | null; dueDate: string | null; priority: 'MEDIUM' | 'HIGH' | 'URGENT'; confidence: number }
interface Row { use: boolean; title: string; assignee: string; dueDate: string; priority: string }

const SAMPLE_NOTES = `Stafoverleg Directoraat Justitie, 26 oktober 2026
Aanwezig: R. Dijkstra, M. Sardjoe, A. Boldewijn, N. Kartodikromo, R. Sabajo

1. Overbevolking justitiële inrichtingen
- Sabajo levert vóór vrijdag de bezettingscijfers van Santo Boma aan.
- Kartodikromo stelt binnen 5 werkdagen het concept-antwoord op de DNA-vragen op.

2. Begroting 2027
- Actie Ramdin: overzicht van de meerkosten bewaking, uiterlijk 15 november 2026.

3. Rondvraag
- Ik bel de Korpschef over de verkeerscontroles tijdens de feestdagen.`;

function NotesTab() {
  const { t, language } = usePrefs();
  const toast = useToast();
  const dossiers = useApi<DossierView[]>('/api/dossiers');
  const [text, setText] = useState('');
  const [dossierId, setDossierId] = useState('');
  const [result, setResult] = useState<{ interactionId: string; engine: EngineInfo; proposals: NoteProposal[] } | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<number | null>(null);
  const read = async () => {
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const r = await api.post<{ interactionId: string; engine: EngineInfo; proposals: NoteProposal[] }>('/api/ai/meeting-notes', { text, dossierId: dossierId || null });
      setResult(r);
      setRows(r.proposals.map((p) => ({ use: Boolean(p.assignee), title: p.title, assignee: p.assignee?.accountId ?? '', dueDate: p.dueDate ?? '', priority: p.priority })));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      const chosen = rows.filter((r) => r.use && r.assignee && r.title.trim());
      const edited = rows.some((r, i) => r.title !== result.proposals[i].title || r.assignee !== (result.proposals[i].assignee?.accountId ?? '') || r.dueDate !== (result.proposals[i].dueDate ?? '') || !r.use);
      const r = await api.post<{ applied: { tasks?: unknown[] } }>(`/api/ai/interactions/${result.interactionId}/feedback`, {
        outcome: edited ? 'EDITED' : 'ACCEPTED',
        apply: { tasks: chosen.map((c) => ({ title: c.title.trim(), assigneeAccountId: c.assignee, dueDate: c.dueDate || null, priority: c.priority, dossierId: dossierId || null })) },
      });
      setCreated(r.applied.tasks?.length ?? 0);
      toast(t(`${r.applied.tasks?.length ?? 0} taken aangemaakt`, `${r.applied.tasks?.length ?? 0} tasks created`));
      window.dispatchEvent(new CustomEvent('juspol:changed'));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const reject = async () => {
    if (!result) return;
    await api.post(`/api/ai/interactions/${result.interactionId}/feedback`, { outcome: 'REJECTED' }).catch(() => null);
    setResult(null);
    setRows([]);
  };
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="grid-5-7">
      <Panel title={t('Notulen', 'Meeting notes')} actions={<button type="button" className="btn link small" onClick={() => setText(SAMPLE_NOTES)}>{t('Voorbeeld invullen', 'Fill in an example')}</button>}>
        <div className="stack">
          <Field label={t('Plak de notulen of de actielijst', 'Paste the notes or the action list')} hint={t('De assistent herkent wie wat moet doen en wanneer: “Sabajo levert vóór vrijdag…”, “Actie Ramdin: …”, “binnen 5 werkdagen”.', 'The assistant recognises who must do what and when: “Sabajo delivers by Friday…”, “Action Ramdin: …”, “within 5 working days”.')}>
            <textarea className="textarea" rows={14} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <Field label={t('Bij zaak (niet verplicht)', 'With matter (optional)')}>
            <select className="select" value={dossierId} onChange={(e) => setDossierId(e.target.value)}>
              <option value="">{t('Geen zaak', 'No matter')}</option>
              {(dossiers.data ?? [])
                .filter((d) => d.state !== 'CLOSED')
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.dossierIdentity} — {d.subject}
                  </option>
                ))}
            </select>
          </Field>
          <div className="row">
            <button type="button" className="btn assist solid" disabled={busy || !text.trim()} onClick={() => void read()}>
              <ListChecks size={16} /> {t('Actiepunten herkennen', 'Find action items')}
            </button>
          </div>
          <ErrorNote error={error} />
        </div>
      </Panel>
      <div className="stack">
        {!result && <Empty title={t('Nog geen voorstellen', 'No suggestions yet')}>{t('Plak notulen en laat de assistent de actiepunten zoeken. U controleert elk punt voordat er een taak wordt aangemaakt.', 'Paste notes and let the assistant find the action items. You check every item before a task is created.')}</Empty>}
        {result && created === null && (
          <Proposal
            title={t(`${result.proposals.length} actiepunten gevonden`, `${result.proposals.length} action items found`)}
            engine={result.engine}
            actions={
              <button type="button" className="btn link small" onClick={() => void reject()}>
                {t('Niet gebruiken', 'Do not use')}
              </button>
            }
          >
            {result.proposals.length === 0 && <p className="small">{t('Er zijn geen actiepunten herkend.', 'No action items were recognised.')}</p>}
            <ol className="stack" style={{ margin: 0, paddingLeft: 0, listStyle: 'none', gap: 14 }}>
              {result.proposals.map((p, i) => (
                <li key={i} className="note-row">
                  <label className="check">
                    <input type="checkbox" checked={rows[i].use} onChange={(e) => set(i, { use: e.target.checked })} aria-label={t('Dit actiepunt gebruiken', 'Use this action item')} />
                  </label>
                  <div className="stack grow" style={{ gap: 8 }}>
                    <span className="xs muted">
                      {t('Regel', 'Line')} {p.line}: “{p.original}” <Confidence value={p.confidence} />
                    </span>
                    <input className="input" value={rows[i].title} onChange={(e) => set(i, { title: e.target.value })} aria-label={t('Titel van de taak', 'Task title')} disabled={!rows[i].use} />
                    <div className="note-fields">
                      <PersonSelect value={rows[i].assignee} onChange={(v) => set(i, { assignee: v })} placeholder={p.assigneeText ? t(`“${p.assigneeText}” niet herkend — kies…`, `“${p.assigneeText}” not recognised — choose…`) : undefined} />
                      <input className="input" type="date" value={rows[i].dueDate} onChange={(e) => set(i, { dueDate: e.target.value })} aria-label={t('Termijn', 'Due date')} />
                      <select className="select" value={rows[i].priority} onChange={(e) => set(i, { priority: e.target.value })} aria-label={t('Prioriteit', 'Priority')}>
                        <option value="LOW">{t('Laag', 'Low')}</option>
                        <option value="MEDIUM">{t('Normaal', 'Normal')}</option>
                        <option value="HIGH">{t('Hoog', 'High')}</option>
                        <option value="URGENT">{t('Spoed', 'Urgent')}</option>
                      </select>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            <div className="row">
              <button type="button" className="btn primary" disabled={busy || !rows.some((r) => r.use && r.assignee && r.title.trim())} onClick={() => void create()}>
                <Check size={16} /> {t(`${rows.filter((r) => r.use && r.assignee).length} taken aanmaken`, `Create ${rows.filter((r) => r.use && r.assignee).length} tasks`)}
              </button>
              <span className="xs muted">{t('Elke medewerker krijgt een melding. De taken krijgen als bron “notulen”.', 'Each person is notified. The tasks get “meeting notes” as their source.')}</span>
            </div>
          </Proposal>
        )}
        {created !== null && (
          <Notice tone="ok" title={t(`${created} taken aangemaakt`, `${created} tasks created`)}>
            <Link to="/taken?scope=assigned">{t('Bekijk de taken die u heeft uitgezet', 'See the tasks you assigned')}</Link>{' '}
            <button type="button" className="btn link" onClick={() => (setResult(null), setCreated(null), setText(''))}>
              {t('Nieuwe notulen', 'New notes')}
            </button>
            <span className="xs muted" style={{ display: 'block', marginTop: 4 }}>
              {t(`Vastgelegd ${dateTime(new Date().toISOString(), language)}`, `Recorded ${dateTime(new Date().toISOString(), language)}`)}
            </span>
          </Notice>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ risk

interface Risk {
  engine: EngineInfo;
  scope: string;
  generatedOn: string;
  counts: { high: number; medium: number; low: number; letters: number };
  dossiers: { dossierId: string; dossierIdentity: string; subject: string; dueDate: string | null; workingDaysLeft: number | null; responsible: string | null; processingState: string; score: number; level: 'HIGH' | 'MEDIUM' | 'LOW'; reasons: string[]; openTasks: number }[];
  letters: { itemId: string; registrationIdentity: string; subject: string; reasons: string[] }[];
}

function RiskTab() {
  const { t, language } = usePrefs();
  const { manager } = useSession();
  const [scope, setScope] = useState<'mine' | 'all'>(manager ? 'all' : 'mine');
  const { data, error, loading } = useApi<Risk>(`/api/ai/risk?scope=${scope}&language=${language}`);
  const levelTone = { HIGH: 'danger', MEDIUM: 'warn', LOW: 'ok' } as const;
  const levelText = (l: string) => ({ HIGH: t('Hoog', 'High'), MEDIUM: t('Middel', 'Medium'), LOW: t('Laag', 'Low') })[l] ?? l;
  return (
    <div className="stack" style={{ '--gap': '18px' } as React.CSSProperties}>
      <div className="row between">
        <p className="muted" style={{ margin: 0, maxWidth: '70ch' }}>
          {t('De assistent weegt de resterende werkdagen, hoe lang er niets gebeurde, open taken en adviezen en waar de goedkeuring staat. De score is een hulpmiddel; de redenen staan erbij.', 'The assistant weighs the working days left, how long nothing happened, open tasks and advice, and where approval stands. The score is an aid; the reasons are shown.')}
        </p>
        {manager && (
          <div className="segmented" role="group" aria-label={t('Bereik', 'Scope')}>
            <button type="button" aria-pressed={scope === 'mine'} onClick={() => setScope('mine')}>
              {t('Mijn zaken', 'My matters')}
            </button>
            <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
              {t('Hele ministerie', 'Whole ministry')}
            </button>
          </div>
        )}
      </div>
      <ErrorNote error={error} />
      {loading && !data && <Loading lines={6} />}
      {data && (
        <>
          <div className="figures">
            <div className="figure alert">
              <span className="value">{data.counts.high}</span>
              <span className="label">{t('hoog risico', 'high risk')}</span>
            </div>
            <div className="figure warn">
              <span className="value">{data.counts.medium}</span>
              <span className="label">{t('middel risico', 'medium risk')}</span>
            </div>
            <div className="figure good">
              <span className="value">{data.counts.low}</span>
              <span className="label">{t('laag risico', 'low risk')}</span>
            </div>
            <div className="figure">
              <span className="value">{data.counts.letters}</span>
              <span className="label">{t('brieven wachten op antwoord', 'letters awaiting a reply')}</span>
            </div>
          </div>
          <Panel flush>
            {data.dossiers.length === 0 ? (
              <Empty title={t('Geen lopende zaken met een termijn', 'No open matters with a deadline')} />
            ) : (
              <table className="table responsive">
                <thead>
                  <tr>
                    <th>{t('Risico', 'Risk')}</th>
                    <th>{t('Zaak', 'Matter')}</th>
                    <th>{t('Waarom', 'Why')}</th>
                    <th>{t('Termijn', 'Deadline')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.dossiers.map((d) => (
                    <tr key={d.dossierId}>
                      <td>
                        <Badge tone={levelTone[d.level]}>{levelText(d.level)}</Badge>
                        <div className="xs muted" style={{ marginTop: 4 }}>
                          {t(`score ${d.score}`, `score ${d.score}`)}
                        </div>
                      </td>
                      <td className="title-cell">
                        <Stamp value={d.dossierIdentity} to={`/zaken/${d.dossierId}`} /> <Link to={`/zaken/${d.dossierId}`}>{d.subject}</Link>
                        <div className="xs muted">{d.responsible ?? t('geen verantwoordelijke', 'no one responsible')}</div>
                      </td>
                      <td>
                        <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
                          {d.reasons.map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                        </ul>
                      </td>
                      <td className="nowrap small">
                        {d.dueDate ? date(d.dueDate, language) : '—'}
                        {d.workingDaysLeft !== null && (
                          <div className="xs" style={{ color: d.workingDaysLeft < 0 ? 'var(--danger)' : 'var(--muted)', fontWeight: d.workingDaysLeft < 0 ? 700 : 400 }}>
                            {d.workingDaysLeft < 0 ? t(`${-d.workingDaysLeft} ${d.workingDaysLeft === -1 ? 'werkdag' : 'werkdagen'} te laat`, `${-d.workingDaysLeft} working ${d.workingDaysLeft === -1 ? 'day' : 'days'} late`) : t(`nog ${d.workingDaysLeft} ${d.workingDaysLeft === 1 ? 'werkdag' : 'werkdagen'}`, `${d.workingDaysLeft} working ${d.workingDaysLeft === 1 ? 'day' : 'days'} left`)}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
          {data.letters.length > 0 && (
            <Panel title={t('Brieven die op een antwoord wachten', 'Letters awaiting a reply')} flush>
              <ul className="list">
                {data.letters.map((l) => (
                  <li key={l.itemId}>
                    <Link to={`/post/${l.itemId}`} className="list-link">
                      <Stamp value={l.registrationIdentity} />
                      <span className="grow stack" style={{ gap: 2 }}>
                        <span className="list-title">{l.subject}</span>
                        <span className="small muted">{l.reasons.join('; ')}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <span className="engine-note">
            <TriangleAlert size={13} aria-hidden="true" /> {t(`Berekend op ${date(data.generatedOn, language)}.`, `Calculated on ${date(data.generatedOn, language)}.`)}{' '}
            {data.engine.provider === 'builtin' ? t('Ingebouwde assistent, op de eigen server.', 'Built-in assistant, on the ministry’s own server.') : data.engine.model}
          </span>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ read a letter

interface Prop<T> { value: T; confidence: number; basis: string }
interface ReadResult {
  interactionId: string;
  engine: EngineInfo;
  proposals: {
    language: string;
    subject: Prop<string> | null;
    party: Prop<string> | null;
    documentDate: Prop<string> | null;
    senderReference: Prop<string> | null;
    classification: Prop<string> | null;
    deadlines: { phrase: string; dueDate: string | null; kind: string; workingDays?: number; confidence: number }[];
    requests: string[];
    wordCount: number;
  };
  routing: { unitId: string; unitName: string; confidence: number; reasons: string[]; person: { name: string; basis: string; openTasks: number } | null }[] | null;
  category: { id: string; code: string; name: string; confidence: number; reasons?: string[] }[] | null;
  duplicates: { itemId: string; registrationIdentity: string | null; subject: string; similarity: number; reasons: string[] }[] | null;
}

const SAMPLE_LETTER = `Korps Politie Suriname
Hoofdbureau, Paramaribo
Paramaribo, 20 oktober 2026
Ons kenmerk: KPS/2026/1187

Aan de Minister van Justitie en Politie

Betreft: aanvullende informatie inzake vuurwapenvergunningen

Geachte Minister,

Hierbij verzoeken wij u binnen 10 werkdagen een overzicht te sturen van de in 2025 verleende vuurwapenvergunningen per district.
Graag ontvangen wij tevens uw reactie op het conceptbeleid voor 1 december 2026.

Hoogachtend,
R. Tjon Kie Sim
Korpschef a.i.`;

function ReadTab() {
  const { t, language } = usePrefs();
  const [text, setText] = useState('');
  const [result, setResult] = useState<ReadResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.post<ReadResult>('/api/ai/intake', { text }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const p = result?.proposals;
  const field = (label: string, v: Prop<string> | null, render?: (x: string) => string) => (
    <div className="read-field" key={label}>
      <dt>{label}</dt>
      <dd>
        {v ? (
          <>
            <strong>{render ? render(v.value) : v.value}</strong> <Confidence value={v.confidence} />
            <div className="xs muted">
              {t('Gevonden in:', 'Found in:')} “{v.basis}”
            </div>
          </>
        ) : (
          <span className="muted">{t('niet gevonden', 'not found')}</span>
        )}
      </dd>
    </div>
  );
  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <Panel title={t('Tekst van een brief of e-mail', 'Text of a letter or e-mail')} actions={<button type="button" className="btn link small" onClick={() => setText(SAMPLE_LETTER)}>{t('Voorbeeld invullen', 'Fill in an example')}</button>}>
        <div className="stack">
          <p className="small muted" style={{ margin: 0 }}>
            {t('Bij registratie doet de assistent dit vanzelf met de gelezen tekst van een scan. Hier kunt u het proberen met geplakte tekst; er wordt niets geregistreerd.', 'At registration the assistant does this by itself with the text read from a scan. Here you can try it with pasted text; nothing is registered.')}
          </p>
          <textarea className="textarea" rows={16} value={text} onChange={(e) => setText(e.target.value)} aria-label={t('Tekst', 'Text')} />
          <div className="row">
            <button type="button" className="btn assist solid" disabled={busy || !text.trim()} onClick={() => void run()}>
              <FileSearch size={16} /> {t('Laten lezen', 'Read it')}
            </button>
          </div>
          <ErrorNote error={error} />
        </div>
      </Panel>
      <div className="stack">
        {!result && <Empty title={t('Nog niets gelezen', 'Nothing read yet')}>{t('De assistent stelt onderwerp, afzender, datum, kenmerk, termijnen en de behandelende afdeling voor, met waar hij het vond.', 'The assistant proposes subject, sender, date, reference, deadlines and the handling department, with where it found them.')}</Empty>}
        {p && result && (
          <Proposal title={t('Zo leest de assistent deze brief', 'This is how the assistant reads this letter')} engine={result.engine}>
            <dl className="read-fields">
              {field(t('Onderwerp', 'Subject'), p.subject)}
              {field(t('Afzender', 'Sender'), p.party)}
              {field(t('Datum van de brief', 'Date of the letter'), p.documentDate, (x) => date(x, language))}
              {field(t('Kenmerk afzender', 'Sender reference'), p.senderReference)}
            </dl>
            <div>
              <h4 className="mini-head">
                <CalendarClock size={15} aria-hidden="true" /> {t('Termijnen in de tekst', 'Deadlines in the text')}
              </h4>
              {p.deadlines.length === 0 ? (
                <p className="small muted">{t('Geen termijn gevonden.', 'No deadline found.')}</p>
              ) : (
                <ul className="small stack" style={{ margin: 0, paddingLeft: 18, gap: 4 }}>
                  {p.deadlines.map((d, i) => (
                    <li key={i}>
                      “{d.phrase}” → <strong>{d.dueDate ? date(d.dueDate, language) : '—'}</strong>
                      {d.kind === 'RELATIVE_WORKING_DAYS' && <span className="muted"> ({t('werkdagen, feestdagen overgeslagen', 'working days, public holidays skipped')})</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {result.routing && result.routing.length > 0 && (
              <div>
                <h4 className="mini-head">{t('Behandelende afdeling', 'Handling department')}</h4>
                {result.routing.slice(0, 2).map((r) => (
                  <p key={r.unitId} className="small" style={{ margin: '0 0 6px' }}>
                    <strong>{r.unitName}</strong> <Confidence value={r.confidence} />
                    {r.person && (
                      <>
                        <br />
                        {r.person.name} <span className="muted">({r.person.basis})</span>
                      </>
                    )}
                    <br />
                    <span className="xs muted">{r.reasons.join('; ')}</span>
                  </p>
                ))}
              </div>
            )}
            {result.duplicates && result.duplicates.length > 0 && (
              <Notice tone="warn" title={t('Lijkt op een stuk dat er al is', 'Resembles a record that already exists')}>
                {result.duplicates.slice(0, 3).map((d) => (
                  <div key={d.itemId} className="small">
                    <Link to={`/post/${d.itemId}`}>{d.registrationIdentity ?? t('concept', 'draft')}</Link> — {d.subject} ({Math.round(d.similarity * 100)}%)
                  </div>
                ))}
              </Notice>
            )}
            {p.requests.length > 0 && (
              <div>
                <h4 className="mini-head">{t('Wat wordt er gevraagd', 'What is asked')}</h4>
                <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                  {p.requests.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
          </Proposal>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ translate

function TranslateTab({ status }: { status: Status | null }) {
  const { t } = usePrefs();
  const [text, setText] = useState('');
  const [to, setTo] = useState<'nl' | 'en'>('en');
  const [result, setResult] = useState<{ translation: string; engine: EngineInfo } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const builtin = status?.provider === 'builtin';
  return (
    <div className="stack" style={{ '--gap': '16px' } as React.CSSProperties}>
      {builtin && (
        <Notice tone="info" title={t('Vertalen vraagt een taalmodel', 'Translation needs a language model')}>
          {t(
            'De ingebouwde assistent vertaalt niet. De beheerder kan onder Beheer → Assistent gratis een open-source taalmodel (Ollama) op het eigen netwerk koppelen; dan werkt vertalen hier en in de chat. Vertrouwelijke stukken blijven dan op het eigen netwerk.',
            'The built-in assistant does not translate. The administrator can connect a free open-source language model (Ollama) on the ministry network under Administration → Assistant; translation then works here and in the chat. Confidential records then stay on the ministry network.',
          )}
        </Notice>
      )}
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <Panel title={t('Tekst', 'Text')}>
          <div className="stack">
            <textarea className="textarea" rows={12} value={text} onChange={(e) => setText(e.target.value)} aria-label={t('Te vertalen tekst', 'Text to translate')} />
            <div className="row">
              <select className="select" style={{ width: 'auto' }} value={to} onChange={(e) => setTo(e.target.value as 'nl' | 'en')} aria-label={t('Naar', 'Into')}>
                <option value="en">{t('Naar het Engels', 'Into English')}</option>
                <option value="nl">{t('Naar het Nederlands', 'Into Dutch')}</option>
              </select>
              <button
                type="button"
                className="btn assist solid"
                disabled={busy || !text.trim() || builtin}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    setResult(await api.post('/api/ai/translate', { text, to }));
                  } catch (e) {
                    setError(errorText(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Languages size={16} /> {t('Vertalen', 'Translate')}
              </button>
            </div>
            <ErrorNote error={error} />
          </div>
        </Panel>
        {result ? (
          <Proposal title={t('Vertaling', 'Translation')} engine={result.engine}>
            <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{result.translation}</p>
          </Proposal>
        ) : (
          <Empty title={t('Nog geen vertaling', 'No translation yet')}>{t('Een vertaling is een hulpmiddel om een stuk te begrijpen. Het origineel blijft het officiële stuk.', 'A translation is an aid to understand a record. The original stays the official record.')}</Empty>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ history

interface HistoryRow { id: string; feature: string; subjectType: string | null; subjectId: string | null; provider: string; model: string; summary: string; latencyMs: number; createdAt: string; outcome: string | null }
interface Usage { days: number; people: number; features: { feature: string; total: number; accepted: number; edited: number; rejected: number; avgMs: number; acceptanceRate: number | null }[] }

function HistoryTab({ showUsage }: { showUsage: boolean }) {
  const { t, language } = usePrefs();
  const { openConversation } = useAssistant();
  const history = useApi<HistoryRow[]>('/api/ai/history');
  const chats = useApi<{ id: string; startedAt: string; lastAt: string; messages: number; firstQuestion: string | null }[]>('/api/ai/chat/conversations');
  const usage = useApi<Usage>(showUsage ? '/api/ai/usage' : null);
  return (
    <div className="split">
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <Panel title={t('Uw voorstellen van de assistent', 'Your suggestions from the assistant')} flush>
          {!history.data ? (
            <Loading />
          ) : history.data.length === 0 ? (
            <Empty title={t('Nog niets', 'Nothing yet')} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('Wanneer', 'When')}</th>
                    <th>{t('Functie', 'Feature')}</th>
                    <th>{t('Voorstel', 'Suggestion')}</th>
                    <th>{t('Uw besluit', 'Your decision')}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.data.map((h) => (
                    <tr key={h.id}>
                      <td className="nowrap small">{dateTime(h.createdAt, language)}</td>
                      <td className="small">{AI_FEATURE(t, h.feature)}</td>
                      <td className="small">
                        {h.subjectType && h.subjectId ? <Link to={h.subjectType === 'DOSSIER' ? `/zaken/${h.subjectId}` : `/post/${h.subjectId}`}>{h.summary}</Link> : h.summary}
                        <div className="xs faint">
                          {h.provider === 'builtin' ? t('ingebouwd', 'built-in') : h.model}, {h.latencyMs} ms
                        </div>
                      </td>
                      <td>{h.outcome ? <Badge tone={OUTCOME[h.outcome]?.[2] ?? 'neutral'}>{t(OUTCOME[h.outcome]?.[0] ?? h.outcome, OUTCOME[h.outcome]?.[1] ?? h.outcome)}</Badge> : <span className="xs muted">{t('alleen bekeken', 'only viewed')}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <Panel title={t('Uw gesprekken', 'Your conversations')} flush>
          {(chats.data ?? []).length === 0 ? (
            <p className="small muted" style={{ padding: '4px 20px 14px' }}>
              {t('Nog geen gesprekken.', 'No conversations yet.')}
            </p>
          ) : (
            <ul className="list">
              {chats.data!.map((c) => (
                <li key={c.id}>
                  <button type="button" className="list-link" onClick={() => openConversation(c.id)}>
                    <MessagesSquare size={17} style={{ marginTop: 2, color: 'var(--assist)', flex: 'none' }} aria-hidden="true" />
                    <span className="grow stack" style={{ gap: 2, textAlign: 'left' }}>
                      <span className="list-title">{c.firstQuestion ?? t('Gesprek', 'Conversation')}</span>
                      <span className="xs muted">
                        {t(`${c.messages} berichten`, `${c.messages} messages`)}, {ago(c.lastAt, language)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        {showUsage && usage.data && (
          <Panel title={t(`Gebruik in het ministerie (${usage.data.days} dagen)`, `Use across the ministry (${usage.data.days} days)`)}>
            <p className="small muted" style={{ marginTop: 0 }}>
              {t(`${usage.data.people} medewerkers gebruikten de assistent.`, `${usage.data.people} people used the assistant.`)}
            </p>
            <HBars title={t('Aantal voorstellen per functie', 'Number of suggestions per feature')} rows={usage.data.features.map((f) => ({ label: AI_FEATURE(t, f.feature), value: f.total }))} />
            {(() => {
              const answered = usage.data.features.reduce((n, f) => n + f.accepted + f.edited + f.rejected, 0);
              const taken = usage.data.features.reduce((n, f) => n + f.accepted + f.edited, 0);
              return (
                <p className="small" style={{ margin: '12px 0 0' }}>
                  {answered === 0
                    ? t('Nog geen voorstellen overgenomen of afgewezen; de meeste voorstellen worden alleen bekeken.', 'No suggestions accepted or rejected yet; most suggestions are only viewed.')
                    : t(`Van de ${answered} voorstellen waarop iemand reageerde, zijn er ${taken} overgenomen (${Math.round((taken / answered) * 100)}%).`, `Of the ${answered} suggestions someone responded to, ${taken} were accepted (${Math.round((taken / answered) * 100)}%).`)}
                </p>
              );
            })()}
          </Panel>
        )}
      </div>
    </div>
  );
}
