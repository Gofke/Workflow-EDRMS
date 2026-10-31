/**
 * Every failure the assistant can meet, as one short reason code. The HTTP
 * status and the message a person sees follow from the code alone, so the
 * panel, the audit log and the tests all speak the same language.
 */
export type AgentReason =
  | 'invalid'
  | 'too-long'
  | 'signed-out'
  | 'denied'
  | 'origin'
  | 'too-large'
  | 'rate-limit'
  | 'free-limit'
  | 'cancelled'
  | 'unavailable'
  | 'bad-request'
  | 'too-many-steps'
  | 'no-key'
  | 'bad-key'
  | 'bad-model'
  | 'timeout'
  | 'switched-off';

export const STATUS: Record<AgentReason, number> = {
  invalid: 400,
  'too-long': 400,
  'signed-out': 401,
  denied: 403,
  origin: 403,
  'switched-off': 403,
  'too-large': 413,
  'rate-limit': 429,
  'free-limit': 429,
  cancelled: 499,
  unavailable: 502,
  'bad-request': 502,
  'too-many-steps': 502,
  'no-key': 503,
  'bad-key': 503,
  'bad-model': 503,
  timeout: 504,
};

export const MESSAGE: Record<AgentReason, { nl: string; en: string }> = {
  invalid: { nl: 'Typ een vraag.', en: 'Type a question.' },
  'too-long': { nl: 'De vraag is te lang. Houd het onder de 2.000 tekens.', en: 'The question is too long. Keep it under 2,000 characters.' },
  'signed-out': { nl: 'U bent afgemeld. Meld u opnieuw aan.', en: 'You are signed out. Sign in again.' },
  denied: { nl: 'U hebt geen toegang tot de assistent.', en: 'You do not have access to the assistant.' },
  origin: { nl: 'Dit verzoek komt niet van het EDRMS.', en: 'This request does not come from the EDRMS.' },
  'switched-off': { nl: 'De assistent is door de beheerder uitgezet.', en: 'The assistant is switched off by the administrator.' },
  'too-large': { nl: 'Het gesprek is te lang. Begin een nieuw gesprek.', en: 'The conversation is too long. Start a new chat.' },
  'rate-limit': { nl: 'U hebt het maximum aantal vragen per uur bereikt. Probeer het later opnieuw.', en: 'You have reached the number of questions per hour. Try again later.' },
  'free-limit': { nl: 'De gratis limiet van het taalmodel is bereikt. Probeer het over een minuut opnieuw.', en: 'The free limit of the language model is reached. Try again in a minute.' },
  cancelled: { nl: 'De vraag is gestopt.', en: 'The question was stopped.' },
  unavailable: { nl: 'Het taalmodel is nu niet bereikbaar.', en: 'The language model cannot be reached right now.' },
  'bad-request': { nl: 'Het taalmodel kon deze vraag niet verwerken.', en: 'The language model could not process this question.' },
  'too-many-steps': { nl: 'Deze vraag vroeg te veel stappen. Stel een kortere of preciezere vraag.', en: 'This question took too many steps. Ask a shorter or more precise question.' },
  'no-key': { nl: 'Er is geen sleutel voor het taalmodel ingesteld.', en: 'No key for the language model is set.' },
  'bad-key': { nl: 'De sleutel voor het taalmodel wordt geweigerd.', en: 'The key for the language model is refused.' },
  'bad-model': { nl: 'Het ingestelde taalmodel bestaat niet of is niet beschikbaar.', en: 'The configured language model does not exist or is not available.' },
  timeout: { nl: 'Het taalmodel antwoordde niet op tijd.', en: 'The language model did not answer in time.' },
};

export class AgentError extends Error {
  constructor(
    readonly reason: AgentReason,
    readonly detail = '',
  ) {
    super(detail || reason);
  }
}

/** Reasons where another (free) model or the built-in assistant may take over. */
export const RECOVERABLE: AgentReason[] = ['rate-limit', 'free-limit', 'unavailable', 'timeout', 'bad-model', 'bad-request', 'too-many-steps', 'no-key', 'bad-key'];

/** Reasons where the next model in the fallback list is worth trying. */
export const TRY_NEXT_MODEL: AgentReason[] = ['free-limit', 'rate-limit', 'unavailable', 'bad-model'];
