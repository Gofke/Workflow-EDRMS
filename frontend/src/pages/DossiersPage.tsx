import { useEffect, useState } from 'react';
import { DossierHistory, DossierView, ItemView, ReviewQueueItem, api } from '../api';
import { TimelinePanel } from './TimelinePanel';
import { WorkflowPanel } from './WorkflowPanel';

/**
 * Dossiers — the matter files.
 *
 * The record picker deliberately offers registered records only. A draft cannot
 * be linked, and the screen explains why rather than silently omitting it, so a
 * user who expects to find their draft here understands what to do.
 */
/** Accounts that may carry responsibility. The server enforces the same list. */
const ELIGIBLE = ['MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR'];

export function DossiersPage() {
  const [dossiers, setDossiers] = useState<DossierView[]>([]);
  const [records, setRecords] = useState<ItemView[]>([]);
  const [subject, setSubject] = useState('');
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [owner, setOwner] = useState<Record<string, string>>({});
  const [due, setDue] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<Record<string, DossierHistory>>({});
  const [people, setPeople] = useState<{ accountId: string; personName: string; roles: string[] }[]>(
    [],
  );
  // The assignment controls are withheld until this list has arrived. Rendering
  // them first meant the list loading mid-interaction re-rendered the picker and
  // silently discarded whatever the user had just selected.
  const [peopleLoaded, setPeopleLoaded] = useState(false);
  /** Actions this user may perform, whether by role or by delegation. */
  const [authority, setAuthority] = useState<
    { action: string; viaDelegationFrom: string | null }[]
  >([]);
  const [authorityLoaded, setAuthorityLoaded] = useState(false);
  /** Matters routed to this user for decision. */
  const [queue, setQueue] = useState<ReviewQueueItem[]>([]);

  const reload = async () => {
    try {
      const [d, r, q] = await Promise.all([api.dossiers(), api.records(), api.reviewQueue()]);
      setDossiers(d);
      setRecords(r);
      setQueue(q);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load dossiers.');
    }
  };

  useEffect(() => {
    void reload();
    api
      .myAuthority()
      .then(setAuthority)
      .catch(() => setAuthority([]))
      .finally(() => setAuthorityLoaded(true));
  }, []);

  const mayAssign = authority.find((a) => a.action === 'ASSIGN_RESPONSIBILITY');
  const maySetDueDate = authority.find((a) => a.action === 'SET_DUE_DATE');
  const canAssign = Boolean(mayAssign || maySetDueDate);
  const actingFor = [mayAssign, maySetDueDate]
    .filter((a) => a?.viaDelegationFrom)
    .map((a) => a?.viaDelegationFrom as string);

  useEffect(() => {
    // Only someone who may act needs the name list, so it is fetched only then.
    if (canAssign) {
      api
        .assignableOfficials()
        .then(setPeople)
        .catch(() => setPeople([]))
        .finally(() => setPeopleLoaded(true));
    }
  }, [canAssign]);

  const run = async (action: () => Promise<unknown>, done: string) => {
    setMessage(null);
    setError(null);
    try {
      await action();
      setMessage(done);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The action could not be completed.');
    }
  };

  const registered = records.filter((item) => item.state === 'REGISTERED');
  const draftCount = records.length - registered.length;

  return (
    <section>
      <h2>Dossiers</h2>
      {/* The delegate is told whose authority they are using, before they use
          it. Convenience may reduce clicks; it may not blur identity. */}
      {actingFor.length > 0 && (
        <p className="notice" role="status">
          You are acting on behalf of {Array.from(new Set(actingFor)).join(' and ')}. Everything you
          record here will name you as the person who acted, and them as the authority.
        </p>
      )}
      {message && <p className="notice" role="status">{message}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      <div className="card inline">
        <h3>Open a new dossier</h3>
        <label htmlFor="dossier-subject">What is the matter about?</label>
        <input
          id="dossier-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
        <p className="footnote">
          The dossier reference is assigned by the system when you open it, and cannot be typed in
          or changed afterwards.
        </p>
        <button
          type="button"
          className="primary"
          onClick={() =>
            run(async () => {
              await api.createDossier(subject);
              setSubject('');
            }, 'Dossier opened. The system has assigned its reference.')
          }
        >
          Open dossier
        </button>
      </div>

      {queue.length > 0 && (
        <p className="notice" role="status">
          {queue.length === 1
            ? 'One matter is awaiting your decision.'
            : `${queue.length} matters are awaiting your decision.`}{' '}
          They are marked “Under review” below.
        </p>
      )}

      {dossiers.length === 0 && <p className="muted">No dossiers yet.</p>}

      {dossiers.map((dossier) => (
        <div key={dossier.id} className="dossier">
          <div className="dossier-head">
            <div>
              <span className="mono strong">{dossier.dossierIdentity}</span>
              <span className="tag official">{dossier.state}</span>
              <div>{dossier.subject}</div>
            </div>
            <div className="footnote">
              Opened {new Date(dossier.createdAt).toLocaleString('en-GB')} by {dossier.createdByName}
            </div>
          </div>

          {dossier.linkedItems.length === 0 ? (
            <p className="muted small-text">No records in this dossier yet.</p>
          ) : (
            <ul className="linked">
              {dossier.linkedItems.map((item) => (
                <li key={item.id}>
                  <span className="mono">{item.registrationIdentity}</span> — {item.subject}
                  <span className="footnote"> ({item.direction.toLowerCase()})</span>
                </li>
              ))}
            </ul>
          )}

          <div className="detail-row">
            <span className="label-inline">Responsible</span>
            <span>{dossier.responsibleName ?? 'Not yet assigned'}</span>
            <span className="label-inline">Official due date</span>
            <span className="mono">{dossier.dueDate ?? 'None set'}</span>
          </div>

          {dossier.processingState !== 'FINALISED' &&
            canAssign &&
            authorityLoaded &&
            !peopleLoaded && (
            <p className="muted small-text">Loading the list of officials…</p>
          )}

          {/* Finalised: the server refuses these changes, so the screen must not
              invite them either (FR-FIN-003). */}
          {dossier.processingState !== 'FINALISED' && canAssign && peopleLoaded && (
            <div className="assign-row">
              <select
                aria-label={`Who is responsible for ${dossier.dossierIdentity}`}
                value={owner[dossier.id] ?? ''}
                onChange={(e) => setOwner({ ...owner, [dossier.id]: e.target.value })}
              >
                <option value="">Assign responsibility to…</option>
                {people
                  .filter((p) => p.roles.some((r) => ELIGIBLE.includes(r)))
                  .map((p) => (
                    <option key={p.accountId} value={p.accountId}>
                      {p.personName}
                    </option>
                  ))}
              </select>
              {mayAssign && (
                <button
                  type="button"
                  className="secondary small"
                  disabled={!owner[dossier.id]}
                  onClick={() =>
                    run(
                      () =>
                        api.assignResponsibility(dossier.id, owner[dossier.id], dossier.version),
                      'Responsibility recorded.',
                    )
                  }
                >
                  Assign
                </button>
              )}

              <input
                type="date"
                aria-label={`Official due date for ${dossier.dossierIdentity}`}
                value={due[dossier.id] ?? dossier.dueDate ?? ''}
                onChange={(e) => setDue({ ...due, [dossier.id]: e.target.value })}
              />
              {dossier.dueDate && (
                <input
                  type="text"
                  aria-label={`Reason for changing the due date of ${dossier.dossierIdentity}`}
                  placeholder="Reason for the change (required)"
                  value={reason[dossier.id] ?? ''}
                  onChange={(e) => setReason({ ...reason, [dossier.id]: e.target.value })}
                />
              )}
              {maySetDueDate && (
              <button
                type="button"
                className="secondary small"
                disabled={!due[dossier.id]}
                onClick={() =>
                  run(
                    () =>
                      api.setDueDate(
                        dossier.id,
                        due[dossier.id],
                        reason[dossier.id] ?? null,
                        dossier.version,
                      ),
                    'Official due date recorded.',
                  )
                }
              >
                {dossier.dueDate ? 'Change due date' : 'Set due date'}
              </button>
              )}
            </div>
          )}

          <button
            type="button"
            className="link-button"
            onClick={async () => {
              if (history[dossier.id]) {
                const next = { ...history };
                delete next[dossier.id];
                setHistory(next);
                return;
              }
              const h = await api.dossierHistory(dossier.id);
              setHistory({ ...history, [dossier.id]: h });
            }}
          >
            {history[dossier.id] ? 'Hide history' : 'Show history'}
          </button>

          {history[dossier.id] && (
            <div className="history">
              <strong>Responsibility</strong>
              <ul>
                {history[dossier.id].responsibility.length === 0 && <li>Never assigned.</li>}
                {history[dossier.id].responsibility.map((entry, i) => (
                  <li key={i}>
                    {entry.responsibleName} — assigned by {entry.assignedByName}
                    {entry.onBehalfOfName ? `, on behalf of ${entry.onBehalfOfName}` : ''} on{' '}
                    {new Date(entry.assignedAt).toLocaleString('en-GB')}
                    {entry.isCurrent ? ' (current)' : ' (superseded)'}
                  </li>
                ))}
              </ul>
              <strong>Official due date</strong>
              <ul>
                {history[dossier.id].dueDates.length === 0 && <li>Never set.</li>}
                {history[dossier.id].dueDates.map((entry, i) => (
                  <li key={i}>
                    {entry.previousDueDate ?? 'none'} → {entry.newDueDate ?? 'none'}, by{' '}
                    {entry.changedByName}
                    {entry.onBehalfOfName ? `, on behalf of ${entry.onBehalfOfName}` : ''} on{' '}
                    {new Date(entry.changedAt).toLocaleString('en-GB')}
                    {entry.reason ? ` — ${entry.reason}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <TimelinePanel dossierId={dossier.id} />

          <WorkflowPanel
            dossier={dossier}
            canDecide={Boolean(mayAssign && !mayAssign.viaDelegationFrom)}
            awaitingMyDecision={queue.some((q) => q.dossierId === dossier.id)}
            onChanged={reload}
            onError={setError}
            onMessage={setMessage}
          />

          {dossier.processingState !== 'FINALISED' && (
          <div className="link-row">
            <select
              aria-label={`Record to add to ${dossier.dossierIdentity}`}
              value={choice[dossier.id] ?? ''}
              onChange={(e) => setChoice({ ...choice, [dossier.id]: e.target.value })}
            >
              <option value="">Select a registered record…</option>
              {/* Records already in this dossier are left out: offering one
                  again only produces a refusal the user cannot act on. */}
              {registered
                .filter(
                  (item) => !dossier.linkedItems.some((linked) => linked.id === item.id),
                )
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.registrationIdentity} — {item.subject}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className="secondary small"
              disabled={!choice[dossier.id]}
              onClick={() =>
                run(
                  () => api.linkRecord(dossier.id, choice[dossier.id]),
                  'Record added to the dossier.',
                )
              }
            >
              Add to dossier
            </button>
          </div>
          )}
        </div>
      ))}

      {draftCount > 0 && (
        <p className="footnote">
          {draftCount} draft {draftCount === 1 ? 'item is' : 'items are'} not listed above. Only a
          registered record can be added to a dossier — register it first.
        </p>
      )}
    </section>
  );
}
