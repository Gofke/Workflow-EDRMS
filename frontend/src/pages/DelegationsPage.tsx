import { useEffect, useState } from 'react';
import { DELEGATABLE_ACTIONS, DelegationView, api } from '../api';

interface Props {
  /** True for a role that DEC-13 configuration permits to delegate. */
  canDelegate: boolean;
  ownName: string;
}

/**
 * The delegation register.
 *
 * Everyone with a business role can read it, deliberately: knowing who is
 * currently acting for whom is part of knowing who is accountable. Granting is
 * limited to roles that hold the authority, and only the principal sees a
 * revoke control on their own grants.
 */
export function DelegationsPage({ canDelegate, ownName }: Props) {
  const [rows, setRows] = useState<DelegationView[]>([]);
  const [people, setPeople] = useState<{ accountId: string; personName: string }[]>([]);
  const [delegate, setDelegate] = useState('');
  const [actions, setActions] = useState<string[]>([]);
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [until, setUntil] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () =>
    api
      .delegations()
      .then(setRows)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load delegations.'));

  useEffect(() => {
    void reload();
    if (canDelegate) {
      // Candidates, not assignable officials: support staff are the usual
      // delegates and are absent from the responsibility list by design.
      api.delegationCandidates().then(setPeople).catch(() => setPeople([]));
    }
  }, [canDelegate]);

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

  return (
    <section>
      <h2>Delegated authority</h2>
      {message && <p className="notice" role="status">{message}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      <div className="table-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th>Authority of</th>
              <th>May be used by</th>
              <th>For</th>
              <th>From</th>
              <th>Until</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} className="muted">No authority has been delegated.</td></tr>
            )}
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.principalName}</td>
                <td>{row.delegateName}</td>
                <td>
                  {row.permittedActions
                    .map((a) => DELEGATABLE_ACTIONS.find((d) => d.code === a)?.label ?? a)
                    .join('; ')}
                </td>
                <td className="mono">{new Date(row.validFrom).toLocaleDateString('en-GB')}</td>
                <td className="mono">{new Date(row.validUntil).toLocaleDateString('en-GB')}</td>
                <td>
                  <span className={row.isActive ? 'tag official' : 'tag draft'}>
                    {row.revokedAt ? 'Revoked' : row.isActive ? 'Active' : 'Not in effect'}
                  </span>
                </td>
                <td>
                  {row.principalName === ownName && !row.revokedAt && (
                    <button
                      type="button"
                      className="secondary small"
                      onClick={() => {
                        if (!window.confirm(`Revoke this authority from ${row.delegateName}?`)) return;
                        void run(
                          () => api.revokeDelegation(row.id),
                          `Authority revoked from ${row.delegateName}.`,
                        );
                      }}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canDelegate && (
        <div className="card inline">
          <h3>Delegate your authority</h3>
          <p className="footnote">
            The person signs in as themselves. No password is shared, and every action they take
            under your authority records both their name and yours.
          </p>

          <label htmlFor="delegate">Who may act for you</label>
          <select id="delegate" value={delegate} onChange={(e) => setDelegate(e.target.value)}>
            <option value="">Select a person…</option>
            {people
              .filter((person) => person.personName !== ownName)
              .map((person) => (
                <option key={person.accountId} value={person.accountId}>
                  {person.personName}
                </option>
              ))}
          </select>

          <label>What they may do</label>
          {DELEGATABLE_ACTIONS.map((action) => (
            <label key={action.code} className="checkbox">
              <input
                type="checkbox"
                checked={actions.includes(action.code)}
                onChange={(e) =>
                  setActions((current) =>
                    e.target.checked
                      ? [...current, action.code]
                      : current.filter((c) => c !== action.code),
                  )
                }
              />
              {action.label}
            </label>
          ))}

          <label htmlFor="from">From</label>
          <input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <label htmlFor="until">Until</label>
          <input id="until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />

          <button
            type="button"
            className="primary"
            disabled={!delegate || actions.length === 0 || !until}
            onClick={() =>
              run(async () => {
                await api.grantDelegation({
                  delegateAccountId: delegate,
                  actions,
                  validFrom: new Date(from).toISOString(),
                  validUntil: new Date(`${until}T23:59:59`).toISOString(),
                });
                setDelegate('');
                setActions([]);
                setUntil('');
              }, 'Authority delegated.')
            }
          >
            Delegate authority
          </button>
        </div>
      )}
    </section>
  );
}
