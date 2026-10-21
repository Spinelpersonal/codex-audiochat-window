import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings } from '../shared/defaults.ts';
import { busyConversationId, duplicateShortcuts, isRunning, mergeAttachments, normalizeShortcut, rebaseSettingsDraft, safeImageSource, shortcutFromKey, shortcutIdentity, snapshotMessages, upsertConversation } from './model.ts';
import { translator } from './i18n.ts';

const timestamp = '2026-01-01T12:00:00.000Z';
const conversation = (messages = [], overrides = {}) => ({ id: 'one', mode: 'chat', title: 'A conversation', createdAt: timestamp, updatedAt: timestamp, messages, ...overrides });
const assistant = (id, text, status = 'complete') => ({ id, role: 'assistant', text, status, createdAt: timestamp });
const key = (overrides = {}) => ({ key: ' ', code: 'Space', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, ...overrides });

test('request text replaces the full snapshot instead of appending deltas', () => {
  const canonical = conversation([assistant('response', '', 'pending')]);
  assert.equal(snapshotMessages(canonical, { status: 'responding', text: 'Hello' })[0].text, 'Hello');
  assert.equal(snapshotMessages(canonical, { status: 'responding', text: 'Hello world' })[0].text, 'Hello world');
  assert.equal(canonical.messages[0].text, '');
});

test('streaming a later turn never overwrites an earlier assistant message', () => {
  const canonical = conversation([assistant('first', 'Keep this answer'), assistant('second', 'Keep this too')]);
  const result = snapshotMessages(canonical, { status: 'thinking', baselineAssistantId: 'second', text: 'New answer' });
  assert.equal(result.length, 3);
  assert.equal(result[0].text, 'Keep this answer');
  assert.equal(result[1].text, 'Keep this too');
  assert.equal(result[2].text, 'New answer');
});

test('a canonical final message wins over an older streaming snapshot', () => {
  const canonical = conversation([assistant('response', 'The complete answer')]);
  assert.equal(snapshotMessages(canonical, { status: 'responding', text: 'The complete' })[0].text, 'The complete answer');
  assert.equal(snapshotMessages(canonical, { status: 'completed', text: 'The complete answer' }).length, 1);
});

test('a pending canonical message uses cancellation and error snapshots', () => {
  const canonical = conversation([assistant('response', '', 'pending')]);
  const cancelled = snapshotMessages(canonical, { status: 'cancelled', text: 'Partial answer' })[0];
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.text, 'Partial answer');
  const failed = snapshotMessages(canonical, { status: 'error', error: 'CLI disconnected' })[0];
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'CLI disconnected');
});

test('an active request without a canonical assistant exposes a real pending state', () => {
  const result = snapshotMessages(conversation(), { status: 'starting' });
  assert.equal(result.length, 1);
  assert.equal(result[0].text, '');
  assert.equal(result[0].status, 'pending');
  assert.equal(snapshotMessages(conversation(), { status: 'completed' }).length, 0);
});

test('canonical upserts replace rather than duplicate and keep recent conversations first', () => {
  const first = conversation();
  const second = conversation([], { id: 'two', updatedAt: '2026-01-02T12:00:00.000Z' });
  const result = upsertConversation([first, second], { ...first, title: 'Renamed' });
  assert.deepEqual(result.map((item) => item.id), ['two', 'one']);
  assert.equal(result[1].title, 'Renamed');
});

test('an older buffered event cannot roll back a newer bootstrap conversation', () => {
  const recent = conversation([assistant('answer', 'Keep this')], { updatedAt: '2026-01-03T12:00:00.000Z' });
  assert.deepEqual(upsertConversation([recent], conversation()), [recent]);
});

test('attachment previews merge by ID without mutating the source', () => {
  const one = { id: 'a', name: 'old.txt' }, replacement = { id: 'a', name: 'new.txt' }, two = { id: 'b', name: 'second.txt' };
  const source = [one];
  assert.deepEqual(mergeAttachments(source, [replacement, two]), [replacement, two]);
  assert.deepEqual(source, [one]);
});

test('shortcut recording creates Electron-compatible canonical accelerators', () => {
  assert.equal(shortcutFromKey(key()), 'Control+Shift+Space');
  assert.equal(shortcutFromKey(key({ key: 's', code: 'KeyS' })), 'Control+Shift+S');
  assert.equal(shortcutFromKey(key({ key: 'F12', code: 'F12', shiftKey: false })), 'Control+F12');
  assert.equal(shortcutFromKey(key({ key: 'n', code: 'KeyN', ctrlKey: false, shiftKey: false, metaKey: true })), 'Super+N');
  assert.equal(shortcutFromKey(key({ key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: false })), 'Control+Left');
  assert.equal(shortcutFromKey(key({ key: 'Control', code: 'ControlLeft' })), null);
  assert.equal(shortcutFromKey(key({ key: 'x', code: 'KeyX', ctrlKey: false, shiftKey: false })), null);
  assert.equal(shortcutFromKey(key({ key: 'Dead', code: 'Quote' })), null);
});

