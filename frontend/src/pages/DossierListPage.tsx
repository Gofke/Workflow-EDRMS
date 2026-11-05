import { Lock, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { today } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { CLASSIFICATION } from '../lib/labels';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { Badge, ClassStamp, Confirm, Due, Empty, ErrorNote, Field, Loading, PageHead, Panel, ProcessingBadge, Segmented, Stamp, usePager } from '../ui';
import { DossierView } from './DossierDetailPage';

interface Category {
  id: string;
  code: string;
  name: string;
  defaultClassification: string | null;
  handlingWorkingDays: number | null;
}

export default function DossierListPage() {
  const { t } = usePrefs();
  const { user } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { data, error, loading } = useApi<DossierView[]>('/api/dossiers');
  const categories = useApi<Category[]>('/api/casefiles/categories');
  const [q, setQ] = useState('');
  const view = params.get('view') ?? 'open';
  const mine = params.get('mine') === '1';
  const [newOpen, setNewOpen] = useState(false);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const now = today();
    return (data ?? [])
      .filter((d) => {
        if (view === 'open') return d.state !== 'CLOSED' && d.processingState !== 'FINALISED';
        if (view === 'review') return d.processingState === 'UNDER_REVIEW';
        if (view === 'overdue') return d.state !== 'CLOSED' && d.processingState !== 'FINALISED' && d.dueDate !== null && d.dueDate < now;
        if (view === 'done') return d.processingState === 'FINALISED' || d.state === 'CLOSED';
        return true;
      })
      .filter((d) => !mine || d.responsibleAccountId === user?.accountId)
      .filter((d) => !needle || `${d.dossierIdentity} ${d.subject} ${d.responsibleName ?? ''}`.toLowerCase().includes(needle))
      .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
  }, [data, q, view, mine, user]);
  const { page: pageRows, pager } = usePager(rows);

  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v === null) next.delete(k);
    else next.set(k, v);
    setParams(next, { replace: true });
  };
  const categoryName = (id: string | null) => categories.data?.find((c) => c.id === id)?.name;

  return (
    <>
      <PageHead
        title={t('Zaken', 'Matters')}
        lead={t('Elke zaak bundelt de stukken, taken, adviezen en besluiten over één onderwerp, met een verantwoordelijke en een termijn.', 'Each matter brings together the records, tasks, advice and decisions on one subject, with a responsible official and a deadline.')}
        actions={
          <button type="button" className="btn primary" onClick={() => setNewOpen(true)}>
            <Plus size={18} /> {t('Nieuwe zaak', 'New matter')}
          </button>
        }
      />
      <div className="filters">
        <Field label={t('Zoeken in de lijst', 'Filter the list')}>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Nummer of woord', 'Number or word')} />
        </Field>
        <Segmented
          label={t('Weergave', 'View')}
          value={view}
          onChange={(v) => set('view', v)}
          options={[
            { value: 'open', label: t('Lopend', 'Open') },
            { value: 'review', label: t('Ter beoordeling', 'Under review') },
            { value: 'overdue', label: t('Over termijn', 'Overdue') },
            { value: 'done', label: t('Afgerond', 'Finished') },
            { value: 'all', label: t('Alles', 'All') },
          ]}
        />
        <label className="check">
          <input type="checkbox" checked={mine} onChange={(e) => set('mine', e.target.checked ? '1' : null)} />
          {t('Alleen waarvoor ik verantwoordelijk ben', 'Only those I am responsible for')}
        </label>
      </div>
      <ErrorNote error={error} />
      <Panel flush>
        {loading && !data ? (
          <div style={{ padding: 20 }}>
            <Loading lines={6} />
          </div>
        ) : rows.length === 0 ? (
          <Empty title={t('Geen zaken in deze weergave', 'No matters in this view')} />
        ) : (
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>{t('Nummer', 'Number')}</th>
                  <th>{t('Onderwerp', 'Subject')}</th>
                  <th>{t('Verantwoordelijk', 'Responsible')}</th>
                  <th>{t('Status', 'Status')}</th>
                  <th>{t('Termijn', 'Deadline')}</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((d) => (
                  <tr key={d.id} className="clickable" onClick={() => navigate(`/zaken/${d.id}`)}>
                    <td>
                      <Stamp value={d.dossierIdentity} />
                    </td>
                    <td className="title-cell">
                      <Link to={`/zaken/${d.id}`} onClick={(e) => e.stopPropagation()}>
                        {d.subject}
                      </Link>
                      <div className="row small muted" style={{ gap: 8, marginTop: 2 }}>
                        <span>{categoryName(d.categoryId) ?? t('zonder categorie', 'no category')}</span>
                        <span>
                          {d.linkedItems.length} {t(d.linkedItems.length === 1 ? 'stuk' : 'stukken', d.linkedItems.length === 1 ? 'record' : 'records')}
                        </span>
                        <ClassStamp level={d.classification} />
                        {d.legalHold && (
                          <Badge tone="danger">
                            <Lock size={11} /> {t('bewaarplicht', 'legal hold')}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td>{d.responsibleName ?? <span className="muted">{t('nog niemand', 'nobody yet')}</span>}</td>
                    <td>
                      <ProcessingBadge state={d.processingState} closed={d.state === 'CLOSED'} />
                    </td>
                    <td>
                      <Due date={d.dueDate} done={d.processingState === 'FINALISED' || d.state === 'CLOSED'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pager}
          </div>
        )}
      </Panel>
      {newOpen && <NewDossierDialog categories={categories.data ?? []} onClose={() => setNewOpen(false)} onCreated={(id) => navigate(`/zaken/${id}`)} />}
    </>
  );
}

function NewDossierDialog({ categories, onClose, onCreated }: { categories: Category[]; onClose: () => void; onCreated: (id: string) => void }) {
  const { t, language } = usePrefs();
  const [subject, setSubject] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [classification, setClassification] = useState('');
  const { busy, error, run } = useAction();
  const cat = categories.find((c) => c.id === categoryId);
  return (
    <Confirm
      title={t('Nieuwe zaak openen', 'Open a new matter')}
      confirmLabel={t('Zaak openen', 'Open matter')}
      onClose={onClose}
      busy={busy}
      error={error}
      disabled={!subject.trim()}
      onConfirm={() =>
        void run(async () => {
          const d = await api.post<{ id: string }>('/api/dossiers', { subject: subject.trim(), ...(categoryId ? { categoryId } : {}), ...(classification ? { classification } : {}) });
          window.dispatchEvent(new CustomEvent('juspol:changed'));
          onCreated(d.id);
        })
      }
    >
      <Field label={t('Onderwerp', 'Subject')}>
        <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </Field>
      <Field label={t('Categorie uit het archiefplan', 'Category from the file plan')} hint={cat?.handlingWorkingDays ? t(`Behandeltermijn ${cat.handlingWorkingDays} werkdagen.`, `Handling time ${cat.handlingWorkingDays} working days.`) : undefined}>
        <select className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">{t('Geen categorie', 'No category')}</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} — {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('Vertrouwelijkheid', 'Confidentiality')} hint={t('Leeg laten: volgt de categorie of de standaard.', 'Leave empty: follows the category or the default.')}>
        <select className="select" value={classification} onChange={(e) => setClassification(e.target.value)}>
          <option value="">{t('Standaard', 'Default')}</option>
          {Object.entries(CLASSIFICATION).map(([k, v]) => (
            <option key={k} value={k}>
              {language === 'en' ? v[1] : v[0]}
            </option>
          ))}
        </select>
      </Field>
    </Confirm>
  );
}
