import { describe, expect, it } from 'vitest';
import { dutchMessage } from './apiMessages';

/** Server messages reach a Dutch screen in Dutch, never as English or as a status code. */
describe('Server messages in Dutch', () => {
  it('translates known messages, with names and numbers kept', () => {
    expect(dutchMessage(403, 'You are not permitted to perform this action.')).toBe('U heeft geen toestemming voor deze handeling.');
    expect(dutchMessage(400, 'This task cannot be completed yet: 2 subtask(s) are still open.')).toBe('Deze taak kan nog niet worden afgerond: er staan nog 2 deeltaken open.');
    expect(dutchMessage(400, 'The step "Paraaf Onder-Directeur" is decided by someone holding that role.')).toBe('Over de stap "Paraaf Onder-Directeur" beslist iemand met die rol.');
    expect(dutchMessage(404, 'Unknown dossier.')).toBe('Dit bestaat niet (meer), of u heeft er geen toegang toe.');
  });

  it('falls back on the kind of error, and leaves Dutch text alone', () => {
    expect(dutchMessage(400, 'subject must be shorter than or equal to 500 characters')).toBe('De invoer is niet geldig. Controleer de velden en probeer het opnieuw.');
    expect(dutchMessage(502, 'Bad Gateway')).toMatch(/^Er ging iets mis op de server/);
    expect(dutchMessage(400, 'Met verlof. Voor personeelszaken kunt u terecht bij S. Hiwat.')).toBe('Met verlof. Voor personeelszaken kunt u terecht bij S. Hiwat.');
  });
});
