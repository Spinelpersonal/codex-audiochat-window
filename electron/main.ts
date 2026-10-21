import {
  app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu,
  nativeImage, nativeTheme, Notification, screen, session, Tray,
} from 'electron';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppEvent, Attachment, CliStatus, ModeId, Settings } from '../shared/types';
import { MODE_IDS } from '../shared/types';
import { validateSettings } from './config';
import { Store } from './store';
import { HotkeyManager } from './hotkeys';
import { CodexRunner } from './codex';
import { FileService } from './files';
import { ChatEngine, errorText } from './chat';
import { capture, getVoices, shutdownWindows, speak, stopSpeech } from './windows';

const smoke = process.env.CODEX_OVERLAY_SMOKE === '1';
if (process.env.CODEX_OVERLAY_DATA_DIR) app.setPath('userData', path.resolve(process.env.CODEX_OVERLAY_DATA_DIR));
app.setName('Codex Overlay');
app.setAppUserModelId('dev.codexoverlay.app');
const developmentUrl = !app.isPackaged && process.env.VITE_DEV_SERVER_URL === 'http://127.0.0.1:5173'
  ? process.env.VITE_DEV_SERVER_URL : undefined;
const rendererFile = path.resolve(__dirname, '../dist/index.html');
const rendererUrl = developmentUrl ?? pathToFileURL(rendererFile).href;
const runner = new CodexRunner();
const attachments = new Map<string, Attachment>();
let store: Store;
let files: FileService;
let engine: ChatEngine;
let hotkeys: HotkeyManager;
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let closing = false;
let exitReady = false;
let ready = false;
let captureBusy = false;
let dialogDepth = 0;
let speechRevision = 0;
let boundsTimer: ReturnType<typeof setTimeout> | undefined;
let cli: CliStatus = { installed: false, authenticated: false, message: 'Codex wird geprüft / Checking Codex' };
let checkPromise: Promise<CliStatus> | undefined;
let configQueue: Promise<unknown> = Promise.resolve();
const pendingEvents: AppEvent[] = [];
const deferredActions: ModeId[] = [];

