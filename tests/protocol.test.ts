import { describe, expect, it } from 'vitest';
import { CodexProtocolParser, protocolErrorMessage, readableDiagnostic, type RunnerEvent } from '../electron/protocol';

const line = (event: unknown): string => `${JSON.stringify(event)}\n`;
const message = (id: string, text: string, type = 'item.completed') => ({ type, item: { id, type: 'agent_message', text } });
const completed = { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };

function setup(options: ConstructorParameters<typeof CodexProtocolParser>[0] = {}) {
  const events: RunnerEvent[] = [];
  const parser = new CodexProtocolParser({ onEvent: event => events.push(event), ...options });
  return { parser, events };
}

describe('CodexProtocolParser', () => {
  it('decodes split UTF-8, CRLF, BOM and a final event without a newline', () => {
    const { parser, events } = setup();
    const input = Buffer.from('\uFEFF' + line({ type: 'thread.started', thread_id: 'session-1' }).replace('\n', '\r\n')
      + line({ type: 'turn.started' }) + line(message('answer', 'Grüße 👋 日本語')) + JSON.stringify(completed));
    for (const byte of input) parser.push(Buffer.from([byte]));
    expect(parser.finish()).toEqual({ text: 'Grüße 👋 日本語', sessionId: 'session-1' });
    expect(events).toEqual([
      { type: 'session', sessionId: 'session-1' }, { type: 'status', status: 'thinking' },
      { type: 'status', status: 'responding' }, { type: 'text', text: 'Grüße 👋 日本語' },
    ]);
  });

  it('replaces snapshots by ID, deduplicates completed events and ignores stale updates', () => {
    const { parser, events } = setup();
    parser.start();
    parser.push(line({ type: 'turn.started' })
      + line(message('a', 'Hel', 'item.updated'))
      + line(message('a', 'Hello', 'item.updated'))
      + line(message('a', 'Hello')) + line(message('a', 'Hello'))
      + line(message('a', 'H', 'item.updated')) + line(message('b', 'World')) + line(completed));
    expect(parser.finish().text).toBe('Hello\n\nWorld');
    expect(events.filter(event => event.type === 'text')).toEqual([
      { type: 'text', text: 'Hel' }, { type: 'text', text: 'Hello' }, { type: 'text', text: 'Hello\n\nWorld' },
    ]);
    expect(events.filter(event => event.type === 'status')).toEqual([
      { type: 'status', status: 'thinking' }, { type: 'status', status: 'responding' },
    ]);
  });

  it('accepts corrected snapshots rather than incorrectly treating them as text deltas', () => {
    const { parser } = setup();
    parser.push(line(message('a', 'old answer', 'item.updated')) + line(message('a', 'new answer')) + line(completed));
    expect(parser.finish().text).toBe('new answer');
  });

  it('retains a resumed session ID if thread.started is omitted', () => {
    const { parser } = setup({ sessionId: 'previous-session' });
    parser.push(line(message('a', 'answer')) + line(completed));
    expect(parser.finish()).toEqual({ text: 'answer', sessionId: 'previous-session' });
  });

  it('deduplicates session events and ignores unknown/tool/reasoning events', () => {
    const { parser, events } = setup();
    const thread = line({ type: 'thread.started', thread_id: 'one' });
    parser.push('\n' + thread + thread + line({ type: 'future.event', data: {} })
      + line({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'not assistant text' } })
      + line({ type: 'item.updated', item: { type: 'reasoning', text: 'private reasoning' } })
      + line(message('empty', '')) + line(completed));
    expect(parser.finish()).toEqual({ text: '', sessionId: 'one' });
    expect(events).toEqual([{ type: 'session', sessionId: 'one' }]);
  });

  it.each([
    { type: 'turn.failed', error: { message: 'Model unavailable' } },
    { type: 'turn.failed', error: 'Model unavailable' },
    { type: 'error', message: 'Model unavailable' },
    { type: 'error', error: { error: { message: 'Model unavailable' } } },
  ])('rejects explicit CLI failure: $type', event => {
    const { parser } = setup();
    expect(() => parser.push(line(event))).toThrow('Model unavailable');
    expect(() => parser.finish()).toThrow('Model unavailable');
  });

  it('rejects unspecified errors and does not let completion conceal them', () => {
    const { parser } = setup();
    expect(() => parser.push(line(completed) + line({ type: 'error' }))).toThrow('No error details provided');
    expect(() => parser.finish()).toThrow('No error details provided');
  });

  it.each(['', line(message('a', 'partial')), line({ type: 'turn.started' })])('requires turn.completed, not only EOF', input => {
    const { parser } = setup();
    parser.push(input);
    expect(() => parser.finish()).toThrow('missing turn.completed');
  });

  it('requires completion again if another turn starts', () => {
    const { parser } = setup();
    parser.push(line(completed) + line({ type: 'turn.started' }));
    expect(() => parser.finish()).toThrow('missing turn.completed');
  });

  it.each([
    ['not json\n', 'Invalid Codex CLI JSONL'],
    ['{"type":\n', 'Invalid Codex CLI JSONL'],
    ['[]\n', 'missing type'],
    ['{}\n', 'missing type'],
    [line({ type: 'thread.started' }), 'missing thread_id'],
    [line({ type: 'item.updated', item: { type: 'agent_message', text: 'no id' } }), 'expected an id and text'],
  ])('rejects malformed protocol records', (input, error) => {
    const { parser } = setup();
    expect(() => parser.push(input)).toThrow(error);
  });

  it('rejects truncated JSON at EOF', () => {
    const { parser } = setup();
    parser.push('{"type":"turn.completed"');
    expect(() => parser.finish()).toThrow('Invalid Codex CLI JSONL');
  });

  it('bounds both total bytes and pending/completed JSONL line bytes', () => {
    const total = setup({ maxOutputBytes: 8 }).parser;
    expect(() => total.push('123456789')).toThrow('output exceeded');
    const pending = setup({ maxLineBytes: 4 }).parser;
    expect(() => pending.push('üüü')).toThrow('line exceeded');
    const full = setup({ maxLineBytes: 4 }).parser;
    expect(() => full.push('12345\n')).toThrow('line exceeded');
  });

  it('cannot be reused after finishing', () => {
    const { parser } = setup();
    parser.push(line(completed));
    parser.finish();
    expect(() => parser.push(line(completed))).toThrow('already finished');
    expect(() => parser.finish()).toThrow('already finished');
  });
});

describe('diagnostics', () => {
  it('extracts deeply nested CLI errors without overflowing the stack', () => {
    let error: unknown = { message: 'Readable deep failure' };
    for (let i = 0; i < 20_000; i++) error = { error };
    expect(protocolErrorMessage(error)).toBe('Readable deep failure');
  });

  it('handles indirect cycles in the exported diagnostic helper', () => {
    const first: Record<string, unknown> = {};
    const second = { error: first, reason: 'Readable cyclic failure' };
    first.error = second;
    expect(protocolErrorMessage(first)).toBe('Readable cyclic failure');
  });
  it('extracts nested failure messages and bounds/control-strips output', () => {
    expect(protocolErrorMessage({ error: { message: ' denied ' } })).toBe('denied');
    expect(protocolErrorMessage({ reason: 'reason' })).toBe('reason');
    expect(protocolErrorMessage(null)).toBe('');
    expect(readableDiagnostic('\u001b[31mError\u001b[0m\0\nmore')).toBe('Error\nmore');
    expect(protocolErrorMessage('x'.repeat(5000))).toHaveLength(2048);
    expect(readableDiagnostic('prefix suffix', 6)).toBe('suffix');
  });
});
