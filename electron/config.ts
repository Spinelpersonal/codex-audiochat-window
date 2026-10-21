import { MODE_IDS, type ModeConfig, type Settings } from '../shared/types';

function record(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${name} must be an object.`);
  }
  const result = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(result)) {
    if (typeof key !== 'string' || !keys.includes(key)) throw new TypeError(`Unknown ${name} field: ${String(key)}.`);
  }
  for (const key of keys) if (!Object.hasOwn(result, key)) throw new TypeError(`${name}.${key} is required.`);
  return result;
}
function text(value: unknown, name: string, limit: number): string {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0')) {
    throw new TypeError(`${name} must be a string of at most ${limit} characters without NUL.`);
  }
  return value;
}
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean.`);
  return value;
}
function number(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}.`);
  }
  return value;
}
function choice<T extends string>(value: unknown, name: string, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new TypeError(`Invalid ${name}.`);
  return value as T;
}

const MODIFIERS: Record<string, string> = {
  ctrl: 'Control', control: 'Control', cmdorctrl: 'Control', commandorcontrol: 'Control',
  ctrlormeta: 'Control', alt: 'Alt', option: 'Alt', shift: 'Shift',
};
const WINDOWS_MODIFIERS = new Set(['win', 'windows', 'super', 'meta', 'cmd', 'command']);
const KEYS: Record<string, string> = {
  space: 'Space', spacebar: 'Space', tab: 'Tab', enter: 'Enter', return: 'Enter',
  esc: 'Escape', escape: 'Escape', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  insert: 'Insert', ins: 'Insert', up: 'Up', arrowup: 'Up', down: 'Down', arrowdown: 'Down',
  left: 'Left', arrowleft: 'Left', right: 'Right', arrowright: 'Right', home: 'Home', end: 'End',
  pageup: 'PageUp', pgup: 'PageUp', pagedown: 'PageDown', pgdn: 'PageDown', plus: 'Plus',
  minus: '-', comma: ',', period: '.', slash: '/', backslash: '\\', semicolon: ';',
  quote: "'", backquote: '`', bracketleft: '[', bracketright: ']', equal: '=',
};
const RESERVED = new Set([
  'Control+N', 'Alt+Tab', 'Alt+Shift+Tab', 'Control+Alt+Tab', 'Alt+Escape', 'Alt+Shift+Escape',
  'Alt+F4', 'Alt+Space', 'Control+Escape', 'Control+Shift+Escape', 'Control+Alt+Delete', 'Control+Alt+End',
]);

