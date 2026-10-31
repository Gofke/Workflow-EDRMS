import { ExternalLink, History, MessageSquarePlus, Send, ShieldCheck, Sparkles, Square, WifiOff, X } from 'lucide-react';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ApiError, api, errorText } from '../lib/api';
import { date } from '../lib/format';
import { Markdown } from '../lib/markdown';
import { usePrefs } from '../lib/prefs';
import { Badge, Stamp } from '../ui';
import { PersonSelect } from '../ui/people';
import { useAssistant } from './context';

interface Row {
  type: string;
  id: string;
  identity: string | null;
  title: string;
  meta: string;
  date: string | null;
  link: string;
}

interface Card {
  kind: string;
  title: string;
  rows?: Row[];
  count?: number;
  bullets?: string[];
  keySentences?: { text: string; source: string }[];
  link?: string;
  body?: string;
  itemId?: string;
  articles?: { id: string; title: string; link: string }[];
  dossiers?: { dossierId: string; dossierIdentity: string; subject: string; level: string; reasons: string[] }[];
  letters?: { itemId: string; registrationIdentity: string; subject: string; reasons: string[] }[];
  proposals?: { title: string; assignee: { accountId: string; name: string } | null; dueDate: string | null; priority: string; original: string }[];
  task?: { title: string; assigneeAccountId: string; assigneeName: string; dueDate: string | null; priority: string; dossierId: string | null; dossierIdentity: string | null };
  dossierId?: string | null;
  sourceInteractionId?: string;
}

interface Engine {
  provider: string;
  model: string;
  offline: boolean;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  cards?: Card[];
  suggestions?: string[];
  pending?: { kind: string; interactionId: string } | null;
  intent?: string;
  interactionId?: string;
  toolsUsed?: string[];
  engine?: Engine;
  notice?: string | null;
  failed?: boolean;
}

interface Status {
  enabled: boolean;
  provider: string;
  model: string;
  offline: boolean;
  external: boolean;
  tier: 'free' | 'paid';
  dataPolicy: 'metadata' | 'records';
  hourlyLimit: number;
  usedThisHour: number;
  limits: { question: number; historyTurns: number };
  examples: string[];
}

interface Answer {
  answer: string;
  toolsUsed: string[];
  cards: Card[];
  suggestions: string[];
  conversationId: string;
  messageId: string;
  engine: Engine;
  notice: string | null;
  pending: { kind: string; interactionId: string } | null;
}

const TOOL_LABEL: Record<string, [string, string]> = {
  help_articles: ['help', 'help'],
  my_work: ['mijn werk', 'my work'],
  find_record: ['opzoeken', 'look-up'],
  list_records: ['lijst', 'list'],
  count_records: ['telling', 'count'],
  deadline_risk: ['termijnrisico', 'deadline risk'],
  org_structure: ['organisatie', 'organisation'],
  summarise_record: ['samenvatting', 'summary'],
  draft_reply: ['conceptantwoord', 'draft reply'],
  retention_overview: ['bewaartermijnen', 'retention'],
  audit_overview: ['audit', 'audit'],
  system_status: ['systeemstatus', 'system status'],
};

const PROVIDER: Record<string, string> = { gemini: 'Gemini', anthropic: 'Claude', 'openai-compatible': 'Model', ollama: 'Ollama' };

/** The page the person has open, without a record id when they chose to leave it out. */
function pageOf(pathname: string, withRecord: boolean): string {
  return withRecord ? pathname : pathname.replace(/\/[0-9a-f-]{36}.*$/i, '');
}

/**
 * The assistant, on every page: a chat like ChatGPT, docked on the right. It
 * answers from what the system holds and only within what the person may see —
 * that is enforced on the server, not here. Answers render as safe Markdown.
 */
