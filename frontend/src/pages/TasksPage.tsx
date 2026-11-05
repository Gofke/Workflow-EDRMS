import { CalendarDays, ChevronLeft, ChevronRight, Columns3, List, Plus, Users } from 'lucide-react';
import { DragEvent, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { addDays, today } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { TASK_STATUS } from '../lib/labels';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { Avatar, Confirm, Due, Empty, ErrorNote, Field, Loading, PageHead, Panel, PriorityBadge, Segmented, usePager, useToast } from '../ui';
import { PersonSelect } from '../ui/people';
import { TaskRow, TaskView } from '../ui/records';
import { NewTaskDialog } from '../ui/tasks';

type Scope = 'my' | 'assigned' | 'unit' | 'all';
type View = 'list' | 'board' | 'calendar';

export default function TasksPage() {
  const { t } = usePrefs();
  const { manager } = useSession();
  const [params, setParams] = useSearchParams();
  const scope = (params.get('scope') as Scope) ?? 'my';
  const view = (params.get('view') as View) ?? 'list';
  const due = params.get('due') ?? '';
  const [q, setQ] = useState('');
  const [priority, setPriority] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [newOpen, setNewOpen] = useState(params.get('nieuw') === '1');
  const counts = useApi<Record<string, number>>('/api/tasks/counts');
  const query = new URLSearchParams({ scope, limit: '300', ...(due ? { due } : {}), ...(priority ? { priority } : {}), ...(q.trim() ? { q: q.trim() } : {}), ...(!showDone && view === 'list' ? { includeClosed: 'false' } : {}) });
  const tasks = useApi<{ data: TaskView[]; total: number }>(`/api/tasks?${query.toString()}`);

  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (!v) next.delete(k);
    else next.set(k, v);
    setParams(next, { replace: true });
  };
  const reload = () => {
    void tasks.reload();
    void counts.reload();
    window.dispatchEvent(new CustomEvent('juspol:changed'));
  };

  return (
    <>
      <PageHead
        title={t('Taken', 'Tasks')}
        lead={t('Het werk dat brieven en zaken vragen: wie, wat, wanneer. Een taak wordt nooit verwijderd; hij wordt afgerond, geannuleerd of gearchiveerd.', 'The work letters and matters call for: who, what, when. A task is never deleted; it is completed, cancelled or archived.')}
        actions={
          <button type="button" className="btn primary" onClick={() => setNewOpen(true)}>
            <Plus size={18} /> {t('Nieuwe taak', 'New task')}
          </button>
        }
      />
      <div className="filters">
        <Segmented
          label={t('Welke taken', 'Which tasks')}
          value={scope}
          onChange={(v) => set('scope', v)}
          options={[
            { value: 'my', label: `${t('Voor mij', 'For me')}${counts.data ? ` (${counts.data.my})` : ''}` },
            { value: 'assigned', label: `${t('Door mij uitgezet', 'Assigned by me')}${counts.data ? ` (${counts.data.assigned})` : ''}` },
            { value: 'unit', label: t('Mijn afdeling', 'My department') },
            { value: 'all', label: t('Alles wat ik mag zien', 'Everything I may see') },
          ]}
        />
        <Segmented
          label={t('Weergave', 'View')}
          value={view}
          onChange={(v) => set('view', v)}
          options={[
            { value: 'list', label: <><List size={16} /> {t('Lijst', 'List')}</> },
            { value: 'board', label: <><Columns3 size={16} /> {t('Bord', 'Board')}</> },
            { value: 'calendar', label: <><CalendarDays size={16} /> {t('Kalender', 'Calendar')}</> },
          ]}
        />
      </div>
      <div className="filters">
        <Field label={t('Zoeken', 'Search')}>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Titel of nummer', 'Title or number')} />
        </Field>
        <Field label={t('Termijn', 'Due')}>
          <select className="select" value={due} onChange={(e) => set('due', e.target.value || null)}>
            <option value="">{t('Alle', 'Any')}</option>
            <option value="overdue">{t('Te laat', 'Overdue')}</option>
            <option value="today">{t('Vandaag', 'Today')}</option>
            <option value="week">{t('Komende 7 dagen', 'Next 7 days')}</option>
          </select>
        </Field>
        <Field label={t('Prioriteit', 'Priority')}>
          <select className="select" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">{t('Alle', 'Any')}</option>
            <option value="URGENT">{t('Spoed', 'Urgent')}</option>
            <option value="HIGH">{t('Hoog', 'High')}</option>
            <option value="MEDIUM">{t('Normaal', 'Normal')}</option>
            <option value="LOW">{t('Laag', 'Low')}</option>
          </select>
        </Field>
        {view === 'list' && (
          <label className="check">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
            {t('Ook afgeronde taken', 'Include finished tasks')}
          </label>
        )}
      </div>
      <ErrorNote error={tasks.error} />
      {tasks.loading && !tasks.data ? (
        <Loading lines={6} />
      ) : view === 'list' ? (
        <ListView tasks={tasks.data?.data ?? []} canBulk={manager} onChanged={reload} />
      ) : view === 'board' ? (
        <Board tasks={tasks.data?.data ?? []} onChanged={reload} />
      ) : (
        <Calendar tasks={tasks.data?.data ?? []} />
      )}
      {newOpen && <NewTaskDialog onClose={() => (setNewOpen(false), set('nieuw', null))} onCreated={() => reload()} />}
    </>
  );
}

