import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { CliStatus, Settings } from '../shared/types';
import { CodexProtocolParser, MAX_OUTPUT_BYTES, readableDiagnostic } from './protocol';
import type { CodexResult, RunnerEvent } from './protocol';

export type { RunnerEvent } from './protocol';
export const MAX_STDERR_BYTES = 8192;
const CHECK_TIMEOUT_MS = 10_000;
const CHECK_OUTPUT_BYTES = 64 * 1024;

export interface RunOptions {
  settings: Settings;
  sessionId?: string;
  prompt: string;
  images: string[];
  signal: AbortSignal;
  onEvent: (event: RunnerEvent) => void;
}

/** The prompt is deliberately absent: it is written verbatim to stdin. */
export function buildCodexArgs(options: Pick<RunOptions, 'settings' | 'sessionId' | 'images'>): string[] {
  const { settings: { codex }, sessionId, images } = options;
  if (codex.sandbox !== 'read-only' && codex.sandbox !== 'workspace-write') {
    throw new Error('Unsupported Codex sandbox. Choose read-only or workspace-write explicitly.');
  }
  if (sessionId !== undefined && (!sessionId.trim() || sessionId.includes('\0'))) {
    throw new Error('A nonempty Codex session ID is required to resume.');
  }
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', codex.sandbox,
    '-c', 'approval_policy="never"'];
  if (codex.model.trim()) args.push(`--model=${codex.model.trim()}`);
  // Sandbox belongs to exec, not exec resume. Images belong to the resumed turn.
  if (sessionId !== undefined) args.push('resume');
  for (const image of images) {
    if (!image || image.includes('\0')) throw new Error('Invalid Codex image path.');
    args.push(`--image=${image}`);
  }
  // Prevent image varargs or a session name beginning with '-' consuming positionals.
  args.push('--');
  if (sessionId !== undefined) args.push(sessionId);
  args.push('-');
  return args;
}

function target(platform: NodeJS.Platform, arch: string): { triple: string; packageName: string; executable: string } {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : undefined;
  if (!cpu || !['win32', 'linux', 'darwin'].includes(platform)) {
    throw new Error(`Unsupported Codex CLI platform: ${platform}/${arch}.`);
  }
  const suffix = platform === 'win32' ? 'pc-windows-msvc' : platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl';
  return { triple: `${cpu}-${suffix}`, packageName: `codex-${platform === 'win32' ? 'win32' : platform}-${arch}`,
    executable: platform === 'win32' ? 'codex.exe' : 'codex' };
}

/** Support both legacy bundled vendor trees and current optional platform packages. */
export function nativeCodexCandidates(packageRoot: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const { triple, packageName, executable } = target(platform, arch);
  const roots = [packageRoot, p.join(packageRoot, 'node_modules', '@openai', packageName),
    p.join(p.dirname(packageRoot), packageName)];
  return roots.flatMap(root => ['bin', 'codex'].map(dir => p.join(root, 'vendor', triple, dir, executable)));
}

export interface DiscoveryOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  executablePath?: string;
  isExecutable?: (file: string) => Promise<boolean>;
  realPath?: (file: string) => Promise<string>;
}

