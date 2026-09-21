import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { OcrConfig } from '../config/ocr-config';

const run = promisify(execFile);

export interface TextResult {
  text: string;
  engine: string;
}

/**
 * Runs the configured OCR command over a copy of the bytes.
 *
 * Three things matter here. The engine is given a temporary copy, never the
 * stored file, so a misbehaving engine cannot touch captured evidence. The
 * arguments are passed as an argument list, not a shell string, so a filename
 * cannot become a command. And the call is time-boxed: an engine that hangs
 * must not hold a capture open.
 *
 * The command interface is tesseract's: <input> <output base> -l <languages>,
 * writing <output base>.txt. A different engine can be put behind the same
 * interface with a two-line wrapper script.
 */
export async function extractText(bytes: Buffer, config: OcrConfig): Promise<TextResult> {
  const workspace = await mkdtemp(join(tmpdir(), 'juspol-ocr-'));
  const input = join(workspace, 'input');
  const outputBase = join(workspace, 'output');
  try {
    await writeFile(input, bytes);
    await run(config.command, [input, outputBase, '-l', config.languages], {
      timeout: config.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    const text = await readFile(`${outputBase}.txt`, 'utf8');
    return {
      text: text.slice(0, config.maxCharacters).trim(),
      engine: `${config.command} (${config.languages})`,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/**
 * Reads the text layer of a PDF with the configured reader.
 *
 * This is extraction, not recognition: the words come out of the file exactly
 * as they were put in. A PDF that is only a scanned page carries no text layer
 * and yields nothing, which is reported as read-and-empty rather than as a
 * failure — nothing went wrong, there was simply nothing to read.
 *
 * The command interface is pdftotext's: <input> <output file>. The same
 * sandboxing as above: a temporary copy, an argument list, a time limit.
 */
export async function extractPdfText(bytes: Buffer, config: OcrConfig): Promise<TextResult> {
  const workspace = await mkdtemp(join(tmpdir(), 'juspol-pdftext-'));
  const input = join(workspace, 'input.pdf');
  const output = join(workspace, 'output.txt');
  try {
    await writeFile(input, bytes);
    await run(config.pdfCommand, [input, output], {
      timeout: config.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    const text = await readFile(output, 'utf8');
    return { text: text.slice(0, config.maxCharacters).trim(), engine: config.pdfCommand };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
