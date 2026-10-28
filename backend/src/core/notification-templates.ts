/**
 * The words of every notification, in Dutch and English. A notification is
 * stored in the recipient's own language, chosen on their profile.
 */
export type NotificationKind =
  | 'TASK_ASSIGNED'
  | 'TASK_UPDATED'
  | 'TASK_COMMENT'
  | 'TASK_MENTION'
  | 'TASK_COMPLETED'
  | 'TASK_REJECTED'
  | 'TASK_CANCELLED'
  | 'REVIEW_REQUESTED'
  | 'MATTER_RETURNED'
  | 'MATTER_APPROVED'
  | 'MATTER_FINALISED'
  | 'RESPONSIBILITY_ASSIGNED'
  | 'ADVICE_REQUESTED'
  | 'ADVICE_GIVEN'
  | 'DEADLINE_REMINDER'
  | 'DEADLINE_OVERDUE'
  | 'DEADLINE_ESCALATION'
  | 'SECURITY_ALERT'
  | 'OUT_OF_OFFICE'
  | 'WEEKLY_REPORT'
  | 'INTAKE_RECEIVED'
  | 'SYSTEM';

export const ALL_KINDS: NotificationKind[] = [
  'TASK_ASSIGNED', 'TASK_UPDATED', 'TASK_COMMENT', 'TASK_MENTION', 'TASK_COMPLETED', 'TASK_REJECTED',
  'TASK_CANCELLED', 'REVIEW_REQUESTED', 'MATTER_RETURNED', 'MATTER_APPROVED', 'MATTER_FINALISED',
  'RESPONSIBILITY_ASSIGNED', 'ADVICE_REQUESTED', 'ADVICE_GIVEN', 'DEADLINE_REMINDER', 'DEADLINE_OVERDUE',
  'DEADLINE_ESCALATION', 'SECURITY_ALERT', 'OUT_OF_OFFICE', 'WEEKLY_REPORT', 'INTAKE_RECEIVED', 'SYSTEM',
];

/** Defaults when a person has not chosen otherwise. */
export const DEFAULT_CHANNELS: Record<NotificationKind, { email: boolean; sms: boolean; push: boolean }> = {
  TASK_ASSIGNED: { email: true, sms: false, push: true },
  TASK_UPDATED: { email: false, sms: false, push: false },
  TASK_COMMENT: { email: false, sms: false, push: true },
  TASK_MENTION: { email: true, sms: false, push: true },
  TASK_COMPLETED: { email: false, sms: false, push: true },
  TASK_REJECTED: { email: true, sms: false, push: true },
  TASK_CANCELLED: { email: false, sms: false, push: true },
  REVIEW_REQUESTED: { email: true, sms: false, push: true },
  MATTER_RETURNED: { email: true, sms: false, push: true },
  MATTER_APPROVED: { email: true, sms: false, push: true },
  MATTER_FINALISED: { email: false, sms: false, push: true },
  RESPONSIBILITY_ASSIGNED: { email: true, sms: false, push: true },
  ADVICE_REQUESTED: { email: true, sms: false, push: true },
  ADVICE_GIVEN: { email: true, sms: false, push: true },
  DEADLINE_REMINDER: { email: true, sms: false, push: true },
  DEADLINE_OVERDUE: { email: true, sms: false, push: true },
  DEADLINE_ESCALATION: { email: true, sms: true, push: true },
  SECURITY_ALERT: { email: true, sms: true, push: true },
  OUT_OF_OFFICE: { email: false, sms: false, push: true },
  WEEKLY_REPORT: { email: true, sms: false, push: false },
  INTAKE_RECEIVED: { email: false, sms: false, push: true },
  SYSTEM: { email: false, sms: false, push: false },
};

type Params = Record<string, string | number | null | undefined>;
type Template = { title: (p: Params) => string; body: (p: Params) => string };

