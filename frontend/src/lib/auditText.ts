/**
 * The audit log is stored once, in English, and never changed (each line is
 * part of the hash chain). The screen reads it back in Dutch: these patterns
 * rewrite the stored sentence; anything not recognised is shown as stored.
 */

import { ROLE as ROLES } from './labels';

const ROLE = (r: string) => r.split(/,\s*|\s+and\s+/).map((x) => (ROLES[x.trim()]?.[0] ?? x).toLowerCase().replace(/^minister$/, 'Minister').replace(/^directeur$/, 'Directeur').replace(/^onder-directeur$/, 'Onder-Directeur')).join(', ');
const ACTION: Record<string, string> = {
  ASSIGN_RESPONSIBILITY: 'verantwoordelijke aanwijzen',
  SET_DUE_DATE: 'termijn vaststellen',
  REVIEW: 'beoordelen',
  APPROVE: 'goedkeuren',
  APPROVE_ON_BEHALF: 'beslissen namens',
  CLOSE: 'afsluiten',
};
const actions = (a: string) => a.split(/,\s*|\s+and\s+/).map((x) => ACTION[x.trim()] ?? x.toLowerCase()).join(' en ');
const STATUS: Record<string, string> = {
  OPEN: 'open',
  ACCEPTED: 'aangenomen',
  IN_PROGRESS: 'bezig',
  WAITING: 'wachtend',
  IN_REVIEW: 'ter controle',
  COMPLETED: 'afgerond',
  REJECTED: 'geweigerd',
  CANCELLED: 'geannuleerd',
};
const st = (s: string) => STATUS[s] ?? s.toLowerCase();
const date = (iso: string) => iso.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$3-$2-$1');
const plural = (n: string, one: string, many: string) => `${n} ${n === '1' ? one : many}`;

type Rule = [RegExp, (...m: string[]) => string];
const AI_REASON: Record<string, string> = {
  'no language model': 'geen taalmodel ingesteld',
  'rate-limit': 'limiet per uur bereikt',
  'free-limit': 'gratis limiet van het model bereikt',
  unavailable: 'model niet bereikbaar',
  timeout: 'model antwoordde niet op tijd',
  'no-key': 'geen sleutel ingesteld',
  'bad-key': 'sleutel geweigerd',
  'bad-model': 'model niet beschikbaar',
  'bad-request': 'model kon de vraag niet verwerken',
  'too-many-steps': 'te veel stappen',
  cancelled: 'gestopt door de gebruiker',
  'switched-off': 'assistent uitgezet',
  'change proposal': 'voorstel tot wijziging, binnen de server afgehandeld',
};
const REFUSED: Record<string, string> = {
  'incorrect password': 'verkeerd wachtwoord',
  'no such account': 'onbekend account',
  'account disabled': 'account uitgeschakeld',
};

