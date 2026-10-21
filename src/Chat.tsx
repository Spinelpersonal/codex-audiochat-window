import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ArrowDown, ArrowUp, CircleAlert, Command, FilePlus2, Monitor, Paperclip, ScanLine, Sparkles, Square, Volume2, VolumeX } from 'lucide-react';
import { MODE_IDS, type ModeId } from '../shared/types';
import type { OverlayController } from './useOverlay';
import { Attachments } from './Attachments';
import { CopyButton } from './CopyButton';
import { errorMessage, isRunning, snapshotMessages } from './model';
import { IconButton, ModeIcon, Spinner } from './ui';

const Markdown = lazy(() => import('./Markdown').then((module) => ({ default: module.Markdown })));

export function Chat({ controller: c, composerRef, onSettings }: { controller: OverlayController; composerRef: RefObject<HTMLTextAreaElement | null>; onSettings: () => void }) {
  const { t, api, active, draft } = c;
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  const captureInFlight = useRef(false);
  const [stopping, setStopping] = useState(false);
  const request = active ? c.requests[active.id] : undefined;
  const messages = active ? snapshotMessages(active, request) : [];
  const locale = c.bootstrap?.settings.general.language === 'de' ? 'de-DE' : 'en-US';
  const cliReady = c.bootstrap?.cli.installed && c.bootstrap.cli.authenticated;
  const capture = async (mode: 'screen' | 'region') => {
    if (!api || captureInFlight.current || c.busy || c.attaching) return;
    captureInFlight.current = true;
    setCaptureBusy(true);
    try { await api.capture(mode); } catch (error) { c.notify(errorMessage(error)); }
    finally { captureInFlight.current = false; setCaptureBusy(false); }
  };
  const chooseMode = (mode: ModeId) => {
    if (mode === 'screen' || mode === 'region') void capture(mode);
    else if (mode === 'files') void c.run(() => c.addFiles());
    else void c.run(() => c.pickMode(mode));
  };
  const copy = async (text: string) => {
    try { await api!.copy(text); } catch (error) { c.notify(errorMessage(error)); throw error; }
  };
  const stop = () => {
    if (!c.busyId || stopping) return;
    setStopping(true);
    void c.run(() => api!.cancel(c.busyId!)).finally(() => setStopping(false));
  };
  useLayoutEffect(() => {
    follow.current = true; setShowJump(false);
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [active?.id]);
  useLayoutEffect(() => {
    if (follow.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [active?.messages, request?.text, request?.status]);
  useLayoutEffect(() => {
    const textarea = composerRef.current;
    if (textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`; }
  }, [draft.text, active?.id, composerRef]);
  useEffect(() => {
    const observer = new ResizeObserver(() => { if (follow.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; });
    const content = scrollRef.current?.firstElementChild;
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [active?.id]);

  return <main className="chat-view" aria-label={t('assistant')}>
    <div className="chat-toolbar"><div className="mode-picker" role="group" aria-label={t('modes')}>
      {MODE_IDS.map((mode) => <button type="button" key={mode} className={c.mode === mode ? 'is-active' : ''} aria-pressed={c.mode === mode}
        disabled={captureBusy || c.attaching || (c.busy && mode !== 'chat')} title={`${t(mode)} · ${t(`${mode}Desc`)}`} onClick={() => chooseMode(mode)}><ModeIcon mode={mode} size={14} /><span>{t(mode)}</span></button>)}
    </div><span className="mode-context">{active?.sessionId ? <span className="session-dot" /> : <Command size={12} />}<span>{c.bootstrap?.settings.codex.model || 'Codex'}</span></span></div>
    <div className="message-scroll" ref={scrollRef} onScroll={(event) => {
      const element = event.currentTarget;
      follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
      setShowJump(!follow.current);
    }}>
      {messages.length === 0 ? <div className="empty-state">
        <div className="empty-symbol"><Sparkles size={25} strokeWidth={1.5} /><span /></div>
        <span className="eyebrow">{t('assistant')}</span><h1>{t('emptyTitle')}</h1><p>{t(`${c.mode}Desc`)}</p>
        <div className="empty-actions"><button type="button" disabled={c.busy || captureBusy || c.attaching} onClick={() => void capture('screen')}><Monitor size={17} /><span>{t('captureScreen')}</span><ArrowUp size={12} className="action-arrow" /></button><button type="button" disabled={c.busy || captureBusy || c.attaching} onClick={() => void capture('region')}><ScanLine size={17} /><span>{t('captureRegion')}</span><ArrowUp size={12} className="action-arrow" /></button><button type="button" disabled={c.attaching || c.busy || captureBusy} onClick={() => void c.run(() => c.addFiles())}><FilePlus2 size={17} /><span>{t('addFiles')}</span><ArrowUp size={12} className="action-arrow" /></button></div>
        <p className="empty-caption">{t('emptyHint')}</p>
      </div> : <div className="messages">
        {messages.map((message) => <article key={message.id} className={`message message-${message.role}`} aria-label={t(message.role === 'user' ? 'you' : 'assistant')}>
          <div className={`message-avatar ${message.role === 'assistant' ? 'assistant-avatar' : ''}`}>{message.role === 'assistant' ? <Sparkles size={14} /> : <span>{t('you').slice(0, 1).toUpperCase()}</span>}</div>
          <div className="message-content"><header className="message-header"><strong>{t(message.role === 'user' ? 'you' : 'assistant')}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</time>{message.status === 'cancelled' && <span className="message-badge">{t('cancelled')}</span>}</header>
            {message.attachments && <Attachments attachments={message.attachments} t={t} />}
            {message.text ? message.role === 'assistant' ? <Suspense fallback={<p className="user-text">{message.text}</p>}><Markdown text={message.text} onCopy={copy} t={t} /></Suspense> : <p className="user-text">{message.text}</p> : message.status === 'pending' ? <div className="thinking-indicator" aria-label={t('pending')}><span /><span /><span /></div> : message.role === 'assistant' && message.status === 'complete' ? <p className="muted">{t('emptyResponse')}</p> : null}
            {message.status === 'error' && <div className="message-error"><CircleAlert size={14} /><span>{message.error || t('messageError')}</span></div>}
            {message.text && <div className="message-actions"><CopyButton text={message.text} onCopy={copy} t={t} />{message.role === 'assistant' && <IconButton label={t(c.speechActive ? 'stopSpeech' : 'readAloud')} onClick={() => void c.run(() => c.speechActive ? api!.stopSpeech() : api!.speak(message.text))}>{c.speechActive ? <Square size={12} /> : <Volume2 size={14} />}</IconButton>}</div>}
          </div>
        </article>)}
      </div>}
    </div>
    {showJump && messages.length > 0 && <button type="button" className="jump-button" title={t('viewRequest')} aria-label={t('viewRequest')} onClick={() => { follow.current = true; setShowJump(false); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }}><ArrowDown size={16} /></button>}
    <div className="composer-area">
      {!cliReady && <div className="setup-callout"><TerminalIcon /><div><strong>{t('cliSetup')}</strong><span>{t('cliSetupHint')}</span></div><button type="button" className="text-button" onClick={onSettings}>{t('openSettings')}</button></div>}
      {c.busyId && c.busyId !== active?.id && <div className="other-request"><Spinner size={13} /><span>{t('busyOther')}</span><button type="button" className="text-button" onClick={() => { const conversation = c.conversations.find((item) => item.id === c.busyId); if (conversation) c.selectConversation(conversation); }}>{t('viewRequest')}</button><IconButton label={t('stop')} disabled={stopping} onClick={stop}><Square size={12} /></IconButton></div>}
      <div className={`composer ${c.busy ? 'is-busy' : ''}`}>
        <Attachments attachments={draft.attachments} onRemove={(id) => void c.run(() => c.removeAttachment(id))} t={t} />
        <textarea ref={composerRef} aria-label={t('placeholder')} placeholder={t(c.mode === 'chat' ? 'placeholder' : c.mode === 'screen' ? 'placeholderScreen' : c.mode === 'region' ? 'placeholderRegion' : 'placeholderFiles')}
          value={draft.text} onChange={(event) => c.setText(event.target.value)} rows={2} onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault(); if (!captureInFlight.current) void c.send();
            }
          }} />
        <div className="composer-bottom"><div className="composer-tools"><IconButton label={t('addFiles')} disabled={c.attaching || c.busy || captureBusy} onClick={() => void c.run(() => c.addFiles())}>{c.attaching ? <Spinner size={15} /> : <Paperclip size={16} />}</IconButton><IconButton label={t('captureScreen')} disabled={captureBusy || c.busy || c.attaching} onClick={() => void capture('screen')}><Monitor size={16} /></IconButton><IconButton label={t('captureRegion')} disabled={captureBusy || c.busy || c.attaching} onClick={() => void capture('region')}><ScanLine size={16} /></IconButton>{c.speechActive && <IconButton label={t('stopSpeech')} onClick={() => void c.run(() => api!.stopSpeech())}><VolumeX size={16} /></IconButton>}</div>
          <div className="composer-send"><span className="request-status" role="status">{captureBusy || c.attaching ? <Spinner size={12} /> : c.busy && (!c.busyId || c.busyId === active?.id) ? <><span className="live-dot" />{t(request?.status && isRunning(request.status) ? request.status : 'starting')}</> : c.speechActive ? <><Volume2 size={12} />{t('readAloud')}</> : <span className="enter-hint">{t('enterHint')} <kbd>↵</kbd></span>}</span>
            {c.busy ? <button type="button" className="send-button stop-button" title={t('stop')} aria-label={t('stop')} disabled={!c.busyId || stopping} onClick={stop}>{stopping ? <Spinner size={15} /> : <Square size={13} fill="currentColor" />}</button> : <button type="button" className="send-button" title={`${t('send')} · Enter`} aria-label={t('send')} disabled={(!draft.text.trim() && !draft.attachments.length) || c.attaching || captureBusy} onClick={() => void c.send()}><ArrowUp size={18} /></button>}
          </div>
        </div>
      </div>
      <footer className="composer-footer"><span><span className={`status-dot ${cliReady ? 'is-ready' : ''}`} />{t('localCli')}</span><span>{t('newlineHint')}</span></footer>
    </div>
  </main>;
}
function TerminalIcon() { return <span className="setup-icon" aria-hidden="true">&gt;_</span>; }
