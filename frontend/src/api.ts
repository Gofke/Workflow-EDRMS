/**
 * One place for the build version. It was hardcoded in two screens and had gone
 * stale in both — the login page still said 0.1.1 and the identity screen said
 * 0.1.5 while the build was 0.1.8.
 */
export const APP_VERSION = '0.1.18';

export interface AuthenticatedUser {
  accountId: string;
  personName: string;
  email: string;
  jobPosition: string | null;
  organisationalUnit: string | null;
  roles: { code: string; name: string }[];
}

/** Thrown for any non-2xx response, carrying the message the API returned. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    // credentials: the session cookie must travel with every call.
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = Array.isArray(body?.message) ? body.message[0] : body?.message;
    throw new ApiError(response.status, message ?? 'The server could not complete the request.');
  }
  return body as T;
}

export interface AccountSummary {
  accountId: string;
  personName: string;
  email: string;
  organisationalUnit: string | null;
  isEnabled: boolean;
  roles: { code: string; name: string }[];
}

export interface AuditEventRow {
  id: string;
  occurredAt: string;
  eventType: string;
  actorDescription: string;
  subjectDescription: string | null;
  summary: string;
}

export interface ItemView {
  id: string;
  registrationIdentity: string | null;
  state: 'DRAFT' | 'REGISTERED';
  direction: 'INCOMING' | 'OUTGOING' | 'INTERNAL';
  subject: string;
  party: string | null;
  documentDate: string | null;
  registeredAt: string | null;
  createdAt: string;
  version: number;
  createdByName: string;
}

export interface DraftInput {
  direction: string;
  subject: string;
  party?: string;
  documentDate?: string;
}

/** The matter file's state after a close or reopen (FR-DOS-006). */
export interface DossierStateResult {
  state: string;
  processingState: string;
  version: number;
}

export interface DossierView {
  id: string;
  dossierIdentity: string;
  subject: string;
  state: string;
  processingState: string;
  dueDate: string | null;
  responsibleName: string | null;
  createdAt: string;
  version: number;
  createdByName: string;
  linkedItems: {
    id: string;
    registrationIdentity: string | null;
    subject: string;
    direction: string;
    linkedAt: string;
  }[];
}

export interface DossierHistory {
  responsibility: {
    responsibleName: string;
    assignedByName: string;
    onBehalfOfName: string | null;
    assignedAt: string;
    supersededAt: string | null;
    isCurrent: boolean;
  }[];
  dueDates: {
    onBehalfOfName: string | null;
    previousDueDate: string | null;
    newDueDate: string | null;
    reason: string | null;
    changedByName: string;
    changedAt: string;
  }[];
}

export interface CapturedDocumentView {
  id: string;
  originalFilename: string;
  mediaType: string;
  byteSize: number;
  contentHash: string;
  capturedByName: string;
  capturedAt: string;
}

export interface DelegationView {
  id: string;
  principalName: string;
  delegateName: string;
  permittedActions: string[];
  validFrom: string;
  validUntil: string;
  grantedByName: string;
  revokedAt: string | null;
  isActive: boolean;
}

export interface WorkflowEventView {
  eventType: 'SUBMITTED' | 'RETURNED' | 'APPROVED' | 'FINALISED' | 'REOPENED';
  actorName: string;
  onBehalfOfName: string | null;
  reviewerName: string | null;
  reason: string | null;
  reviewedVersion: number;
  occurredAt: string;
}

export interface ReviewQueueItem {
  dossierId: string;
  dossierIdentity: string;
  subject: string;
  submittedByName: string;
  submittedAt: string;
}

export interface TimelineEntry {
  occurredAt: string;
  kind: string;
  headline: string;
  actorName: string;
  onBehalfOfName: string | null;
  detail: string | null;
  source: string;
}

/** FR-COR-015: text read from a document. Assistance, never the document. */
export interface DocumentTextView {
  documentId: string;
  status: 'EXTRACTED' | 'EMPTY' | 'SKIPPED' | 'FAILED';
  text: string | null;
  engine: string | null;
  languages: string | null;
  extractedAt: string | null;
  stale: boolean;
  derived: true;
}

