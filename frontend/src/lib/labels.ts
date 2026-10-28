/** The vocabulary of the system, in both languages. States are shown as words, never as codes. */
type T = (nl: string, en: string) => string;
type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'assist';

export const DIRECTION = (t: T, d: string) =>
  ({ INCOMING: t('Inkomend', 'Incoming'), OUTGOING: t('Uitgaand', 'Outgoing'), INTERNAL: t('Intern', 'Internal') })[d] ?? d;

export const ITEM_STATE = (t: T, s: string) => ({ DRAFT: t('Concept', 'Draft'), REGISTERED: t('Geregistreerd', 'Registered') })[s] ?? s;

export const SOURCE = (t: T, s: string) =>
  ({
    MANUAL: t('Handmatig', 'Manual'),
    EMAIL: t('E-mail', 'E-mail'),
    WIJSAMEN: 'WijSamen',
    EXCHANGE: t('Uitwisseling', 'Exchange'),
    MOBILE: t('Telefoon', 'Phone'),
    COMPOSED: t('Opgesteld', 'Composed'),
  })[s] ?? s;

export const PROCESSING: Record<string, [string, string, Tone]> = {
  ACTIVE: ['In behandeling', 'In progress', 'info'],
  UNDER_REVIEW: ['Ter beoordeling', 'Under review', 'warn'],
  RETURNED: ['Teruggestuurd', 'Returned', 'danger'],
  APPROVED: ['Goedgekeurd', 'Approved', 'ok'],
  FINALISED: ['Afgerond', 'Finalised', 'ok'],
};

export const TASK_STATUS: Record<string, [string, string, Tone]> = {
  OPEN: ['Open', 'Open', 'neutral'],
  ACCEPTED: ['Geaccepteerd', 'Accepted', 'info'],
  IN_PROGRESS: ['Bezig', 'In progress', 'info'],
  WAITING: ['Wacht', 'Waiting', 'warn'],
  IN_REVIEW: ['Ter controle', 'In review', 'assist'],
  COMPLETED: ['Afgerond', 'Completed', 'ok'],
  REJECTED: ['Geweigerd', 'Rejected', 'danger'],
  CANCELLED: ['Geannuleerd', 'Cancelled', 'neutral'],
};

export const PRIORITY: Record<string, [string, string, Tone]> = {
  LOW: ['Laag', 'Low', 'neutral'],
  MEDIUM: ['Normaal', 'Normal', 'info'],
  HIGH: ['Hoog', 'High', 'warn'],
  URGENT: ['Spoed', 'Urgent', 'danger'],
};

export const CLASSIFICATION: Record<string, [string, string]> = {
  OPEN: ['Openbaar', 'Public'],
  INTERNAL: ['Intern', 'Internal'],
  CONFIDENTIAL: ['Vertrouwelijk', 'Confidential'],
  SECRET: ['Geheim', 'Secret'],
};

export const ROLE: Record<string, [string, string]> = {
  MINISTER: ['Minister', 'Minister'],
  DIRECTEUR: ['Directeur', 'Director'],
  ONDER_DIRECTEUR: ['Onder-Directeur', 'Deputy Director'],
  SUPPORT_STAFF: ['Medewerker', 'Staff member'],
  SYS_ADMIN: ['Systeembeheerder', 'System administrator'],
  AUDITOR: ['Auditor', 'Auditor'],
  RECORDS_MANAGER: ['Archiefbeheerder', 'Records manager'],
};

export const WORKFLOW_EVENT = (t: T, e: string) =>
  ({
    SUBMITTED: t('Ingediend ter beoordeling', 'Submitted for review'),
    APPROVED: t('Goedgekeurd', 'Approved'),
    RETURNED: t('Teruggestuurd', 'Returned'),
    FINALISED: t('Afgerond', 'Finalised'),
    REOPENED: t('Heropend', 'Reopened'),
    FORWARDED: t('Doorgestuurd naar de volgende stap', 'Forwarded to the next step'),
  })[e] ?? e.toLowerCase().replace(/_/g, ' ');

