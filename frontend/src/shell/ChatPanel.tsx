import { ExternalLink, MessageSquarePlus, Send, Sparkles, X } from 'lucide-react';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { date } from '../lib/format';
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

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  cards?: Card[];
  suggestions?: string[];
  pending?: { kind: string; interactionId: string } | null;
  intent?: string;
  interactionId?: string;
}

/**
 * The assistant, on every page. It answers from what the system holds and
 * what the person may see; whatever it proposes waits for their confirmation.
 */
export function ChatPanel({ onClose }: { onClose: () => void }) {
  const { t, language } = usePrefs();
  const { context, setContext, prompt, clearPrompt, resume, clearResume } = useAssistant();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useContextFor, setUseContextFor] = useState(true);
  const log = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' });
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

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput('');
    setError(null);
    setMessages((m) => [...m, { id: `u-${Date.now()}`, role: 'user', content: message }]);
    setBusy(true);
    try {
      const r = await api.post<{ conversationId: string; message: Message }>('/api/ai/chat', {
        ...(conversationId ? { conversationId } : {}),
        message,
        language,
        context: context && useContextFor ? { type: context.type, id: context.id } : null,
      });
      setConversationId(r.conversationId);
      setMessages((m) => [...m, r.message]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  const starters = language === 'en'
    ? ['What is waiting for me today?', 'Which matters are at risk of missing their deadline?', 'How many letters came in this week?', 'How do I submit a matter for approval?']
    : ['Wat staat er vandaag voor mij klaar?', 'Welke zaken lopen risico op termijnoverschrijding?', 'Hoeveel brieven kwamen deze week binnen?', 'Hoe bied ik een zaak ter goedkeuring aan?'];

  return (
    <section className="chat" role="dialog" aria-label={t('Assistent', 'Assistant')}>
      <div className="chat-head">
        <Sparkles size={20} style={{ color: 'var(--assist)' }} aria-hidden="true" />
        <div className="grow">
          <div className="title">{t('Assistent', 'Assistant')}</div>
          <div className="xs muted">{t('Gratis en op de eigen server. Ziet alleen wat u mag zien.', 'Free and on the ministry’s own server. Sees only what you may see.')}</div>
        </div>
        <button type="button" className="icon-btn" title={t('Nieuw gesprek', 'New conversation')} aria-label={t('Nieuw gesprek', 'New conversation')} onClick={() => (setMessages([]), setConversationId(null))}>
          <MessageSquarePlus size={19} />
        </button>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t('Assistent sluiten', 'Close assistant')}>
          <X size={20} />
        </button>
      </div>
      <div className="chat-log" ref={log} aria-live="polite">
        {messages.length === 0 && (
          <div className="msg assistant">
            {t(
              'Goedendag. Ik kan vertellen wat er voor u klaarstaat, brieven en zaken zoeken, een zaak samenvatten, een conceptantwoord maken, termijnrisico’s tonen, een taak voor u klaarzetten en uitleggen hoe het systeem werkt.',
              'Good day. I can tell you what is waiting for you, find letters and matters, summarise a matter, draft a reply, show deadline risks, prepare a task for you and explain how the system works.',
            )}
            <div className="chips" style={{ marginTop: 10 }}>
              {starters.map((s) => (
                <button key={s} type="button" className="chip-btn" onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <MessageView key={m.id} m={m} last={i === messages.length - 1} onSuggest={(s) => void send(s)} />
        ))}
        {busy && (
          <div className="msg assistant" aria-label={t('De assistent denkt na', 'The assistant is thinking')}>
            <span className="typing">
              <span />
              <span />
              <span />
            </span>
          </div>
        )}
        {error && <div className="notice danger small">{error}</div>}
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
        <form onSubmit={submit}>
          <textarea
            ref={inputRef}
            className="textarea"
            style={{ minHeight: 44, height: 44 }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder={t('Stel een vraag of geef een opdracht…', 'Ask a question or give an instruction…')}
            aria-label={t('Bericht aan de assistent', 'Message to the assistant')}
          />
          <button type="submit" className="btn assist solid" disabled={busy || !input.trim()} aria-label={t('Versturen', 'Send')}>
            <Send size={18} />
          </button>
        </form>
      </div>
    </section>
  );
}

function MessageView({ m, last, onSuggest }: { m: Message; last: boolean; onSuggest: (s: string) => void }) {
  if (m.role === 'user') return <div className="msg user">{m.content}</div>;
  return (
    <div className="msg assistant">
      {m.content}
      {m.cards && m.cards.length > 0 && (
        <div className="msg-cards">
          {m.cards.map((c, i) => (
            <CardView key={i} card={c} interactionId={m.pending?.interactionId ?? m.interactionId ?? ''} />
          ))}
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

function CardView({ card, interactionId }: { card: Card; interactionId: string }) {
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
  if (card.kind === 'SUMMARY') {
    return (
      <div className="mini-card">
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
