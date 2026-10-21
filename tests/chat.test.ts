import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatEngine, type ChatDependencies } from '../electron/chat';
import type { RunOptions } from '../electron/codex';
import { buildPrompt } from '../electron/prompt';
import { MAX_MESSAGE_TEXT, Store } from '../electron/store';
import { MODE_IDS, type AppEvent, type Attachment, type Conversation, type ModeId, type SendInput } from '../shared/types';

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return {
    promise,
    resolve(value: T) { if (!settled) { settled = true; resolvePromise(value); } },
    reject(error: unknown) { if (!settled) { settled = true; rejectPromise(error); } },
  };
}
function aborted(): Error { return Object.assign(new Error('Fixture request cancelled'), { name: 'AbortError' }); }
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle within 2000ms`)), 2000);
    })]);
  } finally { clearTimeout(timer); }
}
async function tick(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }

type RunnerResult = Awaited<ReturnType<ChatDependencies['runner']['run']>>;
type Prepared = Awaited<ReturnType<ChatDependencies['files']['prepare']>>;
async function fixture(directory: string) {
  const store = new Store(directory);
  await store.init();
  const settings = store.settings;
  for (const mode of MODE_IDS) settings.modes[mode].prompt = `UNIQUE_${mode.toUpperCase()}_PREFERENCE`;
  await store.saveSettings(settings);
  const attachments = new Map<string, Attachment>();
  const events: AppEvent[] = [];
  const trace: string[] = [];
  const runs: { options: RunOptions; result: ReturnType<typeof deferred<RunnerResult>> }[] = [];
  const gates: (() => void)[] = [];
  let runnerClosed = false;
  const run = vi.fn((options: RunOptions): Promise<RunnerResult> => {
    const result = deferred<RunnerResult>();
    runs.push({ options, result });
    const abort = () => result.reject(aborted());
    const cleanup = () => options.signal.removeEventListener('abort', abort);
    void result.promise.then(cleanup, cleanup);
    if (runnerClosed) result.reject(new Error('Fixture runner has shut down'));
    else if (options.signal.aborted) abort();
    else options.signal.addEventListener('abort', abort, { once: true });
    return result.promise;
  });
  const runnerShutdown = vi.fn(async () => {
    runnerClosed = true;
    for (const entry of runs) entry.result.reject(aborted());
    await Promise.allSettled(runs.map(entry => entry.result.promise));
  });
  const prepared: Prepared = { text: '', images: [] };
  const prepare = vi.fn(async (_ids: string[]): Promise<Prepared> => structuredClone(prepared));
  const release = vi.fn(async (_ids: string[]) => { trace.push('release'); });
  const openChat = vi.fn(() => { trace.push('openChat'); });
  const copy = vi.fn(async (_text: string) => { trace.push('copy'); });
  const speak = vi.fn(async (_text: string, _audio: typeof settings.audio) => { trace.push('speak'); });
  const notify = vi.fn((_title: string, _body: string) => { trace.push('notify'); });
  // Match IPC's immediate serialization rather than retaining mutable event payload references.
  const emit = vi.fn((event: AppEvent) => {
    events.push(structuredClone(event));
    trace.push(event.type === 'request' ? `request:${event.status}` : event.type);
  });
  const deps: ChatDependencies = { store, runner: { run, shutdown: runnerShutdown }, files: { prepare, release },
    attachments, emit, openChat, copy, speak, notify };
  const engine = new ChatEngine(deps);
  return {
    store, engine, run, runnerShutdown, prepare, release, attachments, prepared, events, trace, runs,
    copy, speak, notify, openChat,
    add(kind: Attachment['kind'], name = `${kind}.fixture`): Attachment {
      const item = { id: randomUUID(), kind, name, size: 42, preview: 'PRIVATE_TRANSIENT_PREVIEW' };
      attachments.set(item.id, item);
      return item;
    },
    blockPrepare() {
      const gate = deferred<Prepared>();
      prepare.mockImplementationOnce(() => gate.promise);
      gates.push(() => gate.resolve(structuredClone(prepared)));
      return gate;
    },
    async disk(id: string): Promise<Conversation> {
      return JSON.parse(await readFile(path.join(directory, 'conversations', `${id}.json`), 'utf8')) as Conversation;
    },
    async idle() {
      await vi.waitFor(() => expect(engine.busy).toBe(false), { timeout: 2000, interval: 5 });
    },
    async finish(text = 'Final answer', sessionId = 'fixture-session') {
      runs[runs.length - 1].result.resolve({ text, sessionId });
      await this.idle();
    },
    requests() { return events.filter((event): event is Extract<AppEvent, { type: 'request' }> => event.type === 'request'); },
    async dispose() {
      for (const releaseGate of gates) releaseGate();
      await bounded(engine.shutdown(), 'Test cleanup');
    },
  };
}
let directory: string;
let h: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'codex-chat-test-'));
  h = await fixture(directory);
});
afterEach(async () => {
  try { await h?.dispose(); }
  finally { if (directory) await rm(directory, { recursive: true, force: true }); }
});
function input(conversation: Conversation, text = 'Question', attachmentIds: string[] = []): SendInput {
  return { conversationId: conversation.id, mode: conversation.mode, text, attachmentIds };
}
async function allOutputs(): Promise<void> {
  const settings = h.store.settings;
  settings.modes.chat.outputs = { chat: true, clipboard: true, speech: true };
  await h.store.saveSettings(settings);
}
function expectNoAnswerOutputs(): void {
  expect(h.copy).not.toHaveBeenCalled();
  expect(h.speak).not.toHaveBeenCalled();
}

describe('ChatEngine modes, prompts and history', () => {
  it.each(MODE_IDS)('creates a %s conversation before any capture/files are selected', async mode => {
    const conversation = await h.engine.create(mode);
    expect(conversation).toMatchObject({ mode, messages: [] });
    expect((await h.disk(conversation.id)).mode).toBe(mode);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
  });

  it.each(MODE_IDS)('uses the actual %s prompt preferences, image arguments and output selection', async mode => {
    const conversation = await h.engine.create(mode);
    const ids: string[] = [];
    if (mode === 'screen' || mode === 'region' || mode === 'files') {
      const image = h.add('image', `${mode}.png`);
      ids.push(image.id);
      h.prepared.images = [path.join(directory, `${image.id}.png`)];
    }
    if (mode === 'files') {
      ids.push(h.add('text', 'source.ts').id, h.add('pdf', 'notes.pdf').id);
      h.prepared.text = '--- File: "source.ts" ---\nconst answer = 42;\n\n--- File: "notes.pdf" ---\nExtracted PDF text';
    }
    const userText = mode === 'screen' || mode === 'files' ? '' : `Question about ${mode}`;
    const settings = h.store.settings;
    await h.engine.start(input(conversation, userText, ids));
    expect(h.engine.busy).toBe(true);
    expect(h.engine.activeId).toBe(conversation.id);
    const options = h.runs[0].options;
    expect(options.prompt).toBe(buildPrompt(mode, settings, userText, h.prepared.text));
    expect(options.prompt).toContain(`Mode: ${mode}`);
    expect(options.prompt).toContain(`UNIQUE_${mode.toUpperCase()}_PREFERENCE`);
    for (const other of MODE_IDS.filter(other => other !== mode)) expect(options.prompt).not.toContain(`UNIQUE_${other.toUpperCase()}_PREFERENCE`);
    expect(options.images).toEqual(h.prepared.images);
    expect(options.sessionId).toBeUndefined();
    expect(h.prepare).toHaveBeenCalledWith(ids);
    options.onEvent({ type: 'session', sessionId: `session-${mode}` });
    options.onEvent({ type: 'status', status: 'thinking' });
    options.onEvent({ type: 'text', text: 'Partial' });
    options.onEvent({ type: 'text', text: 'Final streamed snapshot' });
    expectNoAnswerOutputs();
    expect((await h.disk(conversation.id)).messages.at(-1)?.status).toBe('pending');
    await h.finish(`Completed ${mode}`, `session-${mode}`);
    const saved = await h.disk(conversation.id);
    expect(saved.sessionId).toBe(`session-${mode}`);
    expect(saved.messages.map(message => message.status)).toEqual(['complete', 'complete']);
    expect(saved.messages.at(-1)?.text).toBe(`Completed ${mode}`);
    expect(JSON.stringify(saved)).not.toContain('PRIVATE_TRANSIENT_PREVIEW');
    expect(h.copy).toHaveBeenCalledTimes(settings.modes[mode].outputs.clipboard ? 1 : 0);
    expect(h.speak).toHaveBeenCalledTimes(settings.modes[mode].outputs.speech ? 1 : 0);
    expect(h.openChat).toHaveBeenCalledTimes(settings.modes[mode].outputs.chat ? 1 : 0);
    expect(h.release).toHaveBeenCalledWith(ids);
    for (const id of ids) expect(h.attachments.has(id)).toBe(false);
    expect(h.engine.activeId).toBeUndefined();
  });

  it('resumes the returned session with only the new prompt/images and persists both turns', async () => {
    const conversation = await h.engine.create('chat');
    const firstImage = h.add('image', 'first.png');
    h.prepared.images = [path.join(directory, 'first.png')];
    await h.engine.start(input(conversation, 'First question', [firstImage.id]));
    h.runs[0].options.onEvent({ type: 'session', sessionId: 'intermediate-session' });
    await h.finish('First completed answer', 'canonical-session');
    const secondImage = h.add('image', 'second.png');
    h.prepared.images = [path.join(directory, 'second.png')];
    await h.engine.start(input(conversation, 'Follow up', [secondImage.id]));
    expect(h.runs[1].options.sessionId).toBe('canonical-session');
    expect(h.runs[1].options.images).toEqual([path.join(directory, 'second.png')]);
    expect(h.runs[1].options.prompt).toContain('Follow up');
    expect(h.runs[1].options.prompt).not.toContain('First completed answer');
    await h.finish('Second completed answer', 'canonical-session');
    const restarted = new Store(directory);
    await restarted.init();
    expect(restarted.warnings).toEqual([]);
    expect(restarted.conversations[0].messages.map(message => message.text)).toEqual([
      'First question', 'First completed answer', 'Follow up', 'Second completed answer',
    ]);
    expect(restarted.conversations[0].messages.every(message => message.status === 'complete')).toBe(true);
  });

  it.each(['screen', 'region', 'files'] as const)('permits text-only %s follow-ups after a session exists', async mode => {
    const conversation = await h.engine.create(mode);
    conversation.sessionId = `existing-${mode}`;
    await h.store.putConversation(conversation);
    await h.engine.start(input(conversation, 'Explain more', []));
    expect(h.runs[0].options.sessionId).toBe(`existing-${mode}`);
    expect(h.runs[0].options.images).toEqual([]);
    await h.finish();
  });
});

describe('ChatEngine output routing and settings snapshots', () => {
  it.each([
    { chat: true, clipboard: false, speech: false }, { chat: false, clipboard: true, speech: false },
    { chat: false, clipboard: false, speech: true }, { chat: true, clipboard: true, speech: false },
    { chat: true, clipboard: false, speech: true }, { chat: false, clipboard: true, speech: true },
    { chat: true, clipboard: true, speech: true },
  ])('routes only configured outputs: %j', async outputs => {
    const settings = h.store.settings;
    settings.modes.chat.outputs = outputs;
    await h.store.saveSettings(settings);
    const conversation = await h.engine.create('chat');
    await h.engine.start(input(conversation));
    expect(h.openChat).toHaveBeenCalledTimes(outputs.chat ? 1 : 0);
    h.runs[0].options.onEvent({ type: 'text', text: 'Not completed yet' });
    expectNoAnswerOutputs();
    await h.finish();
    expect(h.copy).toHaveBeenCalledTimes(outputs.clipboard ? 1 : 0);
    expect(h.speak).toHaveBeenCalledTimes(outputs.speech ? 1 : 0);
    expect(h.notify).toHaveBeenCalledTimes(!outputs.chat && outputs.clipboard ? 1 : 0);
  });

  it('copies only after the completed answer is on disk and completion has been emitted', async () => {
    await allOutputs();
    const conversation = await h.engine.create('chat');
    const observed: Conversation[] = [];
    h.copy.mockImplementation(async () => { h.trace.push('copy'); observed.push(await h.disk(conversation.id)); });
    await h.engine.start(input(conversation));
    h.runs[0].options.onEvent({ type: 'text', text: 'partial' });
    expectNoAnswerOutputs();
    await h.finish('Saved final answer');
    expect(observed).toHaveLength(1);
    expect(observed[0].messages.at(-1)).toMatchObject({ status: 'complete', text: 'Saved final answer' });
    expect(h.trace.indexOf('request:completed')).toBeLessThan(h.trace.indexOf('copy'));
  });

  it.each([true, false])('uses the request audio/routing snapshot when speech initially enabled=%s', async enabled => {
    const original = h.store.settings;
    original.modes.chat.outputs = { chat: true, clipboard: enabled, speech: enabled };
    original.audio = { voice: 'original-voice', rate: -2, volume: 34 };
    await h.store.saveSettings(original);
    const conversation = await h.engine.create('chat');
    await h.engine.start(input(conversation));
    const changed = h.store.settings;
    changed.modes.chat.outputs = { chat: true, clipboard: !enabled, speech: !enabled };
    changed.audio = { voice: 'new-voice', rate: 5, volume: 99 };
    await h.store.saveSettings(changed);
    await h.finish('Snapshot answer');
    expect(h.runs[0].options.settings.audio).toEqual(original.audio);
    expect(h.copy).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(h.speak).toHaveBeenCalledTimes(enabled ? 1 : 0);
    if (enabled) expect(h.speak).toHaveBeenCalledWith('Snapshot answer', original.audio);
  });

  it('does not claim clipboard success when copying the completed answer failed', async () => {
    const settings = h.store.settings;
    settings.modes.chat.outputs = { chat: false, clipboard: true, speech: false };
    await h.store.saveSettings(settings);
    h.copy.mockRejectedValueOnce(new Error('clipboard locked'));
    const conversation = await h.engine.create('chat');
    await h.engine.start(input(conversation));
    await h.finish();
    expect((await h.disk(conversation.id)).messages.at(-1)?.status).toBe('complete');
    expect(h.events).toContainEqual({ type: 'error', message: 'Clipboard: clipboard locked' });
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe('ChatEngine failures, preparation and cancellation', () => {
  it.each(['cancel', 'abort-error', 'failure'] as const)('persists %s without clipboard or speech output and releases consumed attachments', async cause => {
    await allOutputs();
    const conversation = await h.engine.create('chat');
    const attachment = h.add('text', 'source.ts');
    h.prepared.text = 'const input = 1;';
    await h.engine.start(input(conversation, 'Question', [attachment.id]));
    h.runs[0].options.onEvent({ type: 'text', text: 'Partial answer' });
    if (cause === 'cancel') await bounded(h.engine.cancel(conversation.id), 'Cancellation');
    else {
      h.runs[0].result.reject(cause === 'abort-error' ? aborted() : new Error('CLI failed'));
      await h.idle();
    }
    const saved = (await h.disk(conversation.id)).messages.at(-1)!;
    expect(saved).toMatchObject({ text: 'Partial answer', status: cause === 'failure' ? 'error' : 'cancelled' });
    if (cause === 'failure') expect(saved.error).toContain('CLI failed');
    expectNoAnswerOutputs();
    expect(h.notify).toHaveBeenCalledTimes(cause === 'failure' ? 1 : 0);
    expect(h.release).toHaveBeenCalledWith([attachment.id]);
    expect(h.attachments.has(attachment.id)).toBe(false);
    expect(h.engine.busy).toBe(false);
  });

  it('retains attachments and empty history after prepare failure, allowing the same selection to retry', async () => {
    const conversation = await h.engine.create('files');
    const attachment = h.add('text', 'retry.ts');
    h.prepared.text = 'File source';
    h.prepare.mockRejectedValueOnce(new Error('file changed while reading'));
    const request = input(conversation, '', [attachment.id]);
    await expect(h.engine.start(request)).rejects.toThrow('file changed');
    expect(h.engine.busy).toBe(false);
    expect((await h.disk(conversation.id)).messages).toEqual([]);
    expect(h.run).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    expect(h.attachments.has(attachment.id)).toBe(true);
    expectNoAnswerOutputs();
    await h.engine.start(request);
    await h.finish();
    expect(h.prepare).toHaveBeenCalledTimes(2);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.attachments.has(attachment.id)).toBe(false);
  });

  it.each(['cancel', 'shutdown'] as const)('%s during prepare waits for preparation, then aborts without launching the runner', async action => {
    const conversation = await h.engine.create('chat');
    const attachment = h.add('text', 'pending.txt');
    const preparation = h.blockPrepare();
    const starting = h.engine.start(input(conversation, 'Question', [attachment.id])).catch(error => error);
    expect(h.engine.busy).toBe(true);
    let stopped = false;
    const stopping = (action === 'cancel' ? h.engine.cancel(conversation.id) : h.engine.shutdown()).then(() => { stopped = true; });
    await tick();
    expect(stopped).toBe(false);
    preparation.resolve({ text: 'Prepared after cancellation', images: [] });
    expect(await bounded(starting, 'Cancelled preparation')).toMatchObject({ name: 'AbortError' });
    await bounded(stopping, `${action} drain`);
    expect(h.engine.busy).toBe(false);
    expect(h.run).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    expect(h.attachments.has(attachment.id)).toBe(true);
    expect((await h.disk(conversation.id)).messages).toEqual([]);
    expectNoAnswerOutputs();
    if (action === 'shutdown') await expect(h.engine.start(input(conversation))).rejects.toThrow(/shutting down/i);
  });

  it.each(['cancel', 'shutdown'] as const)('does not launch a runner if %s happens during the initial real Store write', async action => {
    const conversation = await h.engine.create('chat');
    // Observe, but do not replace, the real Store's persistence method.
    const writes = vi.spyOn(h.store, 'putConversation');
    const starting = h.engine.start(input(conversation));
    // Preparation resumes first; the real Store still has async init/fs work to finish.
    await Promise.resolve();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(h.run).not.toHaveBeenCalled();
    const stopping = action === 'cancel' ? h.engine.cancel(conversation.id) : h.engine.shutdown();
    await bounded(starting.catch(error => error), 'Starting request');
    await bounded(stopping, `${action} during initial persistence`);
    expect(h.run.mock.calls.length, 'A cancelled or shut-down request must not invoke runner.run').toBe(0);
    expectNoAnswerOutputs();
    expect(h.openChat).not.toHaveBeenCalled();
    expect((await h.disk(conversation.id)).messages.at(-1)?.status).toBe('cancelled');
  });

  it.each(['cancel', 'shutdown'] as const)('suppresses outputs if %s happens while the completed answer is being persisted', async action => {
    await allOutputs();
    const conversation = await h.engine.create('chat');
    await h.engine.start(input(conversation));
    const writes = vi.spyOn(h.store, 'putConversation');
    h.runs[0].result.resolve({ text: 'Generation finished; persistence still in progress', sessionId: 'session' });
    // Resume execute() through its abort check, but not through the asynchronous Store write.
    await Promise.resolve();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0][0].messages.at(-1)?.status).toBe('complete');
    const stopping = action === 'cancel' ? h.engine.cancel(conversation.id) : h.engine.shutdown();
    await bounded(stopping, `${action} during completion persistence`);
    expect({ clipboard: h.copy.mock.calls.length, speech: h.speak.mock.calls.length }).toEqual({ clipboard: 0, speech: 0 });
  });

  it('emits a terminal request error rather than leaving pending history when the completed reply exceeds Store limits', async () => {
    await allOutputs();
    const conversation = await h.engine.create('chat');
    await h.engine.start(input(conversation));
    await h.finish('x'.repeat(MAX_MESSAGE_TEXT + 1));
    expectNoAnswerOutputs();
    expect(h.requests().some(event => event.status === 'error' && !!event.error)).toBe(true);
    expect({ terminalError: h.requests().some(event => event.status === 'error'),
      persistedStatus: (await h.disk(conversation.id)).messages.at(-1)?.status,
    }).toEqual({ terminalError: true, persistedStatus: 'error' });
  });
});

describe('ChatEngine input validation and concurrency', () => {
  it('rejects invalid creation modes and conversation/mode mismatches without preparing files', async () => {
    await expect(h.engine.create('invalid' as ModeId)).rejects.toThrow(/invalid mode/i);
    const conversation = await h.engine.create('chat');
    await expect(h.engine.start({ ...input(conversation), mode: 'files' })).rejects.toThrow(/mode mismatch/i);
    await expect(h.engine.start({ ...input(conversation), conversationId: randomUUID() })).rejects.toThrow(/mode mismatch/i);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
    expect((await h.disk(conversation.id)).messages).toEqual([]);
  });

  it.each(['screen', 'region', 'files'] as const)('requires the appropriate initial attachment for an unresumed %s send, not for creation', async mode => {
    const conversation = await h.engine.create(mode);
    await expect(h.engine.start(input(conversation, 'Analyze', []))).rejects.toThrow(mode === 'files' ? /select files/i : /capture a screenshot/i);
    if (mode !== 'files') {
      const text = h.add('text', 'not-a-screenshot.txt');
      await expect(h.engine.start(input(conversation, 'Analyze', [text.id]))).rejects.toThrow(/capture a screenshot/i);
    }
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
  });

  it.each(['empty', 'long', 'mode', 'ids', 'id-type', 'duplicate', 'stale'] as const)('rejects %s send inputs before any side effects', async invalid => {
    const conversation = await h.engine.create('chat');
    let request: unknown = input(conversation);
    if (invalid === 'empty') request = input(conversation, '   ');
    if (invalid === 'long') request = input(conversation, 'x'.repeat(32_001));
    if (invalid === 'mode') request = { ...input(conversation), mode: 'invalid' };
    if (invalid === 'ids') request = { ...input(conversation), attachmentIds: 'not-an-array' };
    if (invalid === 'id-type') request = { ...input(conversation), attachmentIds: [123] };
    if (invalid === 'duplicate') { const attachment = h.add('text'); request = input(conversation, 'Question', [attachment.id, attachment.id]); }
    if (invalid === 'stale') request = input(conversation, 'Question', [randomUUID()]);
    await expect(h.engine.start(request as SendInput)).rejects.toThrow();
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    expect(h.engine.busy).toBe(false);
    expect((await h.disk(conversation.id)).messages).toEqual([]);
  });

  it('rejects IDs consumed by a previous completed turn instead of silently reusing released attachments', async () => {
    const conversation = await h.engine.create('chat');
    const attachment = h.add('text');
    await h.engine.start(input(conversation, 'First', [attachment.id]));
    await h.finish();
    await expect(h.engine.start(input(conversation, 'Again', [attachment.id]))).rejects.toThrow(/reattach/i);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect((await h.disk(conversation.id)).messages).toHaveLength(2);
  });

  it.each(['preparing', 'running'] as const)('blocks active deletion/concurrent sends while %s, but permits deleting another conversation', async phase => {
    const active = await h.engine.create('chat');
    const other = await h.engine.create('chat');
    const preparation = phase === 'preparing' ? h.blockPrepare() : undefined;
    const starting = h.engine.start(input(active));
    if (!preparation) await starting;
    expect(h.engine.activeId).toBe(active.id);
    await expect(h.engine.remove(active.id)).rejects.toThrow(/stop this conversation/i);
    await expect(h.engine.start(input(other))).rejects.toThrow(/already running/i);
    await h.engine.remove(other.id);
    expect(h.store.conversations.some(item => item.id === other.id)).toBe(false);
    await h.engine.cancel(randomUUID());
    expect(h.engine.busy).toBe(true);
    if (preparation) { preparation.resolve({ text: '', images: [] }); await bounded(starting, 'Preparation'); }
    await h.finish();
    await h.engine.remove(active.id);
    expect(h.store.conversations).toEqual([]);
    await expect(readFile(path.join(directory, 'conversations', `${active.id}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
