# Projekt: Codex Overlay – Windows AI Assistant

## 1. Projektziel

Entwickle eine vollständige, moderne und performante Windows-Desktop-Anwendung namens **Codex Overlay**.

Die Anwendung soll als systemweiter KI-Assistent funktionieren, der jederzeit über frei konfigurierbare Tastenkombinationen aufgerufen werden kann.

Im Hintergrund soll die Anwendung die **OpenAI Codex CLI im Headless-Modus** verwenden. Der Benutzer soll nicht mit einem Terminal interagieren müssen.

Die Anwendung soll vier Interaktionsmodi unterstützen:

1. Normaler Chat
2. Vollbild-Screenshot
3. Bereichs-Screenshot
4. Datei-Analyse

Jeder dieser Modi muss unabhängig konfigurierbar sein, insbesondere hinsichtlich seines System-Prompts, seiner Tastenkombination und der gewünschten Antwortausgabe.

**Wichtig:** Entwickle eine tatsächlich funktionsfähige Anwendung, keine reine UI-Demo oder einen Prototyp mit simulierten Antworten.

---

## 2. Technologie-Stack

Verwende vorzugsweise:

- **Tauri v2** als Desktop-Framework
- **React + TypeScript** für das Frontend
- **Rust** für native Windows-Funktionalitäten und Backend-Integration
- **Tailwind CSS** für das Styling
- **Codex CLI** als KI-Backend
- Native Windows-APIs für Screenshots, Tastenkombinationen und Text-to-Speech

Die Anwendung soll unter Windows 10 und Windows 11 funktionieren.

Verwende möglichst wenige unnötige Abhängigkeiten und achte auf eine klare, wartbare Projektstruktur.

## 3. Codex-CLI-Integration

Die Anwendung soll eine bereits installierte und authentifizierte Codex CLI verwenden.

### Anforderungen

- Automatische Erkennung der Codex-Installation
- Erkennung, ob Codex korrekt authentifiziert ist
- Einstellbare Pfadangabe zur Codex-Executable
- Möglichkeit, ein Codex-Modell auszuwählen
- Vollständig unsichtbare Ausführung der CLI
- Asynchrone Verarbeitung von Anfragen
- Streaming der Antworten, sofern unterstützt
- Anzeige des aktuellen Verarbeitungsstatus
- Fehlerbehandlung bei fehlender Internetverbindung, Authentifizierungsproblemen und CLI-Abstürzen
- Laufende Anfragen abbrechen können
- Unterstützung mehrerer aufeinanderfolgender Nachrichten mit erhaltenem Chat-Kontext

Untersuche vor der Implementierung die aktuelle offizielle Codex-CLI-Dokumentation.

Nutze `codex exec` für Headless-Einzelanfragen und bei Bedarf `codex app-server` für persistente Chats und Streaming.

Verwende die offiziell unterstützten Schnittstellen und Parameter. Erfinde keine CLI-Optionen.

Die Anwendung soll die vorhandene Codex-Authentifizierung sicher wiederverwenden, ohne Zugangsdaten selbst im Klartext zu speichern.

Alle Prozesse sollen beim Beenden oder Abbrechen sauber aufgeräumt werden.

## 4. Always-on-Top Chatfenster

Erstelle ein modernes, minimalistisches Chatfenster.

### Verhalten

- Das Chatfenster ist standardmässig immer über anderen Fenstern.
- Es kann über einen globalen Shortcut geöffnet und geschlossen werden.
- Beim Öffnen erhält das Eingabefeld automatisch den Fokus.
- Mit Enter wird eine Nachricht gesendet.
- Shift + Enter erzeugt einen Zeilenumbruch.
- Escape kann das Fenster schliessen.
- Das Fenster kann verschoben und in der Grösse verändert werden.
- Die Fensterposition und -grösse werden gespeichert.
- Das Fenster soll nicht unnötig den Fokus anderer Anwendungen stehlen.
- Optional soll es sich automatisch ausblenden, wenn der Benutzer ausserhalb des Fensters klickt.

### Chat-Funktionen

