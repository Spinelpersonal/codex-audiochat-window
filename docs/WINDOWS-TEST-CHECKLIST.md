# Windows-Abnahmecheckliste A–F

**Status: offene manuelle Abnahme, keine bereits bestandene Testliste.** Alle Kästchen bleiben bis zum tatsächlich ausgeführten und protokollierten Schritt leer. Ein automatischer Test, CLI-Loginstatus oder Installer-Build ersetzt die Live-Szenarien nicht.

Ziel sind Windows 10 und 11 x64. Der bisherige Entwicklungs-/Smoke-Host ist **Windows 11 x64**; Windows 10 ist noch nicht geprüft. Reale Desktopaufnahmen, hörbare Sprachausgabe und Autostart wurden bislang nicht praktisch abgenommen. Der abschließend gebaute Installer liegt unter `release/Codex Overlay Setup 1.0.0.exe`; tatsächlich ausgeführte automatische Prüfungen und Hash stehen in [VALIDATION.md](VALIDATION.md). Seine Installation/Deinstallation wurde nicht automatisch durchgeführt.

[Bedienung und Datenschutz](../README.md) · [Architektur](ARCHITECTURE.md) · [PDF-Runtime](pdf-runtime.md)

## Testprotokoll und Vorbereitung

Für jeden getesteten Build festhalten:

| Feld | Eintrag |
| --- | --- |
| Datum, prüfende Person | … |
| Commit/Arbeitsstand und Buildbefehl | … |
| Installer-/EXE-Pfad und SHA-256 | … |
| Windows-Version/Build, x64, Standard- oder Administratorkonto | … |
| Monitore, Anordnung, Auflösungen, Skalierungen | … |
| Codex-Version, gewähltes Modell, Art der Anmeldung | …; keine Zugangsdaten protokollieren |
| Verwendete CLI-Konfiguration/Hooks/MCP und Workspace | … |
| Overlay-Datenordner | … |
| Ergebnis A–F, offene Fehler und Belege | … |

- [ ] Den **finalen** Stand mit `npm ci`, `npm run build` und `npm run dist` bauen; nicht versehentlich einen alten Installer abnehmen. Installerhash beispielsweise mit `Get-FileHash -LiteralPath '.\release\Codex Overlay Setup 1.0.0.exe' -Algorithm SHA256` protokollieren.
- [ ] Windows PowerShell 5.1 und .NET Framework 4.8 einschließlich WinForms, Drawing und System.Speech verfügbar; Ziel ist kein reines PowerShell-7-Setup.
- [ ] CLI-Version und `codex login status` im Terminal prüfen. Im Overlay Einstellungen speichern und **Gespeicherte CLI-Konfiguration testen** ausführen. Das allein ist noch keine Modellanfrage.
- [ ] Für alle Live-Schritte ausschließlich künstliche Testinhalte benutzen: keine Passwörter, privaten Chats, Kundendaten oder vertraulichen Fenster. **Anbieterübertragung und mögliche Kosten ausdrücklich akzeptieren.**
- [ ] Eigenes leeres Test-Workspace anlegen, `read-only` einstellen und vorhandene Hooks/MCP/CLI-Konfiguration auf zusätzliche Fähigkeiten prüfen. Tests nicht durch Adminstart oder Abschalten von Sicherheitsfunktionen „reparieren“.
- [ ] Normale Daten gegebenenfalls sichern. Für isolierte UI-Tests kann `CODEX_OVERLAY_DATA_DIR` verwendet werden; das isoliert **nicht** automatisch CLI-Anmeldung, `CODEX_HOME` oder Anbieter-Threads. Für den Autostarttest F ein dediziertes Windows-Testkonto mit normalem Profil verwenden; die Autostart-EXE übernimmt keinen nur im Testterminal gesetzten Profilpfad.
- [ ] Automatische Prüfungen ausführen und **aktuelle Ergebnisse**, nicht alte Zählstände, notieren: `npm run typecheck`, `npm test`, `npm run test:renderer`, `npm run test:ui`.

