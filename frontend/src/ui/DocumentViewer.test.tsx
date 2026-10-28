import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { me, renderPage, server } from '../test/harness';
import { DocumentViewer } from './DocumentViewer';

const DOC = { id: 'doc-1', originalFilename: 'scan.pdf', mediaType: 'application/pdf', byteSize: 2048, contentHash: 'cd'.repeat(32), capturedAt: '2026-10-28T12:00:00Z', capturedByName: 'K. Pawironadi' };

/** Text read by OCR is an aid, never the record; and a changed file is shown as changed. */
describe('Document viewer', () => {
  it('labels text read by text recognition as an aid, not as the record', async () => {
    server(me(['SUPPORT_STAFF']), { 'GET /api/records/i1/documents/doc-1/text': { status: 'EXTRACTED', text: 'Geachte Minister, wij melden een tekort aan medicijnen.', engine: 'tesseract 5', method: 'OCR' } });
    renderPage(<DocumentViewer itemId="i1" documents={[DOC]} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Gelezen tekst' }));
    expect(await screen.findByText(/wij melden een tekort aan medicijnen/)).toBeInTheDocument();
    expect(screen.getByText(/met tekstherkenning.*het document zelf blijft het stuk/)).toBeInTheDocument();
  });

  it('says so plainly when a stored file no longer matches its fingerprint', async () => {
    server(me(['SUPPORT_STAFF']), { 'GET /api/records/i1/documents/doc-1/verify': { intact: false } });
    renderPage(<DocumentViewer itemId="i1" documents={[DOC]} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Controleren' }));
    expect(await screen.findByText('Afwijking: het bestand is gewijzigd of beschadigd')).toBeInTheDocument();
  });
});