/** Never run npm/.cmd/.ps1 wrappers or inspect Codex authentication files. */
export async function resolveCodexExecutable(cliPath: string, options: DiscoveryOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const executable = target(platform, arch).executable;
  const canExecute = options.isExecutable ?? (async (file: string) => {
    try { await access(file, platform === 'win32' ? constants.F_OK : constants.X_OK); return true; }
    catch { return false; }
  });
  const canonical = options.realPath ?? realpath;
  const envValue = (name: string): string | undefined => {
    const key = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase());
    return key ? env[key] : undefined;
  };
  const dirs = (envValue('PATH') ?? '').split(platform === 'win32' ? ';' : ':')
    .map(dir => dir.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  const candidates: string[] = [];
  const addPackage = (root: string): void => { candidates.push(...nativeCodexCandidates(root, platform, arch)); };
  const addLocation = (location: string): void => {
    const ext = p.extname(location).toLowerCase();
    if (platform === 'win32' ? ext === '.exe' : !['.cmd', '.bat', '.ps1', '.js', '.mjs'].includes(ext)) {
      candidates.push(location);
    }
    const dir = p.dirname(location);
    addPackage(p.join(dir, 'node_modules', '@openai', 'codex'));
    addPackage(p.join(dir, 'lib', 'node_modules', '@openai', 'codex'));
    // A configured package directory, bin/codex.js, or a symlink into one.
    addPackage(location);
    addPackage(p.dirname(dir));
  };
  const configured = cliPath.trim().replace(/^"(.*)"$/, '$1');
  if (configured.includes('\0')) throw new Error('Invalid Codex CLI path.');
  if (configured) {
    const locations = p.basename(configured) === configured
      ? dirs.map(dir => p.join(dir, configured)) : [p.resolve(configured)];
    for (const location of locations) {
      addLocation(location);
      try { addLocation(await canonical(location)); } catch { /* A shim may be missing while its package still exists. */ }
    }
  } else {
    // Prefer a real native binary on PATH over any npm shim.
    for (const dir of dirs) candidates.push(p.join(dir, executable));
    for (const dir of dirs) {
      addLocation(p.join(dir, platform === 'win32' ? 'codex.cmd' : 'codex'));
      if (platform !== 'win32') {
        try { addLocation(await canonical(p.join(dir, 'codex'))); } catch { /* Not every PATH entry contains Codex. */ }
      }
    }
    const prefixes = [envValue('npm_config_prefix'), envValue('PREFIX'),
      envValue('APPDATA') ? p.join(envValue('APPDATA')!, 'npm') : undefined,
      platform === 'win32' ? p.join(options.homeDirectory ?? homedir(), 'AppData', 'Roaming', 'npm') : '/usr/local',
      p.dirname(options.executablePath ?? process.execPath)];
    for (const prefix of prefixes) {
      if (!prefix) continue;
      candidates.push(p.join(prefix, executable));
      addPackage(p.join(prefix, 'node_modules', '@openai', 'codex'));
      addPackage(p.join(prefix, 'lib', 'node_modules', '@openai', 'codex'));
    }
  }
  for (const candidate of new Set(candidates)) {
    if (await canExecute(candidate)) return candidate;
  }
  throw new Error(configured
    ? `No native Codex executable found for "${configured}". Select codex.exe or an npm codex.cmd with its @openai/codex package installed.`
    : 'Codex CLI was not found. Install @openai/codex or select its codex.exe/codex.cmd in settings.');
}

/** Optional seams allow offline process tests without changing the production API. */
export interface RunnerDependencies {
  spawn?: typeof nodeSpawn;
  resolveExecutable?: (cliPath: string) => Promise<string>;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  taskkillPath?: string;
}

interface TrackedChild {
  child: ChildProcess;
  closed: Promise<void>;
  isClosed: boolean;
  kind: 'cli' | 'killer';
  termination?: Promise<void>;
}
interface ProcessResult { stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }
interface ProcessOptions {
  cwd?: string;
  input?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
  onStdout?: (chunk: Buffer) => void;
}

