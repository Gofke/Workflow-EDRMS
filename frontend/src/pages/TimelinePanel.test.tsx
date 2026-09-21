import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { apiMock } from '../test/mock-api';
import { TimelinePanel } from './TimelinePanel';

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

/** One page holding everything: the V0.1.12 behaviour, served through paging. */
const pageOf = (entries: unknown[]) =>
  vi.fn().mockResolvedValue({ entries, total: entries.length, nextCursor: null });

describe('TimelinePanel', () => {
  const entry = (overrides = {}) => ({
    occurredAt: '2026-09-18T08:00:00.000Z',
    kind: 'DOSSIER_OPENED',
    headline: 'Dossier opened',
    actorName: 'L. Amatredjo',
    onBehalfOfName: null,
    detail: null,
    source: 'dossier',
    ...overrides,
  });

  it('loads nothing until asked, then shows the entries in the order given', async () => {
    mocked.timelinePage = pageOf([
      entry(),
      entry({
        kind: 'RETURNED',
        headline: 'Returned for correction',
        actorName: 'M. Sardjoe',
        detail: 'De juridische grondslag ontbreekt',
        occurredAt: '2026-09-18T09:00:00.000Z',
      }),
    ]);
    render(<TimelinePanel dossierId="dossier-1" />);
    expect(mocked.timelinePage).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /Read the full history/ }));
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Dossier opened');
    expect(items[1]).toHaveTextContent('De juridische grondslag ontbreekt');
  });

  it('names both parties on a delegated action', async () => {
    mocked.timelinePage = pageOf([
      entry({
        kind: 'RESPONSIBILITY_ASSIGNED',
        headline: 'Responsibility assigned to A. Boldewijn',
        actorName: 'K. Pawironadi',
        onBehalfOfName: 'M. Sardjoe',
      }),
    ]);
    render(<TimelinePanel dossierId="dossier-1" />);
    await userEvent.click(screen.getByRole('button', { name: /Read the full history/ }));

    expect(await screen.findByText(/K. Pawironadi, on behalf of M. Sardjoe/)).toBeInTheDocument();
  });

  it('says so plainly when there is nothing, and reports a failure rather than showing nothing', async () => {
    mocked.timelinePage = pageOf([]);
    const { unmount } = render(<TimelinePanel dossierId="dossier-1" />);
    await userEvent.click(screen.getByRole('button', { name: /Read the full history/ }));
    expect(await screen.findByText('Nothing has happened yet.')).toBeInTheDocument();
    unmount();

    mocked.timelinePage = vi.fn().mockRejectedValue(new Error('You are not permitted to do that.'));
    render(<TimelinePanel dossierId="dossier-1" />);
    await userEvent.click(screen.getByRole('button', { name: /Read the full history/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not permitted');
  });

  it('reads further pages on request and says how far the reader has got', async () => {
    mocked.timelinePage = vi
      .fn()
      .mockResolvedValueOnce({ entries: [entry()], total: 2, nextCursor: 'c1' })
      .mockResolvedValueOnce({
        entries: [entry({ headline: 'Approved', kind: 'APPROVED' })],
        total: 2,
        nextCursor: null,
      });
    render(<TimelinePanel dossierId="dossier-1" />);
    await userEvent.click(screen.getByRole('button', { name: /Read the full history/ }));

    await userEvent.click(await screen.findByRole('button', { name: 'Show more (1 of 2)' }));
    expect(mocked.timelinePage).toHaveBeenLastCalledWith('dossier-1', 'c1', 50);
    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show more/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('tells the reader when the history grew behind them', async () => {
    mocked.timelinePage = vi
      .fn()
      .mockResolvedValueOnce({ entries: [entry()], total: 2, nextCursor: 'c1' })
      .mockResolvedValueOnce({
        entries: [entry({ headline: 'Approved', kind: 'APPROVED' })],
        total: 4,
        nextCursor: null,
      });
    render(<TimelinePanel dossierId="dossier-1" />);
    await userEvent.click(screen.getByRole('button', { name: /Read the full history/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Show more/ }));

    expect(await screen.findByRole('status')).toHaveTextContent('gained 2 entries');
    expect(screen.getByRole('button', { name: 'Read it again from the start' })).toBeInTheDocument();
  });

  it('offers the CSV download once the history is open', async () => {
    mocked.timelinePage = pageOf([entry()]);
    render(<TimelinePanel dossierId="dossier-1" />);
    expect(screen.queryByRole('link', { name: 'Download as CSV' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Read the full history/ }));
    const link = await screen.findByRole('link', { name: 'Download as CSV' });
    expect(link).toHaveAttribute('href', '/api/dossiers/dossier-1/timeline/export');
  });
});
