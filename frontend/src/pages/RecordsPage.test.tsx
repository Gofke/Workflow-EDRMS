import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiMock, item } from '../test/mock-api';
import type { DocumentTextView } from '../api';
import { RecordsPage, registrationPrompt } from './RecordsPage';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  const { apiMock: makeMock } = await vi.importActual<typeof import('../test/mock-api')>(
    '../test/mock-api',
  );
  return { ...actual, api: makeMock() };
});

const { api: mocked } = (await import('../api')) as unknown as {
  api: ReturnType<typeof apiMock>;
};

const duplicate = {
  itemId: 'item-9',
  registrationIdentity: 'IN-2026-00009',
  direction: 'INCOMING',
  subject: 'Inzageverzoek',
  party: 'PARTY-SYN-A',
  registeredAt: new Date().toISOString(),
  reasons: ['IDENTICAL_DOCUMENT' as const],
};

/** FR-COR-016 in the interface: named, advisory, never blocking. */
describe('Registration duplicate warning', () => {
  beforeEach(() => vi.clearAllMocks());

  const draftItem = item({ id: 'draft-1', state: 'DRAFT', registrationIdentity: null, version: 3 });

  it('names the possible duplicate and why, and says nothing will be merged', () => {
    const text = registrationPrompt(draftItem, [duplicate]);
    expect(text).toContain('IN-2026-00009');
    expect(text).toContain('the same document');
    expect(text).toContain('Nothing is merged or changed');
    expect(text).toContain('Register "Inzageverzoek" as an official record?');
  });

  it('asks the ordinary question when there is nothing to warn about', () => {
    expect(registrationPrompt(draftItem, [])).toBe(
      'Register "Inzageverzoek" as an official record? This cannot be undone.',
    );
  });

  it('says so when the check could not run, rather than implying there are no duplicates', () => {
    expect(registrationPrompt(draftItem, null)).toContain('could not be run');
  });

  it('checks before registering and still registers when the user proceeds', async () => {
    mocked.records.mockResolvedValue([draftItem]);
    mocked.possibleDuplicates.mockResolvedValue([duplicate]);
    render(<RecordsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Register' }));

    expect(mocked.possibleDuplicates).toHaveBeenCalledWith('draft-1');
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('IN-2026-00009'));
    expect(mocked.register).toHaveBeenCalledWith('draft-1', 3);
  });

  it('does not let a failed check block registration', async () => {
    mocked.records.mockResolvedValue([draftItem]);
    mocked.possibleDuplicates.mockRejectedValue(new Error('down'));
    render(<RecordsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Register' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('could not be run'));
    expect(mocked.register).toHaveBeenCalledWith('draft-1', 3);
  });

  describe('derived text (FR-COR-015)', () => {
    const registered = item({ id: 'item-1', state: 'REGISTERED' });
    const doc = {
      id: 'doc-1',
      originalFilename: 'scan.png',
      mediaType: 'image/png',
      byteSize: 16285,
      contentHash: 'a'.repeat(64),
      capturedByName: 'L. Amatredjo',
      capturedAt: new Date().toISOString(),
    };
    const text = (overrides: Partial<DocumentTextView> = {}): DocumentTextView => ({
      documentId: 'doc-1',
      status: 'EXTRACTED',
      text: 'MINISTERIE VAN JUSTITIE EN POLITIE',
      engine: 'tesseract (eng)',
      languages: 'eng',
      extractedAt: new Date().toISOString(),
      stale: false,
      derived: true,
      ...overrides,
    });

    const openDocuments = async () => {
      mocked.records.mockResolvedValue([registered]);
      mocked.documentsFor.mockResolvedValue([doc]);
      render(<RecordsPage />);
      await userEvent.click(await screen.findByRole('button', { name: 'Documents' }));
      return screen.findByRole('button', { name: 'Read text (OCR)' });
    };

    it('shows the text as an aid, names the engine, and keeps the document itself in place', async () => {
      mocked.documentText.mockResolvedValue(text());
      await userEvent.click(await openDocuments());

      expect(mocked.documentText).toHaveBeenCalledWith('item-1', 'doc-1');
      expect(await screen.findByText(/MINISTERIE VAN JUSTITIE/)).toBeInTheDocument();
      expect(screen.getByText(/not the document itself/)).toBeInTheDocument();
      expect(screen.getByText(/tesseract \(eng\)/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'scan.png' })).toBeInTheDocument();
    });

    it('distinguishes "read and empty" from "not read"', async () => {
      mocked.documentText.mockResolvedValue(text({ status: 'EMPTY', text: null }));
      const { unmount } = render(<div />);
      unmount();
      await userEvent.click(await openDocuments());
      expect(await screen.findByText('The page was read and no text was found.')).toBeInTheDocument();
    });

    it('warns when the text does not match the document it sits under', async () => {
      mocked.documentText.mockResolvedValue(text({ stale: true }));
      await userEvent.click(await openDocuments());
      expect(await screen.findByRole('alert')).toHaveTextContent('may not describe the document');
    });

    it('explains an empty PDF as a missing text layer, not as a blank page', async () => {
      mocked.records.mockResolvedValue([registered]);
      mocked.documentsFor.mockResolvedValue([
        { ...doc, id: 'doc-2', originalFilename: 'scan.pdf', mediaType: 'application/pdf' },
      ]);
      mocked.documentText.mockResolvedValue(
        text({ documentId: 'doc-2', status: 'EMPTY', text: null, engine: 'pdftotext' }),
      );
      render(<RecordsPage />);
      await userEvent.click(await screen.findByRole('button', { name: 'Documents' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Read text (OCR)' }));
      expect(await screen.findByText(/no text layer/)).toBeInTheDocument();
    });
  });
});