- Markdown-Unterstützung
- Syntax-Highlighting für Code
- Kopierbare Code-Blöcke
- Streaming-Anzeige der Antworten
- Chat-Verlauf
- Neue Konversation starten
- Vorherige Konversationen öffnen
- Nachrichten und Antworten kopieren
- Loading-Animationen
- Stop-Button für laufende Anfragen

Das Fenster soll sich wie ein schnelles Spotlight- oder PowerToys-Run-Overlay anfühlen und nicht wie ein grosses traditionelles Chatprogramm.

## 5. Vier Interaktionsmodi

### Modus 1: Normaler Chat

Der Benutzer öffnet mit einem Shortcut das Chatfenster und kann eine beliebige Nachricht eingeben.

Die Nachricht wird an Codex gesendet und entsprechend den konfigurierten Ausgabeoptionen verarbeitet.

Dieser Modus unterstützt einen fortlaufenden Chat mit Konversationskontext.

### Modus 2: Vollbild-Screenshot

Ein globaler Shortcut erstellt automatisch einen Screenshot des aktuellen Bildschirms.

Anforderungen:

- Erfassung des aktiven Bildschirms
- Unterstützung mehrerer Monitore
- Korrekte Verarbeitung unterschiedlicher DPI-Skalierungen
- Screenshot als Bild an Codex übergeben
- Optional eine zusätzliche Frage zum Screenshot eingeben
- Eine Vorschau des Screenshots ermöglichen
- Konfigurierbarer System-Prompt zur Bildanalyse

Beispiel:

Der Benutzer drückt Ctrl + Shift + F und erhält eine Erklärung des sichtbaren Bildschirminhalts.

### Modus 3: Bereichs-Screenshot

Ein globaler Shortcut aktiviert ein Screenshot-Auswahlwerkzeug.

Anforderungen:

- Bildschirm wird durch ein transparentes Overlay abgedunkelt.
- Der Benutzer kann mit der Maus einen rechteckigen Bereich auswählen.
- Der ausgewählte Bereich wird hervorgehoben.
- Beim Loslassen der Maustaste wird der Bereich als Screenshot erfasst.
- Mit Escape kann der Vorgang abgebrochen werden.
- Der Screenshot wird an Codex übergeben.
- Optional kann der Benutzer eine zusätzliche Frage eingeben.

Die Bedienung soll ähnlich wie bei Windows Snipping Tool funktionieren.

### Modus 4: Datei-Analyse

Der Benutzer kann eine oder mehrere Dateien auswählen, die anschliessend von Codex analysiert werden.

Anforderungen:

- Dateiauswahl über den Windows-Dateidialog
- Drag & Drop
- Unterstützung mehrerer Dateien
- Vorschau der ausgewählten Dateien
- Optionales Eingabefeld für zusätzliche Anweisungen
- Unterstützung gängiger Text-, Code- und Bilddateien
- PDF-Unterstützung mit geeigneter Textextraktion
- Sichtbare Fehlermeldung bei nicht unterstützten Dateiformaten

Dateiinhalte dürfen nicht nur anhand ihres Dateinamens beschrieben werden. Die tatsächlichen Inhalte müssen verarbeitet werden.

---

## 6. Individuelle Einstellungen pro Modus

Dies ist eines der wichtigsten Features der Anwendung.

**Jeder Interaktionsmodus benötigt eine eigene, vollständig unabhängige Konfiguration.**

### A. Globaler Shortcut

Der Benutzer kann für jeden Modus einen individuellen globalen Shortcut festlegen.

Beispiel:

| Modus | Shortcut |
|---|---|
| Normaler Chat | Ctrl + Shift + Space |
| Vollbild-Screenshot | Ctrl + Shift + F |
| Bereichs-Screenshot | Ctrl + Shift + S |
| Datei-Analyse | Ctrl + Shift + D |

Diese Shortcuts sind nur Standardvorschläge und müssen vollständig anpassbar sein.

Anforderungen:

- Shortcut-Aufnahme direkt durch Tastendruck
- Erkennung von Shortcut-Konflikten
- Erkennung bereits belegter globaler Tastenkombinationen
- Änderungen ohne Neustart übernehmen
- Shortcuts dauerhaft speichern

