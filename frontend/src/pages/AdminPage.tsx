import { useEffect, useState } from 'react';
import { AccountSummary, AuditEventRow, ROLE_OPTIONS, api } from '../api';

/**
 * Account administration. Only reachable by an account holding SYS_ADMIN — the
 * server enforces that; this component merely offers the controls.
 *
 * Every state-changing control asks for confirmation first, so no destructive
 * action happens on a single stray click.
 */
export function AdminPage() {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [events, setEvents] = useState<AuditEventRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<Record<string, string>>({});

  const reload = async () => {
    try {
      const [a, e] = await Promise.all([api.accounts(), api.auditTrail()]);
      setAccounts(a);
      setEvents(e);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load accounts.');
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const act = async (confirmText: string, action: () => Promise<unknown>, done: string) => {
    setMessage(null);
    setError(null);
    if (!window.confirm(confirmText)) return;
    try {
      await action();
      setMessage(done);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The change could not be applied.');
    }
  };

  return (
    <section>
      <h2>Account administration</h2>
      {message && <p className="notice" role="status">{message}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      <div className="table-scroll">
      <table className="grid">
        <thead>
          <tr>
            <th>Person</th>
            <th>Email</th>
            <th>Status</th>
            <th>Active roles</th>
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <tr key={account.accountId}>
              <td>{account.personName}</td>
              <td className="mono">{account.email}</td>
              <td>{account.isEnabled ? 'Enabled' : 'Disabled'}</td>
              <td>
                {account.roles.length === 0
                  ? 'None'
                  : account.roles.map((r) => (
                      <span key={r.code} className="chip">
                        {r.name}
                        <button
                          type="button"
                          className="chip-remove"
                          title={`Revoke ${r.name}`}
                          onClick={() =>
                            act(
                              `Revoke the role ${r.name} from ${account.personName}?`,
                              () => api.revokeRole(account.accountId, r.code),
                              `Revoked ${r.name} from ${account.personName}.`,
                            )
                          }
                        >
                          Revoke
                        </button>
                      </span>
                    ))}
              </td>
              <td>
                <select
                  aria-label={`Role to assign to ${account.personName}`}
                  value={role[account.accountId] ?? ''}
                  onChange={(e) => setRole({ ...role, [account.accountId]: e.target.value })}
                >
                  <option value="">Select a role…</option>
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="secondary small"
                  disabled={!role[account.accountId]}
                  onClick={() =>
                    act(
                      `Assign this role to ${account.personName}?`,
                      () => api.assignRole(account.accountId, role[account.accountId]),
                      `Role assigned to ${account.personName}.`,
                    )
                  }
                >
                  Assign
                </button>
                <button
                  type="button"
                  className="secondary small"
                  onClick={() =>
                    act(
                      account.isEnabled
                        ? `Disable the account of ${account.personName}? They will not be able to sign in.`
                        : `Enable the account of ${account.personName}?`,
                      () => api.setEnabled(account.accountId, !account.isEnabled),
                      account.isEnabled ? 'Account disabled.' : 'Account enabled.',
                    )
                  }
                >
                  {account.isEnabled ? 'Disable' : 'Enable'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <h2>Event history</h2>
      <p className="muted">
        Newest first. This history cannot be edited or deleted, by anyone.
      </p>
      <div className="table-scroll">
      <table className="grid">
        <thead>
          <tr>
            <th>When (server time)</th>
            <th>Event</th>
            <th>What happened</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td className="mono">{new Date(event.occurredAt).toLocaleString('en-GB')}</td>
              <td className="mono">{event.eventType}</td>
              <td>{event.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}
