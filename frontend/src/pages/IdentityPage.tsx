import { APP_VERSION, AuthenticatedUser } from '../api';
import { AdminPage } from './AdminPage';
import { DelegationsPage } from './DelegationsPage';
import { DossiersPage } from './DossiersPage';
import { RecordsPage } from './RecordsPage';

interface Props {
  user: AuthenticatedUser;
  onSignOut: () => void;
}

/**
 * The one protected screen in V0.1.1. It shows the authenticated identity and
 * the active functional roles, which is what a tester needs in order to confirm
 * that accounts are individual and that roles are configured per account.
 */
export function IdentityPage({ user, onSignOut }: Props) {
  return (
    <div className="shell">
      <header className="bar">
        <div>
          <p className="eyebrow">Ministry of Justice and Police</p>
          <strong>JusPol EDRMS</strong>
        </div>
        <button type="button" className="secondary" onClick={onSignOut}>
          Sign out
        </button>
      </header>

      <main className="content">
        <h1>Signed in</h1>
        <p className="muted">This screen is only reachable with a valid session.</p>

        <table className="detail">
          <tbody>
            <tr>
              <th scope="row">Name</th>
              <td>{user.personName}</td>
            </tr>
            <tr>
              <th scope="row">Job position</th>
              <td>{user.jobPosition ?? '—'}</td>
            </tr>
            <tr>
              <th scope="row">Email</th>
              <td>{user.email}</td>
            </tr>
            <tr>
              <th scope="row">Organisational unit</th>
              <td>{user.organisationalUnit ?? '—'}</td>
            </tr>
            <tr>
              <th scope="row">Active functional roles</th>
              <td>
                {user.roles.length === 0
                  ? 'None assigned'
                  : user.roles.map((role) => role.name).join(', ')}
              </td>
            </tr>
          </tbody>
        </table>

        <p className="footnote">
          Holding a role does not by itself grant access to any individual record. Record-level
          permission evaluation is not part of version {APP_VERSION}.
        </p>

        {/* Each section is shown only to a role that may use it. The server
            enforces the same rule on every route, so hiding a section is a
            convenience, never the control. */}
        {user.roles.some((role) =>
          ['SUPPORT_STAFF', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'MINISTER'].includes(role.code),
        ) && (
          <>
            <RecordsPage />
            <DossiersPage />
            <DelegationsPage
              canDelegate={user.roles.some((role) =>
                ['MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR'].includes(role.code),
              )}
              ownName={user.personName}
            />
          </>
        )}

        {user.roles.some((role) => role.code === 'SYS_ADMIN') && <AdminPage />}
      </main>
    </div>
  );
}
