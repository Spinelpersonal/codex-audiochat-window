#!/usr/bin/env node
/**
 * Real Electron/preload integration smoke test; no API mocks or model requests.
 *
 * Prerequisites:
 *   npm install --save-dev playwright-core   (or playwright / @playwright/test)
 *   npm run build                          (may finish while this script waits)
 *   node scripts/ui-smoke.mjs [--wait-ms=120000] [--keep-data]
 *
 * Parent main must honor CODEX_OVERLAY_DATA_DIR before single-instance locking
 * and CODEX_OVERLAY_SMOKE=1 before applying any startup or settings side effects:
 * disable global shortcut registration, login-item writes, and notifications;
 * show the main window even when startMinimized is saved. Normal settings
 * validation, disk persistence, preload IPC, and CLI status checks must stay real.
 *
 * Only page.screenshot() is used: the artifact contains the app viewport, never
 * a desktop/screen capture. The script never calls send/capture/chooseFiles/speak.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const mainPath = path.join(root, 'dist-electron', 'main.cjs');
const rendererPath = path.join(root, 'dist', 'index.html');
const output = path.join(root, '.test-output');
const packaged = process.argv.includes('--packaged');
const screenshotPath = path.join(output, packaged ? 'packaged-overlay.png' : 'overlay.png');
const reportPath = path.join(output, packaged ? 'packaged-ui-smoke-result.json' : 'ui-smoke-result.json');
const expectedRenderer = packaged ? path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar', 'dist', 'index.html') : rendererPath;
const timeout = 45_000;
const args = process.argv.slice(2);
const help = `Usage: node scripts/ui-smoke.mjs [--packaged] [--wait-ms=120000] [--keep-data]

Requires a built Electron main/renderer, the electron binary, and one of
playwright-core, playwright, or @playwright/test. No browser download is needed.
The app GUI opens briefly. No screen captures or model requests are performed.
Artifacts: .test-output/overlay.png and .test-output/ui-smoke-result.json
`;

function parseOptions() {
  let waitMs = 120_000;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h' || arg === '--keep-data' || arg === '--packaged') continue;
    if (!/^--wait-ms=\d+$/.test(arg)) throw new Error(`Unknown option: ${arg}\n${help}`);
    waitMs = Number(arg.slice('--wait-ms='.length));
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 600_000) throw new Error('--wait-ms must be between 0 and 600000.');
  }
  return { waitMs, keepData: args.includes('--keep-data') };
}

async function waitForBuild(waitMs) {
  const deadline = Date.now() + waitMs;
  let previous = '';
  console.log(`Waiting up to ${waitMs} ms for dist-electron/main.cjs and dist/index.html…`);
  do {
    try {
      const files = await Promise.all([stat(mainPath), stat(rendererPath)]);
      if (files.every((file) => file.isFile() && file.size > 0)) {
        const fingerprint = files.map((file) => `${file.size}:${file.mtimeMs}`).join('|');
        if (fingerprint === previous || waitMs === 0) return;
        previous = fingerprint;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (Date.now() >= deadline) break;
    await delay(Math.min(200, deadline - Date.now()));
  } while (true);
  throw new Error('Built app is not ready. Ask the parent to finish npm run build, then rerun node scripts/ui-smoke.mjs.');
}

async function electronDriver() {
  for (const name of ['playwright-core', 'playwright', '@playwright/test']) {
    try {
      const module = await import(name);
      if (module._electron?.launch) return module._electron;
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' && error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('Playwright is not installed. The parent can add: npm install --save-dev playwright-core\nNo Playwright browser download is needed; the test uses the electron dependency executable.');
}

async function installedElectronPath() {
  let entry;
  try { entry = require.resolve('electron'); }
  catch { throw new Error('The electron dependency is missing. Finish installing project dependencies first.'); }
  // Some Electron versions try to download on require(). Fail clearly rather than initiating network access.
  try { await access(path.join(path.dirname(entry), 'path.txt')); }
  catch { throw new Error('The electron executable is not installed (electron/path.txt is missing). The parent must finish the Electron binary installation first.'); }
  const executable = require('electron');
  assert.equal(typeof executable, 'string', 'The electron dependency must resolve to its executable path.');
  await access(executable);
  return executable;
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function bounded(operation, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}
const readBootstrap = (page) => bounded(page.evaluate(() => window.overlay.bootstrap()), 'the real overlay.bootstrap() bridge');

async function run() {
  const { waitMs, keepData } = parseOptions();
  await waitForBuild(waitMs);
  const driver = await electronDriver();
  const executablePath = packaged ? path.join(root, 'release', 'win-unpacked', 'Codex Overlay.exe') : await installedElectronPath();
  await access(executablePath);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await mkdir(output, { recursive: true });
  const dataDir = await mkdtemp(path.join(output, 'ui-smoke-data-'));
  console.log(`Isolated app data: ${dataDir}`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  delete env.ELECTRON_RENDERER_URL;
  Object.assign(env, { NODE_ENV: 'production', CODEX_OVERLAY_DATA_DIR: dataDir, CODEX_OVERLAY_SMOKE: '1' });
  let application;
  let succeeded = false;
  let launchNumber = 0;
  const rendererErrors = [];
  const remoteRequests = [];
  const observations = [];

  const stop = async () => {
    if (!application) return;
    const current = application;
    const child = current.process();
    application = undefined;
    let timer;
    try {
      await Promise.race([
        current.close(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Electron did not exit within 15 seconds.')), 15_000); }),
      ]);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  };

  const start = async () => {
    launchNumber++;
    application = await driver.launch({ executablePath, args: packaged ? [] : [root], cwd: root, env, timeout });
    application.on('window', (page) => {
      page.on('pageerror', (error) => rendererErrors.push(`Launch ${launchNumber}: ${error.message}`));
      page.on('request', (request) => { if (/^https?:/i.test(request.url())) remoteRequests.push(request.url()); });
    });
    const page = await application.firstWindow({ timeout });
    page.setDefaultTimeout(timeout);
    const isolation = await bounded(application.evaluate(({ app }) => ({
      dataDir: app.getPath('userData'), smoke: process.env.CODEX_OVERLAY_SMOKE,
    })), 'Electron profile isolation');
    assert.equal(isolation.smoke, '1');
    assert.equal(normalizedPath(await realpath(isolation.dataDir)), normalizedPath(await realpath(dataDir)),
      'Parent main ignored CODEX_OVERLAY_DATA_DIR. Aborting before changing any settings.');
    const nativeWindow = await application.browserWindow(page);
    await bounded(nativeWindow.evaluate((window) => { window.restore(); window.show(); window.focus(); }), 'the visible app window');
    await page.waitForFunction(() => !!window.overlay && !!document.querySelector('.composer textarea'), undefined, { timeout });
    assert.equal(new URL(page.url()).protocol, 'file:', 'Smoke test must use the built renderer, not a development URL.');
    assert.equal(normalizedPath(fileURLToPath(page.url())), normalizedPath(expectedRenderer));
    const bootstrap = await bounded(page.evaluate(async () => {
      const events = { requests: [], speech: [], errors: [] };
      const cleanup = window.overlay.onEvent((event) => {
        if (event.type === 'request') events.requests.push(event.status);
        if (event.type === 'speech') events.speech.push(event.active);
        if (event.type === 'error') events.errors.push(event.message);
      });
      // Observation only: the real preload API is never replaced or patched.
      window.__uiSmoke = { events, cleanup };
      return window.overlay.bootstrap();
    }), 'bootstrap and the real preload event subscription');
    assert.equal(bootstrap.version, pkg.version, 'Launch the project root so Electron reads the app package version.');
    assert.ok(['de', 'en'].includes(bootstrap.settings.general.language));
    assert.ok(Array.isArray(bootstrap.conversations));
    assert.ok(bootstrap.conversations.every((conversation) => conversation.messages.length === 0), 'An isolated smoke profile must not contain message history.');
    assert.equal(typeof bootstrap.cli.installed, 'boolean');
    assert.equal(typeof bootstrap.cli.authenticated, 'boolean');
    assert.equal(typeof bootstrap.cli.message, 'string');
    if (bootstrap.cli.version !== undefined) assert.equal(typeof bootstrap.cli.version, 'string');
    await assertNoGlobalKeys(bootstrap.settings);
    return { page, bootstrap };
  };

  const assertNoGlobalKeys = async (settings) => {
    const shortcuts = Object.values(settings.modes).map((mode) => mode.shortcut).filter(Boolean);
    const registered = await bounded(application.evaluate(({ globalShortcut }, keys) => keys.filter((key) => globalShortcut.isRegistered(key)), shortcuts), 'global shortcut safety verification');
    assert.deepEqual(registered, [], 'CODEX_OVERLAY_SMOKE=1 must disable global shortcut registration on startup AND settings saves.');
  };
  const openSettings = async (page) => {
    await page.locator('.window-controls').getByRole('button', { name: /^(Settings|Einstellungen)$/ }).click();
    const settings = page.locator('.settings-container:not([hidden]) .settings-view');
    await settings.waitFor({ state: 'visible' });
    return settings;
  };
  const category = async (settings, name) => {
    await settings.locator('.settings-tabs').getByRole('button', { name, exact: true }).click();
  };
  const checkCli = async (page, settings) => {
    await category(settings, 'Codex');
    const button = settings.getByRole('button', { name: 'Test saved CLI configuration', exact: true });
    await button.click();
    await settings.getByRole('button', { name: 'Test saved CLI configuration', exact: true }).waitFor();
    await page.waitForFunction(() => {
      const buttons = [...document.querySelectorAll('.settings-section button')];
      return buttons.some((button) => button.textContent.trim() === 'Test saved CLI configuration' && !button.disabled);
    });
    const { cli } = await readBootstrap(page);
    const result = settings.locator('.cli-result');
    assert.ok((await result.innerText()).includes(cli.message), 'Display the real CLI status message.');
    if (cli.version) assert.equal((await result.locator('.cli-result-heading code').innerText()).trim(), cli.version);
    const values = result.locator('dd');
    assert.equal((await values.nth(0).innerText()).trim(), cli.installed ? 'Yes' : 'No');
    assert.equal((await values.nth(1).innerText()).trim(), cli.authenticated ? 'Yes' : 'No');
    observations.push({ installed: cli.installed, authenticated: cli.authenticated, version: cli.version ?? null, message: cli.message });
    console.log(`PASS real CLI status: installed=${cli.installed}, authenticated=${cli.authenticated}, version=${cli.version ?? '(not available)'}`);
  };
  const save = async (page, settings) => {
    await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.waitForFunction(() => !!document.querySelector('.settings-savebar .saved-state') || !!document.querySelector('.settings-scroll .error-callout'));
    const error = settings.locator('.error-callout');
    if (await error.count()) throw new Error(`Settings save failed: ${await error.innerText()}`);
    assert.equal((await settings.locator('.saved-state').innerText()).trim(), 'All changes saved');
    const { settings: saved } = await readBootstrap(page);
    await assertNoGlobalKeys(saved);
    return saved;
  };
  const observeNoRequests = async (page) => {
    const events = await page.evaluate(() => {
      const events = window.__uiSmoke.events;
      window.__uiSmoke.cleanup();
      return events;
    });
    assert.deepEqual(events.requests, [], 'Smoke must never initiate a model request.');
    assert.equal(events.speech.includes(true), false, 'Merely opening settings must not start speech.');
    assert.deepEqual(events.errors, [], 'Unexpected desktop error events.');
  };

  try {
    const first = await start();
    console.log('PASS real preload bootstrap, app version, isolated profile, global keys disabled');
    if (packaged) {
      // Validate native resources and external ESM/native modules from app.asar, without capture/audio/model calls.
      const voiceList = await first.page.evaluate(() => window.overlay.voices());
      assert.ok(Array.isArray(voiceList));
      const stream = 'BT /F1 12 Tf 30 100 Td (CODEX_OVERLAY_PDF_OK) Tj ET';
      const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
      let pdf = '%PDF-1.4\n'; const offsets = [0];
      objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
      const startxref = Buffer.byteLength(pdf);
      pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
      const fixture = path.join(dataDir, 'synthetic.pdf');
      await writeFile(fixture, pdf);
      await first.page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'smoke-file-input'; input.hidden = true; document.body.append(input); });
      await first.page.locator('#smoke-file-input').setInputFiles(fixture);
      const imported = await first.page.evaluate(async () => {
        const input = document.getElementById('smoke-file-input');
        return window.overlay.dropFiles([...input.files]);
      });
      assert.equal(imported.length, 1);
      assert.equal(imported[0].kind, 'pdf');
      assert.ok(imported[0].preview.includes('CODEX_OVERLAY_PDF_OK'), 'Packaged PDF extraction must return actual document text.');
      await first.page.evaluate(async ids => { await window.overlay.releaseAttachments(ids); document.getElementById('smoke-file-input').remove(); }, imported.map(item => item.id));
      console.log(`PASS packaged PDF extraction through real file/preload IPC and native voice enumeration (${voiceList.length} voices, no audio)`);
    }
    let settings = await openSettings(first.page);
    await settings.getByLabel(/^(Language|Sprache)$/, { exact: true }).selectOption('en');
    await settings.getByLabel('Theme', { exact: true }).selectOption('light');
    assert.equal(first.bootstrap.settings.general.language, (await readBootstrap(first.page)).settings.general.language,
      'Changing the draft must not persist before Save.');
    await checkCli(first.page, settings);
    await settings.getByLabel('Working directory', { exact: true }).fill(root);
    await category(settings, 'Shortcuts');
    assert.equal(await settings.locator('.shortcut-recorder').count(), 4);
    await category(settings, 'Modes');
    await settings.locator('.mode-settings-picker').getByRole('button', { name: 'Chat', exact: true }).click();
    const prompt = 'UI smoke persistence check. No model requests are made.';
    await settings.getByLabel('Custom instructions', { exact: true }).fill(prompt);
    assert.equal(await settings.locator('.outputs input[type="checkbox"]').count(), 3);
    await category(settings, 'Audio');
    assert.ok(await settings.getByLabel('Windows voice', { exact: true }).locator('option').count() >= 1);
    const volume = settings.getByRole('slider', { name: /^Volume/ });
    await volume.evaluate((input) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '37');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settings.getByRole('slider', { name: /^Volume.*37%$/ }).waitFor();
    const saved = await save(first.page, settings);
    assert.equal(saved.general.language, 'en');
    assert.equal(saved.general.theme, 'light');
    assert.equal(saved.general.launchAtLogin, first.bootstrap.settings.general.launchAtLogin);
    assert.equal(saved.codex.workingDirectory, root);
    assert.equal(saved.audio.volume, 37);
    assert.equal(saved.modes.chat.prompt, prompt);
    await first.page.waitForFunction(() => document.documentElement.dataset.theme === 'light' && document.documentElement.lang === 'en');
    assert.equal(await first.page.locator('html').getAttribute('data-theme'), 'light');
    assert.equal(await first.page.locator('html').getAttribute('lang'), 'en');
    await observeNoRequests(first.page);
    console.log('PASS all settings categories, explicit Save, live theme/language, no model/speech requests');
    await stop();

    const second = await start();
    assert.deepEqual(second.bootstrap.settings, saved, 'Settings must survive a full Electron process restart.');
    settings = await openSettings(second.page);
    assert.equal(await settings.getByLabel('Language', { exact: true }).inputValue(), 'en');
    assert.equal(await settings.getByLabel('Theme', { exact: true }).inputValue(), 'light');
    assert.equal((await settings.locator('.settings-header .version').innerText()).trim(), `v${pkg.version}`);
    await checkCli(second.page, settings);
    assert.equal(await settings.getByLabel('Working directory', { exact: true }).inputValue(), root);
    await category(settings, 'Modes');
    assert.equal(await settings.getByLabel('Custom instructions', { exact: true }).inputValue(), prompt);
    await category(settings, 'Audio');
    assert.equal(await settings.getByRole('slider', { name: /^Volume/ }).inputValue(), '37');
    await settings.getByRole('button', { name: 'Back to assistant', exact: true }).click();
    await second.page.locator('.workspace:not([hidden]) .composer textarea').waitFor();
    assert.equal(await second.page.locator('.composer textarea').inputValue(), '');
    assert.equal(await second.page.locator('.message').count(), 0);
    assert.equal(await second.page.locator('.desktop-required').count(), 0);
    await second.page.screenshot({ path: screenshotPath, fullPage: false, animations: 'disabled' });
    await observeNoRequests(second.page);
    assert.deepEqual(rendererErrors, [], 'Renderer exceptions occurred.');
    assert.deepEqual(remoteRequests, [], 'The renderer attempted a remote HTTP request.');
    await writeFile(reportPath, `${JSON.stringify({ passed: true, appVersion: pkg.version, persisted: true, cli: observations, modelRequests: 0, screenshot: path.relative(root, screenshotPath) }, null, 2)}\n`);
    console.log('PASS persisted settings after restart, real preload IPC, no renderer errors or remote requests');
    console.log(`App-window screenshot: ${screenshotPath}`);
    console.log(`Report: ${reportPath}`);
    succeeded = true;
  } finally {
    await stop();
    if (succeeded && !keepData) await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    else console.log(`Retained isolated test profile for inspection: ${dataDir}`);
  }
}

if (args.includes('--help') || args.includes('-h')) console.log(help);
else run().catch((error) => { console.error(`UI smoke failed: ${error.stack ?? error}`); process.exitCode = 1; });
