import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiMock, dossier } from '../test/mock-api';
import { WorkflowPanel } from './WorkflowPanel';

// vi.mock is hoisted above the imports, so the stub must be created inside the
// factory. The reference is read back afterwards.
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
 * What the screen offers, per state and per person.
 *
 * Each case here corresponds to a defect that shipped or was caught by hand:
 * controls offered on a finalised matter, Finalise offered before approval, a
 * decision control shown to someone whose decision it is not.
 */
describe('WorkflowPanel', () => {
  const noop = { onChanged: vi.fn(), onError: vi.fn(), onMessage: vi.fn() };

  beforeEach(() => vi.clearAllMocks());

  const panel = (overrides = {}, props = {}) =>
    render(
      <WorkflowPanel
        dossier={dossier(overrides)}
        canDecide={false}
        awaitingMyDecision={false}
        {...noop}
        {...props}
      />,
    );

  it('shows the state in words, not as a code', async () => {
    panel({ processingState: 'UNDER_REVIEW' });
    expect(await screen.findByText('Under review')).toBeInTheDocument();
    expect(screen.queryByText('UNDER_REVIEW')).not.toBeInTheDocument();
  });

  it('offers no decision controls to someone whose decision it is not', async () => {
    panel({ processingState: 'UNDER_REVIEW' }, { canDecide: true, awaitingMyDecision: false });
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Return for correction' }),
    ).not.toBeInTheDocument();
  });

  it('offers Approve and Return only to the designated reviewer', async () => {
    panel({ processingState: 'UNDER_REVIEW' }, { awaitingMyDecision: true });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Return for correction' })).toBeInTheDocument();
  });

  it('keeps Return disabled until a reason is typed', async () => {
    panel({ processingState: 'UNDER_REVIEW' }, { awaitingMyDecision: true });
    const button = screen.getByRole('button', { name: 'Return for correction' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Reason for returning/), 'Grondslag ontbreekt');
    expect(button).toBeEnabled();
  });

  it('does not offer Finalise before approval', () => {
    panel({ processingState: 'UNDER_REVIEW' }, { canDecide: true, awaitingMyDecision: true });
    expect(screen.queryByRole('button', { name: 'Finalise' })).not.toBeInTheDocument();
  });

  it('offers Finalise once approved, and only to a decision-maker', () => {
    const { unmount } = panel({ processingState: 'APPROVED' }, { canDecide: true });
    expect(screen.getByRole('button', { name: 'Finalise' })).toBeInTheDocument();
    unmount();

    panel({ processingState: 'APPROVED' }, { canDecide: false });
    expect(screen.queryByRole('button', { name: 'Finalise' })).not.toBeInTheDocument();
  });

  it('explains the protection on a finalised matter and offers Reopen only to a decision-maker', () => {
    const { unmount } = panel({ processingState: 'FINALISED' }, { canDecide: true });
    expect(screen.getByText(/protected from ordinary change/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
    unmount();

    panel({ processingState: 'FINALISED' }, { canDecide: false });
    expect(screen.getByText(/protected from ordinary change/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
  });

  it('requires a reason to reopen', async () => {
    panel({ processingState: 'FINALISED' }, { canDecide: true });
    const button = screen.getByRole('button', { name: 'Reopen' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Reason for reopening/), 'Nieuwe stukken');
    expect(button).toBeEnabled();
  });

  it('confirms before approving, and passes the version it was shown', async () => {
    panel({ processingState: 'UNDER_REVIEW', version: 7 }, { awaitingMyDecision: true });
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(mocked.approveMatter).toHaveBeenCalledWith('dossier-1', 7);
    expect(window.confirm).toHaveBeenCalled();
  });

  it('labels history events in their own vocabulary, not the state vocabulary', async () => {
    mocked.workflowHistory.mockResolvedValueOnce([
      {
        eventType: 'SUBMITTED',
        actorName: 'L. Amatredjo',
        onBehalfOfName: 'M. Sardjoe',
        reviewerName: 'M. Sardjoe',
        reason: null,
        reviewedVersion: 2,
        occurredAt: new Date().toISOString(),
      },
      {
        eventType: 'FINALISED',
        actorName: 'M. Sardjoe',
        onBehalfOfName: null,
        reviewerName: null,
        reason: null,
        reviewedVersion: 3,
        occurredAt: new Date().toISOString(),
      },
    ]);
    panel();
    await userEvent.click(screen.getByRole('button', { name: 'Decision history' }));

    expect(await screen.findByText('Submitted for review')).toBeInTheDocument();
    expect(screen.getByText('Finalised')).toBeInTheDocument();
    expect(screen.queryByText('SUBMITTED')).not.toBeInTheDocument();
    // FR-DEL-003 in the interface: both parties visible.
    expect(screen.getByText(/on behalf of M. Sardjoe/)).toBeInTheDocument();
  });

  describe('dossier closure (FR-DOS-006 to 008)', () => {
    it('offers Close dossier only on a finalised matter, and only to a decision-maker', () => {
      const { unmount } = panel({ processingState: 'FINALISED' }, { canDecide: true });
      expect(screen.getByRole('button', { name: 'Close dossier' })).toBeInTheDocument();
      unmount();

      const second = panel({ processingState: 'FINALISED' }, { canDecide: false });
      expect(screen.queryByRole('button', { name: 'Close dossier' })).not.toBeInTheDocument();
      second.unmount();

      panel({ processingState: 'APPROVED' }, { canDecide: true });
      expect(screen.queryByRole('button', { name: 'Close dossier' })).not.toBeInTheDocument();
    });

    it('confirms before closing and passes the version it was shown', async () => {
      panel({ processingState: 'FINALISED', version: 9 }, { canDecide: true });
      await userEvent.type(screen.getByLabelText(/Reason for closing/), 'Afgehandeld');
      await userEvent.click(screen.getByRole('button', { name: 'Close dossier' }));
      expect(window.confirm).toHaveBeenCalled();
      expect(mocked.closeDossier).toHaveBeenCalledWith('dossier-1', 'Afgehandeld', 9);
    });

    it('withdraws the workflow Reopen from a closed dossier and offers Reopen dossier instead', () => {
      panel({ processingState: 'FINALISED', state: 'CLOSED' }, { canDecide: true });
      expect(screen.getByText(/This dossier is closed/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Close dossier' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Reopen dossier' })).toBeInTheDocument();
    });

    it('requires a reason to reopen a closed dossier, and hides it from others', async () => {
      const { unmount } = panel({ processingState: 'FINALISED', state: 'CLOSED' }, { canDecide: true });
      const button = screen.getByRole('button', { name: 'Reopen dossier' });
      expect(button).toBeDisabled();
      await userEvent.type(screen.getByLabelText(/Reason for reopening dossier/), 'Bezwaar ontvangen');
      expect(button).toBeEnabled();
      await userEvent.click(button);
      expect(mocked.reopenDossier).toHaveBeenCalledWith('dossier-1', 'Bezwaar ontvangen', 1);
      unmount();

      panel({ processingState: 'FINALISED', state: 'CLOSED' }, { canDecide: false });
      expect(screen.getByText(/This dossier is closed/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reopen dossier' })).not.toBeInTheDocument();
    });

    it('shows the dossier state in words', () => {
      panel({ processingState: 'FINALISED', state: 'REOPENED' });
      expect(screen.getByText('Reopened')).toBeInTheDocument();
      expect(screen.queryByText('REOPENED')).not.toBeInTheDocument();
    });
  });
});