Die regulären automatisierten Tests stellen keine Live-Modellanfragen. Der separate, ausdrücklich bestätigungspflichtige `scripts/live-smoke.mjs` prüft echte Textantworten und Gesprächskontext, nicht diese vollständigen manuellen A–F-Szenarien. Der UI-Smoke verwendet ein isoliertes Profil, reale Preload-/CLI-Statusabfragen und ein Bild **nur des Appfensters**. Er deaktiviert globale Hotkeys, Autostartänderungen und Benachrichtigungen und löst weder Desktop-Capture noch Sprachausgabe aus. Artefakte: `.test-output/ui-smoke-result.json` und `.test-output/overlay.png`. Für A–F **nicht** im `CODEX_OVERLAY_SMOKE`-Modus testen.

## A — Chat, Kontext, Streaming und Abbruch

- [ ] `Strg + Umschalt + Leertaste` aus einer anderen Anwendung drücken: Overlay erscheint, Eingabe erhält Fokus. Noch einmal drücken blendet aus; keine fremden Fenster werden verschoben.
- [ ] Eine harmlose Frage mit einmaligem Kennwort im **Nachrichtentext**, nicht nur im Titel, senden. Reale Antwort im Chat prüfen. Enter sendet, Umschalt + Enter erzeugt einen Zeilenumbruch.
- [ ] Folgefrage zum Kennwort stellen: derselbe Codex-Thread wird fortgesetzt. Neustart und erneute Folgefrage prüfen. Bei fehlendem/gelöschtem Thread verständlicher Fehler statt erfundener Fortsetzung.
- [ ] Statuswechsel beobachten. Antwort-Snapshots dürfen weder Zeichen verdoppeln noch eine frühere Nachricht überschreiben. Wenn die CLI Text erst bei `item.completed` liefert, das als gemessene Streaming-Granularität notieren; Token-Deltas sind kein Abnahmekriterium.
- [ ] Während einer Anfrage zweite Anfrage/zweite Capture-Aktion versuchen: keine parallel gestarteten Modelljobs. Navigation zu anderen Unterhaltungen darf den laufenden Job nicht verwechseln.
- [ ] Antwort stoppen, auch nachdem erste Zeichen vorliegen: Status „Gestoppt“, Teiltext als Teiltext erhalten, keine automatische Clipboard-/Sprachausgabe. Danach ist eine neue Anfrage möglich.
- [ ] Abbruch über Tray und Beenden während einer Anfrage prüfen. Im Task-Manager dürfen kein dauerhaft weiterarbeitender Codex-Prozessbaum und keine geerbten offenen Pipes verbleiben.
- [ ] Modell-/Netzwerkfehler sowie ein zulässiges kurzes Zeitlimit prüfen: verständliche Fehlermeldung, kein falscher Erfolgsstatus, kein endloser Spinner. Keine Testanfrage mit echten Geheimnissen als Fehlerbeleg aufzeichnen.
- [ ] Markdown, Codekopieren und ganze Antwort kopieren prüfen. HTML/Skripte bleiben inert, entfernte Markdownbilder werden nicht nachgeladen, Links öffnen keine unerwarteten Fenster.

**Ergebnis A / Beleg / offene Fehler:** …

## B — Bildschirmmodus und Monitore

Vorher Bildschirm-`autoSend` aus und Ausgabe Chat einstellen; das entspricht dem Standard.

