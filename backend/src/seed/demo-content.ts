/**
 * The content of the demonstration and training environment: invented letters
 * of the kind a Surinamese ministry receives, with invented senders' staff and
 * invented citizens. No real person's matter is described.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { newPdf, pdfBuffer } from '../core/pdf';

export interface LetterSpec {
  key: string;
  daysAgo: number;
  clerk: string;
  from: string;
  fromLines?: string[];
  place?: string;
  kenmerk?: string;
  subject: string;
  body: string[];
  signer: string;
  signerTitle?: string;
  classification?: 'OPEN' | 'INTERNAL' | 'CONFIDENTIAL' | 'SECRET';
  replyDays?: number;
  language?: 'nl' | 'en';
  scanned?: boolean;
  photo?: boolean;
  draft?: boolean;
  /** Registered without filling the fields, so the assistant's proposals show. */
  bare?: boolean;
}

const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function dateDaysAgo(n: number): string {
  const d = new Date(Date.now() - 3 * 3600_000);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** A ministry does not work at weekends: a day that falls on one moves back to the Friday before. */
export function workingDayBack(n: number): number {
  if (n <= 0) return n;
  let x = n;
  for (;;) {
    const w = new Date(`${dateDaysAgo(x)}T12:00:00Z`).getUTCDay();
    if (w !== 0 && w !== 6) return x;
    x++;
  }
}

/** The date written on a letter that arrived n days ago: two working days earlier. */
export function letterDate(arrivedDaysAgo: number): string {
  return dateDaysAgo(workingDayBack(arrivedDaysAgo + 2));
}

function longDate(iso: string, en = false): string {
  const [y, m, d] = iso.split('-').map(Number);
  return en ? `${MONTHS_EN[m - 1]} ${d}, ${y}` : `${d} ${MONTHS[m - 1]} ${y}`;
}

export async function letterPdf(spec: LetterSpec): Promise<Buffer> {
  const en = spec.language === 'en';
  const dated = letterDate(spec.daysAgo);
  const doc = newPdf({ title: spec.subject });
  doc.font('Bold').fontSize(15).fillColor('#1f2937').text(spec.from);
  doc.font('Body').fontSize(9).fillColor('#4b5563');
  for (const l of spec.fromLines ?? []) doc.text(l);
  doc.moveDown(1.4);
  doc.fillColor('#111827').fontSize(10.5);
  doc.text(en ? 'To the Minister of Justice and Police' : 'Aan de Minister van Justitie en Politie');
  doc.text('Henck Arronstraat 3');
  doc.text('Paramaribo');
  doc.moveDown(1);
  doc.text(en ? `${spec.place ?? 'Paramaribo'}, ${longDate(dated, true)}` : `${spec.place ?? 'Paramaribo'}, ${longDate(dated)}`);
  if (spec.kenmerk) doc.text(en ? `Our reference: ${spec.kenmerk}` : `Ons kenmerk: ${spec.kenmerk}`);
  doc.font('Bold').text(en ? `Subject: ${spec.subject}` : `Onderwerp: ${spec.subject}`);
  doc.font('Body').moveDown(1);
  doc.text(en ? 'Dear Minister,' : 'Excellentie,');
  doc.moveDown(0.6);
  for (const p of spec.body) {
    doc.text(p, { align: 'left', lineGap: 2 });
    doc.moveDown(0.6);
  }
  doc.moveDown(0.6);
  doc.text(en ? 'Yours faithfully,' : 'Hoogachtend,');
  doc.moveDown(1.6);
  doc.font('Bold').text(spec.signer);
  doc.font('Body').text(spec.signerTitle ?? spec.from);
  return pdfBuffer(doc);
}

/** A letter as if it came off the scanner: an image of the page, no text layer. */
export function scanOf(pdf: Buffer, kind: 'pdf' | 'jpeg' | 'photo'): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  try {
    writeFileSync(join(dir, 'in.pdf'), pdf);
    if (kind === 'photo') {
      const photo = phonePhoto(dir);
      if (photo) return photo;
      kind = 'jpeg';
    }
    execFileSync('pdftoppm', ['-r', '150', '-gray', '-f', '1', '-l', '1', kind === 'jpeg' ? '-jpeg' : '-png', join(dir, 'in.pdf'), join(dir, 'page')]);
    return readFileSync(join(dir, kind === 'jpeg' ? 'page-1.jpg' : 'page-1.png'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The first page as a clerk's phone would photograph it on a desk: in colour,
 * slightly skewed, with a shadow, uneven light and sensor noise. Needs
 * ImageMagick; without it the caller falls back to a plain JPEG.
 */
function phonePhoto(dir: string): Buffer | null {
  try {
    execFileSync('pdftoppm', ['-r', '110', '-png', '-f', '1', '-l', '1', join(dir, 'in.pdf'), join(dir, 'page')]);
    const page = join(dir, 'page-1.png');
    const [w, h] = execFileSync('identify', ['-format', '%w %h', page]).toString().trim().split(' ').map(Number);
    const out = join(dir, 'photo.jpg');
    execFileSync('convert', [
      page, '-fill', '#efe9dc', '-colorize', '7%',
      '(', '+clone', '-background', '#000', '-shadow', '55x14+14+18', ')', '+swap', '-background', 'none', '-layers', 'merge', '+repage',
      '-bordercolor', 'none', '-border', '70', '-background', '#5b4636', '-flatten',
      '-virtual-pixel', 'background', '-background', '#5b4636',
      '-distort', 'Perspective', `0,0 40,30  ${w + 139},0 ${w + 100},12  0,${h + 139} 18,${h + 120}  ${w + 139},${h + 139} ${w + 125},${h + 139}`,
      '-gravity', 'center', '-crop', '94%x95%+0+0', '+repage',
      '(', '+clone', '-fill', '#ffffff', '-colorize', '100', '-background', '#6a6a6a', '-vignette', '0x260+0+0', ')', '-compose', 'multiply', '-composite',
      '-blur', '0x0.5', '-attenuate', '0.3', '+noise', 'Gaussian', '-resize', '85%', '-quality', '78', out,
    ]);
    return readFileSync(out);
  } catch {
    return null;
  }
}

/** A screenshot of a sound-meter app, as a citizen attaches it to a noise complaint. Needs ImageMagick. */
export function soundMeterPng(when: string): Buffer | null {
  const dir = mkdtempSync(join(tmpdir(), 'meter-'));
  try {
    const out = join(dir, 'meter.png');
    execFileSync('convert', [
      '-size', '720x1280', 'gradient:#10151f-#1b2433',
      '-font', 'DejaVu-Sans', '-fill', '#9fb3c8', '-pointsize', '34', '-gravity', 'north', '-annotate', '+0+90', 'Geluidsmeter',
      '-fill', '#ffffff', '-pointsize', '170', '-font', 'DejaVu-Sans-Bold', '-annotate', '+0+260', '92',
      '-fill', '#9fb3c8', '-pointsize', '46', '-font', 'DejaVu-Sans', '-annotate', '+0+470', 'dB(A)',
      '-fill', '#e5a50a', '-pointsize', '34', '-annotate', '+0+560', 'Zeer luid',
      '-stroke', '#3d8bfd', '-strokewidth', '6', '-fill', 'none',
      '-draw', 'polyline 60,860 100,820 140,900 180,780 220,840 260,760 300,880 340,800 380,830 420,740 460,870 500,790 540,850 580,770 620,860 660,810',
      '-stroke', 'none', '-fill', '#9fb3c8', '-pointsize', '28', '-annotate', '+0+990', 'Gem. 87 dB   Max. 96 dB   Duur 14 min',
      '-fill', '#cbd5e1', '-pointsize', '30', '-annotate', '+0+1080', 'Paramaribo-Noord', '-annotate', '+0+1125', when,
      '-depth', '8', out,
    ]);
    return readFileSync(out);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function imagePdf(png: Buffer): Promise<Buffer> {
  const doc = newPdf({ margin: 0 });
  doc.image(png, 0, 0, { width: doc.page.width });
  return pdfBuffer(doc);
}

const ADV = 'Advocatenkantoor Brahim & Partners';
const ADV_LINES = ['Keizerstraat 112, Paramaribo', 'Tel. 597-470 112 · info@brahim-advocaten.example'];
const KPS = 'Korps Politie Suriname';
const KPS_LINES = ['Hoofdbureau van Politie, Van \'t Hogerhuysstraat', 'Paramaribo'];
const OM = 'Openbaar Ministerie';
const OM_LINES = ['Parket Procureur-Generaal', 'Gravenstraat 1, Paramaribo'];
const FIN = 'Ministerie van Financiën en Planning';
const DNA = 'De Nationale Assemblée';
const BIZA = 'Ministerie van Binnenlandse Zaken';
const SB = 'Penitentiaire Inrichting Santo Boma';
const GY_EMB = 'Embassy of the Co-operative Republic of Guyana';
const SSS = 'Stichting Slachtofferhulp Suriname';
const HVJ = 'Hof van Justitie';
const BRH = 'Bureau voor Rechtshulp';

/** Incoming letters, oldest first. `clerk` registers it; the key links it to its matter. */
export const LETTERS: LetterSpec[] = [
  { key: 'invite-old', daysAgo: 296, clerk: 'assistant1@juspol.test', from: KPS, fromLines: KPS_LINES, kenmerk: 'KPS/PR/2025-044', subject: 'Uitnodiging opening politiepost Lelydorp', body: ['Het Korps Politie Suriname heeft de eer u uit te nodigen voor de officiële opening van de nieuwe politiepost te Lelydorp.', 'Wij verzoeken u uw aanwezigheid binnen 10 werkdagen te bevestigen.'], signer: 'R. Tjon Kie Sim', signerTitle: 'Korpschef a.i.' },
  { key: 'appointment', daysAgo: 270, clerk: 'assistant2@juspol.test', from: 'Commissie van Toezicht Penitentiaire Inrichtingen', fromLines: ['p/a Ministerie van Justitie en Politie'], kenmerk: 'CvT/2025-12', subject: 'Voordracht benoeming lid Commissie van Toezicht', body: ['De Commissie van Toezicht draagt mevrouw drs. A. Soekhoe voor als nieuw lid van de commissie, ter vervanging van het aftredende lid.', 'Wij verzoeken u de benoeming in overweging te nemen.'], signer: 'mr. H. Fernandes', signerTitle: 'Voorzitter' },
  { key: 'lawsuit', daysAgo: 190, clerk: 'assistant2@juspol.test', from: HVJ, fromLines: ['Griffie', 'Gravenstraat 2, Paramaribo'], kenmerk: 'AR 25-1182', subject: 'Oproeping in de civiele procedure Bouwbedrijf Santo N.V. tegen de Staat Suriname', body: ['Hierbij wordt de Staat Suriname, vertegenwoordigd door de Minister van Justitie en Politie, opgeroepen te verschijnen in de procedure inzake de aanbesteding van de uitbreiding van het justitiecomplex.', 'De zitting staat gepland binnen dertig dagen na dagtekening van deze oproeping.'], signer: 'mr. C. Pinas-Lie', signerTitle: 'Griffier' },
  { key: 'gen-1', daysAgo: 170, clerk: 'assistant1@juspol.test', from: OM, fromLines: OM_LINES, kenmerk: 'PG/2025/3301', subject: 'Halfjaaroverzicht strafzaken, tweede helft 2025', body: ['Hierbij bieden wij u het overzicht aan van de afgedane strafzaken in de tweede helft van 2025.', 'Het overzicht is bestemd voor de beleidsvoorbereiding.'], signer: 'mr. R. Baarh', signerTitle: 'Procureur-Generaal' },
  { key: 'gen-2', daysAgo: 160, clerk: 'assistant1@juspol.test', from: BIZA, kenmerk: 'BZ/CBB/25-889', subject: 'Verzoek gegevens personeelsbestand voor de jaarlijkse telling', body: ['Ten behoeve van de jaarlijkse telling van het overheidspersoneel verzoeken wij u de gegevens van het personeelsbestand aan te leveren.', 'Wij verzoeken u de gegevens uiterlijk binnen 20 werkdagen aan te leveren.'], signer: 'drs. M. Ooft', signerTitle: 'Directeur Personeelsbeleid' },
  { key: 'gen-3', daysAgo: 150, clerk: 'assistant2@juspol.test', from: SSS, fromLines: ['Wanicastraat 51, Paramaribo'], kenmerk: 'SSS-25-071', subject: 'Aanvraag subsidie voor het programma slachtofferondersteuning', body: ['Stichting Slachtofferhulp Suriname verzoekt om een bijdrage voor de voortzetting van het programma voor de ondersteuning van slachtoffers van huiselijk geweld.', 'Een begroting is bijgevoegd.'], signer: 'mevr. J. Kasanpawiro', signerTitle: 'Voorzitter' },
  { key: 'gen-4', daysAgo: 140, clerk: 'assistant1@juspol.test', from: KPS, fromLines: KPS_LINES, kenmerk: 'KPS/LOG/2025-301', subject: 'Aanvraag vervanging dienstvoertuigen district Nickerie', body: ['De dienstvoertuigen van het district Nickerie zijn aan vervanging toe. Wij verzoeken om goedkeuring van de aanschaf van vier voertuigen.', 'Een offerte is bijgevoegd.'], signer: 'R. Tjon Kie Sim', signerTitle: 'Korpschef a.i.' },
  { key: 'gen-5', daysAgo: 128, clerk: 'assistant2@juspol.test', from: BRH, fromLines: ['Mr. Dr. J.C. de Mirandastraat 10, Paramaribo'], kenmerk: 'BRH/2025/210', subject: 'Kwartaalrapportage toevoegingen rechtsbijstand', body: ['Hierbij treft u de kwartaalrapportage aan van de verleende toevoegingen in strafzaken en civiele zaken.'], signer: 'mr. S. Bhagwandin', signerTitle: 'Hoofd Bureau voor Rechtshulp' },
  { key: 'gen-6', daysAgo: 115, clerk: 'assistant1@juspol.test', from: 'Ambassade van de Verenigde Staten van Amerika', fromLines: ['Kristalstraat 165, Paramaribo'], kenmerk: 'PAR-2025-0912', subject: 'Uitnodiging regionale conferentie bestrijding mensenhandel', body: ['De Ambassade nodigt een delegatie van het ministerie uit voor de regionale conferentie over de bestrijding van mensenhandel in Georgetown.', 'Wij vernemen graag binnen 14 dagen de samenstelling van de delegatie.'], signer: 'J. Morrison', signerTitle: 'Political Officer' },
  { key: 'gen-7', daysAgo: 104, clerk: 'assistant2@juspol.test', from: OM, fromLines: OM_LINES, kenmerk: 'PG/2025/3907', subject: 'Advies wijziging Wetboek van Strafvordering, digitale opsporing', body: ['Op uw verzoek bieden wij u ons advies aan over het voorontwerp tot wijziging van het Wetboek van Strafvordering inzake digitale opsporing.'], signer: 'mr. R. Baarh', signerTitle: 'Procureur-Generaal' },
  { key: 'gen-8', daysAgo: 92, clerk: 'assistant1@juspol.test', from: 'Bureau Forensische Zaken', fromLines: ['Kernkampweg 1, Paramaribo'], kenmerk: 'BFZ/25/118', subject: 'Verzoek uitbreiding laboratoriumcapaciteit DNA-onderzoek', body: ['Door de toename van het aantal zaken is de capaciteit van het DNA-laboratorium ontoereikend. Wij verzoeken om uitbreiding met twee analisten.'], signer: 'dr. P. Mungra', signerTitle: 'Directeur' },
  { key: 'gen-9', daysAgo: 80, clerk: 'assistant2@juspol.test', from: KPS, fromLines: KPS_LINES, kenmerk: 'KPS/OO/2025-512', subject: 'Rapportage openbare orde jaarwisseling, voorbereiding', body: ['In het kader van de voorbereiding op de jaarwisseling bieden wij u het operationeel plan aan.', 'Wij verzoeken u uiterlijk 1 december uw opmerkingen kenbaar te maken.'], signer: 'R. Tjon Kie Sim', signerTitle: 'Korpschef a.i.' },
  { key: 'pardon', daysAgo: 66, clerk: 'assistant2@juspol.test', from: ADV, fromLines: ADV_LINES, kenmerk: 'BP/2026/0412', subject: 'Gratieverzoek ten behoeve van de heer J. Pinas', body: ['Namens onze cliënt, de heer J. Pinas, thans verblijvend in de Penitentiaire Inrichting Santo Boma, verzoeken wij u gratie te verlenen voor het resterende deel van de opgelegde gevangenisstraf.', 'Cliënt heeft twee derde van zijn straf uitgezeten, heeft zich voorbeeldig gedragen en heeft een vaste baan in het vooruitzicht. Een verklaring van de werkgever en een gedragsrapport zijn bijgevoegd.', 'Wij verzoeken u binnen 30 dagen een beslissing te nemen.'], signer: 'mr. D. Brahim', signerTitle: 'Advocaat' },
  { key: 'pardon-dup', daysAgo: 64, clerk: 'assistant1@juspol.test', from: ADV, fromLines: ADV_LINES, kenmerk: 'BP/2026/0412', subject: 'Gratieverzoek de heer J. Pinas (per e-mail)', body: ['Namens onze cliënt, de heer J. Pinas, verzoeken wij u gratie te verlenen voor het resterende deel van de opgelegde gevangenisstraf.', 'Deze brief werd eerder per post verzonden.'], signer: 'mr. D. Brahim', signerTitle: 'Advocaat', draft: true },
  { key: 'mla', daysAgo: 58, clerk: 'assistant1@juspol.test', from: GY_EMB, fromLines: ['Paramaribo'], place: 'Paramaribo', kenmerk: 'GY/PBO/2026-17', subject: 'Request for mutual legal assistance in a fraud investigation', language: 'en', classification: 'CONFIDENTIAL', body: ['On behalf of the Director of Public Prosecutions of Guyana, we kindly request your assistance in obtaining bank records and witness statements in an ongoing fraud investigation.', 'The request is made under the bilateral treaty on mutual legal assistance in criminal matters.', 'We would appreciate a reply within 30 days.'], signer: 'S. Persaud', signerTitle: 'First Secretary' },
  { key: 'bill', daysAgo: 52, clerk: 'assistant2@juspol.test', from: DNA, fromLines: ['Onafhankelijkheidsplein 10, Paramaribo'], kenmerk: 'DNA/CJ/2026-033', subject: 'Commentaar Vaste Commissie op het ontwerp Wet Slachtofferhulp', body: ['De Vaste Commissie voor Justitie en Politie heeft het ontwerp van de Wet Slachtofferhulp besproken en biedt u haar commentaar aan.', 'De commissie verzoekt u binnen 15 werkdagen schriftelijk te reageren op de gestelde vragen, zodat de openbare behandeling kan worden voorbereid.'], signer: 'mevr. drs. R. Bhola', signerTitle: 'Voorzitter Vaste Commissie' },
  { key: 'budget', daysAgo: 45, clerk: 'assistant1@juspol.test', from: FIN, fromLines: ['Tamarindelaan 3, Paramaribo'], kenmerk: 'FIN/BB/2026-140', subject: 'Instructie opstellen begroting 2027', body: ['Hierbij ontvangt u de instructie voor het opstellen van de begroting voor het dienstjaar 2027.', 'De ontwerpbegroting dient uiterlijk 30 november 2026 te worden ingediend.'], signer: 'drs. A. Raghoebarsing', signerTitle: 'Directeur Financiën' },
  { key: 'residence', daysAgo: 40, clerk: 'assistant2@juspol.test', from: ADV, fromLines: ADV_LINES, kenmerk: 'BP/2026/0533', subject: 'Aanvraag verblijfsvergunning familie Mohan', body: ['Namens de familie Mohan verzoeken wij om verlening van een verblijfsvergunning voor bepaalde tijd, in verband met werk en gezinshereniging.', 'De vereiste stukken, waaronder de arbeidsovereenkomst en de geboorteakten, zijn bijgevoegd.'], signer: 'mr. D. Brahim', signerTitle: 'Advocaat' },
  { key: 'inspection', daysAgo: 34, clerk: 'assistant2@juspol.test', from: 'Inspectie Justitiële Inrichtingen', fromLines: ['p/a Ministerie van Justitie en Politie'], kenmerk: 'IJI/2026/07', subject: 'Inspectierapport Penitentiaire Inrichting Santo Boma, derde kwartaal', classification: 'CONFIDENTIAL', body: ['Hierbij bieden wij u het vertrouwelijke inspectierapport aan over de situatie in de Penitentiaire Inrichting Santo Boma.', 'De inspectie constateert ernstige overbevolking in twee afdelingen en een tekort aan medische zorg.', 'Wij verzoeken u binnen 20 werkdagen aan te geven welke maatregelen worden genomen.'], signer: 'mr. W. Amafo', signerTitle: 'Hoofdinspecteur' },
  { key: 'questions', daysAgo: 21, clerk: 'assistant1@juspol.test', from: DNA, fromLines: ['Onafhankelijkheidsplein 10, Paramaribo'], kenmerk: 'DNA/SV/2026-118', subject: 'Schriftelijke vragen over de overbevolking in de justitiële inrichtingen', body: ['Ingevolge het Reglement van Orde stellen de leden Sewdien en Tjong schriftelijke vragen over de overbevolking in de justitiële inrichtingen.', 'De vragen dienen binnen 10 werkdagen te worden beantwoord.'], signer: 'mevr. M. Wijdenbosch', signerTitle: 'Griffier' },
  { key: 'transfer', daysAgo: 16, clerk: 'assistant2@juspol.test', from: 'Familie Pinas', fromLines: ['Tourtonnelaan 44, Paramaribo'], subject: 'Verzoek overplaatsing gedetineerde R. Pinas naar Penitentiaire Inrichting Santo Boma', body: ['Mijn broer, de heer R. Pinas, verblijft in het Huis van Bewaring te Nickerie. Ik verzoek om zijn overplaatsing naar de Penitentiaire Inrichting Santo Boma, dichter bij zijn familie.', 'Onze moeder is op leeftijd en kan de reis naar Nickerie niet meer maken.'], signer: 'mevr. S. Pinas' },
  { key: 'inzage', daysAgo: 12, clerk: 'assistant1@juspol.test', from: KPS, fromLines: KPS_LINES, kenmerk: 'KPS/JZ/2026-118', subject: 'Verzoek om inzage in het strafdossier van de heer R. Pinas', body: ['Hierbij verzoeken wij u vriendelijk om inzage in het strafdossier van de heer R. Pinas in verband met een lopend onderzoek.', 'Wij verzoeken u binnen 10 werkdagen te reageren.'], signer: 'insp. K. Djoemadi', signerTitle: 'Hoofd Juridische Zaken' },
  { key: 'staff', daysAgo: 10, clerk: 'assistant2@juspol.test', from: 'M. Kartoredjo', fromLines: ['Indira Gandhiweg 210, Wanica'], subject: 'Sollicitatie naar de functie van beleidsmedewerker Juridische Zaken', body: ['Naar aanleiding van de vacature solliciteer ik naar de functie van beleidsmedewerker bij de afdeling Juridische Zaken.', 'Mijn curriculum vitae en diploma’s zijn bijgevoegd.'], signer: 'mr. M. Kartoredjo' },
  { key: 'scan', daysAgo: 7, clerk: 'assistant1@juspol.test', from: SB, fromLines: ['Santo Boma, Wanica'], kenmerk: 'PISB/2026/223', subject: 'Melding tekort aan medicijnen in de inrichting', scanned: true, body: ['Hierbij melden wij dat de voorraad van een aantal noodzakelijke medicijnen in de inrichting onvoldoende is.', 'Wij verzoeken u binnen 5 werkdagen maatregelen te treffen.'], signer: 'R. Sabajo', signerTitle: 'Directeur van de inrichting' },
  { key: 'firearms', daysAgo: 5, clerk: 'assistant2@juspol.test', from: 'Schietvereniging Wanica', fromLines: ['Lelydorp, Wanica'], subject: 'Aanvraag vergunning voor het houden van een schietwedstrijd', body: ['Onze vereniging verzoekt om toestemming voor het houden van een nationale schietwedstrijd.', 'Wij ontvangen graag vóór vrijdag uw reactie in verband met de voorbereidingen.'], signer: 'E. Rozenblad', signerTitle: 'Secretaris' },
  { key: 'photo', daysAgo: 2, clerk: 'assistant1@juspol.test', from: 'Stichting Rechtshulp Wanica', fromLines: ['Lelydorp'], kenmerk: 'SRW/26/014', subject: 'Verzoek om voorlichting over het nieuwe beklagrecht van gedetineerden', photo: true, body: ['Wij verzoeken u om voorlichting over het nieuwe beklagrecht van gedetineerden aan onze vrijwilligers.', 'Graag ontvangen wij binnen twee weken een voorstel voor een datum.'], signer: 'mevr. L. Wongsonadi', signerTitle: 'Coördinator' },
  { key: 'new-1', daysAgo: 1, clerk: 'assistant1@juspol.test', from: OM, fromLines: OM_LINES, kenmerk: 'PG/2026/5120', subject: 'Verzoek uitlevering van een verdachte aan de Republiek Guyana', classification: 'CONFIDENTIAL', body: ['De autoriteiten van de Republiek Guyana hebben verzocht om de uitlevering van een verdachte van gewapende overvallen.', 'Wij verzoeken u binnen 10 werkdagen te beslissen of de procedure wordt voortgezet.'], signer: 'mr. R. Baarh', signerTitle: 'Procureur-Generaal', draft: true, bare: true },
  { key: 'new-2', daysAgo: 0, clerk: 'assistant2@juspol.test', from: KPS, fromLines: KPS_LINES, kenmerk: 'KPS/VK/2026-077', subject: 'Verzoek om extra middelen voor verkeerscontroles tijdens de feestdagen', body: ['Met het oog op de feestdagen verzoeken wij om extra middelen voor verkeerscontroles op de Oost-Westverbinding.', 'Wij verzoeken u uiterlijk 15 november 2026 te beslissen.'], signer: 'R. Tjon Kie Sim', signerTitle: 'Korpschef a.i.', draft: true, bare: true },
];

/** More letters to give the trends and the registry a realistic volume. */
const FILLER_SENDERS: [string, string][] = [
  [KPS, 'Rapportage districtscommando'],
  [OM, 'Overzicht seponeringen'],
  [BIZA, 'Circulaire personeelsbeleid'],
  [SSS, 'Voortgangsrapport programma'],
  [BRH, 'Rapportage spreekuren'],
  ['Ministerie van Buitenlandse Zaken', 'Doorgeleiding verzoek ambassade'],
  ['Kantongerecht Eerste Kanton', 'Afschrift beschikking'],
  ['Centraal Bureau voor Burgerzaken', 'Verzoek verificatie gegevens'],
  ['Militaire Politie', 'Rapportage grensbewaking'],
  ['Ministerie van Volksgezondheid', 'Afstemming medische zorg gedetineerden'],
];

export function fillerLetters(): LetterSpec[] {
  const out: LetterSpec[] = [];
  let n = 0;
  for (let days = 178; days >= 3; days -= 6) {
    const [from, topic] = FILLER_SENDERS[n % FILLER_SENDERS.length];
    n += 1;
    const month = MONTHS[new Date(Date.now() - days * 86400000).getUTCMonth()];
    out.push({
      key: `filler-${n}`,
      daysAgo: days,
      clerk: n % 2 ? 'assistant1@juspol.test' : 'assistant2@juspol.test',
      from,
      kenmerk: `${from.split(' ').map((w) => w[0]).join('').toUpperCase()}/2026/${100 + n}`,
      subject: `${topic} ${month}`,
      body: [`Hierbij ontvangt u ter informatie: ${topic.toLowerCase()} over de maand ${month}.`],
      signer: 'Namens de directie',
    });
  }
  return out;
}
