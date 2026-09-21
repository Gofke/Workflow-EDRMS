/**
 * OCR parameters (FR-COR-015, CONDITIONAL — "where OCR is enabled").
 *
 * Off by default. The requirement is conditional in the FS itself, and OCR
 * needs an engine installed on the server, which is an operational decision the
 * Ministry and whoever runs the pilot must take together.
 *
 * The commands are configurable so the build does not hard-code one engine, and
 * so the tests can drive a stub instead of requiring a real engine to be
 * installed wherever the suite runs.
 *
 * Two readers, because they are two different jobs. An image is read by OCR. A
 * PDF that carries a text layer is read straight out of the file, which is
 * exact rather than guessed. A PDF that is only a scanned page has no text
 * layer, and reads as empty until page-image OCR is built.
 */
export interface OcrConfig {
  enabled: boolean;
  command: string;
  languages: string;
  timeoutMs: number;
  /** Image types the OCR engine is asked to read. Others are skipped. */
  mediaTypes: string[];
  /** The text-layer reader for PDFs, and the types it is given. */
  pdfCommand: string;
  pdfMediaTypes: string[];
  maxCharacters: number;
}

const DEFAULT_TYPES = ['image/jpeg', 'image/png', 'image/tiff'];
const DEFAULT_PDF_TYPES = ['application/pdf'];

export function loadOcrConfig(): OcrConfig {
  return {
    enabled: process.env.OCR_ENABLED === 'true',
    command: process.env.OCR_COMMAND ?? 'tesseract',
    languages: process.env.OCR_LANGUAGES ?? 'eng',
    timeoutMs: Number(process.env.OCR_TIMEOUT_MS ?? 30_000),
    mediaTypes: (process.env.OCR_MEDIA_TYPES ?? DEFAULT_TYPES.join(','))
      .split(',')
      .map((type) => type.trim())
      .filter(Boolean),
    pdfCommand: process.env.PDF_TEXT_COMMAND ?? 'pdftotext',
    pdfMediaTypes: (process.env.PDF_TEXT_MEDIA_TYPES ?? DEFAULT_PDF_TYPES.join(','))
      .split(',')
      .map((type) => type.trim())
      .filter(Boolean),
    maxCharacters: Number(process.env.OCR_MAX_CHARACTERS ?? 200_000),
  };
}