- [ ] Mit `Strg + Umschalt + F` den Monitor unter dem Mauszeiger aufnehmen. Das Overlay selbst fehlt in der Aufnahme. Vorschau erscheint; vor Senden wird keine Modellanfrage ausgelöst.
- [ ] Maus auf jeden Monitor verschieben und wiederholen: Es wird jeweils **ein ganzer aktiver Monitor** aufgenommen, nicht immer der primäre und nicht der gesamte virtuelle Desktop.
- [ ] Einzelmonitor bei 100 %, 125 %, 150 % und 200 % Skalierung prüfen, soweit verfügbar. Pixelmaße, Bildausschnitt und sichtbare Testmarkierungen vergleichen.
- [ ] Gemischte DPI testen, etwa 100 % + 150 %/200 %, unterschiedliche Auflösungen und einen Monitor links/oberhalb des primären Monitors mit negativem Ursprung. Kein Versatz, kein unerwünschtes Cropping.
- [ ] Vorschau mit einer Frage zu einer sichtbaren künstlichen Markierung senden. Antwort muss sich auf den tatsächlichen Bildinhalt beziehen; Bildfähigkeit des gewählten Modells gesondert bestätigen.
- [ ] Prüfen, dass nach dem Turn die eigene `captures/capture-…png` entfernt wird. Die Aufnahme darf nie als Zwischenbild in die Zwischenablage geschrieben werden.
- [ ] Sperren/Entsperren, Remote-Sitzung, gesperrte Capture-API und gegebenenfalls sicherer UAC-Desktop prüfen: Hotkey kann dort nicht zugestellt werden oder Capture kann scheitern/schwarz sein. Kein Zugriff auf geschützte Inhalte durch eine Berechtigungsumgehung; nach Rückkehr bleibt die App bedienbar. Fehler/Timeout dürfen keinen hängenden PowerShell-Prozess hinterlassen.

**Ergebnis B / Monitor- und DPI-Matrix / Belege:** …

## C — Bereichsauswahl und sofortige Clipboard-Antwort

> **Achtung:** Der Standardmodus sendet die Auswahl unmittelbar an den Anbieter. Für geometrische Tests zuerst „Automatisch senden“ ausschalten; nur für den ausdrücklich akzeptierten Live-Test wieder einschalten.

- [ ] Auswahl mit `Strg + Umschalt + S` öffnen. Der Desktop ist eingefroren und abgedunkelt; im Hintergrund geänderte Fenster verändern den eingefrorenen Inhalt nicht.
- [ ] Rechteck in allen Zugrichtungen und nahe jedem Bildschirmrand auswählen. Pixel unter dem Rechteck stimmen mit dem späteren Ausschnitt überein.
- [ ] Rechteck über eine Monitorgrenze mit gemischter DPI und über negative Desktopkoordinaten ziehen. Kein verschobener oder proportional falsch skalierter Ausschnitt.
- [ ] Winzige Auswahl unter 2 × 2 Pixeln nicht übernehmen; danach weiter auswählen oder abbrechen können.
- [ ] Escape, rechte Maustaste und Auswahl-Timeout testen: keine Modellanfrage, kein neuer Clipboard-Inhalt, keine zurückgelassene Teilaufnahme. Das ursprüngliche Fensterverhalten wird sinnvoll wiederhergestellt; spätestens nach ungefähr 120 Sekunden ist die Aktion beendet.
- [ ] Mit künstlichem Bildinhalt die Standardschalter wiederherstellen: **Auto-Senden an, Chat aus, Clipboard an, Sprache aus**. Auswählen startet ohne zusätzliche Sendebestätigung genau eine reale Anfrage.
- [ ] Vorher einen harmlosen Clipboard-Marker setzen. Erst nach erfolgreich gespeicherter vollständiger Antwort ersetzt deren Text den Marker; nicht das Bild. Bei Fehler/Abbruch bleibt der Marker erhalten.
- [ ] Chat öffnet sich für die Clipboard-only-Antwort nicht ungefragt. Antwort über Verlauf/Benachrichtigung wiederfinden: Ausgabe ohne Chat bedeutet **nicht** Speicherung ohne Verlauf.
- [ ] CLI-Startfehler mit bewusst ungültiger gespeicherter Testkonfiguration prüfen: verständlicher Fehler, gegebenenfalls Vorschau für manuelles Wiederholen; keine verlorene oder unbemerkt erneut gesendete Auswahl. Anschließend richtige Konfiguration wiederherstellen.

**Ergebnis C / Datenschutzfreigabe / Belege:** …

## D — Tatsächlicher Dateiinhalt, PDF, Bilder und native Stimmen

