import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '../shared/defaults';
import type { Conversation } from '../shared/types';
import { Store, MAX_MESSAGES, MAX_MESSAGE_TEXT, MAX_CONVERSATION_TEXT } from '../electron/store';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'codex-store-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const timestamp = '2026-10-21T12:00:00.000Z';
function sample(id: string = randomUUID()): Conversation {
  return { id, title: 'Test conversation', mode: 'chat', createdAt: timestamp, updatedAt: timestamp,
    messages: [{ id: randomUUID(), role: 'user', text: 'Hello', createdAt: timestamp }] };
}
async function json(file: string): Promise<any> { return JSON.parse(await readFile(file, 'utf8')); }
async function fixtureFiles(): Promise<string> {
  const conversations = path.join(directory, 'conversations');
  await mkdir(conversations, { recursive: true });
  return conversations;
}

describe('Store loading', () => {
  it('loads independent defaults, no conversations or bounds, and initializes once', async () => {
    const store = new Store(directory);
    expect(store.init()).toBe(store.init());
    await store.init();
    expect(store.settings).toEqual(defaultSettings());
    expect(store.conversations).toEqual([]);
    expect(store.bounds).toBeUndefined();
    expect(store.warnings).toEqual([]);
    const copy = store.settings;
    copy.general.theme = 'light';
    expect(store.settings.general.theme).toBe('dark');
  });

  it('merges defaults only while loading partial stored settings', async () => {
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ version: 1,
      general: { theme: 'light' }, codex: { model: 'custom-model' }, modes: { chat: { prompt: 'Preference' } } }));
    const store = new Store(directory);
    await store.init();
    expect(store.settings.general.theme).toBe('light');
    expect(store.settings.codex.model).toBe('custom-model');
    expect(store.settings.codex.sandbox).toBe('read-only');
    expect(store.settings.modes.chat.prompt).toBe('Preference');
    expect(store.settings.modes.chat.shortcut).toBe(defaultSettings().modes.chat.shortcut);
    expect(store.warnings).toEqual([]);
  });

  it.each(['{ broken', 'null', '{"version":2}', '{"codex":{"sandbox":"danger-full-access"}}', '{"unknown":true}',
    '{"general":{"__proto__":{"polluted":true}}}'])('quarantines malformed/invalid settings %s without silently discarding originals', async content => {
    await writeFile(path.join(directory, 'settings.json'), content);
    const store = new Store(directory);
    await store.init();
    expect(store.settings).toEqual(defaultSettings());
    const quarantined = (await readdir(directory)).filter(name => name.startsWith('settings.json.corrupt-'));
    expect(quarantined).toHaveLength(1);
    expect(await readFile(path.join(directory, quarantined[0]), 'utf8')).toBe(content);
    await expect(readFile(path.join(directory, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(store.warnings[0]).toContain('Quarantined');
    const warnings = store.warnings;
    warnings.length = 0;
    expect(store.warnings).toHaveLength(1);
  });

  it('quarantines malformed bounds and conversation files independently while loading good records', async () => {
    const folder = await fixtureFiles();
    const good = sample();
    const brokenId = randomUUID();
    const mismatchId = randomUUID();
    await writeFile(path.join(folder, `${good.id}.json`), JSON.stringify(good));
    await writeFile(path.join(folder, `${brokenId}.json`), 'not json');
    await writeFile(path.join(folder, `${mismatchId}.json`), JSON.stringify(sample()));
    await writeFile(path.join(folder, 'not-a-uuid.json'), 'do not parse me');
    await writeFile(path.join(directory, 'window.json'), JSON.stringify({ x: 0, y: 0, width: -1, height: 600 }));
    const store = new Store(directory);
    await store.init();
    expect(store.conversations).toEqual([good]);
    expect(store.bounds).toBeUndefined();
    expect(store.warnings).toHaveLength(4);
    expect((await readdir(folder)).filter(name => name.includes('.corrupt-'))).toHaveLength(3);
  });

  it('marks interrupted pending messages cancelled and persists the recovery', async () => {
    const store = new Store(directory);
    const pending = sample();
    pending.messages.push({ id: randomUUID(), role: 'assistant', text: 'partial', createdAt: timestamp, status: 'pending' });
    await store.putConversation(pending);
    expect(store.conversations[0].messages[1].status).toBe('pending');
    const restarted = new Store(directory);
    await restarted.init();
    const recovered = restarted.conversations[0].messages[1];
    expect(recovered).toMatchObject({ status: 'cancelled', text: 'partial', error: expect.stringContaining('restart') });
    expect((await json(path.join(directory, 'conversations', `${pending.id}.json`))).messages[1].status).toBe('cancelled');
    expect(restarted.warnings[0]).toContain('interrupted');
    const again = new Store(directory);
    await again.init();
    expect(again.warnings).toEqual([]);
  });

  it('recovers a full-budget interrupted conversation without creating an invalid persisted record', async () => {
    const store = new Store(directory);
    const input = sample();
    input.messages = Array.from({ length: MAX_CONVERSATION_TEXT / MAX_MESSAGE_TEXT }, (_, index) => ({
      id: String(index), role: 'assistant' as const, text: 'x'.repeat(MAX_MESSAGE_TEXT), createdAt: timestamp, status: 'pending' as const,
    }));
    await store.putConversation(input);
    const restarted = new Store(directory);
    await restarted.init();
    expect(restarted.conversations[0].messages.every(message => message.status === 'cancelled')).toBe(true);
    const again = new Store(directory);
    await again.init();
    expect(again.conversations).toHaveLength(1);
    expect(again.warnings).toEqual([]);
  });

  it('removes legacy attachment previews and extra private metadata on load and on disk', async () => {
    const folder = await fixtureFiles();
    const input = sample();
    input.messages[0].attachments = [{ id: 'attachment', name: 'image.png', kind: 'image', size: 5, preview: 'data:image/png;base64,PRIVATE' }];
    Object.assign(input.messages[0].attachments[0], { localPath: 'C:/private/file.png' });
    await writeFile(path.join(folder, `${input.id}.json`), JSON.stringify(input));
    const store = new Store(directory);
    await store.init();
    expect(store.conversations[0].messages[0].attachments).toEqual([{ id: 'attachment', name: 'image.png', kind: 'image', size: 5 }]);
    const disk = await readFile(path.join(folder, `${input.id}.json`), 'utf8');
    expect(disk).not.toContain('PRIVATE');
    expect(disk).not.toContain('localPath');
  });

  it('bounds file bytes and rejects malformed UTF-8 instead of decoding replacement characters', async () => {
    await writeFile(path.join(directory, 'settings.json'), 'x'.repeat(512 * 1024 + 1));
    await writeFile(path.join(directory, 'window.json'), Buffer.from([0xff, 0xfe, 0x7b]));
    const store = new Store(directory);
    await store.init();
    expect(store.warnings).toHaveLength(2);
    expect((await readdir(directory)).filter(name => name.includes('.corrupt-'))).toHaveLength(2);
  });

  it('does not read a hard-linked external settings file', async () => {
    const outside = path.join(directory, 'external.json');
    const settings = defaultSettings();
    settings.general.theme = 'light';
    await writeFile(outside, JSON.stringify(settings));
    await link(outside, path.join(directory, 'settings.json'));
    const store = new Store(directory);
    await store.init();
    expect(store.settings.general.theme).toBe('dark');
    expect((await json(outside)).general.theme).toBe('light');
    expect(store.warnings[0]).toContain('private storage file');
  });
});

describe('Store writes and validation', () => {
  it('round-trips settings, conversations, sessions and negative multi-monitor bounds', async () => {
    const store = new Store(directory);
    const settings = defaultSettings();
    settings.codex.sandbox = 'workspace-write';
    const input = sample();
    input.sessionId = 'codex-session';
    const bounds = { x: -1920, y: -40, width: 1200, height: 800 };
    await Promise.all([store.saveSettings(settings), store.putConversation(input), store.saveBounds(bounds)]);
    const restarted = new Store(directory);
    await restarted.init();
    expect(restarted.settings).toEqual(settings);
    expect(restarted.conversations).toEqual([input]);
    expect(restarted.bounds).toEqual(bounds);
    expect(restarted.warnings).toEqual([]);
    expect((await readdir(directory)).some(name => name.includes('.tmp-'))).toBe(false);
  });

  it('accepts explicitly undefined optional fields permitted by the shared types', async () => {
    const store = new Store(directory);
    const input = sample();
    input.sessionId = undefined;
    Object.assign(input.messages[0], { status: undefined, error: undefined, attachments: undefined });
    await store.putConversation(input);
    const disk = await json(path.join(directory, 'conversations', `${input.id}.json`));
    expect(disk).not.toHaveProperty('sessionId');
    expect(disk.messages[0]).not.toHaveProperty('attachments');
    expect(disk.messages[0]).not.toHaveProperty('error');
    expect(disk.messages[0]).not.toHaveProperty('status');
  });

  it('captures input snapshots at call time and exposes defensive getters', async () => {
    const store = new Store(directory);
    const input = sample();
    input.messages[0].attachments = [{ id: 'a', name: 'image.png', kind: 'image', size: 4, preview: 'secret' }];
    const pending = store.putConversation(input);
    input.messages[0].text = 'mutated';
    input.messages[0].attachments[0].name = 'changed.png';
    await pending;
    const output = store.conversations;
    expect(output[0].messages[0].text).toBe('Hello');
    expect(output[0].messages[0].attachments).toEqual([{ id: 'a', name: 'image.png', kind: 'image', size: 4 }]);
    output[0].messages[0].text = 'mutated getter';
    expect(store.conversations[0].messages[0].text).toBe('Hello');
    expect(await readFile(path.join(directory, 'conversations', `${input.id}.json`), 'utf8')).not.toContain('secret');
    await store.saveBounds({ x: 0, y: 0, width: 900, height: 600 });
    store.bounds!.width = 1;
    expect(store.bounds!.width).toBe(900);
  });

  it('serializes concurrent writes and put/delete races in invocation order', async () => {
    const store = new Store(directory);
    const input = sample();
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      const settings = defaultSettings();
      settings.audio.volume = i;
      writes.push(store.saveSettings(settings));
      writes.push(store.putConversation({ ...input, title: `Title ${i}` }));
    }
    writes.push(store.deleteConversation(input.id));
    writes.push(store.putConversation({ ...input, title: 'Final' }));
    await Promise.all(writes);
    expect(store.settings.audio.volume).toBe(19);
    expect((await json(path.join(directory, 'settings.json'))).audio.volume).toBe(19);
    expect(store.conversations[0].title).toBe('Final');
    expect((await json(path.join(directory, 'conversations', `${input.id}.json`))).title).toBe('Final');
    expect((await readdir(path.join(directory, 'conversations'))).filter(name => name.includes('.tmp-'))).toEqual([]);
  });

  it('leaves memory unchanged on failed atomic rename, cleans temporary files and continues its queue', async () => {
    const store = new Store(directory);
    await store.init();
    await mkdir(path.join(directory, 'settings.json'));
    const settings = defaultSettings();
    settings.audio.volume = 30;
    await expect(store.saveSettings(settings)).rejects.toThrow();
    expect(store.settings.audio.volume).toBe(85);
    expect((await readdir(directory)).some(name => name.includes('.tmp-'))).toBe(false);
    await rm(path.join(directory, 'settings.json'), { recursive: true });
    await store.saveSettings(settings);
    expect(store.settings.audio.volume).toBe(30);
  });

  it.each(['../settings', 'a/../../window', 'C:\\secret.json', '123',
    '11111111-1111-1111-8111-111111111111', '11111111-1111-4111-0111-111111111111'])('rejects unsafe/non-v4-v7 IDs %s', async value => {
    const store = new Store(directory);
    await expect(store.putConversation(sample(value))).rejects.toThrow('UUID');
    await expect(store.deleteConversation(value)).rejects.toThrow('UUID');
    expect(await readdir(directory)).toEqual([]);
  });

  it('accepts UUID v7 and canonicalizes UUID case, with idempotent deletion', async () => {
    const store = new Store(directory);
    const input = sample('019A1DE0-1234-7ABC-8DEF-0123456789AB');
    await store.putConversation(input);
    expect(store.conversations[0].id).toBe(input.id.toLowerCase());
    await store.deleteConversation(input.id);
    await store.deleteConversation(input.id);
    expect(store.conversations).toEqual([]);
    expect(await readdir(path.join(directory, 'conversations'))).toEqual([]);
  });

  it('bounds message count, individual text and aggregate conversation text without silent truncation', async () => {
    const store = new Store(directory);
    const count = sample();
    count.messages = Array.from({ length: MAX_MESSAGES + 1 }, (_, index) => ({ ...count.messages[0], id: String(index) }));
    await expect(store.putConversation(count)).rejects.toThrow('messages');
    const large = sample();
    large.messages[0].text = 'x'.repeat(MAX_MESSAGE_TEXT + 1);
    await expect(store.putConversation(large)).rejects.toThrow('message.text');
    const aggregate = sample();
    aggregate.messages = Array.from({ length: Math.floor(MAX_CONVERSATION_TEXT / MAX_MESSAGE_TEXT) + 1 }, (_, index) => ({ ...aggregate.messages[0], id: String(index), text: 'x'.repeat(MAX_MESSAGE_TEXT) }));
    await expect(store.putConversation(aggregate)).rejects.toThrow('Conversation text exceeds');
    expect(store.conversations).toEqual([]);
  });

  it('rejects malformed message data, duplicate IDs and invalid window bounds', async () => {
    const store = new Store(directory);
    const duplicate = sample();
    duplicate.messages.push({ ...duplicate.messages[0] });
    await expect(store.putConversation(duplicate)).rejects.toThrow('Duplicate message');
    for (const invalid of [0, -1, NaN, Infinity]) {
      await expect(store.saveBounds({ x: 0, y: 0, width: invalid, height: 600 })).rejects.toThrow('bounds.width');
    }
    const settings = defaultSettings();
    delete (settings as unknown as Record<string, unknown>).audio;
    await expect(store.saveSettings(settings)).rejects.toThrow('audio');
  });

  it('returns conversations most recently updated first', async () => {
    const store = new Store(directory);
    const old = sample();
    const recent = { ...sample(), updatedAt: '2026-10-22T12:00:00.000Z' };
    await store.putConversation(old);
    await store.putConversation(recent);
    expect(store.conversations.map(item => item.id)).toEqual([recent.id, old.id]);
  });
});
