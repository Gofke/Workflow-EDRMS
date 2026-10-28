import { Handshake, Plus } from 'lucide-react';
import { useState } from 'react';
import { api, errorText } from '../lib/api';
import { addDays, date, today } from '../lib/format';
import { useApi } from '../lib/hooks';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { Badge, Confirm, Dialog, Empty, ErrorNote, Field, Loading, PageHead, Panel, useToast } from '../ui';

interface Delegation { id: string; principalAccountId: string; principalName: string; delegateAccountId: string; delegateName: string; permittedActions: string[]; validFrom: string; validUntil: string; grantedByName: string; revokedAt: string | null; isActive: boolean }

const ACTIONS: Record<string, [string, string, string, string]> = {
  ASSIGN_RESPONSIBILITY: ['Verantwoordelijke aanwijzen', 'Assign the responsible official', 'Een zaak aan een behandelaar toewijzen.', 'Assign a matter to an official.'],
  SET_DUE_DATE: ['Termijn zetten of wijzigen', 'Set or change the deadline', 'De termijn van een zaak bepalen, met reden.', 'Decide a matter’s deadline, with a reason.'],
  APPROVE_ON_BEHALF: ['Beslissen namens', 'Decide on behalf', 'Alleen als de regeling dit uitdrukkelijk toestaat.', 'Only where the rules explicitly allow it.'],
};

