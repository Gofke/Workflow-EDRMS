/**
 * Subject areas of the Ministry of Justice and Police, the words that signal
 * them, and the words in a unit's name that mark the unit dealing with them.
 * A starting point only: routing suggestions learn from where earlier letters
 * actually went, and that history outweighs this list as soon as it exists.
 */
export interface Topic {
  code: string;
  nl: string;
  en: string;
  words: string[];
  unitHints: string[];
}

export const TOPICS: Topic[] = [
  {
    code: 'DETENTION',
    nl: 'Justitiële inrichtingen en detentie',
    en: 'Prisons and detention',
    words: ['gedetineerde', 'gedetineerden', 'detentie', 'penitentiaire', 'inrichting', 'santo boma', 'overplaatsing', 'gevangenis', 'cel', 'bezoekregeling', 'verlof', 'prisoner', 'detention', 'prison', 'inmate', 'transfer', 'parole', 'voorwaardelijke invrijheidstelling', 'gratie', 'pardon', 'strafonderbreking', 'reclassering'],
    unitHints: ['justitiële inrichting', 'penitentiair', 'detentie', 'gevangeniswezen', 'reclassering', 'prisons', 'detention'],
  },
  {
    code: 'POLICE',
    nl: 'Politie en openbare orde',
    en: 'Police and public order',
    words: ['politie', 'korps', 'agent', 'aangifte', 'proces-verbaal', 'opsporing', 'arrestatie', 'surveillance', 'openbare orde', 'verkeer', 'wapenvergunning', 'vuurwapen', 'police', 'officer', 'arrest', 'investigation', 'public order', 'firearm', 'licence', 'commissariaat'],
    unitHints: ['politie', 'police', 'openbare orde', 'veiligheid', 'korps'],
  },
  {
    code: 'IMMIGRATION',
    nl: 'Vreemdelingenzaken en naturalisatie',
    en: 'Immigration and naturalisation',
    words: ['vreemdeling', 'vreemdelingen', 'verblijfsvergunning', 'visum', 'naturalisatie', 'nationaliteit', 'paspoort', 'uitzetting', 'migratie', 'grensbewaking', 'residence permit', 'visa', 'naturalisation', 'citizenship', 'deportation', 'immigration', 'passport', 'kmar'],
    unitHints: ['vreemdelingen', 'immigratie', 'migratie', 'naturalisatie', 'immigration', 'burgerzaken'],
  },
  {
    code: 'LEGISLATION',
    nl: 'Wetgeving en juridische zaken',
    en: 'Legislation and legal affairs',
    words: ['wet', 'wetsontwerp', 'wetswijziging', 'staatsbesluit', 'regelgeving', 'juridisch', 'advies', 'grondwet', 'verdrag', 'rechtbank', 'vonnis', 'hoger beroep', 'bezwaar', 'beroep', 'advocaat', 'dagvaarding', 'law', 'bill', 'legislation', 'decree', 'legal', 'court', 'judgment', 'appeal', 'objection', 'lawyer', 'treaty'],
    unitHints: ['wetgeving', 'juridisch', 'juridische', 'legal', 'legislation', 'rechtszaken'],
  },
  {
    code: 'FINANCE',
    nl: 'Financiën en begroting',
    en: 'Finance and budget',
    words: ['begroting', 'factuur', 'betaling', 'krediet', 'budget', 'financieel', 'subsidie', 'aanbesteding', 'offerte', 'inkoop', 'declaratie', 'invoice', 'payment', 'finance', 'grant', 'procurement', 'tender', 'quotation', 'srd', 'usd'],
    unitHints: ['financi', 'begroting', 'finance', 'budget', 'middelen'],
  },
  {
    code: 'PERSONNEL',
    nl: 'Personeelszaken',
    en: 'Human resources',
    words: ['sollicitatie', 'benoeming', 'aanstelling', 'ontslag', 'salaris', 'personeel', 'pensioen', 'verlof', 'ziekmelding', 'functie', 'vacature', 'opleiding', 'training', 'application', 'appointment', 'dismissal', 'salary', 'personnel', 'pension', 'vacancy', 'staff'],
    unitHints: ['personeel', 'p&o', 'hrm', 'human resources', 'personnel', 'hr'],
  },
  {
    code: 'ICT',
    nl: 'ICT en informatievoorziening',
    en: 'ICT and information',
    words: ['ict', 'computer', 'systeem', 'netwerk', 'software', 'licentie', 'storing', 'wachtwoord', 'account', 'server', 'internet', 'e-mail', 'database', 'system', 'network', 'outage', 'password', 'hardware', 'printer'],
    unitHints: ['ict', 'informatie', 'automatisering', 'information', 'beheer'],
  },
  {
    code: 'CABINET',
    nl: 'Kabinet en bestuurszaken',
    en: 'Cabinet and governance',
    words: ['minister', 'kabinet', 'audiëntie', 'uitnodiging', 'bezoek', 'ceremonie', 'parlement', 'de nationale assemblee', 'dna', 'kamervragen', 'persbericht', 'media', 'protocol', 'invitation', 'audience', 'visit', 'parliament', 'national assembly', 'press', 'speech', 'toespraak', 'raad van ministers'],
    unitHints: ['kabinet', 'cabinet', 'bestuurszaken', 'minister', 'secretariaat'],
  },
];

export function topicsIn(text: string): { topic: Topic; hits: string[] }[] {
  const lower = ` ${text.toLowerCase()} `;
  const out: { topic: Topic; hits: string[] }[] = [];
  for (const topic of TOPICS) {
    const hits = topic.words.filter((w) => new RegExp(`[^a-zà-ÿ]${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^a-zà-ÿ]`, 'i').test(lower));
    if (hits.length) out.push({ topic, hits });
  }
  return out.sort((a, b) => b.hits.length - a.hits.length);
}