export function ChatPanel({ onClose }: { onClose: () => void }) {
  const { t, language } = usePrefs();
  const location = useLocation();
  const { context, setContext, prompt, clearPrompt, resume, clearResume } = useAssistant();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [useContextFor, setUseContextFor] = useState(true);
  const log = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stopper = useRef<AbortController | null>(null);
  /** Increases with every new chat, so a late answer never lands in the next conversation. */
  const generation = useRef(0);

  const loadStatus = () =>
    api
      .get<{ data: Status }>(`/api/v1/ai/status?lang=${language}`)
      .then((r) => setStatus(r.data))
      .catch(() => setStatus(null));

  useEffect(() => {
    void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);
  useEffect(() => {
    inputRef.current?.focus();
    // Closing the panel stops a question in progress; changing the language does not.
    return () => stopper.current?.abort();
  }, []);
  // Like a chat app: while waiting, show the newest; when an answer arrives,
  // show it from its start, with the question above it.
  useEffect(() => {
    const el = log.current;
    if (!el) return;
    const last = messages[messages.length - 1];
    if (!busy && last?.role === 'assistant') {
      const questions = el.querySelectorAll<HTMLElement>('.msg.user');
      const q = questions[questions.length - 1];
      if (q) {
        el.scrollTo({ top: Math.max(q.offsetTop - 8, 0), behavior: 'smooth' });
        return;
      }
    }
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);
  useEffect(() => {
    if (prompt) {
      clearPrompt();
      void send(prompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt]);
  useEffect(() => setUseContextFor(true), [context?.id]);
  useEffect(() => {
    if (!resume) return;
    clearResume();
    setError(null);
    api
      .get<Message[]>(`/api/ai/chat/conversations/${resume}`)
      .then((rows) => {
        setMessages(rows);
        setConversationId(resume);
      })
      .catch((e) => setError(errorText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume]);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  /** What the model may see of the conversation: the person's turns and the model's own answers. */
  function historyFor(list: Message[]) {
    return list
      .filter((m) => !m.failed && (m.role === 'user' || (m.engine && !m.engine.offline)))
      .slice(-30)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
  }

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    const limit = status?.limits.question ?? 2000;
    if (question.length > limit) {
      setError(t(`De vraag is te lang (${question.length} tekens). Houd het onder de ${limit}.`, `The question is too long (${question.length} characters). Keep it under ${limit}.`));
      return;
    }
    setInput('');
    setError(null);
    const before = messages;
    setMessages((m) => [...m, { id: `u-${Date.now()}`, role: 'user', content: question }]);
    setBusy(true);
    const stop = new AbortController();
    stopper.current = stop;
    const gen = generation.current;
    try {
      const response = await fetch('/api/v1/ai/query', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Accept-Language': language },
        body: JSON.stringify({
          question,
          history: historyFor(before),
          lang: language,
          page: pageOf(location.pathname, Boolean(context) && useContextFor),
          ...(conversationId ? { conversationId } : {}),
        }),
        signal: stop.signal,
      });
      const body = (await response.json().catch(() => null)) as { success?: boolean; message?: string; reason?: string; data?: Answer } | null;
      if (response.status === 401) window.dispatchEvent(new CustomEvent('juspol:signed-out'));
      if (!response.ok || !body?.success || !body.data) throw new ApiError(response.status, body?.message ?? t('Er ging iets mis. Probeer het opnieuw.', 'Something went wrong. Try again.'), body);
      const a = body.data;
      if (gen !== generation.current) return;
      setConversationId(a.conversationId);
      setMessages((m) => [
        ...m,
        { id: a.messageId, role: 'assistant', content: a.answer, cards: a.cards, suggestions: a.suggestions, toolsUsed: a.toolsUsed, engine: a.engine, notice: a.notice, pending: a.pending, intent: 'assistant' },
      ]);
    } catch (e) {
      if (gen !== generation.current) return;
      if ((e as Error).name === 'AbortError') {
        // The stopped question is not sent again as history.
        setMessages((m) => [...m.map((x, i) => (i === m.length - 1 && x.role === 'user' ? { ...x, failed: true } : x)), { id: `s-${Date.now()}`, role: 'assistant', content: t('Gestopt.', 'Stopped.'), failed: true }]);
      } else {
        setMessages((m) => m.map((x, i) => (i === m.length - 1 ? { ...x, failed: true } : x)));
        setError(errorText(e));
      }
    } finally {
      stopper.current = null;
      setBusy(false);
      void loadStatus();
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  const newChat = () => {
    generation.current += 1;
    stopper.current?.abort();
    setBusy(false);
    setMessages([]);
    setConversationId(null);
    setError(null);
    inputRef.current?.focus();
  };

  const examples = status?.examples?.length
    ? status.examples
    : language === 'en'
      ? ['What is waiting for me today?', 'Which matters are at risk of missing their deadline?', 'How many letters came in this week?', 'How do I register a letter?']
      : ['Wat staat er vandaag voor mij klaar?', 'Welke zaken lopen risico op termijnoverschrijding?', 'Hoeveel brieven kwamen deze week binnen?', 'Hoe registreer ik een brief?'];
  const offline = !status || status.offline;
  const left = status ? Math.max(status.hourlyLimit - status.usedThisHour, 0) : null;

  return (
    <aside className="chat chat-docked" role="dialog" aria-label={t('Assistent', 'Assistant')}>
      <div className="chat-head">
        <span className="chat-avatar" aria-hidden="true">
          <Sparkles size={20} />
        </span>
        <div className="grow">
          <div className="title">{t('Vraag de assistent', 'Ask the assistant')}</div>
          <div className="xs muted">{t('Ziet alleen wat u mag zien, binnen uw lijn.', 'Sees only what you may see, within your line.')}</div>
        </div>
        <Link to="/assistent?tab=geschiedenis" className="icon-btn" title={t('Eerdere gesprekken', 'Earlier conversations')} aria-label={t('Eerdere gesprekken', 'Earlier conversations')}>
          <History size={19} />
        </Link>
        <button type="button" className="icon-btn" title={t('Nieuw gesprek', 'New chat')} aria-label={t('Nieuw gesprek', 'New chat')} onClick={newChat}>
          <MessageSquarePlus size={19} />
        </button>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t('Assistent sluiten', 'Close assistant')}>
          <X size={20} />
        </button>
      </div>
      <div className="chat-model" aria-live="polite">
        {status && !status.enabled ? (
          <span className="model-badge off">{t('Uitgezet door de beheerder', 'Switched off by the administrator')}</span>
        ) : offline ? (
          <span className="model-badge offline" title={t('Antwoordt op de eigen server, zonder taalmodel.', 'Answers on the ministry server, without a language model.')}>
            <WifiOff size={14} aria-hidden="true" /> {t('Ingebouwde assistent, offline', 'Built-in assistant, offline')}
          </span>
        ) : (
          <span className="model-badge online" title={status?.model}>
            <span className="dot" aria-hidden="true" /> {PROVIDER[status!.provider] ?? status!.provider} <span className="model-name">{status!.model}</span>
          </span>
        )}
        {left !== null && status?.enabled && !offline && (
          <span className={`xs ${left <= 3 ? 'warn-text' : 'muted'}`}>
            {t(`nog ${left} van ${status.hourlyLimit} vragen dit uur`, `${left} of ${status.hourlyLimit} questions left this hour`)}
          </span>
        )}
      </div>
      <div className="chat-log" ref={log}>
        {messages.length === 0 && (
          <div className="chat-welcome">
            <p className="strong">{t('Goedendag. Waarmee kan ik u helpen?', 'Good day. How can I help?')}</p>
            <p className="small muted">
              {t(
                'Vraag naar uw werk, zaken, brieven en taken, termijnen en aantallen, wie wat behandelt, of hoe iets werkt in het systeem.',
                'Ask about your work, matters, letters and tasks, deadlines and counts, who handles what, or how something works in the system.',
              )}
            </p>
            {status?.external && status.dataPolicy === 'metadata' && (
              <div className="privacy-note small">
                <ShieldCheck size={16} aria-hidden="true" />
                <span>
                  {t(
                    'Gratis Gemini: naar Google gaan alleen kenmerken zoals nummers, status, data en namen van eenheden en behandelaars. Onderwerpen, documenten en vertrouwelijke stukken blijven op de server. Typ geen persoonsgegevens.',
                    'Free Gemini: only attributes such as numbers, statuses, dates and names of units and handlers go to Google. Subjects, documents and confidential records stay on the server. Do not type personal details.',
                  )}
                </span>
              </div>
            )}
            <div className="chips examples">
              {examples.map((s) => (
                <button key={s} type="button" className="chip-btn" onClick={() => void send(s)} disabled={busy || (status ? !status.enabled : false)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <MessageView key={m.id} m={m} last={i === messages.length - 1 && !busy} onSuggest={(s) => void send(s)} />
        ))}
        {busy && (
          <div className="msg assistant thinking" aria-label={t('De assistent denkt na', 'The assistant is thinking')}>
            <span className="typing" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="xs muted">{t('Zoekt het uit…', 'Looking it up…')}</span>
          </div>
        )}
        {error && (
          <div className="notice danger small" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="chat-foot">
        {context && (
          <label className="check small">
            <input type="checkbox" checked={useContextFor} onChange={(e) => setUseContextFor(e.target.checked)} />
            <span>
              {t('Over', 'About')} <strong>{context.label}</strong>
            </span>
            <button type="button" className="btn link small" onClick={() => setContext(null)}>
              {t('loslaten', 'detach')}
            </button>
          </label>
        )}
        <form onSubmit={submit} className="chat-input">
          <textarea
            ref={inputRef}
            className="textarea"
            rows={1}
            maxLength={(status?.limits.question ?? 2000) + 200}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder={t('Vraag wat u wilt…', 'Ask anything…')}
            aria-label={t('Vraag aan de assistent', 'Question to the assistant')}
            disabled={status ? !status.enabled : false}
          />
          {busy ? (
            <button type="button" className="btn danger solid" onClick={() => stopper.current?.abort()} aria-label={t('Stoppen', 'Stop')} title={t('Stoppen', 'Stop')}>
              <Square size={16} />
            </button>
          ) : (
            <button type="submit" className="btn assist solid" disabled={!input.trim() || (status ? !status.enabled : false)} aria-label={t('Versturen', 'Send')} title={t('Versturen', 'Send')}>
              <Send size={18} />
            </button>
          )}
        </form>
        <div className="xs muted chat-disclaimer">
          {input.length > 1800 ? (
            <span className={input.length > (status?.limits.question ?? 2000) ? 'danger-text' : ''}>
              {input.length} / {status?.limits.question ?? 2000}
            </span>
          ) : (
            t('De assistent kan zich vergissen. Controleer belangrijke gegevens in het dossier.', 'The assistant can make mistakes. Check important details in the record.')
          )}
        </div>
      </div>
    </aside>
  );
}

function MessageView({ m, last, onSuggest }: { m: Message; last: boolean; onSuggest: (s: string) => void }) {
  const { t, language } = usePrefs();
  if (m.role === 'user') return <div className={`msg user${m.failed ? ' failed' : ''}`}>{m.content}</div>;
  const tools = (m.toolsUsed ?? []).map((x) => TOOL_LABEL[x]?.[language === 'en' ? 1 : 0] ?? x);
  return (
    <div className={`msg assistant${m.failed ? ' failed' : ''}`}>
      {m.notice && <div className="msg-notice xs">{m.notice}</div>}
      {m.engine && !m.engine.offline ? <Markdown text={m.content} /> : <div className="pre-line">{m.content}</div>}
      {m.cards && m.cards.length > 0 && (
        <div className="msg-cards">
          {m.cards.map((c, i) => (
            <CardView key={i} card={c} interactionId={m.pending?.interactionId ?? m.interactionId ?? ''} full={Boolean(m.engine && !m.engine.offline)} />
          ))}
        </div>
      )}
      {(tools.length > 0 || m.engine) && (
        <div className="msg-meta xs muted">
          {m.engine?.offline ? t('Ingebouwde assistent', 'Built-in assistant') : m.engine ? `${PROVIDER[m.engine.provider] ?? m.engine.provider}` : ''}
          {tools.length > 0 && `${m.engine ? ', ' : ''}${t('gebruikt', 'used')}: ${tools.join(', ')}`}
        </div>
      )}
      {last && m.suggestions && m.suggestions.length > 0 && (
        <div className="chips" style={{ marginTop: 10 }}>
          {m.suggestions.map((s) => (
            <button key={s} type="button" className="chip-btn" onClick={() => onSuggest(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** `full`: the answer text came from the model, which never saw the details, so the card carries them. */
function CardView({ card, interactionId, full = false }: { card: Card; interactionId: string; full?: boolean }) {
  const { t, language } = usePrefs();
  if (card.kind === 'LIST' && card.rows) {
    return (
      <div className="mini-card">
        <div className="small strong">{card.title}</div>
        <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0' }} className="stack">
          {card.rows.slice(0, 8).map((r) => (
            <li key={r.id} className="stack" style={{ gap: 2 }}>
              <Link to={r.link} className="strong" style={{ color: 'var(--text)' }}>
                {r.identity && <Stamp value={r.identity} />} {r.title}
              </Link>
              <span className="xs muted">
                {r.meta}
                {r.date ? `${/^(termijn|due)$/.test(r.meta ?? '') ? ' ' : ' — '}${date(r.date, language)}` : ''}
              </span>
            </li>
          ))}
        </ul>
        {card.count && card.count > 8 ? <div className="xs muted" style={{ marginTop: 6 }}>{t(`En nog ${card.count - 8}.`, `And ${card.count - 8} more.`)}</div> : null}
      </div>
    );
  }
  if (card.kind === 'NOTE') {
    return (
      <div className="mini-card note-card small" role="note">
        <ShieldCheck size={15} aria-hidden="true" />
        <span>
          <strong>{card.title}</strong> {card.body}
        </span>
      </div>
    );
  }
  if (card.kind === 'SUMMARY') {
    return (
      <div className="mini-card">
        {full && (
          <>
            <div className="small strong">{card.title}</div>
            {card.bullets && card.bullets.length > 0 && (
              <ul>
                {card.bullets.map((b) => (
                  <li key={b} className="small">
                    {b}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {card.keySentences && card.keySentences.length > 0 && (
          <>
            <div className="small strong">{t('Uit de stukken', 'From the records')}</div>
            <ul>
              {card.keySentences.slice(0, 3).map((k) => (
                <li key={k.text} className="small">
                  “{k.text}” <span className="faint">({k.source})</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {card.link && (
          <Link to={card.link} className="small">
            <ExternalLink size={13} /> {t('Openen', 'Open')}
          </Link>
        )}
      </div>
    );
  }
  if (card.kind === 'DRAFT') {
    return (
      <div className="mini-card">
        <div className="small strong">{card.title}</div>
        <div className="small pre" style={{ maxHeight: 220, overflowY: 'auto', marginTop: 6 }}>
          {card.body}
        </div>
        {card.link && (
          <Link to={`${card.link}?tab=antwoord`} className="small">
            {t('Openen bij de brief', 'Open with the letter')}
          </Link>
        )}
      </div>
    );
  }
  if (card.kind === 'HELP') {
    return (
      <div className="mini-card small">
        {card.link && (
          <Link to={card.link}>
            <ExternalLink size={13} /> {t('Naar dit scherm', 'Go to this screen')}
          </Link>
        )}
        {card.articles && card.articles.length > 0 && (
          <div style={{ marginTop: 4 }}>
            {t('Zie ook:', 'See also:')}{' '}
            {card.articles.map((a, i) => (
              <span key={a.id}>
                {i > 0 && ', '}
                <Link to={`/help#${a.id}`}>{a.title}</Link>
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (card.kind === 'RISK') {
    return (
      <div className="mini-card">
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} className="stack">
          {(card.dossiers ?? []).map((d) => (
            <li key={d.dossierId} className="stack" style={{ gap: 2 }}>
              <span>
                <Badge tone={d.level === 'HIGH' ? 'danger' : 'warn'}>{d.level === 'HIGH' ? t('Hoog', 'High') : t('Middel', 'Medium')}</Badge>{' '}
                <Link to={`/zaken/${d.dossierId}`} className="strong" style={{ color: 'var(--text)' }}>
                  {d.subject}
                </Link>
              </span>
              <span className="xs muted">{d.reasons.join('; ')}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (card.kind === 'TASK_PROPOSAL' && card.task) return <TaskProposal card={card} interactionId={interactionId} />;
  if (card.kind === 'NOTES' && card.proposals) return <NotesProposal card={card} interactionId={card.sourceInteractionId ?? interactionId} />;
  if (card.kind === 'TRANSLATION') return <div className="mini-card small pre">{card.body}</div>;
  return null;
}

function TaskProposal({ card, interactionId }: { card: Card; interactionId: string }) {
  const { t } = usePrefs();
  const task = card.task!;
  const [title, setTitle] = useState(task.title);
  const [assignee, setAssignee] = useState(task.assigneeAccountId);
  const [due, setDue] = useState(task.dueDate ?? '');
  const [state, setState] = useState<'open' | 'busy' | 'done' | 'rejected'>('open');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; reference: string } | null>(null);

  const decide = async (accept: boolean) => {
    setState('busy');
    setError(null);
    try {
      const edited = title !== task.title || assignee !== task.assigneeAccountId || (due || null) !== task.dueDate;
      const r = await api.post<{ applied: { tasks?: { id: string; reference: string }[] } }>(`/api/ai/interactions/${interactionId}/feedback`, accept
        ? { outcome: edited ? 'EDITED' : 'ACCEPTED', apply: { tasks: [{ title, assigneeAccountId: assignee, dueDate: due || null, priority: task.priority, dossierId: task.dossierId }] } }
        : { outcome: 'REJECTED' });
      setCreated(r.applied.tasks?.[0] ?? null);
      setState(accept ? 'done' : 'rejected');
      window.dispatchEvent(new CustomEvent('juspol:changed'));
    } catch (e) {
      setError(errorText(e));
      setState('open');
    }
  };

  if (state === 'done') {
    return (
      <div className="mini-card small">
        {t('Taak aangemaakt:', 'Task created:')} {created && <Link to={`/taken/${created.id}`}>{created.reference}</Link>}
      </div>
    );
  }
  if (state === 'rejected') return <div className="mini-card small muted">{t('Voorstel afgewezen. Er is niets aangemaakt.', 'Proposal declined. Nothing was created.')}</div>;
  return (
    <div className="proposal" style={{ whiteSpace: 'normal' }}>
      <div className="proposal-head">
        <Sparkles size={15} /> {t('Voorgestelde taak', 'Proposed task')}
      </div>
      <div className="proposal-body stack" style={{ gap: 8 }}>
        <label className="field small">
          {t('Titel', 'Title')}
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field small">
          {t('Voor', 'For')}
          <PersonSelect value={assignee} onChange={setAssignee} />
        </label>
        <label className="field small">
          {t('Termijn', 'Due date')}
          <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        {task.dossierIdentity && <span className="xs muted">{t('Bij zaak', 'For matter')} {task.dossierIdentity}</span>}
        {error && <span className="small" style={{ color: 'var(--danger)' }}>{error}</span>}
        <div className="row">
          <button type="button" className="btn sm assist solid" disabled={state === 'busy' || !title.trim() || !assignee} onClick={() => void decide(true)}>
            {t('Taak aanmaken', 'Create task')}
          </button>
          <button type="button" className="btn sm" disabled={state === 'busy'} onClick={() => void decide(false)}>
            {t('Niet nodig', 'Not needed')}
          </button>
        </div>
      </div>
    </div>
  );
}

function NotesProposal({ card, interactionId }: { card: Card; interactionId: string }) {
  const { t, language } = usePrefs();
  const proposals = card.proposals ?? [];
  const [chosen, setChosen] = useState<boolean[]>(proposals.map((p) => Boolean(p.assignee)));
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    try {
      const tasks = proposals
        .filter((p, i) => chosen[i] && p.assignee)
        .map((p) => ({ title: p.title, assigneeAccountId: p.assignee!.accountId, dueDate: p.dueDate, priority: p.priority, dossierId: card.dossierId ?? null }));
      const r = await api.post<{ applied: { tasks?: unknown[] } }>(`/api/ai/interactions/${interactionId}/feedback`, { outcome: tasks.length === proposals.length ? 'ACCEPTED' : 'EDITED', apply: { tasks } });
      setDone(r.applied.tasks?.length ?? 0);
      window.dispatchEvent(new CustomEvent('juspol:changed'));
    } catch (e) {
      setError(errorText(e));
    }
  };
  if (done !== null) return <div className="mini-card small">{t(`${done} taken aangemaakt.`, `${done} tasks created.`)}</div>;
  return (
    <div className="proposal" style={{ whiteSpace: 'normal' }}>
      <div className="proposal-head">
        <Sparkles size={15} /> {card.title}
      </div>
      <div className="proposal-body stack" style={{ gap: 6 }}>
        {proposals.map((p, i) => (
          <label key={i} className="check small" style={{ alignItems: 'flex-start' }}>
            <input type="checkbox" checked={chosen[i]} disabled={!p.assignee} onChange={(e) => setChosen((c) => c.map((x, j) => (j === i ? e.target.checked : x)))} />
            <span>
              <strong>{p.title}</strong>
              <br />
              <span className="muted">
                {p.assignee?.name ?? t('geen persoon herkend', 'no person recognised')}
                {p.dueDate ? `, ${date(p.dueDate, language)}` : ''}
              </span>
            </span>
          </label>
        ))}
        {error && <span className="small" style={{ color: 'var(--danger)' }}>{error}</span>}
        <button type="button" className="btn sm assist solid" onClick={() => void create()} disabled={!chosen.some(Boolean)}>
          {t('Aangevinkte taken aanmaken', 'Create ticked tasks')}
        </button>
      </div>
    </div>
  );
}
