import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultSettings } from '../shared/defaults';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  input = '';
  stdin = new Writable({
    write: (chunk, _encoding, done) => { this.input += chunk.toString(); done(); },
  });
  kill = vi.fn(() => { queueMicrotask(() => this.emit('close', null)); return true; });
  complete(value: unknown): void {
    this.stdout.write(JSON.stringify(value));
    this.emit('close', 0);
  }
}

type WindowsService = typeof import('../electron/windows');
let windows: WindowsService;
let children: FakeChild[];
let root: string;
let originalPlatform: PropertyDescriptor | undefined;
let originalResources: PropertyDescriptor | undefined;
let originalDefaultApp: PropertyDescriptor | undefined;
let exitListeners: Array<(code: number) => void>;

beforeEach(async () => {
  vi.resetModules();
  mocks.spawn.mockReset();
  children = [];
  mocks.spawn.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  root = await mkdtemp(path.join(tmpdir(), 'assistant-windows-test-'));
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  originalDefaultApp = Object.getOwnPropertyDescriptor(process, 'defaultApp');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  Object.defineProperty(process, 'resourcesPath', { value: undefined, configurable: true });
  exitListeners = process.listeners('exit');
  windows = await import('../electron/windows');
});

afterEach(async () => {
  await windows.shutdownWindows();
  vi.useRealTimers();
  for (const listener of process.listeners('exit')) {
    if (!exitListeners.includes(listener)) process.removeListener('exit', listener);
  }
  for (const [property, descriptor] of [
    ['platform', originalPlatform], ['resourcesPath', originalResources], ['defaultApp', originalDefaultApp],
  ] as const) {
    if (descriptor) Object.defineProperty(process, property, descriptor);
    else Reflect.deleteProperty(process, property);
  }
  await rm(root, { recursive: true, force: true });
});

async function waitForChildren(count: number): Promise<void> {
  await vi.waitFor(() => expect(children.length).toBe(count), { interval: 1, timeout: 2000 });
}

describe('pure markdown speech sanitizer', () => {
  it('keeps prose and inline code while removing formatting and code blocks', () => {
    const markdown = '# Heading\n\n**Bold** and _emphasis_, `inline()` and ~~old~~.\n- item\n1. next\n> quote\n\n```ts\nthrow new Error("never read");\n```\n~~~python\nprint("never read")\n~~~';
    expect(windows.cleanMarkdown(markdown)).toBe('Heading Bold and emphasis, inline() and old. item next quote');
  });

  it('does not speak image URLs, link destinations, HTML, or reference definitions', () => {
    const markdown = '[Useful label](https://example.com/path) ![image](https://secret.test/a.png) [Reference][id]\n[id]: https://secret.test/\n<b>Hello</b> &amp; goodbye <https://secret.test/>\n- [x] Done';
    expect(windows.cleanMarkdown(markdown)).toBe('Useful label Reference Hello & goodbye Done');
  });

  it('handles Unicode, escaped punctuation, controls, and unfinished code fences', () => {
    expect(windows.cleanMarkdown('Grüße 👋 **Welt**\u0000\n\nnext')).toBe('Grüße 👋 Welt next');
    expect(windows.cleanMarkdown('before\n```js\nunfinished')).toBe('before');
    expect(windows.cleanMarkdown('')).toBe('');
    expect(windows.cleanMarkdown('snake_case_name')).toBe('snake_case_name');
  });
});

