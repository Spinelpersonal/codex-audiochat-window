import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../shared/defaults';
import { buildCodexArgs, CodexRunner, MAX_STDERR_BYTES, nativeCodexCandidates, resolveCodexExecutable, type RunOptions } from '../electron/codex';
import { MAX_OUTPUT_BYTES, type RunnerEvent } from '../electron/protocol';

const jsonl = (...events: unknown[]): string => events.map(event => JSON.stringify(event) + '\n').join('');
const answer = (text = 'Hello 👋') => ({ type: 'item.completed', item: { type: 'agent_message', id: 'answer', text } });
const completed = { type: 'turn.completed' };
const runners: CodexRunner[] = [];

afterEach(async () => {
  await Promise.all(runners.splice(0).map(runner => runner.shutdown()));
});

class FakeChild extends EventEmitter {
  readonly pid: number;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  input = '';
  readonly stdin = new Writable({ write: (chunk, _encoding, callback) => {
    this.input += chunk.toString('utf8');
    callback();
  } });
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  closed = false;
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => {
    this.close(null, 'SIGKILL');
    return true;
  });

  constructor(pid: number) { super(); this.pid = pid; }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.exit(code, signal);
    this.emit('close', code, signal);
  }
}

type Plan = (child: FakeChild, args: string[], options: SpawnOptions) => void;
function harness(plans: Plan[] = [], config: { autoKill?: boolean; killerFailure?: boolean; holdKillerClose?: boolean } = {}) {
  const children: FakeChild[] = [];
  const killers: FakeChild[] = [];
  const calls: { file: string; args: string[]; options: SpawnOptions }[] = [];
  const spawn = vi.fn((file: string, args: string[], options: SpawnOptions) => {
    const child = new FakeChild(1000 + calls.length);
    calls.push({ file, args, options });
    if (file.endsWith('taskkill.exe')) {
      killers.push(child);
      queueMicrotask(() => {
        if (config.killerFailure) {
          child.emit('error', new Error('taskkill missing'));
          child.close(1);
        } else {
          if (config.autoKill !== false) {
            children.find(candidate => String(candidate.pid) === args[1])?.close(null, 'SIGKILL');
          }
          if (!config.holdKillerClose) child.close(0);
        }
      });
    } else {
      children.push(child);
      const plan = plans.shift();
      queueMicrotask(() => plan?.(child, args, options));
    }
    return child as unknown as ChildProcess;
  });
  const resolveExecutable = vi.fn(async () => 'C:\\Codex & tools\\codex.exe');
  const runner = new CodexRunner({ spawn: spawn as unknown as typeof nodeSpawn, resolveExecutable,
    platform: 'win32', homeDirectory: process.cwd(), taskkillPath: 'C:\\Windows\\System32\\taskkill.exe' });
  runners.push(runner);
  return { runner, children, killers, calls, spawn, resolveExecutable };
}

function runOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return { settings: defaultSettings(), prompt: 'A prompt', images: [],
    signal: new AbortController().signal, onEvent: () => {}, ...overrides };
}

async function tick(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }

function discovery(existing: string[], extra: Parameters<typeof resolveCodexExecutable>[1] = {}) {
  return { platform: 'win32' as const, arch: 'x64', env: {} as NodeJS.ProcessEnv,
    homeDirectory: 'C:\\Users\\Me', executablePath: 'C:\\App\\electron.exe',
    realPath: async (file: string) => file,
    isExecutable: async (file: string) => existing.includes(file), ...extra };
}