/** Canonical Windows Electron accelerator. Windows/Meta shortcuts are reserved for the OS. */
export function normalizeShortcut(input: string): string {
  const value = text(input, 'Shortcut', 128).trim();
  if (!value) throw new TypeError('Shortcut must not be empty.');
  const modifiers = new Set<string>();
  let key: string | undefined;
  for (const part of value.split('+')) {
    const token = part.trim().toLowerCase();
    if (!token) throw new TypeError('Invalid shortcut; use Plus for the + key.');
    if (WINDOWS_MODIFIERS.has(token)) throw new TypeError('Windows/Meta shortcuts are reserved for Windows.');
    const modifier = Object.hasOwn(MODIFIERS, token) ? MODIFIERS[token] : undefined;
    if (modifier) {
      if (modifiers.has(modifier)) throw new TypeError(`Repeated shortcut modifier: ${modifier}.`);
      modifiers.add(modifier);
      continue;
    }
    if (key) throw new TypeError('Shortcut must contain exactly one key.');
    if (/^[a-z0-9]$/.test(token)) key = token.toUpperCase();
    else if (/^f(?:[1-9]|1\d|2[0-4])$/.test(token)) key = token.toUpperCase();
    else if (Object.hasOwn(KEYS, token)) key = KEYS[token];
    else if (/^[-,./\\;'`\[\]=]$/.test(token)) key = token;
    else if (/^num(?:[0-9]|dec|add|sub|mult|div)$/.test(token)) key = token;
    else throw new TypeError(`Unsupported shortcut key: ${part.trim()}.`);
  }
  if (!key || !modifiers.size) throw new TypeError('Shortcut requires a modifier and one key.');
  const result = [...['Control', 'Alt', 'Shift'].filter(modifier => modifiers.has(modifier)), key].join('+');
  if (key === 'F12' || RESERVED.has(result)) throw new TypeError(`Shortcut ${result} is reserved by Windows or the application.`);
  return result;
}

/** Shared by settings validation and hotkey registration; does not access Electron. */
export function validateModes(input: unknown): Settings['modes'] {
  const modes = record(input, 'modes', MODE_IDS);
  const seen = new Set<string>();
  const entries = MODE_IDS.map(mode => {
    const name = `modes.${mode}`;
    const config = record(modes[mode], name, ['shortcut', 'promptEnabled', 'prompt', 'outputs', 'autoSend']);
    const shortcut = normalizeShortcut(text(config.shortcut, `${name}.shortcut`, 128));
    if (seen.has(shortcut)) throw new TypeError(`Duplicate shortcut: ${shortcut}.`);
    seen.add(shortcut);
    const rawOutputs = record(config.outputs, `${name}.outputs`, ['chat', 'clipboard', 'speech']);
    const outputs = {
      chat: boolean(rawOutputs.chat, `${name}.outputs.chat`),
      clipboard: boolean(rawOutputs.clipboard, `${name}.outputs.clipboard`),
      speech: boolean(rawOutputs.speech, `${name}.outputs.speech`),
    };
    if (!Object.values(outputs).some(Boolean)) throw new TypeError(`${name} requires at least one output.`);
    const result: ModeConfig = { shortcut, promptEnabled: boolean(config.promptEnabled, `${name}.promptEnabled`),
      prompt: text(config.prompt, `${name}.prompt`, 16_000), outputs, autoSend: boolean(config.autoSend, `${name}.autoSend`) };
    return [mode, result];
  });
  return Object.fromEntries(entries) as Settings['modes'];
}

/** Strict validation: missing fields are errors. Only the Store's loading path merges defaults. */
export function validateSettings(input: unknown): Settings {
  const root = record(input, 'settings', ['version', 'general', 'codex', 'audio', 'modes']);
  if (root.version !== 1) throw new TypeError('settings.version must be 1.');
  const general = record(root.general, 'general', ['launchAtLogin', 'tray', 'startMinimized', 'alwaysOnTop', 'hideOnBlur', 'language', 'theme']);
  const codex = record(root.codex, 'codex', ['cliPath', 'model', 'workingDirectory', 'sandbox', 'timeoutSeconds']);
  const audio = record(root.audio, 'audio', ['voice', 'rate', 'volume']);
  return {
    version: 1,
    general: {
      launchAtLogin: boolean(general.launchAtLogin, 'general.launchAtLogin'), tray: boolean(general.tray, 'general.tray'),
      startMinimized: boolean(general.startMinimized, 'general.startMinimized'),
      alwaysOnTop: boolean(general.alwaysOnTop, 'general.alwaysOnTop'), hideOnBlur: boolean(general.hideOnBlur, 'general.hideOnBlur'),
      language: choice(general.language, 'general.language', ['de', 'en']), theme: choice(general.theme, 'general.theme', ['dark', 'light', 'system']),
    },
    codex: {
      cliPath: text(codex.cliPath, 'codex.cliPath', 2048).trim(), model: text(codex.model, 'codex.model', 200).trim(),
      workingDirectory: text(codex.workingDirectory, 'codex.workingDirectory', 2048).trim(),
      sandbox: choice(codex.sandbox, 'codex.sandbox', ['read-only', 'workspace-write']),
      timeoutSeconds: number(codex.timeoutSeconds, 'codex.timeoutSeconds', 15, 1800),
    },
    audio: { voice: text(audio.voice, 'audio.voice', 2048), rate: number(audio.rate, 'audio.rate', -10, 10), volume: number(audio.volume, 'audio.volume', 0, 100) },
    modes: validateModes(root.modes),
  };
}