export default function DelegationsPage() {
  const { t, language } = usePrefs();
  const { user, decision } = useSession();
  const toast = useToast();
  const { data, error, reload } = useApi<Delegation[]>('/api/delegations');
  const authority = useApi<{ action: string; viaDelegationFrom: string | null }[]>('/api/delegations/my-authority');
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState<Delegation | null>(null);
  const actionName = (a: string) => (ACTIONS[a] ? t(ACTIONS[a][0], ACTIONS[a][1]) : a);
  const status = (d: Delegation) => (d.revokedAt ? ['danger', t('Ingetrokken', 'Revoked')] : d.isActive ? ['ok', t('Geldig', 'In force')] : d.validFrom > new Date().toISOString() ? ['info', t('Gaat nog in', 'Not yet started')] : ['neutral', t('Verlopen', 'Expired')]) as ['ok' | 'danger' | 'info' | 'neutral', string];
  const via = (authority.data ?? []).filter((a) => a.viaDelegationFrom);
  return (
    <>
      <PageHead
        title={t('Delegaties', 'Delegations')}
        lead={t(
          'Wie handelt namens wie, waarvoor en tot wanneer. Het register is openbaar voor iedereen in de organisatie, want weten wie namens wie beslist hoort bij verantwoording. Elke handeling namens een ander staat met beide namen in het logboek.',
          'Who acts on behalf of whom, for what and until when. The register is open to everyone in the organisation, because knowing who decides for whom is part of accountability. Every action on behalf of another is in the log with both names.',
        )}
        actions={
          decision && (
            <button type="button" className="btn primary" onClick={() => setGranting(true)}>
              <Plus size={16} /> {t('Bevoegdheid delegeren', 'Delegate authority')}
            </button>
          )
        }
      />
      {via.length > 0 && (
        <div className="notice info" style={{ marginBottom: 18 }}>
          <Handshake size={18} /> {t('U handelt nu ook namens', 'You now also act on behalf of')} {[...new Set(via.map((v) => v.viaDelegationFrom))].join(', ')}: {via.map((v) => actionName(v.action).toLowerCase()).join(', ')}.
        </div>
      )}
      <ErrorNote error={error} />
      <Panel flush>
        {!data ? (
          <Loading />
        ) : data.length === 0 ? (
          <Empty title={t('Geen delegaties', 'No delegations')} />
        ) : (
          <table className="table responsive">
            <thead>
              <tr>
                <th>{t('Namens', 'On behalf of')}</th>
                <th>{t('Handelt', 'Acts')}</th>
                <th>{t('Waarvoor', 'For')}</th>
                <th>{t('Periode', 'Period')}</th>
                <th>{t('Status', 'Status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((d) => {
                const [tone, label] = status(d);
                return (
                  <tr key={d.id} style={d.isActive ? undefined : { opacity: 0.7 }}>
                    <td>
                      <strong>{d.principalName}</strong>
                    </td>
                    <td>{d.delegateName}</td>
                    <td className="small">{d.permittedActions.map(actionName).join(', ')}</td>
                    <td className="small nowrap">
                      {date(d.validFrom, language)} – {date(d.validUntil, language)}
                    </td>
                    <td>
                      <Badge tone={tone}>{label}</Badge>
                    </td>
                    <td>
                      {!d.revokedAt && d.principalAccountId === user?.accountId && new Date(d.validUntil) > new Date() && (
                        <button type="button" className="btn sm ghost" onClick={() => setRevoking(d)}>
                          {t('Intrekken', 'Revoke')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
      {granting && (
        <GrantDialog
          onClose={() => setGranting(false)}
          onDone={() => {
            setGranting(false);
            toast(t('Delegatie vastgelegd', 'Delegation recorded'));
            void reload();
          }}
        />
      )}
      {revoking && (
        <Confirm
          title={t(`Delegatie aan ${revoking.delegateName} intrekken?`, `Revoke the delegation to ${revoking.delegateName}?`)}
          confirmLabel={t('Intrekken', 'Revoke')}
          danger
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            await api.post(`/api/delegations/${revoking.id}/revoke`);
            setRevoking(null);
            toast(t('Delegatie ingetrokken', 'Delegation revoked'));
            void reload();
            void authority.reload();
          }}
        >
          <p className="small" style={{ margin: 0 }}>
            {t('Vanaf nu kan deze persoon niet meer namens u handelen. Wat al gedaan is, blijft geldig en zichtbaar.', 'From now on this person can no longer act on your behalf. What was already done stays valid and visible.')}
          </p>
        </Confirm>
      )}
    </>
  );
}

function GrantDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = usePrefs();
  const candidates = useApi<{ accountId: string; personName: string }[]>('/api/delegations/candidates');
  const [delegate, setDelegate] = useState('');
  const [actions, setActions] = useState<string[]>(['ASSIGN_RESPONSIBILITY', 'SET_DUE_DATE']);
  const [from, setFrom] = useState(today());
  const [until, setUntil] = useState(addDays(today(), 14));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const start = from === today() ? new Date().toISOString() : new Date(`${from}T00:00:00-03:00`).toISOString();
      await api.post('/api/delegations', { delegateAccountId: delegate, actions, validFrom: start, validUntil: new Date(`${until}T23:59:00-03:00`).toISOString() });
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('Bevoegdheid delegeren', 'Delegate authority')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Annuleren', 'Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={busy || !delegate || actions.length === 0 || until < from} onClick={() => void save()}>
            {t('Delegeren', 'Delegate')}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('Aan wie', 'To whom')}>
          {!candidates.data ? (
            <Loading lines={1} />
          ) : (
            <select className="select" value={delegate} onChange={(e) => setDelegate(e.target.value)}>
              <option value="">{t('Kies een persoon…', 'Choose a person…')}</option>
              {candidates.data.map((c) => (
                <option key={c.accountId} value={c.accountId}>
                  {c.personName}
                </option>
              ))}
            </select>
          )}
        </Field>
        <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600, fontSize: 'var(--text-sm)', marginBottom: 6 }}>{t('Waarvoor', 'For what')}</legend>
          <div className="stack" style={{ gap: 8 }}>
            {['ASSIGN_RESPONSIBILITY', 'SET_DUE_DATE'].map((a) => (
              <label key={a} className="check" style={{ alignItems: 'flex-start' }}>
                <input type="checkbox" checked={actions.includes(a)} onChange={(e) => setActions((xs) => (e.target.checked ? [...xs, a] : xs.filter((x) => x !== a)))} />
                <span>
                  <strong>{t(ACTIONS[a][0], ACTIONS[a][1])}</strong>
                  <br />
                  <span className="xs muted">{t(ACTIONS[a][2], ACTIONS[a][3])}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="form-grid">
          <Field label={t('Vanaf', 'From')}>
            <input className="input" type="date" value={from} min={today()} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t('Tot en met', 'Until')} hint={t('Ten hoogste 90 dagen.', 'At most 90 days.')}>
            <input className="input" type="date" value={until} min={from} onChange={(e) => setUntil(e.target.value)} />
          </Field>
        </div>
        <ErrorNote error={error} />
      </div>
    </Dialog>
  );
}
