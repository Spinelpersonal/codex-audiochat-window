import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import type { Attachment } from '../shared/types';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_CHARS = 150_000;
const MAX_PREVIEW_BYTES = 256 * 1024;
const PREVIEW_CHARS = 600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPTURE_NAME = /^capture-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/i;
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.mdx', '.csv', '.tsv', '.json', '.jsonl', '.jsonc',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.html', '.htm',
  '.css', '.scss', '.sass', '.less', '.xml', '.svg', '.yaml', '.yml', '.toml',
  '.ini', '.cfg', '.conf', '.config', '.log', '.sql', '.py', '.pyi', '.rb', '.php',
  '.java', '.kt', '.kts', '.cs', '.fs', '.fsx', '.vb', '.c', '.h', '.cc', '.cpp',
  '.hpp', '.cxx', '.hxx', '.rs', '.go', '.swift', '.m', '.mm', '.r', '.R', '.lua',
  '.pl', '.pm', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.psd1',
  '.bat', '.cmd', '.vue', '.svelte', '.astro', '.graphql', '.gql', '.proto',
  '.tex', '.rst', '.diff', '.patch', '.properties', '.env', '.gitignore',
]);
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'cmakelists.txt', 'license', 'readme', '.env', '.gitignore', '.gitattributes', '.editorconfig']);
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};

interface Entry {
  attachment: Attachment;
  filePath: string;
  identity: string;
  temporary: boolean;
}
interface Candidate {
  filePath: string;
  name: string;
  kind: Attachment['kind'];
  identity: string;
  temporary: boolean;
}

function key(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}
function identity(stat: { dev: number; ino: number }): string {
  return `${stat.dev}:${stat.ino}`;
}
function kindOf(name: string): Attachment['kind'] {
  const extension = path.extname(name).toLowerCase();
  if (IMAGE_TYPES[extension]) return 'image';
  if (extension === '.pdf') return 'pdf';
  if (TEXT_EXTENSIONS.has(extension) || TEXT_NAMES.has(name.toLowerCase())) return 'text';
  throw new Error(`Unsupported file type: ${name}`);
}
function imageMime(data: Buffer): string | undefined {
  if (data.length >= 45 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && data.readUInt32BE(8) === 13 && data.toString('ascii', 12, 16) === 'IHDR'
      && data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0
      && data.toString('ascii', data.length - 8, data.length - 4) === 'IEND') return 'image/png';
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
      && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9) return 'image/jpeg';
  if (data.length >= 16 && data.toString('ascii', 0, 4) === 'RIFF'
      && data.readUInt32LE(4) + 8 === data.length && data.toString('ascii', 8, 12) === 'WEBP'
      && ['VP8 ', 'VP8L', 'VP8X'].includes(data.toString('ascii', 12, 16))) return 'image/webp';
  if (data.length >= 14 && ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))
      && data.readUInt16LE(6) > 0 && data.readUInt16LE(8) > 0 && data[data.length - 1] === 0x3b) return 'image/gif';
  if (data.length >= 26 && data.toString('ascii', 0, 2) === 'BM'
      && data.readUInt32LE(2) === data.length && data.readUInt32LE(10) >= 26
      && data.readUInt32LE(10) < data.length) return 'image/bmp';
  return undefined;
}
function decodeText(data: Buffer, name: string): string {
  const header = data.subarray(0, 8).toString('latin1');
  if (/^(?:%PDF-|PK\x03\x04|MZ|\x7fELF|\x1f\x8b|\x89PNG|GIF8|RIFF|BM)/.test(header)
      || (data[0] === 0xff && data[1] === 0xd8)) throw new Error(`Binary content is not supported: ${name}`);
  let text: string;
  try {
    if (data[0] === 0xff && data[1] === 0xfe) {
      if (data.length % 2) throw new Error('Odd UTF-16 length');
      text = new TextDecoder('utf-16le', { fatal: true }).decode(data.subarray(2));
    } else if (data[0] === 0xfe && data[1] === 0xff) {
      if (data.length % 2) throw new Error('Odd UTF-16 length');
      text = new TextDecoder('utf-16be', { fatal: true }).decode(data.subarray(2));
    } else {
      text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    }
  } catch {
    throw new Error(`Not valid UTF-8 or BOM-marked UTF-16 text: ${name}`);
  }
  // Permit whitespace, not NULs or binary control characters disguised as source code.
  if (/[\x00-\x08\x0b\x0e-\x1f\x7f-\x9f]/u.test(text)) throw new Error(`Binary content is not supported: ${name}`);
  return text;
}

