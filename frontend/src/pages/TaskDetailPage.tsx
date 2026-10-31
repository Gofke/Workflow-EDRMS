import { Archive, Check, Paperclip, Plus, Send, X } from 'lucide-react';
import { FormEvent, ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { bytes, dateTime, dueLabel, longDate } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { TASK_STATUS } from '../lib/labels';
import { Avatar, Badge, Confirm, Due, ErrorNote, Field, KV, Loading, Notice, PageHead, Panel, PriorityBadge, Stamp, TaskStatusBadge, useToast } from '../ui';
import { PersonSelect, usePeople } from '../ui/people';
import { OPEN_TASK, TaskRow, TaskView } from '../ui/records';
import { NewTaskDialog } from '../ui/tasks';

interface Detail {
  task: TaskView & { audienceCount: number; cancelledReason: string | null; archivedAt: string | null };
  checklist: { id: string; label: string; position: number; done: boolean; doneAt: string | null; doneByName: string | null }[];
  subtasks: TaskView[];
  comments: { id: string; body: string; createdAt: string; authorName: string; authorAccountId: string }[];
  attachments: { id: string; filename: string; byteSize: number; uploadedAt: string; uploadedByName: string }[];
  audience: { accountId: string; name: string }[];
  events: { eventType: string; fromValue: string | null; toValue: string | null; note: string | null; occurredAt: string; actorName: string; onBehalfOfName: string | null }[];
  permissions: { canEdit: boolean; canChangeStatus: boolean; canAcceptOrReject: boolean; canComplete: boolean; canCancel: boolean; canArchive: boolean; canComment: boolean; canAddSubtask: boolean };
}

/** Mentions are stored as @[Name](accountId) and shown as a name. */
function renderBody(body: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /@\[([^\]]+)\]\(([0-9a-f-]{36})\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    parts.push(body.slice(last, m.index));
    parts.push(
      <strong key={m.index} style={{ color: 'var(--info)' }}>
        @{m[1]}
      </strong>,
    );
    last = m.index + m[0].length;
  }
  parts.push(body.slice(last));
  return parts;
}