export const ADVICE_STATUS: Record<string, [string, string, Tone]> = {
  OPEN: ['Gevraagd', 'Requested', 'warn'],
  ANSWERED: ['Gegeven', 'Given', 'ok'],
  WITHDRAWN: ['Ingetrokken', 'Withdrawn', 'neutral'],
};

export const RELATION = (t: T, r: string) =>
  ({
    RELATED: t('Verwant', 'Related'),
    FOLLOW_UP: t('Vervolg op', 'Follow-up of'),
    PRECEDES: t('Voorafgaand aan', 'Precedes'),
    SAME_SUBJECT: t('Zelfde onderwerp', 'Same subject'),
  })[r] ?? r;

export const RETENTION_ACTION = (t: T, a: string | null) =>
  a ? ({ DESTROY: t('Vernietigen', 'Destroy'), TRANSFER: t('Overbrengen naar het Nationaal Archief', 'Transfer to the National Archive'), REVIEW: t('Opnieuw beoordelen', 'Review') })[a] ?? a : '—';

export const AI_FEATURE = (t: T, f: string) =>
  ({
    chat: t('Chat-assistent', 'Chat assistant'),
    intake: t('Velden voorstellen bij registratie', 'Propose registration fields'),
    summary: t('Samenvatten', 'Summaries'),
    draftReply: t('Conceptantwoord', 'Draft reply'),
    deadlines: t('Termijnen herkennen', 'Recognise deadlines'),
    duplicates: t('Mogelijke dubbele stukken', 'Possible duplicates'),
    routing: t('Afdeling voorstellen', 'Suggest department'),
    risk: t('Termijnrisico', 'Deadline risk'),
    translate: t('Vertalen', 'Translate'),
    meetingNotes: t('Actiepunten uit notulen', 'Action items from notes'),
    ask: t('Vragen over uw werk', 'Questions about your work'),
  })[f] ?? f;

export function tone<T extends Record<string, [string, string, Tone]>>(map: T, key: string): Tone {
  return map[key]?.[2] ?? 'neutral';
}

