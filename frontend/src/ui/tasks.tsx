import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { useSession } from '../lib/session';
import { Dialog, ErrorNote, Field, Segmented, useToast } from './index';
import { PersonSelect } from './people';

interface Template {
  id: string;
  name: string;
  description: string | null;
  titleTemplate: string;
  defaultPriority: string;
  defaultDueWorkingDays: number | null;
  checklist: string[];
  isActive: boolean;
}

/** A new task — by hand or from a template — for a letter, a matter, or on its own. */
export function NewTaskDialog({ onClose, onCreated, itemId, dossierId, parentTaskId, defaultTitle }: { onClose: () => void; onCreated?: (id: string) => void; itemId?: string; dossierId?: string; parentTaskId?: string; defaultTitle?: string }) {
  const { t } = usePrefs();
  const { user } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'manual' | 'template'>('manual');
  const [title, setTitle] = useState(defaultTitle ?? '');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState(user?.accountId ?? '');
  const [due, setDue] = useState('');
  const [priority, setPriority] = useState('MEDIUM');
  const [checklist, setChecklist] = useState('');
  const [recurrence, setRecurrence] = useState('NONE');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Template[]>('/api/task-templates').then((ts) => setTemplates(ts.filter((x) => x.isActive !== false))).catch(() => setTemplates([]));
  }, []);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let id: string;
      if (mode === 'template') {
        const r = await api.post<{ id?: string; task?: { id: string } }>(`/api/task-templates/${templateId}/apply`, {
          assigneeAccountId: assignee,
          ...(dossierId ? { dossierId } : {}),
          ...(itemId ? { itemId } : {}),
          ...(due ? { dueDate: due } : {}),
          ...(title.trim() ? { title: title.trim() } : {}),
        });
        id = (r.id ?? r.task?.id) as string;
      } else {
        const r = await api.post<{ id: string }>(parentTaskId ? `/api/tasks/${parentTaskId}/subtasks` : '/api/tasks', {
          title: title.trim(),
          description: description.trim() || undefined,
          assigneeAccountId: assignee,
          dueDate: due || null,
          priority,
          ...(dossierId ? { dossierId } : {}),
          ...(itemId ? { itemId } : {}),
          checklist: checklist
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean),
          ...(recurrence !== 'NONE' ? { recurrence } : {}),
        });
        id = r.id;
      }
      toast(t('Taak aangemaakt', 'Task created'));
      window.dispatchEvent(new CustomEvent('juspol:changed'));
      if (onCreated) onCreated(id);
      else navigate(`/taken/${id}`);
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={parentTaskId ? t('Subtaak toevoegen', 'Add subtask') : t('Nieuwe taak', 'New task')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Annuleren', 'Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={busy || !assignee || (mode === 'manual' ? !title.trim() : !templateId)} onClick={() => void submit()}>
            {busy ? t('Bezig…', 'Working…') : t('Taak aanmaken', 'Create task')}
          </button>
        </>
      }
    >
      <form className="stack" style={{ '--gap': '14px' } as React.CSSProperties} onSubmit={submit}>
        {!parentTaskId && templates.length > 0 && (
          <Segmented
            label={t('Soort', 'Kind')}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'manual', label: t('Zelf invullen', 'Fill in') },
              { value: 'template', label: t('Uit sjabloon', 'From template') },
            ]}
          />
        )}
        {mode === 'template' ? (
          <Field label={t('Sjabloon', 'Template')} hint={templates.find((x) => x.id === templateId)?.description ?? undefined}>
            <select className="select" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">{t('Kies een sjabloon…', 'Choose a template…')}</option>
              {templates.map((tp) => (
                <option key={tp.id} value={tp.id}>
                  {tp.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label={mode === 'template' ? t('Titel (anders volgt hij uit het sjabloon)', 'Title (otherwise taken from the template)') : t('Wat moet er gebeuren?', 'What needs doing?')}>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required={mode === 'manual'} />
        </Field>
        {mode === 'manual' && (
          <Field label={t('Toelichting', 'Details')}>
            <textarea className="textarea" style={{ minHeight: 80 }} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        )}
        <div className="form-grid">
          <Field label={t('Voor wie', 'For whom')}>
            <PersonSelect value={assignee} onChange={setAssignee} required />
          </Field>
          <Field label={t('Termijn', 'Due date')}>
            <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
          {mode === 'manual' && (
            <>
              <Field label={t('Prioriteit', 'Priority')}>
                <select className="select" value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="LOW">{t('Laag', 'Low')}</option>
                  <option value="MEDIUM">{t('Normaal', 'Normal')}</option>
                  <option value="HIGH">{t('Hoog', 'High')}</option>
                  <option value="URGENT">{t('Spoed', 'Urgent')}</option>
                </select>
              </Field>
              {!parentTaskId && (
                <Field label={t('Herhalen', 'Repeat')}>
                  <select className="select" value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
                    <option value="NONE">{t('Niet', 'No')}</option>
                    <option value="WEEKLY">{t('Elke week', 'Every week')}</option>
                    <option value="MONTHLY">{t('Elke maand', 'Every month')}</option>
                  </select>
                </Field>
              )}
            </>
          )}
        </div>
        {mode === 'manual' && (
          <Field label={t('Checklist (één punt per regel)', 'Checklist (one point per line)')}>
            <textarea className="textarea" style={{ minHeight: 70 }} value={checklist} onChange={(e) => setChecklist(e.target.value)} />
          </Field>
        )}
        <ErrorNote error={error} />
      </form>
    </Dialog>
  );
}