describe('hidden fixed PowerShell protocol (no real processes)', () => {
  it('passes untrusted speech and voice names exclusively through JSON stdin', async () => {
    const voice = "Voice'; Start-Process calc; #\n$()";
    const text = "Hello '; Start-Process calc; # $env:PATH — Grüße";
    const speaking = windows.speak(text, { voice, rate: -3, volume: 43 });
    await waitForChildren(1);
    const [executable, args, options] = mocks.spawn.mock.calls[0];
    expect(executable).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    expect(args).toContain('-File');
    expect(args).not.toContain('-Command');
    expect(args).toContain('Speak');
    expect(args.join(' ')).not.toContain(voice);
    expect(args.join(' ')).not.toContain(text);
    expect(options).toMatchObject({ windowsHide: true, shell: false });
    expect(JSON.parse(children[0].input)).toEqual({ text, voice, rate: -3, volume: 43 });
    children[0].complete(true);
    await speaking;
  });

  it('enumerates Unicode native voices and validates the protocol response', async () => {
    const voices = [{ id: 'Microsoft Hedda Desktop', name: 'Hedda – Deutsch', language: 'de-DE' }];
    const result = windows.getVoices();
    children[0].complete(voices);
    expect(await result).toEqual(voices);
    const invalid = windows.getVoices();
    children[1].complete([{ name: 'missing id and language' }]);
    await expect(invalid).rejects.toThrow(/voice response/);
  });

  it('interrupts previous speech and stopSpeech waits for process exit', async () => {
    const first = windows.speak('first', defaultSettings().audio);
    await waitForChildren(1);
    const second = windows.speak('second', defaultSettings().audio);
    await waitForChildren(2);
    expect(children[0].kill).toHaveBeenCalledOnce();
    await first;
    await windows.stopSpeech();
    expect(children[1].kill).toHaveBeenCalledOnce();
    await second;
  });

  it('does not start superseded speech during a cancellation race', async () => {
    const first = windows.speak('first', defaultSettings().audio);
    await waitForChildren(1);
    const second = windows.speak('second', defaultSettings().audio);
    await windows.stopSpeech();
    await Promise.all([first, second]);
    expect(children).toHaveLength(1);
  });

  it('validates settings and skips empty cleaned speech before spawning', async () => {
    for (const audio of [
      { voice: '', rate: 11, volume: 80 }, { voice: '', rate: 0.5, volume: 80 },
      { voice: '', rate: 0, volume: 101 }, { voice: '', rate: Number.NaN, volume: 80 },
    ]) await expect(windows.speak('text', audio)).rejects.toThrow(/settings/);
    await expect(windows.speak('x'.repeat(150_001), defaultSettings().audio)).rejects.toThrow(/150000/);
    await windows.speak('```js\ncode\n```', defaultSettings().audio);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('uses packaged resources rather than a working-directory script', async () => {
    const resources = path.join(root, 'packaged');
    await mkdir(path.join(resources, 'resources'), { recursive: true });
    const bundled = path.join(resources, 'resources', 'windows.ps1');
    await writeFile(bundled, '# fixture only; never executed');
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });
    const result = windows.getVoices();
    expect(mocks.spawn.mock.calls[0][1]).toContain(bundled);
    children[0].complete([]);
    expect(await result).toEqual([]);
    await rm(bundled);
    await expect(windows.getVoices()).rejects.toThrow(/bundled.*missing/);
  });

  it('falls back to project resources only for an Electron development process', async () => {
    Object.defineProperty(process, 'resourcesPath', { value: path.join(root, 'electron-dist'), configurable: true });
    Object.defineProperty(process, 'defaultApp', { value: true, configurable: true });
    const result = windows.getVoices();
    expect(mocks.spawn.mock.calls[0][1]).toContain(path.resolve('resources/windows.ps1'));
    children[0].complete([]);
    await result;
  });

  it('rejects failed, oversized, and malformed native output', async () => {
    const failed = windows.getVoices();
    children[0].stderr.write('native failure');
    children[0].emit('close', 1);
    await expect(failed).rejects.toThrow(/native failure/);
    const invalid = windows.getVoices();
    children[1].stdout.write('not JSON');
    children[1].emit('close', 0);
    await expect(invalid).rejects.toThrow(/invalid JSON/);
    const large = windows.getVoices();
    children[2].stdout.write('a'.repeat(1024 * 1024 + 1));
    await expect(large).rejects.toThrow(/too much output/);
    expect(children[2].kill).toHaveBeenCalledOnce();
  });

  it('reports spawn failure without hanging', async () => {
    const result = windows.getVoices();
    children[0].emit('error', new Error('ENOENT powershell'));
    children[0].emit('close', -2);
    await expect(result).rejects.toThrow(/ENOENT/);
  });

  it('times out native operations and kills the process', async () => {
    vi.useFakeTimers();
    const result = windows.getVoices();
    const assertion = expect(result).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(20_001);
    await assertion;
    expect(children[0].kill).toHaveBeenCalledOnce();
  });
});

