import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Content-addressed storage for captured documents.
 *
 * The bytes are written under their own SHA-256, so the stored file cannot be
 * confused with a filename the user supplied, and identical content is not
 * duplicated on disk. Nothing derives a business identity from either the name
 * or the path (BR-001).
 *
 * A database row and its bytes are separate things. The row is append-only; the
 * bytes are never rewritten after the first write, because a second capture of
 * different content has a different hash and therefore a different key.
 */
export class DocumentStorage {
  constructor(private readonly root: string) {}

  static hash(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  /** Returns the storage key. Writing the same content twice is a no-op. */
  async put(bytes: Buffer): Promise<{ storageKey: string; contentHash: string }> {
    const contentHash = DocumentStorage.hash(bytes);
    // Two-level fan-out so a directory does not accumulate thousands of files.
    const storageKey = join(contentHash.slice(0, 2), contentHash.slice(2, 4), contentHash);
    const target = join(this.root, storageKey);

    if (!existsSync(target)) {
      await mkdir(join(this.root, contentHash.slice(0, 2), contentHash.slice(2, 4)), {
        recursive: true,
      });
      await writeFile(target, bytes);
    }
    return { storageKey, contentHash };
  }

  /**
   * Reads the bytes and verifies them against the recorded hash.
   *
   * A mismatch means the stored content no longer matches what was captured.
   * The caller is given nothing: serving content that fails its own integrity
   * reference would present altered material as authoritative evidence.
   */
  async get(storageKey: string, expectedHash: string): Promise<Buffer> {
    const bytes = await readFile(join(this.root, storageKey));
    const actual = DocumentStorage.hash(bytes);
    if (actual !== expectedHash) {
      throw new IntegrityError(
        'The stored content no longer matches its integrity reference and will not be served.',
      );
    }
    return bytes;
  }
}

export class IntegrityError extends Error {}