function ListView({ tasks, canBulk, onChanged }: { tasks: TaskView[]; canBulk: boolean; onChanged: () => void }) {
  const { t } = usePrefs();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assign, setAssign] = useState(false);
  const [who, setWho] = useState('');
  const { busy, error, run } = useAction();
  const sorted = [...tasks].sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
  const { page: pageRows, pager } = usePager(sorted);
  if (sorted.length === 0)
    return (
      <Panel>
        <Empty title={t('Geen taken', 'No tasks')}>{t('Er zijn geen taken in deze weergave.', 'There are no tasks in this view.')}</Empty>
      </Panel>
    );
  return (
    <Panel flush>
      {canBulk && selected.size > 0 && (
        <div className="row between" style={{ padding: '10px 20px', borderBottom: '1px solid var(--line)', background: 'var(--info-soft)' }}>
          <span>{t(`${selected.size} geselecteerd`, `${selected.size} selected`)}</span>
          <button type="button" className="btn sm" onClick={() => setAssign(true)}>
            <Users size={15} /> {t('Toewijzen aan…', 'Assign to…')}
          </button>
        </div>
      )}
      <ul className="list">
        {pageRows.map((task) => (
          <li key={task.id} className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
            {canBulk && (
              <input
                type="checkbox"
                aria-label={t(`Selecteer ${task.reference}`, `Select ${task.reference}`)}
                style={{ marginTop: 5, width: 18, height: 18 }}
                checked={selected.has(task.id)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(task.id);
                  else next.delete(task.id);
                  setSelected(next);
                }}
              />
            )}
            <div className="grow">
              <TaskRow task={task} />
            </div>
          </li>
        ))}
      </ul>
      {pager}
      {assign && (
        <Confirm
          title={t('Taken toewijzen', 'Assign tasks')}
          confirmLabel={t('Toewijzen', 'Assign')}
          onClose={() => setAssign(false)}
          busy={busy}
          error={error}
          disabled={!who}
          onConfirm={() =>
            void run(async () => {
              const r = await api.post<{ updated: string[]; skipped: { id: string; reason: string }[] }>('/api/tasks/bulk-assign', { taskIds: [...selected], assigneeAccountId: who });
              toast(t(`${r.updated.length} taken toegewezen${r.skipped.length ? `, ${r.skipped.length} overgeslagen` : ''}`, `${r.updated.length} tasks assigned${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`));
              setAssign(false);
              setSelected(new Set());
              onChanged();
            })
          }
        >
          <PersonSelect value={who} onChange={setWho} />
        </Confirm>
      )}
    </Panel>
  );
}

const COLUMNS: { key: string; statuses: string[] }[] = [
  { key: 'OPEN', statuses: ['OPEN', 'ACCEPTED'] },
  { key: 'IN_PROGRESS', statuses: ['IN_PROGRESS'] },
  { key: 'WAITING', statuses: ['WAITING'] },
  { key: 'IN_REVIEW', statuses: ['IN_REVIEW'] },
  { key: 'COMPLETED', statuses: ['COMPLETED'] },
];