describe('capture lifecycle with mocked native capture only', () => {
  it('generates an opaque cache PNG path and never interpolates paths into arguments', async () => {
    const capture = windows.capture('screen', root);
    await waitForChildren(1);
    const input = JSON.parse(children[0].input);
    expect(input.mode).toBe('screen');
    expect(path.dirname(input.outputPath)).toBe(root);
    expect(path.basename(input.outputPath)).toMatch(/^capture-[0-9a-f-]{36}\.png$/);
    expect(mocks.spawn.mock.calls[0][1].join(' ')).not.toContain(input.outputPath);
    await writeFile(input.outputPath, 'fake PNG from mocked native process');
    children[0].complete({ saved: true });
    expect(await capture).toBe(input.outputPath);
  });

  it('returns null on Escape and removes partial captures', async () => {
    const capture = windows.capture('region', root);
    await waitForChildren(1);
    const { outputPath } = JSON.parse(children[0].input);
    await writeFile(outputPath, 'partial');
    children[0].complete(null);
    expect(await capture).toBeNull();
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bounds region selection to 120 seconds and cleans partial output', async () => {
    vi.useFakeTimers();
    const capture = windows.capture('region', root);
    const assertion = expect(capture).rejects.toThrow(/timed out/);
    await waitForChildren(1);
    const { outputPath } = JSON.parse(children[0].input);
    await writeFile(outputPath, 'partial');
    await vi.advanceTimersByTimeAsync(120_001);
    await assertion;
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('shutdown cancels capture and speech and forbids new native jobs', async () => {
    const capture = windows.capture('region', root);
    await waitForChildren(1);
    const { outputPath } = JSON.parse(children[0].input);
    await writeFile(outputPath, 'partial');
    const speaking = windows.speak('test', defaultSettings().audio);
    await waitForChildren(2);
    await windows.shutdownWindows();
    expect(await capture).toBeNull();
    await speaking;
    expect(children.every(child => child.kill.mock.calls.length === 1)).toBe(true);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(windows.getVoices()).rejects.toThrow(/shut down/);
  });

  it('cleans a completed capture if shutdown races with its response', async () => {
    const capture = windows.capture('region', root);
    await waitForChildren(1);
    const { outputPath } = JSON.parse(children[0].input);
    await writeFile(outputPath, 'completed');
    children[0].complete({ saved: true });
    const shutdown = windows.shutdownWindows();
    expect(await capture).toBeNull();
    await shutdown;
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects non-Windows operations and invalid capture inputs', async () => {
    await expect(windows.capture('invalid' as 'screen', root)).rejects.toThrow(/mode/);
    await expect(windows.capture('screen', 'relative')).rejects.toThrow(/absolute/);
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    await expect(windows.getVoices()).rejects.toThrow(/require Windows/);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('bundles physical-pixel, frozen-region, clipboard-free native capture', async () => {
    const script = await readFile(path.resolve('resources/windows.ps1'), 'utf8');
    expect(script).toContain('SetThreadDpiAwarenessContext');
    expect(script).toContain('Screen.FromPoint(Cursor.Position).Bounds');
    expect(script).toContain('SystemInformation.VirtualScreen');
    expect(script).toContain('graphics.CopyFromScreen');
    expect(script).toContain('AutoScaleMode = AutoScaleMode.None');
    expect(script).toContain('Selection.Width < 2 || Selection.Height < 2');
    expect(script).toContain('Keys.Escape');
    expect(script).toContain('Interval = 115000');
    expect(script).not.toMatch(/Clipboard\s*\.\s*(?:Set|Get|Clear|Contains)\w*\s*\(/i);
    expect(script).not.toMatch(/Invoke-Expression|SpeakSsml\s*\(/i);
  });
});