### B. Individueller System-Prompt

Jeder Modus soll optional eigene dauerhafte Anweisungen besitzen.

In den Einstellungen:

- Toggle: System-Prompt aktivieren/deaktivieren
- Mehrzeiliges Textfeld zum Bearbeiten
- Änderungen automatisch oder per Speichern übernehmen
- Zurücksetzen auf den Standardwert

Beispiele:

**Normaler Chat:** „Antworte möglichst kurz, präzise und auf Deutsch.“

**Vollbild-Screenshot:** „Analysiere den Screenshot und erkläre verständlich, was darauf zu sehen ist.“

**Bereichs-Screenshot:** „Wenn der Screenshot eine Programmieraufgabe zeigt, erkläre den Lösungsweg und liefere passenden Code.“

**Datei-Modus:** „Analysiere die bereitgestellten Dateien, identifiziere wichtige Informationen und fasse sie strukturiert zusammen.“

Falls die Codex-Schnittstelle keine echten System-Nachrichten unterstützt, verwende den bestmöglichen offiziell unterstützten Mechanismus für dauerhafte Modus-Anweisungen. Dokumentiere die tatsächliche Priorität dieser Anweisungen korrekt.

### C. Antwortausgabe pro Modus

Für jeden Modus soll individuell einstellbar sein, wie die Antwort verarbeitet wird.

Drei Hauptoptionen:

**1. Chatfenster**

- Chatfenster automatisch öffnen
- Antwort im Chat darstellen
- Markdown und Code-Unterstützung
- Laufende Ausgabe anzeigen

**2. Clipboard**

- Antwort direkt in die Windows-Zwischenablage kopieren
- Chatfenster muss nicht geöffnet werden
- Optional eine kleine Windows-Benachrichtigung anzeigen
- Die vorherige Clipboard-Nutzung nicht unnötig verändern, bevor die Antwort fertig ist

**3. Audio / Text-to-Speech**

- Antwort über Windows Text-to-Speech vorlesen
- Chatfenster muss nicht geöffnet werden
- Lautstärke und Sprechgeschwindigkeit einstellbar
- Verfügbare Windows-Stimmen auswählbar
- Audioausgabe kann unterbrochen werden

Die Ausgabeoptionen sollen unabhängig vom Modus sein.

Beispielsweise soll ein Bereichs-Screenshot automatisch analysiert und die Antwort direkt in die Zwischenablage gespeichert werden können, ohne dass ein Chatfenster erscheint.

Optional dürfen mehrere Ausgabeformen kombiniert werden.

---

## 7. Einstellungsmenü

Erstelle ein übersichtliches Einstellungsfenster mit folgenden Kategorien:

### Allgemein

- Mit Windows automatisch starten
- Im System-Tray weiterlaufen
- Beim Start minimiert starten
- Always-on-Top aktivieren/deaktivieren
- Automatisches Ausblenden des Chatfensters
- Sprache der Benutzeroberfläche (Deutsch/Englisch)
- Dark Mode / Light Mode / System

### Codex

- CLI-Pfad
- Installationsstatus
- Authentifizierungsstatus
- Modellauswahl
- Standard-Arbeitsverzeichnis
- Berechtigungs- und Sandbox-Einstellungen
- Verbindung testen

### Shortcuts

- Übersicht aller vier Modi
- Shortcuts individuell festlegen
- Konflikte erkennen
- Standardeinstellungen wiederherstellen

### Modus-Konfiguration

Für jeden der vier Modi:

- Shortcut
- System-Prompt aktivieren/deaktivieren
- System-Prompt bearbeiten
- Antwortausgabe auswählen
- Zusätzliche modusspezifische Optionen

### Audio

- Text-to-Speech-Stimme
- Lautstärke
- Sprechgeschwindigkeit
- Test-Audio abspielen

## 8. Windows-Integration

Die Anwendung soll sich wie eine native Windows-App verhalten.

Implementiere:

- Windows-System-Tray mit Rechtsklickmenü
- Globale Tastenkombinationen
- Windows-Autostart über eine zuverlässige, unterstützte Methode
- Native Benachrichtigungen
- Clipboard-Integration
- Native Dateiauswahl
- Native Screenshot-Erfassung
- Text-to-Speech über Windows
- Kein sichtbares Konsolenfenster bei Codex-Ausführung

Das Schliessen des Hauptfensters soll die Anwendung standardmässig in den System-Tray minimieren.

Über das Tray-Menü soll die Anwendung vollständig beendet werden können.

Nach einem Windows-Neustart sollen alle Einstellungen erhalten bleiben.

## 9. UI/UX Design

Das Design soll modern, hochwertig und minimalistisch sein.

Orientiere dich stilistisch an:

- Windows 11
- Raycast
- PowerToys Run
- modernen AI-Chat-Anwendungen

Designmerkmale:

- Dezente abgerundete Ecken
- Saubere Typografie
- Flüssige, zurückhaltende Animationen
- Moderne Icons
- Klare visuelle Hierarchie
- Dark Mode als Standard
- Gute Kontraste und Lesbarkeit
- Kompaktes Chat-Overlay
- Übersichtliches Einstellungsfenster
- Deutliche Lade- und Fehlerzustände

Achte besonders darauf, dass sich die Anwendung schnell und reaktionsfreudig anfühlt.

## 10. Architektur und Sicherheit

Verwende eine saubere Trennung zwischen UI, Konfiguration, Windows-Integration und Codex-Backend.

Die Architektur soll mindestens folgende Bereiche enthalten:

- Chat-Verwaltung
- Codex-Prozessverwaltung
- Screenshot-Service
- Datei-Verarbeitung
- Hotkey-Manager
- Konfigurationsverwaltung
- Clipboard-Service
- Text-to-Speech-Service
- Windows-Tray-Integration

Weitere Anforderungen:

- Einstellungen lokal speichern
- Keine unnötigen Administratorrechte
- Keine hartkodierten Zugangsdaten
- Keine unnötige Speicherung von Screenshots
- Temporäre Dateien automatisch bereinigen
- Keine ungefragte permanente Bildschirmüberwachung
- Keine unbeabsichtigte Weitergabe von Dateien
- Sichere Prozessaufrufe ohne Shell-Injection
- Keine standardmässige Umgehung von Codex-Berechtigungsabfragen
- Sinnvolle Timeouts und Fehlerbehandlung

Wenn Codex Dateizugriffe oder Systembefehle ausführen möchte, sollen die konfigurierten Sicherheitsgrenzen respektiert werden. Erforderliche Genehmigungen müssen gegebenenfalls in der Anwendung angezeigt werden.

## 11. Fehlerbehandlung

Die Anwendung muss auch in Fehlerfällen zuverlässig funktionieren.

Behandle unter anderem:

- Codex CLI nicht installiert
- Benutzer nicht bei Codex angemeldet
- Keine Internetverbindung
- Ungültiger System-Prompt
- Screenshot fehlgeschlagen
- Datei kann nicht gelesen werden
- Globaler Shortcut bereits verwendet
- Codex-Prozess stürzt ab
- Anfrage läuft zu lange
- Benutzer bricht einen Vorgang ab
- Anwendung wird während einer Anfrage geschlossen

Zeige verständliche Fehlermeldungen und verhindere, dass die gesamte Anwendung bei einem einzelnen Fehler abstürzt.

## 12. Tests und Qualitätssicherung

Implementiere geeignete automatisierte Tests für:

- Speichern und Laden von Einstellungen
- Hotkey-Konfiguration und Konflikterkennung
- Verarbeitung von Codex-Ausgaben
- System-Prompt-Zuordnung
- Auswahl des Ausgabemodus
- Prozessabbruch
- Datei-Verarbeitung
- Fehlerbehandlung

Teste ausserdem die vollständigen Abläufe aller vier Interaktionsmodi.

Erstelle eine nachvollziehbare manuelle Test-Checkliste für Windows-spezifische Funktionen wie Screenshots, Autostart, Tray und Text-to-Speech.

## 13. Build und Installation

Das Ergebnis soll eine vollständig installierbare Windows-Anwendung sein.

Anforderungen:

- Release-Build für Windows
- Installierbares `.exe`- oder `.msi`-Paket
- Funktionierender Autostart
- Keine Entwicklungsumgebung zur normalen Nutzung erforderlich
- Vorhandene Codex-CLI-Installation korrekt erkennen
- Sauberes Deinstallationsverhalten
- Dokumentation der Installation

Erstelle eine README mit:

- Projektbeschreibung
- Voraussetzungen
- Installation
- Entwicklung starten
- Release bauen
- Codex einrichten
- Verwendung der vier Modi
- Konfiguration der Shortcuts
- Bekannten Einschränkungen

## 14. Vorgehensweise

Gehe strukturiert vor, aber bleibe auf die tatsächliche Implementierung fokussiert.

1. Prüfe zuerst die aktuellen technischen Möglichkeiten der Codex CLI und der ausgewählten Windows-Bibliotheken.
2. Definiere eine geeignete Projektstruktur.
3. Implementiere zunächst eine minimal funktionsfähige Codex-Integration mit echter Antwort.
4. Erstelle das Chat-Overlay und dessen Nachrichtenverarbeitung.
5. Implementiere die globalen Shortcuts.
6. Implementiere die Screenshot-Modi.
7. Implementiere den Datei-Modus.
8. Implementiere Clipboard und Text-to-Speech.
9. Erstelle das vollständige Einstellungsfenster.
10. Integriere Tray, Autostart und Windows-spezifische Funktionen.
11. Implementiere Tests und behebe erkannte Probleme.
12. Erstelle einen installierbaren Release-Build.

**Wichtige Arbeitsanweisungen:**

- Schreibe echten, ausführbaren und wartbaren Code.
- Implementiere keine Fake-Funktionen oder Mock-Antworten im produktiven Code.
- Verwende keine Platzhalter, wenn die Funktion tatsächlich implementiert werden kann.
- Überprüfe regelmässig, ob das Projekt kompiliert.
- Teste den Code, soweit es die Entwicklungsumgebung erlaubt.
- Triff bei kleineren offenen Designentscheidungen selbst sinnvolle Entscheidungen.
- Erkläre kurz, wenn eine Funktion aufgrund technischer Einschränkungen anders umgesetzt werden muss.
- Behaupte nicht, dass ungetestete Funktionen erfolgreich getestet wurden.
- Höre nicht nach der Projektplanung auf, sondern implementiere die Anwendung schrittweise bis zu einem möglichst vollständigen Ergebnis.

## 15. Definition of Done

Das Projekt gilt als funktionsfähig, wenn folgende Szenarien erfolgreich ausgeführt werden können:

**Szenario A:** Der Benutzer drückt seinen Chat-Shortcut. Das Overlay öffnet sich. Er schreibt eine Nachricht, Codex verarbeitet sie, und die Antwort erscheint im Chat.

**Szenario B:** Der Benutzer drückt seinen Vollbild-Screenshot-Shortcut. Ein Screenshot wird erfasst, von Codex analysiert und die Antwort entsprechend den Modus-Einstellungen ausgegeben.

**Szenario C:** Der Benutzer markiert per Shortcut einen Bildschirmbereich. Codex analysiert diesen Bereich und kopiert die Antwort automatisch in die Zwischenablage.

**Szenario D:** Der Benutzer wählt eine Datei aus. Codex analysiert den tatsächlichen Dateiinhalt und liest die Antwort über Text-to-Speech vor.

**Szenario E:** Der Benutzer verändert einen Shortcut, den System-Prompt und den Ausgabemodus. Alle Änderungen funktionieren sofort und bleiben nach einem Neustart erhalten.

**Szenario F:** Windows startet neu. Codex Overlay startet automatisch im Hintergrund, erscheint im System-Tray und reagiert auf die konfigurierten Shortcuts.

Das endgültige Ergebnis soll eine zuverlässige, schnelle und optisch ansprechende Windows-Anwendung sein, die Codex systemweit zugänglich macht, ohne dass der Benutzer jedes Mal ein Terminal öffnen muss.

**Beginne jetzt mit der tatsächlichen Entwicklung des Projekts.**
