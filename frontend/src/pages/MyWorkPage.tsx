import { Gavel, MessageCircleQuestion, Plus, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { ago, date, longDate } from '../lib/format';
import { useApi } from '../lib/hooks';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { useAssistant } from '../shell/context';
import { Badge, Due, Empty, ErrorNote, Figure, Loading, PageHead, Panel, ProcessingBadge, Proposal, Stamp } from '../ui';
import { TaskRow, TaskView } from '../ui/records';
import { useEffect, useState } from 'react';

interface MyWork {
  today: string;
  summary: {
    openTasks: number;
    overdueTasks: number;
    dueThisWeek: number;
    awaitingMyDecision: number;
    adviceToGive: number;
    responsibleMatters: number;
    overdueMatters: number;
    draftsToRegister: number;
    unreadNotifications: number;
  };
  tasks: TaskView[];
  reviewQueue: { dossierId: string; dossierIdentity: string; subject: string; submittedByName: string; submittedAt: string }[];
  advice: { id: string; question: string; dueDate: string | null; dossierId: string; dossierIdentity: string; subject: string; requestedByName: string }[];
  responsible: { id: string; dossierIdentity: string; subject: string; processingState: string; dueDate: string | null; overdue: boolean }[];
  drafts: { id: string; subject: string; direction: string; party: string | null; source: string; createdAt: string }[];
  standingIn: { id: string; accountName?: string; personName?: string; endsOn: string }[];
}

interface Risk {
  counts: { high: number; medium: number };
  dossiers: { dossierId: string; dossierIdentity: string; subject: string; level: string; reasons: string[]; dueDate: string | null }[];
  letters: { itemId: string; registrationIdentity: string; subject: string; reasons: string[] }[];
  engine: { provider: string; model: string; local: boolean };
}

export default function MyWorkPage() {
  const { t, language } = usePrefs();
  const { user, ai } = useSession();
  const assistant = useAssistant();
  const { data, error, loading } = useApi<MyWork>('/api/my-work');
  const [risk, setRisk] = useState<Risk | null>(null);
  useEffect(() => {
    if (ai('risk')) api.get<Risk>(`/api/ai/risk?language=${language}`).then(setRisk).catch(() => null);
  }, [ai]);

  const hour = (new Date().getUTCHours() + 21) % 24;
  const greeting = hour < 12 ? t('Goedemorgen', 'Good morning') : hour < 18 ? t('Goedemiddag', 'Good afternoon') : t('Goedenavond', 'Good evening');
  const s = data?.summary;
  const weekday = data ? new Date(`${data.today}T12:00:00Z`).toLocaleDateString(language === 'en' ? 'en-GB' : 'nl-NL', { weekday: 'long', timeZone: 'UTC' }) : '';

  return (
    <>
      <PageHead
        title={`${greeting}, ${(user?.personName ?? "").replace(/(\b[A-Z]\.) /g, "$1\u00a0")}`}
        lead={data ? `${weekday} ${longDate(data.today, language)}. ${summarySentence(t, data)}` : undefined}
        actions={
          <>
            <Link to="/post?nieuw=1" className="btn primary">
              <Plus size={18} /> {t('Brief registreren', 'Register a letter')}
            </Link>
            <Link to="/taken?nieuw=1" className="btn">
              <Plus size={18} /> {t('Taak', 'Task')}
            </Link>
          </>
        }
      />
      <ErrorNote error={error} />
      {loading && !data && <Loading lines={6} />}
      {data && s && (
        <div className="stack" style={{ '--gap': '22px' } as React.CSSProperties}>
          <div className="figures" role="list" aria-label={t('Uw werk in getallen', 'Your work in figures')}>
            <Figure value={s.awaitingMyDecision} label={t('wacht op uw besluit', 'await your decision')} to="/goedkeuringen" tone={s.awaitingMyDecision ? 'warn' : undefined} />
            <Figure value={s.overdueTasks} label={t(s.overdueTasks === 1 ? 'taak te laat' : 'taken te laat', s.overdueTasks === 1 ? 'task overdue' : 'tasks overdue')} to="/taken?due=overdue" tone={s.overdueTasks ? 'alert' : undefined} />
            <Figure value={s.dueThisWeek} label={t(s.dueThisWeek === 1 ? 'taak deze week' : 'taken deze week', s.dueThisWeek === 1 ? 'task this week' : 'tasks this week')} to="/taken?due=week" />
            <Figure value={s.adviceToGive} label={t(s.adviceToGive === 1 ? 'advies te geven' : 'adviezen te geven', 'advice to give')} to="/goedkeuringen" />
            <Figure value={s.overdueMatters} label={t(s.overdueMatters === 1 ? 'van uw zaken over termijn' : 'van uw zaken over termijn', 'of your matters overdue')} to="/zaken?mine=1" tone={s.overdueMatters ? 'alert' : undefined} />
            <Figure value={s.draftsToRegister} label={t(s.draftsToRegister === 1 ? 'eigen concept te registreren' : 'eigen concepten te registreren', s.draftsToRegister === 1 ? 'own draft to register' : 'own drafts to register')} to="/post?state=DRAFT" />
          </div>

          <div className="split">
            <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
              {data.reviewQueue.length > 0 && (
                <Panel title={t('Wacht op uw besluit', 'Awaiting your decision')} flush>
                  <ul className="list">
                    {data.reviewQueue.map((r) => (
                      <li key={r.dossierId}>
                        <Link to={`/zaken/${r.dossierId}?tab=besluit`} className="list-link">
                          <Gavel size={18} style={{ marginTop: 3, color: 'var(--warn)', flex: 'none' }} aria-hidden="true" />
                          <span className="grow stack" style={{ gap: 3 }}>
                            <span className="list-title">{r.subject}</span>
                            <span className="meta">
                              <Stamp value={r.dossierIdentity} />
                              <span>
                                {t('aangeboden door', 'submitted by')} {r.submittedByName}, {ago(r.submittedAt, language)}
                              </span>
                            </span>
                          </span>
                          <span className="btn sm">{t('Beoordelen', 'Review')}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Panel>
              )}

              <Panel
                title={t('Mijn taken', 'My tasks')}
                actions={
                  <Link to="/taken" className="btn sm ghost">
                    {t('Alle taken', 'All tasks')}
                  </Link>
                }
                flush
              >
                {data.tasks.length === 0 ? (
                  <Empty title={t('Geen open taken', 'No open tasks')}>{t('Nieuwe taken voor u verschijnen hier.', 'New tasks for you appear here.')}</Empty>
                ) : (
                  <ul className="list">
                    {[...data.tasks]
                      .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'))
                      .slice(0, 10)
                      .map((task) => (
                        <li key={task.id}>
                          <TaskRow task={task} showAssignee={false} />
                        </li>
                      ))}
                  </ul>
                )}
              </Panel>

              {data.drafts.length > 0 && (
                <Panel title={t('Nog te registreren', 'Still to register')} flush>
                  <ul className="list">
                    {data.drafts.map((d) => (
                      <li key={d.id}>
                        <Link to={`/post/${d.id}`} className="list-link">
                          <Stamp value={null} />
                          <span className="grow stack" style={{ gap: 2 }}>
                            <span className="list-title">{d.subject}</span>
                            <span className="meta">
                              <span>{d.party ?? t('afzender nog onbekend', 'sender not yet known')}</span>
                              {d.source !== 'MANUAL' && <Badge tone="info">{d.source === 'WIJSAMEN' ? 'WijSamen' : d.source === 'EMAIL' ? 'E-mail' : d.source === 'EXCHANGE' ? t('Uitwisseling', 'Exchange') : d.source}</Badge>}
                              <span>{ago(d.createdAt, language)}</span>
                            </span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Panel>
              )}
            </div>

            <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
              {risk && (risk.dossiers.some((d) => d.level !== 'LOW') || risk.letters.length > 0) && (
                <Proposal
                  title={t('Termijnrisico in uw werk', 'Deadline risk in your work')}
                  engine={risk.engine}
                  actions={
                    <Link to="/assistent?tab=risico" className="btn sm ghost">
                      {t('Alles', 'All')}
                    </Link>
                  }
                >
                  <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 10 }}>
                    {risk.dossiers
                      .filter((d) => d.level !== 'LOW')
                      .slice(0, 4)
                      .map((d) => (
                        <li key={d.dossierId} className="stack" style={{ gap: 2 }}>
                          <span className="row" style={{ gap: 8 }}>
                            <Badge tone={d.level === 'HIGH' ? 'danger' : 'warn'}>{d.level === 'HIGH' ? t('Hoog', 'High') : t('Middel', 'Medium')}</Badge>
                            <Link to={`/zaken/${d.dossierId}`} className="strong" style={{ color: 'var(--text)' }}>
                              {d.subject}
                            </Link>
                          </span>
                          <span className="small muted">{d.reasons.join('; ')}</span>
                        </li>
                      ))}
                  </ul>
                </Proposal>
              )}

              <Panel title={t('Zaken waarvoor u verantwoordelijk bent', 'Matters you are responsible for')} flush>
                {data.responsible.length === 0 ? (
                  <p className="muted small" style={{ padding: '4px 20px 12px' }}>
                    {t('U bent nu voor geen enkele open zaak verantwoordelijk.', 'You are not responsible for any open matter right now.')}
                  </p>
                ) : (
                  <ul className="list">
                    {data.responsible.slice(0, 8).map((d) => (
                      <li key={d.id}>
                        <Link to={`/zaken/${d.id}`} className="list-link">
                          <span className="grow stack" style={{ gap: 3 }}>
                            <span className="list-title">{d.subject}</span>
                            <span className="meta">
                              <Stamp value={d.dossierIdentity} />
                              <ProcessingBadge state={d.processingState} />
                            </span>
                          </span>
                          <Due date={d.dueDate} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              {data.advice.length > 0 && (
                <Panel title={t('Om uw advies gevraagd', 'Your advice requested')} flush>
                  <ul className="list">
                    {data.advice.map((a) => (
                      <li key={a.id}>
                        <Link to={`/zaken/${a.dossierId}?tab=advies`} className="list-link">
                          <MessageCircleQuestion size={18} style={{ marginTop: 3, color: 'var(--info)', flex: 'none' }} aria-hidden="true" />
                          <span className="grow stack" style={{ gap: 3 }}>
                            <span className="list-title">{a.subject}</span>
                            <span className="small">{a.question}</span>
                            <span className="meta">
                              <span>
                                {t('gevraagd door', 'asked by')} {a.requestedByName}
                              </span>
                            </span>
                          </span>
                          <Due date={a.dueDate} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Panel>
              )}

              {ai('chat') && (
                <Panel title={t('Vraag het de assistent', 'Ask the assistant')}>
                  <div className="chips">
                    {[
                      t('Wat staat er vandaag voor mij klaar?', 'What is waiting for me today?'),
                      t('Welke brieven kwamen deze week binnen?', 'Which letters came in this week?'),
                      t('Welke zaken zijn over termijn?', 'Which matters are overdue?'),
                    ].map((q) => (
                      <button key={q} type="button" className="chip-btn" onClick={() => assistant.ask(q)}>
                        <Sparkles size={13} aria-hidden="true" /> {q}
                      </button>
                    ))}
                  </div>
                </Panel>
              )}
              <p className="xs faint">{t(`Bijgewerkt ${date(data.today, language)}`, `Updated ${date(data.today, language)}`)}</p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function summarySentence(t: (nl: string, en: string) => string, d: MyWork): string {
  const s = d.summary;
  const parts: string[] = [];
  if (s.awaitingMyDecision) parts.push(t(`${s.awaitingMyDecision} ${s.awaitingMyDecision === 1 ? 'zaak wacht' : 'zaken wachten'} op uw besluit`, `${s.awaitingMyDecision} matter${s.awaitingMyDecision === 1 ? '' : 's'} await${s.awaitingMyDecision === 1 ? 's' : ''} your decision`));
  if (s.overdueTasks) parts.push(t(`${s.overdueTasks} ${s.overdueTasks === 1 ? 'taak is' : 'taken zijn'} te laat`, `${s.overdueTasks} task${s.overdueTasks === 1 ? ' is' : 's are'} overdue`));
  if (s.dueThisWeek) parts.push(t(`${s.dueThisWeek} ${s.dueThisWeek === 1 ? 'taak verloopt' : 'taken verlopen'} deze week`, `${s.dueThisWeek} task${s.dueThisWeek === 1 ? ' is' : 's are'} due this week`));
  if (!parts.length) return t('Er staat niets dringends voor u klaar.', 'Nothing urgent is waiting for you.');
  const last = parts.pop();
  return `${parts.length ? `${parts.join(', ')} ${t('en', 'and')} ` : ''}${last}.`.replace(/^./, (c) => c.toUpperCase());
}