async function pdfText(data: Buffer, name: string): Promise<string> {
  if (!data.subarray(0, 8).toString('ascii').match(/^%PDF-\d\.\d/)) throw new Error(`Invalid PDF signature: ${name}`);
  // Keep this ESM import external in the Electron build; pdf.js resolves its own worker module.
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs').catch(error => {
    throw new Error(`PDF parser initialization failed: ${error instanceof Error ? error.message : String(error)}. Verify the matching @napi-rs/canvas native binding (see docs/pdf-runtime.md).`, { cause: error });
  });
  const loading = getDocument({
    data: new Uint8Array(data), useSystemFonts: false,
    useWorkerFetch: false, disableFontFace: true, stopAtErrors: true,
  });
  try {
    const document = await loading.promise;
    let result = '';
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        if (pageNumber > 1) result += '\n\n';
        for (const item of content.items) {
          if (!('str' in item)) continue;
          result += item.str + (item.hasEOL ? '\n' : ' ');
          if (result.length > MAX_TEXT_CHARS) throw new Error(`PDF text exceeds ${MAX_TEXT_CHARS} characters: ${name}`);
        }
      } finally {
        page.cleanup();
      }
    }
    if (!result.trim()) throw new Error(`PDF contains no extractable text (OCR is not supported): ${name}`);
    return result.trim();
  } catch (error) {
    throw new Error(`Cannot extract PDF text from ${name}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await loading.destroy();
  }
}

/** Main-process registry: renderer-visible attachments deliberately contain no filesystem paths. */
export class FileService {
  private readonly entries = new Map<string, Entry>();
  private readonly cacheDir: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(cacheDir: string) {
    if (!path.isAbsolute(cacheDir)) throw new Error('The attachment cache directory must be absolute');
    this.cacheDir = path.resolve(cacheDir);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async candidate(input: string, temporary: boolean): Promise<Candidate> {
    if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) throw new Error('File paths must be absolute');
    const stat = await lstat(input);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Only regular files are supported: ${path.basename(input)}`);
    const filePath = await realpath(input);
    const name = path.basename(filePath);
    const kind = kindOf(name);
    if (temporary) {
      const cache = await realpath(this.cacheDir);
      if (kind !== 'image' || !CAPTURE_NAME.test(name) || key(path.dirname(filePath)) !== key(cache)
          || key(path.resolve(input)) !== key(path.join(this.cacheDir, name))) {
        throw new Error('Only generated capture PNGs directly inside the cache may be temporary');
      }
    }
    return { filePath, name, kind, identity: identity(stat), temporary };
  }

  private async read(candidate: Candidate): Promise<{ data: Buffer; text: string; mime?: string }> {
    if (key(await realpath(candidate.filePath)) !== key(candidate.filePath)) throw new Error(`File path changed: ${candidate.name}`);
    const file = await open(candidate.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await file.stat();
      if (!before.isFile() || identity(before) !== candidate.identity) throw new Error(`File was replaced: ${candidate.name}`);
      const limit = candidate.kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      if (before.size > limit) throw new Error(`File exceeds the ${limit / 1024 / 1024} MB limit: ${candidate.name}`);
      // A bounded read also protects against a file that grows after stat().
      const data = Buffer.alloc(Math.min(before.size + 1, limit + 1));
      let bytesRead = 0;
      while (bytesRead < data.length) {
        const read = await file.read(data, bytesRead, data.length - bytesRead, bytesRead);
        if (!read.bytesRead) break;
        bytesRead += read.bytesRead;
      }
      const after = await file.stat();
      if (bytesRead > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs
          || before.ctimeMs !== after.ctimeMs || bytesRead !== before.size) throw new Error(`File changed while being read: ${candidate.name}`);
      const contents = data.subarray(0, bytesRead);
      if (candidate.kind === 'image') {
        const mime = imageMime(contents);
        if (!mime || mime !== IMAGE_TYPES[path.extname(candidate.name).toLowerCase()]) throw new Error(`Invalid image format or signature: ${candidate.name}`);
        return { data: contents, text: '', mime };
      }
      const text = candidate.kind === 'pdf' ? await pdfText(contents, candidate.name) : decodeText(contents, candidate.name);
      if (text.length > MAX_TEXT_CHARS) throw new Error(`File text exceeds ${MAX_TEXT_CHARS} characters: ${candidate.name}`);
      return { data: contents, text };
    } finally {
      await file.close();
    }
  }

  private async removeTemporary(candidate: Candidate): Promise<void> {
    if (!candidate.temporary) return;
    try {
      const stat = await lstat(candidate.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || identity(stat) !== candidate.identity
          || key(await realpath(candidate.filePath)) !== key(candidate.filePath)) throw new Error(`Refusing to delete a replaced temporary capture: ${candidate.name}`);
      await unlink(candidate.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async register(paths: string[], temporary = false): Promise<Attachment[]> {
    return this.exclusive(async () => {
      if (!Array.isArray(paths) || paths.length > 100 || typeof temporary !== 'boolean') throw new Error('Invalid attachment list (maximum 100 files)');
      const candidates: Candidate[] = [];
      const staged: Entry[] = [];
      try {
        const seenPaths = new Set([...this.entries.values()].map(entry => key(entry.filePath)));
        const seenIdentities = new Set([...this.entries.values()].map(entry => entry.identity));
        for (const input of paths) {
          const candidate = await this.candidate(input, temporary);
          if (seenPaths.has(key(candidate.filePath)) || seenIdentities.has(candidate.identity)) throw new Error(`Duplicate attachment: ${candidate.name}`);
          candidates.push(candidate);
          seenPaths.add(key(candidate.filePath));
          seenIdentities.add(candidate.identity);
        }
        let characters = 0;
        for (const candidate of candidates) {
          const { data, text, mime } = await this.read(candidate);
          characters += text.length;
          if (characters > MAX_TEXT_CHARS) throw new Error(`Attachments exceed ${MAX_TEXT_CHARS} aggregate text characters`);
          const attachment: Attachment = {
            id: randomUUID(), name: candidate.name, kind: candidate.kind, size: data.length,
            ...(candidate.kind !== 'image' ? { preview: text.slice(0, PREVIEW_CHARS) }
              : data.length <= MAX_PREVIEW_BYTES ? { preview: `data:${mime};base64,${data.toString('base64')}` } : {}),
          };
          staged.push({ attachment, filePath: candidate.filePath, identity: candidate.identity, temporary });
        }
        for (const entry of staged) this.entries.set(entry.attachment.id, entry);
        return staged.map(entry => ({ ...entry.attachment }));
      } catch (error) {
        const cleanup = await Promise.allSettled(candidates.map(candidate => this.removeTemporary(candidate)));
        const failures = cleanup.filter(result => result.status === 'rejected');
        if (failures.length) throw new AggregateError([error, ...failures.map(result => (result as PromiseRejectedResult).reason)], 'Attachment registration and temporary cleanup failed');
        throw error;
      }
    });
  }

  private select(ids: string[]): Entry[] {
    if (!Array.isArray(ids) || ids.length > 100) throw new Error('Invalid attachment IDs');
    const seen = new Set<string>();
    return ids.map(id => {
      if (typeof id !== 'string' || !UUID.test(id) || seen.has(id)) throw new Error('Invalid or duplicate attachment ID');
      seen.add(id);
      const entry = this.entries.get(id);
      if (!entry) throw new Error('Unknown attachment ID');
      return entry;
    });
  }

  async prepare(ids: string[]): Promise<{ text: string; images: string[] }> {
    return this.exclusive(async () => {
      const selected = this.select(ids);
      const texts: string[] = [];
      const images: string[] = [];
      let characters = 0;
      for (const entry of selected) {
        const candidate: Candidate = { ...entry, name: entry.attachment.name, kind: entry.attachment.kind };
        const { text } = await this.read(candidate);
        if (entry.attachment.kind === 'image') {
          images.push(entry.filePath);
        } else {
          // JSON quoting prevents newlines in a filename from forging another file heading.
          const section = `--- File: ${JSON.stringify(entry.attachment.name)} ---\n${text}`;
          characters += section.length + (texts.length ? 2 : 0);
          if (characters > MAX_TEXT_CHARS) throw new Error(`Attachments exceed ${MAX_TEXT_CHARS} aggregate text characters`);
          texts.push(section);
        }
      }
      return { text: texts.join('\n\n'), images };
    });
  }

  async release(ids: string[]): Promise<void> {
    return this.exclusive(async () => {
      const selected = this.select(ids);
      const results = await Promise.allSettled(selected.map(async entry => {
        await this.removeTemporary({ ...entry, name: entry.attachment.name, kind: entry.attachment.kind });
        this.entries.delete(entry.attachment.id);
      }));
      const errors = results.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason);
      if (errors.length) throw new AggregateError(errors, 'Could not release temporary attachments');
    });
  }

  async cleanup(): Promise<void> {
    return this.exclusive(async () => {
      const results = await Promise.allSettled([...this.entries.values()].map(async entry => {
        await this.removeTemporary({ ...entry, name: entry.attachment.name, kind: entry.attachment.kind });
        this.entries.delete(entry.attachment.id);
      }));
      const errors = results.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason);
      if (errors.length) throw new AggregateError(errors, 'Could not clean up temporary attachments');
    });
  }
}
