import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { mkdir, realpath, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Settings, Voice } from '../shared/types';

const CAPTURE_TIMEOUT = 120_000;
const VOICE_TIMEOUT = 20_000;
const SPEECH_TIMEOUT = 30 * 60_000;
const MAX_OUTPUT = 1024 * 1024;
const active = new Set<NativeJob>();
const pendingCaptures = new Map<string, Promise<void>>();
let speech: NativeJob | undefined;
let closing = false;
let speechGeneration = 0;

/** Plain text for SAPI, not SSML. Never interpret model output as speech markup. */
export function cleanMarkdown(text: string): string {
  return text
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, ' ')
    .replace(/~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^\n)]*\)/g, ' ')
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, ' ')
    .replace(/\[([^\]]+)\]\([^\n)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/^\s{0,3}\[[^\]]+\]:.*$/gm, '')
    .replace(/<https?:\/\/[^>]+>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/[^\s]+/gi, ' ')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm, '')
    .replace(/^\s*\[[ xX]\]\s*/gm, '')
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, ' ')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_match, stars: string, underscores: string) => stars ?? underscores)
    .replace(/(?<!\w)[*_]([^\n*_]+)[*_](?!\w)/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\\([\\`*_{}\[\]()#+.!>~-])/g, '$1')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[entity] ?? entity)
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scriptPath(): string {
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string; defaultApp?: boolean };
    const resourcesPath = electronProcess.resourcesPath;
  if (resourcesPath) {
    const bundled = path.join(resourcesPath, 'resources', 'windows.ps1');
    if (existsSync(bundled)) return bundled;
    // A packaged app must not fall back to an arbitrary script in its working directory.
    if (!electronProcess.defaultApp) throw new Error('The bundled Windows services script is missing');
  }
  const candidates = [
    ...(typeof __dirname === 'string' ? [path.resolve(__dirname, '../resources/windows.ps1')] : []),
    path.resolve(process.cwd(), 'resources/windows.ps1'),
  ];
  const script = candidates.find(candidate => existsSync(candidate));
  if (!script) throw new Error('Cannot find resources/windows.ps1');
  return script;
}

interface NativeJob {
  child: ChildProcessWithoutNullStreams;
  promise: Promise<unknown>;
  cancel(): void;
}

function native(action: 'Capture' | 'Voices' | 'Speak', input: object, timeout: number): NativeJob {
  if (closing) throw new Error('Windows services have shut down');
  if (process.platform !== 'win32') throw new Error('Native capture and speech require Windows');
  const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(executable, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA',
    '-File', scriptPath(), '-Action', action,
  ], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let cancelled = false;
  let failure: Error | undefined;
  let output = '';
  let errors = '';
  let outputBytes = 0;
  let timer: ReturnType<typeof setTimeout>;
  const job: NativeJob = {
    child,
    promise: Promise.resolve(),
    cancel() {
      cancelled = true;
      child.kill();
    },
  };
  job.promise = new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT) {
        failure = new Error('Windows service returned too much output');
        child.kill();
      } else output += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (errors.length < 8192) errors += chunk.slice(0, 8192 - errors.length);
    });
    child.on('error', error => { failure = error; });
    child.stdin.on('error', error => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') failure = error;
    });
    child.once('close', code => {
      clearTimeout(timer);
      active.delete(job);
      if (cancelled) return resolve(null);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`Windows ${action.toLowerCase()} failed: ${errors.trim() || `exit ${code}`}`));
      try {
        resolve(JSON.parse(output.replace(/^\uFEFF/, '').trim()));
      } catch {
        reject(new Error(`Windows ${action.toLowerCase()} returned invalid JSON`));
      }
    });
    timer = setTimeout(() => {
      failure = new Error(`Windows ${action.toLowerCase()} timed out after ${timeout / 1000} seconds`);
      child.kill();
    }, timeout);
    timer.unref();
    // This is the only channel carrying user text, voice names, and filesystem paths.
    child.stdin.end(JSON.stringify(input));
  });
  active.add(job);
  return job;
}

export async function capture(mode: 'screen' | 'region', cacheDir: string): Promise<string | null> {
  if (mode !== 'screen' && mode !== 'region') throw new Error('Invalid capture mode');
  if (!path.isAbsolute(cacheDir)) throw new Error('The capture cache directory must be absolute');
  if (closing) throw new Error('Windows services have shut down');
  await mkdir(cacheDir, { recursive: true });
  const directory = await realpath(cacheDir);
  const outputPath = path.join(directory, `capture-${randomUUID()}.png`);
  let finished!: () => void;
  pendingCaptures.set(outputPath, new Promise<void>(resolve => { finished = resolve; }));
  try {
    const result = await native('Capture', { mode, outputPath }, CAPTURE_TIMEOUT).promise;
    if (result === null || closing) {
      await unlink(outputPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      return null;
    }
    if (!result || typeof result !== 'object' || !('saved' in result) || result.saved !== true) throw new Error('Invalid capture response');
    return outputPath;
  } catch (error) {
    await unlink(outputPath).catch(cleanupError => { if (cleanupError.code !== 'ENOENT') throw cleanupError; });
    throw error;
  } finally {
    pendingCaptures.delete(outputPath);
    finished();
  }
}

export async function getVoices(): Promise<Voice[]> {
  const result = await native('Voices', {}, VOICE_TIMEOUT).promise;
  if (result === null) return [];
  if (!Array.isArray(result) || !result.every(voice => voice && typeof voice.id === 'string'
      && typeof voice.name === 'string' && typeof voice.language === 'string')) throw new Error('Invalid native voice response');
  return result;
}

export async function speak(text: string, audio: Settings['audio']): Promise<void> {
  if (typeof text !== 'string' || text.length > 150_000) throw new Error('Speech text must be at most 150000 characters');
  if (!audio || typeof audio.voice !== 'string' || audio.voice.length > 1000
      || !Number.isInteger(audio.rate) || audio.rate < -10 || audio.rate > 10
      || !Number.isInteger(audio.volume) || audio.volume < 0 || audio.volume > 100) throw new Error('Invalid speech settings');
  const generation = ++speechGeneration;
  const previous = speech;
  speech = undefined;
  if (previous) {
    previous.cancel();
    await previous.promise;
  }
  if (generation !== speechGeneration || closing) return;
  const cleaned = cleanMarkdown(text);
  if (!cleaned) return;
  const job = native('Speak', { text: cleaned, voice: audio.voice, rate: audio.rate, volume: audio.volume }, SPEECH_TIMEOUT);
  speech = job;
  try {
    await job.promise;
  } finally {
    if (speech === job) speech = undefined;
  }
}

export async function stopSpeech(): Promise<void> {
  ++speechGeneration;
  const previous = speech;
  speech = undefined;
  if (previous) {
    previous.cancel();
    await previous.promise;
  }
}

/** Call from the parent's quit/abort path; cancellation waits until every native process exits. */
export async function shutdownWindows(): Promise<void> {
  closing = true;
  ++speechGeneration;
  speech = undefined;
  const jobs = [...active];
  const captures = [...pendingCaptures.values()];
  for (const job of jobs) job.cancel();
  await Promise.allSettled(jobs.map(job => job.promise));
  // Capture owns its file deletion; a second unlink here races on Windows (EPERM).
  await Promise.all(captures);
}

// Last-resort synchronous cleanup if the parent exits without its async quit hook.
process.once('exit', () => {
  for (const job of active) job.child.kill();
  for (const file of pendingCaptures.keys()) {
    try { unlinkSync(file); } catch { /* Async shutdown is the reliable cleanup path. */ }
  }
});
