import { randomUUID } from 'node:crypto';
import type { AppEvent, Attachment, Conversation, ModeId, SendInput, Settings } from '../shared/types';
import { MODE_IDS } from '../shared/types';
import { buildPrompt } from './prompt';
import type { CodexRunner } from './codex';
import type { FileService } from './files';
import type { Store } from './store';

export interface ChatDependencies {
  store: Pick<Store, 'settings' | 'conversations' | 'putConversation' | 'deleteConversation'>;
  runner: Pick<CodexRunner, 'run' | 'shutdown'>;
  files: Pick<FileService, 'prepare' | 'release'>;
  attachments: Map<string, Attachment>;
  emit(event: AppEvent): void;
  openChat(): void;
  copy(text: string): Promise<void>;
  speak(text: string, audio: Settings['audio']): Promise<void>;
  notify(title: string, body: string): void;
}
interface Job { id: string; controller: AbortController; promise: Promise<void> }
const titles: Record<ModeId, string> = { chat: 'Neuer Chat', screen: 'Bildschirmanalyse', region: 'Bereichsanalyse', files: 'Dateianalyse' };
export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 8000);
}
export class ChatEngine {
  private job?: Job;
  private closed = false;
  constructor(private readonly deps: ChatDependencies) {}
  get busy(): boolean { return !!this.job; }
  get activeId(): string | undefined { return this.job?.id; }

  async create(mode: ModeId): Promise<Conversation> {
    if (!MODE_IDS.includes(mode)) throw new Error('Ungültiger Modus / Invalid mode');
    const now = new Date().toISOString();
    const conversation: Conversation = { id: randomUUID(), title: titles[mode], mode, createdAt: now, updatedAt: now, messages: [] };
    await this.deps.store.putConversation(conversation);
    this.deps.emit({ type: 'conversation', conversation });
    return conversation;
  }

  async start(input: SendInput): Promise<void> {
    if (this.closed) throw new Error('Die Anwendung wird beendet / Application is shutting down');
    if (this.job) throw new Error('Bitte zuerst die laufende Anfrage beenden / A request is already running');
    if (!input || !MODE_IDS.includes(input.mode) || typeof input.conversationId !== 'string'
      || typeof input.text !== 'string' || input.text.length > 32_000
      || !Array.isArray(input.attachmentIds) || input.attachmentIds.length > 50
      || !input.attachmentIds.every(id => typeof id === 'string')
      || new Set(input.attachmentIds).size !== input.attachmentIds.length) throw new Error('Ungültige Anfrage / Invalid request');
    if (!input.text.trim() && !input.attachmentIds.length) throw new Error('Nachricht oder Anhang erforderlich / A message or attachment is required');
    const conversation = this.deps.store.conversations.find(item => item.id === input.conversationId);
    if (!conversation || conversation.mode !== input.mode) throw new Error('Die Konversation passt nicht zum Modus / Conversation mode mismatch');
    const metadata = input.attachmentIds.map(id => {
      const attachment = this.deps.attachments.get(id);
      if (!attachment) throw new Error('Anhang nicht mehr verfügbar. Bitte erneut auswählen / Please reattach this file');
      return { ...attachment };
    });
    if (['screen', 'region'].includes(input.mode) && !conversation.sessionId && !metadata.some(item => item.kind === 'image')) {
      throw new Error('Bitte zuerst einen Screenshot aufnehmen / Capture a screenshot first');
    }
    if (input.mode === 'files' && !conversation.sessionId && !metadata.length) throw new Error('Bitte zuerst Dateien auswählen / Select files first');
    const job: Job = { id: conversation.id, controller: new AbortController(), promise: Promise.resolve() };
    this.job = job;
    // Include preparation in the cancellation/shutdown lifetime, not just the CLI process.
    let preparedResolve!: () => void;
    const preparing = new Promise<void>(resolve => { preparedResolve = resolve; });
    job.promise = preparing;
    try {
      const prepared = await this.deps.files.prepare(input.attachmentIds);
      job.controller.signal.throwIfAborted();
      const settings = this.deps.store.settings;
      const prompt = buildPrompt(input.mode, settings, input.text, prepared.text);
      const now = new Date().toISOString();
      conversation.updatedAt = now;
      if (!conversation.messages.length) conversation.title = (input.text.trim() || metadata.map(item => item.name).join(', ') || titles[input.mode]).slice(0, 80);
      conversation.messages.push({ id: randomUUID(), role: 'user', text: input.text.trim(), createdAt: now, attachments: metadata, status: 'complete' });
      conversation.messages.push({ id: randomUUID(), role: 'assistant', text: '', createdAt: now, status: 'pending' });
      await this.deps.store.putConversation(conversation);
      if (job.controller.signal.aborted) {
        conversation.messages[conversation.messages.length - 1].status = 'cancelled';
        await this.deps.store.putConversation(conversation);
        this.deps.emit({ type: 'conversation', conversation });
        job.controller.signal.throwIfAborted();
      }
      this.deps.emit({ type: 'conversation', conversation });
      this.deps.emit({ type: 'request', conversationId: conversation.id, status: 'starting' });
      if (settings.modes[input.mode].outputs.chat) this.deps.openChat();
      job.promise = this.execute(job, conversation, settings, prompt, prepared.images, input.attachmentIds)
        .catch(error => this.deps.emit({ type: 'error', message: errorText(error) }))
        .finally(() => { if (this.job === job) this.job = undefined; });
    } catch (error) {
      if (this.job === job) this.job = undefined;
      throw error;
    } finally { preparedResolve(); }
  }

