# KWR103 Web-Steuerung

Browser-Oberfläche zur Steuerung des Labornetzteils **KORAD KWR103** (0–60 V, 0–15 A, 300 W)
über die serielle Schnittstelle (USB) mit der [Web Serial API](https://developer.mozilla.org/docs/Web/API/Web_Serial_API).
Schwesterprojekt zu *KEL103-Web*. Kein Build-Schritt, keine Abhängigkeiten – reines HTML/CSS/JavaScript.

## Funktionen

- Verbinden über USB-Seriell (Baudrate wählbar, Standard 115200)
- Spannung und Strombegrenzung setzen, Ausgang ein/aus, Anzeige CC/CV
- Live-Anzeige von Spannung, Strom und Leistung mit Verlaufsdiagramm
- **Batterie laden (CC/CV)** mit Ladeschlussspannung, Ladestrom, Abschaltstrom, Abschaltdauer,
  Mindestspannung und maximaler Ladezeit; geladene mAh und Wh werden angezeigt und protokolliert
- Schutz: OVP-Spannung und OVP ein/aus, OCP-Strom
- Schnellspeicher M1–M5, Tastenton, Tastensperre, Remote Sense
- Messdateien je Ladung bzw. je Einschalten des Ausgangs, Download als CSV oder ZIP
- CSV wahlweise für deutsches Excel (`;`, Dezimalkomma, Ortszeit) oder international
- Konsole für beliebige Befehle

## Starten

Nur in **Chrome / Edge (Desktop)** und in sicherem Kontext (`https://` oder `http://localhost`):

```sh
python -m http.server 8001
```

Dann <http://localhost:8001> öffnen, **Verbinden** klicken und den COM-Port des Netzteils wählen.

## Batterie laden

1. **Ladung vorbereiten:** Das Netzteil wird auf die Ladeschlussspannung mit **1 mA** Strombegrenzung
   gestellt und der Ausgang eingeschaltet.
2. **Batterie anschließen:** Die Website erkennt die Batterie daran, dass die Ausgangsspannung unter die
   Ladeschlussspannung einbricht und das Netzteil in die Strombegrenzung (CC) geht – 2 s stabil.
3. **Prüfung:** Liegt die Batteriespannung unter der **Mindestspannung** (tiefentladen) oder über der
   Ladeschlussspannung, wird die Ladung verweigert und der Ausgang abgeschaltet.
4. **Laden:** Strombegrenzung auf den Ladestrom – erst CC, dann CV an der Ladeschlussspannung.
5. **Ende:** sobald der Strom die eingestellte **Abschaltdauer** (Standard 30 s) durchgehend unter dem
   **Abschaltstrom** liegt, oder nach der **maximalen Ladezeit**. Danach wird der Ausgang ausgeschaltet.

Die Überwachung läuft in der Website, nicht im Netzteil: Während der Ladung die Seite geöffnet lassen.
Wird die Verbindung getrennt, schaltet die Website den Ausgang ab (Haken „Ausgang beim Trennen
ausschalten“). Stürzt der Browser ab, hält das Netzteil die Ladeschlussspannung mit dem Ladestrom.

Die Strommessung des KWR103 hat ±(0,1 % + 3 mA) Genauigkeit – der Abschaltstrom muss daher mindestens 10 mA
betragen. Nach dem Laden bleibt die Ladeschlussspannung eingestellt (kein Zurücksetzen auf alte Werte,
damit beim nächsten Einschalten keine zu hohe Spannung an der Batterie liegt).

Die Messdatei einer Ladung enthält zusätzlich `geladen_mAh`, `geladen_Wh`, `ladezeit_min` und `modus` (CC/CV)
sowie in der Spalte `info` die Phase (Warte auf Batterie, Laden CC, Laden CV) und Ereignisse.

## Befehle (am Gerät geprüft, Firmware V1.8)

| Zweck | Befehl |
|---|---|
| Identifikation | `*IDN?` → `KORAD KWR103 V1.8 SN:…` |
| Sollwerte | `VSET:4.200`, `VSET?` → `04.200`; `ISET:0.500`, `ISET?` → `00.500` |
| Messwerte | `VOUT?`, `IOUT?` |
| Ausgang | `OUT:1` / `OUT:0`, `OUT?` → `1`/`0` |
| Status | `STATUS?` → **ein rohes Byte** + `\n` (kein Text) |
| OVP | `OVP:60.500` (Wert), `OVP:ON` / `OVP:OFF`, `OVP?` |
| OCP | `OCP:15.500` (Wert), `OCP?` |
| System | `BEEP:1/0`, `LOCK:1/0`, `COMP:1/0` + `COMP?` (Remote Sense) |
| Speicher | `RCL:1…5`, `SAV:1…5` (M1–M5) |

`STATUS?`-Byte: Bit 0 = 1 bei CV, 0 bei CC · Bit 1 Ausgang · Bit 2 Priorität · Bit 4 Summer ·
Bit 5 Tastensperre · Bit 6 OVP aktiv · Bit 7 OCP.

### Eigenheiten

- `STATUS?` antwortet binär; der Treiber liest deshalb byteweise (ein Statusbyte `0x0A` oder ≥ `0x80`
  würde eine Textauswertung stören).
- `OVP:1` bzw. `OVP:0` setzen den **Spannungswert** auf 1 V bzw. 0 V – ein/aus nur mit `ON`/`OFF`.
- `OCP:ON` wird über die Schnittstelle nicht wirksam (Test: OCP 0,2 A, 0,5 A Last – kein Abschalten).
  Den Überstromschutz am Gerät aktivieren (OCP kurz drücken, dann ON/OFF).
- Die Strommessung zeigt 1 mA als `00.000` an.

## Dateien

- `index.html` – Oberfläche
- `style.css` – Gestaltung (helles/dunkles Farbschema)
- `kwr103.js` – Treiber: serielle Verbindung, Befehlswarteschlange, Byte-Auswertung, KWR103-Befehle
- `app.js` – UI-Logik, Messschleife, Lade-Ablauf, Messdateien
- `plot.js`, `runs.js` – Diagramme und Messdateien (aus KEL103-Web übernommen)

Hersteller-PDFs im Ordner sind per `.gitignore` vom Repository ausgeschlossen.
