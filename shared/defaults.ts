import type { Settings } from './types';

export function defaultSettings(): Settings {
  return {
    version: 1,
    general: {
      launchAtLogin: false, tray: true, startMinimized: false, alwaysOnTop: true,
      hideOnBlur: false, language: 'de', theme: 'dark',
    },
    codex: { cliPath: '', model: '', workingDirectory: '', sandbox: 'read-only', timeoutSeconds: 180 },
    audio: { voice: '', rate: 0, volume: 85 },
    modes: {
      chat: {
        shortcut: 'Control+Shift+Space', promptEnabled: true,
        prompt: 'Antworte möglichst kurz, präzise und auf Deutsch.',
        outputs: { chat: true, clipboard: false, speech: false }, autoSend: false,
      },
      screen: {
        shortcut: 'Control+Shift+F', promptEnabled: true,
        prompt: 'Analysiere den Screenshot und erkläre verständlich, was darauf zu sehen ist.',
        outputs: { chat: true, clipboard: false, speech: false }, autoSend: false,
      },
      region: {
        shortcut: 'Control+Shift+S', promptEnabled: true,
        prompt: 'Wenn der Screenshot eine Programmieraufgabe zeigt, erkläre den Lösungsweg und liefere passenden Code. Andernfalls erkläre den ausgewählten Inhalt.',
        outputs: { chat: false, clipboard: true, speech: false }, autoSend: true,
      },
      files: {
        shortcut: 'Control+Shift+D', promptEnabled: true,
        prompt: 'Analysiere die bereitgestellten Dateien, identifiziere wichtige Informationen und fasse sie strukturiert zusammen.',
        outputs: { chat: true, clipboard: false, speech: true }, autoSend: false,
      },
    },
  };
}