describe('buildCodexArgs', () => {
  it('uses the safe explicit sandbox and never-approval policy with stdin', () => {
    const args = buildCodexArgs(runOptions());
    expect(args).toEqual(['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only',
      '-c', 'approval_policy="never"', '--', '-']);
    expect(args).not.toContain('--full-auto');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it.each(['read-only', 'workspace-write'] as const)('keeps never-approval without bypass flags in %s for new and resumed turns', sandbox => {
    const settings = defaultSettings();
    settings.codex.sandbox = sandbox;
    for (const sessionId of [undefined, 'existing-session']) {
      const args = buildCodexArgs(runOptions({ settings, sessionId }));
      expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual(['--sandbox', sandbox]);
      expect(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2)).toEqual(['-c', 'approval_policy="never"']);
      expect(args.filter(value => value === 'approval_policy="never"')).toHaveLength(1);
      expect(args).not.toContain('--full-auto');
      expect(args).not.toContain('--approve-for-me');
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(args).not.toContain('--dangerously-bypass-hook-trust');
      if (sessionId) expect(args.indexOf('--sandbox')).toBeLessThan(args.indexOf('resume'));
    }
  });

  it('places sandbox before resume and attaches images to the resumed turn', () => {
    const settings = defaultSettings();
    settings.codex.sandbox = 'workspace-write';
    settings.codex.model = 'test-model';
    const args = buildCodexArgs(runOptions({ settings, sessionId: '--last', images: ['C:\\a b\\one.png', 'C:\\two.png'] }));
    expect(args).toEqual(['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write',
      '-c', 'approval_policy="never"', '--model=test-model', 'resume', '--image=C:\\a b\\one.png',
      '--image=C:\\two.png', '--', '--last', '-']);
  });

  it('treats flag-looking model/image values as data, not additional switches', () => {
    const settings = defaultSettings();
    settings.codex.model = '--dangerously-bypass-approvals-and-sandbox';
    const args = buildCodexArgs(runOptions({ settings, images: ['--full-auto'] }));
    expect(args).toContain('--model=--dangerously-bypass-approvals-and-sandbox');
    expect(args).toContain('--image=--full-auto');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--full-auto');
  });

  it('rejects unsafe sandbox values, blank session IDs and NUL paths', () => {
    const options = runOptions();
    (options.settings.codex as { sandbox: string }).sandbox = 'danger-full-access';
    expect(() => buildCodexArgs(options)).toThrow('Unsupported Codex sandbox');
    expect(() => buildCodexArgs(runOptions({ sessionId: ' ' }))).toThrow('nonempty');
    expect(() => buildCodexArgs(runOptions({ images: ['bad\0path'] }))).toThrow('image path');
  });
});

describe('native CLI discovery', () => {
  it('finds the installed npm nested platform layout without running its .cmd', async () => {
    const root = 'C:\\Users\\School\\AppData\\Roaming\\npm';
    const executable = path.win32.join(root, 'node_modules', '@openai', 'codex', 'node_modules', '@openai',
      'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
    expect(await resolveCodexExecutable(path.win32.join(root, 'codex.cmd'), discovery([executable]))).toBe(executable);
  });

  it('supports legacy vendor/codex, modern vendor/bin and hoisted platform packages', async () => {
    const root = 'D:\\npm\\node_modules\\@openai\\codex';
    const candidates = nativeCodexCandidates(root, 'win32', 'x64');
    for (const executable of candidates) {
      expect(await resolveCodexExecutable('D:\\npm\\codex.cmd', discovery([executable]))).toBe(executable);
    }
    expect(candidates).toContain(path.win32.join(root, 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'));
  });

  it('prefers PATH native executables, including case-insensitive/quoted Windows PATH entries', async () => {
    const executable = 'D:\\Native Tools\\codex.exe';
    const npmExecutable = nativeCodexCandidates('D:\\npm\\node_modules\\@openai\\codex', 'win32', 'x64')[0];
    expect(await resolveCodexExecutable('', discovery([executable, npmExecutable], {
      env: { Path: '"D:\\Native Tools";D:\\npm' },
    }))).toBe(executable);
  });

  it.each([
    { npm_config_prefix: 'D:\\Custom Npm' },
    { NPM_CONFIG_PREFIX: 'D:\\Custom Npm' },
    { APPDATA: 'D:\\Profile', expectedPrefix: 'D:\\Profile\\npm' },
  ])('discovers npm prefix/AppData package roots', async ({ expectedPrefix, ...env }) => {
    const prefix = expectedPrefix ?? 'D:\\Custom Npm';
    const executable = nativeCodexCandidates(path.win32.join(prefix, 'node_modules', '@openai', 'codex'), 'win32', 'x64')[2];
    expect(await resolveCodexExecutable('', discovery([executable], { env }))).toBe(executable);
  });

  it('accepts a quoted configured executable and does not silently use a different CLI', async () => {
    const executable = 'D:\\My Tools\\codex.exe';
    expect(await resolveCodexExecutable(`"${executable}"`, discovery([executable]))).toBe(executable);
    await expect(resolveCodexExecutable('D:\\missing\\codex.cmd', discovery([executable], {
      env: { PATH: 'D:\\My Tools' },
    }))).rejects.toThrow('No native Codex executable');
  });

  it('never returns an existing cmd/bat/ps1/js shim as a Windows executable', async () => {
    for (const ext of ['cmd', 'bat', 'ps1', 'js']) {
      const wrapper = `D:\\npm\\codex.${ext}`;
      await expect(resolveCodexExecutable(wrapper, discovery([wrapper]))).rejects.toThrow('No native');
    }
  });

  it('supports configured bare names, arm64 and a configured package bin script', async () => {
    const executable = nativeCodexCandidates('D:\\npm\\node_modules\\@openai\\codex', 'win32', 'arm64')[2];
    const options = discovery([executable], { arch: 'arm64', env: { PATH: 'D:\\npm' } });
    expect(await resolveCodexExecutable('codex.cmd', options)).toBe(executable);
    expect(await resolveCodexExecutable('D:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', options)).toBe(executable);
  });

  it('reports missing installations and unsupported architectures', async () => {
    await expect(resolveCodexExecutable('', discovery([]))).rejects.toThrow('was not found');
    expect(() => nativeCodexCandidates('root', 'win32', 'ia32')).toThrow('Unsupported');
    await expect(resolveCodexExecutable('bad\0path', discovery([]))).rejects.toThrow('Invalid');
  });
});

describe('CodexRunner.run', () => {
  it('streams snapshots, preserves sessions and sends hostile Unicode prompts only through stdin', async () => {
    const events: RunnerEvent[] = [];
    const prompt = '中文 👋\r\n& calc.exe | echo %TOKEN% $(do-not-run) "quotes"';
    const h = harness([(child, args, options) => {
      expect(child.input).toBe(prompt);
      expect(args).not.toContain(prompt);
      expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      expect(options).not.toHaveProperty('env');
      const output = Buffer.from(jsonl({ type: 'thread.started', thread_id: 'session-1' },
        { type: 'turn.started' }, answer(), answer(), completed));
      for (const byte of output) child.stdout.write(Buffer.from([byte]));
      child.close();
    }]);
    const result = await h.runner.run(runOptions({ prompt, onEvent: event => events.push(event) }));
    expect(result).toEqual({ text: 'Hello 👋', sessionId: 'session-1' });
    expect(events.filter(event => event.type === 'text')).toEqual([{ type: 'text', text: 'Hello 👋' }]);
    expect(h.calls[0].file).toBe('C:\\Codex & tools\\codex.exe');
  });

  it('uses the configured working directory, absolute image paths and an existing session', async () => {
    const h = harness([(child) => { child.stdout.write(jsonl(answer('resumed'), completed)); child.close(); }]);
    const settings = defaultSettings();
    settings.codex.workingDirectory = process.cwd();
    const result = await h.runner.run(runOptions({ settings, sessionId: 'existing', images: ['one image.png'] }));
    expect(result).toEqual({ text: 'resumed', sessionId: 'existing' });
    expect(h.calls[0].options.cwd).toBe(process.cwd());
    expect(h.calls[0].args).toContain(`--image=${path.resolve(process.cwd(), 'one image.png')}`);
    expect(h.calls[0].args.slice(-3)).toEqual(['--', 'existing', '-']);
  });

  it('rejects exit 0 without turn.completed and includes stderr', async () => {
    const h = harness([child => {
      child.stdout.write(jsonl(answer('partial')));
      child.stderr.write('unexpected disconnect');
      child.close();
    }]);
    await expect(h.runner.run(runOptions())).rejects.toThrow(/missing turn.completed.*\nunexpected disconnect/);
  });

  it('rejects a nonzero exit even after turn.completed and keeps bounded stderr tail', async () => {
    const h = harness([child => {
      child.stdout.write(jsonl(completed));
      child.stderr.write('ignored prefix ' + 'x'.repeat(MAX_STDERR_BYTES * 2) + '\nReadable failure');
      child.close(7);
    }]);
    const error = await h.runner.run(runOptions()).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected the CLI failure to reject.');
    expect(error.message).toContain('code 7');
    expect(error.message).toContain('Readable failure');
    expect(error.message).not.toContain('ignored prefix');
    expect(error.message.length).toBeLessThan(MAX_STDERR_BYTES + 100);
  });

  it.each([
    jsonl({ type: 'turn.failed', error: { message: 'Denied by policy' } }),
    jsonl({ type: 'error', message: 'Denied by policy' }),
    'invalid JSON\n',
  ])('kills and rejects protocol errors without relying on exit status', async output => {
    const h = harness([child => { child.stdout.write(output); }]);
    await expect(h.runner.run(runOptions())).rejects.toThrow(/Denied by policy|Invalid Codex CLI JSONL/);
    expect(h.killers).toHaveLength(1);
  });

  it('handles errors emitted by stdin and by the process', async () => {
    const stdin = harness([child => { child.stdin.emit('error', new Error('EPIPE')); }]);
    await expect(stdin.runner.run(runOptions())).rejects.toThrow('stdin: EPIPE');
    const process = harness([child => { child.emit('error', new Error('ENOENT')); child.close(-1); }]);
    await expect(process.runner.run(runOptions())).rejects.toThrow('Could not start Codex CLI: ENOENT');
  });

  it('handles a synchronous spawn failure', async () => {
    const runner = new CodexRunner({ resolveExecutable: async () => 'codex.exe',
      spawn: (() => { throw new Error('spawn failed'); }) as unknown as typeof nodeSpawn });
    runners.push(runner);
    await expect(runner.run(runOptions())).rejects.toThrow('spawn failed');
  });

  it('aborts before discovery/spawn when already cancelled', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(h.runner.run(runOptions({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.resolveExecutable).not.toHaveBeenCalled();
  });

  it('rechecks cancellation and shutdown after asynchronous discovery', async () => {
    let discovered!: (file: string) => void;
    const h = harness();
    h.resolveExecutable.mockImplementationOnce(() => new Promise<string>(resolve => { discovered = resolve; }));
    const controller = new AbortController();
    const pending = h.runner.run(runOptions({ signal: controller.signal }));
    controller.abort();
    discovered('codex.exe');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('aborts via hidden shell-free taskkill /T /F and waits for close, not exit', async () => {
    const h = harness([], { autoKill: false });
    const controller = new AbortController();
    let settled = false;
    const pending = h.runner.run(runOptions({ signal: controller.signal })).catch(error => { settled = true; return error as Error; });
    await tick();
    h.children[0].exit(0);
    controller.abort();
    await tick();
    const call = h.calls[1];
    expect(call).toMatchObject({ file: 'C:\\Windows\\System32\\taskkill.exe',
      args: ['/PID', String(h.children[0].pid), '/T', '/F'], options: { shell: false, windowsHide: true } });
    expect(settled).toBe(false);
    h.children[0].close(null, 'SIGKILL');
    expect(await pending).toMatchObject({ name: 'AbortError' });
  });

  it('falls back to child.kill if taskkill fails', async () => {
    const h = harness([], { killerFailure: true });
    const controller = new AbortController();
    const pending = h.runner.run(runOptions({ signal: controller.signal })).catch(error => error);
    await tick();
    controller.abort();
    await expect(pending).resolves.toMatchObject({ name: 'AbortError' });
    expect(h.children[0].kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('enforces timeout and caps noisy stdout/stderr', async () => {
    const timeout = harness();
    const settings = defaultSettings();
    settings.codex.timeoutSeconds = 0.01;
    await expect(timeout.runner.run(runOptions({ settings }))).rejects.toThrow('timed out');
    for (const stream of ['stdout', 'stderr'] as const) {
      const noise = harness([child => { child[stream].write(Buffer.alloc(MAX_OUTPUT_BYTES + 1, 120)); }]);
      await expect(noise.runner.run(runOptions())).rejects.toThrow('output exceeded');
    }
  });

  it.each([0, -1, NaN, Infinity, 3_000_000])('rejects invalid timeout %s before spawning', async timeoutSeconds => {
    const h = harness();
    const settings = defaultSettings();
    settings.codex.timeoutSeconds = timeoutSeconds;
    await expect(h.runner.run(runOptions({ settings }))).rejects.toThrow('timeout must be');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it.each(['abort', 'shutdown'] as const)('suppresses remaining events in an already-buffered chunk after %s', async action => {
    const h = harness([child => {
      child.stdout.write(jsonl({ type: 'thread.started', thread_id: 'new-session' }, answer('late answer'), completed));
    }]);
    const controller = new AbortController();
    const events: RunnerEvent[] = [];
    let shutdown: Promise<void> | undefined;
    const pending = h.runner.run(runOptions({ signal: controller.signal, onEvent: event => {
      events.push(event);
      if (event.type !== 'session') return;
      if (action === 'abort') controller.abort();
      else shutdown = h.runner.shutdown();
    } })).catch(error => error);
    expect(await pending).toBeInstanceOf(Error);
    await shutdown;
    expect(events).toEqual([{ type: 'status', status: 'thinking' }, { type: 'session', sessionId: 'new-session' }]);
  });

  it('terminates if the event consumer throws and removes abort listeners on normal close', async () => {
    const consumer = harness([child => { child.stdout.write(jsonl(answer())); }]);
    await expect(consumer.runner.run(runOptions({ onEvent: event => {
      if (event.type === 'text') throw new Error('consumer failed');
    } }))).rejects.toThrow('consumer failed');
    const controller = new AbortController();
    const normal = harness([child => { child.stdout.write(jsonl(completed)); child.close(); }]);
    await normal.runner.run(runOptions({ signal: controller.signal }));
    controller.abort();
    await tick();
    expect(normal.killers).toHaveLength(0);
  });
});

describe('CodexRunner.test', () => {
  it('checks --version then login status, trusting the status exit code only', async () => {
    const h = harness([
      child => { child.stdout.write('codex-cli 0.163.0\n'); child.close(); },
      child => { child.stderr.write('Logged in using ChatGPT\n'); child.close(); },
    ]);
    await expect(h.runner.test('C:\\npm\\codex.cmd')).resolves.toEqual({ installed: true, authenticated: true,
      path: 'C:\\Codex & tools\\codex.exe', version: 'codex-cli 0.163.0', message: 'Codex CLI is installed and authenticated.' });
    expect(h.calls.map(call => call.args)).toEqual([['--version'], ['login', 'status']]);
    expect(h.calls.every(call => call.options.shell === false && call.options.windowsHide)).toBe(true);
  });

  it('does not infer authentication from token-looking output or successful version detection', async () => {
    const h = harness([
      child => { child.stdout.write('codex-cli 0.163.0\n'); child.close(); },
      child => { child.stderr.write('not logged in'); child.close(1); },
    ]);
    await expect(h.runner.test('')).resolves.toMatchObject({ installed: true, authenticated: false,
      version: 'codex-cli 0.163.0', message: expect.stringContaining('codex login') });
  });

  it('reports discovery/version failures as statuses, not thrown promises', async () => {
    const missing = harness();
    missing.resolveExecutable.mockRejectedValueOnce(new Error('not installed'));
    await expect(missing.runner.test('')).resolves.toEqual({ installed: false, authenticated: false, message: 'not installed' });
    const invalid = harness([child => { child.stdout.write('some other program'); child.close(); }]);
    await expect(invalid.runner.test('')).resolves.toMatchObject({ installed: false, authenticated: false,
      message: expect.stringContaining('valid Codex CLI version') });
    expect(invalid.calls).toHaveLength(1);
  });
});

describe('real offline Node processes', () => {
  function fixture(script: string) {
    let child: ChildProcess | undefined;
    let closed = false;
    const spawn = ((file: string, args: string[], options: SpawnOptions) => {
      if (file !== 'fixture-codex') return nodeSpawn(file, args, options);
      child = nodeSpawn(process.execPath, ['-e', script, '--', ...args], options);
      child.once('close', () => { closed = true; });
      return child;
    }) as unknown as typeof nodeSpawn;
    const runner = new CodexRunner({ spawn, resolveExecutable: async () => 'fixture-codex', homeDirectory: process.cwd() });
    runners.push(runner);
    const settings = defaultSettings();
    settings.codex.timeoutSeconds = 5;
    return { runner, settings, isClosed: () => closed, child: () => child };
  }

  it('writes stdin through real pipes and decodes asynchronously fragmented UTF-8 JSONL', async () => {
    const h = fixture(`
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { input += chunk; });
      process.stdin.on('end', () => {
        const events = [
          { type: 'thread.started', thread_id: 'fixture-session' },
          { type: 'item.completed', item: { type: 'agent_message', id: 'a', text: input } },
          { type: 'turn.completed' }
        ];
        const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\\n'));
        let position = 0;
        function flush() {
          if (position === bytes.length) return;
          process.stdout.write(bytes.subarray(position, ++position));
          setImmediate(flush);
        }
        flush();
      });
    `);
    const prompt = 'Grüße 👋 中文\n& echo never executed';
    await expect(h.runner.run(runOptions({ settings: h.settings, prompt }))).resolves.toEqual({ text: prompt, sessionId: 'fixture-session' });
    expect(h.isClosed()).toBe(true);
  });

  it('shutdown closes a real local process tree, including inherited stdout pipes', async () => {
    const descendant = "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: String(process.pid) }) + '\\n'); setInterval(() => {}, 1000);";
    const h = fixture(`
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
        shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit']
      });
      setInterval(() => {}, 1000);
    `);
    let announce!: (pid: number) => void;
    const ready = new Promise<number>(resolve => { announce = resolve; });
    const pending = h.runner.run(runOptions({ settings: h.settings,
      onEvent: event => { if (event.type === 'session') announce(Number(event.sessionId)); },
    })).catch(error => error);
    const pid = await Promise.race([ready, pending.then(() => { throw new Error('Fixture closed before its descendant was ready.'); })]);
    let emergencyCleanup = false;
    const cleanup = setTimeout(() => {
      emergencyCleanup = true;
      try { process.kill(pid, 'SIGKILL'); } catch { /* A failed assertion must not leave the fixture running. */ }
      h.child()?.kill('SIGKILL');
    }, 6000);
    try {
      await h.runner.shutdown();
      expect(await pending).toBeInstanceOf(Error);
      expect(h.isClosed()).toBe(true);
      expect(emergencyCleanup).toBe(false);
    } finally { clearTimeout(cleanup); }
  });

  it('cancels a real local fixture process and waits for its pipes to close', async () => {
    const h = fixture(`
      process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'ready' }) + '\\n');
      setInterval(() => {}, 1000);
    `);
    const controller = new AbortController();
    await expect(h.runner.run(runOptions({ settings: h.settings, signal: controller.signal,
      onEvent: event => { if (event.type === 'session') controller.abort(); },
    }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.isClosed()).toBe(true);
    expect(h.child()?.exitCode !== null || h.child()?.signalCode !== null).toBe(true);
  });
});

describe('CodexRunner.shutdown', () => {
  it('terminates concurrent children, including exited but not closed processes, and is idempotent', async () => {
    const h = harness([], { autoKill: false });
    const one = h.runner.run(runOptions()).catch(error => error);
    const two = h.runner.run(runOptions()).catch(error => error);
    await tick();
    h.children[0].exit(0);
    let closed = false;
    const shutdown = h.runner.shutdown();
    shutdown.then(() => { closed = true; });
    expect(h.runner.shutdown()).toBe(shutdown);
    await tick();
    expect(h.killers).toHaveLength(2);
    expect(closed).toBe(false);
    h.children[0].close(null, 'SIGKILL');
    h.children[1].close(null, 'SIGKILL');
    await shutdown;
    expect(closed).toBe(true);
    expect(await one).toBeInstanceOf(Error);
    expect(await two).toBeInstanceOf(Error);
    await expect(h.runner.run(runOptions())).rejects.toThrow('shutting down');
    await expect(h.runner.test('')).resolves.toMatchObject({ installed: false, authenticated: false,
      message: expect.stringContaining('shutting down') });
  });

  it('waits for an already-started taskkill helper to close even after the CLI closes', async () => {
    const h = harness([], { holdKillerClose: true });
    const controller = new AbortController();
    const pending = h.runner.run(runOptions({ signal: controller.signal })).catch(error => error);
    await tick();
    controller.abort();
    expect(await pending).toMatchObject({ name: 'AbortError' });
    h.killers[0].exit(0);
    let settled = false;
    const shutdown = h.runner.shutdown().then(() => { settled = true; });
    try {
      await tick();
      expect(settled).toBe(false);
    } finally {
      h.killers[0].close(0);
      await shutdown;
    }
    expect(settled).toBe(true);
  });

  it('does not spawn after shutdown happens during discovery', async () => {
    let discovered!: (file: string) => void;
    const h = harness();
    h.resolveExecutable.mockImplementationOnce(() => new Promise<string>(resolve => { discovered = resolve; }));
    const pending = h.runner.run(runOptions());
    await h.runner.shutdown();
    discovered('codex.exe');
    await expect(pending).rejects.toThrow('shutting down');
    expect(h.spawn).not.toHaveBeenCalled();
  });
});
