import { useEffect, useState } from 'react';
import { DossierView, WorkflowEventView, api } from '../api';

const STATE_LABEL: Record<string, string> = {
  ACTIVE: 'In processing',
  UNDER_REVIEW: 'Under review',
  RETURNED: 'Returned for correction',
  APPROVED: 'Approved',
  FINALISED: 'Finalised',
};

/**
 * Events and states are different vocabularies and need different words. Using
 * the state map for both left "SUBMITTED" rendered raw in the history while a
 * return read as prose beside it.
 */
const EVENT_LABEL: Record<string, string> = {
  SUBMITTED: 'Submitted for review',
  RETURNED: 'Returned for correction',
  APPROVED: 'Approved',
  FINALISED: 'Finalised',
  REOPENED: 'Reopened',
};

const FILE_LABEL: Record<string, string> = {
  OPEN: 'Open',
  CLOSED: 'Closed',
  REOPENED: 'Reopened',
};

interface Props {
  dossier: DossierView;
  /** True for a role that may finalise or reopen — not preparation staff. */
  canDecide: boolean;
  /** True when this user is the designated reviewer for this matter. */
  awaitingMyDecision: boolean;
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}

/**
 * The decision controls for one matter.
 *
 * What is shown depends on the matter's state and on whether the decision is
 * this user's to make. A senior role is not offered Approve on a matter routed
 * to someone else, because it is not theirs to decide (FR-WFL-004) — and the
 * server refuses it regardless.
 */
