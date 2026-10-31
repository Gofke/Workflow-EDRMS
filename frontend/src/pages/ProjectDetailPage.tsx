import { CheckCircle2, Diamond, Lock, Pause, Play, Plus, Send, ShieldCheck, Undo2, UserPlus, X, XCircle } from 'lucide-react';
import { FormEvent, ReactNode, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { date, dateTime, longDate, num } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { usePrefs } from '../lib/prefs';
import { Avatar, Badge, Confirm, Due, ErrorNote, Field, Figure, KV, Loading, Notice, PageHead, Panel, PriorityBadge, Tabs, TaskStatusBadge, useToast } from '../ui';
import {
  ACCESS_TEXT,
  BC_STATUS,
  eventLabel,
  MemberDialog,
  NewTicketDialog,
  PhaseStrip,
  Progress,
  PROJECT_ROLE,
  ProjectDetail,
  ProjectGantt,
  ProjectStatusBadge,
  ReasonDialog,
} from '../ui/projects';

type Tab = 'overzicht' | 'planning' | 'tickets' | 'businesscase' | 'team' | 'historie';
type Dialog = null | 'ticket' | 'member' | 'return' | 'hold' | 'resume' | 'cancel' | 'approve' | 'submit' | { close: string };

export default function ProjectDetailPage() {
  const { id } = useParams();
  const { t, language } = usePrefs();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overzicht';
  const d = useApi<ProjectDetail>(`/api/projects/${id}`);
  const [dialog, setDialog] = useState<Dialog>(null);
  const action = useAction();
  const p = d.data;
  if (d.error && !p) return <ErrorNote error={d.error} />;
  if (!p) return <Loading lines={8} />;
  const L = (pair: [string, string]) => pair[language === 'en' ? 1 : 0];
  const can = p.permissions;
  const full = p.access === 'FULL';
  const overview = full || p.access === 'OVERVIEW';
  const active = p.milestones.find((m) => m.status === 'ACTIVE');
  const changed = () => {
    void d.reload();
    window.dispatchEvent(new CustomEvent('juspol:changed'));
  };
  const post = (path: string, body: Record<string, unknown>, done: string) =>
    action.run(async () => {
      await api.post(`/api/projects/${p.id}${path}`, { version: p.version, ...body });
      setDialog(null);
      toast(done);
      changed();
    });
  const setTab = (v: Tab) => {
    const next = new URLSearchParams(params);
    next.set('tab', v);
    setParams(next, { replace: true });
  };

  const actions: ReactNode[] = [];
  if (can.canSubmitBusinessCase)
    actions.push(
      <button key="submit" type="button" className="btn primary" onClick={() => setDialog('submit')}>
        <Send size={17} /> {t('Business case indienen', 'Submit business case')}
      </button>,
    );
  if (can.canDecideBusinessCase)
    actions.push(
      <button key="approve" type="button" className="btn ok solid" onClick={() => setDialog('approve')}>
        <CheckCircle2 size={17} /> {t('Business case goedkeuren', 'Approve business case')}
      </button>,
      <button key="return" type="button" className="btn" onClick={() => setDialog('return')}>
        <Undo2 size={17} /> {t('Terugsturen', 'Return')}
      </button>,
    );
  if (can.canAddTickets)
    actions.push(
      <button key="ticket" type="button" className={`btn${actions.length ? '' : ' primary'}`} onClick={() => setDialog('ticket')}>
        <Plus size={17} /> {t('Nieuwe ticket', 'New ticket')}
      </button>,
    );
  if (active && can.canCloseMilestone)
    actions.push(
      <button key="close" type="button" className="btn" onClick={() => setDialog({ close: active.id })}>
        <CheckCircle2 size={17} /> {t(`Fase ${active.position} afsluiten`, `Close phase ${active.position}`)}
      </button>,
    );
  if (active && can.canSignOffClosure)
    actions.push(
      <button key="signoff" type="button" className="btn ok solid" onClick={() => setDialog({ close: active.id })}>
        <ShieldCheck size={17} /> {t('Project aftekenen', 'Sign the project off')}
      </button>,
    );

  return (
    <>
      <PageHead
        crumbs={[{ to: '/projecten', label: t('Projecten', 'Projects') }]}
        title={
          <span className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            {p.name} <ProjectStatusBadge status={p.status} />
            {p.classification === 'CONFIDENTIAL' && (
              <Badge tone="danger">
                <Lock size={12} aria-hidden="true" /> {t('Vertrouwelijk', 'Confidential')}
              </Badge>
            )}
          </span>
        }
        lead={
          <>
            {p.reference} · {p.unit.name} · {date(p.startDate, language)} – {date(p.endDate, language)}
            {p.myRole && (
              <>
                {' · '}
                <strong>
                  {t('Uw rol', 'Your role')}: {L(PROJECT_ROLE[p.myRole])}
                </strong>
              </>
            )}
          </>
        }
        actions={actions.length ? <>{actions}</> : undefined}
      />
      <div className="stack" style={{ gap: 10, marginBottom: 14 }}>
        {p.access !== 'FULL' && <Notice tone="info">{L(ACCESS_TEXT[p.access])}</Notice>}
        {p.status === 'ON_HOLD' && (
          <Notice tone="warn" title={t('Gepauzeerd', 'On hold')}>
            {p.statusReason}
          </Notice>
        )}
        {p.status === 'CANCELLED' && (
          <Notice tone="danger" title={t('Stopgezet', 'Cancelled')}>
            {p.statusReason}
          </Notice>
        )}
        {p.businessCase.status === 'RETURNED' && overview && p.businessCase.returnReason && (
          <Notice tone="warn" title={t('Business case teruggestuurd door de opdrachtgever', 'Business case returned by the owner')}>
            {p.businessCase.returnReason}
          </Notice>
        )}
        <ErrorNote error={action.error} />
      </div>
      <div className="figures">
        <Figure value={`${p.progress}%`} label={t('gereed', 'done')} tone={p.status === 'COMPLETED' ? 'good' : undefined} />
        <Figure value={p.phase ? `${p.phase.position}/${p.phase.count}` : '—'} label={p.phase ? p.phase.name : t('geen lopende fase', 'no running phase')} />
        <Figure value={p.ticketCounts.open} label={t('open tickets', 'open tickets')} />
        <Figure value={p.ticketCounts.overdue} label={t('tickets te laat', 'tickets overdue')} tone={p.ticketCounts.overdue ? 'alert' : undefined} />
        <Figure value={L(BC_STATUS[p.businessCaseStatus])} label={t('business case', 'business case')} tone={p.businessCaseStatus === 'APPROVED' ? 'good' : p.businessCaseStatus === 'RETURNED' ? 'warn' : undefined} />
      </div>
      <div className="stack" style={{ gap: 6, margin: '14px 0 18px' }}>
        <Progress value={p.progress} late={p.late} label={t(`${p.progress}% gereed`, `${p.progress}% done`)} />
        <PhaseStrip phases={p.milestones} />
      </div>
      <Tabs
        label={t('Onderdelen van het project', 'Parts of the project')}
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overzicht', label: t('Overzicht', 'Overview') },
          { value: 'planning', label: t('Planning (Gantt)', 'Plan (Gantt)') },
          { value: 'tickets', label: full ? t('Tickets', 'Tickets') : t('Mijn tickets', 'My tickets'), count: p.tickets.filter((x) => !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(x.status)).length, hidden: p.access === 'SUMMARY' && !p.tickets.length },
          { value: 'businesscase', label: t('Business case', 'Business case'), hidden: !overview },
          { value: 'team', label: t('Team', 'Team'), hidden: !overview },
          { value: 'historie', label: t('Geschiedenis', 'History'), hidden: !overview },
        ]}
      />

      {tab === 'overzicht' && (
        <div className="grid-2">
          <Panel title={t('Het project', 'The project')}>
            {p.description && <p style={{ marginTop: 0, whiteSpace: 'pre-wrap' }}>{p.description}</p>}
            <KV
              rows={[
                [t('Opdrachtgever', 'Owner'), <PersonLine key="o" name={p.owner.name} note={t('keurt goed en tekent af', 'approves and signs off')} />],
                [t('Projectleider', 'Project manager'), <PersonLine key="m" name={p.manager.name} note={t('voert uit en verdeelt het werk', 'runs it and divides the work')} />],
                [t('Afdeling', 'Unit'), p.unit.name],
                [t('Looptijd', 'Duration'), `${longDate(p.startDate, language)} – ${longDate(p.endDate, language)}`],
                [t('Rubricering', 'Classification'), p.classification === 'CONFIDENTIAL' ? t('Vertrouwelijk — alleen voor de mensen op het project', 'Confidential — only for the people on the project') : t('Intern', 'Internal')],
                [t('Mensen op het project', 'People on the project'), String(p.memberCount + 2)],
              ]}
            />
          </Panel>
          <Panel title={t('Fasen', 'Phases')}>
            <ol className="phase-list">
              {p.milestones.map((m) => (
                <li key={m.id} className={`phase-item ${m.status.toLowerCase()}`}>
                  <span className="phase-dot" aria-hidden="true" />
                  <span className="grow stack" style={{ gap: 2 }}>
                    <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <strong>
                        {m.position}. {m.name}
                      </strong>
                      {m.gate && (
                        <Badge tone="assist">
                          <Diamond size={11} aria-hidden="true" /> {m.gate === 'BUSINESS_CASE' ? t('Goedkeuring opdrachtgever', 'Owner approval') : t('Aftekening opdrachtgever', 'Owner sign-off')}
                        </Badge>
                      )}
                      {m.status === 'ACTIVE' && <Badge tone="info">{t('Huidige fase', 'Current phase')}</Badge>}
                      {m.status === 'CLOSED' && <Badge tone="ok">{t('Afgesloten', 'Closed')}</Badge>}
                      {m.late && <Badge tone="warn">{t('Over de einddatum', 'Past its end date')}</Badge>}
                    </span>
                    <span className="meta">
                      <span>
                        {date(m.startDate, language)} – {date(m.endDate, language)}
                      </span>
                      <span>
                        {m.tickets.done}/{m.tickets.total} {t('tickets klaar', 'tickets done')}
                      </span>
                      {m.tickets.overdue > 0 && <span className="danger-text">{m.tickets.overdue} {t('te laat', 'overdue')}</span>}
                      {m.closedAt && <span>{t('afgesloten', 'closed')} {date(m.closedAt, language)}</span>}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      )}

      {tab === 'planning' && (
        <Panel title={t('Planning', 'Plan')}>
          <ProjectGantt project={p} />
        </Panel>
      )}

      {tab === 'tickets' && (
        <div className="stack">
          {!full && (
            <p className="muted" style={{ margin: 0 }}>
              {t('U ziet alleen de tickets die u zelf heeft of volgt.', 'You see only the tickets you hold or follow.')}
            </p>
          )}
          {p.milestones.map((m) => {
            const rows = p.tickets.filter((x) => x.milestoneId === m.id);
            if (!rows.length && !(can.canAddTickets && m.status !== 'CLOSED')) return null;
            return (
              <Panel
                key={m.id}
                flush
                title={`${m.position}. ${m.name}`}
                actions={
                  can.canAddTickets && m.status !== 'CLOSED' ? (
                    <button type="button" className="btn sm" onClick={() => setDialog('ticket')}>
                      <Plus size={15} /> {t('Ticket', 'Ticket')}
                    </button>
                  ) : undefined
                }
              >
                {rows.length ? (
                  <ul className="list">
                    {rows.map((x) => (
                      <li key={x.id}>
                        <Link to={`/taken/${x.id}`} className="list-link">
                          <Avatar name={x.assignee.name} small />
                          <span className="grow stack" style={{ gap: 3 }}>
                            <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                              <span className="list-title">{x.title}</span>
                              <PriorityBadge priority={x.priority} quiet />
                              {x.status !== 'OPEN' && <TaskStatusBadge status={x.status} />}
                            </span>
                            <span className="meta">
                              <span>{x.reference}</span>
                              <span>{x.assignee.name}</span>
                              {x.startDate && (
                                <span>
                                  {t('start', 'start')} {date(x.startDate, language)}
                                </span>
                              )}
                            </span>
                          </span>
                          <Due date={x.dueDate} done={['COMPLETED', 'CANCELLED', 'REJECTED'].includes(x.status)} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted" style={{ padding: '12px 18px', margin: 0 }}>
                    {t('Nog geen tickets in deze fase.', 'No tickets in this phase yet.')}
                  </p>
                )}
              </Panel>
            );
          })}
        </div>
      )}

      {tab === 'businesscase' && overview && <BusinessCase project={p} onSaved={changed} />}

      {tab === 'team' && overview && (
        <Panel
          title={t('Team', 'Team')}
          actions={
            can.canAddMembers ? (
              <button type="button" className="btn sm" onClick={() => setDialog('member')}>
                <UserPlus size={15} /> {t('Toevoegen', 'Add')}
              </button>
            ) : undefined
          }
          flush
        >
          <ul className="list">
            <TeamRow name={p.owner.name} role={L(PROJECT_ROLE.OWNER)} />
            <TeamRow name={p.manager.name} role={L(PROJECT_ROLE.MANAGER)} />
            {p.team.map((m) => (
              <TeamRow
                key={m.accountId}
                name={m.name}
                role={L(PROJECT_ROLE[m.role])}
                detail={[m.jobPosition, m.unitName, m.role === 'MEMBER' ? `${m.openTickets} ${t('open tickets', 'open tickets')}` : null].filter(Boolean).join(' · ')}
                onRemove={
                  (can.canAddStakeholders || (can.canAddMembers && m.role === 'MEMBER')) && !m.openTickets
                    ? () =>
                        action.run(async () => {
                          await api.del(`/api/projects/${p.id}/members/${m.accountId}`);
                          toast(t(`${m.name} is van het project gehaald.`, `${m.name} was removed from the project.`));
                          changed();
                        })
                    : undefined
                }
              />
            ))}
          </ul>
        </Panel>
      )}

      {tab === 'historie' && overview && (
        <Panel title={t('Geschiedenis', 'History')}>
          <ol className="timeline-list">
            {p.events.map((e, i) => (
              <li key={i}>
                <strong>{eventLabel(e.eventType, language)}</strong>
                {e.note && <span> — {e.note}</span>}
                <div className="meta">
                  <span>{e.actorName}</span>
                  <span>{dateTime(e.occurredAt, language)}</span>
                </div>
              </li>
            ))}
          </ol>
        </Panel>
      )}

      {(can.canHold || can.canResume || can.canCancel) && (
        <div className="row" style={{ gap: 8, marginTop: 22 }}>
          {can.canHold && (
            <button type="button" className="btn ghost" onClick={() => setDialog('hold')}>
              <Pause size={16} /> {t('Pauzeren', 'Put on hold')}
            </button>
          )}
          {can.canResume && (
            <button type="button" className="btn" onClick={() => setDialog('resume')}>
              <Play size={16} /> {t('Hervatten', 'Resume')}
            </button>
          )}
          {can.canCancel && (
            <button type="button" className="btn ghost danger" onClick={() => setDialog('cancel')}>
              <XCircle size={16} /> {t('Project stopzetten', 'Cancel the project')}
            </button>
          )}
        </div>
      )}

      {dialog === 'ticket' && <NewTicketDialog project={p} onClose={() => setDialog(null)} onCreated={() => { setDialog(null); toast(t('Ticket aangemaakt.', 'Ticket created.')); changed(); }} />}
      {dialog === 'member' && <MemberDialog project={p} onClose={() => setDialog(null)} onDone={() => { setDialog(null); changed(); }} />}
      {dialog === 'submit' && (
        <Confirm title={t('Business case indienen', 'Submit the business case')} confirmLabel={t('Indienen', 'Submit')} onClose={() => setDialog(null)} busy={action.busy} error={action.error} onConfirm={() => void post('/business-case/submit', {}, t('Ingediend bij de opdrachtgever.', 'Submitted to the owner.'))}>
          <p style={{ margin: 0 }}>
            {t(`${p.owner.name} krijgt de business case ter goedkeuring. Tot de beslissing kunt u hem niet wijzigen.`, `${p.owner.name} receives the business case for approval. Until the decision you cannot change it.`)}
          </p>
        </Confirm>
      )}
      {dialog === 'approve' && (
        <Confirm title={t('Business case goedkeuren', 'Approve the business case')} confirmLabel={t('Goedkeuren', 'Approve')} onClose={() => setDialog(null)} busy={action.busy} error={action.error} onConfirm={() => void post('/business-case/approve', {}, t('Goedgekeurd; de volgende fase is begonnen.', 'Approved; the next phase has started.'))}>
          <p style={{ margin: 0 }}>
            {t('Met uw goedkeuring sluit de fase "Business case" en begint de volgende fase. Het project gaat lopen.', 'Your approval closes the "Business case" phase and starts the next phase. The project starts running.')}
          </p>
        </Confirm>
      )}
      {dialog === 'return' && (
        <ReasonDialog
          title={t('Business case terugsturen', 'Return the business case')}
          label={t('Wat moet de projectleider aanpassen?', 'What should the project manager change?')}
          action={t('Terugsturen', 'Return')}
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            await api.post(`/api/projects/${p.id}/business-case/return`, { version: p.version, reason });
            setDialog(null);
            toast(t('Teruggestuurd naar de projectleider.', 'Returned to the project manager.'));
            changed();
          }}
        />
      )}
      {(dialog === 'hold' || dialog === 'resume' || dialog === 'cancel') && (
        <ReasonDialog
          title={dialog === 'hold' ? t('Project pauzeren', 'Put the project on hold') : dialog === 'resume' ? t('Project hervatten', 'Resume the project') : t('Project stopzetten', 'Cancel the project')}
          label={
            dialog === 'cancel'
              ? t('Reden (iedereen op het project krijgt die te zien). Open tickets worden geannuleerd.', 'Reason (everyone on the project will see it). Open tickets are cancelled.')
              : t('Reden (iedereen op het project krijgt die te zien)', 'Reason (everyone on the project will see it)')
          }
          action={dialog === 'hold' ? t('Pauzeren', 'Put on hold') : dialog === 'resume' ? t('Hervatten', 'Resume') : t('Stopzetten', 'Cancel project')}
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            await api.post(`/api/projects/${p.id}/status`, { version: p.version, action: dialog === 'hold' ? 'HOLD' : dialog === 'resume' ? 'RESUME' : 'CANCEL', reason });
            setDialog(null);
            changed();
          }}
        />
      )}
      {dialog && typeof dialog === 'object' && (
        <ReasonDialog
          required={false}
          title={active?.gate === 'CLOSURE' ? t('Project aftekenen', 'Sign the project off') : t(`Fase "${active?.name}" afsluiten`, `Close the phase "${active?.name}"`)}
          label={t('Opmerking (optioneel)', 'Note (optional)')}
          action={active?.gate === 'CLOSURE' ? t('Aftekenen en afronden', 'Sign off and complete') : t('Afsluiten', 'Close phase')}
          onClose={() => setDialog(null)}
          onSubmit={async (note) => {
            await api.post(`/api/projects/${p.id}/milestones/${dialog.close}/close`, { version: p.version, ...(note.trim() ? { note } : {}) });
            setDialog(null);
            toast(active?.gate === 'CLOSURE' ? t('Het project is afgerond.', 'The project is completed.') : t('Fase afgesloten; de volgende fase is begonnen.', 'Phase closed; the next phase has started.'));
            changed();
          }}
        />
      )}
    </>
  );
}

function PersonLine({ name, note }: { name: string; note: string }) {
  return (
    <span className="row" style={{ gap: 8 }}>
      <Avatar name={name} small /> {name} <span className="muted small">— {note}</span>
    </span>
  );
}

function TeamRow({ name, role, detail, onRemove }: { name: string; role: string; detail?: string; onRemove?: () => void }) {
  const { t } = usePrefs();
  return (
    <li className="list-link" style={{ cursor: 'default' }}>
      <Avatar name={name} small />
      <span className="grow stack" style={{ gap: 2 }}>
        <span className="row" style={{ gap: 8 }}>
          <strong>{name}</strong> <Badge>{role}</Badge>
        </span>
        {detail && <span className="meta">{detail}</span>}
      </span>
      {onRemove && (
        <button type="button" className="icon-btn" onClick={onRemove} aria-label={t(`${name} van het project halen`, `Remove ${name} from the project`)}>
          <X size={17} />
        </button>
      )}
    </li>
  );
}

function BusinessCase({ project: p, onSaved }: { project: ProjectDetail; onSaved: () => void }) {
  const { t, language } = usePrefs();
  const bc = p.businessCase;
  const editable = p.permissions.canEditBusinessCase;
  const [form, setForm] = useState({
    problem: bc.problem ?? '',
    solution: bc.solution ?? '',
    benefits: bc.benefits ?? '',
    costs: bc.costs ?? '',
    risks: bc.risks ?? '',
    budget: bc.budget === null || bc.budget === undefined ? '' : String(bc.budget),
  });
  const [editing, setEditing] = useState(false);
  const save = useAction();
  const toast = useToast();
  const parts: [keyof typeof form, string, string, string][] = [
    ['problem', t('Aanleiding en probleem', 'Reason and problem'), t('Wat gaat er nu mis, en voor wie?', 'What goes wrong now, and for whom?'), ''],
    ['solution', t('Oplossing en aanpak', 'Solution and approach'), t('Wat gaat het project doen?', 'What will the project do?'), ''],
    ['benefits', t('Baten', 'Benefits'), t('Wat levert het op, meetbaar?', 'What does it deliver, measurably?'), ''],
    ['costs', t('Kosten', 'Costs'), t('Eenmalig en jaarlijks, per jaar.', 'One-off and yearly, per year.'), ''],
    ['risks', t('Risico’s', 'Risks'), t('Wat kan misgaan, en wat doet u dan?', 'What can go wrong, and what will you do?'), ''],
  ];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save.run(async () => {
      await api.put(`/api/projects/${p.id}/business-case`, {
        version: p.version,
        problem: form.problem,
        solution: form.solution,
        benefits: form.benefits,
        costs: form.costs,
        risks: form.risks,
        budget: form.budget.trim() === '' ? null : Number(form.budget.replace(/\./g, '').replace(',', '.')),
      });
      setEditing(false);
      toast(t('Business case opgeslagen.', 'Business case saved.'));
      onSaved();
    });
  };
  return (
    <Panel
      title={t('Business case', 'Business case')}
      actions={
        editable && !editing ? (
          <button type="button" className="btn sm" onClick={() => setEditing(true)}>
            {t('Bewerken', 'Edit')}
          </button>
        ) : undefined
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        {L2(BC_STATUS[bc.status], language)}
        {bc.submittedAt && ` · ${t('ingediend', 'submitted')} ${dateTime(bc.submittedAt, language)}`}
        {bc.decidedAt && bc.decidedBy && ` · ${bc.status === 'APPROVED' ? t('goedgekeurd door', 'approved by') : t('beslist door', 'decided by')} ${bc.decidedBy}, ${dateTime(bc.decidedAt, language)}`}
      </p>
      {editing ? (
        <form className="stack" onSubmit={submit}>
          {parts.map(([k, label, hint]) => (
            <Field key={k} label={label} hint={hint}>
              <textarea className="textarea" rows={3} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} maxLength={8000} />
            </Field>
          ))}
          <Field label={t('Budget (SRD)', 'Budget (SRD)')}>
            <input className="input" inputMode="decimal" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} />
          </Field>
          <ErrorNote error={save.error} />
          <div className="row" style={{ gap: 8 }}>
            <button type="submit" className="btn primary" disabled={save.busy}>
              {t('Opslaan', 'Save')}
            </button>
            <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
              {t('Annuleren', 'Cancel')}
            </button>
          </div>
        </form>
      ) : (
        <div className="bc-read">
          {parts.filter(([k]) => k !== 'budget').map(([k, label]) => (
            <section key={k}>
              <h3>{label}</h3>
              <p style={{ whiteSpace: 'pre-wrap' }}>{String(bc[k as Exclude<typeof k, 'budget'>] ?? '').trim() || <span className="muted">{t('Nog niet ingevuld.', 'Not filled in yet.')}</span>}</p>
            </section>
          ))}
          <section>
            <h3>{t('Budget', 'Budget')}</h3>
            <p>{bc.budget === null || bc.budget === undefined ? <span className="muted">—</span> : `SRD ${num(bc.budget, language, 0)}`}</p>
          </section>
        </div>
      )}
    </Panel>
  );
}

function L2(pair: [string, string], language: 'nl' | 'en') {
  return pair[language === 'en' ? 1 : 0];
}
