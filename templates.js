/* Vorlagen für die Planung
 *
 * Vorschläge als Startpunkt, keine Verordnung. Beim Übernehmen werden Übungen
 * und Wochen in den Zyklus kopiert; danach lässt sich alles frei ändern, die
 * Vorlage selbst bleibt unberührt.
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
 * Aufbau:
 *   exercises  die Übungen der Vorlage; intensity in Punkten. Zählt ein
 *              Zyklus in Zeit, gilt: 2 Punkte = 1 Stunde (aufgerundet auf
 *              halbe Stunden).
 *   plan       die Wochen der Vorlage. items: [Übung, Tage (0 = Montag),
 *              Wert (optional, sonst der der Übung), Hinweis (optional)]
 *              applies: 'rest' = alle übrigen Wochen, { every: 4 } = jede
 *              4. Woche, [0, 1, 2] = genau diese (0 = Woche 1)
 */
const PLAN_TEMPLATES = [
  {
    id: 'einsteiger',
    name: 'Einsteiger · 2× pro Woche',
    level: 'Erstes Kletterjahr. Ohne Fingerboard.',
    weeks: 8,
    exercises: [
      { key: 'technik', name: 'Technik-Bouldern', categories: ['Technik'], intensity: 3,
        desc: '15 min locker einklettern. Dann 8–10 Boulder deutlich unter deinem Limit: leise Füße, Hüfte nah an der Wand, Züge vorher lesen. 2–3 min Pause.' },
      { key: 'projekt', name: 'Projekt-Bouldern', categories: ['Kraft'], intensity: 3,
        desc: 'Gut aufwärmen, steigernd. Dann 3–4 Boulder an deiner Grenze, je höchstens 4–5 Versuche, 3 min Pause. Aufhören, wenn die Züge unsauber werden.' },
      { key: 'ausgleich', name: 'Ausgleich: Drücken & Schulter', categories: ['Ausgleich'], intensity: 1,
        desc: '2–3 Runden: 10–15 Liegestütze, 10–15 Außenrotation mit Band, 15 Reverse Wrist Curls (Fingerstrecker).' },
      { key: 'rumpf', name: 'Rumpf', categories: ['Rumpf'], intensity: 1,
        desc: '3 Runden: 30–45 s Unterarmstütz, 8–12 Knieheben im Hang.' }
    ],
    plan: [
      { name: 'Aufbauwoche', applies: 'rest', items: [
        ['technik', [0]], ['ausgleich', [0]], ['projekt', [3]], ['rumpf', [3]]
      ] },
      { name: 'Entlastungswoche', applies: { every: 4 }, items: [
        ['technik', [0, 3], 2, 'Locker, nichts an der Grenze.'], ['ausgleich', [0]], ['rumpf', [3]]
      ] }
    ]
  },
  {
    id: 'fortgeschritten',
    name: 'Fortgeschritten · 3× pro Woche',
    level: 'Ab etwa einem Jahr regelmäßigem Bouldern.',
    weeks: 12,
    exercises: [
      { key: 'limit', name: 'Limit-Bouldern', categories: ['Kraft', 'Finger'], intensity: 3,
        desc: '20–30 min steigernd aufwärmen. Dann 2–3 Projekte in verschiedenen Stilen, je 20–30 min, 3–5 min Pause zwischen Versuchen.' },
      { key: 'volumen', name: 'Volumen & Technik', categories: ['Technik', 'Ausdauer'], intensity: 2.5,
        desc: 'Viele Boulder 2–3 Grade unter Limit, kurze Pausen. Jede Woche einen Stil bewusst üben: Platte, Dach, Kante, Volumen.' },
      { key: 'board', name: 'Boardklettern', categories: ['Kraft', 'Finger'], intensity: 3,
        desc: 'Kilter- oder Moonboard: aufwärmen, dann 6–10 harte Boulder mit vollen Pausen. Höchstens 90 min.' },
      { key: 'klimmzug', name: 'Klimmzüge & Rumpf', categories: ['Pull', 'Rumpf'], intensity: 1.5,
        desc: '4 × 5 Klimmzüge (wenn leicht: mit Zusatzgewicht), 3 × 10 Knieheben im Hang.' },
      { key: 'ausgleich', name: 'Ausgleich: Drücken & Schulter', categories: ['Ausgleich'], intensity: 1,
        desc: '2 Runden: 10–15 Liegestütze oder Dips, 10 Schulterdrücken, 10–15 Außenrotation mit Band, 15 Reverse Wrist Curls.' }
    ],
    plan: [
      { name: 'Aufbauwoche', applies: 'rest', items: [
        ['limit', [0]], ['ausgleich', [0, 4]], ['volumen', [2]], ['klimmzug', [2]], ['board', [4]]
      ] },
      { name: 'Entlastungswoche', applies: { every: 4 }, items: [
        ['volumen', [0, 4], 2, 'Locker, kein Limit.'], ['ausgleich', [0, 4]], ['klimmzug', [2], 1, 'Halbe Sätze.']
      ] }
    ]
  },
  {
    id: 'fingerkraft',
    name: 'Fingerkraft-Block · 3× pro Woche',
    level: 'Ab etwa zwei Jahren Klettern, verletzungsfrei. Mit Fingerboard.',
    weeks: 12,
    exercises: [
      { key: 'fingerboard', name: 'Fingerboard', categories: ['Finger'], intensity: 2,
        desc: 'Immer zu Beginn, nach 20 min Aufwärmen, halb aufgestellt. Bei Fingerschmerz sofort aufhören.' },
      { key: 'limit', name: 'Limit-Bouldern', categories: ['Kraft'], intensity: 2.5,
        desc: 'Nach dem Fingerboard: 2–3 Projekte, je 20–30 min, 3–5 min Pause.' },
      { key: 'volumen', name: 'Volumen & Technik', categories: ['Technik', 'Ausdauer'], intensity: 2.5,
        desc: 'Viele Boulder 2–3 Grade unter Limit, kurze Pausen. Lockerer Tag für die Finger.' },
      { key: 'power', name: 'Board & Power', categories: ['Kraft', 'Power'], intensity: 2.5,
        desc: 'Harte Board-Boulder mit vollen Pausen.' },
      { key: 'ausgleich', name: 'Ausgleich & Klimmzüge', categories: ['Ausgleich', 'Pull'], intensity: 1.5,
        desc: '4 × 5 Klimmzüge, dazu 2 Runden Liegestütze, Außenrotation mit Band, Reverse Wrist Curls.' }
    ],
    plan: [
      { name: 'Basis', applies: [0, 1, 2], items: [
        ['fingerboard', [0, 4], null, 'Repeaters: 7 s hängen / 3 s Pause × 6, 3–4 Sätze, 3 min Satzpause, 20 mm, ohne Gewicht.'],
        ['limit', [0]], ['volumen', [2]], ['ausgleich', [2]], ['power', [4]]
      ] },
      { name: 'Maximalkraft', applies: [4, 5, 6], items: [
        ['fingerboard', [0, 4], null, 'Max Hangs: 10 s, 5 Sätze, 3 min Pause. Gewicht so, dass 2–3 s Reserve bleiben.'],
        ['limit', [0]], ['volumen', [2]], ['ausgleich', [2]], ['power', [4]]
      ] },
      { name: 'Power', applies: 'rest', items: [
        ['fingerboard', [0], 1.5, 'Max Hangs 7 s, 4 Sätze – kürzer, dafür etwas mehr Gewicht.'],
        ['limit', [0]], ['volumen', [2]], ['ausgleich', [2]],
        ['power', [4], null, 'Dynamische Züge und Sprünge; Campus nur mit Erfahrung, 3–5 Leitern, volle Pausen.']
      ] },
      { name: 'Entlastungswoche', applies: { every: 4 }, items: [
        ['volumen', [0, 4], 2, 'Locker, kein Fingerboard, kein Limit.'], ['ausgleich', [2], 1]
      ] }
    ]
  }
];
