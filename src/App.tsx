import { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, Command, FileUp, Minus, PanelLeft, Pin, PinOff, Plus, RefreshCw, Settings2, ShieldCheck, SquareTerminal, X } from 'lucide-react';
import { useOverlay, type Toast } from './useOverlay';
import { Chat } from './Chat';
import { Sidebar } from './Sidebar';
import { Settings } from './Settings';
import { initialLanguage, translator, type Translator } from './i18n';
import { IconButton, Spinner } from './ui';

const bridge = window.overlay;

export default function App() {
  const c = useOverlay(bridge);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 760);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState<'general' | 'codex'>('general');
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const settings = c.bootstrap?.settings;
  const t = c.t;
  const openSettings = (category: 'general' | 'codex' = 'general') => { setSettingsCategory(category); setSettingsOpen(true); };
  const closeSidebarOnSmallScreen = () => { if (window.innerWidth < 760) setSidebarOpen(false); };

  useEffect(() => {
    const theme = settings?.general.theme ?? 'dark';
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = theme === 'system' ? media.matches ? 'dark' : 'light' : theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };
    apply(); media.addEventListener('change', apply);
    document.documentElement.lang = settings?.general.language ?? initialLanguage();
    return () => media.removeEventListener('change', apply);
  }, [settings?.general.theme, settings?.general.language]);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 760px)');
    const collapse = () => { if (!media.matches) setSidebarOpen(false); };
    media.addEventListener('change', collapse);
    return () => media.removeEventListener('change', collapse);
  }, []);

  useEffect(() => {
    if (c.loading || !c.bootstrap) return;
    if (c.focusTick) setSettingsOpen(false);
    const frame = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [c.focusTick, c.loading, !!c.bootstrap]);

  useEffect(() => {
    if (!bridge) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector('[role="dialog"]')) return;
      if (event.key === 'Escape') {
        event.preventDefault(); void c.run(() => bridge.windowAction('hide'));
      } else if (event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && event.key.toLowerCase() === 'n' && c.bootstrap) {
        event.preventDefault(); setSettingsOpen(false);
        void c.run(() => c.newConversation('chat'));
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [c]);

  if (!bridge) return <DesktopRequired />;

  return <div className={`app-shell ${sidebarOpen && !settingsOpen ? 'sidebar-open' : ''}`} onDragEnter={(event) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault(); dragDepth.current++; setDragging(true);
  }} onDragOver={(event) => {
    if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }
  }} onDragLeave={(event) => {
    event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  }} onDrop={async (event) => {
    event.preventDefault(); dragDepth.current = 0; setDragging(false);
    const files = [...event.dataTransfer.files];
    if (!files.length || !c.bootstrap) return;
    setSettingsOpen(false);
    await c.run(() => c.addFiles(files));
  }}>
    <header className="titlebar">
      <div className="titlebar-left"><span className="brand-mark"><Command size={14} /></span><span className="app-title">Codex <span>Overlay</span></span><span className="titlebar-divider" />
        {!c.loading && c.bootstrap && <IconButton label={t(sidebarOpen ? 'closeSidebar' : 'openSidebar')} aria-pressed={sidebarOpen} onClick={() => { if (settingsOpen) setSettingsOpen(false); setSidebarOpen((value) => !value); }}><PanelLeft size={15} /></IconButton>}
      </div>
      <div className="titlebar-drag" />
      <div className="window-controls">
        {c.bootstrap && <><IconButton label={t('newChat')} onClick={() => { setSettingsOpen(false); void c.run(() => c.newConversation('chat')); }}><Plus size={16} /></IconButton><IconButton label={t('settings')} aria-pressed={settingsOpen} onClick={() => settingsOpen ? setSettingsOpen(false) : openSettings()}><Settings2 size={15} /></IconButton><span className="titlebar-divider" /></>}
        <IconButton label={t(settings?.general.alwaysOnTop ? 'unpin' : 'pin')} aria-pressed={!!settings?.general.alwaysOnTop} className={settings?.general.alwaysOnTop ? 'pin-active' : ''} onClick={() => void c.run(() => bridge.windowAction('togglePin'))}>{settings?.general.alwaysOnTop ? <Pin size={14} /> : <PinOff size={14} />}</IconButton>
        <IconButton label={t('minimize')} onClick={() => void c.run(() => bridge.windowAction('minimize'))}><Minus size={16} /></IconButton>
        <IconButton label={t('hide')} className="hide-window" onClick={() => void c.run(() => bridge.windowAction('hide'))}><X size={16} /></IconButton>
      </div>
    </header>
    {c.loading ? <div className="connection-state"><span className="connection-logo"><Command size={25} /></span><Spinner size={18} /><p role="status">{t('loading')}</p></div>
      : c.bootError ? <div className="connection-state"><CircleAlert size={28} /><h1>{t('bootstrapError')}</h1><p className="connection-error">{c.bootError}</p><button type="button" className="button primary" onClick={c.retry}><RefreshCw size={15} />{t('retry')}</button></div>
      : c.bootstrap && <>
        <div className="workspace" hidden={settingsOpen}>
          {sidebarOpen && <><button className="sidebar-scrim" type="button" aria-label={t('closeSidebar')} onClick={() => setSidebarOpen(false)} /><Sidebar controller={c} onSettings={() => openSettings()} onSelect={closeSidebarOnSmallScreen} /></>}
          <Chat controller={c} composerRef={composerRef} onSettings={() => openSettings('codex')} />
        </div>
        <div className="settings-container" hidden={!settingsOpen}>
          <Settings settings={c.bootstrap.settings} api={bridge} cli={c.bootstrap.cli} version={c.bootstrap.version} active={settingsOpen} initialCategory={settingsCategory}
            speechActive={c.speechActive} onClose={() => { setSettingsOpen(false); requestAnimationFrame(() => composerRef.current?.focus()); }} onSave={c.saveSettings} onTestCli={c.testCli} onError={c.notify} />
        </div>
      </>}
    {dragging && <div className="drop-overlay"><div><FileUp size={35} strokeWidth={1.5} /><h2>{t('dropTitle')}</h2><p>{t('dropHint')}</p></div></div>}
    <div className="toast-stack" aria-label={t('error')}>{c.toasts.map((toast) => <ToastItem key={toast.id} toast={toast} t={t} onDismiss={c.dismissToast} />)}</div>
  </div>;
}

