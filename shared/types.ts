export const MODE_IDS = ['chat', 'screen', 'region', 'files'] as const;
export type ModeId = (typeof MODE_IDS)[number];
export interface ModeConfig {
  shortcut: string;
  promptEnabled: boolean;
  prompt: string;
  outputs: { chat: boolean; clipboard: boolean; speech: boolean };
  autoSend: boolean;
}
export interface Settings {
  version: 1;
  general: {
    launchAtLogin: boolean; tray: boolean; startMinimized: boolean;
    alwaysOnTop: boolean; hideOnBlur: boolean;
    language: 'de' | 'en'; theme: 'dark' | 'light' | 'system';
  };
  codex: {
    cliPath: string; model: string; workingDirectory: string;
    sandbox: 'read-only' | 'workspace-write'; timeoutSeconds: number;
  };
  audio: { voice: string; rate: number; volume: number };
  modes: Record<ModeId, ModeConfig>;
}
export interface Attachment {
  id: string; name: string; kind: 'image' | 'text' | 'pdf'; size: number;
  preview?: string;
}
export interface Message {
  id: string; role: 'user' | 'assistant'; text: string; createdAt: string;
  attachments?: Attachment[];
  status?: 'pending' | 'complete' | 'cancelled' | 'error';
  error?: string;
}
export interface Conversation {
  id: string; title: string; mode: ModeId; sessionId?: string;
  createdAt: string; updatedAt: string; messages: Message[];
}
export interface CliStatus {
  installed: boolean; authenticated: boolean; path?: string;
  version?: string; message: string;
}
export interface Voice { id: string; name: string; language: string }
export type RequestStatus = 'starting' | 'thinking' | 'responding' | 'completed' | 'cancelled' | 'error';
export type AppEvent =
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'request'; conversationId: string; status: RequestStatus; text?: string; error?: string }
  | { type: 'attachments'; mode: ModeId; attachments: Attachment[]; newConversation: boolean }
  | { type: 'focus' }
  | { type: 'settings'; settings: Settings }
  | { type: 'error'; message: string }
  | { type: 'speech'; active: boolean };
export interface SendInput { conversationId: string; mode: ModeId; text: string; attachmentIds: string[] }
export interface Bootstrap {
  settings: Settings; conversations: Conversation[]; cli: CliStatus;
  platform: string; version: string;
}
export interface OverlayAPI {
  bootstrap(): Promise<Bootstrap>;
  saveSettings(settings: Settings): Promise<Settings>;
  testCli(): Promise<CliStatus>;
  newConversation(mode: ModeId): Promise<Conversation>;
  deleteConversation(id: string): Promise<void>;
  renameConversation(id: string, title: string): Promise<void>;
  exportConversation(id: string): Promise<void>;
  send(input: SendInput): Promise<void>;
  cancel(conversationId: string): Promise<void>;
  capture(mode: 'screen' | 'region'): Promise<void>;
  chooseFiles(): Promise<Attachment[]>;
  dropFiles(files: File[]): Promise<Attachment[]>;
  releaseAttachments(ids: string[]): Promise<void>;
  copy(text: string): Promise<void>;
  speak(text: string): Promise<void>;
  stopSpeech(): Promise<void>;
  voices(): Promise<Voice[]>;
  selectDirectory(): Promise<string | null>;
  selectCli(): Promise<string | null>;
  windowAction(action: 'hide' | 'minimize' | 'close' | 'togglePin' | 'quit'): Promise<void>;
  onEvent(callback: (event: AppEvent) => void): () => void;
}
