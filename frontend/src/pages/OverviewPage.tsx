import { FileDown, FileSpreadsheet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { ago, longDate } from '../lib/format';
import { useApi } from '../lib/hooks';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { Badge, EngineInfo, ErrorNote, Figure, Loading, PageHead, Panel, ProcessingBadge, Proposal, Stamp } from '../ui';
import { BarChart } from '../ui/charts';
import { workflowLabel } from './DossierDetailPage';

interface Overview {
  today: string;
  counts: Record<string, number>;
  onTime: { total: number; onTime: number; percentage: number | null };
  averageHandlingDays: number | null;
  byUnit: { id: string; name: string; code: string; registered: number; open: number; overdue: number; finalised: number; avgHandlingDays: number | null; onTimePct: number | null; openTasks: number; overdueTasks: number }[];
  overdue: { id: string; dossierIdentity: string; subject: string; dueDate: string; processingState: string; responsibleName: string | null; unit: string | null; workingDaysLate: number }[];
  trends: { months: { month: string; incoming: number; outgoing: number; internal: number; finalised: number; tasksCompleted: number }[] };
  recentDecisions: { eventType: string; occurredAt: string; dossierId: string; dossierIdentity: string; subject: string; actorName: string }[];
}

export function monthLabel(m: string, language: string): string {
  return new Date(`${m}-01T12:00:00Z`).toLocaleDateString(language === 'en' ? 'en-GB' : 'nl-NL', { month: 'short', timeZone: 'UTC' }).replace('.', '');
}

export default function OverviewPage() {
  const { t, language } = usePrefs();
  const { ai } = useSession();
  const { data, error } = useApi<Overview>('/api/dashboard/overview');
  const [risk, setRisk] = useState<{ counts: { high: number; medium: number }; dossiers: { dossierId: string; dossierIdentity: string; subject: string; level: string; reasons: string[]; responsible: string | null }[]; engine: EngineInfo } | null>(null);
  useEffect(() => {
    if (ai('risk')) api.get<typeof risk>('/api/ai/risk?scope=all').then(setRisk).catch(() => null);
  }, [ai]);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading lines={8} />;
  const c = data.counts;
  return (
    <>
      <PageHead
        title={t('Bestuurlijk overzicht', 'Management overview')}
        lead={t(`De stand van het werk op ${longDate(data.today, language)}, over alles wat u mag zien.`, `The state of the work on ${longDate(data.today, language)}, across everything you may see.`)}
        actions={
          <>
            <button type="button" className="btn" onClick={() => void api.download('/api/reports/overview.pdf', 'overzicht.pdf')}>
              <FileDown size={18} /> PDF
            </button>
            <button type="button" className="btn" onClick={() => void api.download('/api/reports/overview.xlsx', 'overzicht.xlsx')}>
              <FileSpreadsheet size={18} /> Excel
            </button>
          </>
        }
      />
      <div className="stack" style={{ '--gap': '22px' } as React.CSSProperties}>
        <div className="figures">
          <Figure value={c.openMatters} label={t('lopende zaken', 'open matters')} to="/zaken" />
          <Figure value={c.overdueMatters} label={t('over termijn', 'overdue')} to="/zaken?view=overdue" tone={c.overdueMatters ? 'alert' : undefined} />
          <Figure value={c.dueThisWeek} label={t('termijn deze week', 'due this week')} tone={c.dueThisWeek ? 'warn' : undefined} />
          <Figure value={c.underReview} label={t('ter beoordeling', 'under review')} to="/zaken?view=review" />
          <Figure value={c.awaitingMinister} label={t('wacht op de Minister', 'awaiting the Minister')} />
          <Figure value={data.onTime.percentage === null ? '—' : `${data.onTime.percentage}%`} label={t(`op tijd afgerond (90 dagen, ${data.onTime.total} zaken)`, `finished on time (90 days, ${data.onTime.total} matters)`)} tone={data.onTime.percentage !== null && data.onTime.percentage >= 80 ? 'good' : 'warn'} />
        </div>
        <div className="grid-2">
          <Panel title={t('Post en besluiten per maand', 'Post and decisions per month')}>
            <BarChart
              height={270}
              title={t('Inkomende en uitgaande stukken en afgeronde zaken per maand', 'Incoming and outgoing records and finished matters per month')}
              labels={data.trends.months.map((m) => monthLabel(m.month, language))}
              series={[
                { name: t('Inkomend', 'Incoming'), color: 'var(--brand)', values: data.trends.months.map((m) => m.incoming) },
                { name: t('Uitgaand', 'Outgoing'), color: 'var(--gold)', values: data.trends.months.map((m) => m.outgoing) },
                { name: t('Zaken afgerond', 'Matters finished'), color: 'var(--ok)', values: data.trends.months.map((m) => m.finalised) },
              ]}
            />
          </Panel>
          <Panel title={t('Kerncijfers', 'Key figures')}>
            <dl className="kfigs">
              {(
                [
                  [c.registeredThisMonth, t('geregistreerd deze maand', 'registered this month')],
                  [c.finalisedThisMonth, t('zaken afgerond deze maand', 'matters finished this month')],
                  [data.averageHandlingDays ?? '—', t('gemiddelde doorlooptijd in dagen', 'average handling time in days')],
                  [c.openTasks, t('open taken', 'open tasks')],
                  [c.overdueTasks, t('taken over de termijn', 'tasks past their deadline'), c.overdueTasks > 0],
                  [c.openAdvice, t('open adviesaanvragen', 'open advice requests')],
                  [c.draftsWaiting, t('concepten nog te registreren', 'drafts still to register')],
                ] as [React.ReactNode, string, boolean?][]
              ).map(([v, label, alert]) => (
                <div key={label} className={alert ? 'alert' : undefined}>
                  <dt>{label}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </Panel>
        </div>
        <div className="split">
          <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
            <Panel title={t('Zaken over termijn', 'Matters past their deadline')} flush>
              {data.overdue.length === 0 ? (
                <p className="muted small" style={{ padding: '4px 20px 14px' }}>
                  {t('Geen zaken over termijn.', 'No matters past their deadline.')}
                </p>
              ) : (
                <table className="table responsive">
                  <thead>
                    <tr>
                      <th>{t('Zaak', 'Matter')}</th>
                      <th>{t('Verantwoordelijk', 'Responsible')}</th>
                      <th>{t('Status', 'Status')}</th>
                      <th>{t('Te laat', 'Late')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.overdue.map((o) => (
                      <tr key={o.id}>
                        <td className="title-cell">
                          <Stamp value={o.dossierIdentity} to={`/zaken/${o.id}`} /> <Link to={`/zaken/${o.id}`}>{o.subject}</Link>
                          <div className="small muted">{o.unit}</div>
                        </td>
                        <td>{o.responsibleName ?? '—'}</td>
                        <td>
                          <ProcessingBadge state={o.processingState} />
                        </td>
                        <td className="nowrap">
                          <strong style={{ color: 'var(--danger)' }}>{t(`${o.workingDaysLate} werkdagen`, `${o.workingDaysLate} working days`)}</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
            <Panel title={t('Per afdeling (laatste 90 dagen)', 'By department (last 90 days)')} flush>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('Afdeling', 'Department')}</th>
                      <th>{t('Open', 'Open')}</th>
                      <th>{t('Over termijn', 'Overdue')}</th>
                      <th>{t('Afgerond', 'Finished')}</th>
                      <th>{t('Op tijd', 'On time')}</th>
                      <th>{t('Taken te laat', 'Tasks late')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byUnit
                      .filter((u) => u.open + u.finalised + u.openTasks + u.registered > 0)
                      .map((u) => (
                        <tr key={u.id}>
                          <td>{u.name}</td>
                          <td>{u.open}</td>
                          <td style={u.overdue ? { color: 'var(--danger)', fontWeight: 700 } : undefined}>{u.overdue}</td>
                          <td>{u.finalised}</td>
                          <td style={{ minWidth: 110 }}>
                            {u.onTimePct === null ? (
                              '—'
                            ) : (
                              <span className="stack" style={{ gap: 3 }}>
                                <span className="small strong">{u.onTimePct}%</span>
                                <span className={`meter ${u.onTimePct >= 80 ? 'ok' : u.onTimePct >= 50 ? 'warn' : 'danger'}`}>
                                  <span style={{ width: `${u.onTimePct}%` }} />
                                </span>
                              </span>
                            )}
                          </td>
                          <td>{u.overdueTasks}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
          <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
            {risk && (
              <Proposal title={t('Termijnrisico over het ministerie', 'Deadline risk across the ministry')} engine={risk.engine}>
                <p className="small">
                  {t(`${risk.counts.high} zaken met hoog en ${risk.counts.medium} met middel risico.`, `${risk.counts.high} matters at high and ${risk.counts.medium} at medium risk.`)}
                </p>
                <ul className="risk-list">
                  {risk.dossiers
                    .filter((d) => d.level !== 'LOW')
                    .slice(0, 6)
                    .map((d) => (
                      <li key={d.dossierId}>
                        <Badge tone={d.level === 'HIGH' ? 'danger' : 'warn'}>{d.level === 'HIGH' ? t('Hoog', 'High') : t('Middel', 'Medium')}</Badge>
                        <Link to={`/zaken/${d.dossierId}`} className="strong" style={{ color: 'var(--text)' }}>
                          {d.subject}
                        </Link>
                        <span className="small muted">{d.reasons.join('; ')}</span>
                      </li>
                    ))}
                </ul>
              </Proposal>
            )}
            <Panel title={t('Laatste stap per zaak', 'Latest step per matter')} flush>
              <ul className="list">
                {data.recentDecisions
                  .filter((r, i, all) => all.findIndex((x) => x.dossierId === r.dossierId) === i)
                  .slice(0, 7)
                  .map((r, i) => (
                  <li key={i}>
                    <Link to={`/zaken/${r.dossierId}`} className="list-link">
                      <span className="grow stack" style={{ gap: 2 }}>
                        <span className="list-title">{r.subject}</span>
                        <span className="meta">
                          <Stamp value={r.dossierIdentity} />
                          <span>
                            {workflowLabel(t, r.eventType)}, {r.actorName}, {ago(r.occurredAt, language)}
                          </span>
                        </span>
                      </span>
                    </Link>
                  </li>
                  ))}
              </ul>
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}
