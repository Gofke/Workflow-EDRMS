/**
 * The assistant's help knowledge: how to do things in the system, in Dutch and
 * English. The chatbot answers "how do I…" questions from these articles and
 * links to the screen, so its help is always about this system, not a guess.
 */
import { cosine, idfOf, vector } from './text';

export interface HelpArticle {
  id: string;
  link: string;
  keywords: string;
  nl: { title: string; body: string };
  en: { title: string; body: string };
}

export const HELP: HelpArticle[] = [
  {
    id: 'register-post',
    link: '/post',
    keywords: 'registreren inschrijven post brief binnengekomen ontvangen poststuk register letter incoming mail intake scan',
    nl: {
      title: 'Een binnengekomen brief registreren',
      body: 'Ga naar Post en kies Nieuw poststuk. Vul onderwerp, afzender en datum in, of voeg de scan toe en laat de assistent de velden voorstellen. Controleer het voorstel en kies Registreren: de brief krijgt dan een registratienummer en kan niet meer stilletjes worden gewijzigd.',
    },
    en: {
      title: 'Register an incoming letter',
      body: 'Go to Post and choose New item. Fill in subject, sender and date, or attach the scan and let the assistant propose the fields. Check the proposal and choose Register: the letter receives a registration number and can no longer be changed without a trace.',
    },
  },
  {
    id: 'scan',
    link: '/post',
    keywords: 'scannen scan pdf document toevoegen bijlage uploaden camera foto ocr tekst herkennen attach upload photo',
    nl: {
      title: 'Een document of scan toevoegen',
      body: 'Open het poststuk en kies Document toevoegen. PDF, JPEG en PNG worden geaccepteerd en op virussen gecontroleerd. De tekst van gescande PDF-bestanden wordt automatisch herkend (Nederlands en Engels), zodat u er later op kunt zoeken. Op een telefoon kunt u direct een foto maken.',
    },
    en: {
      title: 'Add a document or scan',
      body: 'Open the item and choose Add document. PDF, JPEG and PNG are accepted and checked for viruses. Text in scanned PDFs is recognised automatically (Dutch and English) so you can search for it later. On a phone you can take a photo directly.',
    },
  },
  {
    id: 'dossier',
    link: '/zaken',
    keywords: 'zaak dossier aanmaken openen koppelen brief toevoegen verantwoordelijke termijn matter case create link responsible due date',
    nl: {
      title: 'Een zaak (dossier) aanmaken en brieven koppelen',
      body: 'Ga naar Zaken en kies Nieuwe zaak. Kies een categorie uit het archiefplan; de termijn en de bewaartermijn volgen daaruit. Koppel geregistreerde brieven via het tabblad Stukken, wijs een verantwoordelijke toe en bevestig de termijn.',
    },
    en: {
      title: 'Create a matter (dossier) and link letters',
      body: 'Go to Matters and choose New matter. Pick a category from the file plan; the deadline and retention period follow from it. Link registered letters on the Records tab, assign a responsible person and confirm the deadline.',
    },
  },
  {
    id: 'tasks',
    link: '/taken',
    keywords: 'taak taken aanmaken toewijzen actie checklist subtaak herhalen bord kalender task create assign checklist subtask recurring board calendar',
    nl: {
      title: 'Taken aanmaken en opvolgen',
      body: 'Ga naar Taken en kies Nieuwe taak, of maak een taak vanuit een zaak of brief. Geef een titel, een uitvoerder, een termijn en eventueel een checklist of subtaken. U kunt taken bekijken als lijst, als bord of op de kalender. Een taak wordt nooit verwijderd; hij wordt afgerond, geannuleerd of gearchiveerd.',
    },
    en: {
      title: 'Create and follow up tasks',
      body: 'Go to Tasks and choose New task, or create one from a matter or letter. Give a title, an assignee, a due date and optionally a checklist or subtasks. View tasks as a list, a board or on the calendar. A task is never deleted; it is completed, cancelled or archived.',
    },
  },
  {
    id: 'approval',
    link: '/goedkeuringen',
    keywords: 'goedkeuren goedkeuring beoordelen indienen route paraaf besluit afwijzen terugsturen approve approval review submit route decision reject return',
    nl: {
      title: 'Een zaak ter goedkeuring aanbieden',
      body: 'Open de zaak en kies Indienen, of start een goedkeuringsroute (bijvoorbeeld Onder-Directeur → Directeur → Minister). Elke beoordelaar ziet de zaak in Goedkeuringen en kan goedkeuren, terugsturen met reden of afwijzen. Wat beoordeeld is, wordt vastgelegd: een wijziging daarna vraagt om een nieuwe beoordeling.',
    },
    en: {
      title: 'Submit a matter for approval',
      body: 'Open the matter and choose Submit, or start an approval route (for example Deputy Director → Director → Minister). Each reviewer sees it under Approvals and can approve, return with a reason or reject. What was reviewed is recorded: a change afterwards needs a new review.',
    },
  },
  {
    id: 'advice',
    link: '/zaken',
    keywords: 'advies vragen adviesaanvraag afdeling collega mening advice request ask colleague department',
    nl: {
      title: 'Advies vragen aan een collega of afdeling',
      body: 'Open de zaak, tabblad Advies, en kies Advies vragen. Stel de vraag, kies de persoon of afdeling en een termijn. Het antwoord komt in de zaak terecht en de vrager krijgt een melding.',
    },
    en: {
      title: 'Ask a colleague or department for advice',
      body: 'Open the matter, Advice tab, and choose Request advice. Ask the question, choose the person or department and a deadline. The answer is added to the matter and the requester is notified.',
    },
  },
  {
    id: 'out-of-office',
    link: '/profiel?tab=afwezigheid',
    keywords: 'afwezig vakantie ziek vervanging vervanger waarnemer out of office leave holiday stand-in substitute',
    nl: {
      title: 'Afwezigheid en vervanging instellen',
      body: 'Ga naar Profiel → Afwezigheid. Geef de periode en uw vervanger op. Meldingen en nieuwe beoordelingen gaan dan ook naar de vervanger. Delegatie van bevoegdheden is iets anders: die stelt u in bij Delegaties.',
    },
    en: {
      title: 'Set out-of-office and a stand-in',
      body: 'Go to Profile → Out of office. Enter the period and your stand-in. Notifications and new reviews then also go to the stand-in. Delegating authority is separate: set that under Delegations.',
    },
  },
  {
    id: 'delegation',
    link: '/delegaties',
    keywords: 'delegatie machtiging namens bevoegdheid delegation on behalf authority mandate',
    nl: {
      title: 'Bevoegdheden delegeren',
      body: 'Bij Delegaties geeft u een collega voor een bepaalde periode het recht om namens u bepaalde handelingen te verrichten. Alles wat namens u gebeurt, wordt met beide namen vastgelegd.',
    },
    en: {
      title: 'Delegate authority',
      body: 'Under Delegations you give a colleague, for a set period, the right to perform specific actions on your behalf. Everything done on your behalf is recorded with both names.',
    },
  },
  {
    id: 'search',
    link: '/zoeken',
    keywords: 'zoeken vinden zoekopdracht opslaan filter tekst in document search find saved search filter',
    nl: {
      title: 'Zoeken',
      body: 'Gebruik Zoeken bovenaan of de pagina Zoeken. U zoekt in brieven, zaken, taken én de tekst in documenten; "verzoeken" vindt ook "verzoek". Filter op afzender, periode, status of afdeling en sla een zoekopdracht op. U vindt alleen wat u mag zien.',
    },
    en: {
      title: 'Search',
      body: 'Use the search bar or the Search page. You search letters, matters, tasks and the text inside documents. Filter by sender, period, status or department and save a search. You only find what you are allowed to see.',
    },
  },
  {
    id: 'reports',
    link: '/rapporten',
    keywords: 'rapport rapportage excel pdf exporteren afdeling prestaties werkverdeling trends report export department performance workload',
    nl: {
      title: 'Rapporten en overzichten',
      body: 'Leidinggevenden vinden onder Dashboard en Rapporten het overzicht van open en te late zaken, prestaties per afdeling, de werkverdeling per persoon en trends. Elk rapport kan als Excel of PDF worden gedownload; dat wordt in het logboek vastgelegd.',
    },
    en: {
      title: 'Reports and overviews',
      body: 'Managers find the overview of open and overdue matters, department performance, workload per person and trends under Dashboard and Reports. Each report downloads as Excel or PDF; the download is recorded in the audit log.',
    },
  },
  {
    id: 'notifications',
    link: '/profiel?tab=meldingen',
    keywords: 'melding meldingen e-mail sms push herinnering dagelijks overzicht notification email reminder digest',
    nl: {
      title: 'Meldingen en herinneringen',
      body: 'U krijgt meldingen in het systeem en, als u dat wilt, per e-mail, sms of pushbericht. Herinneringen komen 5, 2 en 1 werkdag voor een termijn; na een gemiste termijn wordt de leidinggevende ingelicht. Stel uw voorkeuren in bij Profiel → Meldingen.',
    },
    en: {
      title: 'Notifications and reminders',
      body: 'You receive notifications in the system and, if you wish, by e-mail, SMS or push message. Reminders come 5, 2 and 1 working days before a deadline; after a missed deadline the supervisor is informed. Set preferences under Profile → Notifications.',
    },
  },
  {
    id: 'mfa',
    link: '/profiel?tab=beveiliging',
    keywords: 'tweestapsverificatie authenticator code beveiliging wachtwoord inloggen mfa two-factor security password login',
    nl: {
      title: 'Tweestapsverificatie instellen',
      body: 'Ga naar Profiel → Beveiliging en kies Tweestapsverificatie aanzetten. Scan de QR-code met een authenticator-app, voer de code in en bewaar de herstelcodes op een veilige plek. Na vijf verkeerde pogingen wordt een account tijdelijk geblokkeerd.',
    },
    en: {
      title: 'Set up two-step verification',
      body: 'Go to Profile → Security and choose Turn on two-step verification. Scan the QR code with an authenticator app, enter the code and keep the recovery codes somewhere safe. After five wrong attempts an account is locked for a while.',
    },
  },
  {
    id: 'reply',
    link: '/post',
    keywords: 'antwoord beantwoorden brief opstellen sjabloon concept versie verzenden reply answer letter template draft compose send',
    nl: {
      title: 'Een antwoordbrief opstellen',
      body: 'Open de binnengekomen brief en kies Beantwoorden. Kies een sjabloon of laat de assistent een concept maken; elke versie wordt bewaard. Kies daarna Brief maken: er ontstaat een PDF op briefpapier, eventueel met een digitaal zegel dat de ontvanger kan controleren.',
    },
    en: {
      title: 'Draft a reply letter',
      body: 'Open the incoming letter and choose Reply. Pick a template or let the assistant draft one; every version is kept. Then choose Create letter: a PDF on letterhead is produced, optionally with a digital seal the recipient can verify.',
    },
  },
  {
    id: 'seal',
    link: '/verifieren',
    keywords: 'zegel digitaal ondertekenen handtekening echtheid controleren qr verifiëren seal sign signature verify authenticity',
    nl: {
      title: 'Digitaal zegel en echtheid controleren',
      body: 'Een uitgaande brief kan een digitaal zegel krijgen met een QR-code. Wie de code scant of het zegelnummer invult op de pagina Verifiëren, ziet of het document echt is en niet is gewijzigd. Dit is een zegel van het systeem, geen gekwalificeerde elektronische handtekening.',
    },
    en: {
      title: 'Digital seal and checking authenticity',
      body: 'An outgoing letter can carry a digital seal with a QR code. Anyone who scans it or enters the seal number on the Verify page sees whether the document is genuine and unchanged. This is a system seal, not a qualified electronic signature.',
    },
  },
  {
    id: 'tracking',
    link: '/volgen',
    keywords: 'volgen status burger ontvangstbewijs trackingcode waar is mijn brief track status citizen receipt',
    nl: {
      title: 'Status volgen door de afzender',
      body: 'Bij registratie kan een ontvangstbewijs worden gemaakt met een volgcode. De afzender kan op de openbare pagina Volgen met het registratienummer en de code zien in welke fase de brief is, zonder inhoud te zien.',
    },
    en: {
      title: 'Status tracking for the sender',
      body: 'At registration a receipt with a tracking code can be produced. The sender can see on the public Track page, with the registration number and code, which stage the letter is in, without seeing any content.',
    },
  },
  {
    id: 'retention',
    link: '/archief',
    keywords: 'bewaartermijn archief vernietigen overbrengen nationaal archief archiefplan juridische blokkade retention archive destroy transfer legal hold file plan',
    nl: {
      title: 'Bewaren, vernietigen en overbrengen',
      body: 'Elke zaak volgt de bewaartermijn van haar categorie. De archiefbeheerder ziet onder Archief welke zaken aan de beurt zijn en besluit tot vernietigen of overbrengen naar het Nationaal Archief (met een exportpakket). Een juridische blokkade houdt een zaak vast zolang dat nodig is.',
    },
    en: {
      title: 'Retention, destruction and transfer',
      body: 'Each matter follows the retention period of its category. The records manager sees under Archive which matters are due and decides to destroy or transfer them to the National Archive (with an export package). A legal hold keeps a matter as long as needed.',
    },
  },
  {
    id: 'classification',
    link: '/zaken',
    keywords: 'vertrouwelijk geheim rubricering classificatie toegang wie mag zien need to know confidential secret classification access who can see',
    nl: {
      title: 'Vertrouwelijkheid en wie wat mag zien',
      body: 'Elke brief en zaak heeft een niveau: Open, Intern, Vertrouwelijk of Geheim. Vertrouwelijke en geheime stukken zijn alleen zichtbaar voor de daartoe bevoegde rollen en voor wie bij de zaak betrokken is. Wie iets niet mag zien, vindt het ook niet bij zoeken, in overzichten of via de assistent.',
    },
    en: {
      title: 'Confidentiality and who may see what',
      body: 'Every letter and matter has a level: Open, Internal, Confidential or Secret. Confidential and secret records are visible only to the cleared roles and to people involved in the matter. Whoever may not see something does not find it in search, overviews or through the assistant either.',
    },
  },
  {
    id: 'audit',
    link: '/logboek',
    keywords: 'logboek audit wie heeft wat gedaan geschiedenis integriteit controle log history integrity check',
    nl: {
      title: 'Logboek en integriteitscontrole',
      body: 'Alles wat er gebeurt wordt vastgelegd in een logboek dat niet kan worden gewijzigd; elke regel is met de vorige verbonden via een hash. De auditor kan het logboek doorzoeken, exporteren en een integriteitscontrole uitvoeren op het logboek en de opgeslagen documenten.',
    },
    en: {
      title: 'Audit log and integrity check',
      body: 'Everything that happens is recorded in a log that cannot be changed; each entry is chained to the previous one by a hash. The auditor can search and export the log and run an integrity check on the log and the stored documents.',
    },
  },
  {
    id: 'assistant',
    link: '/assistent',
    keywords: 'assistent ai kunstmatige intelligentie chatbot wat kan je hulp samenvatten voorstel privacy assistant artificial intelligence what can you do summarise',
    nl: {
      title: 'Wat de assistent kan',
      body: 'De assistent draait op de eigen server: er gaan geen gegevens naar buiten en het kost niets. Hij kan velden voorstellen bij registratie, termijnen herkennen, een afdeling voorstellen, mogelijke dubbele stukken vinden, zaken samenvatten, een conceptantwoord maken, risico op termijnoverschrijding tonen, actiepunten uit notulen halen en vragen over uw werk beantwoorden. Hij ziet alleen wat u mag zien en doet niets zonder uw bevestiging.',
    },
    en: {
      title: 'What the assistant can do',
      body: 'The assistant runs on the ministry’s own server: no data leaves it and it costs nothing. It can propose fields at registration, recognise deadlines, suggest a department, find possible duplicates, summarise matters, draft a reply, show deadline risk, turn meeting notes into actions and answer questions about your work. It sees only what you may see and does nothing without your confirmation.',
    },
  },
  {
    id: 'meeting-notes',
    link: '/assistent?tab=notulen',
    keywords: 'notulen vergadering actiepunten verslag meeting notes minutes action items',
    nl: {
      title: 'Actiepunten uit notulen',
      body: 'Plak de notulen van een vergadering in Assistent → Notulen. De assistent stelt per actiepunt een taak voor met uitvoerder en termijn. U controleert de voorstellen en maakt alleen de taken aan die u aanvinkt.',
    },
    en: {
      title: 'Action items from meeting notes',
      body: 'Paste meeting notes into Assistant → Meeting notes. The assistant proposes a task per action item with an assignee and due date. You check the proposals and only the ones you tick are created.',
    },
  },
  {
    id: 'mobile',
    link: '/',
    keywords: 'telefoon mobiel app installeren tablet onderweg phone mobile install app tablet',
    nl: {
      title: 'Gebruik op telefoon of tablet',
      body: 'Open het systeem in de browser van uw telefoon en kies Toevoegen aan beginscherm. Het werkt dan als een app: u ziet Mijn werk, kunt goedkeuren, meldingen ontvangen en met de camera een brief vastleggen.',
    },
    en: {
      title: 'Use on a phone or tablet',
      body: 'Open the system in your phone’s browser and choose Add to home screen. It then works like an app: you see My work, can approve, receive notifications and capture a letter with the camera.',
    },
  },
  {
    id: 'settings',
    link: '/beheer',
    keywords: 'beheer instellingen huisstijl logo kleuren feestdagen sjablonen gebruikers rollen admin settings branding holidays templates users roles',
    nl: {
      title: 'Beheer en instellingen',
      body: 'De beheerder stelt onder Beheer de huisstijl, nummering, termijnen, feestdagen, sjablonen, goedkeuringsroutes, gebruikers en rollen, de koppelingen en de assistent in. Beheerrechten geven nooit toegang tot de inhoud van stukken.',
    },
    en: {
      title: 'Administration and settings',
      body: 'Under Administration the administrator sets branding, numbering, deadlines, holidays, templates, approval routes, users and roles, integrations and the assistant. Administration rights never give access to record content.',
    },
  },
  {
    id: 'holidays',
    link: '/beheer?tab=feestdagen',
    keywords: 'feestdag feestdagen werkdagen kalender suriname divali phagwah holiday working days calendar',
    nl: {
      title: 'Werkdagen en feestdagen',
      body: 'Termijnen worden in werkdagen geteld: maandag tot en met vrijdag, zonder de Surinaamse feestdagen. De beheerder laadt de feestdagen per jaar en bevestigt de wisselende data zoals Holi Phagwah, Ied-ul-Fitr en Divali.',
    },
    en: {
      title: 'Working days and holidays',
      body: 'Deadlines are counted in working days: Monday to Friday, without Surinamese public holidays. The administrator loads the holidays each year and confirms moveable dates such as Holi Phagwah, Eid al-Fitr and Divali.',
    },
  },
];

let index: { idf: Map<string, number>; vectors: Map<string, number>[] } | null = null;

function text(a: HelpArticle): string {
  return `${a.nl.title} ${a.nl.title} ${a.en.title} ${a.keywords} ${a.keywords} ${a.nl.body} ${a.en.body}`;
}

export function searchHelp(question: string, max = 3): { article: HelpArticle; score: number }[] {
  if (!index) {
    const docs = HELP.map(text);
    const idf = idfOf(docs, true);
    index = { idf, vectors: docs.map((d) => vector(d, idf, true)) };
  }
  const q = vector(question, index.idf, true);
  return HELP.map((article, i) => ({ article, score: Math.round(cosine(q, index!.vectors[i]) * 1000) / 1000 }))
    .filter((x) => x.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}
