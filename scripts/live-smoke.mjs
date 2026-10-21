import { build } from 'esbuild';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--confirm-usage')) {
  console.log('Usage: node scripts/live-smoke.mjs --confirm-usage');
  console.log('Makes TWO small real Codex requests using your existing authentication and quota.');
  console.log('Sends only synthetic test text, no screenshots or personal files. No tools requested.');
  process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.test-output');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, 'live-codex-'));
const helper = path.join(directory, 'run.cjs');
await build({ stdin: { contents: `
  import { CodexRunner } from './electron/codex';
  import { defaultSettings } from './shared/defaults';
  const runner = new CodexRunner();
  const settings = defaultSettings();
  settings.codex.workingDirectory = ${JSON.stringify(directory)};
  settings.codex.timeoutSeconds = 90;
  const signal = AbortSignal.timeout(100000);
  const statuses = new Set();
  const onEvent = event => { statuses.add(event.type); };
  (async () => {
    try {
      const status = await runner.test('');
      if (!status.authenticated) throw new Error(status.message);
      const first = await runner.run({ settings, signal, images: [], onEvent,
        prompt: 'This is a synthetic connectivity test. Do not use tools or read files. Remember the test word MINT. Reply with exactly: CODEX_OVERLAY_OK' });
      if (!first.text.includes('CODEX_OVERLAY_OK') || !first.sessionId) throw new Error('Unexpected first response or missing session ID');
      const second = await runner.run({ settings, signal, images: [], onEvent, sessionId: first.sessionId,
        prompt: 'Do not use any tools. What test word did I give you in my previous message? Reply with only that word.' });
      if (!second.text.includes('MINT')) throw new Error('Session resume did not preserve the test word');
      console.log(JSON.stringify({ result: 'PASS', cli: status.version, reply: first.text, resumedReply: second.text, eventTypes: [...statuses] }));
    } finally { await runner.shutdown(); }
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
`, resolveDir: root, loader: 'ts' }, outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: 'node24' });
let code;
try {
  code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper], { stdio: 'inherit', windowsHide: true, shell: false });
    child.once('error', reject);
    child.once('close', status => resolve(status ?? 1));
  });
} finally { await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
process.exitCode = code;
