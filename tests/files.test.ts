import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, truncate, link } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileService, MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_TEXT_CHARS } from '../electron/files';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+9sAAAAASUVORK5CYII=', 'base64');

// Real PDFs: byte-correct objects/xref, optional Flate streams, and independently numbered pages.
function pdfFixture(text: string | string[], compressed = false, horizontalScale = 100): Buffer {
  const pages = Array.isArray(text) ? text : [text];
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from(`<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
  ];
  for (const [index, page] of pages.entries()) {
    const escaped = page.replace(/[\\()]/g, '\\$&');
    const plain = Buffer.from(`BT /F1 12 Tf ${horizontalScale} Tz 20 100 Td (${escaped}) Tj ET`);
    const stream = compressed ? deflateSync(plain) : plain;
    objects.push(
      Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`),
      Buffer.concat([Buffer.from(`<< /Length ${stream.length}${compressed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`), stream, Buffer.from('\nendstream')]),
    );
  }
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  let length = chunks[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
    chunks.push(chunk);
    length += chunk.length;
  }
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  return Buffer.concat([...chunks, Buffer.from(xref)]);
}

let root: string;
let cache: string;
let files: FileService;
async function fixture(name: string, contents: string | Buffer): Promise<string> {
  const filePath = path.join(root, name);
  await writeFile(filePath, contents);
  return filePath;
}
async function captureFixture(): Promise<string> {
  const filePath = path.join(cache, `capture-${randomUUID()}.png`);
  await writeFile(filePath, PNG);
  return filePath;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'assistant-files-test-'));
  cache = path.join(root, 'cache');
  await mkdir(cache);
  files = new FileService(cache);
});
afterEach(async () => {
  await files.cleanup();
  await rm(root, { recursive: true, force: true });
});

