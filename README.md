# boulder-training

Trainingsplanung und Leistungsverfolgung. Läuft als Web-App unter
https://kajzan.github.io/boulder-training/ und lässt sich auf dem Homescreen
installieren. Ohne Konto bleiben alle Daten auf dem Gerät (localStorage); mit
Konto werden sie zusätzlich zwischen Geräten abgeglichen (siehe unten).

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html` | Grundgerüst der Seite |
| `styles.css` | Gestaltung |
| `app.js` | die gesamte Logik |
| `templates.js` | Vorlagen für den Wochenplan – hier lassen sich die Pläne anpassen |
| `sync.js` | Abgleich-Modell: zerlegt die Daten in Einträge und führt Stände zusammen |
| `cloud.js` | Konto und Synchronisation über Firebase |
| `vendor/firebase.js` | Firebase-Bibliothek, gebündelt und lokal statt vom Google-Server |
| `firestore.rules` | Sicherheitsregeln – in der Firebase-Konsole eintragen, siehe unten |
| `firebase.json` | nur für den lokalen Firebase-Emulator in den Browsertests |
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

Diese Zahl **nach jeder Änderung** an `index.html`, `styles.css` oder einer
der `.js`-Dateien
erhöhen (`v2`, `v3`, …) und mit committen. Sonst behalten bereits installierte
Geräte unter Umständen den alten Stand, weil sie ihre gespeicherte Fassung für
aktuell halten.

## Vorlagen anpassen

Die Wochenplan-Vorlagen stehen in `templates.js`: je Vorlage Name, Zielgruppe,
Wochenzahl und die Übungen mit Kategorien, Intensität, Wochentagen
(0 = Montag) und Beschreibung. Die Wochenziele berechnet die App daraus im
Rhythmus drei Aufbauwochen + eine Entlastungswoche. Änderungen wirken nur auf
neu angelegte Zyklen.

## Tests

```sh
node tests/run.js
```

Die App ist bewusst ohne Framework und ohne Build-Schritt gebaut. Der Testlauf
lädt `app.js` in Node und stellt die paar Browser-Bausteine nach, die sie
braucht – siehe `tests/harness.js`. Keine Abhängigkeiten nötig.

## Konto und Synchronisation

Ohne Anmeldung bleibt alles auf dem Gerät. Mit einem Konto (E-Mail und
Passwort) liegen die Daten zusätzlich in Firebase (Projekt `boulder-training`,
Standort Frankfurt) und werden zwischen Geräten abgeglichen, auch nach
Offline-Phasen.

Abgeglichen wird erst nach bestätigter E-Mail-Adresse. In Firestore liegen
die Daten gebündelt: ein Dokument je Zyklus, eines je Logbuch-Jahr und eines
für Tests, Messungen und Einstellungen (siehe `sync.js`, Abschnitt „Ablage in Firestore"). Das hält die
Lesekosten klein, weil Firestore nach über 30 Minuten Pause jedes Dokument neu
berechnet.

Die Links in den Mails (Adresse bestätigen, Passwort zurücksetzen) führen auf
die App selbst, die sie im eigenen Design abschließt (`cloud.js`, Abschnitt
„Link aus der Mail"). Dafür steht in der Firebase-Konsole unter
Authentication → Vorlagen bei jeder Vorlage als Aktions-URL
`https://kajzan.github.io/boulder-training/`. Den Text der Mails selbst lässt
Firebase nicht frei gestalten; ganz eigene Mails bräuchten den Blaze-Tarif und
einen Maildienst.

Die Sicherheitsregeln stehen in `firestore.rules`. Sie werden **nicht**
automatisch übernommen: Nach jeder Änderung den Inhalt in der Firebase-Konsole
unter Firestore → Regeln einfügen und veröffentlichen.

Browsertests (optional, brauchen `playwright` und für den Abgleich zusätzlich
`firebase-tools` mit Java):

```sh
node tests/browser/smoke.js
firebase emulators:exec --project demo-boulder --only auth,firestore "node tests/browser/sync-e2e.js"
```

Der zweite Test läuft gegen einen lokalen Emulator; das echte Projekt wird
dabei nicht berührt.

## Datensicherung

Einstellungen → **Daten exportieren** schreibt alles in eine JSON-Datei.
Ohne Konto ist das die einzige Sicherung – Browser räumen ihren Speicher
gelegentlich auf. Mit Konto liegen die Daten zusätzlich in Firebase. Vor größeren Änderungen und ab und zu zwischendurch
exportieren.

## Vor der Veröffentlichung

Solange nur der Eigentümer die App nutzt, dürfen Änderungen direkt auf `main`
landen (ohne Pull Request). **Vor einer Veröffentlichung diese Erlaubnis
widerrufen** und wieder über Pull Requests arbeiten, damit keine fehlerhafte
Änderung ungeprüft live geht. Am besten zusätzlich in GitHub unter
Settings → Branches eine Schutzregel für `main` anlegen.

Außerdem vor der Veröffentlichung: Impressum und Datenschutzerklärung,
Schutz der offenen Registrierung (z.B. App Check), Kostenrahmen in Firebase.
