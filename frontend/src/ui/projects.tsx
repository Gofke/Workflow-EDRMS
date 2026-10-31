import { Diamond } from 'lucide-react';
import { FormEvent, ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { addDays, date, today } from '../lib/format';
import { useApi } from '../lib/hooks';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { Badge, Dialog, ErrorNote, Field } from './index';
import { PersonSelect, usePeople } from './people';

// ---------------------------------------------------------------- types

export type ProjectStatus = 'PROPOSED' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';
export type ProjectAccess = 'FULL' | 'OVERVIEW' | 'SUMMARY' | 'MEMBER';
export type ProjectRole = 'OWNER' | 'MANAGER' | 'STAKEHOLDER' | 'MEMBER';
export interface Counts {
  total: number;
  done: number;
  open: number;
  overdue: number;
}
export interface PhaseLite {
  id: string;
  position: number;
  name: string;
  gate: 'BUSINESS_CASE' | 'CLOSURE' | null;
  startDate: string;
  endDate: string;
  status: 'PLANNED' | 'ACTIVE' | 'CLOSED';
  late: boolean;
}
export interface Phase extends PhaseLite {
  description: string;
  closedAt: string | null;
  tickets: Counts;
}
export interface ProjectSummary {
  id: string;
  reference: string;
  name: string;
  status: ProjectStatus;
  classification: 'INTERNAL' | 'CONFIDENTIAL';
  unit: { id: string; code: string; name: string };
  owner: { accountId: string; name: string };
  manager: { accountId: string; name: string };
  startDate: string;
  endDate: string;
  businessCaseStatus: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'RETURNED';
  phase: { position: number; count: number; name: string } | null;
  progress: number;
  late: boolean;
  ticketCounts: Counts;
  milestones: PhaseLite[];
  myRole: ProjectRole | null;
  access: ProjectAccess;
  memberCount: number;
  version: number;
}
export interface Ticket {
  id: string;
  reference: string;
  title: string;
  status: string;
  priority: string;
  startDate: string | null;
  dueDate: string | null;
  overdue: boolean;
  milestoneId: string;
  assignee: { accountId: string; name: string };
  completedAt: string | null;
}
export interface ProjectDetail extends Omit<ProjectSummary, 'milestones'> {
  description: string;
  statusReason: string | null;
  createdAt: string;
  completedAt: string | null;
  businessCase: {
    status: ProjectSummary['businessCaseStatus'];
    problem?: string;
    solution?: string;
    benefits?: string;
    costs?: string;
    risks?: string;
    budget?: number | null;
    submittedAt?: string | null;
    decidedAt?: string | null;
    decidedBy?: string | null;
    returnReason?: string | null;
  };
  milestones: Phase[];
  tickets: Ticket[];
  ticketsShown: 'all' | 'own';
  team: { accountId: string; name: string; jobPosition: string | null; role: 'STAKEHOLDER' | 'MEMBER'; unitName: string | null; openTickets: number }[];
  events: { eventType: string; note: string | null; occurredAt: string; actorName: string }[];
  permissions: Record<
    | 'canEdit'
    | 'canChangeOwnerOrManager'
    | 'canAddStakeholders'
    | 'canAddMembers'
    | 'canEditBusinessCase'
    | 'canSubmitBusinessCase'
    | 'canDecideBusinessCase'
    | 'canAddTickets'
    | 'canAddMilestone'
    | 'canCloseMilestone'
    | 'canSignOffClosure'
    | 'canHold'
    | 'canResume'
    | 'canCancel'
    | 'seesAllTickets',
    boolean
  >;
}

// ---------------------------------------------------------------- labels

export const PROJECT_STATUS: Record<ProjectStatus, [string, string]> = {
  PROPOSED: ['Business case', 'Business case'],
  ACTIVE: ['Loopt', 'Running'],
  ON_HOLD: ['Gepauzeerd', 'On hold'],
  COMPLETED: ['Afgerond', 'Completed'],
  CANCELLED: ['Stopgezet', 'Cancelled'],
};
export const PROJECT_ROLE: Record<ProjectRole, [string, string]> = {
  OWNER: ['Opdrachtgever', 'Owner'],
  MANAGER: ['Projectleider', 'Project manager'],
  STAKEHOLDER: ['Belanghebbende', 'Stakeholder'],
  MEMBER: ['Teamlid', 'Team member'],
};
export const BC_STATUS: Record<ProjectSummary['businessCaseStatus'], [string, string]> = {
  DRAFT: ['In opbouw', 'Being written'],
  SUBMITTED: ['Ter goedkeuring', 'Awaiting approval'],
  APPROVED: ['Goedgekeurd', 'Approved'],
  RETURNED: ['Teruggestuurd', 'Returned'],
};
export const ACCESS_TEXT: Record<ProjectAccess, [string, string]> = {
  FULL: ['U ziet het hele project, met alle tickets.', 'You see the whole project, with every ticket.'],
  OVERVIEW: [
    'Als belanghebbende ziet u de business case, de fasen, het team en de voortgang — niet de inhoud van de tickets.',
    'As a stakeholder you see the business case, the phases, the team and the progress — not the contents of the tickets.',
  ],
  SUMMARY: [
    'U ziet een samenvatting omdat dit project onder uw lijn valt: status, fase, voortgang en data. De business case en de tickets zijn voor de mensen op het project.',
    'You see a summary because this project falls under your line: status, phase, progress and dates. The business case and the tickets are for the people on the project.',
  ],
  MEMBER: ['Als teamlid ziet u de opzet van het project en uw eigen tickets.', 'As a team member you see the frame of the project and your own tickets.'],
};
const EVENT: Record<string, [string, string]> = {
  CREATED: ['Project gestart', 'Project started'],
  UPDATED: ['Project gewijzigd', 'Project changed'],
  MEMBER_ADDED: ['Op het project gezet', 'Added to the project'],
  MEMBER_REMOVED: ['Van het project gehaald', 'Removed from the project'],
  BUSINESS_CASE_SAVED: ['Business case bijgewerkt', 'Business case updated'],
  BUSINESS_CASE_SUBMITTED: ['Business case ter goedkeuring', 'Business case submitted'],
  BUSINESS_CASE_APPROVED: ['Business case goedgekeurd', 'Business case approved'],
  BUSINESS_CASE_RETURNED: ['Business case teruggestuurd', 'Business case returned'],
  MILESTONE_ADDED: ['Fase toegevoegd', 'Phase added'],
  MILESTONE_CHANGED: ['Fase gewijzigd', 'Phase changed'],
  MILESTONE_CLOSED: ['Fase afgesloten', 'Phase closed'],
  COMPLETED: ['Project afgetekend en afgerond', 'Project signed off and completed'],
  TICKET_ADDED: ['Ticket toegevoegd', 'Ticket added'],
  STATUS_ON_HOLD: ['Gepauzeerd', 'Put on hold'],
  STATUS_ACTIVE: ['Hervat', 'Resumed'],
  STATUS_PROPOSED: ['Hervat', 'Resumed'],
  STATUS_CANCELLED: ['Stopgezet', 'Cancelled'],
};
export function eventLabel(type: string, lang: 'nl' | 'en'): string {
  return EVENT[type] ? EVENT[type][lang === 'en' ? 1 : 0] : type;
}

// ---------------------------------------------------------------- small pieces

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const { language } = usePrefs();
  const tone = status === 'ACTIVE' ? 'info' : status === 'COMPLETED' ? 'ok' : status === 'ON_HOLD' ? 'warn' : status === 'CANCELLED' ? 'neutral' : 'assist';
  return <Badge tone={tone}>{PROJECT_STATUS[status][language === 'en' ? 1 : 0]}</Badge>;
}

