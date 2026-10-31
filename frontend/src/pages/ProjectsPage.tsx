import { AlertTriangle, GanttChartSquare, List, Lock, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { date } from '../lib/format';
import { useApi, useDebounced } from '../lib/hooks';
import { usePrefs } from '../lib/prefs';
import { Badge, Empty, ErrorNote, Field, Figure, Loading, PageHead, Panel, Segmented } from '../ui';
import { NewProjectDialog, PortfolioTimeline, Progress, PROJECT_ROLE, ProjectStatusBadge, ProjectSummary } from '../ui/projects';

type Scope = 'mine' | 'all';
type View = 'list' | 'timeline';

export default function ProjectsPage() {
  const { t, language } = usePrefs();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const scope = (params.get('scope') as Scope) ?? 'all';
  const view = (params.get('view') as View) ?? 'list';
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const query = useDebounced(q, 250);
  const [newOpen, setNewOpen] = useState(false);
  const qs = new URLSearchParams({ scope, ...(status ? { status } : {}), ...(query.trim() ? { q: query.trim() } : {}) });
  const list = useApi<{ data: ProjectSummary[]; canCreate: boolean }>(`/api/projects?${qs.toString()}`);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(k, v);
    setParams(next, { replace: true });
  };
  const data = list.data?.data ?? [];
  const running = data.filter((p) => ['PROPOSED', 'ACTIVE'].includes(p.status));
  const awaiting = data.filter((p) => p.businessCaseStatus === 'SUBMITTED' && p.myRole === 'OWNER');

  return (
    <>
      <PageHead
        title={t('Projecten', 'Projects')}
        lead={t(
          'Van business case tot overdracht: de opdrachtgever keurt goed, de projectleider verdeelt het werk in tickets. Ieder ziet wat hij nodig heeft — een teamlid alleen zijn eigen tickets.',
          'From business case to handover: the owner approves, the project manager divides the work into tickets. Everyone sees what they need — a team member only their own tickets.',
        )}
        actions={
          list.data?.canCreate && (
            <button type="button" className="btn primary" onClick={() => setNewOpen(true)}>
              <Plus size={18} /> {t('Nieuw project', 'New project')}
            </button>
          )
        }
      />
      {list.data && (
        <div className="figures" style={{ marginBottom: 18 }}>
          <Figure value={running.length} label={t('lopende projecten', 'running projects')} />
          <Figure value={running.filter((p) => p.late).length} label={t('lopen achter', 'behind schedule')} tone={running.some((p) => p.late) ? 'warn' : undefined} />
          <Figure value={data.reduce((n, p) => n + p.ticketCounts.overdue, 0)} label={t('tickets te laat', 'tickets overdue')} tone={data.some((p) => p.ticketCounts.overdue) ? 'alert' : undefined} />
          <Figure value={awaiting.length} label={t('business cases wachten op u', 'business cases await you')} tone={awaiting.length ? 'warn' : undefined} />
          <Figure value={data.filter((p) => p.status === 'COMPLETED').length} label={t('afgerond', 'completed')} tone="good" />
        </div>
      )}
      <div className="filters">
        <Segmented
          label={t('Welke projecten', 'Which projects')}
          value={scope}
          onChange={(v) => set('scope', v)}
          options={[
            { value: 'all', label: t('Alles wat ik mag zien', 'Everything I may see') },
            { value: 'mine', label: t('Waar ik op sta', 'Where I have a role') },
          ]}
        />
        <Segmented
          label={t('Weergave', 'View')}
          value={view}
          onChange={(v) => set('view', v)}
          options={[
            { value: 'list', label: <><List size={16} /> {t('Lijst', 'List')}</> },
            { value: 'timeline', label: <><GanttChartSquare size={16} /> {t('Tijdlijn', 'Time line')}</> },
          ]}
        />
      </div>
      <div className="filters">
        <Field label={t('Zoeken', 'Search')}>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Naam of nummer', 'Name or number')} />
        </Field>
        <Field label={t('Status', 'Status')}>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t('Alle', 'Any')}</option>
            <option value="PROPOSED">{t('Business case', 'Business case')}</option>
            <option value="ACTIVE">{t('Loopt', 'Running')}</option>
            <option value="ON_HOLD">{t('Gepauzeerd', 'On hold')}</option>
            <option value="COMPLETED">{t('Afgerond', 'Completed')}</option>
            <option value="CANCELLED">{t('Stopgezet', 'Cancelled')}</option>
          </select>
        </Field>
      </div>
      <ErrorNote error={list.error} />
      {list.loading && !list.data ? (
        <Loading lines={6} />
      ) : !data.length ? (
        <Empty title={t('Geen projecten', 'No projects')}>
          {t('Hier staan de projecten waar u een rol in heeft, en die onder uw lijn vallen.', 'Here are the projects you have a role in, and those that fall under your line.')}
        </Empty>
      ) : view === 'timeline' ? (
        <Panel title={t('Tijdlijn', 'Time line')}>
          <PortfolioTimeline projects={data} />
        </Panel>
      ) : (
        <Panel flush>
          <ul className="list">
            {data.map((p) => (
              <li key={p.id}>
                <Link to={`/projecten/${p.id}`} className="project-item">
                  <span className="grow stack" style={{ gap: 6 }}>
                    <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <span className="list-title">{p.name}</span>
                      <ProjectStatusBadge status={p.status} />
                      {p.classification === 'CONFIDENTIAL' && (
                        <Badge tone="danger">
                          <Lock size={12} aria-hidden="true" /> {t('Vertrouwelijk', 'Confidential')}
                        </Badge>
                      )}
                      {p.late && (
                        <Badge tone="warn">
                          <AlertTriangle size={12} aria-hidden="true" /> {t('Loopt achter', 'Behind schedule')}
                        </Badge>
                      )}
                      {p.businessCaseStatus === 'SUBMITTED' && p.myRole === 'OWNER' && <Badge tone="assist">{t('Wacht op uw goedkeuring', 'Awaits your approval')}</Badge>}
                    </span>
                    <span className="meta">
                      <span>{p.reference}</span>
                      <span>{p.unit.name}</span>
                      <span>
                        {t('Opdrachtgever', 'Owner')}: {p.owner.name}
                      </span>
                      <span>
                        {t('Projectleider', 'Project manager')}: {p.manager.name}
                      </span>
                      <span>
                        {date(p.startDate, language)} – {date(p.endDate, language)}
                      </span>
                      {p.myRole && <span className="my-role">{PROJECT_ROLE[p.myRole][language === 'en' ? 1 : 0]}</span>}
                    </span>
                  </span>
                  <span className="project-progress">
                    <span className="small muted">
                      {p.phase ? `${t('Fase', 'Phase')} ${p.phase.position}/${p.phase.count}: ${p.phase.name}` : p.status === 'COMPLETED' ? t('Afgerond', 'Completed') : '—'}
                    </span>
                    <Progress value={p.progress} late={p.late} label={t(`${p.progress}% gereed`, `${p.progress}% done`)} />
                    <span className="small muted">
                      {p.progress}% · {p.ticketCounts.open} {t('open', 'open')}
                      {p.ticketCounts.overdue ? ` · ${p.ticketCounts.overdue} ${t('te laat', 'overdue')}` : ''}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {newOpen && <NewProjectDialog onClose={() => setNewOpen(false)} onCreated={(id) => navigate(`/projecten/${id}`)} />}
    </>
  );
}
