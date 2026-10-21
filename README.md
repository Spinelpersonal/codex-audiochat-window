# Codex Overlay

Ein Windows-Desktop-Assistent mit globalen Tastenkürzeln: chatten, den Bildschirm oder einen Ausschnitt analysieren und ausgewählte Dokumente, Bilder und Code mit der **bereits installierten Codex-CLI** besprechen. Antworten lassen sich im Chat anzeigen, in die Zwischenablage kopieren und mit einer lokalen Windows-Stimme vorlesen.

Die Anwendung verwendet **Electron, React, TypeScript und Tailwind CSS**. Tauri/Rust war der bevorzugte ursprüngliche Ansatz; weil die Rust-Toolchain in der Entwicklungsumgebung nicht verfügbar war, wurde die umsetzbare Electron-Variante gewählt. Native Aufnahme und Sprachausgabe laufen über .NET und ein fest mitgeliefertes PowerShell-Skript, nicht über einen zusätzlichen Webdienst.

> **Stand 1.0.0:** Windows-x64-Installer: `release/Codex Overlay Setup 1.0.0.exe`. Ein erfolgreicher Build oder Smoke-Test ist **kein Nachweis einer vollständig geprüften Live-End-to-End-Anwendung**. Insbesondere reale Desktopaufnahmen, hörbare Sprachausgabe und Windows-Autostart sind noch manuell abzunehmen; Windows 10 wurde nicht getestet. Die bisherige Entwicklungsumgebung ist Windows 11 x64.

> **Datenschutz vor dem ersten Bereichs-Shortcut:** `Strg + Umschalt + S` startet standardmäßig die Bereichsauswahl und **sendet den gewählten Ausschnitt anschließend sofort über die Codex-CLI an den konfigurierten Anbieter – ohne weitere Vorschau oder Sendebestätigung**. Die Antwort geht standardmäßig nur in die Zwischenablage, wird aber trotzdem lokal im Verlauf gespeichert. Unter **Einstellungen → Modi → Bereich** zuerst „Automatisch senden“ ausschalten, wenn eine Prüfung vor dem Senden gewünscht ist. Das gilt auch für dieselbe Aufnahmeaktion über die Oberfläche oder das Tray-Menü.

## Voraussetzungen

| Voraussetzung | Hinweise |
| --- | --- |
| Windows 10 oder Windows 11, **x64** | Zielplattform dieser Implementierung; Windows-10-Kompatibilität noch manuell prüfen. Keine macOS-/Linux-Desktopunterstützung oder ARM64-Freigabe. |
| **Windows PowerShell 5.1** und **.NET Framework 4.8** | Für `System.Windows.Forms`, `System.Drawing` und `System.Speech`. Die App nutzt die Windows-PowerShell unter `System32`; PowerShell 7 allein ersetzt sie nicht. Unternehmensrichtlinien können Skriptausführung blockieren. |
| Installierte native Codex-CLI und gültige Anmeldung | Die CLI wird nicht mit dem Overlay installiert. Anbieterzugang, Modellfreigaben, Netzverbindung und mögliche Kosten richten sich nach der eigenen Codex-Konfiguration. |
| Lokale SAPI-Stimmen | Für Vorlesen; sichtbar sind die über `System.Speech` verfügbaren installierten Stimmen, nicht zwingend jede in Windows angezeigte Sprachfunktion. |

Die installierte Overlay-App bringt ihre Electron-/Node-Laufzeit mit; **eine separate Node.js-Installation ist für ihren Betrieb nicht nötig**. Für Entwicklung und Builds wird Node.js 24 LTS mit npm benötigt. Wer Codex über npm installiert, benötigt dafür ebenfalls Node/npm; das Overlay selbst sucht und startet danach die native `codex.exe`, nicht den JavaScript-Launcher.

## Installation und Codex einrichten

1. Den lokal gebauten Installer **`release/Codex Overlay Setup 1.0.0.exe`** ausführen und das Zielverzeichnis wählen. Die NSIS-Konfiguration installiert für den aktuellen Benutzer und legt Startmenü-/Desktopverknüpfungen an.
2. **Unsigned Build:** Es ist kein Code-Signing-Zertifikat eingerichtet. Windows SmartScreen kann deshalb warnen. Nur selbst gebaute oder anderweitig vertrauenswürdig bezogene Dateien verwenden und Unternehmensrichtlinien beachten; Sicherheitsfunktionen nicht pauschal abschalten.
3. Falls Codex noch fehlt, nach dessen offizieller Installationsanleitung eine Windows-Version installieren. Eine npm-Installation ist beispielsweise:

   ```sh
   npm install -g @openai/codex
   ```