export function Progress({ value, late, label }: { value: number; late?: boolean; label?: string }) {
  return (
    <span className={`progress${late ? ' late' : ''}`} role="img" aria-label={label ?? `${value}%`}>
      <span className="progress-fill" style={{ width: `${Math.min(Math.max(value, 0), 100)}%` }} />
    </span>
  );
}

/** The phases of a project as one strip: done, current, to come. */
export function PhaseStrip({ phases }: { phases: PhaseLite[] }) {
  const { t, language } = usePrefs();
  return (
    <ol className="phase-strip" aria-label={t('Fasen', 'Phases')}>
      {phases.map((p) => (
        <li key={p.id} className={`phase ${p.status.toLowerCase()}${p.late ? ' late' : ''}`}>
          <span className="phase-name">
            {p.gate && <Diamond size={12} aria-hidden="true" />} {p.name}
          </span>
          <span className="phase-dates">
            {date(p.startDate, language)} – {date(p.endDate, language)}
          </span>
          <span className="sr-only">
            {p.status === 'CLOSED' ? t('afgesloten', 'closed') : p.status === 'ACTIVE' ? t('huidige fase', 'current phase') : t('gepland', 'planned')}
            {p.late ? t(', over de einddatum', ', past its end date') : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- the Gantt chart

interface Row {
  key: string;
  kind: 'phase' | 'ticket' | 'project';
  label: ReactNode;
  sub?: ReactNode;
  start: string;
  end: string;
  tone: 'done' | 'active' | 'planned' | 'late' | 'waiting' | 'held';
  gate?: boolean;
  to?: string;
  describe: string;
  segments?: { start: string; end: string; tone: Row['tone']; label: string }[];
}

function span(rows: { start: string; end: string }[], extra: string[] = []) {
  const all = [...rows.flatMap((r) => [r.start, r.end]), ...extra].filter(Boolean).sort();
  const from = addDays(all[0] ?? today(), -3);
  const to = addDays(all[all.length - 1] ?? today(), 3);
  return { from, to, days: dayCount(from, to) };
}

function dayCount(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

function months(from: string, to: string) {
  const out: { label: string; start: string }[] = [];
  const d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  while (d.toISOString().slice(0, 10) <= to) {
    out.push({ label: d.toISOString().slice(0, 7), start: d.toISOString().slice(0, 10) });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

const MONTHS_NL = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function TimeChart({ rows, caption }: { rows: Row[]; caption: string }) {
  const { language, t } = usePrefs();
  const now = today();
  const s = useMemo(() => span(rows, [now]), [rows, now]);
  const pos = (d: string) => (Math.max(0, dayCount(s.from, d) - 1) / s.days) * 100;
  const width = (a: string, b: string) => Math.max((dayCount(a, b) / s.days) * 100, 0.6);
  const ms = months(s.from, s.to);
  const names = language === 'en' ? MONTHS_EN : MONTHS_NL;
  return (
    <div className="gantt" role="table" aria-label={caption}>
      <div className="gantt-row gantt-head" role="row">
        <div className="gantt-label" role="columnheader">
          {t('Onderdeel', 'Item')}
        </div>
        <div className="gantt-track" role="columnheader" aria-label={t('Tijdlijn', 'Timeline')}>
          {ms.map((m, i) => {
            const left = pos(m.start < s.from ? s.from : m.start);
            const right = i + 1 < ms.length ? pos(ms[i + 1].start) : 100;
            const [y, mo] = m.label.split('-').map(Number);
            // A month too narrow for its name (the clipped first or last one) stays unlabelled.
            if (right - left < 3.2) return null;
            const year = (mo === 1 || i === 0) && right - left >= 6.5;
            return (
              <span key={m.label} className="gantt-month" style={{ left: `${left}%` }} aria-hidden="true">
                {names[mo - 1]}
                {year ? ` ${y}` : ''}
              </span>
            );
          })}
        </div>
      </div>
      {rows.map((r) => (
        <div key={r.key} className={`gantt-row ${r.kind}`} role="row">
          <div className="gantt-label" role="rowheader">
            {r.to ? (
              <Link to={r.to} title={r.describe}>
                {r.label}
              </Link>
            ) : (
              r.label
            )}
            {r.sub && <span className="gantt-sub">{r.sub}</span>}
          </div>
          <div className="gantt-track" role="cell">
            {ms.map((m) => (
              <span key={m.label} className="gantt-grid" style={{ left: `${pos(m.start < s.from ? s.from : m.start)}%` }} aria-hidden="true" />
            ))}
            <span className="gantt-today" style={{ left: `${pos(now)}%` }} aria-hidden="true" />
            {r.segments ? (
              r.segments.map((g, i) => (
                <span
                  key={i}
                  className={`gantt-bar seg ${g.tone}`}
                  style={{ left: `${pos(g.start)}%`, width: `${width(g.start, g.end)}%` }}
                  title={g.label}
                  aria-hidden="true"
                />
              ))
            ) : (
              <span className={`gantt-bar ${r.tone}${r.kind === 'phase' ? ' phase' : ''}`} style={{ left: `${pos(r.start)}%`, width: `${width(r.start, r.end)}%` }} title={r.describe} aria-hidden="true">
                {r.gate && <Diamond size={11} className="gantt-gate" aria-hidden="true" />}
              </span>
            )}
            <span className="sr-only">{r.describe}</span>
          </div>
        </div>
      ))}
      <div className="gantt-legend" aria-hidden="true">
        <span><i className="sw done" /> {t('Klaar', 'Done')}</span>
        <span><i className="sw active" /> {t('Loopt', 'Running')}</span>
        <span><i className="sw planned" /> {t('Gepland', 'Planned')}</span>
        <span><i className="sw waiting" /> {t('Wacht', 'Waiting')}</span>
        <span><i className="sw late" /> {t('Te laat', 'Late')}</span>
        <span><Diamond size={11} /> {t('Beslismoment opdrachtgever', 'Owner decision')}</span>
        <span><i className="sw today" /> {t('Vandaag', 'Today')}</span>
      </div>
    </div>
  );
}

function ticketTone(tk: Ticket): Row['tone'] {
  if (tk.status === 'COMPLETED') return 'done';
  if (['CANCELLED', 'REJECTED'].includes(tk.status)) return 'held';
  if (tk.overdue) return 'late';
  if (tk.status === 'WAITING') return 'waiting';
  if (['IN_PROGRESS', 'IN_REVIEW', 'ACCEPTED'].includes(tk.status)) return 'active';
  return 'planned';
}

function phaseTone(p: PhaseLite): Row['tone'] {
  if (p.status === 'CLOSED') return 'done';
  if (p.late) return 'late';
  return p.status === 'ACTIVE' ? 'active' : 'planned';
}

/** One project: its phases, and under each phase the tickets this person may see. */
export function ProjectGantt({ project }: { project: ProjectDetail }) {
  const { t, language } = usePrefs();
  const [onlyLate, setOnlyLate] = useState(false);
  const rows: Row[] = [];
  for (const p of project.milestones) {
    const tks = project.tickets.filter((tk) => tk.milestoneId === p.id && (!onlyLate || tk.overdue));
    if (onlyLate && !tks.length && !p.late) continue;
    rows.push({
      key: p.id,
      kind: 'phase',
      label: `${p.position}. ${p.name}`,
      sub: `${p.tickets.done}/${p.tickets.total} ${t('tickets klaar', 'tickets done')}`,
      start: p.startDate,
      end: p.endDate,
      tone: phaseTone(p),
      gate: !!p.gate,
      describe: `${t('Fase', 'Phase')} ${p.name}: ${date(p.startDate, language)} – ${date(p.endDate, language)}, ${p.status === 'CLOSED' ? t('afgesloten', 'closed') : p.status === 'ACTIVE' ? t('loopt', 'running') : t('gepland', 'planned')}${p.late ? t(', te laat', ', late') : ''}.`,
    });
    for (const tk of tks) {
      const start = tk.startDate ?? tk.dueDate ?? p.startDate;
      const end = tk.dueDate ?? tk.startDate ?? p.endDate;
      rows.push({
        key: tk.id,
        kind: 'ticket',
        label: (
          <>
            <span className="gantt-ref">{tk.reference}</span> {tk.title}
          </>
        ),
        sub: tk.assignee.name,
        start: start <= end ? start : end,
        end,
        tone: ticketTone(tk),
        to: `/taken/${tk.id}`,
        describe: `${tk.reference} ${tk.title}, ${tk.assignee.name}: ${date(start, language)} – ${date(end, language)}${tk.overdue ? t(', te laat', ', late') : ''}.`,
      });
    }
  }
  return (
    <>
      <div className="row between" style={{ marginBottom: 10 }}>
        <span className="muted small">
          {project.ticketsShown === 'all'
            ? t('Alle fasen en tickets van het project.', 'Every phase and ticket of the project.')
            : t('De fasen van het project, met alleen uw eigen tickets.', 'The phases of the project, with only your own tickets.')}
        </span>
        <label className="check">
          <input type="checkbox" checked={onlyLate} onChange={(e) => setOnlyLate(e.target.checked)} /> {t('Alleen wat te laat is', 'Only what is late')}
        </label>
      </div>
      {rows.length ? <TimeChart rows={rows} caption={t(`Planning van ${project.name}`, `Plan of ${project.name}`)} /> : <p className="muted">{t('Niets te laat.', 'Nothing is late.')}</p>}
    </>
  );
}

/** Every project a person may see on one time line, each with its phases. */
export function PortfolioTimeline({ projects }: { projects: ProjectSummary[] }) {
  const { t, language } = usePrefs();
  const rows: Row[] = projects.map((p) => ({
    key: p.id,
    kind: 'project',
    label: (
      <>
        <span className="gantt-ref">{p.reference}</span> {p.name}
      </>
    ),
    sub: `${PROJECT_STATUS[p.status][language === 'en' ? 1 : 0]}${p.phase ? ` · ${t('fase', 'phase')} ${p.phase.position}/${p.phase.count}` : ''} · ${p.progress}%`,
    start: p.startDate,
    end: p.endDate,
    tone: p.status === 'COMPLETED' ? 'done' : p.late ? 'late' : p.status === 'ON_HOLD' || p.status === 'CANCELLED' ? 'held' : 'active',
    to: `/projecten/${p.id}`,
    describe: `${p.reference} ${p.name}: ${date(p.startDate, language)} – ${date(p.endDate, language)}, ${PROJECT_STATUS[p.status][language === 'en' ? 1 : 0]}, ${p.progress}%${p.late ? t(', loopt achter', ', behind schedule') : ''}.`,
    segments: p.milestones.map((m) => ({ start: m.startDate, end: m.endDate, tone: p.status === 'ON_HOLD' || p.status === 'CANCELLED' ? 'held' : phaseTone(m), label: m.name })),
  }));
  return <TimeChart rows={rows} caption={t('Tijdlijn van de projecten', 'Time line of the projects')} />;
}

// ---------------------------------------------------------------- dialogs

interface Unit {
  id: string;
  code: string;
  name: string;
  isActive?: boolean;
}

export function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = usePrefs();
  const { user } = useSession();
  const units = useApi<Unit[]>('/api/org/units');
  const people = usePeople();
  const me = people.find((p) => p.accountId === user?.accountId);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [unitId, setUnitId] = useState('');
  const [owner, setOwner] = useState(user?.accountId ?? '');
  const [manager, setManager] = useState('');
  const [stakeholder, setStakeholder] = useState('');
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState(addDays(today(), 180));
  const [classification, setClassification] = useState<'INTERNAL' | 'CONFIDENTIAL'>('INTERNAL');
  const [template, setTemplate] = useState<'standard' | 'short'>('standard');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosenUnit = unitId || me?.unitId || '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const span = dayCount(start, end);
      const short =
        template === 'short'
          ? (() => {
              const a = addDays(start, Math.max(Math.round(span * 0.15), 1) - 1);
              const b = addDays(a, Math.max(Math.round(span * 0.7), 1));
              return [
                { name: 'Business case', startDate: start, endDate: a },
                { name: 'Uitvoering', startDate: addDays(a, 1), endDate: b < end ? b : end },
                { name: 'Afsluiting en overdracht', startDate: addDays(b, 1) <= end ? addDays(b, 1) : end, endDate: end },
              ];
            })()
          : undefined;
      const created = await api.post<{ id: string }>('/api/projects', {
        name,
        description,
        unitId: chosenUnit,
        ownerAccountId: owner || undefined,
        managerAccountId: manager,
        stakeholders: stakeholder ? [stakeholder] : [],
        startDate: start,
        endDate: end,
        classification,
        ...(short ? { milestones: short } : {}),
      });
      onCreated(created.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t('Nieuw project', 'New project')}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('Annuleren', 'Cancel')}
          </button>
          <button type="submit" form="new-project" className="btn primary" disabled={busy || !name.trim() || !manager || !chosenUnit}>
            {t('Project starten', 'Start project')}
          </button>
        </>
      }
    >
      <form id="new-project" onSubmit={submit} className="stack">
        <Field label={t('Naam van het project', 'Project name')}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </Field>
        <Field label={t('Waar gaat het over', 'What it is about')} hint={t('Eén of twee zinnen; de business case volgt.', 'One or two sentences; the business case follows.')}>
          <textarea className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid-2">
          <Field label={t('Afdeling', 'Unit')}>
            <select className="select" value={chosenUnit} onChange={(e) => setUnitId(e.target.value)} required>
              <option value="">{t('Kies…', 'Choose…')}</option>
              {(units.data ?? [])
                .filter((u) => u.isActive !== false)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label={t('Rubricering', 'Classification')} hint={t('Vertrouwelijk: alleen zichtbaar voor de mensen op het project.', 'Confidential: visible only to the people on the project.')}>
            <select className="select" value={classification} onChange={(e) => setClassification(e.target.value as 'INTERNAL')}>
              <option value="INTERNAL">{t('Intern', 'Internal')}</option>
              <option value="CONFIDENTIAL">{t('Vertrouwelijk', 'Confidential')}</option>
            </select>
          </Field>
          <Field label={t('Opdrachtgever', 'Owner')} hint={t('Keurt de business case goed en tekent het project af.', 'Approves the business case and signs the project off.')}>
            <PersonSelect value={owner} onChange={setOwner} roles={['MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'SUPPORT_STAFF']} required />
          </Field>
          <Field label={t('Projectleider', 'Project manager')} hint={t('Schrijft de business case en verdeelt het werk.', 'Writes the business case and divides the work.')}>
            <PersonSelect value={manager} onChange={setManager} roles={['MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'SUPPORT_STAFF']} exclude={[owner]} required />
          </Field>
          <Field label={t('Belanghebbende (optioneel)', 'Stakeholder (optional)')} hint={t('Meer belanghebbenden voegt u later toe.', 'Add more stakeholders later.')}>
            <PersonSelect value={stakeholder} onChange={setStakeholder} roles={['MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'SUPPORT_STAFF']} exclude={[owner, manager]} />
          </Field>
          <Field label={t('Fasen', 'Phases')}>
            <select className="select" value={template} onChange={(e) => setTemplate(e.target.value as 'standard')}>
              <option value="standard">{t('Standaard: business case, documentatie, uitvoering, afsluiting', 'Standard: business case, documentation, execution, closure')}</option>
              <option value="short">{t('Kort: business case, uitvoering, afsluiting', 'Short: business case, execution, closure')}</option>
            </select>
          </Field>
          <Field label={t('Start', 'Start')}>
            <input type="date" className="input" value={start} onChange={(e) => setStart(e.target.value)} required />
          </Field>
          <Field label={t('Gereed', 'End')}>
            <input type="date" className="input" value={end} min={start} onChange={(e) => setEnd(e.target.value)} required />
          </Field>
        </div>
        <ErrorNote error={error} />
      </form>
    </Dialog>
  );
}

export function NewTicketDialog({ project, onClose, onCreated, phaseId }: { project: ProjectDetail; onClose: () => void; onCreated: () => void; phaseId?: string }) {
  const { t } = usePrefs();
  const open = project.milestones.filter((m) => m.status !== 'CLOSED');
  const [milestoneId, setMilestoneId] = useState(phaseId ?? project.milestones.find((m) => m.status === 'ACTIVE')?.id ?? open[0]?.id ?? '');
  const phase = project.milestones.find((m) => m.id === milestoneId);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState('');
  const [start, setStart] = useState(() => (phase && phase.startDate > today() ? phase.startDate : today()));
  const [due, setDue] = useState(() => (phase && phase.endDate > today() ? phase.endDate : addDays(today(), 10)));
  const [priority, setPriority] = useState('MEDIUM');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/projects/${project.id}/tickets`, { milestoneId, title, description, assigneeAccountId: assignee, startDate: start, dueDate: due, priority });
      onCreated();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('Nieuwe ticket', 'New ticket')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('Annuleren', 'Cancel')}
          </button>
          <button type="submit" form="new-ticket" className="btn primary" disabled={busy || !title.trim() || !assignee || !milestoneId}>
            {t('Ticket aanmaken', 'Create ticket')}
          </button>
        </>
      }
    >
      <form id="new-ticket" className="stack" onSubmit={submit}>
        <Field label={t('Fase', 'Phase')}>
          <select className="select" value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)} required>
            {open.map((m) => (
              <option key={m.id} value={m.id}>
                {m.position}. {m.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Wat moet er gebeuren', 'What needs doing')}>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </Field>
        <Field label={t('Toelichting', 'Details')}>
          <textarea className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label={t('Voor wie', 'For whom')} hint={t('Wie de ticket krijgt, komt in het team en ziet alleen zijn eigen tickets.', 'Whoever gets the ticket joins the team and sees only their own tickets.')}>
          <PersonSelect value={assignee} onChange={setAssignee} roles={['MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'SUPPORT_STAFF']} required />
        </Field>
        <div className="grid-3">
          <Field label={t('Start', 'Start')}>
            <input type="date" className="input" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label={t('Termijn', 'Due')}>
            <input type="date" className="input" value={due} min={start} onChange={(e) => setDue(e.target.value)} />
          </Field>
          <Field label={t('Prioriteit', 'Priority')}>
            <select className="select" value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="LOW">{t('Laag', 'Low')}</option>
              <option value="MEDIUM">{t('Normaal', 'Normal')}</option>
              <option value="HIGH">{t('Hoog', 'High')}</option>
              <option value="URGENT">{t('Spoed', 'Urgent')}</option>
            </select>
          </Field>
        </div>
        <ErrorNote error={error} />
      </form>
    </Dialog>
  );
}

export function MemberDialog({ project, onClose, onDone }: { project: ProjectDetail; onClose: () => void; onDone: () => void }) {
  const { t } = usePrefs();
  const [accountId, setAccountId] = useState('');
  const [role, setRole] = useState<'STAKEHOLDER' | 'MEMBER'>(project.permissions.canAddStakeholders ? 'STAKEHOLDER' : 'MEMBER');
  const [error, setError] = useState<string | null>(null);
  const exclude = [project.owner.accountId, project.manager.accountId, ...project.team.map((m) => m.accountId)];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post(`/api/projects/${project.id}/members`, { accountId, role });
      onDone();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Dialog
      title={t('Iemand op het project zetten', 'Add someone to the project')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('Annuleren', 'Cancel')}
          </button>
          <button type="submit" form="add-member" className="btn primary" disabled={!accountId}>
            {t('Toevoegen', 'Add')}
          </button>
        </>
      }
    >
      <form id="add-member" className="stack" onSubmit={submit}>
        <Field label={t('Persoon', 'Person')}>
          <PersonSelect value={accountId} onChange={setAccountId} roles={['MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'SUPPORT_STAFF', 'RECORDS_MANAGER']} exclude={exclude} required />
        </Field>
        <Field label={t('Rol', 'Role')}>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value as 'MEMBER')}>
            {project.permissions.canAddStakeholders && <option value="STAKEHOLDER">{t('Belanghebbende — ziet business case, fasen en voortgang', 'Stakeholder — sees business case, phases and progress')}</option>}
            <option value="MEMBER">{t('Teamlid — ziet alleen de eigen tickets', 'Team member — sees only their own tickets')}</option>
          </select>
        </Field>
        <ErrorNote error={error} />
      </form>
    </Dialog>
  );
}

export function ReasonDialog({ title, label, action, onClose, onSubmit, required = true }: { title: string; label: string; action: string; onClose: () => void; onSubmit: (reason: string) => Promise<void>; required?: boolean }) {
  const { t } = usePrefs();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSubmit(reason);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('Annuleren', 'Cancel')}
          </button>
          <button type="submit" form="reason-form" className="btn primary" disabled={busy || (required && !reason.trim())}>
            {action}
          </button>
        </>
      }
    >
      <form id="reason-form" onSubmit={submit} className="stack">
        <Field label={label}>
          <textarea className="textarea" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={600} required={required} />
        </Field>
        <ErrorNote error={error} />
      </form>
    </Dialog>
  );
}