- [ ] Text-/Code-Datei auswählen, deren eindeutiger Testinhalt nicht aus dem Namen erraten werden kann. Vorschau anzeigen, manuell senden und tatsächliche Inhaltsanalyse prüfen.
- [ ] Dateiauswahl per Hotkey, Dialog, Büroklammer und Drag & Drop prüfen. Standard ist Vorschau; die Clipboard-/Auto-Senderegeln müssen zur gewählten Aktion passen. Büroklammer/Drop bleiben ein Entwurf.
- [ ] UTF-8 mit Umlauten/Emoji und BOM-markiertes UTF-16 prüfen. Zwischen Vorschau und Senden geänderte Datei wird erneut gelesen oder bei Ersetzung/Unsicherheit abgelehnt; kein veralteter, ungeprüfter Inhalt wird als aktuell behauptet.
- [ ] Echte ein-/mehrseitige PDFs einschließlich komprimierter Textstreams analysieren. PDF-Syntax oder Dateiname sind kein Ersatz für extrahierten Seiteninhalt.
- [ ] Gescannte/bildbasierte, kaputte und passwortgeschützte PDFs prüfen: expliziter Fehler, keine behauptete OCR. Font-/CMap-Probleme separat protokollieren; [PDF-Runtime](pdf-runtime.md) beachten.
- [ ] PNG und JPEG mit bildfähiger CLI/Modellkombination prüfen. WebP/GIF/BMP separat testen: lokale Annahme/Vorschau ist keine Zusicherung, dass die CLI oder das Modell das Format unterstützt; keine automatische Konvertierung voraussetzen.
- [ ] Ordner, nicht unterstützte Binärdatei, umbenannte Binärdatei, ungültige Bildsignatur und Duplikate abweisen. Bei gemischter gültiger/ungültiger Auswahl keine nur teilweise registrierte Auswahl hinterlassen.
- [ ] Grenzfälle für mehr als 10 MiB Text/PDF, 20 MiB Bild, insgesamt 150.000 Zeichen aufbereiteten Dateitext und mehr als 50 Anhänge prüfen. Klare Fehler statt stiller Inhaltskürzung; die kurze Vorschau ist absichtlich kein Volltext.
- [ ] **Hörtest ausdrücklich freigeben.** Unter Audio verfügbare echte SAPI-Stimmen auflisten, Stimme speichern und erst dann „Gespeicherte Stimme testen“ auslösen. Verständliche hörbare Ausgabe, kein externes TTS und kein Konsolenfenster.
- [ ] Gespeichertes Tempo −10 bis +10 und Lautstärke 0–100 prüfen. Andere installierte Stimme wählen; fehlende/unverfügbare Stimme führt zu verständlichem Fehler statt stiller Cloud-Ausweichlösung.
- [ ] Standard-Dateimodus liefert Chat **und** Vorlesen nach erfolgreicher Antwort. Codeblöcke/Markdown-Markierungen werden nicht als Rohsyntax vorgelesen. Eine neue Sprachausgabe unterbricht die alte; Vorlesen stoppen funktioniert auch über Tray.
- [ ] Originaldateien über Erfolg, Fehler, Abbruch und App-Ende unverändert erhalten. Screenshot-PNGs dagegen nach Freigabe bereinigen; Vorschau-Daten und absolute Registry-Pfade nicht in `conversations/*.json` persistieren.

**Ergebnis D / CLI-Bildformate / Stimmen / Belege:** …

## E — Einstellungen, Ausgaben, Persistenz und Berechtigungen

