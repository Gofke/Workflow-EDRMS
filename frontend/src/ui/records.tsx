import { CheckSquare, ListChecks, MessageSquare, Paperclip } from 'lucide-react';
import { Link } from 'react-router-dom';
import { usePrefs } from '../lib/prefs';
import { Due, PriorityBadge, Stamp, TaskStatusBadge } from './index';

export interface TaskView {
  id: string;
  reference: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  dueDate: string | null;
  overdue: boolean;
  dueInWorkingDays: number | null;
  assignee: { accountId: string; name: string };
  owner: { accountId: string; name: string };
  createdBy: { accountId: string; name: string };
  dossier: { id: string; identity: string; subject: string } | null;
  item: { id: string; identity: string | null; subject: string } | null;
  /** Set when the task is a ticket in a project phase. */
  project?: { id: string; reference: string; name: string; milestoneId: string; milestoneName: string } | null;
  startDate?: string | null;
  parentTaskId: string | null;
  parentReference: string | null;
  checklistDone: number;
  checklistTotal: number;
  subtaskOpen: number;
  subtaskTotal: number;
  commentCount: number;
  attachmentCount: number;
  recurrence: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  rejectionReason: string | null;
  version: number;
}

export const OPEN_TASK = ['OPEN', 'ACCEPTED', 'IN_PROGRESS', 'WAITING', 'IN_REVIEW'];

/** One task in a list: what, for whom, by when, how far. */
export function TaskRow({ task, showAssignee = true }: { task: TaskView; showAssignee?: boolean }) {
  const { t } = usePrefs();
  const done = !OPEN_TASK.includes(task.status);
  return (
    <Link to={`/taken/${task.id}`} className="list-link">
      <CheckSquare size={18} style={{ marginTop: 3, color: done ? 'var(--ok)' : 'var(--muted)', flex: 'none' }} aria-hidden="true" />
      <span className="grow stack" style={{ gap: 3 }}>
        <span className="row" style={{ gap: 8 }}>
          <span className="list-title">{task.title}</span>
          <PriorityBadge priority={task.priority} quiet />
          {task.status !== 'OPEN' && <TaskStatusBadge status={task.status} />}
        </span>
        <span className="meta">
          <span>{task.reference}</span>
          {showAssignee && <span>{task.assignee.name}</span>}
          {task.dossier && <span>{task.dossier.identity}</span>}
          {task.project && <span>{task.project.reference}</span>}
          {task.checklistTotal > 0 && (
            <span>
              <ListChecks size={13} aria-hidden="true" /> {task.checklistDone}/{task.checklistTotal}
            </span>
          )}
          {task.commentCount > 0 && (
            <span>
              <MessageSquare size={13} aria-hidden="true" /> {task.commentCount}
            </span>
          )}
          {task.attachmentCount > 0 && (
            <span>
              <Paperclip size={13} aria-hidden="true" /> {task.attachmentCount}
            </span>
          )}
          {task.subtaskTotal > 0 && <span>{t(`${task.subtaskTotal - task.subtaskOpen}/${task.subtaskTotal} deeltaken`, `${task.subtaskTotal - task.subtaskOpen}/${task.subtaskTotal} subtasks`)}</span>}
        </span>
      </span>
      <Due date={task.dueDate} done={done} />
    </Link>
  );
}

export function ItemLink({ id, identity, subject }: { id: string; identity: string | null; subject: string }) {
  return (
    <Link to={`/post/${id}`} className="list-link">
      <Stamp value={identity} />
      <span className="list-title grow">{subject}</span>
    </Link>
  );
}