describe('FileService text and PDF parsing', () => {
  it('registers exact selected code files with opaque IDs and no path leakage', async () => {
    const selected = await fixture('selected.ts', 'export const answer = 42;');
    await fixture('not-selected.txt', 'DO NOT READ THIS');
    const [attachment] = await files.register([selected]);
    expect(attachment.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(attachment).toMatchObject({ name: 'selected.ts', kind: 'text', size: 25, preview: 'export const answer = 42;' });
    expect(JSON.stringify(attachment)).not.toContain(root);
    expect(Object.keys(attachment).sort()).toEqual(['id', 'kind', 'name', 'preview', 'size']);
    attachment.name = 'renderer-mutated.txt';
    const prepared = await files.prepare([attachment.id]);
    expect(prepared.text).toContain('selected.ts');
    expect(prepared.text).toContain('export const answer = 42;');
    expect(prepared.text).not.toContain('DO NOT READ');
    expect(prepared.images).toEqual([]);
  });

  it('supports UTF-8 and explicit UTF-16 BOMs and common extensionless code', async () => {
    const paths = await Promise.all([
      fixture('readme.md', '\ufeffGrüße 👋'),
      fixture('utf16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Hallo Welt', 'utf16le')])),
      fixture('Dockerfile', 'FROM scratch'),
      fixture('.env', 'EXAMPLE=not-a-secret'),
    ]);
    const attachments = await files.register(paths);
    const { text } = await files.prepare(attachments.map(attachment => attachment.id));
    expect(text).toContain('Grüße 👋');
    expect(text).toContain('Hallo Welt');
    expect(text).toContain('FROM scratch');
  });

  it('extracts actual PDF page text, not the name or PDF syntax', async () => {
    const filePath = await fixture('misleading-name.pdf', pdfFixture('Actual page text 42'));
    const [attachment] = await files.register([filePath]);
    expect(attachment.kind).toBe('pdf');
    expect(attachment.preview).toBe('Actual page text 42');
    const { text } = await files.prepare([attachment.id]);
    expect(text).toContain('Actual page text 42');
    expect(text).not.toContain('/Type /Page');
  });

  it('extracts compressed multi-page PDFs in page order and re-reads changed PDFs', async () => {
    const filePath = await fixture('compressed.pdf', pdfFixture(['First page (with parentheses)', 'Second page \\ text'], true));
    const [attachment] = await files.register([filePath]);
    const { text } = await files.prepare([attachment.id]);
    expect(text).toContain('First page (with parentheses)');
    expect(text).toContain('Second page \\ text');
    expect(text.indexOf('First page')).toBeLessThan(text.indexOf('Second page'));
    expect(text).not.toContain('FlateDecode');
    await writeFile(filePath, pdfFixture('Changed PDF page', true));
    expect((await files.prepare([attachment.id])).text).toContain('Changed PDF page');
  });

  it('rejects fake, broken, and textless PDFs explicitly', async () => {
    await expect(files.register([await fixture('fake.pdf', 'not a PDF')])).rejects.toThrow(/PDF signature/);
    await expect(files.register([await fixture('broken.pdf', '%PDF-1.4\ninvalid')])).rejects.toThrow(/Cannot extract PDF/);
    await expect(files.register([await fixture('scan.pdf', pdfFixture(''))])).rejects.toThrow(/no extractable text/);
  });

  it('rejects excessive decompressed PDF text and leaves registration usable after failure', async () => {
    // Keep every glyph within the page: PDF.js correctly omits out-of-bounds text.
    const oversized = pdfFixture('A'.repeat(MAX_TEXT_CHARS + 1), true, 0.01);
    expect(oversized.length).toBeLessThan(MAX_FILE_BYTES);
    const valid = await fixture('valid.pdf', pdfFixture('Valid after failed extraction', true));
    const invalid = await fixture('too-much-text.pdf', oversized);
    await expect(files.register([valid, invalid])).rejects.toThrow(/PDF text exceeds/);
    const [attachment] = await files.register([valid]);
    expect((await files.prepare([attachment.id])).text).toContain('Valid after failed extraction');
  });

  it('never truncates text content while limiting only previews', async () => {
    const content = 'long text '.repeat(1000);
    const [attachment] = await files.register([await fixture('long.txt', content)]);
    expect(attachment.preview?.length).toBe(600);
    expect((await files.prepare([attachment.id])).text).toContain(content);
  });

  it('re-reads content and rejects excessive aggregate characters without truncating', async () => {
    const first = await fixture('first.txt', 'a'.repeat(80_000));
    const second = await fixture('second.txt', 'b'.repeat(80_000));
    await expect(files.register([first, second])).rejects.toThrow(/aggregate/);
    const [a] = await files.register([first]);
    const [b] = await files.register([second]);
    await expect(files.prepare([a.id, b.id])).rejects.toThrow(/aggregate/);
    await writeFile(first, 'updated selected content');
    expect((await files.prepare([a.id])).text).toContain('updated selected content');
    await writeFile(first, 'a'.repeat(MAX_TEXT_CHARS + 1));
    await expect(files.prepare([a.id])).rejects.toThrow(/characters/);
  });
});