- [ ] Sprache/Theme, eigenes Tastenkürzel, Modus-Anweisungen und Ausgabe ändern: vor **Speichern** bleibt die Main-Konfiguration unverändert; nach Speichern wirken die neuen Werte ohne App-Neustart.
- [ ] Schließen mit ungespeichertem Entwurf bietet Verwerfen/Weiterbearbeiten. Standardwerte bzw. Modus-Reset verändern zunächst nur den Entwurf. Nach echtem Neustart sind nur gespeicherte Änderungen vorhanden.
- [ ] Ein belegtes Shortcut, ein Duplikat, ein leeres/reserviertes Kürzel und eine Windows-/Meta-Kombination werden abgelehnt. Vorherige gültige Kürzel bleiben soweit möglich aktiv; Wiederherstellungsfehler werden nicht verschwiegen. Aufnahme eines Kürzels darf keine unbemerkte Datenübertragung auslösen.
- [ ] Eigene Anweisungen wirken als Präferenz der Benutzeranfrage, **nicht als privilegierter System-Prompt**. Aktivieren/Deaktivieren und getrennte Einstellungen je Modus prüfen; keine Prompt-Injection-Sicherheit aus Rahmenmarkierungen ableiten.
- [ ] Chat, Clipboard und Vorlesen einzeln/kombiniert prüfen; mindestens eine Ausgabe ist erforderlich. Nur vollständig erfolgreiche Antworten werden automatisch kopiert/vorgelesen. Clipboard-only bleibt lokal im Verlauf.
- [ ] Nachrichten über 32.000 Zeichen, eigene Modus-Anweisungen über 16.000 und Antwort-/Audio-Grenzen prüfen. Für Antworten können deterministische Prozessfixtures benutzt werden; keine teure Live-Ausgabe erzwingen. Main-validiertes Zeitlimit ist 15–1.800 Sekunden.
- [ ] Datenpfad auf normaler Installation als `%APPDATA%\Codex Overlay` bestätigen. Einstellungen, Fenster und Verläufe sind unverschlüsseltes JSON; nicht mit verschlüsseltem Secret-Storage verwechseln. Kein Auth-Token wird vom Overlay in diesen Dateien angelegt.
- [ ] Verlauf nach Neustart, Umbenennen, Markdownexport und Löschen prüfen. Ein gelöschter Overlay-Chat darf nicht als Löschung seiner Codex-Threads/Anbieterdaten ausgegeben werden. Unterbrochene Nachrichten werden nach Neustart als abgebrochen angezeigt.

### Read-only tatsächlich prüfen, keine Freigabe umgehen

- [ ] Einen leeren Wegwerf-Workspace einstellen, **`read-only` speichern** und Hooks/MCP vorher auf außerhalb liegende Schreibfähigkeiten kontrollieren. Testmarker existiert noch nicht.
- [ ] Bewusst anfordern: „Erstelle ausschließlich im eingestellten Testordner die Datei `sandbox-denial-probe.txt` mit Inhalt `READ_ONLY_PROBE`. Keine Ausweichwege.“ Eine tatsächliche verweigerte CLI-Tooloperation als Beleg suchen; bloßer Antworttext oder eine nicht angelegte Datei allein beweist keinen ausgeübten Sandboxschutz. Fehlt ein belegbarer Versuch, diesen Teil als offen notieren.
- [ ] Marker bleibt aus; verweigerte Aktion wird nicht durch Adminstart, andere Ordner, geänderte CLI-Flags oder externe Tools umgangen. **Kein Freigabedialog** ist erwartbar: `approval_policy="never"` verweigert Eskalation, nicht automatisch genehmigen.
- [ ] Nur nach separater ausdrücklicher Freigabe **`workspace-write`** im Wegwerf-Workspace speichern und einen kontrollierten Schreibtest durchführen. Danach wieder `read-only` speichern. Keine Testdatei außerhalb des Wegwerf-Ordners und keine systemweite Änderung.
- [ ] Falls trotz Read-only geschrieben wird, Prüfung stoppen und Konfiguration/externen Dienst untersuchen. CLI-Sandbox und geerbte MCP-/Hook-Fähigkeiten getrennt bewerten; kein Sicherheitsversprechen durch Anpassung der Doku oder gefährliche Bypass-Flags herstellen.

**Ergebnis E / Persistenz-/Sandboxbelege / offene Fehler:** …

## F — Tray, Windows-Anmeldung, Shutdown und Deinstallation

Dieses Szenario benötigt eine installierte/gepackte App, **keinen Dev- oder Smoke-Modus**. Es ist noch nicht durch einen Registry- oder UI-Smoke-Test erledigt.