function emit(event: AppEvent): void {
  if (closing || !window || window.isDestroyed()) return;
  if (window.webContents.isLoadingMainFrame()) { pendingEvents.push(event); return; }
  window.webContents.send('overlay:event', event);
}
function notify(title: string, body: string): void {
  if (smoke || closing || window?.isVisible() || !Notification.isSupported()) return;
  const notification = new Notification({ title, body: body.slice(0, 400), silent: true });
  notification.on('click', () => showWindow(true));
  notification.show();
}
function report(error: unknown): void {
  const message = errorText(error);
  console.error(message);
  emit({ type: 'error', message });
  notify('Codex Overlay', message);
}
function showWindow(focus: boolean): void {
  if (!window || window.isDestroyed() || closing) return;
  if (window.isMinimized()) window.restore();
  // Never move a visible window out from under its user. Hidden overlays follow the active monitor.
  if (!window.isVisible()) {
    const monitor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const bounds = window.getBounds();
    if (!intersects(bounds, monitor.workArea)) {
      const width = Math.min(bounds.width, monitor.workArea.width);
      const height = Math.min(bounds.height, monitor.workArea.height);
      window.setBounds({ x: monitor.workArea.x + Math.round((monitor.workArea.width - width) / 2),
        y: monitor.workArea.y + Math.round((monitor.workArea.height - height) / 2), width, height });
    }
    if (focus) window.show(); else window.showInactive();
  }
  if (focus) { window.focus(); emit({ type: 'focus' }); }
}
function hideWindow(): void {
  if (!window) return;
  if (store.settings.general.tray) window.hide(); else window.minimize();
}
function intersects(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
async function withDialog<T>(operation: () => Promise<T>): Promise<T> {
  dialogDepth++;
  try { return await operation(); } finally { dialogDepth--; }
}
async function checkCli(): Promise<CliStatus> {
  if (checkPromise) return checkPromise;
  const cliPath = store.settings.codex.cliPath;
  checkPromise = runner.test(cliPath).then(result => {
    if (store.settings.codex.cliPath === cliPath) cli = result;
    return result;
  }).finally(() => { checkPromise = undefined; });
  return checkPromise;
}
function resource(name: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'resources', name) : path.resolve(__dirname, '../resources', name);
}
function updateTray(): void {
  if (!store.settings.general.tray) { tray?.destroy(); tray = undefined; return; }
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(resource('icon.png')));
    tray.setToolTip('Codex Overlay');
    tray.on('click', () => window?.isVisible() && !window.isMinimized() ? hideWindow() : showWindow(true));
  }
  const de = store.settings.general.language === 'de';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: de ? 'Chat öffnen' : 'Open chat', click: () => showWindow(true) },
    { type: 'separator' },
    { label: de ? 'Bildschirm analysieren' : 'Analyze screen', click: () => void trigger('screen').catch(report) },
    { label: de ? 'Bereich auswählen' : 'Select region', click: () => void trigger('region').catch(report) },
    { label: de ? 'Dateien analysieren' : 'Analyze files', click: () => void trigger('files').catch(report) },
    { type: 'separator' },
    { label: de ? 'Anfrage stoppen' : 'Stop request', click: () => { if (engine.activeId) void engine.cancel(engine.activeId).catch(report); } },
    { label: de ? 'Audio stoppen' : 'Stop speech', click: () => void stopAudio().catch(report) },
    { type: 'separator' },
    { label: de ? 'Beenden' : 'Quit', click: () => app.quit() },
  ]));
}
function applyAppearance(settings: Settings): void {
  window?.setAlwaysOnTop(settings.general.alwaysOnTop, 'floating');
  window?.setSkipTaskbar(settings.general.tray);
  nativeTheme.themeSource = settings.general.theme;
  updateTray();
}
function applyLogin(settings: Settings): void {
  if (smoke) return;
  if (!app.isPackaged) {
    if (settings.general.launchAtLogin) throw new Error('Autostart ist erst in der installierten App verfügbar / Login startup requires the installed app');
    return;
  }
  app.setLoginItemSettings({ openAtLogin: settings.general.launchAtLogin,
    path: process.execPath, args: ['--hidden'], name: 'Codex Overlay' });
  if (app.getLoginItemSettings({ path: process.execPath, args: ['--hidden'] }).openAtLogin !== settings.general.launchAtLogin) {
    throw new Error('Windows-Autostart konnte nicht übernommen werden / Windows startup could not be changed');
  }
}
async function saveSettings(input: unknown): Promise<Settings> {
  const next = validateSettings(input);
  const operation = configQueue.then(async () => {
    const previous = store.settings;
    if (next.codex.workingDirectory) {
      const { stat } = await import('node:fs/promises');
      if (!path.isAbsolute(next.codex.workingDirectory) || !(await stat(next.codex.workingDirectory)).isDirectory()) {
        throw new Error('Arbeitsverzeichnis muss ein vorhandener absoluter Ordner sein / Select an existing absolute working directory');
      }
    }
    try {
      if (!smoke) hotkeys.apply(next.modes);
      applyLogin(next);
      await store.saveSettings(next);
    } catch (error) {
      const failures: unknown[] = [];
      if (!smoke) {
        try { hotkeys.apply(previous.modes); } catch (rollback) { failures.push(rollback); }
        try { applyLogin(previous); } catch (rollback) { failures.push(rollback); }
      }
      if (failures.length) report(new AggregateError(failures, 'Einstellungen konnten nicht vollständig zurückgesetzt werden / Settings rollback failed'));
      throw error;
    }
    applyAppearance(next);
    emit({ type: 'settings', settings: next });
    if (next.codex.cliPath !== previous.codex.cliPath) {
      cli = { installed: false, authenticated: false, message: 'Bitte Verbindung testen / Test the saved CLI configuration' };
    }
    return store.settings;
  });
  configQueue = operation.catch(() => undefined);
  return operation;
}
async function startAudio(text: string, audio = store.settings.audio): Promise<void> {
  const revision = ++speechRevision;
  emit({ type: 'speech', active: true });
  try { await speak(text, audio); }
  finally { if (revision === speechRevision) emit({ type: 'speech', active: false }); }
}
async function stopAudio(): Promise<void> {
  ++speechRevision;
  await stopSpeech();
  emit({ type: 'speech', active: false });
}
async function registerFiles(paths: string[], temporary = false): Promise<Attachment[]> {
  if (paths.length > 50) throw new Error('Maximal 50 Anhänge pro Nachricht / Maximum 50 attachments per message');
  const registered = await files.register(paths, temporary);
  // Native thumbnails keep large screenshots previewable without retaining full image copies in history.
  for (let i = 0; i < registered.length; i++) {
    const attachment = registered[i];
    if (attachment.kind === 'image' && !attachment.preview) {
      try {
        const thumbnail = await nativeImage.createThumbnailFromPath(paths[i], { width: 520, height: 340 });
        if (!thumbnail.isEmpty()) attachment.preview = thumbnail.toDataURL();
      } catch { /* File remains usable when Windows cannot produce a thumbnail. */ }
    }
    attachments.set(attachment.id, attachment);
  }
  return registered;
}
async function chooseFiles(): Promise<Attachment[]> {
  return withDialog(async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Dateien für Codex auswählen / Select files for Codex',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Text, Code, PDF & Images', extensions: ['txt', 'md', 'csv', 'json', 'js', 'ts', 'tsx', 'py', 'rs', 'cs', 'cpp', 'pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
        { name: 'All files', extensions: ['*'] }],
    });
    return result.canceled ? [] : registerFiles(result.filePaths);
  });
}
async function deliver(mode: ModeId, selected: Attachment[]): Promise<void> {
  if (!selected.length) return;
  const settings = store.settings.modes[mode];
  if (settings.autoSend) {
    const conversation = await engine.create(mode);
    try { await engine.start({ conversationId: conversation.id, mode, text: '', attachmentIds: selected.map(item => item.id) }); }
    catch (error) {
      // Preserve a failed-to-start capture for manual retry rather than orphaning the temporary file.
      showWindow(true);
      emit({ type: 'attachments', mode, attachments: selected, newConversation: true });
      throw error;
    }
  } else {
    showWindow(true);
    emit({ type: 'attachments', mode, attachments: selected, newConversation: true });
  }
}
async function captureMode(mode: 'screen' | 'region'): Promise<void> {
  if (captureBusy || engine.busy) throw new Error('Es läuft bereits eine Aufnahme oder Anfrage / A capture or request is already running');
  captureBusy = true;
  const wasVisible = !!window?.isVisible();
  const previousPin = window?.isAlwaysOnTop() ?? false;
  try {
    // Snipping takes a frozen native screenshot only after the overlay has left the compositor.
    window?.hide();
    await new Promise(resolve => setTimeout(resolve, 250));
    const filePath = await capture(mode, path.join(app.getPath('userData'), 'captures'));
    if (closing) { if (filePath) await unlink(filePath).catch(() => undefined); return; }
    if (!filePath) { if (wasVisible) showWindow(true); return; }
    const selected = await registerFiles([filePath], true);
    await deliver(mode, selected);
  } catch (error) { if (wasVisible) showWindow(true); throw error; }
  finally { captureBusy = false; window?.setAlwaysOnTop(previousPin, 'floating'); }
}
async function trigger(mode: ModeId): Promise<void> {
  if (!ready) { deferredActions.push(mode); return; }
  if (closing) return;
  if (mode === 'chat') {
    if (window?.isVisible() && !window.isMinimized()) hideWindow(); else showWindow(true);
  } else if (mode === 'files') {
    if (engine.busy || captureBusy) throw new Error('Es läuft bereits eine Anfrage / A request is already running');
    await deliver(mode, await chooseFiles());
  } else await captureMode(mode);
}
function trusted(event: Electron.IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Untrusted IPC sender');
  }
  const url = event.senderFrame.url;
  if (developmentUrl ? new URL(url).origin !== developmentUrl : url !== rendererUrl) throw new Error('Untrusted IPC origin');
  if (closing) throw new Error('Application is shutting down');
}
function text(value: unknown, max = 200_000): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('Invalid text');
  return value;
}
function setupIpc(): void {
  const handle = (channel: string, handler: (...args: any[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => { trusted(event); return handler(...args); });
  };
  handle('app:bootstrap', async () => ({ settings: store.settings, conversations: store.conversations,
    cli: await checkCli(), platform: process.platform, version: app.getVersion() }));
  handle('settings:save', saveSettings);
  handle('codex:test', checkCli);
  handle('chat:new', (mode: ModeId) => engine.create(mode));
  handle('chat:send', input => engine.start(input));
  handle('chat:cancel', id => engine.cancel(text(id, 200)));
  handle('chat:delete', id => engine.remove(text(id, 200)));
  handle('chat:rename', async (id, title) => {
    if (engine.activeId === id) throw new Error('Laufende Konversation zuerst stoppen / Stop this conversation first');
    const conversation = store.conversations.find(item => item.id === text(id, 200));
    if (!conversation) throw new Error('Conversation not found');
    conversation.title = text(title, 200).trim();
    if (!conversation.title) throw new Error('Titel darf nicht leer sein / Title cannot be empty');
    conversation.updatedAt = new Date().toISOString();
    await store.putConversation(conversation);
    emit({ type: 'conversation', conversation });
  });
  handle('chat:export', async id => {
    const conversation = store.conversations.find(item => item.id === text(id, 200));
    if (!conversation) throw new Error('Conversation not found');
    await withDialog(async () => {
      const result = await dialog.showSaveDialog(window!, { defaultPath: `${conversation.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'conversation'}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (result.canceled || !result.filePath) return;
      const content = `# ${conversation.title}\n\n` + conversation.messages.map(message => `## ${message.role === 'user' ? 'You' : 'Codex'}\n\n${message.text}${message.attachments?.length ? '\n\nAttachments: ' + message.attachments.map(item => item.name).join(', ') : ''}${message.error ? '\n\nError: ' + message.error : ''}`).join('\n\n---\n\n');
      await writeFile(result.filePath, content, 'utf8');
    });
  });
  handle('capture:start', mode => {
    if (mode !== 'screen' && mode !== 'region') throw new Error('Invalid capture mode');
    return captureMode(mode);
  });
  handle('files:choose', chooseFiles);
  handle('files:drop', (paths: string[]) => {
    if (!Array.isArray(paths) || paths.length > 50 || !paths.every(p => typeof p === 'string' && path.isAbsolute(p))) throw new Error('Invalid dropped files');
    return registerFiles(paths);
  });
  handle('files:release', async (ids: string[]) => {
    if (engine.busy) throw new Error('Anhänge können während einer Anfrage nicht entfernt werden / Attachments are in use');
    await files.release(ids);
    for (const id of ids) attachments.delete(id);
  });
  handle('clipboard:copy', value => { clipboard.writeText(text(value)); });
  handle('audio:speak', value => startAudio(text(value, 150_000)));
  handle('audio:stop', stopAudio);
  handle('audio:voices', getVoices);
  handle('dialog:directory', () => withDialog(async () => {
    const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  }));
  handle('dialog:cli', () => withDialog(async () => {
    const result = await dialog.showOpenDialog(window!, { properties: ['openFile'], filters: [{ name: 'Codex CLI', extensions: ['exe', 'cmd'] }] });
    return result.canceled ? null : result.filePaths[0];
  }));
  handle('window:action', async action => {
    switch (action) {
      case 'hide': hideWindow(); break;
      case 'minimize': window?.minimize(); break;
      case 'close': window?.close(); break;
      case 'quit': app.quit(); break;
      case 'togglePin': {
        const next = store.settings;
        next.general.alwaysOnTop = !next.general.alwaysOnTop;
        await saveSettings(next); break;
      }
      default: throw new Error('Invalid window action');
    }
  });
}
function createWindow(): void {
  let bounds = store.bounds;
  if (bounds && !screen.getAllDisplays().some(display => intersects(bounds!, display.workArea))) bounds = undefined;
  const work = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(Math.max(bounds?.width ?? 800, 480), work.width);
  const height = Math.min(Math.max(bounds?.height ?? 760, 560), work.height);
  window = new BrowserWindow({
    width, height, ...(bounds ? { x: bounds.x, y: bounds.y } : {}), minWidth: 480, minHeight: 560,
    frame: false, show: false, backgroundColor: '#101413', title: 'Codex Overlay',
    icon: resource('icon.png'), autoHideMenuBar: true, alwaysOnTop: store.settings.general.alwaysOnTop,
    skipTaskbar: store.settings.general.tray,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true, devTools: !app.isPackaged || smoke },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== rendererUrl && url !== `${rendererUrl}/`) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('did-finish-load', () => {
    for (const event of pendingEvents.splice(0)) emit(event);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    if (!closing) { console.error('Renderer exited', details.reason); window?.reload(); }
  });
  window.once('ready-to-show', () => {
    const hidden = !smoke && (process.argv.includes('--hidden') || store.settings.general.startMinimized);
    if (hidden && store.settings.general.tray) return;
    if (hidden) window?.minimize(); else showWindow(true);
  });
  window.on('close', event => {
    if (closing) return;
    event.preventDefault();
    if (store.settings.general.tray) hideWindow(); else app.quit();
  });
  window.on('blur', () => {
    if (store.settings.general.hideOnBlur && !captureBusy && !dialogDepth && !smoke) hideWindow();
  });
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (window && !window.isDestroyed() && !window.isMinimized()) void store.saveBounds(window.getBounds()).catch(report);
    }, 300);
  };
  window.on('moved', saveBounds);
  window.on('resized', saveBounds);
  void (developmentUrl ? window.loadURL(developmentUrl) : window.loadFile(rendererFile)).catch(report);
}
async function cleanCaptureCache(cache: string): Promise<void> {
  await mkdir(cache, { recursive: true });
  const names = await readdir(cache);
  // Dedicated application cache only; never touch the user's original file attachments.
  for (const name of names) if (/^capture-[0-9a-f-]{36}\.png$/i.test(name)) await unlink(path.join(cache, name));
}
async function initialize(): Promise<void> {
  store = new Store(app.getPath('userData'));
  await store.init();
  const cache = path.join(app.getPath('userData'), 'captures');
  await cleanCaptureCache(cache);
  files = new FileService(cache);
  engine = new ChatEngine({ store, runner, files, attachments, emit,
    openChat: () => showWindow(false),
    copy: async value => { clipboard.writeText(value); }, speak: startAudio, notify });
  hotkeys = new HotkeyManager(globalShortcut, mode => void trigger(mode).catch(report));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on('will-download', event => event.preventDefault());
  // Renderer and Markdown cannot initiate remote requests. Only the local Codex subprocess uses the network.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    const allowed = url.startsWith('file:') || url.startsWith('data:') || url.startsWith('devtools:')
      || (!!developmentUrl && (url.startsWith(`${developmentUrl}/`) || url.startsWith('ws://127.0.0.1:5173/')));
    callback({ cancel: !allowed });
  });
  setupIpc();
  createWindow();
  applyAppearance(store.settings);
  if (!smoke) {
    try { hotkeys.apply(store.settings.modes); } catch (error) { report(error); showWindow(true); }
    try { applyLogin(store.settings); } catch (error) { report(error); }
  }
  ready = true;
  for (const warning of store.warnings) report(warning);
  for (const mode of deferredActions.splice(0)) void trigger(mode).catch(report);
}
app.on('second-instance', () => { if (ready) showWindow(true); });
app.on('activate', () => { if (ready) showWindow(true); });
app.on('window-all-closed', () => { if (!closing) app.quit(); });
app.on('before-quit', event => {
  if (exitReady) return;
  event.preventDefault();
  if (closing) return;
  closing = true;
  clearTimeout(boundsTimer);
  const finalBounds = window && !window.isDestroyed() ? window.getNormalBounds() : undefined;
  try { hotkeys?.dispose(); } catch (error) { console.error(errorText(error)); }
  tray?.destroy(); tray = undefined;
  const shutdownDeadline = setTimeout(() => {
    console.error('Graceful shutdown timed out; abandoned captures will be removed on next startup.');
    app.exit(1);
  }, 25_000);
  shutdownDeadline.unref();
  void (async () => {
    // Abort native captures first, then drain requests before deleting their temporary images.
    await Promise.allSettled([shutdownWindows(), engine?.shutdown(), configQueue]);
    if (finalBounds && store) await store.saveBounds(finalBounds).catch(error => console.error(errorText(error)));
    await files?.cleanup().catch(error => console.error(errorText(error)));
    clearTimeout(shutdownDeadline);
    exitReady = true;
    app.quit();
  })().catch(error => { clearTimeout(shutdownDeadline); console.error(errorText(error)); exitReady = true; app.quit(); });
});
if (!app.requestSingleInstanceLock()) { exitReady = true; app.quit(); }
else void app.whenReady().then(initialize).catch(error => {
  console.error(error);
  dialog.showErrorBox('Codex Overlay konnte nicht starten / Failed to start', errorText(error));
  app.quit();
});
