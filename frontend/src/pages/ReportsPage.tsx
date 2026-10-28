import { FileDown, FileSpreadsheet } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { useApi } from '../lib/hooks';
import { usePrefs } from '../lib/prefs';
import { ErrorNote, Loading, PageHead, Panel, Segmented, Tabs, useToast } from '../ui';
import { BarChart, HBars } from '../ui/charts';
import { monthLabel } from './OverviewPage';

type Report = 'departments' | 'workload' | 'trends' | 'overview';

interface UnitRow { id: string; name: string; code: string; registered: number; open: number; overdue: number; finalised: number; avgHandlingDays: number | null; onTimePct: number | null; openTasks: number; overdueTasks: number }
interface WorkRow { accountId: string; name: string; unit: string | null; openTasks: number; overdueTasks: number; dueThisWeek: number; completed30d: number; responsibleMatters: number; openAdvice: number }
interface Trends { months: { month: string; incoming: number; outgoing: number; internal: number; finalised: number; tasksCompleted: number }[]; topSenders: { name: string; letters: number }[] }

function Downloads({ name, label }: { name: Report; label: string }) {
  const { t } = usePrefs();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const get = async (ext: 'pdf' | 'xlsx') => {
    setBusy(ext);
    try {
      await api.download(`/api/reports/${name}.${ext}`, `${label}.${ext}`);
      toast(t('Rapport gedownload', 'Report downloaded'));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="row">
      <button type="button" className="btn" disabled={!!busy} onClick={() => void get('pdf')}>
        <FileDown size={18} /> {busy === 'pdf' ? t('Bezig…', 'Working…') : t('PDF met zegel', 'Sealed PDF')}
      </button>
      <button type="button" className="btn" disabled={!!busy} onClick={() => void get('xlsx')}>
        <FileSpreadsheet size={18} /> {busy === 'xlsx' ? t('Bezig…', 'Working…') : 'Excel'}
      </button>
    </div>
  );
}

function Departments() {
  const { t } = usePrefs();
  const [days, setDays] = useState<'30' | '90' | '365'>('90');
  const { data, error } = useApi<UnitRow[]>(`/api/dashboard/departments?days=${days}`);
  return (
    <Panel
      title={t('Prestaties per afdeling', 'Performance by department')}
      actions={<Segmented label={t('Periode', 'Period')} value={days} onChange={setDays} options={[{ value: '30', label: t('30 dagen', '30 days') }, { value: '90', label: t('90 dagen', '90 days') }, { value: '365', label: t('1 jaar', '1 year') }]} />}
      flush
    >
      <ErrorNote error={error} />
      {!data ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('Afdeling', 'Department')}</th>
                <th>{t('Geregistreerd', 'Registered')}</th>
                <th>{t('Open zaken', 'Open matters')}</th>
                <th>{t('Over termijn', 'Overdue')}</th>
                <th>{t('Afgerond', 'Finished')}</th>
                <th>{t('Doorlooptijd', 'Handling time')}</th>
                <th>{t('Op tijd', 'On time')}</th>
                <th>{t('Open taken', 'Open tasks')}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.name}</strong> <span className="xs muted">{u.code}</span>
                  </td>
                  <td>{u.registered}</td>
                  <td>{u.open}</td>
                  <td style={u.overdue ? { color: 'var(--danger)', fontWeight: 700 } : undefined}>{u.overdue}</td>
                  <td>{u.finalised}</td>
                  <td>{u.avgHandlingDays === null ? '—' : t(`${u.avgHandlingDays} dagen`, `${u.avgHandlingDays} days`)}</td>
                  <td>{u.onTimePct === null ? '—' : `${u.onTimePct}%`}</td>
                  <td>
                    {u.openTasks}
                    {u.overdueTasks > 0 && <span className="xs" style={{ color: 'var(--danger)' }}> ({t(`${u.overdueTasks} te laat`, `${u.overdueTasks} late`)})</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Workload() {
  const { t } = usePrefs();
  const { data, error } = useApi<WorkRow[]>('/api/dashboard/workload');
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  const rows = [...data].sort((a, b) => b.openTasks + b.responsibleMatters - (a.openTasks + a.responsibleMatters));
  return (
    <div className="grid-2">
      <Panel title={t('Open taken per medewerker', 'Open tasks per person')}>
        <HBars
          title={t('Open taken per medewerker; rood is het deel dat te laat is', 'Open tasks per person; red is the part that is late')}
          rows={[...rows]
            .sort((a, b) => b.openTasks - a.openTasks)
            .filter((r) => r.openTasks > 0)
            .map((r) => ({ label: r.name, value: r.openTasks, tone: r.overdueTasks > 0 ? ('danger' as const) : r.dueThisWeek > 0 ? ('warn' as const) : ('ok' as const) }))}
        />
        <p className="xs muted" style={{ marginTop: 10 }}>
          {t('Rood: minstens één taak te laat. Oranje: termijn deze week.', 'Red: at least one task late. Orange: due this week.')}
        </p>
      </Panel>
      <Panel title={t('Werklast in detail', 'Workload in detail')} flush>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('Medewerker', 'Person')}</th>
                <th>{t('Taken', 'Tasks')}</th>
                <th>{t('Te laat', 'Late')}</th>
                <th>{t('Zaken', 'Matters')}</th>
                <th>{t('Afgerond 30 d.', 'Done 30 d.')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.accountId}>
                  <td>
                    <strong>{r.name}</strong>
                    <div className="xs muted">{r.unit ?? ''}</div>
                  </td>
                  <td>{r.openTasks}</td>
                  <td style={r.overdueTasks ? { color: 'var(--danger)', fontWeight: 700 } : undefined}>{r.overdueTasks}</td>
                  <td>{r.responsibleMatters}</td>
                  <td>{r.completed30d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function TrendsView() {
  const { t, language } = usePrefs();
  const [months, setMonths] = useState<'6' | '12' | '24'>('12');
  const { data, error } = useApi<Trends>(`/api/dashboard/trends?months=${months}`);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  const labels = data.months.map((m) => monthLabel(m.month, language));
  return (
    <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
      <Panel
        title={t('Post per maand', 'Post per month')}
        actions={<Segmented label={t('Periode', 'Period')} value={months} onChange={setMonths} options={[{ value: '6', label: t('6 mnd', '6 mo') }, { value: '12', label: t('12 mnd', '12 mo') }, { value: '24', label: t('24 mnd', '24 mo') }]} />}
      >
        <BarChart
          height={260}
          stacked
          title={t('Inkomende, uitgaande en interne stukken per maand', 'Incoming, outgoing and internal records per month')}
          labels={labels}
          series={[
            { name: t('Inkomend', 'Incoming'), color: 'var(--brand)', values: data.months.map((m) => m.incoming) },
            { name: t('Uitgaand', 'Outgoing'), color: 'var(--gold)', values: data.months.map((m) => m.outgoing) },
            { name: t('Intern', 'Internal'), color: 'var(--info)', values: data.months.map((m) => m.internal) },
          ]}
        />
      </Panel>
      <div className="grid-2">
        <Panel title={t('Afgehandeld per maand', 'Completed per month')}>
          <BarChart
            title={t('Afgeronde zaken en taken per maand', 'Finished matters and tasks per month')}
            labels={labels}
            series={[
              { name: t('Zaken afgerond', 'Matters finished'), color: 'var(--ok)', values: data.months.map((m) => m.finalised) },
              { name: t('Taken afgerond', 'Tasks done'), color: 'var(--brand)', values: data.months.map((m) => m.tasksCompleted) },
            ]}
          />
        </Panel>
        <Panel title={t('Meeste post van', 'Most post from')}>
          <HBars title={t('Afzenders met de meeste inkomende brieven', 'Senders with the most incoming letters')} rows={data.topSenders.slice(0, 8).map((s) => ({ label: s.name, value: s.letters }))} />
        </Panel>
      </div>
    </div>
  );
}

export default function ReportsPage() {
  const { t } = usePrefs();
  const [tab, setTab] = useState<Report>('departments');
  const meta: Record<Report, [string, string, string]> = {
    departments: [t('Afdelingen', 'Departments'), t('Open zaken, termijnen, doorlooptijd en op-tijd-percentage per afdeling.', 'Open matters, deadlines, handling time and on-time rate per department.'), 'afdelingen'],
    workload: [t('Werklast', 'Workload'), t('Taken en zaken per medewerker, met wat te laat is en wat deze week vervalt.', 'Tasks and matters per person, with what is late and what falls due this week.'), 'werklast'],
    trends: [t('Trends', 'Trends'), t('Post en afhandeling per maand, en de afzenders met de meeste post.', 'Post and completion per month, and the senders with the most post.'), 'trends'],
    overview: [t('Bestuurlijk overzicht', 'Management overview'), t('Alles op één A4: kerncijfers, zaken over termijn en per afdeling. Geschikt voor de staf.', 'Everything on one page: key figures, overdue matters and departments. Suitable for the staff meeting.'), 'bestuurlijk-overzicht'],
  };
  return (
    <>
      <PageHead
        title={t('Rapporten', 'Reports')}
        lead={t('Elk rapport is live uit het systeem en is te downloaden als PDF (met zegel en QR-code om de echtheid te controleren) of als Excel om verder te rekenen.', 'Every report is live from the system and can be downloaded as a PDF (sealed, with a QR code to check it is genuine) or as Excel for further calculation.')}
      />
      <Tabs label={t('Rapport', 'Report')} value={tab} onChange={setTab} tabs={(Object.keys(meta) as Report[]).map((r) => ({ value: r, label: meta[r][0] }))} />
      <div className="row between" style={{ margin: '18px 0' }}>
        <p className="muted" style={{ margin: 0, maxWidth: '62ch' }}>
          {meta[tab][1]}
        </p>
        <Downloads name={tab} label={meta[tab][2]} />
      </div>
      {tab === 'departments' && <Departments />}
      {tab === 'workload' && <Workload />}
      {tab === 'trends' && <TrendsView />}
      {tab === 'overview' && (
        <Panel title={t('Bestuurlijk overzicht', 'Management overview')}>
          <p>{t('Het bestuurlijk overzicht staat live op de pagina Bestuurlijk overzicht. Hier downloadt u het als document voor het stafoverleg of het archief.', 'The management overview is live on the Management overview page. Here you download it as a document for the staff meeting or the archive.')}</p>
          <Link className="btn" to="/overzicht">
            {t('Open het overzicht', 'Open the overview')}
          </Link>
        </Panel>
      )}
    </>
  );
}