- [ ] Tray an: Klick toggelt Sichtbarkeit; Kontextmenü für Chat/Aufnahme/Dateien/Antwort stoppen/Audio stoppen/Beenden funktioniert. Ausblenden/Schließen lässt die App nur dann wie vorgesehen im Tray weiterlaufen.
- [ ] Tray aus: App bleibt über Taskleiste/Fenster erreichbar, Ausblenden minimiert sinnvoll, `Alt + F4` beendet. Keine unsichtbare, nicht mehr erreichbare Instanz.
- [ ] „Immer im Vordergrund“, „Bei Fokusverlust ausblenden“ und ausgeblendeter Start prüfen. Native Datei-/Speicherdialoge und Bereichsauswahl werden nicht unbeabsichtigt durch Fokusverlust zerstört.
- [ ] „Bei Anmeldung starten“ speichern, eigenen HKCU-Run-Eintrag mit installierter EXE und `--hidden` prüfen. Autostartversuch im Entwicklungsmodus muss abgelehnt werden.
- [ ] **Windows tatsächlich ab- und wieder anmelden oder neu starten.** Installierte App startet im Hintergrund, Tray ist vorhanden, konfigurierte Hotkeys reagieren. Mit künstlichen Inhalten arbeiten; Bereich kann sofort senden. Keine Autostart-Schleife und kein Konsolenfenster.
- [ ] Autostart ausschalten, erneut anmelden: kein automatischer Start. Auch das negative Ergebnis muss praktisch geprüft sein.
- [ ] Zweiten Appstart versuchen: vorhandene Instanz wird aktiviert, keine doppelte Hotkeyregistrierung und kein konkurrierendes Leeren des Capture-Caches.
- [ ] Beenden während Bereichsauswahl, Anfrage und Sprachausgabe jeweils prüfen: bekannte native Prozesse/CLI-Bäume enden, kein endloses Warten. Der Main-Prozess hat einen 25-Sekunden-Notausstieg; dessen Auftreten als Fehler festhalten, nicht als normalen Erfolg.
- [ ] Nicht gesendete Capture-Vorschau erstellen und regulär beenden: temporäre Datei verschwindet. Abbruch-/Dateisperrfall mit ausschließlich künstlichen Daten kontrolliert testen: liegengebliebene eigene Capture-Dateien werden beim nächsten Start entfernt; Originalanhänge bleiben erhalten. Löschung ist kein sicheres Überschreiben.
- [ ] Installer als Standardbenutzer auf Windows 11 und **separat Windows 10** prüfen: Zielpfad wählbar, Startmenü-/Desktopverknüpfungen korrekt, mitgelieferte PowerShell-/PDF-/Canvas-Ressourcen auch aus ASAR/Installationsverzeichnis verfügbar.
- [ ] Unsigned-/SmartScreen-Verhalten dokumentieren. Eine Warnung ist kein erfolgreich geprüfter Signaturstatus; weder Defender noch Organisationsrichtlinien pauschal deaktivieren.
- [ ] Vor Deinstallation benötigte Daten sichern. Deinstallation entfernt App/Verknüpfungen und den eigenen Autostartwert, lässt laut Konfiguration lokale Appdaten bestehen. Codex-Installation, dessen Anmeldung/Threads und fremde Registryeinträge bleiben unangetastet.
- [ ] Bei anschließendem Anmelden startet keine entfernte Overlay-EXE mehr. Gewollt aufbewahrte Appdaten und CLI-Daten separat nach Datenschutzbedarf behandeln; keine automatische Komplettlöschung behaupten.

**Ergebnis F / echte Anmelde- und Deinstallationsbelege:** …

## Abschlussentscheidung

- [ ] A–F für den **tatsächlich freizugebenden Build** protokolliert; nicht ausgeführte Schritte ausdrücklich offen/übersprungen mit Grund.
- [ ] Windows-10-Lücke, Modell-/CLI-Bildformatgrenzen, PDF-Fontwarnungen, Signing und etwaige weitere Einschränkungen im Freigabeprotokoll nennen.
- [ ] Abschließende Test-/Buildbefehle und aktuelle Ergebnisse ergänzen. Keine „vollständig live getestet“-Behauptung ohne entsprechende Belege.
- [ ] README-/Releasehinweis erst nach bestätigtem Neubau und tatsächlicher Abnahme aktualisieren; keine Modell-, Bildschirm-, Sprach- oder Autostarttests aus einem reinen Smoke-Erfolg ableiten.
