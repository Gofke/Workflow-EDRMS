import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { date } from '../lib/format';
import { usePrefs } from '../lib/prefs';

export interface PersonRow {
  accountId: string;
  personName: string;
  email: string;
  jobPosition: string | null;
  unitId: string | null;
  unit: string | null;
  isEnabled: boolean;
  roles: string[];
  absentUntil: string | null;
}

let cache: Promise<PersonRow[]> | null = null;

export function usePeople(): PersonRow[] {
  const [people, setPeople] = useState<PersonRow[]>([]);
  useEffect(() => {
    if (!cache) cache = api.get<PersonRow[]>('/api/org/people').catch(() => []);
    void cache.then(setPeople);
  }, []);
  return people;
}

export function forgetPeople() {
  cache = null;
}

/** A person to choose, grouped by department, with who is away marked. */
export function PersonSelect({
  value,
  onChange,
  roles,
  id,
  placeholder,
  exclude,
  required,
}: {
  value: string;
  onChange: (accountId: string) => void;
  roles?: string[];
  id?: string;
  placeholder?: string;
  exclude?: string[];
  required?: boolean;
}) {
  const { t, language } = usePrefs();
  const people = usePeople().filter((p) => p.isEnabled && (!roles || p.roles.some((r) => roles.includes(r))) && !(exclude ?? []).includes(p.accountId));
  const units = [...new Set(people.map((p) => p.unit ?? t('Zonder afdeling', 'No department')))].sort();
  return (
    <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)} required={required}>
      <option value="">{placeholder ?? t('Kies een persoon…', 'Choose a person…')}</option>
      {units.map((u) => (
        <optgroup key={u} label={u}>
          {people
            .filter((p) => (p.unit ?? t('Zonder afdeling', 'No department')) === u)
            .map((p) => (
              <option key={p.accountId} value={p.accountId}>
                {p.personName}
                {p.jobPosition ? ` — ${p.jobPosition}` : ''}
                {p.absentUntil ? ` (${t('afwezig tot', 'away until')} ${date(p.absentUntil, language)})` : ''}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}
