/* Vorlagen für den Wochenplan
 *
 * Vorschläge als Startpunkt, keine Verordnung. Beim Anlegen eines Zyklus wird
 * eine Vorlage kopiert; danach lässt sich alles frei ändern, die Vorlage selbst
 * bleibt unberührt.
 *
 * Grundlage (Stand Oktober 2026), zusammengefasst:
 * - 3 Aufbauwochen + 1 Entlastungswoche (Deload, Umfang −30 bis −50 %, ohne
 *   Fingerboard, Limit-Bouldern und Campus).
 * - Höchstens zwei harte Fingereinheiten pro Woche, mit 48 h Abstand.
 * - Fingerboard erst nach ein bis zwei Jahren regelmäßigem Klettern; im ersten
 *   Jahr trainiert das Bouldern selbst die Finger genug.
 * - Max Hangs zu Beginn der Einheit, nach gründlichem Aufwärmen, ca. 10 s,
 *   3–5 min Pause.
 * - Ausgleichstraining (Drücken, Schulter-Außenrotation, Fingerstrecker)
 *   gehört in jeden Plan.
 *
 * days: Wochentage, 0 = Montag … 6 = Sonntag
 * intensity: im selben Maß wie die eigenen Übungen; die Wochenziele werden
 *   daraus berechnet (siehe templateTargets in app.js).
 * minutes: ungefähre Dauer – gilt, wenn der Zyklus in Minuten oder Stunden
 *   zählt.
 */
const PLAN_TEMPLATES = [
  {
    id: 'einsteiger',
    name: 'Einsteiger · 2× pro Woche',
    level: 'Erstes Kletterjahr. Ohne Fingerboard.',
    weeks: 8,
    exercises: [
      {
        name: 'Technik-Bouldern',
        categories: ['Technik'],
        intensity: 3,
        minutes: 75,
        days: [0],
        desc: '15 min locker einklettern. Dann 8–10 Boulder deutlich unter deinem Limit: leise Füße, Hüfte nah an der Wand, Züge vorher lesen. 2–3 min Pause.'
      },
      {
        name: 'Projekt-Bouldern',
        categories: ['Kraft'],
        intensity: 3,
        minutes: 75,
        days: [3],
        desc: 'Gut aufwärmen, steigernd. Dann 3–4 Boulder an deiner Grenze, je höchstens 4–5 Versuche, 3 min Pause. Aufhören, wenn die Züge unsauber werden. Deload-Woche: nur Technik.'
      },
      {
        name: 'Ausgleich: Drücken & Schulter',
        categories: ['Ausgleich'],
        intensity: 1,
        minutes: 15,
        days: [0],
        desc: '2–3 Runden: 10–15 Liegestütze, 10–15 Außenrotation mit Band, 15 Reverse Wrist Curls (Fingerstrecker).'
      },
      {
        name: 'Rumpf',
        categories: ['Rumpf'],
        intensity: 1,
        minutes: 10,
        days: [3],
        desc: '3 Runden: 30–45 s Unterarmstütz, 8–12 Knieheben im Hang.'
      }
    ]
  },
  {
    id: 'fortgeschritten',
    name: 'Fortgeschritten · 3× pro Woche',
    level: 'Ab etwa einem Jahr regelmäßigem Bouldern.',
    weeks: 12,
    exercises: [
      {
        name: 'Limit-Bouldern',
        categories: ['Kraft', 'Finger'],
        intensity: 3,
        minutes: 90,
        days: [0],
        desc: '20–30 min steigernd aufwärmen. Dann 2–3 Projekte in verschiedenen Stilen, je 20–30 min, 3–5 min Pause zwischen Versuchen. Deload-Woche: weglassen.'
      },
      {
        name: 'Volumen & Technik',
        categories: ['Technik', 'Ausdauer'],
        intensity: 2.5,
        minutes: 75,
        days: [2],
        desc: 'Viele Boulder 2–3 Grade unter Limit, kurze Pausen. Jede Woche einen Stil bewusst üben: Platte, Dach, Kante, Volumen.'
      },
      {
        name: 'Boardklettern',
        categories: ['Kraft', 'Finger'],
        intensity: 3,
        minutes: 90,
        days: [4],
        desc: 'Kilter- oder Moonboard: aufwärmen, dann 6–10 harte Boulder mit vollen Pausen. Höchstens 90 min. Deload-Woche: leichte Boulder.'
      },
      {
        name: 'Klimmzüge & Rumpf',
        categories: ['Pull', 'Rumpf'],
        intensity: 1.5,
        minutes: 20,
        days: [2],
        desc: '4 × 5 Klimmzüge (wenn leicht: mit Zusatzgewicht), 3 × 10 Knieheben im Hang.'
      },
      {
        name: 'Ausgleich: Drücken & Schulter',
        categories: ['Ausgleich'],
        intensity: 1,
        minutes: 15,
        days: [0, 4],
        desc: '2 Runden: 10–15 Liegestütze oder Dips, 10 Schulterdrücken, 10–15 Außenrotation mit Band, 15 Reverse Wrist Curls.'
      }
    ]
  },
  {
    id: 'fingerkraft',
    name: 'Fingerkraft-Block · 3× pro Woche',
    level: 'Ab etwa zwei Jahren Klettern, verletzungsfrei. Mit Fingerboard.',
    weeks: 12,
    exercises: [
      {
        name: 'Fingerboard',
        categories: ['Finger'],
        intensity: 2,
        minutes: 30,
        days: [0, 4],
        desc: 'Immer zu Beginn, nach 20 min Aufwärmen, halb aufgestellt. Wo 1–3: 7 s hängen / 3 s Pause × 6, 3–4 Sätze, 3 min Satzpause, 20 mm, ohne Gewicht. Wo 5–7 und 9–11: Max Hangs 10 s, 5 Sätze, 3 min Pause, Gewicht so, dass 2–3 s Reserve bleiben. Deload-Woche und bei Fingerschmerz: weglassen.'
      },
      {
        name: 'Limit-Bouldern',
        categories: ['Kraft'],
        intensity: 2.5,
        minutes: 75,
        days: [0],
        desc: 'Nach dem Fingerboard: 2–3 Projekte, je 20–30 min, 3–5 min Pause. Deload-Woche: weglassen.'
      },
      {
        name: 'Volumen & Technik',
        categories: ['Technik', 'Ausdauer'],
        intensity: 2.5,
        minutes: 75,
        days: [2],
        desc: 'Viele Boulder 2–3 Grade unter Limit, kurze Pausen. Lockerer Tag für die Finger.'
      },
      {
        name: 'Board & Power',
        categories: ['Kraft', 'Power'],
        intensity: 2.5,
        minutes: 75,
        days: [4],
        desc: 'Wo 1–7: harte Board-Boulder, volle Pausen. Wo 9–11: dynamische Züge und Sprünge; Campus nur mit Erfahrung, 3–5 Leitern, volle Pausen. Deload-Woche: leichte Boulder.'
      },
      {
        name: 'Ausgleich & Klimmzüge',
        categories: ['Ausgleich', 'Pull'],
        intensity: 1.5,
        minutes: 25,
        days: [2],
        desc: '4 × 5 Klimmzüge, dazu 2 Runden Liegestütze, Außenrotation mit Band, Reverse Wrist Curls.'
      }
    ]
  }
];
