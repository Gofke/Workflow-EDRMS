import { Bookmark, FileText, FolderOpen, Inbox, ListChecks, Search, Sparkles, Trash2 } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { date } from '../lib/format';
import { useApi } from '../lib/hooks';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { Badge, Empty, EngineInfo, ErrorNote, Field, Loading, PageHead, Panel, Proposal, Stamp, usePager, useToast } from '../ui';

interface Hit {
  type: 'ITEM' | 'DOSSIER' | 'TASK' | 'DOCUMENT';
  id: string;
  identity: string | null;
  title: string;
  snippet: string | null;
  date: string | null;
  meta: Record<string, string | null>;
  link: string;
}

const ICONS = { ITEM: Inbox, DOSSIER: FolderOpen, TASK: ListChecks, DOCUMENT: FileText };

/** «word» marks a match in a snippet from a document's text. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/«|»/);
  return (
    <span className="small muted">
      {parts.map((p, i) => (i % 2 ? <mark key={i} style={{ background: 'var(--gold-soft)', color: 'var(--text)', padding: '0 2px' }}>{p}</mark> : <span key={i}>{p}</span>))}
    </span>
  );
}

export default function SearchPage() {
  const { t, language } = usePrefs();
  const { ai } = useSession();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [types, setTypes] = useState<string[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [party, setParty] = useState('');
  const [classification, setClassification] = useState('');
  const [result, setResult] = useState<{ hits: Hit[]; counts: Record<string, number> } | null>(null);
  const { page: hitRows, pager } = usePager(result?.hits ?? []);
  const [answer, setAnswer] = useState<{ answer: string; understood: string[]; count: number; rows: { id: string; identity: string | null; title: string; meta: string; date: string | null; link: string; type: string }[]; engine: EngineInfo } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveName, setSaveName] = useState<string | null>(null);
  const saved = useApi<{ id: string; name: string; query: Record<string, string> }[]>('/api/search/saved');

  const run = async (query = q) => {
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const p = new URLSearchParams({ ...(query.trim() ? { q: query.trim() } : {}), ...(types.length ? { types: types.join(',') } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(party.trim() ? { party: party.trim() } : {}), ...(classification ? { classification } : {}), limit: '50' });
      setResult(await api.get(`/api/search?${p.toString()}`));
      setParams(query.trim() ? { q: query.trim() } : {}, { replace: true });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const askQuestion = async () => {
    setBusy(true);
    setError(null);
    try {
      setAnswer(await api.post('/api/ai/ask', { question: q, language }));
      setResult(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (params.get('q')) void run(params.get('q')!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const looksLikeQuestion = /\?$|^(hoeveel|welke|wat|toon|laat|how many|which|show|what)\b/i.test(q.trim());
    if (ai('ask') && looksLikeQuestion) void askQuestion();
    else void run();
  };
  const toggle = (type: string) => setTypes((ts) => (ts.includes(type) ? ts.filter((x) => x !== type) : [...ts, type]));

  return (
    <>
      <PageHead title={t('Zoeken', 'Search')} lead={t('In brieven, zaken, taken en de tekst van documenten — ook gescande. U vindt alleen wat u mag zien. Stel ook een vraag in gewone taal: “Welke brieven van de Politie kwamen deze maand binnen?”', 'In letters, matters, tasks and the text of documents — scanned ones too. You only find what you may see. You can also ask in plain language: “Which letters from the Police came in this month?”')} />
      <div className="split">
        <div className="stack">
          <form onSubmit={submit} className="row">
            <div className="topbar-search grow" style={{ maxWidth: 'none' }}>
              <Search size={18} aria-hidden="true" />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Zoekwoorden, een nummer, of een vraag', 'Keywords, a number, or a question')} aria-label={t('Zoeken', 'Search')} autoFocus />
            </div>
            <button type="submit" className="btn primary" disabled={busy}>
              {t('Zoeken', 'Search')}
            </button>
            {ai('ask') && (
              <button type="button" className="btn assist" disabled={busy || !q.trim()} onClick={() => void askQuestion()}>
                <Sparkles size={16} /> {t('Als vraag', 'As a question')}
              </button>
            )}
          </form>
          <div className="row">
            {(['ITEM', 'DOSSIER', 'TASK', 'DOCUMENT'] as const).map((type) => (
              <label key={type} className="check small">
                <input type="checkbox" checked={types.includes(type)} onChange={() => toggle(type)} />
                {{ ITEM: t('Brieven', 'Letters'), DOSSIER: t('Zaken', 'Matters'), TASK: t('Taken', 'Tasks'), DOCUMENT: t('Tekst in documenten', 'Document text') }[type]}
                {result?.counts?.[type] !== undefined && <Badge>{result.counts[type]}</Badge>}
              </label>
            ))}
          </div>
          <ErrorNote error={error} />
          {busy && <Loading />}
          {answer && (
            <Proposal title={t('Antwoord van de assistent', 'Answer from the assistant')} engine={answer.engine}>
              <p>
                <strong>{answer.answer}</strong>
              </p>
              <p className="small muted">
                {t('Zo begreep ik de vraag:', 'This is how I understood the question:')} {answer.understood.join('; ')}
              </p>
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
            </Proposal>
          )}
          {result && (
            <Panel flush>
              {result.hits.length === 0 ? (
                <Empty title={t('Niets gevonden', 'Nothing found')}>{t('Probeer andere woorden of minder filters.', 'Try other words or fewer filters.')}</Empty>
              ) : (
                <ul className="list">
                  {hitRows.map((h) => {
                    const Icon = ICONS[h.type];
                    return (
                      <li key={`${h.type}-${h.id}`}>
                        <Link to={h.link.replace(/^\/records\//, '/post/').replace(/^\/dossiers\//, '/zaken/').replace(/^\/tasks\//, '/taken/')} className="list-link">
                          <Icon size={18} style={{ marginTop: 3, color: 'var(--muted)', flex: 'none' }} aria-hidden="true" />
                          <span className="grow stack" style={{ gap: 3 }}>
                            <span className="row" style={{ gap: 8 }}>
                              {h.identity && <Stamp value={h.identity} />}
                              <span className="list-title">{h.title}</span>
                            </span>
                            {h.snippet && <Snippet text={h.snippet} />}
                            {h.type === 'DOCUMENT' && <span className="xs faint">{t('Gevonden in de gelezen tekst van een document', 'Found in the text read from a document')}</span>}
                          </span>
                          <span className="small muted nowrap">{h.date ? date(h.date, language) : ''}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
              {pager}
            </Panel>
          )}
        </div>
        <div className="stack side-sticky">
          <Panel title={t('Verfijnen', 'Refine')}>
            <div className="stack">
              <Field label={t('Afzender of geadresseerde', 'Sender or addressee')}>
                <input className="input" value={party} onChange={(e) => setParty(e.target.value)} />
              </Field>
              <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <Field label={t('Vanaf', 'From')}>
                  <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </Field>
                <Field label={t('Tot en met', 'Until')}>
                  <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </Field>
              </div>
              <Field label={t('Vertrouwelijkheid', 'Confidentiality')}>
                <select className="select" value={classification} onChange={(e) => setClassification(e.target.value)}>
                  <option value="">{t('Alle', 'All')}</option>
                  <option value="INTERNAL">{t('Intern', 'Internal')}</option>
                  <option value="CONFIDENTIAL">{t('Vertrouwelijk', 'Confidential')}</option>
                </select>
              </Field>
              <div className="row">
                <button type="button" className="btn" onClick={() => void run()}>
                  {t('Toepassen', 'Apply')}
                </button>
                <button type="button" className="btn ghost" disabled={!q.trim() && !party.trim()} onClick={() => setSaveName(q || party)} aria-expanded={saveName !== null}>
                  <Bookmark size={16} /> {t('Bewaren', 'Save')}
                </button>
              </div>
              {saveName !== null && (
                <form
                  className="inline-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!saveName.trim()) return;
                    await api.post('/api/search/saved', { name: saveName.trim(), query: { q, party, from, to, classification, types: types.join(',') } });
                    toast(t('Zoekopdracht bewaard', 'Search saved'));
                    setSaveName(null);
                    void saved.reload();
                  }}
                >
                  <input className="input" autoFocus value={saveName} onChange={(e) => setSaveName(e.target.value)} aria-label={t('Naam voor deze zoekopdracht', 'Name for this search')} placeholder={t('Naam voor deze zoekopdracht', 'Name for this search')} />
                  <button type="submit" className="btn primary" disabled={!saveName.trim()}>
                    {t('Bewaren', 'Save')}
                  </button>
                </form>
              )}
            </div>
          </Panel>
          <Panel title={t('Bewaarde zoekopdrachten', 'Saved searches')} flush>
            <ul className="list">
              {(saved.data ?? []).map((s) => (
                <li key={s.id} className="row between">
                  <button
                    type="button"
                    className="btn link"
                    onClick={() => {
                      setQ(s.query.q ?? '');
                      setParty(s.query.party ?? '');
                      setFrom(s.query.from ?? '');
                      setTo(s.query.to ?? '');
                      setClassification(s.query.classification ?? '');
                      setTypes((s.query.types ?? '').split(',').filter(Boolean));
                      void run(s.query.q ?? '');
                    }}
                  >
                    {s.name}
                  </button>
                  <button type="button" className="icon-btn" aria-label={t('Verwijderen', 'Delete')} onClick={() => void api.del(`/api/search/saved/${s.id}`).then(() => saved.reload())}>
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
              {saved.data?.length === 0 && <li className="small muted">{t('Nog niets bewaard.', 'Nothing saved yet.')}</li>}
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}