/** FR-COR-016: an advisory match. Naming it changes neither record. */
export interface PossibleDuplicate {
  itemId: string;
  registrationIdentity: string;
  direction: string;
  subject: string;
  party: string | null;
  registeredAt: string;
  reasons: ('IDENTICAL_DOCUMENT' | 'SAME_SUBJECT_AND_PARTY')[];
}

export interface TimelinePage {
  entries: TimelineEntry[];
  total: number;
  nextCursor: string | null;
}

export const DELEGATABLE_ACTIONS = [
  { code: 'ASSIGN_RESPONSIBILITY', label: 'Assign responsibility for a matter' },
  { code: 'SET_DUE_DATE', label: 'Set or change an official due date' },
];

export const ROLE_OPTIONS = [
  { code: 'MINISTER', name: 'Minister' },
  { code: 'DIRECTEUR', name: 'Directeur' },
  { code: 'ONDER_DIRECTEUR', name: 'Onder-Directeur' },
  { code: 'SUPPORT_STAFF', name: 'Assistant / support staff' },
  { code: 'SYS_ADMIN', name: 'Pilot System Administrator' },
];

export const api = {
  login: (email: string, password: string) =>
    request<AuthenticatedUser>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  me: () => request<AuthenticatedUser>('/api/auth/me'),
  logout: () => request<{ signedOut: true }>('/api/auth/logout', { method: 'POST' }),

  accounts: () => request<AccountSummary[]>('/api/admin/accounts'),
  auditTrail: () => request<AuditEventRow[]>('/api/admin/audit?limit=100'),
  assignRole: (accountId: string, roleCode: string) =>
    request<{ applied: true }>('/api/admin/roles/assign', {
      method: 'POST',
      body: JSON.stringify({ accountId, roleCode }),
    }),
  revokeRole: (accountId: string, roleCode: string) =>
    request<{ applied: true }>('/api/admin/roles/revoke', {
      method: 'POST',
      body: JSON.stringify({ accountId, roleCode }),
    }),
  records: () => request<ItemView[]>('/api/records'),
  documentsFor: (itemId: string) =>
    request<CapturedDocumentView[]>(`/api/records/${itemId}/documents`),

  /** Multipart: the browser sets the boundary, so no Content-Type is sent. */
  captureDocument: async (itemId: string, file: File) => {
    const body = new FormData();
    body.append('file', file);
    const response = await fetch(`/api/records/${itemId}/documents`, {
      method: 'POST',
      credentials: 'include',
      body,
    });
    const parsed = await response.json().catch(() => null);
    if (!response.ok) {
      const message = Array.isArray(parsed?.message) ? parsed.message[0] : parsed?.message;
      throw new ApiError(response.status, message ?? 'The document could not be captured.');
    }
    return parsed as CapturedDocumentView;
  },

  documentContentUrl: (itemId: string, documentId: string) =>
    `/api/records/${itemId}/documents/${documentId}/content`,
  dossiers: () => request<DossierView[]>('/api/dossiers'),
  createDossier: (subject: string) =>
    request<DossierView>('/api/dossiers', { method: 'POST', body: JSON.stringify({ subject }) }),
  reviewQueue: () => request<ReviewQueueItem[]>('/api/dossiers/review-queue'),
  timeline: (dossierId: string) =>
    request<TimelineEntry[]>(`/api/dossiers/${dossierId}/timeline`),
  timelinePage: (dossierId: string, cursor: string | null = null, limit = 50) =>
    request<TimelinePage>(
      `/api/dossiers/${dossierId}/timeline/page?limit=${limit}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
    ),
  /** A plain link: the browser downloads it with the session cookie. */
  timelineExportUrl: (dossierId: string) => `/api/dossiers/${dossierId}/timeline/export`,
  eligibleReviewers: () =>
    request<{ accountId: string; personName: string }[]>('/api/dossiers/eligible-reviewers'),
  workflowHistory: (dossierId: string) =>
    request<WorkflowEventView[]>(`/api/dossiers/${dossierId}/workflow`),
  submitForReview: (dossierId: string, reviewerAccountId: string, version: number) =>
    request<{ processingState: string; version: number }>(`/api/dossiers/${dossierId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ reviewerAccountId, version }),
    }),
  returnForCorrection: (dossierId: string, reason: string, version: number) =>
    request<{ processingState: string; version: number }>(`/api/dossiers/${dossierId}/return`, {
      method: 'POST',
      body: JSON.stringify({ reason, version }),
    }),
  finaliseMatter: (dossierId: string, version: number) =>
    request<{ processingState: string; version: number }>(`/api/dossiers/${dossierId}/finalise`, {
      method: 'POST',
      body: JSON.stringify({ version }),
    }),
  reopenMatter: (dossierId: string, reason: string, version: number) =>
    request<{ processingState: string; version: number }>(`/api/dossiers/${dossierId}/reopen`, {
      method: 'POST',
      body: JSON.stringify({ reason, version }),
    }),
  closeDossier: (dossierId: string, reason: string | null, version: number) =>
    request<DossierStateResult>(`/api/dossiers/${dossierId}/dossier-state/close`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason ?? undefined, version }),
    }),
  reopenDossier: (dossierId: string, reason: string, version: number) =>
    request<DossierStateResult>(`/api/dossiers/${dossierId}/dossier-state/reopen`, {
      method: 'POST',
      body: JSON.stringify({ reason, version }),
    }),
  approveMatter: (dossierId: string, version: number) =>
    request<{ processingState: string; version: number }>(`/api/dossiers/${dossierId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ version }),
    }),

  delegations: () => request<DelegationView[]>('/api/delegations'),
  myAuthority: () =>
    request<{ action: string; viaDelegationFrom: string | null }[]>(
      '/api/delegations/my-authority',
    ),
  delegationCandidates: () =>
    request<{ accountId: string; personName: string }[]>('/api/delegations/candidates'),
  grantDelegation: (input: {
    delegateAccountId: string;
    actions: string[];
    validFrom: string;
    validUntil: string;
  }) => request<DelegationView>('/api/delegations', { method: 'POST', body: JSON.stringify(input) }),
  revokeDelegation: (id: string) =>
    request<DelegationView>(`/api/delegations/${id}/revoke`, { method: 'POST' }),

  assignableOfficials: () =>
    request<{ accountId: string; personName: string; roles: string[] }[]>(
      '/api/dossiers/assignable-officials',
    ),
  dossierHistory: (dossierId: string) =>
    request<DossierHistory>(`/api/dossiers/${dossierId}/history`),
  assignResponsibility: (dossierId: string, responsibleAccountId: string, version: number) =>
    request<DossierView>(`/api/dossiers/${dossierId}/responsibility`, {
      method: 'POST',
      body: JSON.stringify({ responsibleAccountId, version }),
    }),
  setDueDate: (dossierId: string, dueDate: string | null, reason: string | null, version: number) =>
    request<DossierView>(`/api/dossiers/${dossierId}/due-date`, {
      method: 'POST',
      body: JSON.stringify({ dueDate, reason: reason ?? undefined, version }),
    }),
  linkRecord: (dossierId: string, itemId: string) =>
    request<DossierView>(`/api/dossiers/${dossierId}/links`, {
      method: 'POST',
      body: JSON.stringify({ itemId }),
    }),
  createDraft: (input: DraftInput) =>
    request<ItemView>('/api/records/drafts', { method: 'POST', body: JSON.stringify(input) }),
  updateDraft: (id: string, input: DraftInput, version: number) =>
    request<ItemView>(`/api/records/drafts/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...input, version }),
    }),
  documentText: (itemId: string, documentId: string) =>
    request<DocumentTextView>(`/api/records/${itemId}/documents/${documentId}/text`),
  possibleDuplicates: (id: string) =>
    request<PossibleDuplicate[]>(`/api/records/${id}/possible-duplicates`),
  register: (id: string, version: number) =>
    request<ItemView>(`/api/records/${id}/register`, {
      method: 'POST',
      body: JSON.stringify({ version }),
    }),

  setEnabled: (accountId: string, enabled: boolean) =>
    request<{ applied: true }>(`/api/admin/accounts/${enabled ? 'enable' : 'disable'}`, {
      method: 'POST',
      body: JSON.stringify({ accountId }),
    }),
};