4. In einem Terminal prüfen und anmelden:

   ```sh
   codex --version
   codex login
   codex login status
   ```

   Die Anmeldung erfolgt **in Codex**, nicht im Overlay. Wenn PowerShell den npm-Launcher blockiert, kann der vorhandene `codex.cmd` oder die native `codex.exe` direkt verwendet werden; keine globale Lockerung der Ausführungsrichtlinie ist dafür erforderlich.
5. Codex Overlay öffnen, dann **Einstellungen → Codex**:
   - **Codex-Programm:** leer für automatische Suche über `PATH` und bekannte npm-Installationsorte. Alternativ `codex.exe` oder einen vorhandenen `codex.cmd` auswählen. Ein npm-Launcher dient nur zum Auffinden des nativen Programms; er wird nicht als Shellskript ausgeführt.
   - **Modell:** leer übernimmt die Codex-Konfiguration. Bildanalysen erfordern ein tatsächlich bildfähiges Modell und eine passende CLI-Version.
   - **Arbeitsverzeichnis:** einen vorhandenen vertrauenswürdigen Ordner wählen. Leer bedeutet das Benutzer-Homeverzeichnis, nicht automatisch den Projektordner.
   - **Sandbox:** zunächst **Nur lesen / `read-only`** beibehalten. **`workspace-write`** erlaubt ausdrücklich Änderungen im Arbeitsbereich.
   - Änderungen **speichern**, danach **„Gespeicherte CLI-Konfiguration testen“**. Der Test prüft Version und `codex login status`, nicht die Modellverfügbarkeit durch eine Live-Anfrage.

## Bedienung und Standardwerte

Die Werte stammen aus [`shared/defaults.ts`](shared/defaults.ts). „Vorschau“ bedeutet: Aufnahme/Datei wird als Anhang angezeigt; erst **Senden** überträgt die Anfrage.

| Modus | Globales Tastenkürzel | Standardablauf | Antwortausgabe |
| --- | --- | --- | --- |
| Chat | `Strg + Umschalt + Leertaste` | Fenster ein-/ausblenden, Nachricht manuell senden | Chat |
| Bildschirm | `Strg + Umschalt + F` | Monitor unter dem Mauszeiger aufnehmen, Vorschau | Chat |
| Bereich | `Strg + Umschalt + S` | Rechteck auf eingefrorenem Desktop wählen, **sofort automatisch senden** | Zwischenablage; kein automatisches Öffnen des Chats |
| Dateien | `Strg + Umschalt + D` | Dateien auswählen, Vorschau, manuell senden | Chat **und Vorlesen** |

- **Enter** sendet, **Umschalt + Enter** fügt einen Zeilenumbruch ein. **Strg + N** erstellt im Overlay einen neuen Chat; **Escape** blendet das Overlay aus. In der Bereichsauswahl bricht Escape stattdessen die Aufnahme ab.
- Der Bildschirmmodus nimmt **einen Monitor** auf, nicht alle Monitore zusammen. Die Bereichsauswahl verwendet dagegen ein eingefrorenes Bild des virtuellen Desktops, auch über Monitorgrenzen hinweg. Es gibt keine dauerhafte Bildschirmüberwachung.
- Dateien lassen sich auch über die Büroklammer oder Drag & Drop anhängen. Diese Wege erzeugen einen Entwurf im Dateimodus. Automatisches Dateisenden betrifft die Aktivierung über Tastenkürzel/Tray; der Chat-Shortcut öffnet oder verbirgt nur das Fenster, auch bei gesetztem Chat-`autoSend`.
- Modus-Anweisungen, Ausgaben und Auto-Senden sind unter **Modi** konfigurierbar. Mindestens eine Antwortausgabe muss aktiv bleiben. **„Eigene Anweisungen“ sind Benutzerpräferenzen, kein echter System-Prompt.**
- Einstellungen werden erst durch **Änderungen speichern** übernommen. Auch der Stimmtest verwendet gespeicherte Audioeinstellungen. Standard: Systemstimme, Tempo `0`, Lautstärke `85 %`.
- Für globale Kürzel `Strg`, `Alt` oder `Umschalt` plus Taste verwenden. Doppelte, leere, reservierte oder Windows-/Meta-Kombinationen werden im Main-Prozess abgelehnt; bei Konflikten wird versucht, die bisherigen Kürzel wiederherzustellen.
- Standardmäßig sind Tray und „Immer im Vordergrund“ aktiv; Autostart, ausgeblendeter Start und Ausblenden bei Fokusverlust sind aus. Mit aktivem Tray bleibt die App beim Ausblenden verfügbar. **Tray → Beenden** beendet sie wirklich; ohne Tray kann das Fenster mit `Alt + F4` geschlossen werden.
- **Antwort stoppen** bricht die laufende CLI-Anfrage ab. **Vorlesen stoppen** beendet die Sprachausgabe separat. Es läuft immer nur **eine Modellanfrage gleichzeitig**.

