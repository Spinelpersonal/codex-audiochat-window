import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppEvent, Attachment, Bootstrap, Conversation, ModeId, OverlayAPI, Settings } from '../shared/types';
import { busyConversationId, errorMessage, isRunning, mergeAttachments, upsertConversation, type RequestSnapshot } from './model';
import { initialLanguage, translator } from './i18n';

export interface Draft { text: string; attachments: Attachment[] }
export interface Toast { id: number; message: string; kind: 'error' | 'success' }
interface State {
  bootstrap: Bootstrap | null;
  loading: boolean;
  bootError: string | null;
  conversations: Conversation[];
  activeId: string | null;
  mode: ModeId;
  drafts: Record<string, Draft>;
  requests: Record<string, RequestSnapshot>;
  sending: boolean;
  attaching: boolean;
  speechActive: boolean;
  focusTick: number;
  toasts: Toast[];
}
const EMPTY_DRAFT: Draft = { text: '', attachments: [] };
const initialState: State = {
  bootstrap: null, loading: true, bootError: null, conversations: [], activeId: null,
  mode: 'chat', drafts: {}, requests: {}, sending: false, attaching: false,
  speechActive: false, focusTick: 0, toasts: [],
};

export function useOverlay(api: OverlayAPI | undefined) {
  const [state, setState] = useState<State>(initialState);
  const current = useRef(state);
  const mounted = useRef(true);
  const navigation = useRef(0);
  const requestRevision = useRef(0);
  const creating = useRef(0);
  const toastId = useRef(0);
  const [retry, setRetry] = useState(0);
  const attachmentQueue = useRef<Promise<void>>(Promise.resolve());
  const attachmentsInFlight = useRef(0);
  const mutate = useCallback((update: (previous: State) => State) => {
    if (!mounted.current) return;
    current.current = update(current.current);
    setState(current.current);
  }, []);
  const notify = useCallback((message: string, kind: Toast['kind'] = 'error') => {
    const id = ++toastId.current;
    mutate((s) => ({ ...s, toasts: [...s.toasts.slice(-3), { id, message, kind }] }));
  }, [mutate]);
  const run = useCallback(async (operation: () => Promise<unknown>) => {
    try { await operation(); } catch (error) { notify(errorMessage(error)); }
  }, [notify]);
  const t = translator(state.bootstrap?.settings.general.language ?? initialLanguage());

  const createConversation = useCallback(async (mode: ModeId, select = true, revision = requestRevision.current): Promise<Conversation> => {
    if (!api) throw new Error('Desktop bridge unavailable');
    const token = select ? ++navigation.current : navigation.current;
    creating.current++;
    try {
      const conversation = await api.newConversation(mode);
      mutate((s) => ({
        ...s,
        // A newer conversation event may already include a running or completed request.
        conversations: s.conversations.some((item) => item.id === conversation.id) ? s.conversations : upsertConversation(s.conversations, conversation),
        ...(select && token === navigation.current && revision === requestRevision.current
          ? { activeId: conversation.id, mode: conversation.mode, focusTick: s.focusTick + 1 } : {}),
      }));
      return conversation;
    } finally { creating.current--; }
  }, [api, mutate]);

  const appendAttachments = useCallback(async (mode: ModeId, attachments: Attachment[], forceNew: boolean, revision = requestRevision.current) => {
    if (!attachments.length) return;
    const before = current.current;
    const active = before.conversations.find((item) => item.id === before.activeId);
    const oldKey = before.activeId ?? 'initial';
    let key = oldKey;
    if (forceNew || !active || active.mode !== mode) {
      const created = await createConversation(mode, true, revision);
      key = created.id;
    }
    mutate((s) => {
      const migrate = !forceNew && key !== oldKey && s.activeId === key;
      const source = migrate ? s.drafts[oldKey] ?? EMPTY_DRAFT : EMPTY_DRAFT;
      const target = s.drafts[key] ?? EMPTY_DRAFT;
      return {
        ...s,
        drafts: {
          ...s.drafts,
          ...(migrate ? { [oldKey]: { text: '', attachments: [] } } : {}),
          [key]: { text: target.text || source.text, attachments: mergeAttachments(mergeAttachments(source.attachments, target.attachments), attachments) },
        },
        focusTick: s.activeId === key ? s.focusTick + 1 : s.focusTick,
      };
    });
  }, [createConversation, mutate]);

  useEffect(() => {
    mounted.current = true;
    if (!api) { mutate((s) => ({ ...s, loading: false })); return () => { mounted.current = false; }; }
    let alive = true;
    let initialized = false;
    const buffered: AppEvent[] = [];
    const handle = (event: AppEvent) => {
      if (!alive) return;
      switch (event.type) {
        case 'conversation':
          mutate((s) => {
            const isNew = !s.conversations.some((item) => item.id === event.conversation.id);
            return {
              ...s, conversations: upsertConversation(s.conversations, event.conversation),
              ...(isNew && s.bootstrap?.settings.modes[event.conversation.mode].outputs.chat !== false
                && (event.conversation.messages.length > 0 || (!creating.current && !Object.values(s.requests).some((item) => isRunning(item.status))))
                ? { activeId: event.conversation.id, mode: event.conversation.mode } : {}),
            };
          });
          break;
        case 'request': {
          const previous = current.current.requests[event.conversationId];
          const fresh = isRunning(event.status) && (!previous || !isRunning(previous.status));
          if (fresh) requestRevision.current++;
          mutate((s) => {
            const conversation = s.conversations.find((item) => item.id === event.conversationId);
            const lastSettled = [...(conversation?.messages ?? [])].reverse().find((message) => message.role === 'assistant' && message.status !== 'pending');
            const existing = s.requests[event.conversationId];
            const baseline = fresh ? lastSettled?.id : existing?.baselineAssistantId;
            return {
              ...s,
              ...(fresh && conversation && s.bootstrap?.settings.modes[conversation.mode].outputs.chat !== false
                ? { activeId: conversation.id, mode: conversation.mode } : {}),
              requests: { ...s.requests, [event.conversationId]: {
                status: event.status,
                text: event.text ?? (fresh ? undefined : existing?.text),
                error: event.error,
                baselineAssistantId: baseline,
              } },
            };
          });
          if (event.error) notify(event.error);
          break;
        }
        case 'attachments': {
          // Keep the event's request revision: a later automatic request must not be hidden by an empty preview session.
          if (!event.attachments.length) break;
          const revision = requestRevision.current;
          attachmentsInFlight.current++;
          mutate((s) => ({ ...s, attaching: true }));
          attachmentQueue.current = attachmentQueue.current
            .then(() => alive ? appendAttachments(event.mode, event.attachments, event.newConversation, revision) : undefined)
            .catch((error) => notify(errorMessage(error)))
            .finally(() => {
              attachmentsInFlight.current--;
              mutate((s) => ({ ...s, attaching: attachmentsInFlight.current > 0 }));
            });
          break;
        }
        case 'settings':
          mutate((s) => ({ ...s, bootstrap: s.bootstrap ? { ...s.bootstrap, settings: event.settings } : null }));
          break;
        case 'focus': mutate((s) => ({ ...s, focusTick: s.focusTick + 1 })); break;
        case 'speech': mutate((s) => ({ ...s, speechActive: event.active })); break;
        case 'error': notify(event.message); break;
      }
    };
    let cleanup = () => {};
    try {
      cleanup = api.onEvent((event) => initialized ? handle(event) : buffered.push(event));
      mutate((s) => ({ ...s, loading: true, bootError: null }));
      void api.bootstrap().then((bootstrap) => {
        if (!alive) return;
        const conversations = [...bootstrap.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        mutate((s) => ({
          ...s, bootstrap, conversations, activeId: conversations[0]?.id ?? null,
          mode: conversations[0]?.mode ?? 'chat', loading: false, bootError: null,
        }));
        initialized = true;
        for (const event of buffered) handle(event);
        buffered.length = 0;
      }).catch((error) => {
        if (alive) mutate((s) => ({ ...s, loading: false, bootError: errorMessage(error) }));
      });
    } catch (error) {
      mutate((s) => ({ ...s, loading: false, bootError: errorMessage(error) }));
    }
    return () => { alive = false; mounted.current = false; cleanup(); };
  }, [api, retry, mutate, notify, appendAttachments]);

  const selectConversation = (conversation: Conversation) => {
    navigation.current++;
    mutate((s) => ({ ...s, activeId: conversation.id, mode: conversation.mode, focusTick: s.focusTick + 1 }));
  };
  const pickMode = async (mode: ModeId) => {
    if (mode === current.current.mode) return;
    if (current.current.activeId) await createConversation(mode);
    else {
      navigation.current++;
      mutate((s) => ({ ...s, mode, focusTick: s.focusTick + 1 }));
    }
  };
  const setText = (text: string) => mutate((s) => {
    const key = s.activeId ?? 'initial';
    return { ...s, drafts: { ...s.drafts, [key]: { ...(s.drafts[key] ?? EMPTY_DRAFT), text } } };
  });
  const busyId = busyConversationId(state.conversations, state.requests);
  const busy = state.sending || !!busyId;

  const send = async () => {
    if (!api) return;
    const before = current.current;
    if (before.sending || before.attaching || busyConversationId(before.conversations, before.requests)) return;
    const oldKey = before.activeId ?? 'initial';
    const draft = before.drafts[oldKey] ?? EMPTY_DRAFT;
    if (!draft.text.trim() && !draft.attachments.length) return;
    mutate((s) => ({ ...s, sending: true }));
    let conversationId = before.activeId;
    let dispatched = false;
    try {
      if (!conversationId) conversationId = (await createConversation(before.mode)).id;
      const id = conversationId;
      const conversation = current.current.conversations.find((item) => item.id === id);
      const baselineAssistantId = [...(conversation?.messages ?? [])].reverse().find((message) => message.role === 'assistant')?.id;
      mutate((s) => ({
        ...s, drafts: { ...s.drafts, [oldKey]: { text: '', attachments: [] }, [id]: { text: '', attachments: [] } },
        requests: { ...s.requests, [id]: { status: 'starting', baselineAssistantId } },
      }));
      dispatched = true;
      // Do not wait for a complete response before clearing the composer or entering busy state.
      await api.send({ conversationId: id, mode: before.mode, text: draft.text, attachmentIds: draft.attachments.map((item) => item.id) });
    } catch (error) {
      const message = errorMessage(error);
      mutate((s) => {
        const key = conversationId ?? oldKey;
        const latestDraft = s.drafts[key] ?? EMPTY_DRAFT;
        return {
          ...s,
          drafts: { ...s.drafts, [key]: { text: latestDraft.text || draft.text, attachments: mergeAttachments(draft.attachments, latestDraft.attachments) } },
          requests: dispatched && conversationId ? { ...s.requests, [conversationId]: { ...s.requests[conversationId], status: 'error', error: message } } : s.requests,
        };
      });
      notify(message);
    } finally { mutate((s) => ({ ...s, sending: false })); }
  };

  const addFiles = async (files?: File[]) => {
    if (!api || current.current.attaching) return;
    const revision = requestRevision.current;
    attachmentsInFlight.current++;
    mutate((s) => ({ ...s, attaching: true }));
    try {
      const attachments = files ? await api.dropFiles(files) : await api.chooseFiles();
      await appendAttachments('files', attachments, false, revision);
    } finally {
      attachmentsInFlight.current--;
      mutate((s) => ({ ...s, attaching: attachmentsInFlight.current > 0 }));
    }
  };
  const removeAttachment = async (id: string) => {
    if (!api) return;
    const key = current.current.activeId ?? 'initial';
    const attachment = current.current.drafts[key]?.attachments.find((item) => item.id === id);
    if (!attachment) return;
    mutate((s) => ({ ...s, drafts: { ...s.drafts, [key]: { ...(s.drafts[key] ?? EMPTY_DRAFT), attachments: (s.drafts[key]?.attachments ?? []).filter((item) => item.id !== id) } } }));
    try { await api.releaseAttachments([id]); }
    catch (error) {
      mutate((s) => ({ ...s, drafts: { ...s.drafts, [key]: { ...(s.drafts[key] ?? EMPTY_DRAFT), attachments: mergeAttachments(s.drafts[key]?.attachments ?? [], [attachment]) } } }));
      throw error;
    }
  };
  const deleteConversation = async (id: string) => {
    if (!api) return;
    await api.deleteConversation(id);
    const attachmentIds = current.current.drafts[id]?.attachments.map((item) => item.id) ?? [];
    mutate((s) => {
      const conversations = s.conversations.filter((item) => item.id !== id);
      const drafts = { ...s.drafts }; delete drafts[id];
      const requests = { ...s.requests }; delete requests[id];
      const next = s.activeId === id ? conversations[0] : s.conversations.find((item) => item.id === s.activeId);
      return { ...s, conversations, drafts, requests, activeId: next?.id ?? null, mode: next?.mode ?? s.mode };
    });
    if (attachmentIds.length) await api.releaseAttachments(attachmentIds);
    notify(t('deleted'), 'success');
  };
  const renameConversation = async (id: string, title: string) => {
    if (!api) return;
    await api.renameConversation(id, title);
    notify(t('renamed'), 'success');
  };
  const saveSettings = async (settings: Settings) => {
    if (!api) throw new Error(t('bridgeMissing'));
    const saved = await api.saveSettings(settings);
    mutate((s) => ({ ...s, bootstrap: s.bootstrap ? { ...s.bootstrap, settings: saved } : null }));
    notify(translator(saved.general.language)('saved'), 'success');
    return saved;
  };
  const testCli = async () => {
    if (!api) throw new Error(t('bridgeMissing'));
    const cli = await api.testCli();
    mutate((s) => ({ ...s, bootstrap: s.bootstrap ? { ...s.bootstrap, cli } : null }));
    return cli;
  };

  return {
    ...state, api, t, busy, busyId,
    active: state.conversations.find((item) => item.id === state.activeId),
    draft: state.drafts[state.activeId ?? 'initial'] ?? EMPTY_DRAFT,
    notify, run, setText, send, addFiles, removeAttachment, selectConversation, pickMode,
    newConversation: (mode = current.current.mode) => createConversation(mode),
    deleteConversation, renameConversation, saveSettings, testCli,
    retry: () => setRetry((value) => value + 1),
    dismissToast: (id: number) => mutate((s) => ({ ...s, toasts: s.toasts.filter((item) => item.id !== id) })),
  };
}

export type OverlayController = ReturnType<typeof useOverlay>;
