// Offline browser integration tests. Test fixtures are injected through CDP, never bundled into the app.
// Run after vite build: node src/renderer.smoke.mjs [--screenshot] [--dev]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSettings } from '../shared/defaults.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const browser = [process.env.CHROME_PATH, ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean).flatMap((base) => [path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe')])].find((file) => file && existsSync(file));
if (!browser) throw new Error('Set CHROME_PATH to a Chromium browser to run the offline renderer smoke tests.');
if (!existsSync(path.join(dist, 'index.html'))) throw new Error('Build the renderer before running smoke tests.');
const profile = await mkdtemp(path.join(root, 'src', '.smoke-profile-'));
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const target = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!target.startsWith(`${dist}${path.sep}`)) { response.writeHead(403).end(); return; }
  try {
    const content = await readFile(target);
    response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(target)] ?? 'application/octet-stream' });
    response.end(content);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const devServer = process.argv.includes('--dev') ? await (await import('vite')).createServer({ server: { watch: { ignored: ['**/.smoke-profile-*/**'] } } }) : null;
if (devServer) await devServer.listen();
const url = devServer ? 'http://127.0.0.1:5173/' : `http://127.0.0.1:${server.address().port}/`;
const child = spawn(browser, ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--metrics-recording-only', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let nextId = 0, buffer = '';
const pending = new Map();
const runtimeErrors = [];
const remoteRequests = [];
child.stdio[4].on('data', (chunk) => {
  buffer += chunk.toString();
  for (let index; (index = buffer.indexOf('\0')) >= 0;) {
    const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    if (message.id) {
      const job = pending.get(message.id);
      if (job) { pending.delete(message.id); clearTimeout(job.timer); message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result); }
    }
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === 'Network.requestWillBeSent' && /^https?:/.test(message.params.request.url) && !message.params.request.url.startsWith(url)) remoteRequests.push(message.params.request.url);
  }
});
function rpc(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });
}
let session;
async function evaluate(expression) {
  const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function wait(expression, label = expression) {
  for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await new Promise((resolve) => setTimeout(resolve, 40)); }
  throw new Error(`Timed out: ${label}`);
}
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const clickText = (selector, text) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)}).click()`);
const fill = (selector, value) => evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const select = (selector, value) => evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const keyboard = (key, extras = {}) => evaluate(`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ key, bubbles: true, cancelable: true, ...extras })}))`);
function fixture(settings) {
  let saved = settings, counter = 0, attachmentCounter = 0;
  const listeners = new Set(), conversations = new Map(), calls = [];
  const emit = (event) => { for (const listener of listeners) listener(structuredClone(event)); };
  const cli = { installed: true, authenticated: true, message: 'Test CLI connected', version: 'test' };
  const attachment = () => ({ id: `file-${++attachmentCounter}`, name: 'context.txt', kind: 'text', size: 42, preview: 'Offline test attachment' });
  const make = (mode, messages = []) => ({ id: `conversation-${++counter}`, title: 'Test conversation', mode, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages });
  const canonical = (conversation) => { conversations.set(conversation.id, conversation); emit({ type: 'conversation', conversation }); };
  window.__smoke = {
    calls, emit, delayNew: false, saveFails: false,
    finish(id, text) {
      const c = conversations.get(id); const last = c.messages[c.messages.length - 1];
      last.text = text; last.status = 'complete'; canonical(c); emit({ type: 'request', conversationId: id, status: 'completed', text });
    },
    automatic(mode = 'region') {
      const c = make(mode, [{ id: 'automatic-answer', role: 'assistant', text: '', status: 'pending', createdAt: new Date().toISOString() }]);
      canonical(c); emit({ type: 'request', conversationId: c.id, status: 'responding', text: 'Automatic result' }); return c.id;
    },
  };
  window.overlay = {
    async bootstrap() { await new Promise((r) => setTimeout(r, 30)); canonical(make('chat')); return { settings: saved, conversations: [], cli, platform: 'win32', version: 'test' }; },
    onEvent(callback) { listeners.add(callback); return () => { listeners.delete(callback); calls.push(['cleanup']); }; },
    async newConversation(mode) {
      calls.push(['new', mode]); const c = make(mode); canonical(c);
      if (window.__smoke.delayNew) await new Promise((resolve) => { window.__smoke.resolveNew = resolve; });
      return structuredClone(c);
    },
    async send(input) {
      calls.push(['send', input]); const c = conversations.get(input.conversationId);
      c.messages.push({ id: `user-${calls.length}`, role: 'user', text: input.text, createdAt: new Date().toISOString() }, { id: `answer-${calls.length}`, role: 'assistant', text: '', status: 'pending', createdAt: new Date().toISOString() });
      canonical(c); emit({ type: 'request', conversationId: c.id, status: 'starting' });
      emit({ type: 'request', conversationId: c.id, status: 'responding', text: 'First' });
    },
    async cancel(id) { calls.push(['cancel', id]); const c = conversations.get(id); c.messages[c.messages.length - 1].status = 'cancelled'; canonical(c); emit({ type: 'request', conversationId: id, status: 'cancelled', text: 'Stopped result' }); },
    async capture(mode) { calls.push(['capture', mode]); emit({ type: 'attachments', mode, attachments: [attachment()], newConversation: true }); },
    async chooseFiles() { calls.push(['chooseFiles']); return [attachment()]; },
    async dropFiles(files) { calls.push(['dropFiles', files.map((file) => file.name)]); await new Promise((resolve) => setTimeout(resolve, 15)); return [attachment()]; },
    async releaseAttachments(ids) { calls.push(['release', ids]); },
    async copy(text) { calls.push(['copy', text]); },
    async speak(text) { calls.push(['speak', text]); emit({ type: 'speech', active: true }); },
    async stopSpeech() { calls.push(['stopSpeech']); emit({ type: 'speech', active: false }); },
    async voices() { calls.push(['voices']); return [{ id: 'voice-one', name: 'Native test voice', language: 'en-US' }]; },
    async saveSettings(next) { calls.push(['save', next]); if (window.__smoke.saveFails) throw new Error('Windows shortcut conflict'); saved = structuredClone(next); emit({ type: 'settings', settings: saved }); return saved; },
    async testCli() { calls.push(['testCli', saved.codex.cliPath]); return cli; },
    async selectDirectory() { return null; }, async selectCli() { return null; },
    async windowAction(action) { calls.push(['windowAction', action]); },
    async renameConversation(id, title) { calls.push(['rename', id, title]); const c = conversations.get(id); c.title = title; canonical(c); },
    async deleteConversation(id) { calls.push(['delete', id]); conversations.delete(id); },
    async exportConversation(id) { calls.push(['export', id]); },
  };
}

try {
  const { targetId } = await rpc('Target.createTarget', { url: 'about:blank' });
  session = (await rpc('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await rpc('Page.enable', {}, session); await rpc('Runtime.enable', {}, session); await rpc('Network.enable', {}, session);
  await rpc('Emulation.setDeviceMetricsOverride', { width: 920, height: 780, deviceScaleFactor: 1, mobile: false }, session);
  await rpc('Page.navigate', { url }, session);
  await wait(`!!document.querySelector('.desktop-required')`, 'desktop-required fallback');
  assert.match(await evaluate('document.body.textContent'), /desktop|Desktop/);
  console.log('PASS missing-bridge page');

  const settings = defaultSettings(); settings.general.language = 'en';
  await rpc('Page.addScriptToEvaluateOnNewDocument', { source: `(${fixture.toString()})(${JSON.stringify(settings)})` }, session);
  await rpc('Page.reload', {}, session);
  await wait(`!!document.querySelector('.composer textarea')`, 'bootstrap');
  assert.equal(await evaluate(`document.querySelectorAll('.conversation-item').length`), 1);
  await fill('.composer textarea', 'Explain this');
  await evaluate(`document.querySelector('[aria-label="Send message"]').click();document.querySelector('[aria-label="Send message"]')?.click();`);
  await wait(`document.querySelector('.message-assistant')?.textContent.includes('First')`, 'first streaming snapshot');
  assert.equal(await evaluate(`__smoke.calls.filter(c=>c[0]==='send').length`), 1);
  const conversationId = await evaluate(`__smoke.calls.find(c=>c[0]==='send')[1].conversationId`);
  await evaluate(`__smoke.emit({type:'request',conversationId:${JSON.stringify(conversationId)},status:'responding',text:'First second'})`);
  await wait(`document.querySelector('.message-assistant .markdown')?.textContent==='First second'`, 'replacement snapshot');
  await fill('.composer textarea', 'Keep my draft');
  const markdown = 'A complete answer\n\n| Item | Value |\n| --- | --- |\n| A | 1 |\n\n```js\nconst answer = 42;\n```\n\n![remote](https://example.invalid/tracker.png)\n\n![reference][remote]\n\n[remote]: https://example.invalid/reference.png\n\n<img src="https://example.invalid/raw.png"><picture><source srcset="https://example.invalid/source.png"></picture>';
  await evaluate(`__smoke.finish(${JSON.stringify(conversationId)},${JSON.stringify(markdown)})`);
  await wait(`!!document.querySelector('.markdown table') && !!document.querySelector('.hljs-keyword')`, 'Markdown table and syntax highlighting');
  assert.equal(await evaluate(`document.querySelector('.composer textarea').value`), 'Keep my draft');
  assert.equal(await evaluate(`document.querySelectorAll('.markdown img, .markdown picture, .markdown source').length`), 0);
  await click('[aria-label="Copy code"]');
  await wait(`__smoke.calls.some(c=>c[0]==='copy'&&c[1]==='const answer = 42;')`, 'code copy');
  console.log('PASS immediate send, duplicate lock, snapshots, Markdown, draft editing, code copy');
  await click('.conversation-actions [aria-label="Rename"]');
  await fill('#conversation-title', 'Renamed by test');
  await click('.modal-actions .primary');
  await wait(`document.querySelector('.conversation-select')?.textContent.includes('Renamed by test')`, 'canonical rename');
  await click('.conversation-actions [aria-label="Export Markdown"]');
  await wait(`__smoke.calls.some(c=>c[0]==='export')`, 'native export');
  await click('.conversation-actions [aria-label="Delete"]');
  await click('.modal-actions .danger');
  await wait(`document.querySelectorAll('.conversation-item').length===0`, 'delete confirmation');
  console.log('PASS visible rename, export, and delete actions');

  await click('.window-controls [aria-label="Settings"]');
  await clickText('.settings-tabs button', 'Codex');
  const cliSelector = await evaluate(`'#'+[...document.querySelectorAll('.field')].find(e=>e.querySelector('label').textContent==='Codex executable').querySelector('input').id.replaceAll(':','\\:')`);
  await fill(cliSelector, 'C:\\new-codex.exe');
  await evaluate(`__smoke.emit({type:'focus'})`);
  await wait(`!document.querySelector('.workspace').hidden&&document.activeElement===document.querySelector('.composer textarea')`, 'focus event');
  await click('.window-controls [aria-label="Settings"]');
  await clickText('.settings-tabs button', 'Codex');
  assert.equal(await evaluate(`document.querySelector('.settings-fields .field input').value`), 'C:\\new-codex.exe');
  await clickText('.settings-section button', 'Test saved CLI configuration');
  await wait(`__smoke.calls.some(c=>c[0]==='testCli')`);
  assert.equal(await evaluate(`__smoke.calls.find(c=>c[0]==='testCli')[1]`), '');
  await clickText('.settings-tabs button', 'Shortcuts');
  await click('#shortcut-screen');
  await keyboard(' ', { code: 'Space', ctrlKey: true, shiftKey: true });
  await wait(`!!document.querySelector('#shortcut-error-screen')`, 'duplicate shortcut validation');
  assert.equal(await evaluate(`document.querySelector('.settings-savebar button').disabled`), true);
  await click('#shortcut-screen');
  await keyboard('n', { code: 'KeyN', ctrlKey: true });
  await wait(`document.querySelector('#shortcut-error-screen')?.textContent.includes('reserved')`, 'local shortcut conflict');
  assert.equal(await evaluate(`document.querySelector('.settings-savebar button').disabled`), true);
  await click('#shortcut-screen');

  await keyboard('k', { code: 'KeyK', ctrlKey: true, altKey: true });

  await wait(`document.querySelector('#shortcut-screen').textContent.includes('K')`);
  await evaluate('__smoke.saveFails=true');
  await click('.settings-savebar button');
  await wait(`document.querySelector('.error-callout')?.textContent.includes('Windows shortcut conflict')`, 'OS conflict surfaced');
  assert.equal(await evaluate(`document.querySelector('.settings-savebar button').disabled`), false);
  await evaluate('__smoke.saveFails=false'); await click('.settings-savebar button');
  await wait(`document.querySelector('.saved-state')?.textContent==='All changes saved'`);
  await clickText('.settings-tabs button', 'General');
  await select('.field-grid .field:last-child select', 'light');
  await select('.field-grid .field:first-child select', 'de');
  await click('.settings-savebar button');
  await wait(`document.documentElement.dataset.theme==='light'&&document.documentElement.lang==='de'`, 'theme and language saved immediately');
  await clickText('.settings-tabs button', 'Audio');
  await wait(`document.querySelectorAll('.settings-fields select option').length===2`, 'native voice list');
  await clickText('.settings-section .button', 'Gespeicherte Stimme testen');
  await wait(`__smoke.calls.some(c=>c[0]==='speak')`);
  await clickText('.settings-section .button', 'Vorlesen stoppen');
  await wait(`__smoke.calls.some(c=>c[0]==='stopSpeech')`);
  await click('[aria-label="Zurück zum Assistenten"]');
  console.log('PASS settings, saved-CLI test, shortcut recording/duplicates/OS conflicts, DE/light theme, native voice test/stop');

  await click('.composer-tools [aria-label="Bildschirm aufnehmen"]');
  await wait(`document.querySelector('.mode-picker .is-active')?.textContent==='Bildschirm'&&!!document.querySelector('.composer .attachment')`, 'manual capture preview creates a session');
  const captureCount = await evaluate(`__smoke.calls.filter(c=>c[0]==='new').length`);
  await fill('.composer textarea', 'Keep this file question');
  await click('.composer-tools [aria-label="Dateien hinzufügen"]');
  await wait(`document.querySelector('.mode-picker .is-active')?.textContent==='Dateien'`, 'files mode');
  assert.equal(await evaluate(`document.querySelector('.composer textarea').value`), 'Keep this file question');
  assert.equal(await evaluate(`__smoke.calls.filter(c=>c[0]==='new').length`), captureCount + 1);
  await evaluate(`(() => {const dataTransfer=new DataTransfer();dataTransfer.items.add(new File(['hello'],'dropped.txt',{type:'text/plain'}));document.querySelector('.app-shell').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));})()`);
  await wait(`__smoke.calls.some(c=>c[0]==='dropFiles'&&c[1][0]==='dropped.txt')&&document.querySelectorAll('.composer .attachment').length===3`, 'awaited native file drop');
  await click('.composer .attachment .icon-button');
  await wait(`document.querySelectorAll('.composer .attachment').length===2`);
  await keyboard('Escape'); await wait(`__smoke.calls.some(c=>c[0]==='windowAction'&&c[1]==='hide')`);
  await keyboard('n', { ctrlKey: true });
  await wait(`document.querySelector('.mode-picker .is-active')?.textContent==='Chat'&&document.activeElement===document.querySelector('.composer textarea')`, 'Ctrl+N and composer focus');
  console.log('PASS screenshot/new-session preview, files mode, draft migration, drops, removal, Escape, Ctrl+N/focus');

  await evaluate(`__smoke.delayNew=true;__smoke.emit({type:'attachments',mode:'screen',attachments:[{id:'race-file',kind:'text',name:'race.txt',size:4}],newConversation:true});`);
  await wait(`typeof __smoke.resolveNew==='function'`, 'delayed manual preview');
  const sendsBeforePreview = await evaluate(`__smoke.calls.filter(c=>c[0]==='send').length`);
  await fill('.composer textarea', 'Do not send before the preview is ready');
  await evaluate(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);
  assert.equal(await evaluate(`__smoke.calls.filter(c=>c[0]==='send').length`), sendsBeforePreview);
  await evaluate(`__smoke.automatic('screen');__smoke.delayNew=false;__smoke.resolveNew();`);
  await wait(`document.querySelector('.message-assistant')?.textContent.includes('Automatic result')`, 'automatic request retains selection');
  assert.equal(await evaluate(`document.querySelector('.mode-picker .is-active').textContent`), 'Bildschirm');
  await click('[aria-label="Antwort stoppen"]');
  await wait(`!!document.querySelector('[aria-label="Nachricht senden"]')`, 'stop request');
  const countsBeforeBackground = await evaluate(`({new:__smoke.calls.filter(c=>c[0]==='new').length,send:__smoke.calls.filter(c=>c[0]==='send').length,speak:__smoke.calls.filter(c=>c[0]==='speak').length})`);
  await evaluate(`(() => {const next=structuredClone([...__smoke.calls].reverse().find(c=>c[0]==='save')[1]);next.modes.region.outputs.speech=true;__smoke.emit({type:'settings',settings:next});const id=__smoke.automatic();__smoke.finish(id,'Background clipboard and speech output');})()`);
  await wait(`!!document.querySelector('[aria-label="Nachricht senden"]')&&!document.querySelector('.other-request')`, 'background request completes');
  assert.equal(await evaluate(`document.querySelector('.mode-picker .is-active').textContent`), 'Bildschirm');
  assert.equal(await evaluate(`document.querySelector('.request-status').textContent.includes('Vorlesen')`), false);
  assert.deepEqual(await evaluate(`({new:__smoke.calls.filter(c=>c[0]==='new').length,send:__smoke.calls.filter(c=>c[0]==='send').length,speak:__smoke.calls.filter(c=>c[0]==='speak').length})`), countsBeforeBackground);
  await evaluate(`__smoke.emit({type:'speech',active:true})`);
  await wait(`document.querySelector('.request-status').textContent.includes('Vorlesen')`, 'native speech event controls status');
  await click('.composer-tools [aria-label="Vorlesen stoppen"]');
  await wait(`!document.querySelector('.request-status').textContent.includes('Vorlesen')`);
  await click('.composer-tools [aria-label="Bereich auswählen"]');
  await wait(`document.querySelector('.mode-picker .is-active')?.textContent==='Bereich'&&!!document.querySelector('.composer .attachment')`, 'manual preview ignores autoSend setting');
  assert.equal(await evaluate(`__smoke.calls.filter(c=>c[0]==='send').length`), sendsBeforePreview);
  console.log('PASS preview send-lock, manual region preview, background outputs, event-only speech status, remote image privacy');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 480, height: 720, deviceScaleFactor: 1, mobile: false }, session);
  await evaluate(`window.dispatchEvent(new Event('resize'))`);
  await wait(`document.documentElement.clientWidth===480`);
  assert.equal(await evaluate('document.documentElement.scrollWidth'), 480);
  assert.ok(await evaluate(`document.querySelector('.composer textarea').getBoundingClientRect().width>300`));
  assert.match(await evaluate(`getComputedStyle(document.body).fontFamily`), /Segoe|system-ui/);
  assert.equal(await evaluate('localStorage.length'), 0);
  if (process.argv.includes('--screenshot')) {
    await evaluate(`(() => {const saved=[...__smoke.calls].reverse().find(c=>c[0]==='save')[1];__smoke.emit({type:'settings',settings:{...saved,general:{...saved.general,theme:'dark'}}});document.querySelectorAll('.toast .icon-button').forEach(e=>e.click());})()`);
    await keyboard('n', { ctrlKey: true });
    await wait(`document.documentElement.dataset.theme==='dark'&&!document.querySelector('.sidebar')&&!!document.querySelector('.empty-state')`);
    const screenshot = await rpc('Page.captureScreenshot', { format: 'png' }, session);
    await writeFile(path.join(root, 'src', '.smoke-overlay.png'), Buffer.from(screenshot.data, 'base64'));
  }
  assert.deepEqual(runtimeErrors, []);
  assert.deepEqual(remoteRequests, []);
  console.log('PASS preview/automatic-request race, stop, 480px layout, no runtime errors or remote image requests');
} finally {
  try { await rpc('Browser.close'); } catch { child.kill(); }
  for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('Browser closed')); }
  if (devServer) await devServer.close();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(profile, { force: true, recursive: true, maxRetries: 8, retryDelay: 200 });
}