## Dateien, Bilder und Grenzen

Text/Code wird wirklich eingelesen; PDFs werden mit PDF.js als Text extrahiert. Die Analyse verwendet nicht bloß den Dateinamen. Unterstützt sind viele gängige Quelltext-/Textformate, etwa TXT, Markdown, CSV, JSON, JS/TS, Python, Rust, C#, HTML und Konfigurationsdateien. Text muss UTF-8 oder UTF-16 mit BOM sein. Ordner, symbolische Datei-Links, Duplikate, unbekannte Formate und als Text getarnte Binärdaten werden abgelehnt; Office-/ZIP-Dateien werden nicht automatisch entpackt.

| Grenze | Aktueller Wert |
| --- | --- |
| Text-/Code-/PDF-Datei | 10 MiB pro Datei |
| Bilddatei | 20 MiB pro Datei |
| Aufbereiteter Dateitext | insgesamt höchstens 150.000 Zeichen, einschließlich der Dateirahmung bei der Vorbereitung |
| Anhänge | höchstens 50 pro Nachricht/öffentlicher Dateiauswahl |
| Eigene Nachricht | 32.000 Zeichen |
| Eigene Modus-Anweisungen | 16.000 Zeichen |
| Modellantwort | 180.000 Zeichen; Vorlesen hat separat höchstens 150.000 Zeichen |
| Anfragezeitlimit | 15–1.800 Sekunden, Standard 180 Sekunden; maßgeblich ist die Main-Prozess-Validierung |
| Bereichsauswahl | höchstens ungefähr 120 Sekunden |

Zeichenlimits beziehen sich auf JavaScript-UTF-16-Codeeinheiten, nicht auf Tokens. Zu große Dateiinhalte werden mit einem Fehler zurückgewiesen, nicht still gekürzt. Kurze Anhangsvorschauen sind dagegen bewusst nur Vorschauen.

**Bilder:** PNG, JPEG, WebP, GIF und BMP werden anhand von Endung und Signatur geprüft. Original-Bildpfade werden als einzelne `--image=…`-Argumente an Codex übergeben; es gibt **keine automatische Konvertierung**. PNG/JPEG sind die naheliegenden Ausgangsformate. Ob andere Formate decodiert werden und das gewählte Modell Bilder akzeptiert, hängt von der tatsächlich installierten CLI-/Anbieterversion ab. Eine erfolgreiche lokale Prüfung oder Vorschau garantiert keine Modellunterstützung. Screenshots sind PNG.

**Kein OCR-Dienst:** Bildschirmtext wird nicht lokal per OCR extrahiert, sondern als Bild an das Modell gegeben. Bildbasierte/gescannte PDFs ohne extrahierbaren Text werden abgelehnt; PDF-Seiten werden nicht automatisch gerastert. Passwortgeschützte PDFs werden nicht automatisch entsperrt. Hinweise zu nativen PDF-Abhängigkeiten und noch offenen Font-/CMap-Einschränkungen: [`docs/pdf-runtime.md`](docs/pdf-runtime.md).

## Datenschutz, Speicherung und Berechtigungen

- Ausgewählte Inhalte, Nachricht und Modus-Anweisungen werden über die lokale CLI an deren konfigurierten Modellanbieter gesendet. **Lokale CLI bedeutet nicht lokale oder offline ausgeführte KI.** Kosten, Aufbewahrung und Datenschutzbedingungen des Anbieters gelten weiterhin. Codex kann je nach Workspace, eigener Konfiguration, Hooks und MCP weitere Kontextquellen nutzen.
- Das Overlay hat keinen eigenen Telemetrie-Backenddienst, keinen API-Schlüssel-Dialog und keinen eigenen Login-/Token-Speicher. Es liest oder kopiert keine Codex-Authdateien; der gestartete CLI-Prozess übernimmt die vorhandene Benutzerumgebung und Anmeldung. Die CLI und eingebundene Dienste können eigene Netzwerk-/Loggingfunktionen haben.
- **`read-only` ist Standard**, `workspace-write` muss ausdrücklich gewählt werden. `approval_policy="never"` heißt: keine interaktive Freigabe für verbotene Aktionen, **nicht** „alles automatisch genehmigen“. Eine Approval-Oberfläche und Codex-`app-server` sind bewusst nicht implementiert. Es werden keine Codex-Flags zur gefährlichen Umgehung von Sandbox und Genehmigungen verwendet.
- Sandboxregeln der CLI sind keine universelle OS-Isolation für alle geerbten Hooks, MCP-Server oder externen Dienste. Unvertrauenswürdige Konfigurationen können Fähigkeiten außerhalb der lokalen Dateisandbox besitzen. Eigene Anweisungen und Dateitext-Markierungen verhindern außerdem keine Prompt-Injection zuverlässig.
- Der Renderer hat keinen Node-Zugriff, benutzt eine schmale Preload-API und darf keine entfernten Webseiten/Markdownbilder laden. Das ist eine Schutzmaßnahme, keine Sicherheitszertifizierung.

