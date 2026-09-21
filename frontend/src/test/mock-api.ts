import { vi } from 'vitest';
import type { DossierView, ItemView } from '../api';

/** A dossier in whatever state a test needs. */
export function dossier(overrides: Partial<DossierView> = {}): DossierView {
  return {
    id: 'dossier-1',
    dossierIdentity: 'DOS-2026-0001',
    subject: 'Bezwaarschrift 2026-221',
    state: 'OPEN',
    processingState: 'ACTIVE',
    dueDate: null,
    responsibleName: null,
    createdAt: new Date().toISOString(),
    version: 1,
    createdByName: 'L. Amatredjo',
    linkedItems: [],
    ...overrides,
  };
}

export function item(overrides: Partial<ItemView> = {}): ItemView {
  return {
    id: 'item-1',
    registrationIdentity: 'IN-2026-00001',
    state: 'REGISTERED',
    direction: 'INCOMING',
    subject: 'Inzageverzoek',
    party: 'Advocatenkantoor Wijngaarde',
    documentDate: '2026-09-10',
    registeredAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    version: 2,
    createdByName: 'L. Amatredjo',
    ...overrides,
  };
}

/** Every api function, stubbed. Tests override only what they exercise. */
export function apiMock(overrides: Record<string, unknown> = {}) {
  const resolved = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    dossiers: resolved([]),
    records: resolved([]),
    reviewQueue: resolved([]),
    myAuthority: resolved([]),
    assignableOfficials: resolved([]),
    eligibleReviewers: resolved([]),
    dossierHistory: resolved({ responsibility: [], dueDates: [] }),
    workflowHistory: resolved([]),
    timelinePage: resolved({ entries: [], total: 0, nextCursor: null }),
    timelineExportUrl: vi.fn((id: string) => `/api/dossiers/${id}/timeline/export`),
    delegations: resolved([]),
    delegationCandidates: resolved([]),
    documentsFor: resolved([]),
    documentContentUrl: vi.fn(
      (itemId: string, documentId: string) => `/api/records/${itemId}/documents/${documentId}/content`,
    ),
    captureDocument: resolved({}),
    possibleDuplicates: resolved([]),
    documentText: resolved({
      documentId: 'doc-1',
      status: 'SKIPPED',
      text: null,
      engine: null,
      languages: null,
      extractedAt: null,
      stale: false,
      derived: true,
    }),
    register: resolved(item()),
    createDossier: resolved(dossier()),
    linkRecord: resolved(dossier()),
    assignResponsibility: resolved(dossier()),
    setDueDate: resolved(dossier()),
    submitForReview: resolved({ processingState: 'UNDER_REVIEW', version: 2 }),
    returnForCorrection: resolved({ processingState: 'RETURNED', version: 3 }),
    approveMatter: resolved({ processingState: 'APPROVED', version: 3 }),
    finaliseMatter: resolved({ processingState: 'FINALISED', version: 4 }),
    reopenMatter: resolved({ processingState: 'ACTIVE', version: 5 }),
    closeDossier: resolved({ state: 'CLOSED', processingState: 'FINALISED', version: 5 }),
    reopenDossier: resolved({ state: 'REOPENED', processingState: 'FINALISED', version: 6 }),
    grantDelegation: resolved({}),
    revokeDelegation: resolved({}),
    ...overrides,
  };
}