export function WorkflowPanel({
  dossier,
  canDecide,
  awaitingMyDecision,
  onChanged,
  onError,
  onMessage,
}: Props) {
  const [reviewers, setReviewers] = useState<{ accountId: string; personName: string }[]>([]);
  const [reviewer, setReviewer] = useState('');
  const [reason, setReason] = useState('');
  const [closeReason, setCloseReason] = useState('');
  const closed = dossier.state === 'CLOSED';
  const [history, setHistory] = useState<WorkflowEventView[] | null>(null);

  const submittable = ['ACTIVE', 'RETURNED'].includes(dossier.processingState);

  useEffect(() => {
    if (submittable) {
      api.eligibleReviewers().then(setReviewers).catch(() => setReviewers([]));
    }
  }, [submittable]);

  const run = async (action: () => Promise<unknown>, done: string) => {
    try {
      await action();
      onMessage(done);
      setHistory(null);
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'The action could not be completed.');
    }
  };

  return (
    <div className="workflow">
      <div className="detail-row">
        <span className="label-inline">Processing state</span>
        <span>
          <span className={dossier.processingState === 'APPROVED' ? 'tag official' : 'tag draft'}>
            {STATE_LABEL[dossier.processingState] ?? dossier.processingState}
          </span>
        </span>
      </div>

      <div className="detail-row">
        <span className="label-inline">Dossier</span>
        <span>
          <span className={closed ? 'tag official' : 'tag draft'}>
            {FILE_LABEL[dossier.state] ?? dossier.state}
          </span>
        </span>
      </div>

      {submittable && reviewers.length > 0 && (
        <div className="assign-row">
          <select
            aria-label={`Reviewer for ${dossier.dossierIdentity}`}
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
          >
            <option value="">Send for review to…</option>
            {reviewers.map((person) => (
              <option key={person.accountId} value={person.accountId}>
                {person.personName}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="secondary small"
            disabled={!reviewer}
            onClick={() =>
              run(
                () => api.submitForReview(dossier.id, reviewer, dossier.version),
                dossier.processingState === 'RETURNED'
                  ? 'Resubmitted for review.'
                  : 'Submitted for review.',
              )
            }
          >
            {dossier.processingState === 'RETURNED' ? 'Resubmit' : 'Submit for review'}
          </button>
        </div>
      )}

      {awaitingMyDecision && (
        <div className="assign-row">
          <span className="label-inline">Your decision</span>
          <input
            type="text"
            aria-label={`Reason for returning ${dossier.dossierIdentity}`}
            placeholder="Reason, required to return for correction"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            type="button"
            className="secondary small"
            disabled={reason.trim().length === 0}
            onClick={() =>
              run(
                () => api.returnForCorrection(dossier.id, reason, dossier.version),
                'Returned for correction.',
              )
            }
          >
            Return for correction
          </button>
          <button
            type="button"
            className="secondary small"
            onClick={() => {
              if (!window.confirm(`Approve ${dossier.dossierIdentity}? This is recorded as your decision.`)) return;
              void run(() => api.approveMatter(dossier.id, dossier.version), 'Approved.');
            }}
          >
            Approve
          </button>
        </div>
      )}

      {dossier.processingState === 'APPROVED' && canDecide && (
        <div className="assign-row">
          <span className="label-inline">Approved</span>
          <button
            type="button"
            className="secondary small"
            onClick={() => {
              if (
                !window.confirm(
                  `Finalise ${dossier.dossierIdentity}? The result is then protected from ordinary change.`,
                )
              )
                return;
              void run(() => api.finaliseMatter(dossier.id, dossier.version), 'Finalised.');
            }}
          >
            Finalise
          </button>
        </div>
      )}

      {dossier.processingState === 'FINALISED' && !closed && (
        <div className="assign-row">
          <p className="footnote">
            This matter is finalised. Its responsibility, deadline and records are protected from
            ordinary change. Reopening is recorded as its own event and does not remove the
            finalisation.
          </p>
          {canDecide && (
            <>
              <input
                type="text"
                aria-label={`Reason for reopening ${dossier.dossierIdentity}`}
                placeholder="Reason, required to reopen"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <button
                type="button"
                className="secondary small"
                disabled={reason.trim().length === 0}
                onClick={() =>
                  run(() => api.reopenMatter(dossier.id, reason, dossier.version), 'Reopened.')
                }
              >
                Reopen
              </button>
            </>
          )}
        </div>
      )}

      {dossier.processingState === 'FINALISED' && !closed && canDecide && (
        <div className="assign-row">
          <span className="label-inline">Close the dossier</span>
          <input
            type="text"
            aria-label={`Reason for closing ${dossier.dossierIdentity}`}
            placeholder="Reason (optional)"
            value={closeReason}
            onChange={(e) => setCloseReason(e.target.value)}
          />
          <button
            type="button"
            className="secondary small"
            onClick={() => {
              if (
                !window.confirm(
                  `Close dossier ${dossier.dossierIdentity}? It stays readable, but nothing can be changed or added until it is reopened.`,
                )
              )
                return;
              void run(
                () => api.closeDossier(dossier.id, closeReason.trim() || null, dossier.version),
                'Dossier closed.',
              );
            }}
          >
            Close dossier
          </button>
        </div>
      )}

      {closed && (
        <div className="assign-row">
          <p className="footnote">
            This dossier is closed. It can be read, but nothing can be changed or added to it.
            Reopening the dossier is recorded as its own event and does not remove the closure.
          </p>
          {canDecide && (
            <>
              <input
                type="text"
                aria-label={`Reason for reopening dossier ${dossier.dossierIdentity}`}
                placeholder="Reason, required to reopen the dossier"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <button
                type="button"
                className="secondary small"
                disabled={reason.trim().length === 0}
                onClick={() =>
                  run(
                    () => api.reopenDossier(dossier.id, reason, dossier.version),
                    'Dossier reopened.',
                  )
                }
              >
                Reopen dossier
              </button>
            </>
          )}
        </div>
      )}

      <button
        type="button"
        className="link-button"
        onClick={async () => {
          if (history) {
            setHistory(null);
            return;
          }
          setHistory(await api.workflowHistory(dossier.id));
        }}
      >
        {history ? 'Hide decision history' : 'Decision history'}
      </button>

      {history && (
        <div className="history">
          {history.length === 0 && <p className="muted small-text">No decisions yet.</p>}
          <ul>
            {history.map((event, i) => (
              <li key={i}>
                <strong>{EVENT_LABEL[event.eventType] ?? event.eventType}</strong> — {event.actorName}
                {event.onBehalfOfName ? `, on behalf of ${event.onBehalfOfName}` : ''}
                {event.reviewerName && event.eventType === 'SUBMITTED'
                  ? ` to ${event.reviewerName}`
                  : ''}{' '}
                on {new Date(event.occurredAt).toLocaleString('en-GB')} (version{' '}
                {event.reviewedVersion})
                {event.reason ? <div className="footnote">Reason: {event.reason}</div> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
