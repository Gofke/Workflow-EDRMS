import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { apiMock, dossier, item } from '../test/mock-api';
import { DossiersPage } from './DossiersPage';

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

/**
 * Authority as the screen presents it.
 *
 * Two shipped defects are pinned here. Delegated authority did not reach the
 * interface at all, so an assistant holding a valid delegation saw nothing. And
 * a finalised matter still offered the controls the server would refuse.
 */
describe('DossiersPage', () => {
  function setup(options: {
    authority?: { action: string; viaDelegationFrom: string | null }[];
    dossiers?: ReturnType<typeof dossier>[];
    queue?: { dossierId: string }[];
  }) {
    vi.clearAllMocks();
    mocked.myAuthority.mockResolvedValue(options.authority ?? []);
    mocked.dossiers.mockResolvedValue(options.dossiers ?? [dossier()]);
    mocked.records.mockResolvedValue([item()]);
    mocked.reviewQueue.mockResolvedValue(options.queue ?? []);
    mocked.assignableOfficials.mockResolvedValue([
      { accountId: 'a1', personName: 'A. Boldewijn', roles: ['ONDER_DIRECTEUR'] },
    ]);
    return render(<DossiersPage />);
  }

  it('offers no assignment controls to someone with no authority', async () => {
    setup({ authority: [] });
    await screen.findByText('DOS-2026-0001');
    expect(screen.queryByLabelText(/Who is responsible/)).not.toBeInTheDocument();
  });

  /** The defect: a valid delegation that the screen never showed. */
  it('offers the delegated action, and names whose authority is being used', async () => {
    setup({
      authority: [
        { action: 'ASSIGN_RESPONSIBILITY', viaDelegationFrom: 'M. Sardjoe (directeur@juspol.test)' },
      ],
    });

    expect(await screen.findByText(/acting on behalf of M. Sardjoe/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/Who is responsible/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Assign' })).toBeInTheDocument();
  });

  /** FR-DEL-004 in the interface: the unlisted action is not offered. */
  it('offers only the action that was delegated', async () => {
    setup({
      authority: [{ action: 'SET_DUE_DATE', viaDelegationFrom: 'M. Sardjoe' }],
    });
    await waitFor(() => expect(screen.getByLabelText(/Official due date/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Assign' })).not.toBeInTheDocument();
  });

  it('shows no acting-on-behalf banner for a role holder acting in their own right', async () => {
    setup({ authority: [{ action: 'ASSIGN_RESPONSIBILITY', viaDelegationFrom: null }] });
    await screen.findByText('DOS-2026-0001');
    expect(screen.queryByText(/acting on behalf of/)).not.toBeInTheDocument();
  });

  /** The defect: controls offered on a matter the server would refuse. */
  it('withdraws every ordinary-change control once a matter is finalised', async () => {
    setup({
      authority: [{ action: 'ASSIGN_RESPONSIBILITY', viaDelegationFrom: null }],
      dossiers: [dossier({ processingState: 'FINALISED' })],
    });
    await screen.findByText('DOS-2026-0001');

    await waitFor(() => expect(screen.getByText(/protected from ordinary change/)).toBeInTheDocument());
    expect(screen.queryByLabelText(/Who is responsible/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Record to add/)).not.toBeInTheDocument();
  });

  it('tells a reviewer when matters await their decision', async () => {
    setup({ queue: [{ dossierId: 'dossier-1' }] });
    expect(await screen.findByText(/One matter is awaiting your decision/)).toBeInTheDocument();
  });

  it('explains why a draft is missing from the record picker', async () => {
    vi.clearAllMocks();
    mocked.myAuthority.mockResolvedValue([]);
    mocked.dossiers.mockResolvedValue([dossier()]);
    mocked.reviewQueue.mockResolvedValue([]);
    mocked.records.mockResolvedValue([
      item(),
      item({ id: 'item-2', state: 'DRAFT', registrationIdentity: null }),
    ]);
    render(<DossiersPage />);

    expect(await screen.findByText(/1 draft item is not listed above/)).toBeInTheDocument();
  });
});