### Lokale Daten

Normaler Speicherort: **`%APPDATA%\Codex Overlay`**. `app.setName('Codex Overlay')` wird vor dem ersten normalen `userData`-Zugriff gesetzt; ein datenreiner Electron-Main-Probeaufruf hat diesen Pfad bestätigt. `CODEX_OVERLAY_DATA_DIR` kann ihn für isolierte Tests überschreiben.

```text
%APPDATA%\Codex Overlay\
  settings.json                Einstellungen und eigene Anweisungen
  window.json                  Fensterposition und Größe
  conversations\<UUID>.json    Nachrichten und Anhang-Metadaten
  captures\capture-<UUID>.png  temporäre Aufnahme
```

**Einstellungen und Verläufe sind unverschlüsseltes JSON.** Auch Zwischenablage-only-Antworten werden gespeichert. Anhangsvorschauen bleiben im Arbeitsspeicher und werden nicht in den Verlaufsdateien abgelegt; Original-Dateipfade werden dort ebenfalls nicht gespeichert. Die eigentliche Screenshot-PNG liegt bis zur Bereinigung jedoch temporär auf Disk.

Temporäre Aufnahmen werden nach einer abgeschlossenen, fehlgeschlagenen oder abgebrochenen Anfrage bzw. beim Freigeben des Anhangs gelöscht. Nicht gesendete Aufnahmen werden beim regulären Beenden bereinigt; liegengebliebene `capture-…png`-Dateien beim nächsten Start. Ein Absturz, Dateisperren oder erzwungenes Beenden kann die Löschung verzögern. Das ist **kein sicheres Überschreiben**; Backups und Dateisystemspuren sind damit nicht beseitigt. Originaldateien werden nicht gelöscht.

Zusätzlich verwaltet Codex selbst Sitzungen/Threads, üblicherweise unter **`~/.codex`** beziehungsweise `%USERPROFILE%\.codex` oder einem eigenen `CODEX_HOME`. Dort können Kontext und Inhalte weiter unverschlüsselt bestehen. Das Löschen eines Overlay-Chats oder einer Screenshot-Datei löscht **nicht** diese CLI-Daten oder Anbieter-Aufzeichnungen. Auch die Deinstallation bewahrt die Overlay-Appdaten laut Installerkonfiguration auf.

## Entwicklung, Tests und Builds

Im Projektordner mit Node.js 24 LTS und npm:

```sh
npm ci
npm run dev
```

Die Installation benötigt Netzwerkzugang für Pakete und das Electron-Binary. Optionale native PDF-/Canvas-Abhängigkeiten nicht weglassen. Vite läuft auf `http://127.0.0.1:5173`; `npm run dev` startet zusätzlich Electron. Die URL allein ist keine vollwertige Desktop-App und zeigt ohne Preload nur den entsprechenden Hinweis.

**Rendereränderungen laden automatisch neu. Nach Änderungen an `electron/` oder `shared/` muss `npm run dev` beendet und neu gestartet werden.** Es gibt dort keinen Backend-Watcher.

