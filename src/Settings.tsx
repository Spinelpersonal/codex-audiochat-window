import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, AudioLines, Check, CircleAlert, FolderOpen, Keyboard, RefreshCw, RotateCcw, Save, Settings2, SlidersHorizontal, Square, Terminal, Volume2, X } from 'lucide-react';
import { MODE_IDS, type CliStatus, type ModeId, type OverlayAPI, type Settings as AppSettings, type Voice } from '../shared/types';
import { defaultSettings } from '../shared/defaults';
import { duplicateShortcuts, errorMessage, normalizeShortcut, rebaseSettingsDraft, shortcutFromKey } from './model';
import { translator, type TranslationKey } from './i18n';
import { Field, IconButton, Modal, ModeIcon, Spinner, Toggle } from './ui';

type Category = 'general' | 'codex' | 'shortcuts' | 'modes' | 'audio';
const categories = [
  { id: 'general', Icon: Settings2 }, { id: 'codex', Icon: Terminal },
  { id: 'shortcuts', Icon: Keyboard }, { id: 'modes', Icon: SlidersHorizontal }, { id: 'audio', Icon: AudioLines },
] as const;

interface Props {
  settings: AppSettings;
  api: OverlayAPI;
  cli: CliStatus;
  version: string;
  active: boolean;
  initialCategory: Category;
  speechActive: boolean;
  onClose: () => void;
  onSave: (settings: AppSettings) => Promise<AppSettings>;
  onTestCli: () => Promise<CliStatus>;
  onError: (message: string) => void;
}

