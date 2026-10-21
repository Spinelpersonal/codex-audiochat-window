import type { Attachment, Conversation, Message, RequestStatus, Settings } from '../shared/types';

export interface RequestSnapshot {
  status: RequestStatus;
  text?: string;
  error?: string;
  baselineAssistantId?: string;
}

export function isRunning(status?: RequestStatus): boolean {
  return status === 'starting' || status === 'thinking' || status === 'responding';
}

export function busyConversationId(conversations: Conversation[], requests: Record<string, RequestSnapshot>): string | undefined {
  return Object.keys(requests).find((id) => isRunning(requests[id].status))
    ?? conversations.find((conversation) => !requests[conversation.id] && conversation.messages.some((message) => message.status === 'pending'))?.id;
}

export function rebaseSettingsDraft(draft: Settings, previous: Settings, saved: Settings): Settings {
  const rebase = (current: unknown, base: unknown, next: unknown): unknown => {
    if (JSON.stringify(current) === JSON.stringify(base)) return structuredClone(next);
    if (current && base && next && typeof current === 'object' && typeof base === 'object' && typeof next === 'object') {
      return Object.fromEntries(Object.entries(next).map(([key, value]) => [key,
        rebase((current as Record<string, unknown>)[key], (base as Record<string, unknown>)[key], value),
      ]));
    }
    return current;
  };
  return rebase(draft, previous, saved) as Settings;
}

export function upsertConversation(conversations: Conversation[], conversation: Conversation): Conversation[] {
  const existing = conversations.find((item) => item.id === conversation.id);
  if (existing && existing.updatedAt > conversation.updatedAt) return conversations;
  return [...conversations.filter((item) => item.id !== conversation.id), conversation]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function mergeAttachments(current: Attachment[], incoming: Attachment[]): Attachment[] {
  return [...new Map([...current, ...incoming].map((attachment) => [attachment.id, attachment])).values()];
}

/** Request text is a complete snapshot, never a delta. Canonical messages win once settled. */
export function snapshotMessages(conversation: Conversation, request?: RequestSnapshot): Message[] {
  if (!request) return conversation.messages;
  const messages = [...conversation.messages];
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      if (messages[i].id !== request.baselineAssistantId) index = i;
      break;
    }
  }
  const status = isRunning(request.status) ? 'pending'
    : request.status === 'cancelled' ? 'cancelled' : request.status === 'error' ? 'error' : 'complete';
  if (index >= 0) {
    const message = messages[index];
    if (message.status === 'pending' || (!message.status && isRunning(request.status))) {
      messages[index] = { ...message, text: request.text ?? message.text, status, error: request.error ?? message.error };
    }
  } else if (isRunning(request.status) || request.text || request.error) {
    messages.push({
      id: `request-${conversation.id}`, role: 'assistant', text: request.text ?? '',
      createdAt: conversation.updatedAt, status, error: request.error,
    });
  }
  return messages;
}

export interface ShortcutKey {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  getModifierState?: (key: string) => boolean;
}

const MODIFIERS = ['Control', 'Alt', 'Shift', 'Super'] as const;
const MODIFIER_ALIASES: Record<string, string> = {
  control: 'Control', ctrl: 'Control', commandorcontrol: 'Control', cmdorctrl: 'Control',
  alt: 'Alt', option: 'Alt', shift: 'Shift', super: 'Super', meta: 'Super', win: 'Super', windows: 'Super',
};
const KEY_ALIASES: Record<string, string> = {
  space: 'Space', spacebar: 'Space', tab: 'Tab', enter: 'Enter', return: 'Enter',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert', ins: 'Insert',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  up: 'Up', arrowup: 'Up', down: 'Down', arrowdown: 'Down', left: 'Left', arrowleft: 'Left', right: 'Right', arrowright: 'Right',
  escape: 'Escape', esc: 'Escape',
};

/** Normalize Windows accelerators before duplicate checks and before crossing the bridge. */
export function normalizeShortcut(value: string): string | null {
  if (!value.trim()) return '';
  const parts = value.split('+').map((part) => part.trim().toLowerCase());
  const rawKey = parts.pop()!;
  const key = KEY_ALIASES[rawKey] ?? (/^(?:[a-z0-9]|f(?:[1-9]|1\d|2[0-4]))$/.test(rawKey) ? rawKey.toUpperCase() : null);
  if (!key || (!parts.length && !/^F\d+$/.test(key))) return null;
  const modifiers = parts.map((part) => MODIFIER_ALIASES[part]);
  if (modifiers.some((modifier) => !modifier)) return null;
  return [...MODIFIERS.filter((modifier) => modifiers.includes(modifier)), key].join('+');
}

export function shortcutFromKey(event: ShortcutKey): string | null {
  if (event.isComposing || event.getModifierState?.('AltGraph') || ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'Dead', 'Unidentified'].includes(event.key)) return null;
  const modifiers = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super'].filter(Boolean);
  let key = event.key;
  if (key === ' ') key = 'Space';
  else if (/^[a-z0-9]$/i.test(key)) key = key.toUpperCase();
  else if (/^Digit\d$/.test(event.code)) key = event.code.slice(5);
  return normalizeShortcut([...modifiers, key].join('+'));
}

export function shortcutIdentity(value: string): string {
  return normalizeShortcut(value)?.toLowerCase() ?? value.split('+').map((part) => part.trim().toLowerCase()).sort().join('+');
}

export function duplicateShortcuts(settings: Settings): Set<string> {
  const seen = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const [mode, config] of Object.entries(settings.modes)) {
    if (!config.shortcut.trim()) continue;
    const shortcut = shortcutIdentity(config.shortcut);
    const prior = seen.get(shortcut);
    if (prior) { duplicates.add(mode); duplicates.add(prior); }
    seen.set(shortcut, mode);
  }
  return duplicates;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function safeImageSource(preview?: string): string | undefined {
  // Attachments are local previews, not remote resources or navigable file URLs.
  return preview && /^(?:data:image\/(?:png|jpe?g|gif|webp|bmp);base64,|blob:)/i.test(preview) ? preview : undefined;
}