| Befehl | Zweck |
| --- | --- |
| `npm run typecheck` | TypeScript prüfen |
| `npm test` | Vitest-Tests für Dienste/Protokoll/Store; unter Windows auch echte PDF-Extraktion in einem fensterlosen Electron-Main-Prozess |
| `npm run test:renderer` | Renderer-Zustands-/Modelltests mit Nodes Test-Runner |
| `npm run test:ui` | Erst Build, dann echter Electron-/Preload-UI-Smoke mit isoliertem Profil |
| `npm run build` | Typecheck, Vite-Renderer und Electron-CommonJS-Bundles bauen |
| `npm start` | Bereits gebauten Stand über Electron starten |
| `npm run pack` | Neu bauen und entpackte Windows-x64-App in `release/win-unpacked` erzeugen |
| `npm run dist` | Neu bauen und Windows-x64-NSIS-Installer in `release` erzeugen |
| `node scripts/ui-smoke.mjs --packaged --wait-ms=0` | Bereits gepackte App inklusive PDF-Import und nativer Stimmenliste testen, ohne Modellanfrage oder Audio |
| `node scripts/live-smoke.mjs --confirm-usage` | **Zwei kosten-/kontingentrelevante Live-Anfragen** mit rein künstlichem Text; echte Antwort und Session-Fortsetzung prüfen |

Die regulären automatisierten Tests stellen **keine Live-Modellanfragen**. Nur der ausdrücklich mit `--confirm-usage` gestartete Live-Smoke verwendet die vorhandene Codex-Anmeldung und das zugehörige Kontingent; Codex kann dabei eigene Threads speichern. Der UI-Smoke prüft unter anderem gespeicherte Einstellungen nach Neustart und echte CLI-Statusabfragen. Er öffnet kurz die App und erzeugt `.test-output/overlay.png` **nur vom Appfenster**, keine Desktopaufnahme, sowie `.test-output/ui-smoke-result.json`. Globale Hotkeys, Autostartänderungen und Benachrichtigungen sind dabei deaktiviert; Sprachausgabe und Capture werden nicht ausgelöst. Das ersetzt keine manuelle Prüfung dieser Funktionen.

Die ausgeführten Prüfungen und der Installer-Hash stehen im [Validierungsprotokoll](docs/VALIDATION.md). Das ist keine Zusicherung vollständig getesteter Windows-Szenarien. Siehe auch [Architektur](docs/ARCHITECTURE.md) und die noch abzuarbeitende [Windows-Testcheckliste A–F](docs/WINDOWS-TEST-CHECKLIST.md).

## Bekannte Grenzen und Fehlerbehebung

- **CLI nicht gefunden:** `PATH`/Installation prüfen oder die native `codex.exe` auswählen. Ein `codex.cmd` funktioniert nur, wenn seine zugehörige native npm-Plattforminstallation vorhanden ist. Danach speichern und die gespeicherte Konfiguration testen.
- **Nicht angemeldet:** `codex login` im Terminal ausführen; danach erneut testen. Ein positiver Loginstatus bestätigt noch keine Modell-/Bildberechtigung.
- **Kein sichtbares Token-Streaming:** JSONL-Ereignisse werden während der Ausführung verarbeitet. Je nach Codex-Version erscheinen Text-Snapshots erst bei abgeschlossenen Antwort-Items; gleichmäßige Token-Deltas werden nicht versprochen.
- **Aufnahme schwarz/fehlgeschlagen:** Sperrbildschirm, sicherer UAC-Desktop, geschützte Inhalte oder eine ungeeignete Remote-Sitzung sind keine unterstützten Umgehungsziele. Fehler und Abbruch prüfen; keine erhöhten Berechtigungen oder Sicherheitsabschaltungen als Standardlösung.
- **Keine Stimme/PDF-Runtimefehler:** passende lokale SAPI-Stimme bzw. vollständige native Canvas-Abhängigkeit prüfen; siehe [PDF-Runtime](docs/pdf-runtime.md). PDF-Font-/CMap-Abdeckung ist nicht vollständig geprüft.
- **Autostart im Entwicklungsmodus:** wird abgelehnt; nur mit der installierten/gepackten App prüfen. Ein gültiger Registryeintrag allein beweist noch keinen erfolgreichen Start nach Anmeldung.
- Keine Mikrofonaufnahme oder Sprache-zu-Text-Funktion; sie war nicht Teil dieses Implementierungsumfangs. Ebenso kein `app-server`, keine interaktiven Tool-Freigaben, kein allgemeiner Sandbox-Bypass und keine garantierte Wiederaufnahme gelöschter Codex-Threads.

## Inspiration und Lizenz

Inspiriert durch den Overlay-/Hotkey-Workflow von [Lorenzo-Se/claude-chat](https://github.com/Lorenzo-Se/claude-chat). **Aus diesem Projekt wurde kein Code kopiert.** Codex Overlay ist eine eigenständige Implementierung mit anderer CLI-Anbindung.

Der Projektcode steht unter der [MIT-Lizenz](LICENSE), Copyright 2026 Codex Overlay contributors. Abhängigkeiten behalten ihre jeweiligen Lizenzen.