/** A board: drag a card to another column to change its status. */
function Board({ tasks, onChanged }: { tasks: TaskView[]; onChanged: () => void }) {
  const { t, language } = usePrefs();
  const toast = useToast();
  const [over, setOver] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recent = addDays(today(), -14);
  const drop = async (e: DragEvent, status: string) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData('text/task');
    const task = tasks.find((x) => x.id === id);
    if (!task || COLUMNS.find((c) => c.key === status)?.statuses.includes(task.status)) return;
    try {
      if (status === 'COMPLETED') await api.post(`/api/tasks/${id}/complete`, { version: task.version });
      else await api.post(`/api/tasks/${id}/status`, { status, version: task.version });
      toast(t('Status bijgewerkt', 'Status updated'));
      setError(null);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <>
      <ErrorNote error={error} />
      <div className="board" role="list">
        {COLUMNS.map((col) => {
          const cards = tasks.filter((x) => col.statuses.includes(x.status) && (col.key !== 'COMPLETED' || (x.completedAt ?? '') >= recent));
          const [nl, en] = TASK_STATUS[col.key];
          return (
            <section
              key={col.key}
              className="board-col"
              aria-label={language === 'en' ? en : nl}
              onDragOver={(e) => (e.preventDefault(), setOver(col.key))}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => void drop(e, col.key)}
              style={over === col.key ? { outline: '2px dashed var(--brand)' } : undefined}
            >
              <h3>
                <span>{col.key === 'COMPLETED' ? t('Afgerond (14 dagen)', 'Completed (14 days)') : language === 'en' ? en : nl}</span>
                <span className="muted">{cards.length}</span>
              </h3>
              <div className="cards">
                {cards.map((task) => (
                  <Link key={task.id} to={`/taken/${task.id}`} className={`task-card p-${task.priority}`} draggable onDragStart={(e) => e.dataTransfer.setData('text/task', task.id)}>
                    <strong className="small">{task.title}</strong>
                    <span className="row between xs muted">
                      <span className="row" style={{ gap: 6 }}>
                        <Avatar name={task.assignee.name} small /> {task.assignee.name}
                      </span>
                      <Due date={task.dueDate} done={col.key === 'COMPLETED'} />
                    </span>
                    {(task.dossier || task.priority === 'URGENT' || task.priority === 'HIGH') && (
                      <span className="row xs" style={{ gap: 6 }}>
                        <PriorityBadge priority={task.priority} quiet />
                        {task.dossier && <span className="muted">{task.dossier.identity}</span>}
                      </span>
                    )}
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

/** The month, with each task on its due date and the Surinamese holidays marked. */
function Calendar({ tasks }: { tasks: TaskView[] }) {
  const { t, language } = usePrefs();
  const [month, setMonth] = useState(today().slice(0, 7));
  const [holidays, setHolidays] = useState<Record<string, string>>({});
  const year = month.slice(0, 4);
  useEffect(() => {
    api
      .get<{ date: string; name: string }[]>(`/api/calendar/holidays?year=${year}`)
      .then((hs) => setHolidays(Object.fromEntries(hs.map((h) => [h.date, h.name]))))
      .catch(() => setHolidays({}));
  }, [year]);
  const days = useMemo(() => {
    const first = new Date(`${month}-01T12:00:00Z`);
    const offset = (first.getUTCDay() + 6) % 7;
    const start = addDays(`${month}-01`, -offset);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [month]);
  const shift = (n: number) => {
    const d = new Date(`${month}-01T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + n);
    setMonth(d.toISOString().slice(0, 7));
  };
  const title = new Date(`${month}-01T12:00:00Z`).toLocaleDateString(language === 'en' ? 'en-GB' : 'nl-NL', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const dows = language === 'en' ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];
  const now = today();
  return (
    <div className="stack">
      <div className="row between">
        <h2 style={{ textTransform: 'capitalize' }}>{title}</h2>
        <div className="row">
          <button type="button" className="btn sm" onClick={() => shift(-1)} aria-label={t('Vorige maand', 'Previous month')}>
            <ChevronLeft size={16} />
          </button>
          <button type="button" className="btn sm" onClick={() => setMonth(today().slice(0, 7))}>
            {t('Vandaag', 'Today')}
          </button>
          <button type="button" className="btn sm" onClick={() => shift(1)} aria-label={t('Volgende maand', 'Next month')}>
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <div className="calendar" role="grid" aria-label={title}>
        {dows.map((d) => (
          <div key={d} className="dow" role="columnheader">
            {d}
          </div>
        ))}
        {days.map((d) => {
          const items = tasks.filter((x) => x.dueDate === d);
          const cls = ['day', d.slice(0, 7) !== month ? 'other' : '', d === now ? 'today' : '', holidays[d] ? 'holiday' : '', items.length ? 'has' : ''].join(' ');
          return (
            <div key={d} className={cls} role="gridcell">
              <span className="num">{Number(d.slice(8))}</span>
              {holidays[d] && <span className="xs" style={{ color: 'var(--warn)' }}>{holidays[d]}</span>}
              {items.slice(0, 3).map((x) => (
                <Link key={x.id} to={`/taken/${x.id}`} className={`chip${x.overdue ? ' late' : ''}`} title={`${x.title} — ${x.assignee.name}`}>
                  {x.title}
                </Link>
              ))}
              {items.length > 3 && <span className="xs muted">+{items.length - 3}</span>}
            </div>
          );
        })}
      </div>
      <p className="xs muted">{t('Feestdagen tellen niet als werkdag bij het berekenen van termijnen.', 'Holidays do not count as working days when deadlines are calculated.')}</p>
    </div>
  );
}
