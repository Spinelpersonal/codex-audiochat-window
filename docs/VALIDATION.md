# Validierungsprotokoll – 1.0.0

Datum: 21.10.2026. Entwicklungs-/Buildhost: Windows 11 x64, Build 26200; Node.js 24.21.0. Desktop-Laufzeit: Electron 42.11.18 mit Node.js 24.19.0. Verwendete Codex-CLI: 0.163.0. Keine Git-Commits oder Systeminstallation wurden vorgenommen.

## Tatsächlich ausgeführte Prüfungen

| Prüfung | Ergebnis und Umfang |
| --- | --- |
| `npm run typecheck` | Bestanden; auch im abschließenden Release-Build ausgeführt |
| Editor-Projektdiagnostik | Keine Fehler oder Warnungen gemeldet |
| `npm test` | **306 Tests in 9 Dateien bestanden**, nach Aktualisierung auf PDF.js 6.4.299 |
| `npm run test:renderer` | **17 Tests bestanden** |
| `npm run test:ui` | Echte Electron-App und Preload, isoliertes Datenprofil; Einstellungen, CLI-Status und Wiederherstellung nach Neustart bestanden |
| `npm run dist` | Windows-x64-NSIS-Installer erfolgreich erzeugt; ausführbare Datei mit App-Metadaten/Icon, ohne Signatur |
| `node scripts/ui-smoke.mjs --packaged --wait-ms=0` | Tatsächliche `release/win-unpacked/Codex Overlay.exe` gestartet, Bootstrap/CLI-Status, alle Einstellungskategorien, Speichern und Wiederherstellung nach Neustart bestanden; keine Rendererfehler oder entfernten Rendererrequests |
| PDF in gepackter App | Künstliche PDF über echten Chromium-Dateianhang, Preload und FileService importiert; erwarteter Dokumenttext aus `app.asar`-Runtime extrahiert |
| Native Windows-Ressourcen | PowerShell-Syntax und eingebettetes C# kompiliert; gepackte App listete **2 installierte SAPI-Stimmen** auf, ohne Audio abzuspielen |
| `node scripts/live-smoke.mjs --confirm-usage` | **Zwei echte Codex-Anfragen erfolgreich**: erste Antwort `CODEX_OVERLAY_OK`, Folgeantwort `MINT` aus dem vorherigen Gesprächskontext; echte Session-ID und Status-/Text-Ereignisse empfangen |
| `npm audit --omit=dev --audit-level=high` | **0 gemeldete Produktions-Schwachstellen** |
| `npm audit --audit-level=high` | Keine hohen/kritischen Meldungen; **8 moderate Meldungen im Build-Abhängigkeitsbaum**, siehe unten |

Die Live-Anfragen verwendeten nur künstlichen Testtext und die vorhandene Anmeldung. Es wurden weder Desktopinhalte noch persönliche Dateien für den Live-Test übertragen. Codex kann diese synthetischen Turns in seinem eigenen Sitzungsverzeichnis behalten. Die regulären Unit-/UI-Tests verwenden keine Modellanfragen; Test-Doubles existieren nur in Testdateien.

Die UI-Smokes deaktivieren globale Hotkeys, Autostartänderungen und Benachrichtigungen und nutzen einen eigenen temporären Datenordner. Ihre Screenshots zeigen ausschließlich das Appfenster, nicht den Desktop:

- `.test-output/overlay.png`
- `.test-output/ui-smoke-result.json`
- `.test-output/packaged-overlay.png`
- `.test-output/packaged-ui-smoke-result.json`

Diese lokalen Artefakte und Release-Dateien sind absichtlich nicht in Git aufgenommen.

## Installer-Artefakt

Datei: `release/Codex Overlay Setup 1.0.0.exe`

Größe: **124.195.831 Bytes** (ca. 118,4 MiB).

SHA-256:

```text
dffa6404259822bfbad258028fbe643a3ab0a0c0580a3a15fe52034debda5231
```

Der Hash gilt für diesen konkreten Build. Ein Neubau kann trotz unverändertem Quellcode wegen eingebetteter Builddaten einen anderen Hash ergeben. Das Artefakt ist **nicht codesigniert**; es wird keine Signatur- oder SmartScreen-Vertrauensstellung behauptet.

## Sicherheitsprüfung und verbleibende Warnungen

- PDF.js wurde nach einer Audit-Meldung auf **6.4.299** aktualisiert. Vite, esbuild und electron-builder wurden auf kompatible, gepatchte Versionen aktualisiert. Die Versionen sind im Lockfile festgehalten.
- Die verbleibenden acht moderaten Entwicklungsmeldungen gehen auf `sprintf-js` über `roarr → global-agent → @electron/get → electron-builder` zurück. Sie betreffen den Build-Abhängigkeitsbaum, nicht die ausgelieferten Produktionsabhängigkeiten. Der vorgeschlagene erzwungene Builder-Downgrade würde bekannte höhere Schwachstellen wieder einführen und wurde nicht übernommen. Vor öffentlicher Distribution erneut prüfen; Auditergebnisse sind zeitabhängig.
- PDF.js meldet für nicht eingebettete Standardfonts weiterhin `standardFontDataUrl`-Warnungen. Die Testtexte werden korrekt extrahiert; vollständige Font-/CMap-Abdeckung ist nicht zugesichert. Siehe [PDF-Runtime](pdf-runtime.md).
- Nodes separater Renderer-Test meldet eine harmlose Modulformat-Erkennung für TypeScript-Quelldateien. Der Electron-Release verwendet explizite `.cjs`-Bundles und bestand den echten Starttest.
- Der Packager meldet deduplizierte/vermehrt referenzierte Frontend-Abhängigkeiten; Build und Appstart wurden dadurch nicht verhindert.

## Noch nicht praktisch abgenommen

Kein automatischer oder Live-Texttest ersetzt die [Windows-Abnahmecheckliste](WINDOWS-TEST-CHECKLIST.md). Insbesondere **nicht als bestanden behauptet**:

- Echte Vollbild-/Bereichsaufnahmen und Bildanalyse des realen Desktops, insbesondere mehrere Monitore, negative Ursprünge und gemischte DPI-Skalierung.
- Globale Shortcuts unter realen Fremdprogrammen und Betriebssystem-Konflikten; die Transaktions-/Konfliktlogik wurde mit Testregistries geprüft.
- Hörbare SAPI-Wiedergabe, Lautstärke, Tempo und Audiohardware. Nur Stimmenauflistung und Prozess-/Textaufbereitung wurden automatisch geprüft.
- Windows-Autostart nach Ab-/Anmeldung oder Neustart, echte NSIS-Installation/Deinstallation und frisches Windows-Benutzerprofil.
- Zielkompatibilität mit Windows 10; entwickelt und gebaut wurde unter Windows 11 x64.
- Vollständige A–F-Live-Abläufe mit allen nativen Ein-/Ausgaben. Die vier Modi und ihre Ausgaberouten wurden offline auf Engine-Ebene geprüft.

## Verwendete technische Referenzen

- [Offizielle Codex-CLI-Referenz](https://developers.openai.com/codex/cli/reference)
- [Offizieller nichtinteraktiver Modus und JSONL-Protokoll](https://developers.openai.com/codex/noninteractive)
- Lokale Hilfe von `codex exec --help` und `codex exec resume --help`, Version 0.163.0; erlaubte Argumentkombinationen wurden ohne Modellanfragen geprüft.
- [Lorenzo-Se/claude-chat](https://github.com/Lorenzo-Se/claude-chat) als Workflow-/Designinspiration; kein Quellcode übernommen.