export default function TaskDetailPage() {
  const { id } = useParams() as { id: string };
  const { t, language } = usePrefs();
  const { client } = useSession();
  const toast = useToast();
  const d = useApi<Detail>(`/api/tasks/${id}`);
  const action = useAction();
  const [dialog, setDialog] = useState<null | 'reject' | 'cancel' | 'edit' | 'subtask'>(null);
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [mention, setMention] = useState('');
  const [newItem, setNewItem] = useState('');
  const people = usePeople();

  if (d.error) return <ErrorNote error={d.error} />;
  if (!d.data) return <Loading lines={8} />;
  const { task, checklist, subtasks, comments, attachments, events, permissions: can } = d.data;
  const open = OPEN_TASK.includes(task.status);

  const changed = async (message: string) => {
    toast(message);
    setDialog(null);
    setReason('');
    await d.reload();
    window.dispatchEvent(new CustomEvent('juspol:changed'));
  };
  const post = (path: string, body: object, message: string) =>
    action.run(async () => {
      await api.post(`/api/tasks/${task.id}${path}`, { version: task.version, ...body });
      await changed(message);
    });

  const remaining = checklist.filter((c) => !c.done).length;
  const blockedByChecklist = client?.tasks.requireChecklistForCompletion && remaining > 0;
  const blockedBySubtasks = client?.tasks.requireSubtasksForCompletion && task.subtaskOpen > 0;

  const addComment = (e: FormEvent) => {
    e.preventDefault();
    const person = people.find((p) => p.accountId === mention);
    const body = person ? `@[${person.personName}](${person.accountId}) ${comment.trim()}` : comment.trim();
    void action.run(async () => {
      await api.post(`/api/tasks/${task.id}/comments`, { body });
      setComment('');
      setMention('');
      await d.reload();
    });
  };

  return (
    <>
      <PageHead
        crumbs={[{ to: '/taken', label: t('Taken', 'Tasks') }]}
        title={
          <span className="stack" style={{ gap: 8 }}>
            <span className="row" style={{ gap: 10 }}>
              <span className="stamp">{task.reference}</span>
              <TaskStatusBadge status={task.status} />
              <PriorityBadge priority={task.priority} />
              {task.recurrence !== 'NONE' && <Badge tone="info">{task.recurrence === 'WEEKLY' ? t('Elke week', 'Weekly') : t('Elke maand', 'Monthly')}</Badge>}
              {task.source !== 'MANUAL' && <Badge tone={['AI_PROPOSAL', 'MEETING_NOTES', 'CHAT'].includes(task.source) ? 'assist' : 'neutral'}>{sourceLabel(t, task.source)}</Badge>}
            </span>
            <span>{task.title}</span>
          </span>
        }
        actions={
          <>
            {can.canAcceptOrReject && task.status === 'OPEN' && (
              <>
                <button type="button" className="btn" disabled={action.busy} onClick={() => void post('/accept', {}, t('Geaccepteerd', 'Accepted'))}>
                  <Check size={17} /> {t('Accepteren', 'Accept')}
                </button>
                <button type="button" className="btn danger" onClick={() => setDialog('reject')}>
                  <X size={17} /> {t('Weigeren', 'Decline')}
                </button>
              </>
            )}
            {can.canComplete && open && (
              <button type="button" className="btn ok solid" disabled={action.busy || Boolean(blockedByChecklist) || Boolean(blockedBySubtasks)} onClick={() => void post('/complete', {}, t('Taak afgerond', 'Task completed'))} data-testid="complete">
                <Check size={17} /> {t('Afronden', 'Complete')}
              </button>
            )}
            {can.canArchive && !open && !task.archivedAt && (
              <button type="button" className="btn" onClick={() => void post('/archive', {}, t('Gearchiveerd', 'Archived'))}>
                <Archive size={17} /> {t('Archiveren', 'Archive')}
              </button>
            )}
          </>
        }
      />
      <ErrorNote error={action.error} />
      {(blockedByChecklist || blockedBySubtasks) && open && can.canComplete && (
        <div style={{ marginBottom: 14 }}>
          <Notice tone="info">
            {blockedByChecklist ? t(`Nog ${remaining} ${remaining === 1 ? 'controlepunt' : 'controlepunten'} open. `, `${remaining} checklist ${remaining === 1 ? 'point' : 'points'} left. `) : ''}
            {blockedBySubtasks ? t(`Nog ${task.subtaskOpen} ${task.subtaskOpen === 1 ? 'deeltaak' : 'deeltaken'} open.`, `${task.subtaskOpen} ${task.subtaskOpen === 1 ? 'subtask' : 'subtasks'} still open.`) : ''} {t('Afronden kan als alles klaar is.', 'You can complete once everything is done.')}
          </Notice>
        </div>
      )}
      {task.rejectionReason && task.status === 'REJECTED' && (
        <div style={{ marginBottom: 14 }}>
          <Notice tone="warn" title={t('Geweigerd', 'Declined')}>
            {task.rejectionReason}
          </Notice>
        </div>
      )}
      <div className="split">
        <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
          {task.description && (
            <Panel title={t('Toelichting', 'Details')}>
              <p className="pre">{task.description}</p>
            </Panel>
          )}
          <Panel title={`${t('Checklist', 'Checklist')}${checklist.length ? ` (${checklist.length - remaining}/${checklist.length})` : ''}`}>
            <div className="stack" style={{ gap: 8 }}>
              {checklist.map((c) => (
                <label key={c.id} className="check" style={{ alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={c.done} disabled={!can.canChangeStatus || action.busy} onChange={(e) => void action.run(async () => (await api.patch(`/api/tasks/${task.id}/checklist/${c.id}`, { done: e.target.checked }), await d.reload()))} />
                  <span>
                    <span style={c.done ? { textDecoration: 'line-through', color: 'var(--muted)' } : undefined}>{c.label}</span>
                    {c.done && c.doneByName && (
                      <span className="xs muted">
                        {' '}
                        — {c.doneByName}, {dateTime(c.doneAt, language)}
                      </span>
                    )}
                  </span>
                </label>
              ))}
              {can.canEdit && open && (
                <form
                  className="row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (newItem.trim()) void action.run(async () => (await api.post(`/api/tasks/${task.id}/checklist`, { label: newItem.trim() }), setNewItem(''), await d.reload()));
                  }}
                >
                  <input className="input grow" value={newItem} onChange={(e) => setNewItem(e.target.value)} placeholder={t('Punt toevoegen', 'Add a point')} aria-label={t('Punt toevoegen', 'Add a point')} />
                  <button className="btn sm" type="submit">
                    <Plus size={15} />
                  </button>
                </form>
              )}
              {checklist.length === 0 && !can.canEdit && <p className="small muted">{t('Geen checklist.', 'No checklist.')}</p>}
            </div>
          </Panel>
          <Panel
            title={t('Deeltaken', 'Subtasks')}
            actions={
              can.canAddSubtask &&
              !task.parentTaskId && (
                <button type="button" className="btn sm" onClick={() => setDialog('subtask')}>
                  <Plus size={15} /> {t('Deeltaak', 'Subtask')}
                </button>
              )
            }
            flush
          >
            {subtasks.length ? (
              <ul className="list">
                {subtasks.map((s) => (
                  <li key={s.id}>
                    <TaskRow task={s} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted" style={{ padding: '4px 20px 14px' }}>
                {t('Geen deeltaken.', 'No subtasks.')}
              </p>
            )}
          </Panel>
          <Panel title={t('Overleg', 'Discussion')}>
            <div className="stack">
              {comments.map((c) => (
                <div key={c.id} className="row top" style={{ gap: 10 }}>
                  <Avatar name={c.authorName} small />
                  <div className="grow">
                    <div className="small">
                      <strong>{c.authorName}</strong> <span className="muted">{dateTime(c.createdAt, language)}</span>
                    </div>
                    <p>{renderBody(c.body)}</p>
                  </div>
                </div>
              ))}
              {comments.length === 0 && <p className="small muted">{t('Nog geen opmerkingen.', 'No comments yet.')}</p>}
              {can.canComment && (
                <form className="stack" onSubmit={addComment}>
                  <textarea className="textarea" style={{ minHeight: 80 }} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('Schrijf een opmerking…', 'Write a comment…')} aria-label={t('Opmerking', 'Comment')} />
                  <div className="row">
                    <span className="small muted">{t('Iemand vermelden:', 'Mention someone:')}</span>
                    <div style={{ minWidth: 240 }}>
                      <PersonSelect value={mention} onChange={setMention} placeholder={t('niemand', 'nobody')} />
                    </div>
                    <button type="submit" className="btn primary sm" disabled={!comment.trim() || action.busy}>
                      <Send size={15} /> {t('Plaatsen', 'Post')}
                    </button>
                  </div>
                  <span className="xs muted">{t('Wie u vermeldt, krijgt een melding.', 'Whoever you mention is notified.')}</span>
                </form>
              )}
            </div>
          </Panel>
        </div>
        <div className="stack side-sticky" style={{ '--gap': '18px' } as React.CSSProperties}>
          <Panel
            title={t('Gegevens', 'Details')}
            actions={
              can.canEdit &&
              open && (
                <button type="button" className="btn sm ghost" onClick={() => setDialog('edit')}>
                  {t('Wijzigen', 'Edit')}
                </button>
              )
            }
          >
            <KV
              rows={[
                [t('Uitvoerder', 'Assignee'), task.assignee.name],
                [t('Opdrachtgever', 'Owner'), task.owner.name],
                [
                  t('Termijn', 'Due'),
                  task.dueDate ? (
                    open ? (
                      <span key="d">
                        {longDate(task.dueDate, language)}
                        {/* Near or past the deadline, say so; further away the date is enough. */}
                        {dueLabel(task.dueDate, language).tone && (
                          <>
                            {' — '}
                            <Due date={task.dueDate} />
                          </>
                        )}
                      </span>
                    ) : (
                      <span key="d">
                        {longDate(task.dueDate, language)}
                        {task.completedAt &&
                          (() => {
                            // The day it was finished, in Suriname time.
                            const day = new Date(Date.parse(task.completedAt) - 3 * 3600_000).toISOString().slice(0, 10);
                            return day <= task.dueDate
                              ? t(` — op tijd afgerond, ${longDate(day, language)}`, ` — finished on time, ${longDate(day, language)}`)
                              : t(` — afgerond na de termijn, ${longDate(day, language)}`, ` — finished after the deadline, ${longDate(day, language)}`);
                          })()}
                      </span>
                    )
                  ) : (
                    '—'
                  ),
                ],
                [t('Zaak', 'Matter'), task.dossier ? <Link key="z" to={`/zaken/${task.dossier.id}`}>{task.dossier.identity} — {task.dossier.subject}</Link> : '—'],
                [t('Brief', 'Letter'), task.item ? <span key="i" className="row" style={{ gap: 6 }}><Stamp value={task.item.identity} to={`/post/${task.item.id}`} /> {task.item.subject}</span> : '—'],
                ...(task.project
                  ? ([
                      [t('Project', 'Project'), <Link key="p" to={`/projecten/${task.project.id}`}>{task.project.reference} — {task.project.name}</Link>],
                      [t('Fase', 'Phase'), task.project.milestoneName],
                      [t('Start', 'Start'), task.startDate ? longDate(task.startDate, language) : '—'],
                    ] as [ReactNode, ReactNode][])
                  : []),
                [t('Hoofdtaak', 'Parent task'), task.parentTaskId ? <Link key="p" to={`/taken/${task.parentTaskId}`}>{task.parentReference}</Link> : '—'],
                [t('Aangemaakt', 'Created'), `${dateTime(task.createdAt, language)}, ${task.createdBy.name}`],
              ]}
            />
            {can.canChangeStatus && open && (
              <div className="row" style={{ marginTop: 14 }}>
                <select
                  className="select"
                  value=""
                  aria-label={t('Status wijzigen', 'Change status')}
                  onChange={(e) => e.target.value && void post('/status', { status: e.target.value }, t('Status bijgewerkt', 'Status updated'))}
                >
                  <option value="">{t('Status wijzigen…', 'Change status…')}</option>
                  {['IN_PROGRESS', 'WAITING', 'IN_REVIEW']
                    .filter((s) => s !== task.status)
                    .map((s) => (
                      <option key={s} value={s}>
                        {{ IN_PROGRESS: t('Bezig', 'In progress'), WAITING: t('Wacht op iets of iemand', 'Waiting'), IN_REVIEW: t('Ter controle', 'In review') }[s]}
                      </option>
                    ))}
                </select>
                {can.canCancel && (
                  <button type="button" className="btn sm danger" onClick={() => setDialog('cancel')}>
                    {t('Annuleren', 'Cancel task')}
                  </button>
                )}
              </div>
            )}
          </Panel>
          <Panel
            title={t('Bijlagen', 'Attachments')}
            actions={
              can.canComment && (
                <label className="btn sm">
                  <Paperclip size={15} /> {t('Toevoegen', 'Add')}
                  <input type="file" hidden onChange={(e) => e.target.files?.[0] && void action.run(async () => (await api.upload(`/api/tasks/${task.id}/attachments`, 'file', e.target.files![0]), await d.reload()))} />
                </label>
              )
            }
            flush
          >
            <ul className="list">
              {attachments.map((a) => (
                <li key={a.id}>
                  <button type="button" className="btn link" onClick={() => void api.download(`/api/tasks/${task.id}/attachments/${a.id}/content`, a.filename)}>
                    {a.filename}
                  </button>
                  <div className="xs muted">
                    {bytes(a.byteSize)}, {a.uploadedByName}
                  </div>
                </li>
              ))}
              {attachments.length === 0 && <li className="small muted">{t('Geen bijlagen.', 'No attachments.')}</li>}
            </ul>
          </Panel>
          <Panel title={t('Geschiedenis', 'History')}>
            <ol className="timeline">
              {[...events].reverse().map((e, i) => (
                <li key={i} className={e.eventType === 'COMPLETED' ? 'ok' : e.eventType === 'REJECTED' || e.eventType === 'CANCELLED' ? 'danger' : ''}>
                  <strong className="small">{eventLabel(t, e.eventType, e.toValue)}</strong>
                  <div className="xs">
                    {e.actorName}
                    {e.note ? ` — ${e.note}` : ''}
                  </div>
                  <div className="when">{dateTime(e.occurredAt, language)}</div>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      </div>
      {(dialog === 'reject' || dialog === 'cancel') && (
        <Confirm
          title={dialog === 'reject' ? t('Taak weigeren', 'Decline task') : t('Taak annuleren', 'Cancel task')}
          confirmLabel={dialog === 'reject' ? t('Weigeren', 'Decline') : t('Annuleren', 'Cancel task')}
          danger
          onClose={() => setDialog(null)}
          busy={action.busy}
          error={action.error}
          disabled={!reason.trim()}
          onConfirm={() => void post(dialog === 'reject' ? '/reject' : '/cancel', { reason }, dialog === 'reject' ? t('Geweigerd', 'Declined') : t('Geannuleerd', 'Cancelled'))}
        >
          <Field label={t('Reden', 'Reason')} hint={dialog === 'reject' ? t('De opdrachtgever krijgt de reden te zien.', 'The owner sees the reason.') : undefined}>
            <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </Confirm>
      )}
      {dialog === 'edit' && <EditTask task={task} onClose={() => setDialog(null)} onSaved={() => void changed(t('Opgeslagen', 'Saved'))} />}
      {dialog === 'subtask' && <NewTaskDialog parentTaskId={task.id} dossierId={task.dossier?.id} onClose={() => setDialog(null)} onCreated={() => void d.reload()} />}
    </>
  );
}

function EditTask({ task, onClose, onSaved }: { task: TaskView; onClose: () => void; onSaved: () => void }) {
  const { t } = usePrefs();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [assignee, setAssignee] = useState(task.assignee.accountId);
  const [due, setDue] = useState(task.dueDate ?? '');
  const [priority, setPriority] = useState(task.priority);
  const { busy, error, run } = useAction();
  return (
    <Confirm
      title={t('Taak wijzigen', 'Edit task')}
      confirmLabel={t('Opslaan', 'Save')}
      onClose={onClose}
      busy={busy}
      error={error}
      disabled={!title.trim()}
      onConfirm={() => void run(async () => (await api.put(`/api/tasks/${task.id}`, { version: task.version, title: title.trim(), description, assigneeAccountId: assignee, dueDate: due || null, priority }), onSaved()))}
    >
      <Field label={t('Titel', 'Title')}>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label={t('Toelichting', 'Details')}>
        <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="form-grid">
        <Field label={t('Uitvoerder', 'Assignee')}>
          <PersonSelect value={assignee} onChange={setAssignee} />
        </Field>
        <Field label={t('Termijn', 'Due')}>
          <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
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
    </Confirm>
  );
}

function sourceLabel(t: (nl: string, en: string) => string, s: string) {
  return (
    {
      TEMPLATE: t('Uit sjabloon', 'From template'),
      AI_PROPOSAL: t('Voorstel assistent', 'Assistant proposal'),
      MEETING_NOTES: t('Uit notulen', 'From meeting notes'),
      CHAT: t('Via de assistent', 'Via the assistant'),
      RECURRENCE: t('Herhaling', 'Repeat'),
      BULK: t('Bulk', 'Bulk'),
    }[s] ?? s
  );
}

function eventLabel(t: (nl: string, en: string) => string, e: string, to: string | null) {
  return (
    {
      CREATED: t('Aangemaakt', 'Created'),
      UPDATED: t('Gewijzigd', 'Updated'),
      ASSIGNED: t(`Toegewezen${to ? ` aan ${to}` : ''}`, `Assigned${to ? ` to ${to}` : ''}`),
      STATUS_CHANGED: t(`Status: ${(to && TASK_STATUS[to]?.[0]) ?? to ?? ''}`, `Status: ${(to && TASK_STATUS[to]?.[1]) ?? to ?? ''}`),
      CHECKLIST_ADDED: t('Checklistpunt toegevoegd', 'Checklist point added'),
      CHECKLIST_UNDONE: t('Checklistpunt heropend', 'Checklist point reopened'),
      CHECKLIST_REMOVED: t('Checklistpunt verwijderd', 'Checklist point removed'),
      CHECKLIST_RENAMED: t('Checklistpunt hernoemd', 'Checklist point renamed'),
      ACCEPTED: t('Geaccepteerd', 'Accepted'),
      REJECTED: t('Geweigerd', 'Declined'),
      COMPLETED: t('Afgerond', 'Completed'),
      CANCELLED: t('Geannuleerd', 'Cancelled'),
      ARCHIVED: t('Gearchiveerd', 'Archived'),
      COMMENTED: t('Opmerking geplaatst', 'Comment posted'),
      ATTACHMENT_ADDED: t('Bijlage toegevoegd', 'Attachment added'),
      CHECKLIST_DONE: t('Checklistpunt afgevinkt', 'Checklist point done'),
    }[e] ?? e.toLowerCase().replace(/_/g, ' ')
  );
}