describe('PDF.js Electron main runtime', () => {
  it.runIf(process.platform === 'win32')('extracts a real PDF from an externalized CJS bundle in a windowless Electron main process', async () => {
    const require = createRequire(path.join(process.cwd(), 'package.json'));
    const electronDirectory = path.dirname(require.resolve('electron/package.json'));
    const binary = (await readFile(path.join(electronDirectory, 'path.txt'), 'utf8')).trim();
    const executable = path.join(electronDirectory, 'dist', binary);
    // Keep ordinary node_modules resolution, as in dist-electron; no rewritten imports or test shims.
    const appDirectory = await mkdtemp(path.join(process.cwd(), 'node_modules', '.pdf-runtime-test-'));
    try {
      const selected = await fixture('electron-main.pdf', pdfFixture(['Electron main PDF page one', 'Electron main PDF page two'], true));
      const resultPath = path.join(root, 'electron-result.json');
      const entry = path.join(appDirectory, 'main.cjs');
      await mkdir(path.join(appDirectory, 'user-data'));
      await build({
        entryPoints: [path.resolve('electron/files.ts')], outfile: path.join(appDirectory, 'files.cjs'),
        bundle: true, platform: 'node', format: 'cjs', target: 'node22',
        external: ['pdfjs-dist', 'pdfjs-dist/*'], logLevel: 'silent',
      });
      await writeFile(entry, `
        const { app } = require('electron');
        const fs = require('node:fs/promises');
        const { FileService } = require('./files.cjs');
        app.disableHardwareAcceleration();
        app.setPath('userData', ${JSON.stringify(path.join(appDirectory, 'user-data'))});
        app.setPath('sessionData', ${JSON.stringify(path.join(appDirectory, 'user-data'))});
        app.whenReady().then(async () => {
          if (process.type !== 'browser') throw new Error('Not an Electron main process');
          const files = new FileService(${JSON.stringify(cache)});
          try {
            const [attachment] = await files.register([${JSON.stringify(selected)}]);
            const prepared = await files.prepare([attachment.id]);
            await fs.writeFile(${JSON.stringify(resultPath)}, JSON.stringify({
              type: process.type, platform: process.platform, arch: process.arch,
              electron: process.versions.electron, node: process.versions.node,
              domMatrix: typeof globalThis.DOMMatrix, preview: attachment.preview, ...prepared,
            }));
          } finally { await files.cleanup(); }
          app.exit(0);
        }).catch(error => { console.error(error); app.exit(1); });
      `);
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      await promisify(execFile)(executable, [entry], { env, windowsHide: true, shell: false, timeout: 20_000 });
      const result = JSON.parse(await readFile(resultPath, 'utf8'));
      expect(result).toMatchObject({ type: 'browser', platform: 'win32', arch: process.arch, domMatrix: 'function', images: [] });
      expect(result.electron).toBe(require('electron/package.json').version);
      expect(result.node).toBeTruthy();
      console.info('Verified PDF.js Electron main runtime:', { electron: result.electron, node: result.node, arch: result.arch, type: result.type });
      expect(result.preview).toContain('Electron main PDF page one');
      expect(result.text).toContain('Electron main PDF page one');
      expect(result.text).toContain('Electron main PDF page two');
    } finally {
      await rm(appDirectory, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('FileService image formats and bounds', () => {
  it('validates PNG magic and returns a small data URL preview', async () => {
    const filePath = await fixture('tiny.png', PNG);
    const [attachment] = await files.register([filePath]);
    expect(attachment.kind).toBe('image');
    expect(attachment.preview).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(await files.prepare([attachment.id])).toEqual({ text: '', images: [filePath] });
  });

  it('accepts JPEG, WebP, GIF, and BMP signatures', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
    const webp = Buffer.alloc(24);
    webp.write('RIFF'); webp.writeUInt32LE(16, 4); webp.write('WEBPVP8 ', 8);
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const bmp = Buffer.alloc(58);
    bmp.write('BM'); bmp.writeUInt32LE(58, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(1, 18); bmp.writeInt32LE(1, 22);
    for (const [extension, data, mime] of [
      ['jpg', jpeg, 'image/jpeg'], ['jpeg', jpeg, 'image/jpeg'], ['webp', webp, 'image/webp'],
      ['gif', gif, 'image/gif'], ['bmp', bmp, 'image/bmp'],
    ] as const) {
      const [attachment] = await files.register([await fixture(`image.${extension}`, data)]);
      expect(attachment.preview).toMatch(`data:${mime};base64,`);
    }
  });

  it('rejects renamed, malformed, and truncated images', async () => {
    for (const [name, content] of [
      ['fake.png', Buffer.from('not a PNG')], ['mismatch.jpg', PNG],
      ['truncated.png', PNG.subarray(0, 24)], ['fake.webp', Buffer.from('RIFF0000WEBPjunk')],
    ] as const) {
      await expect(files.register([await fixture(name, content)])).rejects.toThrow(/image format/);
    }
    const selected = await fixture('changed.png', PNG);
    const [attachment] = await files.register([selected]);
    await writeFile(selected, 'now binary garbage');
    await expect(files.prepare([attachment.id])).rejects.toThrow(/image format/);
  });

  it('omits large previews rather than returning huge renderer data URLs', async () => {
    const padded = Buffer.concat([PNG.subarray(0, PNG.length - 12), Buffer.alloc(300_000), PNG.subarray(-12)]);
    const [attachment] = await files.register([await fixture('large.png', padded)]);
    expect(attachment.preview).toBeUndefined();
  });

  it('enforces byte limits at registration and again at prepare', async () => {
    const large = await fixture('large.txt', 'small');
    await truncate(large, MAX_FILE_BYTES + 1);
    await expect(files.register([large])).rejects.toThrow(/10 MB/);
    const largeImage = await fixture('large.png', PNG);
    const [attachment] = await files.register([largeImage]);
    await truncate(largeImage, MAX_IMAGE_BYTES + 1);
    await expect(files.prepare([attachment.id])).rejects.toThrow(/20 MB/);
    await files.release([attachment.id]);
    await expect(files.register([largeImage])).rejects.toThrow(/20 MB/);
  });
});

describe('FileService registry security and lifecycle', () => {
  it('rejects directories, unsupported extensions, binary source, and invalid UTF-8', async () => {
    await expect(files.register([root])).rejects.toThrow(/regular files/);
    await expect(files.register([await fixture('program.exe', 'plain text')])).rejects.toThrow(/Unsupported file/);
    await expect(files.register([await fixture('binary.ts', Buffer.from([0, 1, 2]))])).rejects.toThrow(/Binary/);
    await expect(files.register([await fixture('bad.txt', Buffer.from([0xc3, 0x28]))])).rejects.toThrow(/valid UTF/);
    await expect(files.register([await fixture('renamed.txt', pdfFixture('hidden PDF'))])).rejects.toThrow(/Binary/);
    await expect(files.register(['relative.txt'])).rejects.toThrow(/absolute/);
  });

  it('rejects duplicate paths and hard links, without partially registering', async () => {
    const selected = await fixture('selected.txt', 'hello');
    await expect(files.register([selected, selected])).rejects.toThrow(/Duplicate/);
    const [attachment] = await files.register([selected]);
    await expect(files.register([selected])).rejects.toThrow(/Duplicate/);
    const alias = path.join(root, 'alias.txt');
    await link(selected, alias);
    await expect(files.register([alias])).rejects.toThrow(/Duplicate/);
    expect((await files.prepare([attachment.id])).text).toContain('hello');
  });

  it('rejects invalid, unknown, duplicate, and released IDs atomically', async () => {
    const [attachment] = await files.register([await fixture('selected.txt', 'hello')]);
    for (const ids of [['../../secret'], [randomUUID()], [attachment.id, attachment.id], [null] as unknown as string[]]) {
      await expect(files.prepare(ids)).rejects.toThrow(/ID/);
      await expect(files.release(ids)).rejects.toThrow(/ID/);
    }
    await expect(files.release([attachment.id, randomUUID()])).rejects.toThrow(/Unknown/);
    expect((await files.prepare([attachment.id])).text).toContain('hello');
    await files.release([attachment.id]);
    await expect(files.prepare([attachment.id])).rejects.toThrow(/Unknown/);
  });

  it('rolls back registration and deletes owned captures on partial failure', async () => {
    const capture = await captureFixture();
    const invalid = path.join(cache, `capture-${randomUUID()}.png`);
    await writeFile(invalid, 'invalid image');
    await expect(files.register([capture, invalid], true)).rejects.toThrow(/image format/);
    await expect(stat(capture)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(invalid)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await files.prepare([])).toEqual({ text: '', images: [] });
  });

  it('deletes only owned captures and never deletes original user files', async () => {
    const capture = await captureFixture();
    const original = await fixture('original.png', PNG);
    const [a] = await files.register([capture], true);
    const [b] = await files.register([original]);
    await expect(files.register([original], true)).rejects.toThrow(/generated capture/);
    const arbitraryCache = path.join(cache, 'user-photo.png');
    await writeFile(arbitraryCache, PNG);
    await expect(files.register([arbitraryCache], true)).rejects.toThrow(/generated capture/);
    await files.release([a.id, b.id]);
    await expect(stat(capture)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(original)).toEqual(PNG);
    expect(await readFile(arbitraryCache)).toEqual(PNG);
  });

  it('does not delete an already-registered capture on duplicate registration', async () => {
    const capture = await captureFixture();
    const [attachment] = await files.register([capture], true);
    await expect(files.register([capture], true)).rejects.toThrow(/Duplicate/);
    expect((await files.prepare([attachment.id])).images).toEqual([capture]);
  });

  it('serializes concurrent registration and cleanup, and cleanup is repeatable', async () => {
    const capture = await captureFixture();
    const registration = files.register([capture], true);
    const cleanup = files.cleanup();
    const [attachment] = await registration;
    await cleanup;
    await files.cleanup();
    await expect(files.prepare([attachment.id])).rejects.toThrow(/Unknown/);
    await expect(stat(capture)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