export function Settings({ settings, api, cli, version, active, initialCategory, speechActive, onClose, onSave, onTestCli, onError }: Props) {
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [category, setCategory] = useState<Category>(initialCategory);
  const [mode, setMode] = useState<ModeId>('chat');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'discard' | 'reset' | null>(null);
  const [recording, setRecording] = useState<ModeId | null>(null);
  const [recordError, setRecordError] = useState<ModeId | null>(null);
  const [testing, setTesting] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voicesLoaded, setVoicesLoaded] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceTesting, setVoiceTesting] = useState(false);
  const previousSettings = useRef(settings);
  const alive = useRef(true);
  const t = translator(draft.general.language);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const duplicates = duplicateShortcuts(draft);
  const invalidShortcuts = new Set(MODE_IDS.filter((id) => normalizeShortcut(draft.modes[id].shortcut) === null));
  const reservedShortcuts = new Set(MODE_IDS.filter((id) => normalizeShortcut(draft.modes[id].shortcut) === 'Control+N'));
  const errors: TranslationKey[] = [];
  if (!Number.isInteger(draft.codex.timeoutSeconds) || draft.codex.timeoutSeconds < 10 || draft.codex.timeoutSeconds > 1800) errors.push('invalidTimeout');
  if (!Number.isFinite(draft.audio.rate) || draft.audio.rate < -10 || draft.audio.rate > 10) errors.push('invalidRate');
  if (!Number.isFinite(draft.audio.volume) || draft.audio.volume < 0 || draft.audio.volume > 100) errors.push('invalidVolume');
  if (duplicates.size) errors.push('duplicateShortcut');
  if (invalidShortcuts.size) errors.push('invalidShortcut');
  if (reservedShortcuts.size) errors.push('reservedShortcut');

  useEffect(() => {
    const previous = previousSettings.current;
    setDraft((current) => rebaseSettingsDraft(current, previous, settings));
    previousSettings.current = settings;
  }, [settings]);
  useEffect(() => { if (active) setCategory(initialCategory); }, [active, initialCategory]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!active) setRecording(null); }, [active]);

  const general = <K extends keyof AppSettings['general']>(key: K, value: AppSettings['general'][K]) => setDraft((s) => ({ ...s, general: { ...s.general, [key]: value } }));
  const codex = <K extends keyof AppSettings['codex']>(key: K, value: AppSettings['codex'][K]) => setDraft((s) => ({ ...s, codex: { ...s.codex, [key]: value } }));
  const audio = <K extends keyof AppSettings['audio']>(key: K, value: AppSettings['audio'][K]) => setDraft((s) => ({ ...s, audio: { ...s.audio, [key]: value } }));
  const modeConfig = <K extends keyof AppSettings['modes']['chat']>(id: ModeId, key: K, value: AppSettings['modes']['chat'][K]) => setDraft((s) => ({ ...s, modes: { ...s.modes, [id]: { ...s.modes[id], [key]: value } } }));

  useEffect(() => {
    if (!recording || !active) return;
    const record = (event: KeyboardEvent) => {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.repeat || event.isComposing) return;
      if (event.key === 'Escape') { setRecording(null); setRecordError(null); return; }
      const shortcut = shortcutFromKey(event);
      if (!shortcut) {
        if (!['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(event.key)) setRecordError(recording);
        return;
      }
      setDraft((s) => ({ ...s, modes: { ...s.modes, [recording]: { ...s.modes[recording], shortcut } } }));
      setRecordError(null); setRecording(null); setSaveError(null);
    };
    window.addEventListener('keydown', record, true);
    return () => window.removeEventListener('keydown', record, true);
  }, [recording, active]);

  const loadVoices = useCallback(async () => {
    setVoicesLoading(true); setVoiceError(null);
    try {
      const list = await api.voices();
      if (alive.current) { setVoices(list); setVoicesLoaded(true); }
    } catch (error) { if (alive.current) setVoiceError(errorMessage(error)); }
    finally { if (alive.current) setVoicesLoading(false); }
  }, [api]);
  useEffect(() => { if (active && category === 'audio' && !voicesLoaded) void loadVoices(); }, [active, category, voicesLoaded, loadVoices]);
  const action = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (error) { onError(errorMessage(error)); } };
  const save = async () => {
    if (saving || !dirty || errors.length || recording) return;
    setSaving(true); setSaveError(null);
    try {
      const normalized = structuredClone(draft);
      for (const id of MODE_IDS) normalized.modes[id].shortcut = normalizeShortcut(normalized.modes[id].shortcut) ?? normalized.modes[id].shortcut;
      setDraft(structuredClone(await onSave(normalized)));
    }
    catch (error) { setSaveError(errorMessage(error)); onError(errorMessage(error)); }
    finally { setSaving(false); }
  };
  const close = () => { if (saving) return; if (dirty) setConfirm('discard'); else onClose(); };
  const config = draft.modes[mode];

  return <section className="settings-view" aria-label={t('settings')}>
    <header className="settings-header">
      <IconButton label={t('back')} onClick={close}><ArrowLeft size={18} /></IconButton>
      <div><h1>{t('settings')}</h1><p>{t('settingsIntro')}</p></div>
      <span className="version">v{version}</span>
    </header>
    <nav className="settings-tabs" aria-label={t('settings')}>
      {categories.map(({ id, Icon }) => <button key={id} type="button" aria-current={category === id ? 'page' : undefined} className={category === id ? 'is-active' : ''}
        onClick={() => { setCategory(id); setRecording(null); }}><Icon size={15} /><span>{t(id)}</span></button>)}
    </nav>
    <div className="settings-scroll" key={category}>
      <fieldset className="settings-fields" disabled={saving}>
        {category === 'general' && <>
          <Section title={t('appearance')}>
            <div className="field-grid">
              <Field label={t('language')}>{(id) => <select id={id} value={draft.general.language} onChange={(e) => general('language', e.target.value as 'de' | 'en')}><option value="de">Deutsch</option><option value="en">English</option></select>}</Field>
              <Field label={t('theme')}>{(id) => <select id={id} value={draft.general.theme} onChange={(e) => general('theme', e.target.value as AppSettings['general']['theme'])}><option value="dark">{t('dark')}</option><option value="light">{t('light')}</option><option value="system">{t('system')}</option></select>}</Field>
            </div>
          </Section>
          <Section title={t('windowBehavior')}>
            {(['launchAtLogin', 'tray', 'startMinimized', 'alwaysOnTop', 'hideOnBlur'] as const).map((key) => <Toggle key={key} label={t(key)} hint={t(`${key}Hint`)} checked={draft.general[key]} onChange={(value) => general(key, value)} />)}
          </Section>
        </>}
        {category === 'codex' && <>
          <Section title={t('cliConnection')}>
            <Field label={t('cliPath')} hint={t('cliPathHint')}>{(id, hintId) => <div className="input-action"><input id={id} aria-describedby={hintId} value={draft.codex.cliPath} onChange={(e) => codex('cliPath', e.target.value)} placeholder="codex" spellCheck={false} /><IconButton label={t('browse')} onClick={() => void action(async () => { const path = await api.selectCli(); if (path) codex('cliPath', path); })}><FolderOpen size={17} /></IconButton></div>}</Field>
            <Field label={t('model')} hint={t('modelHint')}>{(id, hintId) => <input id={id} aria-describedby={hintId} value={draft.codex.model} onChange={(e) => codex('model', e.target.value)} placeholder={t('defaultModel')} spellCheck={false} />}</Field>
            <Field label={t('workingDirectory')} hint={t('workingDirectoryHint')}>{(id, hintId) => <div className="input-action"><input id={id} aria-describedby={hintId} value={draft.codex.workingDirectory} onChange={(e) => codex('workingDirectory', e.target.value)} placeholder="C:\…" spellCheck={false} /><IconButton label={t('browse')} onClick={() => void action(async () => { const path = await api.selectDirectory(); if (path) codex('workingDirectory', path); })}><FolderOpen size={17} /></IconButton></div>}</Field>
            <Field label={t('sandbox')} hint={t('sandboxHint')}>{(id, hintId) => <select id={id} aria-describedby={hintId} value={draft.codex.sandbox} onChange={(e) => codex('sandbox', e.target.value as AppSettings['codex']['sandbox'])}><option value="read-only">{t('readOnly')}</option><option value="workspace-write">{t('workspaceWrite')}</option></select>}</Field>
            <Field label={`${t('timeout')} · ${t('seconds')}`} hint={t('timeoutHint')}>{(id, hintId) => <input id={id} aria-describedby={hintId} type="number" min={10} max={1800} step={1} value={Number.isFinite(draft.codex.timeoutSeconds) ? draft.codex.timeoutSeconds : ''} onChange={(e) => codex('timeoutSeconds', e.target.valueAsNumber)} />}</Field>
          </Section>
          <Section title={t('localCli')}>
            <div className="cli-result"><div className="cli-result-heading"><span className={`status-dot ${cli.installed && cli.authenticated ? 'is-ready' : ''}`} /><strong>{t(cli.installed && cli.authenticated ? 'ready' : 'notReady')}</strong>{cli.version && <code>{cli.version}</code>}</div>
              <dl><div><dt>{t('installed')}</dt><dd>{t(cli.installed ? 'yes' : 'no')}</dd></div><div><dt>{t('authenticated')}</dt><dd>{t(cli.authenticated ? 'yes' : 'no')}</dd></div></dl>
              <p>{cli.message}</p>{cli.path && <code className="cli-path">{cli.path}</code>}
            </div>
            <button type="button" className="button secondary" disabled={testing} onClick={() => { setTesting(true); void action(onTestCli).finally(() => setTesting(false)); }}>{testing ? <Spinner size={14} /> : <Terminal size={14} />}{t(testing ? 'testing' : 'testCli')}</button>
            <p className="field-hint">{t('savedCliHint')}</p>
          </Section>
        </>}
        {category === 'shortcuts' && <>
          <p className="section-intro">{t('shortcutIntro')}</p>
          <Section title={t('shortcuts')}>
            {MODE_IDS.map((id) => {
              const shortcutError = duplicates.has(id) ? 'duplicateShortcut' : reservedShortcuts.has(id) ? 'reservedShortcut'
                : invalidShortcuts.has(id) || recordError === id ? 'invalidShortcut' : null;
              return <div className="shortcut-row" key={id}>
              <div className="shortcut-name"><ModeIcon mode={id} /><label htmlFor={`shortcut-${id}`}>{t(id)}</label></div>
              <button id={`shortcut-${id}`} type="button" className={`shortcut-recorder ${recording === id ? 'is-recording' : ''} ${shortcutError ? 'is-invalid' : ''}`}
                aria-label={`${t('recordShortcut')}: ${t(id)}`} aria-pressed={recording === id} aria-invalid={!!shortcutError} aria-describedby={shortcutError ? `shortcut-error-${id}` : undefined}
                onClick={() => { setRecording(recording === id ? null : id); setRecordError(null); }}>
                {recording === id ? <><span className="recording-dot" />{t('pressKeys')}</> : draft.modes[id].shortcut ? <Shortcut value={draft.modes[id].shortcut} /> : <span>—</span>}
              </button>
              <IconButton label={`${t('clearShortcut')}: ${t(id)}`} disabled={!draft.modes[id].shortcut} onClick={() => { modeConfig(id, 'shortcut', ''); setRecording(null); setRecordError(null); }}><X size={14} /></IconButton>
              {shortcutError && <p className="field-error" id={`shortcut-error-${id}`}>{t(shortcutError)}</p>}
            </div>; })}
            <p className="field-hint">{t('shortcutHint')}</p>
          </Section>
          <div className="info-callout"><CircleAlert size={16} /><p>{t('shortcutConflict')}</p></div>
          <Section title={t('localShortcuts')}>
            <div className="local-shortcut"><span>{t('newHint')}</span><Shortcut value="Control+N" /></div>
            <div className="local-shortcut"><span>{t('escapeHint')}</span><kbd>Esc</kbd></div>
            <p className="field-hint">{t('focusHint')}</p>
          </Section>
        </>}
        {category === 'modes' && <>
          <p className="section-intro">{t('modeIntro')}</p>
          <div className="mode-settings-picker">{MODE_IDS.map((id) => <button key={id} type="button" className={mode === id ? 'is-active' : ''} aria-pressed={mode === id} onClick={() => setMode(id)}><ModeIcon mode={id} />{t(id)}</button>)}</div>
          <Section title={t(mode)} action={<button type="button" className="text-button" onClick={() => setDraft((s) => ({ ...s, modes: { ...s.modes, [mode]: defaultSettings().modes[mode] } }))}><RotateCcw size={13} />{t('resetMode')}</button>}>
            <Toggle label={t('promptEnabled')} hint={t('promptHint')} checked={config.promptEnabled} onChange={(value) => modeConfig(mode, 'promptEnabled', value)} />
            <Field label={t('modePrompt')}>{(id) => <textarea id={id} rows={6} value={config.prompt} disabled={!config.promptEnabled} onChange={(e) => modeConfig(mode, 'prompt', e.target.value)} />}</Field>
            <fieldset className="outputs"><legend>{t('outputs')}</legend>
              {(['chat', 'clipboard', 'speech'] as const).map((output) => <label key={output}><input type="checkbox" checked={config.outputs[output]} onChange={(e) => modeConfig(mode, 'outputs', { ...config.outputs, [output]: e.target.checked })} /><span>{t(output === 'chat' ? 'outputChat' : output === 'clipboard' ? 'outputClipboard' : 'outputSpeech')}</span></label>)}
            </fieldset>
            <Toggle label={t('autoSend')} hint={t(mode === 'chat' ? 'chatAutoSendHint' : 'autoSendHint')} checked={config.autoSend} onChange={(value) => modeConfig(mode, 'autoSend', value)} />
          </Section>
        </>}
        {category === 'audio' && <>
          <Section title={t('voice')} action={<IconButton label={t('refreshVoices')} disabled={voicesLoading} onClick={() => void loadVoices()}>{voicesLoading ? <Spinner size={14} /> : <RefreshCw size={14} />}</IconButton>}>
            <Field label={t('voice')} hint={t('voicesHint')}>{(id, hintId) => <select id={id} aria-describedby={hintId} value={draft.audio.voice} onChange={(e) => audio('voice', e.target.value)}>
              <option value="">{t('systemVoice')}</option>
              {draft.audio.voice && !voices.some((voice) => voice.id === draft.audio.voice) && <option value={draft.audio.voice}>{draft.audio.voice}</option>}
              {voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}{voice.language ? ` · ${voice.language}` : ''}</option>)}
            </select>}</Field>
            {voicesLoading && <p className="muted inline-status"><Spinner size={13} />{t('loading')}</p>}
            {voiceError && <p className="field-error" role="alert">{t('loadVoicesError')} {voiceError}</p>}
            {voicesLoaded && !voices.length && <p className="field-hint">{t('noVoices')}</p>}
            <Field label={`${t('rate')} · ${draft.audio.rate > 0 ? '+' : ''}${draft.audio.rate}`}>{(id) => <><input id={id} type="range" min={-10} max={10} step={1} value={draft.audio.rate} onChange={(e) => audio('rate', e.target.valueAsNumber)} /><div className="range-labels"><span>{t('slower')}</span><span>{t('faster')}</span></div></>}</Field>
            <Field label={`${t('volume')} · ${draft.audio.volume}%`}>{(id) => <input id={id} type="range" min={0} max={100} value={draft.audio.volume} onChange={(e) => audio('volume', e.target.valueAsNumber)} />}</Field>
            <div className="button-row"><button type="button" className="button secondary" disabled={voiceTesting} onClick={() => { setVoiceTesting(true); void action(() => api.speak(t('voiceSample'))).finally(() => setVoiceTesting(false)); }}>{voiceTesting ? <Spinner size={14} /> : <Volume2 size={15} />}{t('testVoice')}</button>
              <button type="button" className="button secondary" disabled={!speechActive && !voiceTesting} onClick={() => void action(() => api.stopSpeech())}><Square size={12} />{t('stopSpeech')}</button></div>
            <p className="field-hint">{t('savedVoiceHint')}</p>
          </Section>
        </>}
      </fieldset>
      {errors.length > 0 && <div className="validation-summary" role="status">{errors.map((key) => <p key={key}><CircleAlert size={14} />{t(key)}</p>)}</div>}
      {saveError && <div className="error-callout" role="alert"><CircleAlert size={17} /><div><strong>{t('error')}</strong><p>{saveError}</p></div></div>}
      <footer className="settings-about"><span>Codex Overlay · {t('about')} {version} · v{draft.version}</span><button className="text-button" type="button" onClick={() => setConfirm('reset')} disabled={saving}><RotateCcw size={13} />{t('resetAll')}</button></footer>
    </div>
    <footer className="settings-savebar"><span className={dirty ? 'dirty-state' : 'saved-state'}>{dirty ? <span className="recording-dot" /> : <Check size={13} />}{t(dirty ? 'unsaved' : 'allSaved')}</span><button type="button" className="button primary" onClick={() => void save()} disabled={!dirty || saving || errors.length > 0 || !!recording}>{saving ? <Spinner size={15} /> : <Save size={15} />}{t(saving ? 'saving' : 'save')}</button></footer>
    {confirm && active && <Modal title={t(confirm === 'discard' ? 'discardTitle' : 'resetAllTitle')} onClose={() => setConfirm(null)} t={t}>
      <p className="modal-copy">{t(confirm === 'discard' ? 'discardBody' : 'resetAllBody')}</p>
      <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setConfirm(null)}>{t(confirm === 'discard' ? 'keepEditing' : 'cancel')}</button><button type="button" className="button primary" onClick={() => {
        if (confirm === 'discard') { setDraft(structuredClone(settings)); setSaveError(null); onClose(); }
        else { setDraft(defaultSettings()); setSaveError(null); }
        setConfirm(null);
      }}>{t(confirm === 'discard' ? 'discard' : 'resetAll')}</button></div>
    </Modal>}
  </section>;
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return <section className="settings-section"><header><h2>{title}</h2>{action}</header><div className="settings-section-body">{children}</div></section>;
}
export function Shortcut({ value }: { value: string }) {
  const labels: Record<string, string> = { Control: 'Ctrl', Super: 'Win', Meta: 'Win' };
  return <span className="key-combination">{(normalizeShortcut(value) ?? value).split('+').map((key, index) => <kbd key={`${key}-${index}`}>{labels[key] ?? key}</kbd>)}</span>;
}
