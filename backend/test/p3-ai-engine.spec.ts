import { parseQuestion, looksLikeDataQuestion } from '../src/ai/engine/ask';
import { documentDate, findDates, findDeadlines, looseDate } from '../src/ai/engine/dates';
import { extractIntake } from '../src/ai/engine/extract';
import { searchHelp } from '../src/ai/engine/help';
import { topicsIn } from '../src/ai/engine/lexicon';
import { proposeActions } from '../src/ai/engine/notes';
import { keySentences } from '../src/ai/engine/summarise';
import { detectLanguage, trigramSimilarity } from '../src/ai/engine/text';

/** The built-in engine's pieces, on their own, with the cases that matter in a ministry's post. */
describe('Phase 3 assistant engine', () => {
  const today = '2026-10-28'; // a Wednesday

  it('reads dates written the Dutch and the English way', () => {
    expect(findDates('Paramaribo, 12 oktober 2026', today)[0].date).toBe('2026-10-12');
    expect(findDates('d.d. 03-11-2026', today)[0].date).toBe('2026-11-03');
    expect(findDates('op 5 mrt.', today)[0].date).toBe('2026-03-05');
    expect(findDates('October 9, 2026', today)[0].date).toBe('2026-10-09');
    expect(findDates('2026-12-01', today)[0].date).toBe('2026-12-01');
    expect(findDates('31 februari 2026', today)).toHaveLength(0);
    expect(documentDate('Ministerie\nDatum: 14 september 2026\nOnderwerp: x', today)).toBe('2026-09-14');
  });

  it('recognises the deadlines letters ask for', () => {
    expect(findDeadlines('Wij verzoeken u binnen 14 dagen te reageren.', today)[0]).toMatchObject({ kind: 'RELATIVE_DAYS', dueDate: '2026-11-11' });
    expect(findDeadlines('binnen twee weken', today)[0].dueDate).toBe('2026-11-11');
    expect(findDeadlines('binnen 10 werkdagen', today)[0]).toMatchObject({ kind: 'RELATIVE_WORKING_DAYS', workingDays: 10 });
    expect(findDeadlines('uiterlijk 15 november 2026', today)[0]).toMatchObject({ kind: 'ABSOLUTE', dueDate: '2026-11-15' });
    expect(findDeadlines('graag vóór vrijdag', today)[0]).toMatchObject({ kind: 'WEEKDAY', dueDate: '2026-10-30' });
    expect(findDeadlines('please reply no later than 20 November 2026', today)[0].dueDate).toBe('2026-11-20');
    expect(findDeadlines('within 30 days', today)[0].dueDate).toBe('2026-11-27');
    expect(findDeadlines('Geen termijn genoemd.', today)).toHaveLength(0);
  });

  it('understands loose dates in notes and chat', () => {
    expect(looseDate('morgen', today)).toBe('2026-10-29');
    expect(looseDate('overmorgen', today)).toBe('2026-10-30');
    expect(looseDate('volgende week', today)).toBe('2026-11-06');
    expect(looseDate('volgende week', '2026-10-30')).toBe('2026-11-06');
    expect(looseDate('eind van de maand', today)).toBe('2026-10-31');
    expect(looseDate('next Monday', today)).toBe('2026-11-02');
    expect(looseDate('zonder datum', today)).toBeNull();
  });

  it('proposes registration fields from a letter or an e-mail', () => {
    const mail = extractIntake('Van: Openbaar Ministerie <om@juspol.sr>\nOnderwerp: RE: Aanvraag gratie G. Doe\n\nGeachte,\nIk verzoek u om gratie te verlenen.', today);
    expect(mail.party?.value).toBe('Openbaar Ministerie');
    expect(mail.subject?.value).toBe('Aanvraag gratie G. Doe');
    expect(mail.requests[0]).toContain('gratie');
    expect(mail.classification).toBeNull();
    const secret = extractIntake('ZEER GEHEIM\nBetreft: operatie', today);
    expect(secret.classification?.value).toBe('SECRET');
    expect(extractIntake('De geheimhoudingsplicht geldt.', today).classification).toBeNull();
    const signed = extractIntake('Geachte heer,\nWij vragen u een gesprek.\nMet vriendelijke groet,\nStichting Rechtshulp Suriname', today);
    expect(signed.party?.value).toBe('Stichting Rechtshulp Suriname');
  });

  it('tells Dutch from English', () => {
    expect(detectLanguage('Wij verzoeken u vriendelijk om een reactie op deze brief.')).toBe('nl');
    expect(detectLanguage('We kindly request a response to this letter from your office.')).toBe('en');
  });

  it('finds the subject area of a letter', () => {
    expect(topicsIn('Verzoek om een verblijfsvergunning voor mijn echtgenote')[0].topic.code).toBe('IMMIGRATION');
    expect(topicsIn('Factuur voor de levering van printers, betaling binnen 30 dagen')[0].topic.code).toBe('FINANCE');
    expect(topicsIn('Overplaatsing van een gedetineerde naar Santo Boma')[0].topic.code).toBe('DETENTION');
  });

  it('summarises with sentences that are really in the text, without repeats', () => {
    const text =
      'De heer Pinas verzoekt om overplaatsing naar Santo Boma. Hij verblijft sinds 2024 in de inrichting. Zijn familie woont in Paramaribo. ' +
      'De heer Pinas verzoekt om overplaatsing naar Santo Boma, zo schrijft hij. Het besluit is aan de Minister. De directie adviseert positief.';
    const k = keySentences([{ text, source: 'IN-1' }], 3);
    expect(k.length).toBe(3);
    for (const s of k) expect(text).toContain(s.text);
    expect(k.filter((s) => s.text.startsWith('De heer Pinas verzoekt')).length).toBe(1);
  });

  it('turns notes into actions with people, dates and priorities', () => {
    const people = [
      { accountId: 'a', name: 'M. Sardjoe' },
      { accountId: 'b', name: 'L. Amatredjo' },
    ];
    const me = { accountId: 'm', name: 'R. Dijkstra' };
    const p = proposeActions('Aanwezig: allen\n- Sardjoe: brief aan OM opstellen vóór 5 november\n- Ik bel de advocaat morgen\nTODO: Amatredjo archiveert de stukken, urgent\nDe vergadering werd om 11 uur gesloten.', people, me, today);
    expect(p).toHaveLength(3);
    expect(p[0]).toMatchObject({ title: 'Brief aan OM opstellen', dueDate: '2026-11-05', assignee: { accountId: 'a' } });
    expect(p[1]).toMatchObject({ assignee: { accountId: 'm' }, dueDate: '2026-10-29' });
    expect(p[2]).toMatchObject({ assignee: { accountId: 'b' }, priority: 'URGENT' });
  });

  it('understands plain-language questions', () => {
    const q = parseQuestion('Hoeveel zaken zijn over termijn?', today, 'nl');
    expect(q).toMatchObject({ entity: 'DOSSIER', count: true, overdue: true });
    const l = parseQuestion('Welke uitgaande brieven over gratie zijn er in september verstuurd?', today, 'nl');
    expect(l).toMatchObject({ entity: 'ITEM', direction: 'OUTGOING', about: 'gratie', from: '2026-09-01', to: '2026-09-30' });
    const t = parseQuestion('Show my urgent tasks due this week', today, 'en');
    expect(t).toMatchObject({ entity: 'TASK', mine: true, priority: 'URGENT' });
    const r = parseQuestion('Welke zaken wachten op goedkeuring?', today, 'nl');
    expect(r.status).toBe('REVIEW');
    expect(looksLikeDataQuestion('Hoeveel brieven kwamen er binnen?')).toBe(true);
    expect(looksLikeDataQuestion('Goedemorgen')).toBe(false);
  });

  it('answers how-to questions from the help articles', () => {
    expect(searchHelp('Hoe registreer ik een brief?')[0].article.id).toBe('register-post');
    expect(searchHelp('Wat is een digitaal zegel?')[0].article.id).toBe('seal');
    expect(searchHelp('How do I approve a matter?')[0].article.id).toBe('approval');
    expect(searchHelp('Waar stel ik mijn vervanger in als ik op vakantie ben?')[0].article.id).toBe('out-of-office');
  });

  it('matches subjects typed slightly differently', () => {
    expect(trigramSimilarity('Verzoek overplaatsing gedetineerde Pinas', 'Verzoek om overplaatsing gedetineerde J. Pinas')).toBeGreaterThan(0.5);
    expect(trigramSimilarity('Begroting 2027', 'Verzoek om gratie')).toBeLessThan(0.15);
  });
});