  private async execute(job: Job, conversation: Conversation, settings: Settings, prompt: string, images: string[], ids: string[]): Promise<void> {
    const answer = conversation.messages[conversation.messages.length - 1];
    const outputs = settings.modes[conversation.mode].outputs;
    try {
      const result = await this.deps.runner.run({ settings, sessionId: conversation.sessionId, prompt, images,
        signal: job.controller.signal,
        onEvent: event => {
          if (job.controller.signal.aborted) return;
          if (event.type === 'session') conversation.sessionId = event.sessionId;
          if (event.type === 'text') {
            if (event.text.length > 180_000) throw new Error('Codex-Antwort zu lang / Codex response exceeds the 180000 character limit');
            answer.text = event.text;
            this.deps.emit({ type: 'request', conversationId: conversation.id, status: 'responding', text: event.text });
          } else if (event.type === 'status') this.deps.emit({ type: 'request', conversationId: conversation.id, status: event.status });
        },
      });
      job.controller.signal.throwIfAborted();
      if (result.text.length > 180_000) throw new Error('Codex-Antwort zu lang / Codex response exceeds the 180000 character limit');
      answer.text = result.text;
      if (result.sessionId) conversation.sessionId = result.sessionId;
      answer.status = 'complete';
      conversation.updatedAt = new Date().toISOString();
      await this.deps.store.putConversation(conversation);
      job.controller.signal.throwIfAborted();
      this.deps.emit({ type: 'conversation', conversation });
      this.deps.emit({ type: 'request', conversationId: conversation.id, status: 'completed', text: answer.text });
      // Outputs are deliberately applied only to a successfully completed, persisted answer.
      let copied = false;
      if (outputs.clipboard && !job.controller.signal.aborted) {
        try { await this.deps.copy(answer.text); copied = true; }
        catch (error) { this.deps.emit({ type: 'error', message: `Clipboard: ${errorText(error)}` }); }
      }
      if (outputs.speech && !job.controller.signal.aborted) void this.deps.speak(answer.text, settings.audio).catch(error => this.deps.emit({ type: 'error', message: `Audio: ${errorText(error)}` }));
      if (!outputs.chat && copied && !job.controller.signal.aborted) this.deps.notify('Codex Overlay', settings.general.language === 'de' ? 'Antwort in die Zwischenablage kopiert.' : 'Answer copied to clipboard.');
    } catch (error) {
      const cancelled = job.controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      answer.status = cancelled ? 'cancelled' : 'error';
      if (!cancelled) answer.error = errorText(error);
      conversation.updatedAt = new Date().toISOString();
      try { await this.deps.store.putConversation(conversation); }
      catch (storageError) { this.deps.emit({ type: 'error', message: `Speichern fehlgeschlagen / Storage failed: ${errorText(storageError)}` }); }
      this.deps.emit({ type: 'conversation', conversation });
      this.deps.emit({ type: 'request', conversationId: conversation.id, status: cancelled ? 'cancelled' : 'error', text: answer.text, error: answer.error });
      if (!cancelled) this.deps.notify('Codex Overlay – Fehler / Error', answer.error!);
    } finally {
      try {
        await this.deps.files.release(ids);
        for (const id of ids) this.deps.attachments.delete(id);
      } catch (error) { this.deps.emit({ type: 'error', message: errorText(error) }); }
    }
  }

  async cancel(id: string): Promise<void> {
    const job = this.job;
    if (!job || job.id !== id) return;
    job.controller.abort();
    await job.promise;
    // Preparation may have installed the execution promise after the first await.
    if (job.promise) await job.promise;
  }
  async remove(id: string): Promise<void> {
    if (this.job?.id === id) throw new Error('Laufende Konversation zuerst stoppen / Stop this conversation first');
    await this.deps.store.deleteConversation(id);
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    const job = this.job;
    job?.controller.abort();
    await this.deps.runner.shutdown();
    if (job) { await job.promise; await job.promise; }
  }
}
