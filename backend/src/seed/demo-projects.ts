/**
 * Demonstration projects (V0.5.0): 78 more staff (100 accounts in all), a unit
 * of outside contractors, and twelve projects of the ministry at every stage —
 * a business case being written, one waiting for the owner, one returned, the
 * work under way, one behind schedule, one on hold, one confidential, and one
 * run through its whole life and signed off.
 *
 * Everything is done through the API by the people concerned, on the day it
 * happened (see the Clock in demo.ts). All people and projects are invented.
 */
import request from 'supertest';
import { DataSource } from 'typeorm';

type Agent = ReturnType<typeof request.agent>;

export interface StoryContext {
  db: DataSource;
  as(email: string): Promise<Agent>;
  id(email: string): string;
  unit(code: string): string;
  /** "today + n" as the batch sees it. */
  due(n: number): string;
  later(table: string, column: string, id: string): void;
  on(day: number, fn: () => Promise<void>): void;
  ok(req: request.Test, status: number): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const e = (name: string) => `${name}@juspol.test`;

// ---------------------------------------------------------------- the people

export const CONTRACTOR_UNIT = { code: 'EXT', name: 'Externe leveranciers', kind: 'SERVICE', parent: 'SUB-BV' };

/** [email name, full name, job, unit, role]. Invented people; Surinamese names from every community. */
const STAFF: [string, string, string, string, string?][] = [
  ['jagernath', 'R. Jagernath', 'Senior jurist wetgeving', 'JZ'],
  ['soemodihardjo', 'S. Soemodihardjo', 'Jurist', 'JZ'],
  ['pinas', 'D. Pinas', 'Wetgevingsjurist', 'JZ'],
  ['mahabier', 'A. Mahabier', 'Juridisch medewerker', 'JZ'],
  ['karsoredjo', 'L. Karsoredjo', 'Beleidsmedewerker Juridische Zaken', 'JZ'],
  ['fungaloi', 'N. Fung-A-Loi', 'Jurist internationale rechtshulp', 'JZ'],
  ['esajas', 'J. Esajas', 'Juridisch secretaris', 'JZ'],
  ['ramsaran', 'K. Ramsaran', 'Senior behandelaar naturalisatie', 'VZ'],
  ['abauna', 'M. Abauna', 'Behandelaar verblijfsvergunningen', 'VZ'],
  ['tjonafat', 'P. Tjon-A-Fat', 'Behandelaar verblijfsvergunningen', 'VZ'],
  ['wongsoredjo', 'R. Wongsoredjo', 'Medewerker loket Vreemdelingenzaken', 'VZ'],
  ['bissumbhar', 'C. Bissumbhar', 'Coördinator vreemdelingenregister', 'VZ'],
  ['hooghart', 'E. Hooghart', 'Medewerker documentcontrole', 'VZ'],
  ['sewnath', 'G. Sewnath', 'Administratief medewerker Vreemdelingenzaken', 'VZ'],
  ['pawirodikromo', 'H. Pawirodikromo', 'Coördinator gevangeniswezen', 'JI'],
  ['aboikoni', 'T. Aboikoni', 'Hoofd beveiliging Santo Boma', 'JI'],
  ['ramautar', 'F. Ramautar', 'Medewerker reclassering', 'JI'],
  ['dundas', 'W. Dundas', 'Facilitair coördinator inrichtingen', 'JI'],
  ['kartoredjo', 'I. Kartoredjo', 'Maatschappelijk werker', 'JI'],
  ['lieaaling', 'B. Lie-A-Ling', 'Medewerker detentiezaken', 'JI'],
  ['gangarampanday', 'V. Gangaram Panday', 'Medisch coördinator inrichtingen', 'JI'],
  ['amania', 'O. Amania', 'Medewerker jeugdinrichting', 'JI'],
  ['vriesde', 'S. Vriesde', 'Bouwkundig adviseur inrichtingen', 'JI'],
  ['ramdien', 'D. Ramdien', 'Senior P&O-adviseur', 'PZ'],
  ['setrowidjojo', 'N. Setrowidjojo', 'Salarisadministrateur', 'PZ'],
  ['kanhai', 'A. Kanhai', 'P&O-medewerker', 'PZ'],
  ['nahar', 'E. Nahar', 'Opleidingscoördinator', 'PZ'],
  ['atmodikoro', 'R. Atmodikoro', 'Beheerder personeelsdossiers', 'PZ'],
  ['debipersad', 'M. Debipersad', 'Senior financieel adviseur', 'FZ'],
  ['kalloe', 'J. Kalloe', 'Begrotingsmedewerker', 'FZ'],
  ['soekhoe', 'Y. Soekhoe', 'Controller', 'FZ'],
  ['eersel', 'K. Eersel', 'Medewerker crediteuren', 'FZ'],
  ['chinalin', 'P. Chin-A-Lin', 'Inkoopadviseur', 'FZ'],
  ['mungra', 'S. Mungra', 'Financieel administrateur', 'FZ'],
  ['kenswil', 'R. Kenswil', 'Senior beleidsmedewerker politie', 'PO'],
  ['lieuwon', 'C. Lieuw-On', 'Coördinator wijkzorg', 'PO'],
  ['sastrodimedjo', 'A. Sastrodimedjo', 'Projectcoördinator camerabewaking', 'PO'],
  ['fernandes', 'B. Fernandes', 'Beleidsmedewerker openbare orde', 'PO'],
  ['asoiti', 'L. Asoiti', 'Opleidingscoördinator politie', 'PO'],
  ['adjako', 'D. Adjako', 'Coördinator verbindingen', 'PO'],
  ['jhinkoe', 'G. Jhinkoe', 'Medewerker vergunningen', 'PO'],
  ['brandon', 'M. Brandon', 'Analist criminaliteitscijfers', 'PO'],
  ['wolf', 'T. Wolf', 'Beleidsmedewerker verkeersveiligheid', 'PO'],
  ['gopie', 'K. Gopie', 'Medewerker korpsbeheer', 'PO'],
  ['abena', 'F. Abena', 'Medewerker slachtofferzorg', 'PO'],
  ['leeflang', 'E. Leeflang', 'Beleidsmedewerker districtspolitie', 'PO'],
  ['marhe', 'J. Marhé', 'ICT-projectleider', 'HO-ICT'],
  ['tjinkonfat', 'S. Tjin-Kon-Fat', 'Netwerkbeheerder', 'HO-ICT'],
  ['goerdayal', 'R. Goerdayal', 'Applicatiebeheerder', 'HO-ICT'],
  ['wirjosentono', 'N. Wirjosentono', 'Informatiebeveiliger', 'HO-ICT'],
  ['cairo', 'V. Cairo', 'Databasebeheerder', 'HO-ICT'],
  ['bholasing', 'A. Bholasing', 'Servicedeskmedewerker', 'HO-ICT'],
  ['jairam', 'E. Jairam', 'Functioneel beheerder', 'HO-ICT'],
  ['sitaram', 'L. Sitaram', 'Technisch beheerder', 'HO-ICT'],
  ['oostburg', 'D. Oostburg', 'Beleidsadviseur van de Minister', 'HO-KAB'],
  ['pawiroredjo', 'M. Pawiroredjo', 'Communicatieadviseur', 'HO-KAB'],
  ['ramlakhan', 'S. Ramlakhan', 'Protocolmedewerker', 'HO-KAB'],
  ['monsanto', 'I. Monsanto', 'Juridisch adviseur Kabinet', 'HO-KAB'],
  ['soekdew', 'R. Soekdew', 'Stafmedewerker Directeur Justitie', 'HO-DIR'],
  ['starke', 'C. Starke', 'Planning en control Justitie', 'HO-DIR'],
  ['kromowidjojo', 'W. Kromowidjojo', 'Secretaresse Directeur Justitie', 'HO-DIR'],
  ['djasmadi', 'G. Djasmadi', 'Stafmedewerker Directeur Bedrijfsvoering', 'DIR-BP'],
  ['ritfeld', 'H. Ritfeld', 'Planning en control Bedrijfsvoering', 'DIR-BP'],
  ['tewari', 'N. Tewari', 'Stafmedewerker Juridische Zaken en Vreemdelingenzaken', 'SUB-JZ'],
  ['dinmohamed', 'P. Dinmohamed', 'Stafmedewerker Justitiële Inrichtingen', 'SUB-JI'],
  ['bajnath', 'L. Bajnath', 'Stafmedewerker Bedrijfsvoering', 'SUB-BV'],
  ['ganpat', 'A. Ganpat', 'Stafmedewerker Politie en Openbare Orde', 'SUB-PO'],
  ['mohan', 'J. Mohan', 'Medewerker registratie', 'REG'],
  ['poeketi', 'K. Poeketi', 'Archiefmedewerker', 'REG'],
  ['tjoeawie', 'A. Tjoe-Awie', 'Medewerker digitalisering archief', 'REG'],
  ['karijomenawi', 'P. Karijomenawi', 'Auditor', 'IA', 'AUDITOR'],
  ['vanenburg', 'R. Vanenburg', 'Auditor', 'IA', 'AUDITOR'],
  ['lam', 'B. Lam', 'Externe consultant registersystemen', 'EXT'],
  ['moenne', 'R. Moenne', 'Externe softwareontwikkelaar', 'EXT'],
  ['kasanmoesdiran', 'D. Kasanmoesdiran', 'Externe projectadviseur bouw', 'EXT'],
  ['venloo', 'T. Venloo', 'Externe installateur camerasystemen', 'EXT'],
  ['kariodimedjo', 'M. Kariodimedjo', 'Externe trainer', 'EXT'],
  ['zalman', 'S. Zalman', 'Externe netwerkspecialist', 'EXT'],
];

export const PROJECT_STAFF = STAFF.map(([email, fullName, job, unit, role]) => ({ email: e(email), fullName, job, unit, roles: [role ?? 'SUPPORT_STAFF'] }));

// ---------------------------------------------------------------- the projects

/** A ticket: what, for whom, start and due (days ago; negative is still to come), and what became of it. */
type TicketSpec = [title: string, who: string, start: number, due: number, outcome?: number | 'IP' | 'WAIT' | 'REV' | 'ACC', note?: string];
interface PhaseSpec {
  name: string;
  start: number;
  end: number;
  /** When the tickets were made (default: the start of the phase, or the planning day for phases to come). */
  planned?: number;
  tickets: TicketSpec[];
  closed?: number;
}
interface ProjectSpec {
  name: string;
  description: string;
  unit: string;
  owner: string;
  manager: string;
  stakeholders?: string[];
  classification?: 'CONFIDENTIAL';
  created: number;
  phases: PhaseSpec[];
  bc: { problem: string; solution: string; benefits: string; costs: string; risks: string; budget: number };
  /** Partial business case only (still being written). */
  bcPartial?: boolean;
  bcSaved?: number;
  bcSubmitted?: number;
  bcReturned?: [number, string];
  bcApproved?: number;
  signedOff?: number;
  hold?: [number, string];
}

const PROJECTS: ProjectSpec[] = [
  {
    name: 'Digitalisering strafregister',
    description: 'Het strafregister gaat van kaartenbak naar een beveiligd digitaal register, gekoppeld aan het Korps Politie, zodat een uittreksel binnen een dag klaar is.',
    unit: 'JZ',
    owner: 'directeur',
    manager: 'kartodikromo',
    stakeholders: ['minister', 'dualrole'],
    created: 205,
    phases: [
      {
        name: 'Business case',
        start: 205,
        end: 185,
        tickets: [
          ['Huidige werkwijze strafregister in kaart brengen', 'jagernath', 205, 196, 197],
          ['Kostenraming opvragen bij ICT', 'marhe', 204, 194, 195],
          ['Privacytoets persoonsgegevens', 'wirjosentono', 203, 190, 190],
          ['Business case schrijven', 'kartodikromo', 200, 188, 188],
        ],
      },
      {
        name: 'Documentatie en ontwerp',
        start: 184,
        end: 130,
        planned: 182,
        closed: 128,
        tickets: [
          ['Functioneel ontwerp register', 'jagernath', 182, 150, 151],
          ['Koppeling met het Korps Politie beschrijven', 'pinas', 180, 155, 154],
          ['Beveiligingseisen vastleggen', 'wirjosentono', 178, 150, 149],
          ['Aanbesteding leverancier registersysteem', 'chinalin', 175, 135, 136],
          ['Migratieplan oude kaartenbak', 'mohan', 170, 140, 141],
        ],
      },
      {
        name: 'Uitvoering',
        start: 129,
        end: -40,
        planned: 128,
        tickets: [
          ['Testomgeving inrichten', 'marhe', 128, 110, 108],
          ['Registermodule bouwen', 'lam', 125, -10, 'IP'],
          ['Kaarten 1990–2005 digitaliseren', 'mohan', 110, 20, 'IP'],
          ['Koppeling met het Korps Politie bouwen', 'lam', 90, 5, 'WAIT', 'Wacht op de toegangssleutel van het Korps Politie.'],
          ['Kaarten 2006–2025 digitaliseren', 'tjoeawie', 60, -30],
          ['Beveiligingstest door onafhankelijke partij', 'wirjosentono', 20, -25, 'ACC'],
          ['Gebruikerstraining griffie en loket', 'soemodihardjo', 30, -35],
        ],
      },
      {
        name: 'Afsluiting en overdracht',
        start: -41,
        end: -95,
        planned: 10,
        tickets: [
          ['Overdracht aan functioneel beheer', 'jairam', -42, -70],
          ['Evaluatie met belanghebbenden', 'kartodikromo', -70, -90],
          ['Projectdossier archiveren', 'mohan', -85, -95],
        ],
      },
    ],
    bc: {
      problem: 'Een uittreksel uit het strafregister duurt nu gemiddeld drie weken: de kaarten worden met de hand gezocht en overgetypt. Fouten en zoekgeraakte kaarten leiden tot klachten van burgers en werkgevers.',
      solution: 'Een digitaal register met de bestaande kaarten gescand en ingevoerd, een koppeling met het Korps Politie voor nieuwe vonnissen, en uittreksels die het loket direct kan afdrukken.',
      benefits: 'Uittreksel binnen één werkdag (nu 15). Minder fouten. Toezicht op wie welk dossier inziet. Twee medewerkers vrij voor andere taken.',
      costs: 'Eenmalig SRD 2,1 mln (software, scannen, koppeling, training). Jaarlijks SRD 240.000 (licentie en beheer).',
      risks: 'Slechte leesbaarheid van oude kaarten (maatregel: dubbele invoer); vertraging bij het Korps Politie (maatregel: koppeling later, eerst handmatige invoer).',
      budget: 2100000,
    },
    bcSaved: 189,
    bcSubmitted: 187,
    bcApproved: 182,
  },
  {
    name: 'Renovatie cellenblok C, Santo Boma',
    description: 'Renovatie van cellenblok C na het inspectierapport: sanitair, elektra, camerabewaking en een medische ruimte, met tijdelijke overplaatsing van de gedetineerden.',
    unit: 'JI',
    owner: 'onderdirecteur',
    manager: 'sabajo',
    stakeholders: ['directeur', 'ramdin'],
    created: 260,
    phases: [
      {
        name: 'Business case',
        start: 260,
        end: 245,
        tickets: [
          ['Inspectierapport cellenblok C analyseren', 'aboikoni', 260, 252, 253],
          ['Bouwkundige opname', 'vriesde', 259, 250, 250],
          ['Begroting renovatie', 'debipersad', 258, 248, 247],
          ['Business case opstellen', 'sabajo', 256, 246, 246],
        ],
      },
      {
        name: 'Ontwerp en vergunningen',
        start: 244,
        end: 200,
        planned: 242,
        closed: 198,
        tickets: [
          ['Bestek en tekeningen', 'vriesde', 242, 215, 214],
          ['Bouwvergunning aanvragen', 'dundas', 240, 210, 208],
          ['Aanbesteding aannemer', 'chinalin', 235, 205, 203],
          ['Tijdelijke overplaatsing gedetineerden plannen', 'aboikoni', 230, 202, 201],
        ],
      },
      {
        name: 'Uitvoering',
        start: 199,
        end: 60,
        planned: 198,
        closed: 58,
        tickets: [
          ['Sloop- en asbestwerk', 'kasanmoesdiran', 198, 170, 168],
          ['Nieuwe sanitaire voorzieningen', 'kasanmoesdiran', 170, 120, 115],
          ['Elektra en camerabewaking', 'dundas', 150, 95, 92],
          ['Medische ruimte inrichten', 'gangarampanday', 120, 80, 78],
          ['Bouwtoezicht en tussentijdse opleveringen', 'vriesde', 198, 62, 61],
        ],
      },
      {
        name: 'Afsluiting en overdracht',
        start: 59,
        end: 25,
        planned: 58,
        tickets: [
          ['Oplevering en restpunten', 'vriesde', 58, 45, 44],
          ['Terugplaatsing gedetineerden', 'aboikoni', 50, 35, 33],
          ['Eindafrekening', 'debipersad', 45, 30, 29],
          ['Evaluatie met de inrichting', 'sabajo', 40, 27, 26],
        ],
      },
    ],
    bc: {
      problem: 'Het inspectierapport noemt cellenblok C onveilig en mensonwaardig: lekkend sanitair, kapotte elektra en geen toezicht op de gangen. Er is geen medische ruimte in het blok.',
      solution: 'Volledige renovatie van blok C in één keer, met de gedetineerden tijdelijk in blok A en B. Nieuwe sanitaire voorzieningen, elektra, camerabewaking en een medische ruimte.',
      benefits: 'Voldoen aan de eisen van de inspectie en de mensenrechtenverdragen. Minder incidenten op de gangen. Medische zorg in het blok zelf.',
      costs: 'SRD 4,8 mln bouwkosten, SRD 350.000 inrichting, SRD 120.000 tijdelijke maatregelen.',
      risks: 'Overbezetting van blok A en B tijdens de bouw (maatregel: gefaseerd en met extra bewaking); prijsstijgingen bouwmateriaal (maatregel: 10% onvoorzien).',
      budget: 5270000,
    },
    bcSaved: 247,
    bcSubmitted: 246,
    bcApproved: 242,
    signedOff: 24,
  },
  {
    name: 'Invoering e-dossier Vreemdelingenzaken',
    description: 'Elke aanvraag voor verblijf en naturalisatie krijgt een digitaal dossier: scannen bij binnenkomst, behandelen op het scherm, en de aanvrager kan de stand volgen.',
    unit: 'VZ',
    owner: 'dualrole',
    manager: 'chin',
    stakeholders: ['directeur'],
    created: 75,
    phases: [
      {
        name: 'Business case',
        start: 75,
        end: 50,
        tickets: [
          ['Doorlooptijden van aanvragen meten', 'ramsaran', 75, 62, 61],
          ['Wensen van loketmedewerkers ophalen', 'abauna', 74, 60, 58],
          ['Marktverkenning leveranciers', 'goerdayal', 72, 55, 54],
          ['Business case opstellen', 'chin', 70, 50, 49],
        ],
      },
      {
        name: 'Documentatie en ontwerp',
        start: 49,
        end: -10,
        planned: 42,
        tickets: [
          ['Procesbeschrijving verblijfsaanvraag', 'ramsaran', 42, 15, 14],
          ['Documenttypen en bewaartermijnen', 'bissumbhar', 40, 10, 'IP'],
          ['Gegevensmodel vreemdelingenregister', 'moenne', 35, -5, 'IP'],
          ['Toegangsrechten per rol vastleggen', 'goerdayal', 30, -8, 'REV'],
          ['Scanstraat specificeren', 'tjonafat', 25, -9],
        ],
      },
      {
        name: 'Uitvoering',
        start: -11,
        end: -120,
        planned: 5,
        tickets: [
          ['E-dossier bouwen en testen', 'moenne', -11, -90],
          ['Lopende dossiers scannen', 'tjonafat', -20, -100],
          ['Training loketmedewerkers', 'abauna', -90, -115],
          ['Livegang en ondersteuning eerste week', 'chin', -116, -120],
        ],
      },
      {
        name: 'Afsluiting en overdracht',
        start: -121,
        end: -150,
        planned: 5,
        tickets: [['Nazorg en evaluatie', 'chin', -121, -145]],
      },
    ],
    bc: {
      problem: 'Aanvragen voor verblijf en naturalisatie liggen gemiddeld zeven maanden op papier; dossiers raken zoek tussen loket, behandelaar en Directeur. Aanvragers bellen dagelijks over de stand.',
      solution: 'Een e-dossier per aanvraag: alles gescand bij binnenkomst, behandeling en paraaf op het scherm, en een volgcode voor de aanvrager.',
      benefits: 'Doorlooptijd van zeven naar drie maanden. Geen zoekgeraakte dossiers. 60% minder telefoon aan het loket.',
      costs: 'Eenmalig SRD 1,6 mln (software, scanstraat, scannen achterstand). Jaarlijks SRD 180.000.',
      risks: 'Achterstand tijdens de overgang (maatregel: eerst alleen nieuwe aanvragen); weerstand bij behandelaars (maatregel: sleutelgebruikers vanaf het begin betrokken).',
      budget: 1600000,
    },
    bcSaved: 48,
    bcSubmitted: 46,
    bcApproved: 42,
  },
  {
    name: 'Vervanging portofoons Korps Politie',
    description: 'De analoge portofoons van het korps worden vervangen door een digitaal, versleuteld radiosysteem met dekking in de districten en het binnenland.',
    unit: 'PO',
    owner: 'directeur2',
    manager: 'pengel',
    stakeholders: ['onderdirecteur3', 'ramdin'],
    created: 30,
    phases: [
      {
        name: 'Business case',
        start: 30,
        end: -5,
        tickets: [
          ['Inventarisatie huidige portofoons', 'adjako', 30, 20, 19],
          ['Dekkingsonderzoek districten en binnenland', 'zalman', 29, 15, 14],
          ['Kostenraming en financiering', 'kalloe', 28, 12, 11],
          ['Marktconsultatie leveranciers', 'chinalin', 26, 10, 9],
          ['Business case opstellen', 'pengel', 25, 8, 7],
        ],
      },
      { name: 'Documentatie en ontwerp', start: -6, end: -60, tickets: [] },
      { name: 'Uitvoering', start: -61, end: -260, tickets: [] },
      { name: 'Afsluiting en overdracht', start: -261, end: -300, tickets: [] },
    ],
    bc: {
      problem: 'De analoge portofoons zijn 18 jaar oud, kunnen worden afgeluisterd en hebben geen bereik in grote delen van het binnenland. Onderdelen zijn niet meer te krijgen.',
      solution: 'Een digitaal, versleuteld radiosysteem met vijf nieuwe masten in de districten en satellietverbinding voor de binnenlandse posten; 900 nieuwe portofoons.',
      benefits: 'Niet af te luisteren. Bereik voor alle posten. Noodknop met locatie voor agenten in nood.',
      costs: 'SRD 9,4 mln in twee jaar (2027: 6,1 mln; 2028: 3,3 mln). Jaarlijks SRD 420.000 onderhoud.',
      risks: 'Financiering 2028 nog niet zeker (maatregel: gefaseerd per district); levertijd masten (maatregel: tijdelijk huren).',
      budget: 9400000,
    },
    bcSaved: 7,
    bcSubmitted: 6,
  },
  {
    name: 'Camerabewaking binnenstad Paramaribo',
    description: "Camera's aan de Waterkant, de Kernkamp en de Domineestraat, met een meldkamer bij het korps en een privacyprotocol voor de beelden.",
    unit: 'PO',
    owner: 'onderdirecteur3',
    manager: 'sastrodimedjo',
    stakeholders: ['pengel'],
    created: 160,
    phases: [
      {
        name: 'Business case',
        start: 160,
        end: 145,
        tickets: [
          ['Probleemanalyse overlast binnenstad', 'brandon', 160, 150, 150],
          ['Business case opstellen', 'sastrodimedjo', 158, 146, 146],
        ],
      },
      {
        name: 'Ontwerp',
        start: 144,
        end: 100,
        planned: 140,
        closed: 98,
        tickets: [
          ['Cameralocaties bepalen met het korps', 'brandon', 139, 120, 119],
          ['Aanbesteding camerasysteem', 'chinalin', 135, 105, 104],
          ['Privacy-impactanalyse', 'fernandes', 130, 110, 109],
        ],
      },
      {
        name: 'Uitvoering',
        start: 97,
        end: 30,
        planned: 97,
        tickets: [
          ["40 camera's plaatsen aan de Waterkant", 'venloo', 97, 50, 48],
          ["Camera's plaatsen Kernkamp en Domineestraat", 'venloo', 60, 25, 'IP'],
          ['Meldkamer inrichten', 'brandon', 70, 35, 'WAIT', 'Wacht op levering van de beeldschermen.'],
          ['Privacyprotocol beelden vaststellen', 'fernandes', 50, 40, 39],
          ['Koppeling met noodnummer 115', 'wirjosentono', 45, 10],
        ],
      },
      {
        name: 'Afsluiting',
        start: 29,
        end: 20,
        planned: 30,
        tickets: [
          ['Overdracht aan het korps', 'sastrodimedjo', 29, 22],
          ['Evaluatie na drie maanden', 'brandon', 25, 20],
        ],
      },
    ],
    bc: {
      problem: 'Toenemende straatroof en overlast in de binnenstad; winkeliers en toeristen voelen zich onveilig. De politie heeft te weinig ogen op straat.',
      solution: "65 camera's op de drukste punten, een meldkamer bij het korps die 18 uur per dag meekijkt, en vaste regels voor het bewaren en inzien van beelden.",
      benefits: '20% minder straatroof in het eerste jaar (doel). Snellere inzet bij incidenten. Beelden als bewijs.',
      costs: "SRD 1,9 mln camera's en installatie, SRD 300.000 meldkamer. Jaarlijks SRD 260.000 bemensing en onderhoud.",
      risks: 'Privacyklachten (maatregel: protocol en logboek); diefstal en vandalisme (maatregel: hoge masten).',
      budget: 2200000,
    },
    bcSaved: 146,
    bcSubmitted: 145,
    bcApproved: 140,
  },
  {
    name: 'Opleidingsprogramma wijkagenten 2027',
    description: 'Een vast opleidingsprogramma voor wijkagenten: buurtgericht werken, huiselijk geweld herkennen en jongeren bereiken.',
    unit: 'PO',
    owner: 'onderdirecteur3',
    manager: 'asoiti',
    stakeholders: ['pengel', 'nahar'],
    created: 12,
    phases: [
      {
        name: 'Business case',
        start: 12,
        end: -10,
        tickets: [
          ['Behoeftepeiling in de districten', 'lieuwon', 12, 2, 3],
          ['Lesprogramma schetsen', 'asoiti', 11, -5, 'IP'],
          ['Kosten trainers en locaties', 'kalloe', 10, -6],
          ['Business case opstellen', 'asoiti', 8, -8],
        ],
      },
      { name: 'Uitvoering', start: -11, end: -200, tickets: [] },
      { name: 'Afsluiting', start: -201, end: -230, tickets: [] },
    ],
    bc: {
      problem: 'Wijkagenten krijgen geen vaste opleiding voor hun werk in de buurt; de kennis verschilt sterk per district.',
      solution: 'Een programma van zes modules per jaar, gegeven in de districten zelf.',
      benefits: '',
      costs: '',
      risks: '',
      budget: 0,
    },
    bcPartial: true,
    bcSaved: 2,
  },
  {
    name: 'Begrotingscyclus 2027 digitaal',
    description: 'De begroting wordt per directoraat digitaal opgesteld, goedgekeurd en verantwoord, met rapportages voor De Nationale Assemblée.',
    unit: 'FZ',
    owner: 'onderdirecteur2',
    manager: 'ramdin',
    stakeholders: ['directeur2'],
    created: 95,
    phases: [
      {
        name: 'Business case',
        start: 95,
        end: 75,
        tickets: [
          ['Knelpunten huidige begrotingscyclus', 'soekhoe', 95, 82, 82],
          ['Business case opstellen', 'ramdin', 90, 78, 78],
        ],
      },
      {
        name: 'Documentatie en ontwerp',
        start: 74,
        end: 5,
        planned: 70,
        tickets: [
          ['Begrotingsformat per directoraat', 'soekhoe', 69, 40, 41],
          ['Goedkeuringsroute begroting', 'kalloe', 60, 20, 22],
          ['Rapportage-eisen De Nationale Assemblée', 'mungra', 50, 3, 'IP'],
          ['Koppeling met het financieel systeem', 'sitaram', 40, -10, 'IP'],
        ],
      },
      {
        name: 'Uitvoering',
        start: 4,
        end: -90,
        planned: 3,
        tickets: [
          ['Begrotingsmodule bouwen', 'sitaram', -5, -70],
          ['Training budgethouders', 'soekhoe', -60, -85],
        ],
      },
      { name: 'Afsluiting en overdracht', start: -91, end: -110, tickets: [] },
    ],
    bc: {
      problem: 'De begroting gaat als losse Excel-bestanden per e-mail rond; versies lopen door elkaar en de verantwoording aan De Nationale Assemblée kost weken handwerk.',
      solution: 'Eén digitaal begrotingsformat per directoraat met een vaste goedkeuringsroute en standaardrapportages.',
      benefits: 'Begroting twee weken eerder klaar. Eén versie van de waarheid. Rapportages met een druk op de knop.',
      costs: 'SRD 640.000 eenmalig, SRD 90.000 per jaar.',
      risks: 'Budgethouders werken liever in Excel (maatregel: import en training).',
      budget: 640000,
    },
    bcSaved: 78,
    bcSubmitted: 77,
    bcApproved: 70,
  },
  {
    name: 'Personeelsdossiers 2010–2020 digitaliseren',
    description: 'De papieren personeelsdossiers van 2010 tot en met 2020 worden gescand en in het EDRMS opgenomen, met de juiste bewaartermijnen.',
    unit: 'PZ',
    owner: 'onderdirecteur2',
    manager: 'vlijter',
    stakeholders: ['linger', 'ramdin'],
    created: 40,
    phases: [
      {
        name: 'Business case',
        start: 40,
        end: -5,
        tickets: [
          ['Omvang van het archief tellen', 'atmodikoro', 40, 30, 29],
          ['Offertes scanbureaus', 'tjoeawie', 38, 25, 24],
          ['Business case opstellen', 'vlijter', 35, 20, 19],
        ],
      },
      { name: 'Documentatie en ontwerp', start: -6, end: -40, tickets: [] },
      { name: 'Uitvoering', start: -41, end: -150, tickets: [] },
      { name: 'Afsluiting en overdracht', start: -151, end: -170, tickets: [] },
    ],
    bc: {
      problem: 'Ruim 2.300 personeelsdossiers liggen alleen op papier in het archief van PZ; opzoeken kost dagen en de ruimte is vol.',
      solution: 'Scannen door een scanbureau, opnemen in het EDRMS met rubricering en bewaartermijn, en de papieren dossiers overbrengen.',
      benefits: 'Dossier binnen een minuut op het scherm. Archiefruimte vrij. Toezicht op wie een dossier inziet.',
      costs: 'SRD 380.000 in totaal.',
      risks: 'Privacy tijdens het scannen (maatregel: scannen op locatie).',
      budget: 380000,
    },
    bcSaved: 19,
    bcSubmitted: 18,
    bcReturned: [15, 'Graag de kosten per jaar uitsplitsen en aangeven wat er met de papieren dossiers gebeurt na het scannen: vernietigen of overbrengen naar het Nationaal Archief.'],
  },
  {
    name: 'Uitwijkcentrum ICT',
    description: 'Een tweede locatie waar de systemen van het ministerie binnen vier uur weer draaien als het hoofdkantoor uitvalt.',
    unit: 'HO-ICT',
    owner: 'directeur2',
    manager: 'marhe',
    stakeholders: ['onderdirecteur2'],
    classification: 'CONFIDENTIAL',
    created: 140,
    phases: [
      {
        name: 'Business case',
        start: 140,
        end: 120,
        tickets: [
          ['Risicoanalyse uitval datacenter', 'wirjosentono', 140, 128, 127],
          ['Business case opstellen', 'marhe', 138, 124, 123],
        ],
      },
      {
        name: 'Documentatie en ontwerp',
        start: 119,
        end: 70,
        planned: 116,
        closed: 68,
        tickets: [
          ['Eisen aan de uitwijklocatie', 'tjinkonfat', 115, 90, 88],
          ['Keuze locatie en contract', 'marhe', 110, 75, 72],
          ['Uitwijkprocedures beschrijven', 'cairo', 100, 72, 70],
        ],
      },
      {
        name: 'Uitvoering',
        start: 67,
        end: -40,
        planned: 67,
        tickets: [
          ['Ruimte en stroomvoorziening', 'tjinkonfat', 67, 30, 28],
          ['Replicatie van de databases', 'cairo', 50, -10, 'IP'],
          ['Netwerkverbinding met de tweede locatie', 'zalman', 45, -5, 'IP'],
          ['Uitwijktest met alle directoraten', 'wirjosentono', 20, -35],
        ],
      },
      {
        name: 'Afsluiting en overdracht',
        start: -41,
        end: -60,
        planned: 20,
        tickets: [['Uitwijkplan vaststellen', 'marhe', -41, -55]],
      },
    ],
    bc: {
      problem: 'Alle systemen van het ministerie draaien in één serverruimte. Bij brand of langdurige stroomuitval ligt het werk van het hele ministerie stil.',
      solution: 'Een tweede locatie met gerepliceerde databases en een geteste uitwijkprocedure.',
      benefits: 'Systemen binnen vier uur terug na uitval. Geen verlies van registraties.',
      costs: 'SRD 1,2 mln eenmalig, SRD 210.000 per jaar.',
      risks: 'Vertrouwelijkheid van de locatie (maatregel: project vertrouwelijk, beperkte kring).',
      budget: 1200000,
    },
    bcSaved: 123,
    bcSubmitted: 122,
    bcApproved: 116,
  },
  {
    name: 'Slachtofferhulploket Nickerie',
    description: 'Een loket voor slachtofferhulp in Nieuw Nickerie, samen met het korps en Slachtofferhulp, zodat slachtoffers niet naar Paramaribo hoeven.',
    unit: 'JZ',
    owner: 'directeur',
    manager: 'wongsodikromo',
    stakeholders: ['dualrole'],
    created: 110,
    phases: [
      {
        name: 'Business case',
        start: 110,
        end: 90,
        tickets: [
          ['Behoefte in Nickerie in kaart brengen', 'esajas', 110, 98, 97],
          ['Business case opstellen', 'wongsodikromo', 105, 93, 92],
        ],
      },
      {
        name: 'Documentatie en ontwerp',
        start: 89,
        end: 40,
        planned: 86,
        tickets: [
          ['Locatie zoeken in Nieuw Nickerie', 'esajas', 85, 60, 58],
          ['Samenwerking met Slachtofferhulp vastleggen', 'abena', 80, 50, 49],
          ['Personeelsplan loket', 'karsoredjo', 75, 45, 'WAIT', 'Wacht op de begroting 2027.'],
        ],
      },
      { name: 'Uitvoering', start: 39, end: -60, tickets: [] },
      { name: 'Afsluiting en overdracht', start: -61, end: -80, tickets: [] },
    ],
    bc: {
      problem: 'Slachtoffers in Nickerie moeten voor hulp en informatie over hun zaak naar Paramaribo; velen haken af.',
      solution: 'Een loket twee dagen per week in Nieuw Nickerie, in het politiebureau, met een medewerker van Justitie en van Slachtofferhulp.',
      benefits: 'Hulp dichtbij. Meer aangiftes die doorgezet worden.',
      costs: 'SRD 180.000 per jaar.',
      risks: 'Geen geschikte ruimte (maatregel: tijdelijk in het politiebureau).',
      budget: 180000,
    },
    bcSaved: 92,
    bcSubmitted: 91,
    bcApproved: 86,
    hold: [35, 'Wacht op de begroting 2027; de huurlocatie is nog niet vrijgegeven.'],
  },
  {
    name: 'Implementatie herziening Wetboek van Strafvordering',
    description: 'Invoering van het herziene Wetboek van Strafvordering bij griffies, Openbaar Ministerie en politie: werkprocessen, formulieren, opleiding en voorlichting.',
    unit: 'JZ',
    owner: 'minister',
    manager: 'dualrole',
    stakeholders: ['directeur', 'kartodikromo'],
    created: 55,
    phases: [
      {
        name: 'Business case',
        start: 55,
        end: 35,
        tickets: [
          ['Impactanalyse wetswijziging', 'mahabier', 55, 42, 41],
          ['Business case opstellen', 'dualrole', 52, 38, 37],
        ],
      },
      {
        name: 'Documentatie en ontwerp',
        start: 34,
        end: -20,
        planned: 30,
        tickets: [
          ['Overzicht wijzigingen per artikel', 'jagernath', 29, 5, 6],
          ['Gevolgen voor griffies en Openbaar Ministerie', 'mahabier', 28, -5, 'IP'],
          ['Internationale verdragen toetsen', 'fungaloi', 25, -10, 'IP'],
          ['Communicatieplan', 'oostburg', 20, -15],
          ['Uitvoeringstoets politie', 'pinas', 15, -12, 'ACC'],
        ],
      },
      { name: 'Uitvoering', start: -21, end: -200, tickets: [] },
      { name: 'Afsluiting en overdracht', start: -201, end: -240, tickets: [] },
    ],
    bc: {
      problem: 'Het herziene Wetboek treedt in werking; zonder voorbereiding werken griffies, OM en politie met verouderde formulieren en procedures.',
      solution: 'Per organisatie nieuwe werkprocessen en formulieren, een opleiding voor 600 medewerkers en voorlichting aan advocaten en publiek.',
      benefits: 'Ordelijke invoering op de wettelijke datum. Minder vormfouten en vrijspraken op procedurele gronden.',
      costs: 'SRD 1,1 mln (opleiding, drukwerk, voorlichting).',
      risks: 'Krappe termijn (maatregel: prioriteit voor de wijzigingen met de meeste impact).',
      budget: 1100000,
    },
    bcSaved: 37,
    bcSubmitted: 36,
    bcApproved: 30,
  },
  {
    name: 'Bewustwordingscampagne huiselijk geweld',
    description: 'Een landelijke campagne op radio, sociale media en scholen, in vier talen, met het meldnummer voorop.',
    unit: 'JZ',
    owner: 'directeur',
    manager: 'karsoredjo',
    stakeholders: ['oostburg'],
    created: 70,
    phases: [
      {
        name: 'Business case',
        start: 70,
        end: 55,
        tickets: [
          ['Cijfers huiselijk geweld verzamelen', 'kenswil', 70, 60, 60],
          ['Business case opstellen', 'karsoredjo', 68, 57, 56],
        ],
      },
      {
        name: 'Campagne',
        start: 54,
        end: -25,
        planned: 52,
        tickets: [
          ['Campagneboodschap en beelden', 'pawiroredjo', 51, 30, 29],
          ['Radiospots in vier talen', 'pawiroredjo', 40, 10, 9],
          ['Voorlichting op scholen', 'abena', 35, -10, 'IP'],
          ['Meldingen per week bijhouden', 'kenswil', 30, -20],
          ['Planning sociale media', 'pawiroredjo', 20, 2, 'IP'],
        ],
      },
      { name: 'Afsluiting en evaluatie', start: -26, end: -40, tickets: [] },
    ],
    bc: {
      problem: 'Huiselijk geweld wordt weinig gemeld; veel slachtoffers kennen het meldnummer niet of durven niet te bellen.',
      solution: 'Een campagne van drie maanden op radio, sociale media en scholen, in het Nederlands, Sranantongo, Sarnami en Javaans.',
      benefits: 'Meer meldingen (doel: +30%). Bekendheid meldnummer boven 70%.',
      costs: 'SRD 260.000.',
      risks: 'Meer meldingen dan de hulpverlening aankan (maatregel: afspraken met Slachtofferhulp vooraf).',
      budget: 260000,
    },
    bcSaved: 56,
    bcSubmitted: 55,
    bcApproved: 52,
  },
];

/**
 * Four or five tickets in every phase: what the project managers planned
 * further ahead, and the smaller jobs of each phase. [project, phase index,
 * tickets, day the tickets were made].
 */
const MORE: [string, number, TicketSpec[], number?][] = [
  ['Digitalisering strafregister', 3, [['Eindrapportage aan de Minister', 'kartodikromo', -88, -94]]],
  ['Invoering e-dossier Vreemdelingenzaken', 3, [
    ['Overdracht aan applicatiebeheer', 'goerdayal', -121, -130],
    ['Papieren dossiers overbrengen naar het archief', 'bissumbhar', -122, -140],
    ['Eindrapportage', 'chin', -140, -150],
  ]],
  ['Vervanging portofoons Korps Politie', 1, [
    ['Programma van eisen radiosysteem', 'adjako', -6, -30],
    ['Frequentievergunning aanvragen', 'gopie', -10, -40],
    ['Locaties zendmasten vastleggen', 'zalman', -15, -45],
    ['Aanbestedingsdocumenten', 'chinalin', -30, -60],
  ], 6],
  ['Vervanging portofoons Korps Politie', 2, [
    ['Zendmasten plaatsen', 'zalman', -61, -180],
    ['Portofoons uitleveren per district', 'adjako', -150, -240],
    ['Training meldkamer en agenten', 'kariodimedjo', -170, -250],
    ['Oude portofoons afvoeren', 'gopie', -230, -258],
  ], 6],
  ['Vervanging portofoons Korps Politie', 3, [
    ['Overdracht aan korpsbeheer', 'adjako', -261, -280],
    ['Evaluatie dekking binnenland', 'zalman', -270, -290],
    ['Eindafrekening', 'kalloe', -280, -295],
    ['Eindrapportage', 'pengel', -290, -300],
  ], 6],
  ['Camerabewaking binnenstad Paramaribo', 0, [
    ['Gesprekken met winkeliers en wijkraad', 'fernandes', 159, 150, 151],
    ["Kostenraming camera's en meldkamer", 'chinalin', 158, 148, 149],
  ]],
  ['Camerabewaking binnenstad Paramaribo', 1, [['Stroom- en glasvezelaansluitingen', 'venloo', 130, 102, 101]]],
  ['Camerabewaking binnenstad Paramaribo', 3, [
    ['Gebruikershandleiding meldkamer', 'brandon', 28, 21],
    ['Eindafrekening', 'eersel', 27, 20],
  ]],
  ['Opleidingsprogramma wijkagenten 2027', 1, [
    ['Trainers werven', 'asoiti', -11, -40],
    ['Lesmateriaal ontwikkelen', 'kariodimedjo', -20, -70],
    ['Eerste module in Paramaribo', 'lieuwon', -70, -110],
    ['Modules in de districten', 'leeflang', -110, -195],
  ], 1],
  ['Opleidingsprogramma wijkagenten 2027', 2, [
    ['Evaluatie met de wijkagenten', 'lieuwon', -201, -215],
    ['Certificaten uitreiken', 'nahar', -205, -220],
    ['Programma 2028 voorstellen', 'asoiti', -215, -228],
    ['Eindrapportage', 'asoiti', -225, -230],
  ], 1],
  ['Begrotingscyclus 2027 digitaal', 0, [
    ['Wensen van budgethouders ophalen', 'kalloe', 94, 84, 84],
    ['Leveranciers vergelijken', 'sitaram', 92, 80, 80],
  ]],
  ['Begrotingscyclus 2027 digitaal', 2, [
    ['Testen met twee directoraten', 'mungra', -50, -75],
    ['Begroting 2027 in het systeem zetten', 'soekhoe', -75, -90],
  ]],
  ['Begrotingscyclus 2027 digitaal', 3, [
    ['Overdracht aan Financiële Zaken', 'sitaram', -91, -100],
    ['Handleiding budgethouders', 'kalloe', -91, -102],
    ['Evaluatie begrotingscyclus', 'ramdin', -95, -105],
    ['Eindrapportage', 'ramdin', -105, -110],
  ], 3],
  ['Personeelsdossiers 2010–2020 digitaliseren', 1, [
    ['Indexering en metadata per dossier', 'atmodikoro', -6, -20],
    ['Bewaartermijnen per documentsoort', 'tjoeawie', -8, -25],
    ['Privacyafspraken met het scanbureau', 'ramdien', -10, -30],
    ['Planning scannen per jaargang', 'vlijter', -20, -40],
  ], 1],
  ['Personeelsdossiers 2010–2020 digitaliseren', 2, [
    ['Scannen 2010–2014', 'atmodikoro', -41, -90],
    ['Scannen 2015–2020', 'atmodikoro', -90, -140],
    ['Kwaliteitscontrole met steekproef', 'tjoeawie', -50, -145],
    ['Opnemen in het EDRMS', 'kanhai', -60, -148],
  ], 1],
  ['Personeelsdossiers 2010–2020 digitaliseren', 3, [
    ['Papieren dossiers overbrengen', 'tjoeawie', -151, -160],
    ['Evaluatie', 'vlijter', -155, -165],
    ['Eindafrekening', 'eersel', -160, -168],
    ['Eindrapportage', 'vlijter', -165, -170],
  ], 1],
  ['Uitwijkcentrum ICT', 0, [
    ['Maximale uitvaltijd per directoraat', 'cairo', 139, 130, 129],
    ['Kosten tweede locatie', 'kalloe', 137, 126, 125],
  ]],
  ['Uitwijkcentrum ICT', 1, [['Beveiliging van de locatie', 'wirjosentono', 112, 80, 79]]],
  ['Uitwijkcentrum ICT', 3, [
    ['Overdracht aan beheer', 'tjinkonfat', -42, -55],
    ['Tweede uitwijktest', 'wirjosentono', -45, -58],
    ['Eindrapportage', 'marhe', -55, -60],
  ]],
  ['Slachtofferhulploket Nickerie', 0, [
    ['Overleg met de districtscommissaris', 'abena', 108, 99, 98],
    ['Kosten loket per jaar', 'kalloe', 106, 95, 94],
  ]],
  ['Slachtofferhulploket Nickerie', 1, [['Werkinstructie intake slachtoffers', 'esajas', 70, 42]]],
  ['Slachtofferhulploket Nickerie', 2, [
    ['Ruimte inrichten', 'esajas', 39, 10],
    ['Medewerkers werven', 'karsoredjo', 35, -10],
    ['Voorlichting in Nickerie', 'abena', 20, -40],
    ['Opening loket', 'wongsodikromo', -40, -55],
  ], 39],
  ['Slachtofferhulploket Nickerie', 3, [
    ['Bezoekcijfers vastleggen', 'karsoredjo', -61, -70],
    ['Overdracht aan Slachtofferhulp', 'abena', -62, -78],
    ['Evaluatie na drie maanden', 'wongsodikromo', -61, -75],
    ['Eindrapportage', 'wongsodikromo', -75, -80],
  ], 39],
  ['Implementatie herziening Wetboek van Strafvordering', 0, [
    ['Gesprekken met griffies en Openbaar Ministerie', 'jagernath', 54, 44, 43],
    ['Kostenraming opleiding en drukwerk', 'kalloe', 53, 40, 39],
  ]],
  ['Implementatie herziening Wetboek van Strafvordering', 2, [
    ['Nieuwe formulieren en sjablonen', 'mahabier', -21, -60],
    ['Werkprocessen griffies aanpassen', 'jagernath', -30, -150],
    ['Opleiding 600 medewerkers', 'kariodimedjo', -40, -170],
    ['Voorlichting advocatuur', 'oostburg', -60, -120],
  ], 1],
  ['Implementatie herziening Wetboek van Strafvordering', 3, [
    ['Monitoring eerste zes maanden', 'mahabier', -201, -230],
    ['Evaluatie met OM en griffies', 'dualrole', -220, -235],
    ['Eindrapportage aan de Minister', 'dualrole', -230, -240],
    ['Projectdossier archiveren', 'mohan', -235, -240],
  ], 1],
  ['Bewustwordingscampagne huiselijk geweld', 0, [
    ['Partners benaderen: Slachtofferhulp en scholen', 'abena', 69, 59, 58],
    ['Kostenraming media', 'pawiroredjo', 67, 58, 57],
  ]],
  ['Bewustwordingscampagne huiselijk geweld', 2, [
    ['Effectmeting meldingen', 'kenswil', -26, -35],
    ['Evaluatie met de partners', 'karsoredjo', -30, -38],
    ['Eindafrekening media', 'eersel', -32, -38],
    ['Eindrapportage', 'karsoredjo', -35, -40],
  ], 1],
];

for (const [name, index, tickets, planned] of MORE) {
  const phase = PROJECTS.find((p) => p.name === name)?.phases[index];
  if (!phase) throw new Error(`Unknown phase ${index} of ${name}`);
  phase.tickets.push(...tickets);
  if (planned !== undefined && phase.planned === undefined) phase.planned = planned;
}

// ---------------------------------------------------------------- the story

export function registerProjects(ctx: StoryContext): void {
  for (const spec of PROJECTS) story(ctx, spec);
}

function story(ctx: StoryContext, spec: ProjectSpec): void {
  const state = { id: '', milestones: [] as string[], tickets: new Map<string, string>() };
  const version = async () => (await ctx.db.query(`SELECT version FROM project WHERE id = $1`, [state.id]))[0].version as number;
  const taskVersion = async (id: string) => (await ctx.db.query(`SELECT version FROM task WHERE id = $1`, [id]))[0].version as number;
  const rel = (batch: number, target: number) => ctx.due(batch - target);

  // The project starts: its phases with their dates, the stakeholders, and the first tickets.
  ctx.on(spec.created, async () => {
    const owner = await ctx.as(e(spec.owner));
    const created = await ctx.ok(
      owner.post('/api/projects').send({
        name: spec.name,
        description: spec.description,
        unitId: ctx.unit(spec.unit),
        managerAccountId: ctx.id(e(spec.manager)),
        stakeholders: (spec.stakeholders ?? []).map((s) => ctx.id(e(s))),
        startDate: rel(spec.created, spec.phases[0].start),
        endDate: rel(spec.created, spec.phases[spec.phases.length - 1].end),
        ...(spec.classification ? { classification: spec.classification } : {}),
        milestones: spec.phases.map((p) => ({ name: p.name, startDate: rel(spec.created, p.start), endDate: rel(spec.created, p.end) })),
      }),
      201,
    );
    state.id = created.id;
    state.milestones = created.milestones.map((m: { id: string }) => m.id);
    for (const c of ['start_date', 'end_date']) ctx.later('project', c, state.id);
    for (const m of state.milestones) for (const c of ['start_date', 'end_date']) ctx.later('project_milestone', c, m);
  });

  // Each phase's tickets, made by the project manager when the phase is planned.
  spec.phases.forEach((phase, i) => {
    if (!phase.tickets.length) return;
    const day = phase.planned ?? (i === 0 ? spec.created : Math.max(phase.start, 1));
    ctx.on(day, async () => {
      const pm = await ctx.as(e(spec.manager));
      for (const [title, who, start, due] of phase.tickets) {
        const t = await ctx.ok(
          pm.post(`/api/projects/${state.id}/tickets`).send({
            milestoneId: state.milestones[i],
            title,
            assigneeAccountId: ctx.id(e(who)),
            startDate: rel(day, Math.min(start, day)),
            dueDate: rel(day, due),
            priority: due < 15 && due > -15 ? 'HIGH' : 'MEDIUM',
          }),
          201,
        );
        state.tickets.set(title, t.id);
        ctx.later('task', 'start_date', t.id);
        ctx.later('task', 'due_date', t.id);
      }
    });
    // What became of each ticket, on its day.
    for (const [title, who, , , outcome, note] of phase.tickets) {
      if (outcome === undefined) continue;
      // Work starts a few days after the ticket was made.
      const when = typeof outcome === 'number' ? outcome : Math.max(day - 3, 1);
      ctx.on(when, async () => {
        const holder = await ctx.as(e(who));
        const id = state.tickets.get(title)!;
        if (typeof outcome === 'number') await ctx.ok(holder.post(`/api/tasks/${id}/complete`).send({ version: await taskVersion(id) }), 200);
        else if (outcome === 'ACC') await ctx.ok(holder.post(`/api/tasks/${id}/accept`).send({ version: await taskVersion(id) }), 200);
        else {
          const status = { IP: 'IN_PROGRESS', WAIT: 'WAITING', REV: 'IN_REVIEW' }[outcome];
          await ctx.ok(holder.post(`/api/tasks/${id}/status`).send({ status, version: await taskVersion(id), ...(note ? { note } : {}) }), 200);
        }
      });
    }
  });

  // The business case: written, submitted, decided.
  if (spec.bcSaved !== undefined) {
    ctx.on(spec.bcSaved, async () => {
      const pm = await ctx.as(e(spec.manager));
      const bc = spec.bcPartial ? { problem: spec.bc.problem, solution: spec.bc.solution } : spec.bc;
      await ctx.ok(pm.put(`/api/projects/${state.id}/business-case`).send({ version: await version(), ...bc }), 200);
    });
  }
  if (spec.bcSubmitted !== undefined) {
    ctx.on(spec.bcSubmitted, async () => {
      const pm = await ctx.as(e(spec.manager));
      await ctx.ok(pm.post(`/api/projects/${state.id}/business-case/submit`).send({ version: await version() }), 200);
    });
  }
  if (spec.bcReturned) {
    const [day, reason] = spec.bcReturned;
    ctx.on(day, async () => {
      const owner = await ctx.as(e(spec.owner));
      await ctx.ok(owner.post(`/api/projects/${state.id}/business-case/return`).send({ version: await version(), reason }), 200);
      // The project manager plans the extra work the owner asked for.
      const pm = await ctx.as(e(spec.manager));
      for (const [title, who, due] of [
        ['Kosten per jaar uitsplitsen', 'ramdien', -3],
        ['Afspraak met het Archief over de papieren originelen', 'tjoeawie', -2],
      ] as const) {
        const t = await ctx.ok(
          pm.post(`/api/projects/${state.id}/tickets`).send({ milestoneId: state.milestones[0], title, assigneeAccountId: ctx.id(e(who)), startDate: rel(day - 1, day - 1), dueDate: rel(day - 1, due), priority: 'HIGH' }),
          201,
        );
        ctx.later('task', 'start_date', t.id);
        ctx.later('task', 'due_date', t.id);
        if (who === 'ramdien') {
          const holder = await ctx.as(e(who));
          await ctx.ok(holder.post(`/api/tasks/${t.id}/status`).send({ status: 'IN_PROGRESS', version: await taskVersion(t.id) }), 200);
        }
      }
    });
  }
  if (spec.bcApproved !== undefined) {
    ctx.on(spec.bcApproved, async () => {
      const owner = await ctx.as(e(spec.owner));
      await ctx.ok(owner.post(`/api/projects/${state.id}/business-case/approve`).send({ version: await version() }), 200);
    });
  }

  // Phases closed by the project manager; the closure signed off by the owner.
  spec.phases.forEach((phase, i) => {
    if (phase.closed === undefined || i === 0) return;
    ctx.on(phase.closed, async () => {
      const pm = await ctx.as(e(spec.manager));
      await ctx.ok(pm.post(`/api/projects/${state.id}/milestones/${state.milestones[i]}/close`).send({ version: await version() }), 200);
    });
  });
  if (spec.signedOff !== undefined) {
    ctx.on(spec.signedOff, async () => {
      const owner = await ctx.as(e(spec.owner));
      await ctx.ok(
        owner
          .post(`/api/projects/${state.id}/milestones/${state.milestones[state.milestones.length - 1]}/close`)
          .send({ version: await version(), note: 'Opgeleverd volgens plan; restpunten afgehandeld. Afgetekend.' }),
        200,
      );
    });
  }
  if (spec.hold) {
    const [day, reason] = spec.hold;
    ctx.on(day, async () => {
      const owner = await ctx.as(e(spec.owner));
      await ctx.ok(owner.post(`/api/projects/${state.id}/status`).send({ action: 'HOLD', version: await version(), reason }), 200);
    });
  }
}