const nl: Record<NotificationKind, Template> = {
  TASK_ASSIGNED: { title: (p) => `Nieuwe taak: ${p.title}`, body: (p) => `${p.actor} heeft u taak ${p.reference} toegewezen${p.due ? `, termijn ${p.due}` : ''}.` },
  TASK_UPDATED: { title: (p) => `Taak gewijzigd: ${p.title}`, body: (p) => `${p.actor} heeft ${p.reference} gewijzigd: ${p.change}.` },
  TASK_COMMENT: { title: (p) => `Reactie op ${p.reference}`, body: (p) => `${p.actor}: ${p.excerpt}` },
  TASK_MENTION: { title: (p) => `${p.actor} noemde u in ${p.reference}`, body: (p) => `${p.excerpt}` },
  TASK_COMPLETED: { title: (p) => `Taak afgerond: ${p.title}`, body: (p) => `${p.actor} heeft ${p.reference} afgerond.` },
  TASK_REJECTED: { title: (p) => `Taak geweigerd: ${p.title}`, body: (p) => `${p.actor} heeft ${p.reference} geweigerd. Reden: ${p.reason}` },
  TASK_CANCELLED: { title: (p) => `Taak geannuleerd: ${p.title}`, body: (p) => `${p.actor} heeft ${p.reference} geannuleerd. Reden: ${p.reason}` },
  REVIEW_REQUESTED: { title: (p) => `Ter beoordeling: ${p.identity}`, body: (p) => `${p.actor} vraagt uw beslissing over ${p.identity} — ${p.subject}.` },
  MATTER_RETURNED: { title: (p) => `Teruggestuurd: ${p.identity}`, body: (p) => `${p.actor} heeft ${p.identity} teruggestuurd ter correctie. Reden: ${p.reason}` },
  MATTER_APPROVED: { title: (p) => `Goedgekeurd: ${p.identity}`, body: (p) => `${p.actor} heeft ${p.identity} goedgekeurd.` },
  MATTER_FINALISED: { title: (p) => `Afgerond: ${p.identity}`, body: (p) => `${p.actor} heeft ${p.identity} definitief afgerond.` },
  RESPONSIBILITY_ASSIGNED: { title: (p) => `U bent verantwoordelijk voor ${p.identity}`, body: (p) => `${p.actor} heeft u verantwoordelijk gemaakt voor ${p.identity} — ${p.subject}.` },
  ADVICE_REQUESTED: { title: (p) => `Adviesaanvraag: ${p.identity}`, body: (p) => `${p.actor} vraagt uw advies${p.due ? ` vóór ${p.due}` : ''}: ${p.excerpt}` },
  ADVICE_GIVEN: { title: (p) => `Advies ontvangen: ${p.identity}`, body: (p) => `${p.actor} heeft advies gegeven over ${p.identity}.` },
  DEADLINE_REMINDER: { title: (p) => `Herinnering: ${p.label} verloopt over ${p.days} werkdag(en)`, body: (p) => `De termijn van ${p.label} is ${p.due}.` },
  DEADLINE_OVERDUE: { title: (p) => `Termijn verstreken: ${p.label}`, body: (p) => `De termijn van ${p.label} was ${p.due}.` },
  DEADLINE_ESCALATION: { title: (p) => `Escalatie: ${p.label} is ${p.days} werkdag(en) over tijd`, body: (p) => `${p.person} is verantwoordelijk. De termijn was ${p.due}.` },
  SECURITY_ALERT: { title: (p) => `Beveiligingsmelding: ${p.what}`, body: (p) => `${p.detail}` },
  OUT_OF_OFFICE: { title: (p) => `U vervangt ${p.person}`, body: (p) => `${p.person} is afwezig van ${p.from} tot en met ${p.until}. Meldingen voor ${p.person} komen ook bij u.` },
  WEEKLY_REPORT: { title: () => 'Weekoverzicht', body: (p) => `${p.summary}` },
  INTAKE_RECEIVED: { title: (p) => `Nieuwe binnenkomende post: ${p.subject}`, body: (p) => `Via ${p.channel}. Ter registratie klaargezet.` },
  SYSTEM: { title: (p) => `${p.title}`, body: (p) => `${p.body ?? ''}` },
};