function abortError(): Error {
  const error = new Error('Codex request was cancelled.');
  error.name = 'AbortError';
  return error;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function withStderr(message: string, stderr: string): string {
  const detail = readableDiagnostic(stderr, MAX_STDERR_BYTES);
  return detail ? `${message}\n${detail}` : message;
}
function tailBuffer(previous: Buffer, chunk: Buffer, limit: number): Buffer {
  return chunk.length >= limit ? Buffer.from(chunk.subarray(-limit))
    : Buffer.concat([previous.subarray(-Math.max(0, limit - chunk.length)), chunk]);
}

export class CodexRunner {
  private readonly spawn: typeof nodeSpawn;
  private readonly resolveExecutable: (cliPath: string) => Promise<string>;
  private readonly platform: NodeJS.Platform;
  private readonly home: string;
  private readonly taskkillPath: string;
  private readonly children = new Set<TrackedChild>();
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;

  constructor(dependencies: RunnerDependencies = {}) {
    this.spawn = dependencies.spawn ?? nodeSpawn;
    this.resolveExecutable = dependencies.resolveExecutable ?? resolveCodexExecutable;
    this.platform = dependencies.platform ?? process.platform;
    this.home = dependencies.homeDirectory ?? homedir();
    this.taskkillPath = dependencies.taskkillPath ?? path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  }

  async test(cliPath: string): Promise<CliStatus> {
    let executable: string | undefined;
    let version: string | undefined;
    let installed = false;
    try {
      this.ensureOpen();
      executable = await this.resolveExecutable(cliPath);
      const check = (args: string[]) => this.execute(executable!, args, {
        cwd: this.home, timeoutMs: CHECK_TIMEOUT_MS, maxOutputBytes: CHECK_OUTPUT_BYTES,
      });
      const result = await check(['--version']);
      const output = readableDiagnostic(result.stdout || result.stderr, 512);
      if (result.code !== 0 || !/^codex(?:-cli)?\s+\d+\.\d+\.\S+/i.test(output)) {
        throw new Error(withStderr('The selected executable did not report a valid Codex CLI version.', result.stderr || result.stdout));
      }
      version = output.split(/\r?\n/)[0];
      installed = true;
      const login = await check(['login', 'status']);
      return {
        installed, authenticated: login.code === 0, path: executable, version,
        message: login.code === 0 ? 'Codex CLI is installed and authenticated.'
          : withStderr('Codex CLI is not authenticated. Run codex login in a terminal.', login.stderr || login.stdout),
      };
    } catch (error) {
      return { installed, authenticated: false, ...(executable ? { path: executable } : {}),
        ...(version ? { version } : {}), message: errorMessage(error) };
    }
  }

  async run(options: RunOptions): Promise<CodexResult> {
    this.ensureOpen();
    if (options.signal.aborted) throw abortError();
    const seconds = options.settings.codex.timeoutSeconds;
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2_147_483_647) {
      throw new Error('Codex timeout must be a positive number of seconds below 2147483.');
    }
    const cwd = options.settings.codex.workingDirectory.trim() || this.home;
    const images = options.images.map(image => {
      if (!image || image.includes('\0')) throw new Error('Invalid Codex image path.');
      return path.resolve(cwd, image);
    });
    const args = buildCodexArgs({ ...options, images });
    const executable = await this.resolveExecutable(options.settings.codex.cliPath);
    this.ensureOpen();
    if (options.signal.aborted) throw abortError();
    const parser = new CodexProtocolParser({
      sessionId: options.sessionId,
      onEvent: event => {
        // Cancellation may happen inside a callback while this JSONL chunk is still being parsed.
        if (!options.signal.aborted && !this.shuttingDown) options.onEvent(event);
      },
    });
    parser.start();
    const result = await this.execute(executable, args, {
      cwd, input: options.prompt, signal: options.signal, timeoutMs: seconds * 1000,
      maxOutputBytes: MAX_OUTPUT_BYTES, onStdout: chunk => parser.push(chunk),
    });
    if (result.code !== 0) {
      throw new Error(withStderr(`Codex CLI exited ${result.signal ? `with signal ${result.signal}` : `with code ${result.code ?? 'unknown'}`}.`, result.stderr));
    }
    try { return parser.finish(); }
    catch (error) { throw new Error(withStderr(errorMessage(error), result.stderr)); }
  }

  /**
   * Parent must prevent the initial Electron before-quit, await this, then reissue quit
   * with a guard: Electron does not await promises returned by async event listeners.
   */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      const active = [...this.children];
      await Promise.all(active.filter(record => record.kind === 'cli').map(record => this.terminate(record)));
      await Promise.all([...this.children].map(record => record.closed));
    })();
    return this.shutdownPromise;
  }

  private ensureOpen(): void {
    if (this.shuttingDown) throw new Error('Codex runner is shutting down.');
  }

  private track(child: ChildProcess, kind: TrackedChild['kind']): TrackedChild {
    let resolveClosed!: () => void;
    const record: TrackedChild = { child, kind, isClosed: false,
      closed: new Promise<void>(resolve => { resolveClosed = resolve; }) };
    this.children.add(record);
    child.once('close', () => {
      record.isClosed = true;
      this.children.delete(record);
      resolveClosed();
    });
    return record;
  }

  private terminate(record: TrackedChild): Promise<void> {
    if (record.isClosed) return Promise.resolve();
    if (record.termination) return record.termination;
    record.termination = (async () => {
      const killDirect = (): void => {
        try {
          if (this.platform !== 'win32' && record.child.pid) {
            try { process.kill(-record.child.pid, 'SIGKILL'); return; } catch { /* Fall back to the direct child. */ }
          }
          record.child.kill('SIGKILL');
        } catch { /* An already exiting process may no longer be killable. Still wait for close. */ }
      };
      if (this.platform === 'win32' && record.child.pid) {
        try {
          const killer = this.spawn(this.taskkillPath, ['/PID', String(record.child.pid), '/T', '/F'], {
            shell: false, windowsHide: true, stdio: 'ignore', timeout: 5000,
          });
          const trackedKiller = this.track(killer, 'killer');
          let failed = false;
          killer.on('error', () => { failed = true; killDirect(); });
          await trackedKiller.closed;
          if (failed || killer.exitCode !== 0) killDirect();
        } catch { killDirect(); }
      } else {
        killDirect();
      }
      await record.closed;
    })();
    return record.termination;
  }

  private execute(executable: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
    this.ensureOpen();
    if (options.signal?.aborted) return Promise.reject(abortError());
    return new Promise<ProcessResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawn(executable, args, {
          shell: false, windowsHide: true, detached: this.platform !== 'win32',
          cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'],
          // Inherit the user's environment/authentication unchanged; never read or copy token files.
        });
      } catch (error) { reject(error); return; }
      const record = this.track(child, 'cli');
      let failure: Error | undefined;
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let outputBytes = 0;
      const fail = (error: Error): void => {
        if (record.isClosed || failure) return;
        failure = error;
        void this.terminate(record);
      };
      const onAbort = (): void => fail(abortError());
      const timer = setTimeout(() => fail(new Error(`Codex CLI timed out after ${options.timeoutMs / 1000} seconds.`)), options.timeoutMs);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const count = (chunk: Buffer): boolean => {
        outputBytes += chunk.length;
        if (outputBytes > options.maxOutputBytes) fail(new Error('Codex CLI output exceeded the size limit.'));
        return !failure;
      };
      child.stdout?.on('data', (chunk: Buffer) => {
        if (!count(chunk)) return;
        try {
          if (options.onStdout) options.onStdout(chunk);
          else stdout = Buffer.concat([stdout, chunk]);
        } catch (error) { fail(new Error(errorMessage(error))); }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = tailBuffer(stderr, chunk, MAX_STDERR_BYTES);
        count(chunk);
      });
      child.stdout?.on('error', error => fail(new Error(`Could not read Codex stdout: ${error.message}`)));
      child.stderr?.on('error', error => fail(new Error(`Could not read Codex stderr: ${error.message}`)));
      child.stdin?.on('error', error => fail(new Error(`Could not write the prompt to Codex stdin: ${error.message}`)));
      child.on('error', error => fail(new Error(`Could not start Codex CLI: ${error.message}`)));
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        const diagnostic = stderr.toString('utf8');
        if (failure) {
          failure.message = withStderr(failure.message, diagnostic);
          reject(failure);
        } else resolve({ stdout: stdout.toString('utf8'), stderr: diagnostic, code, signal });
      });
      if (options.signal?.aborted) onAbort();
      if (!failure) {
        try {
          if (!child.stdin) fail(new Error('Codex CLI stdin is unavailable.'));
          else child.stdin.end(options.input ?? '', 'utf8');
        } catch (error) { fail(new Error(`Could not write the prompt to Codex stdin: ${errorMessage(error)}`)); }
      }
    });
  }
}
