import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../shared/defaults';
import { normalizeShortcut, validateSettings } from '../electron/config';

describe('normalizeShortcut', () => {
  it.each([
    [' ctrl + SHIFT + spacebar ', 'Control+Shift+Space'], ['shift+alt+control+f', 'Control+Alt+Shift+F'],
    ['CmdOrCtrl+Return', 'Control+Enter'], ['option+f8', 'Alt+F8'],
    ['Control+PgDn', 'Control+PageDown'], ['CTRL+Plus', 'Control+Plus'], ['Alt+F24', 'Alt+F24'],
    ['Control+Comma', 'Control+,'], ['Control+,', 'Control+,'], ['ctrl+numadd', 'Control+numadd'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeShortcut(input)).toBe(expected);
    expect(normalizeShortcut(expected)).toBe(expected);
  });

  it.each(['', 'A', 'F8', 'Ctrl', 'Ctrl+Alt', 'Ctrl++A', 'Ctrl+Ctrl+A', 'Ctrl+Control+A', 'Ctrl+A+B',
    'Ctrl+UnknownKey', 'Ctrl+F25', 'Ctrl+N', 'CommandOrControl+n', 'Alt+Tab', 'Alt+Shift+Tab', 'Alt+F4',
    'Alt+Space', 'Ctrl+Esc', 'Ctrl+Shift+Esc', 'Ctrl+Alt+Delete', 'Ctrl+F12', 'Win+R', 'Meta+Shift+S',
    'Super+A', 'Command+Q', 'Ctrl+PrintScreen', 'Ctrl+\0', 'a'.repeat(129)])('rejects invalid/reserved %j', input => {
    expect(() => normalizeShortcut(input)).toThrow();
  });
});

describe('validateSettings', () => {
  it('accepts defaults and returns independent canonical settings', () => {
    const input = defaultSettings();
    input.modes.chat.shortcut = 'shift+ctrl+spacebar';
    const output = validateSettings(input);
    expect(output.modes.chat.shortcut).toBe('Control+Shift+Space');
    output.modes.chat.outputs.chat = false;
    expect(input.modes.chat.outputs.chat).toBe(true);
  });

  it('strictly rejects missing fields rather than merging defaults', () => {
    expect(() => validateSettings({})).toThrow('required');
    const input = defaultSettings() as unknown as Record<string, unknown>;
    delete input.audio;
    expect(() => validateSettings(input)).toThrow('audio');
  });

  it.each([null, [], 'settings', 1, new Date()])('rejects a non-record root %j', input => {
    expect(() => validateSettings(input)).toThrow('object');
  });

  it.each(['root', 'general', 'codex', 'audio', 'mode', 'outputs'])('rejects unknown fields in %s', level => {
    const input = defaultSettings();
    const target = level === 'root' ? input : level === 'mode' ? input.modes.chat
      : level === 'outputs' ? input.modes.chat.outputs : input[level as 'general' | 'codex' | 'audio'];
    Object.assign(target, { unknown: true });
    expect(() => validateSettings(input)).toThrow('Unknown');
  });

  it('rejects prototype-looking and symbol keys without polluting objects', () => {
    const input = JSON.parse(JSON.stringify(defaultSettings()));
    input.general = JSON.parse('{"__proto__":{},"launchAtLogin":false,"tray":true,"startMinimized":false,"alwaysOnTop":true,"hideOnBlur":false,"language":"de","theme":"dark"}');
    expect(() => validateSettings(input)).toThrow('Unknown');
    const symbols = defaultSettings();
    Object.defineProperty(symbols, Symbol('hidden'), { value: true });
    expect(() => validateSettings(symbols)).toThrow('Unknown');
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it.each([
    ['version', 2], ['general.language', 'fr'], ['general.theme', 'blue'], ['general.tray', 'true'],
    ['codex.sandbox', 'danger-full-access'], ['codex.timeoutSeconds', 14.99], ['codex.timeoutSeconds', 1801],
    ['codex.timeoutSeconds', NaN], ['codex.timeoutSeconds', Infinity], ['audio.rate', -11], ['audio.rate', 11],
    ['audio.volume', -1], ['audio.volume', 101], ['audio.volume', '50'], ['modes.chat.promptEnabled', 1],
    ['modes.chat.autoSend', null], ['modes.chat.outputs.chat', 1], ['modes.chat.prompt', 'x'.repeat(16001)],
    ['codex.cliPath', 'x'.repeat(2049)], ['codex.workingDirectory', 'x'.repeat(2049)], ['codex.model', 'x'.repeat(201)],
    ['codex.cliPath', 'bad\0path'],
  ])('rejects invalid %s', (field, value) => {
    const input = defaultSettings();
    const parts = field.split('.');
    let target = input as unknown as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
    target[parts[parts.length - 1]] = value;
    expect(() => validateSettings(input)).toThrow();
  });

  it('accepts all numeric/string boundary values', () => {
    for (const [timeoutSeconds, rate, volume] of [[15, -10, 0], [1800, 10, 100]]) {
      const input = defaultSettings();
      input.codex.timeoutSeconds = timeoutSeconds;
      input.audio.rate = rate;
      input.audio.volume = volume;
      input.codex.cliPath = 'x'.repeat(2048);
      input.codex.workingDirectory = 'x'.repeat(2048);
      input.codex.model = 'x'.repeat(200);
      input.modes.chat.prompt = 'x'.repeat(16000);
      expect(validateSettings(input)).toEqual(input);
    }
  });

  it('rejects disabled outputs even if prompts or auto-send are disabled', () => {
    const input = defaultSettings();
    input.modes.region.outputs = { chat: false, clipboard: false, speech: false };
    input.modes.region.autoSend = false;
    input.modes.region.promptEnabled = false;
    expect(() => validateSettings(input)).toThrow('at least one output');
  });

  it('detects shortcuts duplicated through aliases and modifier order', () => {
    const input = defaultSettings();
    input.modes.files.shortcut = 'shift+ctrl+spacebar';
    expect(() => validateSettings(input)).toThrow('Duplicate shortcut');
  });
});
