import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { defaultSettings } from '../shared/defaults';
import { MODE_IDS, type Attachment, type Conversation, type Message, type Settings } from '../shared/types';
import { validateSettings } from './config';

export interface WindowBounds { x: number; y: number; width: number; height: number }
export const MAX_MESSAGES = 1000;
export const MAX_MESSAGE_TEXT = 200_000;
export const MAX_CONVERSATION_TEXT = 2_000_000;
export const MAX_CONVERSATIONS = 1000;
const CONVERSATION_BYTES = 16 * 1024 * 1024;
const SETTINGS_BYTES = 512 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function object(value: unknown, name: string, required: string[] = [], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${name} must be an object.`);
  const result = value as Record<string, unknown>;
  if (required.length) {
    for (const key of Object.keys(result)) if (![...required, ...optional].includes(key)) throw new TypeError(`Unknown ${name} field: ${key}.`);
    for (const key of required) if (!Object.hasOwn(result, key)) throw new TypeError(`${name}.${key} is required.`);
  }
  return result;
}
function string(value: unknown, name: string, limit: number, nonempty = false): string {
  if (typeof value !== 'string' || value.length > limit || (nonempty && !value.trim())) throw new TypeError(`Invalid ${name}; maximum ${limit} characters.`);
  return value;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError('Conversation ID must be a UUID v4 or v7.');
  return value.toLowerCase();
}
function date(value: unknown, name: string): string {
  const text = string(value, name, 40, true);
  if (!/^\d{4}-\d\d-\d\dT/.test(text) || !Number.isFinite(Date.parse(text))) throw new TypeError(`Invalid ${name}.`);
  return text;
}
function attachment(value: unknown): Attachment {
  const raw = object(value, 'attachment');
  if (!['image', 'text', 'pdf'].includes(raw.kind as string)) throw new TypeError('Invalid attachment.kind.');
  if (!Number.isSafeInteger(raw.size) || (raw.size as number) < 0) throw new TypeError('Invalid attachment.size.');
  // Deliberately whitelist metadata; previews, local paths and other transient fields never survive.
  return { id: string(raw.id, 'attachment.id', 200, true), name: string(raw.name, 'attachment.name', 512, true),
    kind: raw.kind as Attachment['kind'], size: raw.size as number };
}
function conversation(value: unknown): Conversation {
  const raw = object(value, 'conversation', ['id', 'title', 'mode', 'createdAt', 'updatedAt', 'messages'], ['sessionId']);
  if (!MODE_IDS.includes(raw.mode as Conversation['mode'])) throw new TypeError('Invalid conversation.mode.');
  if (!Array.isArray(raw.messages) || raw.messages.length > MAX_MESSAGES) throw new RangeError(`A conversation may contain at most ${MAX_MESSAGES} messages.`);
  const messageIds = new Set<string>();
  let total = 0;
  const messages: Message[] = raw.messages.map(value => {
    const message = object(value, 'message', ['id', 'role', 'text', 'createdAt'], ['attachments', 'status', 'error']);
    const messageId = string(message.id, 'message.id', 200, true);
    if (messageIds.has(messageId)) throw new TypeError('Duplicate message ID.');
    messageIds.add(messageId);
    if (message.role !== 'user' && message.role !== 'assistant') throw new TypeError('Invalid message.role.');
    const result: Message = { id: messageId, role: message.role, text: string(message.text, 'message.text', MAX_MESSAGE_TEXT), createdAt: date(message.createdAt, 'message.createdAt') };
    total += result.text.length;
    if (message.status !== undefined) {
      if (!['pending', 'complete', 'cancelled', 'error'].includes(message.status as string)) throw new TypeError('Invalid message.status.');
      result.status = message.status as Message['status'];
    }
    if (message.error !== undefined) { result.error = string(message.error, 'message.error', 8192); total += result.error.length; }
    if (message.attachments !== undefined) {
      if (!Array.isArray(message.attachments) || message.attachments.length > 50) throw new TypeError('At most 50 attachments are allowed per message.');
      result.attachments = message.attachments.map(attachment);
      if (new Set(result.attachments.map(item => item.id)).size !== result.attachments.length) throw new TypeError('Duplicate attachment ID.');
    }
    if (total > MAX_CONVERSATION_TEXT) throw new RangeError(`Conversation text exceeds ${MAX_CONVERSATION_TEXT} characters.`);
    return result;
  });
  const result: Conversation = { id: id(raw.id), title: string(raw.title, 'conversation.title', 200), mode: raw.mode as Conversation['mode'],
    createdAt: date(raw.createdAt, 'conversation.createdAt'), updatedAt: date(raw.updatedAt, 'conversation.updatedAt'), messages };
  if (raw.sessionId !== undefined) {
    result.sessionId = string(raw.sessionId, 'conversation.sessionId', 200, true);
    if (result.sessionId.includes('\0')) throw new TypeError('Invalid conversation.sessionId.');
  }
  return result;
}
function bounds(value: unknown): WindowBounds {
  const raw = object(value, 'bounds', ['x', 'y', 'width', 'height']);
  for (const key of ['x', 'y', 'width', 'height']) {
    const number = raw[key];
    const dimension = key === 'width' || key === 'height';
    if (!Number.isSafeInteger(number) || (number as number) < (dimension ? 1 : -1_000_000)
      || (number as number) > (dimension ? 32_768 : 1_000_000)) throw new TypeError(`Invalid bounds.${key}.`);
  }
  return { x: raw.x as number, y: raw.y as number, width: raw.width as number, height: raw.height as number };
}

/** Loading-only merge. Supplied invalid values and unknown keys are retained for strict validation. */
function mergeDefaults(defaults: unknown, stored: unknown): unknown {
  const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  if (!plain(defaults) || !plain(stored)) return stored;
  return Object.fromEntries([...new Set([...Object.keys(defaults), ...Object.keys(stored)])].map(key => [key,
    Object.hasOwn(stored, key) ? mergeDefaults(defaults[key], stored[key]) : defaults[key]]));
}
function code(error: unknown, expected: string): boolean { return (error as NodeJS.ErrnoException | null)?.code === expected; }

async function atomicRename(source: string, destination: string): Promise<void> {
  // Windows antivirus/indexers can briefly hold the destination without FILE_SHARE_DELETE.
  // Retry the atomic replacement; never unlink the previous, valid settings file first.
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, destination); return; }
    catch (error) {
      if (process.platform !== 'win32' || attempt >= 8
        || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

export class Store {
  private readonly directory: string;
  private readonly conversationDirectory: string;
  private currentSettings = defaultSettings();
  private readonly currentConversations = new Map<string, Conversation>();
  private currentBounds?: WindowBounds;
  private readonly notices: string[] = [];
  private queue: Promise<void> = Promise.resolve();
  private initialization?: Promise<void>;

  constructor(directory: string) {
    if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) throw new TypeError('A storage directory is required.');
    this.directory = path.resolve(directory);
    this.conversationDirectory = path.join(this.directory, 'conversations');
  }

  get settings(): Settings { return structuredClone(this.currentSettings); }
  get conversations(): Conversation[] {
    return structuredClone([...this.currentConversations.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id)));
  }
  get bounds(): WindowBounds | undefined { return this.currentBounds ? { ...this.currentBounds } : undefined; }
  get warnings(): string[] { return [...this.notices]; }

  init(): Promise<void> {
    if (!this.initialization) this.initialization = this.enqueue(async () => {
      await mkdir(this.directory, { recursive: true });
      await this.assertDirectory(this.directory);
      await mkdir(this.conversationDirectory, { recursive: true });
      await this.assertDirectories();
      const settings = await this.load(path.join(this.directory, 'settings.json'), SETTINGS_BYTES, value => validateSettings(mergeDefaults(defaultSettings(), value)));
      if (settings) this.currentSettings = settings;
      this.currentBounds = await this.load(path.join(this.directory, 'window.json'), 4096, bounds);
      const entries = (await readdir(this.conversationDirectory)).filter(name => name.toLowerCase().endsWith('.json')).sort();
      for (const name of entries) {
        const filename = path.join(this.conversationDirectory, name);
        const fileId = name.slice(0, -5);
        if (!UUID.test(fileId)) { await this.quarantine(filename, 'invalid conversation filename'); continue; }
        if (this.currentConversations.size >= MAX_CONVERSATIONS) {
          this.notices.push(`Conversation limit ${MAX_CONVERSATIONS} reached; additional files were left untouched.`);
          break;
        }
        let rewrite = false;
        let interrupted = 0;
        const loaded = await this.load(filename, CONVERSATION_BYTES, value => {
          const parsed = conversation(value);
          if (parsed.id !== fileId.toLowerCase() || this.currentConversations.has(parsed.id)) throw new TypeError('Conversation ID does not match its unique filename.');
          let remaining = MAX_CONVERSATION_TEXT - parsed.messages.reduce((sum, message) => sum + message.text.length + (message.error?.length ?? 0), 0);
          for (const message of parsed.messages) if (message.status === 'pending') {
            message.status = 'cancelled';
            const notice = 'Interrupted by an application restart.';
            if (!message.error && remaining >= notice.length) {
              message.error = notice;
              remaining -= notice.length;
            }
            interrupted++;
          }
          rewrite = JSON.stringify(value) !== JSON.stringify(parsed);
          return parsed;
        });
        if (!loaded) continue;
        if (rewrite) await this.writeJSON(filename, loaded, CONVERSATION_BYTES);
        this.currentConversations.set(loaded.id, loaded);
        if (interrupted) this.notices.push(`Recovered ${interrupted} interrupted message(s) in ${loaded.id} as cancelled.`);
      }
    });
    return this.initialization;
  }

  async saveSettings(settings: Settings): Promise<void> {
    const snapshot = validateSettings(settings);
    await this.init();
    await this.enqueue(async () => {
      await this.writeJSON(path.join(this.directory, 'settings.json'), snapshot, SETTINGS_BYTES);
      this.currentSettings = snapshot;
    });
  }

  async putConversation(value: Conversation): Promise<void> {
    const snapshot = conversation(value);
    await this.init();
    await this.enqueue(async () => {
      if (!this.currentConversations.has(snapshot.id) && this.currentConversations.size >= MAX_CONVERSATIONS) throw new RangeError('Conversation limit reached.');
      await this.writeJSON(path.join(this.conversationDirectory, `${snapshot.id}.json`), snapshot, CONVERSATION_BYTES);
      this.currentConversations.set(snapshot.id, snapshot);
    });
  }

  async deleteConversation(value: string): Promise<void> {
    const key = id(value);
    await this.init();
    await this.enqueue(async () => {
      await this.assertDirectories();
      try { await unlink(path.join(this.conversationDirectory, `${key}.json`)); }
      catch (error) { if (!code(error, 'ENOENT')) throw error; }
      this.currentConversations.delete(key);
    });
  }

  async saveBounds(value: WindowBounds): Promise<void> {
    const snapshot = bounds(value);
    await this.init();
    await this.enqueue(async () => {
      await this.writeJSON(path.join(this.directory, 'window.json'), snapshot, 4096);
      this.currentBounds = snapshot;
    });
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  private async assertDirectory(directory: string): Promise<void> {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Storage directories must be real directories, not symbolic links.');
  }
  private async assertDirectories(): Promise<void> {
    await this.assertDirectory(this.directory);
    await this.assertDirectory(this.conversationDirectory);
  }

  private async load<T>(filename: string, limit: number, validate: (value: unknown) => T): Promise<T | undefined> {
    try {
      await this.assertDirectories();
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new TypeError('Not a regular private storage file.');
      if (info.size > limit) throw new RangeError('Storage file is too large.');
      const handle = await open(filename, 'r');
      try {
        const opened = await handle.stat();
        if (opened.ino !== info.ino || opened.dev !== info.dev || opened.nlink > 1) throw new TypeError('Storage file changed while opening.');
        const chunks: Buffer[] = [];
        let size = 0;
        while (true) {
          const buffer = Buffer.alloc(Math.min(64 * 1024, limit + 1 - size));
          const { bytesRead } = await handle.read(buffer);
          if (!bytesRead) break;
          size += bytesRead;
          if (size > limit) throw new RangeError('Storage file is too large.');
          chunks.push(buffer.subarray(0, bytesRead));
        }
        return validate(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))));
      } finally { await handle.close(); }
    } catch (error) {
      if (code(error, 'ENOENT')) return undefined;
      if (!(error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError)) throw error;
      await this.quarantine(filename, error instanceof SyntaxError ? 'invalid JSON' : error.message);
      return undefined;
    }
  }

  private async quarantine(filename: string, reason: string): Promise<void> {
    await this.assertDirectories();
    const destination = `${filename}.corrupt-${Date.now()}-${randomUUID()}`;
    // If rename fails, surface the I/O error rather than silently replacing unreadable data.
    await atomicRename(filename, destination);
    this.notices.push(`Quarantined ${path.basename(filename)} as ${path.basename(destination)}: ${reason}`);
  }

  private async writeJSON(filename: string, value: unknown, limit: number): Promise<void> {
    await this.assertDirectories();
    const data = JSON.stringify(value, null, 2) + '\n';
    if (Buffer.byteLength(data, 'utf8') > limit) throw new RangeError('Storage data exceeds the file size limit.');
    const temporary = `${filename}.tmp-${randomUUID()}`;
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(data, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await atomicRename(temporary, filename);
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(error => {
        if (!code(error, 'ENOENT')) this.notices.push(`Could not remove temporary file ${path.basename(temporary)}.`);
      });
    }
  }
}