/** Dutch and English names of the log's event types; anything new falls back to the code. */
const AUDIT_TYPES: Record<string, [string, string]> = {
  SIGN_IN_SUCCEEDED: ['Aangemeld', 'Signed in'],
  SIGN_IN_FAILED: ['Aanmelden mislukt', 'Sign-in failed'],
  SIGN_OUT: ['Afgemeld', 'Signed out'],
  PASSWORD_CHANGED: ['Wachtwoord gewijzigd', 'Password changed'],
  PASSWORD_RESET: ['Wachtwoord opnieuw ingesteld', 'Password reset'],
  ACCOUNT_LOCKED: ['Account geblokkeerd', 'Account locked'],
  MFA_ENABLED: ['Tweestapsverificatie aan', 'Two-step verification on'],
  MFA_DISABLED: ['Tweestapsverificatie uit', 'Two-step verification off'],
  MFA_FAILED: ['Verificatiecode fout', 'Verification code wrong'],
  ROLE_ASSIGNED: ['Rol toegekend', 'Role assigned'],
  ROLE_REVOKED: ['Rol ingetrokken', 'Role revoked'],
  ACCOUNT_DISABLED: ['Account uitgeschakeld', 'Account disabled'],
  ACCOUNT_ENABLED: ['Account ingeschakeld', 'Account enabled'],
  ACCOUNT_CREATED: ['Account aangemaakt', 'Account created'],
  ACCOUNT_UPDATED: ['Account gewijzigd', 'Account updated'],
  SETTING_CHANGED: ['Instelling gewijzigd', 'Setting changed'],
  UNIT_CREATED: ['Afdeling aangemaakt', 'Department created'],
  UNIT_UPDATED: ['Afdeling gewijzigd', 'Department updated'],
  TASK_TEMPLATE_SAVED: ['Takensjabloon opgeslagen', 'Task template saved'],
  HOLIDAY_CHANGED: ['Feestdagen gewijzigd', 'Holidays changed'],
  LETTER_TEMPLATE_SAVED: ['Briefsjabloon opgeslagen', 'Letter template saved'],
  CATEGORY_SAVED: ['Archiefcategorie opgeslagen', 'File category saved'],
  ROUTE_SAVED: ['Goedkeuringsroute opgeslagen', 'Approval route saved'],
  TRAINING_DATA_LOADED: ['Oefengegevens geladen', 'Training data loaded'],
  DRAFT_CREATED: ['Concept aangemaakt', 'Draft created'],
  ITEM_REGISTERED: ['Geregistreerd', 'Registered'],
  DOCUMENT_CAPTURED: ['Document toegevoegd', 'Document added'],
  DOCUMENT_RETRIEVED: ['Document geopend', 'Document opened'],
  DOCUMENT_INTEGRITY_FAILED: ['Document gewijzigd of zoek', 'Document altered or missing'],
  DOCUMENT_REJECTED_MALWARE: ['Besmet bestand geweigerd', 'Infected file refused'],
  DRAFT_VERSION_SAVED: ['Versie opgeslagen', 'Version saved'],
  LETTER_COMPOSED: ['Brief opgemaakt', 'Letter composed'],
  LABEL_PRINTED: ['Etiket afgedrukt', 'Label printed'],
  EMAIL_INTAKE_RECEIVED: ['E-mail ontvangen', 'E-mail received'],
  SEAL_APPLIED: ['Zegel geplaatst', 'Seal applied'],
  DOSSIER_CREATED: ['Zaak aangemaakt', 'Matter created'],
  RECORD_LINKED: ['Stuk aan zaak gekoppeld', 'Record linked to matter'],
  RESPONSIBILITY_ASSIGNED: ['Verantwoordelijke aangewezen', 'Responsible official assigned'],
  RESPONSIBILITY_REASSIGNED: ['Verantwoordelijke gewijzigd', 'Responsible official changed'],
  DUE_DATE_SET: ['Termijn gezet', 'Deadline set'],
  DUE_DATE_CHANGED: ['Termijn gewijzigd', 'Deadline changed'],
  DELEGATION_GRANTED: ['Mandaat verleend', 'Delegation granted'],
  DELEGATION_REVOKED: ['Mandaat ingetrokken', 'Delegation revoked'],
  WORKFLOW_SUBMITTED: ['Ter beoordeling aangeboden', 'Submitted for review'],
  WORKFLOW_RETURNED: ['Teruggestuurd', 'Returned'],
  WORKFLOW_APPROVED: ['Goedgekeurd', 'Approved'],
  WORKFLOW_FINALISED: ['Afgerond', 'Finalised'],
  WORKFLOW_REOPENED: ['Heropend', 'Reopened'],
  DOSSIER_CLOSED: ['Zaak gesloten', 'Matter closed'],
  DOSSIER_REOPENED: ['Zaak heropend', 'Matter reopened'],
  TIMELINE_EXPORTED: ['Tijdlijn geëxporteerd', 'Timeline exported'],
  DOSSIER_CATEGORISED: ['Archiefcategorie gezet', 'File category set'],
  DOSSIER_RELATED: ['Zaken verbonden', 'Matters related'],
  ROUTE_STEP_APPROVED: ['Routestap goedgekeurd', 'Route step approved'],
  ADVICE_REQUESTED: ['Advies gevraagd', 'Advice requested'],
  ADVICE_GIVEN: ['Advies gegeven', 'Advice given'],
  ADVICE_WITHDRAWN: ['Adviesvraag ingetrokken', 'Advice request withdrawn'],
  OUT_OF_OFFICE_SET: ['Afwezigheid gemeld', 'Out of office set'],
  OUT_OF_OFFICE_ENDED: ['Afwezigheid beëindigd', 'Out of office ended'],
  CLASSIFICATION_CHANGED: ['Vertrouwelijkheid gewijzigd', 'Confidentiality changed'],
  ACCESS_GRANTED: ['Toegang verleend', 'Access granted'],
  ACCESS_REVOKED: ['Toegang ingetrokken', 'Access revoked'],
  TASK_CREATED: ['Taak aangemaakt', 'Task created'],
  TASK_UPDATED: ['Taak gewijzigd', 'Task updated'],
  TASK_ASSIGNED: ['Taak toegewezen', 'Task assigned'],
  TASK_STATUS_CHANGED: ['Taakstatus gewijzigd', 'Task status changed'],
  TASK_ACCEPTED: ['Taak aanvaard', 'Task accepted'],
  TASK_REJECTED: ['Taak geweigerd', 'Task declined'],
  TASK_COMPLETED: ['Taak afgerond', 'Task completed'],
  TASK_CANCELLED: ['Taak geannuleerd', 'Task cancelled'],
  TASK_ARCHIVED: ['Taak gearchiveerd', 'Task archived'],
  TASK_COMMENTED: ['Opmerking bij taak', 'Task comment'],
  TASK_ATTACHMENT_ADDED: ['Bijlage bij taak', 'Task attachment'],
  REMINDER_SENT: ['Herinnering verstuurd', 'Reminder sent'],
  DEADLINE_ESCALATED: ['Termijn geëscaleerd', 'Deadline escalated'],
  WEEKLY_REPORT_SENT: ['Weekoverzicht verstuurd', 'Weekly report sent'],
  LEGAL_HOLD_SET: ['Bewaarplicht ingesteld', 'Legal hold set'],
  LEGAL_HOLD_RELEASED: ['Bewaarplicht opgeheven', 'Legal hold released'],
  RETENTION_DECIDED: ['Bewaarbesluit', 'Retention decision'],
  ARCHIVE_PACKAGE_EXPORTED: ['Archiefpakket gemaakt', 'Archive package made'],
  TIMELINE_PDF_EXPORTED: ['Tijdlijn als PDF', 'Timeline as PDF'],
  REPORT_EXPORTED: ['Rapport gedownload', 'Report downloaded'],
  AUDIT_EXPORTED: ['Logboek gedownload', 'Log downloaded'],
  INTEGRITY_CHECK_RUN: ['Integriteitscontrole', 'Integrity check'],
  AI_SUGGESTION_ACCEPTED: ['Voorstel assistent overgenomen', 'Assistant suggestion accepted'],
  AI_SUGGESTION_REJECTED: ['Voorstel assistent afgewezen', 'Assistant suggestion rejected'],
  INTEGRATION_KEY_CREATED: ['Koppelsleutel aangemaakt', 'Integration key created'],
  INTEGRATION_KEY_REVOKED: ['Koppelsleutel ingetrokken', 'Integration key revoked'],
  WIJSAMEN_REPORT_RECEIVED: ['Melding WijSamen ontvangen', 'WijSamen report received'],
  EXCHANGE_EXPORTED: ['Zaak verzonden aan ander ministerie', 'Matter sent to another ministry'],
  EXCHANGE_IMPORTED: ['Zaak ontvangen van ander ministerie', 'Matter received from another ministry'],
  EXCHANGE_PARTNER_SAVED: ['Uitwisselpartner opgeslagen', 'Exchange partner saved'],
};

export const AUDIT_TYPE = (t: T, type: string) => {
  const l = AUDIT_TYPES[type];
  return l ? t(l[0], l[1]) : type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, ' ');
};

export const AUDIT_CATEGORY = (t: T, c: string) =>
  ({
    SECURITY: t('Beveiliging', 'Security'),
    ADMINISTRATION: t('Beheer', 'Administration'),
    RECORDS: t('Post en documenten', 'Post and documents'),
    MATTERS: t('Zaken', 'Matters'),
    TASKS: t('Taken', 'Tasks'),
    ACCESS: t('Toegang', 'Access'),
    ARCHIVE: t('Archief', 'Archive'),
    OVERSIGHT: t('Toezicht', 'Oversight'),
    ASSISTANT: t('Assistent', 'Assistant'),
    INTEGRATION: t('Koppelingen', 'Integrations'),
  })[c] ?? c;
