import { useEffect, useLayoutEffect, useState } from 'react';
import { NavigateFunction } from 'react-router-dom';
import { usePrefs } from '../lib/prefs';

interface Step {
  target: string;
  nl: [string, string];
  en: [string, string];
}

const STEPS: Step[] = [
  { target: 'mywork', nl: ['Mijn werk', 'Hier begint uw dag: wat op uw besluit wacht, uw taken met hun termijn, adviezen die u moet geven en concepten die nog geregistreerd moeten worden.'], en: ['My work', 'Your day starts here: what awaits your decision, your tasks and their deadlines, advice you owe and drafts still to register.'] },
  { target: 'post', nl: ['Post', 'Alle binnenkomende en uitgaande brieven. Registreer een brief, voeg de scan toe en laat de assistent de velden voorstellen.'], en: ['Post', 'All incoming and outgoing letters. Register a letter, add the scan and let the assistant propose the fields.'] },
  { target: 'search', nl: ['Zoeken', 'Zoek in brieven, zaken, taken en de tekst in documenten. U vindt alleen wat u mag zien.'], en: ['Search', 'Search letters, matters, tasks and the text inside documents. You only find what you may see.'] },
  { target: 'chat', nl: ['De assistent', 'Stel een vraag in gewone taal: “Wat staat er vandaag klaar?”, “Vat deze zaak samen”, “Maak een taak voor …”. Hij stelt voor; u beslist.'], en: ['The assistant', 'Ask in plain language: “What is waiting today?”, “Summarise this matter”, “Create a task for …”. It proposes; you decide.'] },
  { target: 'assistant', nl: ['Hulpmiddelen van de assistent', 'Termijnrisico’s, actiepunten uit notulen en vragen over uw werk, op één plek.'], en: ['Assistant tools', 'Deadline risks, action items from meeting notes and questions about your work, in one place.'] },
  { target: 'overview', nl: ['Bestuurlijk overzicht', 'Voor de leiding: open en te late zaken, prestaties per afdeling en de trends.'], en: ['Management overview', 'For management: open and overdue matters, department performance and trends.'] },
];

/** A short guided tour of the main screens, shown once and available from the user menu. */
export function Tour({ onDone }: { onDone: () => void; navigate: NavigateFunction }) {
  const { language, t } = usePrefs();
  const steps = STEPS.filter((s) => document.querySelector(`[data-tour="${s.target}"]`));
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = steps[i];

  useLayoutEffect(() => {
    if (!step) return;
    const el = document.querySelector(`[data-tour="${step.target}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
    setRect(el?.getBoundingClientRect() ?? null);
  }, [step]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onDone();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onDone]);

  if (!step) return null;
  const [title, text] = language === 'en' ? step.en : step.nl;
  const top = rect ? Math.min(window.innerHeight - 230, Math.max(12, rect.top)) : 120;
  const left = rect ? (rect.right + 400 < window.innerWidth ? rect.right + 16 : Math.max(12, rect.left - 396)) : 120;
  return (
    <>
      {rect && <div className="tour-ring" style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }} />}
      <div className="tour" role="dialog" aria-label={t('Rondleiding', 'Guided tour')} style={{ top, left }}>
        <div className="xs muted">
          {t('Stap', 'Step')} {i + 1} / {steps.length}
        </div>
        <h2 style={{ fontSize: '1.1rem', margin: '4px 0 6px' }}>{title}</h2>
        <p>{text}</p>
        <div className="row between" style={{ marginTop: 14 }}>
          <button type="button" className="btn ghost sm" onClick={onDone}>
            {t('Overslaan', 'Skip')}
          </button>
          <div className="row">
            {i > 0 && (
              <button type="button" className="btn sm" onClick={() => setI(i - 1)}>
                {t('Vorige', 'Back')}
              </button>
            )}
            <button type="button" className="btn sm primary" onClick={() => (i + 1 < steps.length ? setI(i + 1) : onDone())}>
              {i + 1 < steps.length ? t('Volgende', 'Next') : t('Klaar', 'Done')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
