import { StringDecoder } from 'node:string_decoder';

/** Text events are complete accumulated snapshots, not deltas. */
export type RunnerEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; text: string }
  | { type: 'status'; status: 'thinking' | 'responding' };

export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_LINE_BYTES = 2 * 1024 * 1024;

export interface CodexResult { text: string; sessionId?: string }
export interface ProtocolOptions {
  onEvent?: (event: RunnerEvent) => void;
  sessionId?: string;
  maxOutputBytes?: number;
  maxLineBytes?: number;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Keep CLI diagnostics readable without forwarding terminal control sequences. */
export function readableDiagnostic(value: string, maxLength = 8192): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim().slice(-maxLength);
}

export function protocolErrorMessage(value: unknown): string {
  const pending: unknown[] = [value];
  const visited = new Set<Record<string, unknown>>();
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string' && current.trim()) {
      const message = readableDiagnostic(current, 2048);
      if (message) return message;
    }
    const record = object(current);
    if (!record || visited.has(record)) continue;
    visited.add(record);
    // Reverse push order preserves message/error/reason priority without recursive calls.
    for (const key of ['reason', 'error', 'message']) pending.push(record[key]);
  }
  return '';
}

/** A single codex exec JSONL turn. Unknown event/item types are forward-compatible. */
export class CodexProtocolParser {
  private readonly decoder = new StringDecoder('utf8');
  private readonly messages = new Map<string, { text: string; completed: boolean }>();
  private pending = '';
  private bytes = 0;
  private firstLine = true;
  private completed = false;
  private finished = false;
  private failure?: Error;
  private sessionId?: string;
  private text = '';
  private status?: 'thinking' | 'responding';

  constructor(private readonly options: ProtocolOptions = {}) {
    this.sessionId = options.sessionId;
  }

  start(): void { this.setStatus('thinking'); }

  push(chunk: Uint8Array | string): void {
    this.assertOpen();
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    this.bytes += buffer.length;
    if (this.bytes > (this.options.maxOutputBytes ?? MAX_OUTPUT_BYTES)) {
      this.fail('Codex CLI output exceeded the size limit.');
    }
    this.consume(this.decoder.write(buffer));
  }

  finish(): CodexResult {
    this.assertOpen();
    this.consume(this.decoder.end());
    if (this.pending.trim()) this.line(this.pending);
    this.pending = '';
    this.finished = true;
    if (!this.completed) this.fail('Codex CLI closed without a completed turn (missing turn.completed).');
    return { text: this.text, ...(this.sessionId ? { sessionId: this.sessionId } : {}) };
  }

  private assertOpen(): void {
    if (this.failure) throw this.failure;
    if (this.finished) throw new Error('Codex protocol parser is already finished.');
  }

  private consume(text: string): void {
    this.pending += text;
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      this.line(line);
    }
    this.checkLineSize(this.pending);
  }

  private checkLineSize(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > (this.options.maxLineBytes ?? MAX_LINE_BYTES)) {
      this.fail('Codex CLI JSONL line exceeded the size limit.');
    }
  }

  private line(raw: string): void {
    this.checkLineSize(raw);
    let line = raw.trim();
    if (this.firstLine) {
      line = line.replace(/^\uFEFF/, '');
      this.firstLine = false;
    }
    if (!line) return;
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { this.fail(`Invalid Codex CLI JSONL: ${readableDiagnostic(line, 160)}`); }
    const event = object(value);
    if (!event || typeof event.type !== 'string') this.fail('Invalid Codex CLI event: missing type.');
    switch (event.type) {
      case 'thread.started': {
        if (typeof event.thread_id !== 'string' || !event.thread_id.trim()) {
          this.fail('Invalid Codex thread.started event: missing thread_id.');
        }
        if (this.sessionId !== event.thread_id) {
          this.sessionId = event.thread_id;
          this.options.onEvent?.({ type: 'session', sessionId: event.thread_id });
        }
        break;
      }
      case 'turn.started':
        this.completed = false;
        this.setStatus('thinking');
        break;
      case 'item.updated':
      case 'item.completed': {
        const item = object(event.item);
        if (item?.type !== 'agent_message') break;
        if (typeof item.id !== 'string' || !item.id || typeof item.text !== 'string') {
          this.fail('Invalid Codex agent_message: expected an id and text snapshot.');
        }
        const previous = this.messages.get(item.id);
        // A delayed update must not overwrite the final snapshot for this item.
        if (previous?.completed && event.type === 'item.updated') break;
        this.messages.set(item.id, { text: item.text, completed: event.type === 'item.completed' });
        const next = [...this.messages.values()].map(message => message.text).filter(Boolean).join('\n\n');
        if (next !== this.text) {
          this.text = next;
          this.setStatus('responding');
          this.options.onEvent?.({ type: 'text', text: next });
        }
        break;
      }
      case 'turn.completed':
        this.completed = true;
        break;
      case 'turn.failed':
      case 'error':
        this.fail(`Codex CLI ${event.type === 'turn.failed' ? 'turn failed' : 'error'}: ${protocolErrorMessage(event.error) || protocolErrorMessage(event.message) || 'No error details provided.'}`);
    }
  }

  private setStatus(status: 'thinking' | 'responding'): void {
    if (status === this.status) return;
    this.status = status;
    this.options.onEvent?.({ type: 'status', status });
  }

  private fail(message: string): never {
    this.failure = new Error(message);
    throw this.failure;
  }
}
