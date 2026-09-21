/**
 * Document capture parameters.
 *
 * Accepted types and the size limit are operational settings, not baseline
 * decisions: FR-COR-014 requires scanned paper intake without prescribing
 * formats. The defaults cover a scanner and an office document.
 */
export interface DocumentConfig {
  storageRoot: string;
  maxBytes: number;
  allowedMediaTypes: string[];
}

const DEFAULT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

export function loadDocumentConfig(): DocumentConfig {
  return {
    storageRoot: process.env.DOCUMENT_STORAGE_PATH ?? './captured-documents',
    maxBytes: Number(process.env.DOCUMENT_MAX_BYTES ?? 20 * 1024 * 1024),
    allowedMediaTypes: (process.env.DOCUMENT_ALLOWED_TYPES ?? DEFAULT_TYPES.join(','))
      .split(',')
      .map((type) => type.trim())
      .filter(Boolean),
  };
}