const en: Record<NotificationKind, Template> = {
  TASK_ASSIGNED: { title: (p) => `New task: ${p.title}`, body: (p) => `${p.actor} assigned task ${p.reference} to you${p.due ? `, due ${p.due}` : ''}.` },
  TASK_UPDATED: { title: (p) => `Task changed: ${p.title}`, body: (p) => `${p.actor} changed ${p.reference}: ${p.change}.` },
  TASK_COMMENT: { title: (p) => `Comment on ${p.reference}`, body: (p) => `${p.actor}: ${p.excerpt}` },
  TASK_MENTION: { title: (p) => `${p.actor} mentioned you in ${p.reference}`, body: (p) => `${p.excerpt}` },
  TASK_COMPLETED: { title: (p) => `Task completed: ${p.title}`, body: (p) => `${p.actor} completed ${p.reference}.` },
  TASK_REJECTED: { title: (p) => `Task declined: ${p.title}`, body: (p) => `${p.actor} declined ${p.reference}. Reason: ${p.reason}` },
  TASK_CANCELLED: { title: (p) => `Task cancelled: ${p.title}`, body: (p) => `${p.actor} cancelled ${p.reference}. Reason: ${p.reason}` },
  REVIEW_REQUESTED: { title: (p) => `For your decision: ${p.identity}`, body: (p) => `${p.actor} asks for your decision on ${p.identity} — ${p.subject}.` },
  MATTER_RETURNED: { title: (p) => `Returned: ${p.identity}`, body: (p) => `${p.actor} returned ${p.identity} for correction. Reason: ${p.reason}` },
  MATTER_APPROVED: { title: (p) => `Approved: ${p.identity}`, body: (p) => `${p.actor} approved ${p.identity}.` },
  MATTER_FINALISED: { title: (p) => `Finalised: ${p.identity}`, body: (p) => `${p.actor} finalised ${p.identity}.` },
  RESPONSIBILITY_ASSIGNED: { title: (p) => `You are responsible for ${p.identity}`, body: (p) => `${p.actor} made you responsible for ${p.identity} — ${p.subject}.` },
  ADVICE_REQUESTED: { title: (p) => `Advice requested: ${p.identity}`, body: (p) => `${p.actor} asks for your advice${p.due ? ` by ${p.due}` : ''}: ${p.excerpt}` },
  ADVICE_GIVEN: { title: (p) => `Advice received: ${p.identity}`, body: (p) => `${p.actor} gave advice on ${p.identity}.` },
  DEADLINE_REMINDER: { title: (p) => `Reminder: ${p.label} is due in ${p.days} working day(s)`, body: (p) => `${p.label} is due on ${p.due}.` },
  DEADLINE_OVERDUE: { title: (p) => `Deadline passed: ${p.label}`, body: (p) => `${p.label} was due on ${p.due}.` },
  DEADLINE_ESCALATION: { title: (p) => `Escalation: ${p.label} is ${p.days} working day(s) overdue`, body: (p) => `${p.person} is responsible. It was due on ${p.due}.` },
  SECURITY_ALERT: { title: (p) => `Security alert: ${p.what}`, body: (p) => `${p.detail}` },
  OUT_OF_OFFICE: { title: (p) => `You are standing in for ${p.person}`, body: (p) => `${p.person} is away from ${p.from} to ${p.until}. Notifications for ${p.person} also reach you.` },
  WEEKLY_REPORT: { title: () => 'Weekly overview', body: (p) => `${p.summary}` },
  INTAKE_RECEIVED: { title: (p) => `New incoming mail: ${p.subject}`, body: (p) => `Via ${p.channel}. Ready to register.` },
  SYSTEM: { title: (p) => `${p.title}`, body: (p) => `${p.body ?? ''}` },
};

export function render(kind: NotificationKind, params: Params, language: 'nl' | 'en') {
  const t = (language === 'en' ? en : nl)[kind];
  return { title: clip(t.title(params), 300), body: clip(t.body(params), 1000) };
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
