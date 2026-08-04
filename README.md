# boulder-training

Trainingsplanung und Leistungsverfolgung. Läuft als Web-App unter
https://kajzan.github.io/boulder-training/ und lässt sich auf dem Homescreen
installieren. Alle Daten bleiben auf dem Gerät (localStorage), es gibt keinen
Server und kein Konto.

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html` | Grundgerüst der Seite |
| `styles.css` | Gestaltung |
| `app.js` | die gesamte Logik |
| `sw.js` | Service Worker – macht die App offline nutzbar |
| `manifest.json` | macht die App installierbar |
| `assets/fonts/` | Schriften, lokal statt von Google |
| `assets/icons/` | App-Icons |
| `tests/` | Testlauf, siehe unten |

## ⚠️ Nach jeder Änderung: Version hochzählen

In `sw.js` steht oben:

```js
const VERSION = 'v1';
```

Diese Zahl **nach jeder Änderung** an `index.html`, `styles.css` oder `app.js`
erhöhen (`v2`, `v3`, …) und mit committen. Sonst behalten bereits installierte
Geräte unter Umständen den alten Stand, weil sie ihre gespeicherte Fassung für
aktuell halten.

## Tests

```sh
node tests/run.js
```

Die App ist bewusst ohne Framework und ohne Build-Schritt gebaut. Der Testlauf
lädt `app.js` in Node und stellt die paar Browser-Bausteine nach, die sie
braucht – siehe `tests/harness.js`. Keine Abhängigkeiten nötig.

## Datensicherung

Einstellungen → **Daten exportieren** schreibt alles in eine JSON-Datei.
Das ist die einzige Sicherung, die es gibt – Browser räumen ihren Speicher
gelegentlich auf. Vor größeren Änderungen und ab und zu zwischendurch
exportieren.