const RULES: Rule[] = [
  [/^(.+?) signed in with two-step verification\.$/, (who) => `${who} heeft zich aangemeld, met tweestapsverificatie.`],
  [/^(.+?) signed in\.$/, (who) => `${who} heeft zich aangemeld.`],
  [/^A sign-in attempt for (\S+) was refused \((.+)\)\.$/, (who, why) => `Een aanmeldpoging voor ${who} is geweigerd (${REFUSED[why] ?? why}).`],
  [/^(.+?) signed out\.$/, (who) => `${who} heeft zich afgemeld.`],
  [/^(.+?) created a draft (incoming|outgoing|internal) item: (.+)$/, (who, dir, s) => `${who} maakte een concept ${{ incoming: 'inkomend', outgoing: 'uitgaand', internal: 'intern' }[dir]} stuk aan: ${s}`],
  [/^(.+?) captured the document (.+?) against a draft item\.$/, (who, f) => `${who} legde het document ${f} vast bij een concept.`],
  [/^(.+?) captured the document (.+?) against (.+)\.$/, (who, f, x) => `${who} legde het document ${f} vast bij ${x}.`],
  [/^(.+?) registered (incoming|outgoing|internal) item (\S+): (.+)$/, (who, dir, id, s) => `${who} registreerde ${{ incoming: 'inkomend', outgoing: 'uitgaand', internal: 'intern' }[dir]} stuk ${id}: ${s}`],
  [/^(.+?) created task (\S+) \((.+)\) for (.+)\.$/, (who, id, title, to) => `${who} maakte taak ${id} (${title}) aan voor ${to}.`],
  [/^(.+?) linked record (\S+) to dossier (\S+)\.$/, (who, r, d) => `${who} voegde stuk ${r} toe aan zaak ${d}.`],
  [/^(.+?) created dossier (\S+): (.+)$/, (who, d, s) => `${who} opende zaak ${d}: ${s}`],
  [/^(.+?) set the official due date of (\S+) to (\d{4}-\d{2}-\d{2})\.$/, (who, d, due) => `${who} stelde de termijn van ${d} vast op ${date(due)}.`],
  [/^(.+?) assigned responsibility for (\S+) to (.+)\.$/, (who, d, to) => `${who} maakte ${to} verantwoordelijk voor ${d}.`],
  [/^(.+?) approved the step "(.+)" of (\S+) and passed it to (.+)\.$/, (who, step, d, to) => `${who} keurde de stap "${step}" van ${d} goed en legde de zaak voor aan ${to}.`],
  [/^(.+?) submitted (\S+) for review to (.+)\.$/, (who, d, to) => `${who} bood ${d} ter beoordeling aan ${to} aan.`],
  [/^(.+?) submitted (\S+) for review by (.+)\.$/, (who, d, to) => `${who} bood ${d} ter beoordeling aan ${to} aan.`],
  [/^(.+?) retrieved the captured document (.+)\.$/, (who, f) => `${who} opende het document ${f}.`],
  [/^(.+?) finalised (\S+), on the approval recorded by (.+)\.$/, (who, d, by) => `${who} rondde ${d} definitief af, op de goedkeuring van ${by}.`],
  [/^(.+?) approved (\S+) as reviewed at version (\d+)\.$/, (who, d, v) => `${who} keurde ${d} goed (beoordeeld in versie ${v}).`],
  [/^(.+) is (\d+) working day\(s\) overdue and was escalated \(level (\d)\) to (.+)\.$/, (what, n, l, to) => `${what} is ${plural(n, 'werkdag', 'werkdagen')} over tijd en is geëscaleerd (niveau ${l}) naar ${to}.`],
  [/^(.+) is (\d+) working days? overdue and was escalated \(level (\d)\) to (.+)\.$/, (what, n, l, to) => `${what} is ${plural(n, 'werkdag', 'werkdagen')} over tijd en is geëscaleerd (niveau ${l}) naar ${to}.`],
  [/^(.+?) updated the unit (.+?): head changed\.$/, (who, u) => `${who} wijzigde het hoofd van ${u}.`],
  [/^(.+?) updated the unit (.+?)\.$/, (who, u) => `${who} wijzigde de afdeling ${u}.`],
  [/^(.+?) created the file-plan category (.+)\.$/, (who, c) => `${who} maakte de archiefcategorie ${c} aan.`],
  [/^(.+?) updated the file-plan category (.+)\.$/, (who, c) => `${who} wijzigde de archiefcategorie ${c}.`],
  [/^(.+?) created the account (\S+) for (.+) with roles (.+)\.$/, (who, acc, p, roles) => `${who} maakte het account ${acc} aan voor ${p}, met de rol ${ROLE(roles)}.`],
  [/^(.+?) created the unit (.+)\.$/, (who, u) => `${who} maakte de afdeling ${u} aan.`],
  [/^(.+?) moved task (\S+) from (\w+) to (\w+)(?: \((.+)\))?\.$/, (who, id, a, b, why) => `${who} zette taak ${id} van ${st(a)} op ${st(b)}${why ? ` (${why})` : ''}.`],
  [/^(.+?) saved version (\d+) of the text of the draft "(.+)"\.$/, (who, v, s) => `${who} bewaarde versie ${v} van de tekst van het concept "${s}".`],
  [/^(.+?) approved step (\d+) of (\d+) \((.+)\) of (\S+)\.$/, (who, i, n, step, d) => `${who} keurde stap ${i} van ${n} (${step}) van ${d} goed.`],
  [/^(.+?) commented on task (\S+)\.$/, (who, id) => `${who} reageerde op taak ${id}.`],
  [/^(.+?) asked (.+?) for advice on (\S+)\.$/, (who, to, d) => `${who} vroeg ${to} om advies over ${d}.`],
  [/^(.+?) gave advice on (\S+)\.$/, (who, d) => `${who} gaf advies over ${d}.`],
  [/^(.+?) created the task template "(.+)"\.$/, (who, n) => `${who} maakte het taaksjabloon "${n}" aan.`],
  [/^(.+?) printed the label for (\S+)\.$/, (who, id) => `${who} drukte het etiket af voor ${id}.`],
  [/^(.+?) printed the receipt for (\S+)\.$/, (who, id) => `${who} drukte het ontvangstbewijs af voor ${id}.`],
  [/^(.+?) asked the assistant a question; answered by (.+?) using (.+)\.$/, (who, model, tools) =>
    `${who} stelde de assistent een vraag; beantwoord door ${model} ${tools === 'no tools' ? 'zonder hulpmiddelen' : `met ${tools}`}.`],
  [/^(.+?) asked the assistant a question; answered offline by the built-in assistant \((.+)\)\.$/, (who, why) =>
    `${who} stelde de assistent een vraag; offline beantwoord door de ingebouwde assistent (${AI_REASON[why] ?? why}).`],
  [/^(.+?) asked the assistant a question; not answered \((.+)\)\.$/, (who, why) => `${who} stelde de assistent een vraag; niet beantwoord (${AI_REASON[why] ?? why}).`],
  [/^(.+?) accepted an assistant suggestion \((.+)\)\.$/, (who) => `${who} nam een voorstel van de assistent over.`],
  [/^(.+?) rejected an assistant suggestion \((.+)\)\.$/, (who) => `${who} wees een voorstel van de assistent af.`],
  [/^(.+?) edited an assistant suggestion \((.+)\)\.$/, (who) => `${who} nam een voorstel van de assistent aangepast over.`],
  [/^(.+?) exported the report "(.+)" as (\w+)\.$/, (who, r, f) => `${who} maakte het rapport "${r}" als ${f}.`],
  [/^A WijSamen report \((.+)\) was received as a draft incoming item\.$/, (ref) => `Een melding uit WijSamen (${ref}) is als concept binnengekomen.`],
  [/^(.+?) created the approval route (.+)\.$/, (who, r) => `${who} maakte de goedkeuringsroute ${r} aan.`],
  [/^(.+?) saved the exchange partner (.+)\.$/, (who, p) => `${who} legde de uitwisselingspartner ${p} vast.`],
  [/^Integrity check: (\d+) audit events \(chain (intact|broken)\), (\d+) earlier anchor\(s\) present, (\d+) stored file\(s\) \((\d+) failed\), (\d+) seal\(s\) \((\d+) failed\)\.$/,
    (n, chain, anchors, files, ff, seals, sf) =>
      `Integriteitscontrole: ${n} logboekregels (keten ${chain === 'intact' ? 'ongebroken' : 'verbroken'}), ${anchors} eerdere ankerpunten, ${plural(files, 'bestand', 'bestanden')} (${ff} afwijkend), ${plural(seals, 'zegel', 'zegels')} (${sf} ongeldig).`],
  [/^(.+?) created an integration key for (.+)\.$/, (who, k) => `${who} maakte een koppelingssleutel aan voor ${k}.`],
  [/^(.+?) exported the timeline of (\S+) as PDF \((\d+) entries\)\.$/, (who, d, n) => `${who} maakte de tijdlijn van ${d} als PDF (${n} gebeurtenissen).`],
  [/^(.+?) will be away from (\S+) to (\S+); (.+) stands in\.$/, (who, a, b, s) => `${who} is afwezig van ${date(a)} tot en met ${date(b)}; ${s} vervangt.`],
  [/^(.+?) sent (\d+) record\(s\) of (\S+) to (.+) as a signed exchange package\.$/, (who, n, d, to) => `${who} stuurde ${plural(n, 'stuk', 'stukken')} van ${d} als ondertekend pakket naar ${to}.`],
  [/^(.+?) exported the archive transfer package of (\S+) \((\d+) files\)\.$/, (who, d, n) => `${who} maakte het archiefpakket van ${d} (${plural(n, 'bestand', 'bestanden')}).`],
  [/^(.+?) composed the letter (.+?) from text version (\d+)\.$/, (who, f, v) => `${who} stelde de brief ${f} op uit tekstversie ${v}.`],
  [/^(.+?) delegated (.+) to (.+?) until (\d{4}-\d{2}-\d{2})\.$/, (who, what, to, until) => `${who} droeg bevoegdheden (${actions(what)}) over aan ${to} tot en met ${date(until)}.`],
  [/^(.+?) closed dossier (\S+) \(reason: (.+)\)\.$/, (who, d, why) => `${who} sloot zaak ${d} af (reden: ${why}).`],
  [/^(.+?) reopened dossier (\S+) \(reason: (.+)\)\.$/, (who, d, why) => `${who} heropende zaak ${d} (reden: ${why}).`],
  [/^(.+?) applied the system seal to (.+?) \((\S+)\)\.$/, (who, f, id) => `${who} plaatste het digitale zegel op ${f} (${id}).`],
  [/^(.+?) changed the (\w+) settings\.$/, (who, area) => `${who} wijzigde de instellingen (${area === 'ai' ? 'assistent' : area}).`],
  [/^(.+?) placed a legal hold on (\S+) \(reason: (.+)\)\.$/, (who, d, why) => `${who} legde juridische bewaarplicht op ${d} (reden: ${why}).`],
  [/^(.+?) released the legal hold on (\S+) \(reason: (.+)\)\.$/, (who, d, why) => `${who} hief de juridische bewaarplicht op ${d} op (reden: ${why}).`],
  [/^(.+?) took in a signed exchange package from (.+?) \((.+)\): (\d+) draft incoming item\(s\)\.$/, (who, from, ref, n) => `${who} las een ondertekend pakket in van ${from} (${ref}): ${plural(n, 'concept', 'concepten')}.`],
  [/^(.+?) loaded the Suriname public holidays \((\d+) added\)\.$/, (who, n) => `${who} laadde de Surinaamse feestdagen (${n} toegevoegd).`],
  [/^(.+?) returned (\S+) for correction \(reason: (.+)\)\.$/, (who, d, why) => `${who} stuurde ${d} terug ter correctie (reden: ${why}).`],
  [/^(.+?) recorded the retention decision (\w+) for (\S+) \(reason: (.+)\)\.$/, (who, dec, d, why) =>
    `${who} legde het bewaarbesluit "${{ DESTROY: 'vernietigen', TRANSFER: 'overbrengen', RETAIN: 'blijvend bewaren', EXTEND: 'verlengen' }[dec] ?? dec}" vast voor ${d} (reden: ${why}).`],
  [/^Sign-in for (\S+) was locked for (\d+) minutes after (\d+) failed attempts\.$/, (who, m, n) => `Aanmelden voor ${who} is ${m} minuten geblokkeerd na ${n} mislukte pogingen.`],
  [/^Sign-in failed for (.+?)(?: \((.+)\))?\.$/, (who, why) => `Aanmelden mislukt voor ${who}${why ? ` (${why})` : ''}.`],
];

export function auditSummaryNl(summary: string): string {
  for (const [pattern, render] of RULES) {
    const m = pattern.exec(summary);
    if (m) return render(...m.slice(1));
  }
  return summary;
}
