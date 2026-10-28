import { Archive, Lock, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { date } from '../lib/format';
import { useApi } from '../lib/hooks';
import { CLASSIFICATION, RETENTION_ACTION } from '../lib/labels';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { Badge, Dialog, Empty, ErrorNote, Field, Loading, Notice, PageHead, Panel, Segmented, Stamp, Tabs, useToast } from '../ui';
import type { DossierView } from './DossierDetailPage';

type Tab = 'bewaren' | 'archiefplan' | 'bewaarplicht';

interface RetentionRow { id: string; dossierIdentity: string; subject: string; legalHold: boolean; retentionState: string; categoryCode: string; categoryName: string; retentionYears: number; retentionAction: string | null; closedOn: string; retentionEndsOn: string }
interface Category { id: string; code: string; name: string; parentId: string | null; description: string | null; retentionYears: number | null; retentionAction: string | null; handlingWorkingDays: number | null; defaultClassification: string; defaultRouteId: string | null; isActive: boolean; dossierCount: number }

export default function ArchivePage() {
  const { t } = usePrefs();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'bewaren';
  return (
    <>
      <PageHead
        title={t('Archief', 'Archive')}
        lead={t(
          'Elke afgesloten zaak valt onder een categorie van het archiefplan met een bewaartermijn. Als de termijn verloopt, beslist de archiefbeheerder: vernietigen, overbrengen naar het Nationaal Archief, blijvend bewaren of verlengen — altijd met een reden, en vastgelegd in het logboek.',
          'Every closed matter falls under a category of the file plan with a retention period. When the period ends, the records manager decides: destroy, transfer to the National Archive, keep permanently or extend — always with a reason, and recorded in the log.',
        )}
      />
      <Tabs
        label={t('Archief', 'Archive')}
        value={tab}
        onChange={(v) => setParams(v === 'bewaren' ? {} : { tab: v }, { replace: true })}
        tabs={[
          { value: 'bewaren', label: t('Bewaartermijnen', 'Retention') },
          { value: 'archiefplan', label: t('Archiefplan', 'File plan') },
          { value: 'bewaarplicht', label: t('Juridische bewaarplicht', 'Legal hold') },
        ]}
      />
      <div style={{ marginTop: 20 }}>
        {tab === 'bewaren' && <RetentionTab />}
        {tab === 'archiefplan' && <FilePlanTab />}
        {tab === 'bewaarplicht' && <HoldTab />}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ retention

function RetentionTab() {
  const { t, language } = usePrefs();
  const { has } = useSession();
  const [filter, setFilter] = useState<'due' | 'upcoming' | 'all'>('due');
  const { data, error, reload } = useApi<RetentionRow[]>(`/api/casefiles/retention?filter=${filter}`);
  const [deciding, setDeciding] = useState<RetentionRow | null>(null);
  const canDecide = has('RECORDS_MANAGER');
  return (
    <div className="stack" style={{ '--gap': '16px' } as React.CSSProperties}>
      <div className="row between">
        <Segmented
          label={t('Welke zaken', 'Which matters')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'due', label: t('Termijn verlopen', 'Period ended') },
            { value: 'upcoming', label: t('Binnen 90 dagen', 'Within 90 days') },
            { value: 'all', label: t('Alle afgesloten zaken', 'All closed matters') },
          ]}
        />
        {!canDecide && <span className="small muted">{t('Alleen de archiefbeheerder neemt bewaarbesluiten.', 'Only the records manager takes retention decisions.')}</span>}
      </div>
      <ErrorNote error={error} />
      <Panel flush>
        {!data ? (
          <Loading />
        ) : data.length === 0 ? (
          <Empty title={filter === 'due' ? t('Geen verlopen bewaartermijnen', 'No retention periods have ended') : t('Niets in deze lijst', 'Nothing in this list')}>
            {t('Zaken verschijnen hier zodra ze zijn afgesloten en hun bewaartermijn afloopt.', 'Matters appear here once they are closed and their retention period runs out.')}
          </Empty>
        ) : (
          <table className="table responsive">
            <thead>
              <tr>
                <th>{t('Zaak', 'Matter')}</th>
                <th>{t('Categorie', 'Category')}</th>
                <th>{t('Afgesloten', 'Closed')}</th>
                <th>{t('Termijn tot', 'Period until')}</th>
                <th>{t('Volgens het plan', 'Per the plan')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td className="title-cell">
                    <Stamp value={r.dossierIdentity} to={`/zaken/${r.id}?tab=archief`} /> <Link to={`/zaken/${r.id}?tab=archief`}>{r.subject}</Link>
                    {r.legalHold && (
                      <div>
                        <Badge tone="danger">
                          <Lock size={12} /> {t('Bewaarplicht', 'Legal hold')}
                        </Badge>
                      </div>
                    )}
                  </td>
                  <td className="small">
                    {r.categoryName} <span className="xs muted">{r.categoryCode}</span>
                    <div className="xs muted">{r.retentionYears === 0 ? t('geen bewaartermijn', 'no retention period') : t(`${r.retentionYears} jaar`, `${r.retentionYears} years`)}</div>
                  </td>
                  <td className="small nowrap">{date(r.closedOn, language)}</td>
                  <td className="small nowrap">{date(r.retentionEndsOn, language)}</td>
                  <td className="small">{RETENTION_ACTION(t, r.retentionAction)}</td>
                  <td className="nowrap">
                    {canDecide && (
                      <button type="button" className="btn sm" onClick={() => setDeciding(r)}>
                        {t('Besluiten', 'Decide')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {deciding && <DecideDialog row={deciding} onClose={() => setDeciding(null)} onDone={() => (setDeciding(null), void reload())} />}
    </div>
  );
}

function DecideDialog({ row, onClose, onDone }: { row: RetentionRow; onClose: () => void; onDone: () => void }) {
  const { t } = usePrefs();
  const toast = useToast();
  const [decision, setDecision] = useState<'DESTROY' | 'TRANSFER' | 'RETAIN' | 'EXTEND'>(row.retentionAction === 'TRANSFER' ? 'TRANSFER' : row.retentionAction === 'DESTROY' ? 'DESTROY' : 'RETAIN');
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = row.legalHold && (decision === 'DESTROY' || decision === 'TRANSFER');
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/dossiers/${row.id}/retention`, { decision, reason, ...(decision === 'EXTEND' ? { extendUntil: until } : {}) });
      toast(t('Bewaarbesluit vastgelegd', 'Retention decision recorded'));
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t(`Bewaarbesluit voor ${row.dossierIdentity}`, `Retention decision for ${row.dossierIdentity}`)}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Annuleren', 'Cancel')}
          </button>
          <button type="button" className={`btn ${decision === 'DESTROY' ? 'danger' : 'primary'}`} disabled={busy || blocked || !reason.trim() || (decision === 'EXTEND' && !until)} onClick={() => void save()}>
            {t('Besluit vastleggen', 'Record decision')}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small" style={{ margin: 0 }}>
          <strong>{row.subject}</strong>
          <br />
          {t('Het archiefplan zegt:', 'The file plan says:')} {RETENTION_ACTION(t, row.retentionAction)}
        </p>
        <fieldset className="stack" style={{ border: 'none', padding: 0, margin: 0, gap: 8 }}>
          <legend style={{ fontWeight: 600, fontSize: "var(--text-sm)", marginBottom: 4 }}>{t('Besluit', 'Decision')}</legend>
          {(
            [
              ['DESTROY', t('Vernietigen', 'Destroy'), t('De zaak wordt als vernietigd geregistreerd. Het logboek bewaart wie, wanneer en waarom.', 'The matter is recorded as destroyed. The log keeps who, when and why.')],
              ['TRANSFER', t('Overbrengen naar het Nationaal Archief', 'Transfer to the National Archive'), t('Eerst het overdrachtspakket downloaden op de zaak (tab Archief).', 'First download the transfer package on the matter (Archive tab).')],
              ['RETAIN', t('Blijvend bewaren', 'Keep permanently'), t('Voor zaken van blijvende waarde.', 'For matters of lasting value.')],
              ['EXTEND', t('Termijn verlengen', 'Extend the period'), t('Kies tot wanneer.', 'Choose until when.')],
            ] as const
          ).map(([v, label, hint]) => (
            <label key={v} className="check" style={{ alignItems: 'flex-start' }}>
              <input type="radio" name="decision" checked={decision === v} onChange={() => setDecision(v)} />
              <span>
                <strong>{label}</strong>
                <br />
                <span className="xs muted">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {decision === 'EXTEND' && (
          <Field label={t('Verlengen tot', 'Extend until')}>
            <input className="input" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </Field>
        )}
        <Field label={t('Reden', 'Reason')} hint={t('Verplicht. De reden komt in het logboek.', 'Required. The reason goes into the log.')}>
          <textarea className="textarea" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {blocked && <Notice tone="danger">{t('Deze zaak valt onder juridische bewaarplicht. Hef die eerst op.', 'This matter is under legal hold. Release it first.')}</Notice>}
        <ErrorNote error={error} />
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ file plan

const EMPTY: Omit<Category, 'id' | 'dossierCount'> = { code: '', name: '', parentId: null, description: '', retentionYears: 10, retentionAction: 'REVIEW', handlingWorkingDays: 20, defaultClassification: 'INTERNAL', defaultRouteId: null, isActive: true };

function FilePlanTab() {
  const { t } = usePrefs();
  const { has } = useSession();
  const { data, error, reload } = useApi<Category[]>('/api/casefiles/categories?all=true');
  const routes = useApi<{ id: string; name: string }[]>('/api/approval-routes');
  const [editing, setEditing] = useState<(Omit<Category, 'id' | 'dossierCount'> & { id?: string }) | null>(null);
  const canEdit = has('RECORDS_MANAGER', 'SYS_ADMIN');
  return (
    <div className="stack" style={{ '--gap': '16px' } as React.CSSProperties}>
      <div className="row between">
        <p className="muted" style={{ margin: 0, maxWidth: '70ch' }}>
          {t('Per categorie: hoe lang een zaak bewaard blijft, wat er daarna gebeurt, binnen hoeveel werkdagen een zaak normaal wordt afgehandeld en welke goedkeuringsroute erbij hoort.', 'Per category: how long a matter is kept, what happens afterwards, within how many working days a matter is normally handled and which approval route applies.')}
        </p>
        {canEdit && (
          <button type="button" className="btn primary" onClick={() => setEditing({ ...EMPTY })}>
            <Plus size={16} /> {t('Nieuwe categorie', 'New category')}
          </button>
        )}
      </div>
      <ErrorNote error={error} />
      <Panel flush>
        {!data ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('Code', 'Code')}</th>
                  <th>{t('Categorie', 'Category')}</th>
                  <th>{t('Bewaren', 'Keep')}</th>
                  <th>{t('Daarna', 'Then')}</th>
                  <th>{t('Afhandeling', 'Handling')}</th>
                  <th>{t('Zaken', 'Matters')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((c) => (
                  <tr key={c.id} style={c.isActive ? undefined : { opacity: 0.6 }}>
                    <td>
                      <span className="stamp">{c.code}</span>
                    </td>
                    <td>
                      <strong>{c.name}</strong>
                      {!c.isActive && (
                        <>
                          {' '}
                          <Badge>{t('niet meer in gebruik', 'no longer used')}</Badge>
                        </>
                      )}
                      {c.description && <div className="xs muted">{c.description}</div>}
                    </td>
                    <td className="nowrap">{c.retentionYears === null ? '—' : c.retentionYears === 0 ? t('niet', 'no') : t(`${c.retentionYears} jaar`, `${c.retentionYears} years`)}</td>
                    <td className="small">{RETENTION_ACTION(t, c.retentionAction)}</td>
                    <td className="nowrap small">{c.handlingWorkingDays ? t(`${c.handlingWorkingDays} werkdagen`, `${c.handlingWorkingDays} working days`) : '—'}</td>
                    <td>{c.dossierCount}</td>
                    <td>
                      {canEdit && (
                        <button type="button" className="icon-btn" aria-label={t(`${c.name} wijzigen`, `Edit ${c.name}`)} onClick={() => setEditing({ ...c, description: c.description ?? '' })}>
                          <Pencil size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {editing && <CategoryDialog value={editing} routes={routes.data ?? []} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), void reload())} />}
    </div>
  );
}

function CategoryDialog({ value, routes, onClose, onSaved }: { value: Omit<Category, 'id' | 'dossierCount'> & { id?: string }; routes: { id: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const { t } = usePrefs();
  const toast = useToast();
  const [v, setV] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }));
  const save = async () => {
    setBusy(true);
    setError(null);
    const body = { code: v.code.trim(), name: v.name.trim(), parentId: v.parentId, description: v.description ?? '', retentionYears: v.retentionYears, retentionAction: v.retentionAction, handlingWorkingDays: v.handlingWorkingDays, defaultClassification: v.defaultClassification, defaultRouteId: v.defaultRouteId, isActive: v.isActive };
    try {
      if (v.id) await api.put(`/api/casefiles/categories/${v.id}`, body);
      else await api.post('/api/casefiles/categories', body);
      toast(t('Categorie opgeslagen', 'Category saved'));
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={v.id ? t('Categorie wijzigen', 'Edit category') : t('Nieuwe categorie', 'New category')}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Annuleren', 'Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={busy || !v.code.trim() || v.name.trim().length < 2} onClick={() => void save()}>
            {t('Opslaan', 'Save')}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={t('Code', 'Code')}>
          <input className="input" value={v.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} maxLength={40} />
        </Field>
        <Field label={t('Naam', 'Name')}>
          <input className="input" value={v.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label={t('Omschrijving', 'Description')} className="wide">
          <textarea className="textarea" rows={2} value={v.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <Field label={t('Bewaartermijn in jaren', 'Retention in years')} hint={t('0 = niet bewaren na afsluiten', '0 = not kept after closing')}>
          <input className="input" type="number" min={0} max={200} value={v.retentionYears ?? ''} onChange={(e) => set({ retentionYears: e.target.value === '' ? null : Number(e.target.value) })} />
        </Field>
        <Field label={t('Daarna', 'Then')}>
          <select className="select" value={v.retentionAction ?? ''} onChange={(e) => set({ retentionAction: e.target.value || null })}>
            <option value="DESTROY">{RETENTION_ACTION(t, 'DESTROY')}</option>
            <option value="TRANSFER">{RETENTION_ACTION(t, 'TRANSFER')}</option>
            <option value="REVIEW">{RETENTION_ACTION(t, 'REVIEW')}</option>
          </select>
        </Field>
        <Field label={t('Normale afhandeltermijn (werkdagen)', 'Normal handling time (working days)')}>
          <input className="input" type="number" min={1} max={365} value={v.handlingWorkingDays ?? ''} onChange={(e) => set({ handlingWorkingDays: e.target.value === '' ? null : Number(e.target.value) })} />
        </Field>
        <Field label={t('Standaard vertrouwelijkheid', 'Default confidentiality')}>
          <select className="select" value={v.defaultClassification} onChange={(e) => set({ defaultClassification: e.target.value })}>
            {['OPEN', 'INTERNAL', 'CONFIDENTIAL', 'SECRET'].map((c) => (
              <option key={c} value={c}>
                {t(CLASSIFICATION[c][0], CLASSIFICATION[c][1])}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Goedkeuringsroute', 'Approval route')}>
          <select className="select" value={v.defaultRouteId ?? ''} onChange={(e) => set({ defaultRouteId: e.target.value || null })}>
            <option value="">{t('Geen vaste route', 'No fixed route')}</option>
            {routes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <label className="check">
          <input type="checkbox" checked={v.isActive} onChange={(e) => set({ isActive: e.target.checked })} /> {t('In gebruik', 'In use')}
        </label>
      </div>
      <ErrorNote error={error} />
    </Dialog>
  );
}

// ------------------------------------------------------------------ legal hold

function HoldTab() {
  const { t } = usePrefs();
  const { data, error } = useApi<DossierView[]>('/api/dossiers');
  const held = (data ?? []).filter((d) => d.legalHold);
  return (
    <div className="stack" style={{ '--gap': '16px' } as React.CSSProperties}>
      <p className="muted" style={{ margin: 0, maxWidth: '72ch' }}>
        {t('Een zaak onder juridische bewaarplicht kan niet worden vernietigd of overgebracht, wat het archiefplan ook zegt — bijvoorbeeld bij een lopende rechtszaak. Instellen en opheffen gebeurt op de zaak zelf, met een reden.', 'A matter under legal hold cannot be destroyed or transferred, whatever the file plan says — for example during a court case. Setting and releasing happens on the matter itself, with a reason.')}
      </p>
      <ErrorNote error={error} />
      <Panel flush>
        {!data ? (
          <Loading />
        ) : held.length === 0 ? (
          <Empty title={t('Geen zaken onder bewaarplicht', 'No matters under legal hold')} />
        ) : (
          <ul className="list">
            {held.map((d) => (
              <li key={d.id}>
                <Link to={`/zaken/${d.id}?tab=archief`} className="list-link">
                  <Archive size={18} style={{ marginTop: 3, color: 'var(--danger)', flex: 'none' }} aria-hidden="true" />
                  <span className="grow stack" style={{ gap: 3 }}>
                    <span className="list-title">{d.subject}</span>
                    <span className="meta">
                      <Stamp value={d.dossierIdentity} />
                      <span>{d.owningUnit}</span>
                      <span>{d.responsibleName ?? ''}</span>
                    </span>
                  </span>
                  <Badge tone="danger">
                    <Lock size={12} /> {t('Bewaarplicht', 'Legal hold')}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
