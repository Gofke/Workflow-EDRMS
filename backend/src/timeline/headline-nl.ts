/**
 * The timeline's headlines are stored in one language (English, as written
 * since Delivery 1). Documents a person reads in Dutch — the timeline PDF —
 * get them in Dutch. The same rules are used in the interface.
 */
const RULES: [RegExp, string][] = [
  [/^Dossier opened$/, 'Zaak geopend'],
  [/^Responsibility assigned to (.+)$/, 'Verantwoordelijkheid toegewezen aan $1'],
  [/^Official due date set to (.+)$/, 'Termijn vastgesteld op $1'],
  [/^Official due date changed to (.+)$/, 'Termijn gewijzigd naar $1'],
  [/^Official due date removed$/, 'Termijn verwijderd'],
  [/^Record (.+) filed in this matter$/, 'Stuk $1 aan de zaak toegevoegd'],
  [/^Record (.+) registered$/, 'Stuk $1 geregistreerd'],
  [/^Document captured: (.+)$/, 'Document vastgelegd: $1'],
  [/^Submitted for review to (.+)$/, 'Ter beoordeling aangeboden aan $1'],
  [/^Returned for correction$/, 'Teruggestuurd ter correctie'],
  [/^Approved$/, 'Goedgekeurd'],
  [/^Finalised$/, 'Afgerond'],
  [/^Reopened$/, 'Heropend'],
  [/^Dossier closed$/, 'Dossier gesloten'],
  [/^Dossier reopened$/, 'Dossier heropend'],
  [/^Task (\S+) created for (.+)$/, 'Taak $1 aangemaakt voor $2'],
  [/^Task (\S+) completed$/, 'Taak $1 afgerond'],
  [/^Task (\S+) cancelled$/, 'Taak $1 geannuleerd'],
  [/^Task (\S+) reassigned to (.*)$/, 'Taak $1 overgedragen aan $2'],
  [/^Task (\S+) declined$/, 'Taak $1 geweigerd'],
  [/^Advice requested from (.+)$/, 'Advies gevraagd aan $1'],
  [/^Advice given by (.+)$/, 'Advies gegeven door $1'],
  [/^Step approved: (.+)$/, 'Stap goedgekeurd: $1'],
  [/^Classification changed from (.+) to (.+)$/, 'Vertrouwelijkheid gewijzigd van $1 naar $2'],
  [/^Legal hold placed$/, 'Juridische bewaarplicht ingesteld'],
  [/^Legal hold released$/, 'Juridische bewaarplicht opgeheven'],
];

export function dutchHeadline(text: string): string {
  for (const [re, nl] of RULES) {
    if (re.test(text)) return text.replace(re, nl).replace(/(\d{4})-(\d{2})-(\d{2})/, '$3-$2-$1');
  }
  return text;
}