test('shortcut recording respects the active layout and rejects AltGr and composition', () => {
  assert.equal(shortcutFromKey(key({ key: 'z', code: 'KeyY' })), 'Control+Shift+Z');
  assert.equal(shortcutFromKey(key({ key: '!', code: 'Digit1' })), 'Control+Shift+1');
  assert.equal(shortcutFromKey(key({ key: 'F8', code: 'F8', ctrlKey: false, shiftKey: false })), 'F8');
  assert.equal(shortcutFromKey(key({ key: '@', code: 'KeyQ', altKey: true, getModifierState: (name) => name === 'AltGraph' })), null);
  assert.equal(shortcutFromKey(key({ key: 'a', code: 'KeyA', isComposing: true })), null);
});

test('Windows shortcut aliases normalize to a stable modifier order before saving', () => {
  assert.equal(normalizeShortcut(' shift + CTRL + Spacebar '), 'Control+Shift+Space');
  assert.equal(normalizeShortcut('win+option+CommandOrControl+s'), 'Control+Alt+Super+S');
  assert.equal(normalizeShortcut('Meta+cmdOrCtrl+ArrowLeft'), 'Control+Super+Left');
  assert.equal(normalizeShortcut('ctrl+Control+a'), 'Control+A');
  assert.equal(normalizeShortcut('f24'), 'F24');
  assert.equal(normalizeShortcut(' '), '');
  for (const invalid of ['A', 'Control', 'Control++A', 'Control+NoSuchKey']) assert.equal(normalizeShortcut(invalid), null);
});

test('shortcut duplicates compare modifier aliases, ordering, and case', () => {
  assert.equal(shortcutIdentity('Control+Shift+Space'), shortcutIdentity('shift+ctrl+space'));
  assert.equal(shortcutIdentity('Control+Alt+Super+S'), shortcutIdentity('Win+Option+CmdOrCtrl+s'));
  const settings = defaultSettings();
  settings.modes.screen.shortcut = 'shift+ctrl+space';
  assert.deepEqual([...duplicateShortcuts(settings)].sort(), ['chat', 'screen']);
  settings.modes.screen.shortcut = '';
  settings.modes.region.shortcut = '';
  assert.equal(duplicateShortcuts(settings).size, 0);
});

test('previews never request remote resources or permit active image markup', () => {
  assert.equal(safeImageSource('https://example.com/tracker.png'), undefined);
  assert.equal(safeImageSource('file:///private/image.png'), undefined);
  assert.equal(safeImageSource('data:image/svg+xml,<svg onload="alert(1)"/>'), undefined);
  assert.equal(safeImageSource('data:image/png;base64,YWJj'), 'data:image/png;base64,YWJj');
});

test('only active request statuses block another send', () => {
  for (const status of ['starting', 'thinking', 'responding']) assert.equal(isRunning(status), true);
  for (const status of ['completed', 'cancelled', 'error', undefined]) assert.equal(isRunning(status), false);
});

test('bootstrap pending messages lock sends, but terminal request events unlock them', () => {
  const pending = conversation([assistant('response', '', 'pending')]);
  assert.equal(busyConversationId([pending], {}), 'one');
  assert.equal(busyConversationId([pending], { one: { status: 'completed' } }), undefined);
  assert.equal(busyConversationId([], { other: { status: 'thinking' } }), 'other');
});

test('external settings events update untouched fields without losing a dirty draft', () => {
  const saved = defaultSettings(), draft = defaultSettings(), next = defaultSettings();
  draft.codex.cliPath = 'my-codex.exe';
  draft.modes.chat.outputs.speech = true;
  next.general.alwaysOnTop = false;
  next.audio.volume = 60;
  const result = rebaseSettingsDraft(draft, saved, next);
  assert.equal(result.codex.cliPath, 'my-codex.exe');
  assert.equal(result.modes.chat.outputs.speech, true);
  assert.equal(result.general.alwaysOnTop, false);
  assert.equal(result.audio.volume, 60);
  assert.equal(draft.general.alwaysOnTop, true);
});

test('both languages expose useful settings and desktop-required messages', () => {
  for (const language of ['de', 'en']) {
    const t = translator(language);
    for (const id of ['desktopRequiredBody', 'savedCliHint', 'savedVoiceHint', 'shortcutConflict', 'autoSendHint']) assert.ok(t(id).length > 25);
  }
  assert.notEqual(translator('de')('settings'), translator('en')('settings'));
});