function ToastItem({ toast, t, onDismiss }: { toast: Toast; t: Translator; onDismiss: (id: number) => void }) {
  const callback = useRef(onDismiss); callback.current = onDismiss;
  useEffect(() => {
    const timeout = setTimeout(() => callback.current(toast.id), toast.kind === 'error' ? 10000 : 4200);
    return () => clearTimeout(timeout);
  }, [toast.id, toast.kind]);
  return <div className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>{toast.kind === 'error' ? <CircleAlert size={16} /> : <Check size={16} />}<p>{toast.message}</p><IconButton label={t('dismiss')} onClick={() => onDismiss(toast.id)}><X size={14} /></IconButton></div>;
}

function DesktopRequired() {
  const [language, setLanguage] = useState(initialLanguage);
  const t = translator(language);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  return <main className="desktop-required"><header><span className="brand-mark"><Command size={17} /></span><strong>Codex Overlay</strong><div className="language-switch"><button type="button" aria-pressed={language === 'de'} onClick={() => setLanguage('de')}>DE</button><button type="button" aria-pressed={language === 'en'} onClick={() => setLanguage('en')}>EN</button></div></header>
    <section><div className="desktop-required-icon"><SquareTerminal size={32} strokeWidth={1.4} /></div><span className="eyebrow">{t('bridgeMissing')}</span><h1>{t('desktopRequired')}</h1><p>{t('desktopRequiredBody')}</p><div className="desktop-instructions"><MonitorIcon /><p>{t('desktopRequiredAction')}</p></div><footer><ShieldCheck size={15} /><span>{t('offlineNote')}</span></footer></section>
  </main>;
}
function MonitorIcon() { return <SquareTerminal size={20} aria-hidden="true" />; }
