import PDFDocument from 'pdfkit';
import { join } from 'path';
import QRCode from 'qrcode';

/**
 * PDF building blocks shared by letters, labels, the timeline export, reports
 * and archive packages. The fonts are bundled with the server (Liberation Sans,
 * SIL Open Font License) so every character a Dutch letter needs is rendered
 * the same on every server, and no font is fetched from anywhere.
 */
const FONT_DIR = join(__dirname, '..', '..', 'assets', 'fonts');

export type Pdf = InstanceType<typeof PDFDocument>;

export interface Branding {
  organisationName: string;
  productName: string;
  primaryColor: string;
  accentColor: string;
  logoDataUrl: string | null;
  letterheadLines: string[];
  signatoryTitle: string;
}

export function newPdf(options: { size?: string | [number, number]; margin?: number; title?: string; info?: Record<string, string> } = {}): Pdf {
  const doc = new PDFDocument({
    size: (options.size as string) ?? 'A4',
    margin: options.margin ?? 56,
    bufferPages: true,
    info: { Title: options.title ?? 'Document', Producer: 'JusPol EDRMS', ...(options.info ?? {}) },
  });
  doc.registerFont('Body', join(FONT_DIR, 'LiberationSans-Regular.ttf'));
  doc.registerFont('Bold', join(FONT_DIR, 'LiberationSans-Bold.ttf'));
  doc.registerFont('Italic', join(FONT_DIR, 'LiberationSans-Italic.ttf'));
  doc.font('Body');
  return doc;
}

export function pdfBuffer(doc: Pdf): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

export async function qrPng(text: string, width = 240): Promise<Buffer> {
  return QRCode.toBuffer(text, { type: 'png', margin: 1, width, errorCorrectionLevel: 'M' });
}

export async function qrDataUrl(text: string, width = 240): Promise<string> {
  return QRCode.toDataURL(text, { margin: 1, width, errorCorrectionLevel: 'M' });
}

function logoBuffer(branding: Branding): Buffer | null {
  if (!branding.logoDataUrl) return null;
  const match = /^data:image\/(png|jpeg);base64,(.+)$/.exec(branding.logoDataUrl);
  return match ? Buffer.from(match[2], 'base64') : null;
}

/** The ministry letterhead: logo or emblem, name lines, a rule in the house colour. */
export function letterhead(doc: Pdf, branding: Branding): void {
  const left = doc.page.margins.left;
  const top = 40;
  const logo = logoBuffer(branding);
  if (logo) {
    doc.image(logo, left, top, { fit: [64, 64] });
  } else {
    doc.save();
    doc.roundedRect(left, top, 56, 56, 8).fill(branding.primaryColor);
    doc.fillColor('#ffffff').font('Bold').fontSize(18).text(initials(branding.organisationName), left, top + 18, { width: 56, align: 'center' });
    doc.restore();
  }
  doc.fillColor('#111827').font('Bold').fontSize(13).text(branding.letterheadLines[0] ?? branding.organisationName, left + 76, top + 6);
  doc.font('Body').fontSize(9.5).fillColor('#4b5563');
  for (const line of branding.letterheadLines.slice(1)) doc.text(line, left + 76);
  doc.moveTo(left, top + 76).lineTo(doc.page.width - doc.page.margins.right, top + 76).lineWidth(2).strokeColor(branding.accentColor).stroke();
  doc.fillColor('#111827').font('Body').fontSize(11);
  doc.y = top + 96;
  doc.x = left;
}

export function footer(doc: Pdf, text: string): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const bottom = doc.page.height - 36;
    doc.font('Body').fontSize(8).fillColor('#6b7280');
    doc.text(`${text}   ·   ${i + 1} / ${range.count}`, doc.page.margins.left, bottom, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      align: 'center',
      lineBreak: false,
    });
  }
}

export function initials(name: string): string {
  const words = name.split(/\s+/).filter((w) => /^[A-Z]/.test(w));
  return (words.slice(0, 3).map((w) => w[0]).join('') || 'MJP').toUpperCase();
}

/** A simple table: header row in the house colour, zebra rows, wraps across pages. */
export function table(doc: Pdf, columns: { label: string; width: number }[], rows: string[][], color: string): void {
  const left = doc.page.margins.left;
  const draw = (cells: string[], header: boolean, shade: boolean) => {
    const heights = cells.map((c, i) => doc.font(header ? 'Bold' : 'Body').fontSize(9).heightOfString(c, { width: columns[i].width - 8 }));
    const h = Math.max(...heights) + 8;
    if (doc.y + h > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage();
    }
    const y = doc.y;
    if (header) doc.rect(left, y, columns.reduce((a, c) => a + c.width, 0), h).fill(color);
    else if (shade) doc.rect(left, y, columns.reduce((a, c) => a + c.width, 0), h).fill('#f3f4f6');
    let x = left;
    cells.forEach((c, i) => {
      doc.fillColor(header ? '#ffffff' : '#111827').font(header ? 'Bold' : 'Body').fontSize(9).text(c, x + 4, y + 4, { width: columns[i].width - 8 });
      x += columns[i].width;
    });
    doc.y = y + h;
    doc.x = left;
  };
  draw(columns.map((c) => c.label), true, false);
  rows.forEach((r, i) => draw(r, false, i % 2 === 1));
  doc.moveDown(0.5);
}
