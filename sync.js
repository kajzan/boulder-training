/* Abgleich-Modell
 *
 * Die App arbeitet mit einem einzigen Objekt (appData). Für den Abgleich
 * zwischen Geräten wird es hier in einzelne Einträge zerlegt: je Zyklus,
 * Übung, abgehakter Übung an einem Tag, Test und Messung, dazu ein Eintrag
 * für die Einstellungen. Haben zwei Geräte offline Verschiedenes geändert,
 * treffen ihre Änderungen verschiedene Einträge und fügen sich zusammen. Nur
 * wenn beide denselben Eintrag ändern, gewinnt der spätere.
 *
 * Dieser Teil kennt keinen Anbieter, nur Schlüssel und Daten. Die Anbindung
 * an Firebase baut darauf auf.
 *
 * Schlüssel, zugleich als Dokument-ID in Firestore verwendbar:
 *   settings:app
 *   cycle:<zyklus>
 *   exercise:<zyklus>:<übung>
 *   entry:<zyklus>:<datum>:<übung>
 *   test:<test>
 *   assessment:<messung>
 *
 * Neue Felder auf oberster Ebene von appData müssen hier ergänzt werden,
 * sonst gehen sie beim Abgleich verloren. Der Hin-und-zurück-Test in
 * tests/run.js schlägt dann an.
 */

const SYNC_TYPES = new Set(['settings', 'cycle', 'exercise', 'entry', 'test', 'assessment']);

// IDs werden kodiert eingesetzt: Ein ':' oder '/' in eingelesenen Altdaten
// könnte sonst Schlüssel vermischen oder in Firestore einen Pfad aufspalten.
function syncKey(type, ...parts) {
  return [type].concat(parts.map(p => encodeURIComponent(String(p)))).join(':');
}

function syncKeyType(key) {
  const i = key.indexOf(':');
  return i < 0 ? key : key.slice(0, i);
}

// Löst die Daten vom App-Objekt, damit spätere Änderungen dort die Dokumente
// nicht mitverändern, und entfernt undefined – Firestore lehnt es ab.
function syncClean(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// Vergleichbare Darstellung, unabhängig von der Reihenfolge der Felder.
// Firestore liefert Felder nicht unbedingt so geordnet zurück, wie sie
// geschrieben wurden; ein einfacher Textvergleich sähe dann Änderungen, wo
// keine sind, und löste unnötige Schreibvorgänge aus.
function syncCanon(value) {
  if (Array.isArray(value)) return '[' + value.map(syncCanon).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map(k => JSON.stringify(k) + ':' + syncCanon(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function syncCmp(a, b) {
  const x = String(a), y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// ── appData → Einträge ──
function toDocs(data) {
  const docs = {};
  docs[syncKey('settings', 'app')] = { activeCycleId: data.activeCycleId ?? null };

  (data.cycles || []).forEach(cycle => {
    const { exercises, sessions, ...rest } = cycle;
    const exList = Array.isArray(exercises) ? exercises : [];

    // Die Reihenfolge der Übungen steht am Zyklus, nicht an den Übungen:
    // Umsortieren ändert so genau einen Eintrag statt alle.
    docs[syncKey('cycle', cycle.id)] = syncClean(Object.assign({}, rest, {
      exerciseOrder: exList.map(ex => ex.id)
    }));

    exList.forEach(ex => {
      docs[syncKey('exercise', cycle.id, ex.id)] =
        syncClean(Object.assign({}, ex, { cycleId: cycle.id }));
    });

    // Jede abgehakte Übung ist ein eigener Eintrag. Hakt man an zwei Geräten
    // am selben Tag Verschiedenes ab, bleibt so beides erhalten.
    Object.keys(sessions || {}).forEach(date => {
      (sessions[date] || []).forEach(raw => {
        const entry = typeof raw === 'string' ? { exId: raw } : raw;
        if (!entry || entry.exId === undefined || entry.exId === null) return;
        docs[syncKey('entry', cycle.id, date, entry.exId)] =
          syncClean(Object.assign({}, entry, { cycleId: cycle.id, date }));
      });
    });
  });

  (data.tests || []).forEach(t => { docs[syncKey('test', t.id)] = syncClean(t); });
  (data.assessments || []).forEach(a => { docs[syncKey('assessment', a.id)] = syncClean(a); });
  return docs;
}

// ── Einträge → appData ──
//
// Zyklen, Tests und Messungen werden nach ihrer ID geordnet. Die IDs beruhen
// auf dem Anlegezeitpunkt, die Reihenfolge entspricht also der bisherigen.
// Eine gespeicherte Position würde beim Löschen alle späteren Einträge
// verändern und damit unbeteiligte Einträge in Konflikte ziehen.
//
// Übungen ohne Zyklus (der Zyklus wurde auf einem anderen Gerät gelöscht,
// während hier offline eine Übung dazukam) fallen weg. Beim nächsten
// Abgleich werden sie dadurch auch aus dem Speicher entfernt.
function fromDocs(docs) {
  const data = { cycles: [], activeCycleId: null, tests: [], assessments: [] };
  const cycles = [];
  const exercisesByCycle = new Map();
  const entriesByCycle = new Map();
  const listFor = (map, id) => {
    const k = String(id);
    if (!map.has(k)) map.set(k, []);
    return map.get(k);
  };

  Object.keys(docs).forEach(key => {
    const d = syncClean(docs[key]);
    if (!d) return;
    switch (syncKeyType(key)) {
      case 'settings':
        data.activeCycleId = d.activeCycleId ?? null;
        break;
      case 'cycle':
        cycles.push(d);
        break;
      case 'exercise': {
        const { cycleId, ...ex } = d;
        listFor(exercisesByCycle, cycleId).push(ex);
        break;
      }
      case 'entry':
        listFor(entriesByCycle, d.cycleId).push(d);
        break;
      case 'test':
        data.tests.push(d);
        break;
      case 'assessment':
        data.assessments.push(d);
        break;
      // Unbekannte Arten stammen von einer neueren App-Version. Sie haben hier
      // keinen Platz, werden aber auch nicht gelöscht (siehe diffDocs).
    }
  });

  cycles.sort((a, b) => syncCmp(a.id, b.id)).forEach(cycle => {
    const { exerciseOrder, ...rest } = cycle;
    const pool = new Map((exercisesByCycle.get(String(cycle.id)) || [])
      .map(ex => [String(ex.id), ex]));

    const exercises = [];
    (Array.isArray(exerciseOrder) ? exerciseOrder : []).forEach(id => {
      const ex = pool.get(String(id));
      if (ex) { exercises.push(ex); pool.delete(String(id)); }
    });
    // Übungen, die in der Reihenfolge fehlen – etwa weil ein anderes Gerät
    // sie gleichzeitig angelegt hat –, gehen nicht verloren, sondern kommen
    // ans Ende.
    Array.from(pool.values()).sort((a, b) => syncCmp(a.id, b.id))
      .forEach(ex => exercises.push(ex));

    // Abgehakte Übungen eines Tages in der Reihenfolge des Trainingsplans
    const rank = new Map(exercises.map((ex, i) => [String(ex.id), i]));
    const rankOf = e => rank.has(String(e.exId)) ? rank.get(String(e.exId)) : exercises.length;
    const sessions = {};
    (entriesByCycle.get(String(cycle.id)) || [])
      .sort((a, b) => syncCmp(a.date, b.date) || rankOf(a) - rankOf(b) || syncCmp(a.exId, b.exId))
      .forEach(e => {
        const { cycleId, date, ...entry } = e;
        if (!sessions[date]) sessions[date] = [];
        sessions[date].push(entry);
      });

    data.cycles.push(Object.assign({}, rest, { exercises, sessions }));
  });

  data.tests.sort((a, b) => syncCmp(a.id, b.id));
  data.assessments.sort((a, b) => syncCmp(a.id, b.id));
  return data;
}

// ── Änderungen zwischen zwei Ständen ──
//
// Ergibt nur, was sich wirklich geändert hat. Ein Gerät schreibt damit nie
// seinen ganzen Stand, sondern nur seine eigenen Änderungen – deshalb holt es
// auch nichts zurück, was ein anderes Gerät inzwischen gelöscht hat.
//
// Einträge unbekannter Art werden nie gelöscht. Eine ältere App-Version, die
// sie nicht kennt, würde sie sonst bei jedem Abgleich entfernen.
function diffDocs(prev, next) {
  const set = {};
  const del = [];
  Object.keys(next).forEach(k => {
    if (!Object.prototype.hasOwnProperty.call(prev, k) ||
        syncCanon(prev[k]) !== syncCanon(next[k])) {
      set[k] = next[k];
    }
  });
  Object.keys(prev).forEach(k => {
    if (!Object.prototype.hasOwnProperty.call(next, k) && SYNC_TYPES.has(syncKeyType(k))) {
      del.push(k);
    }
  });
  return { set, del };
}

function applyDiff(docs, diff) {
  const out = Object.assign({}, docs);
  diff.del.forEach(k => { delete out[k]; });
  Object.keys(diff.set).forEach(k => { out[k] = diff.set[k]; });
  return out;
}

function isEmptyDiff(diff) {
  return diff.del.length === 0 && Object.keys(diff.set).length === 0;
}

// Ob ein Stand echte Trainingsdaten enthält. Der Einstellungs-Eintrag allein
// zählt nicht – den hat auch eine frisch installierte App.
function hasUserData(docs) {
  return Object.keys(docs).some(k => {
    const t = syncKeyType(k);
    return SYNC_TYPES.has(t) && t !== 'settings';
  });
}

// ── Abgleich planen ──
//
// Beide Funktionen entscheiden nur, was herauskommt und was geschrieben
// werden muss. Sie fassen weder Netz noch Speicher an und lassen sich so ohne
// Server prüfen.

// Dieses Gerät verbindet sich zum ersten Mal mit dem Konto.
// merge: Sind auf dem Gerät und im Konto schon Daten, werden sie
// zusammengeführt (true) oder es gelten nur die Daten des Kontos (false).
function planFirstLink(localDocs, serverDocs, merge) {
  if (!hasUserData(serverDocs)) {
    // Neues Konto: alles von diesem Gerät übernehmen
    return { result: localDocs, push: diffDocs(serverDocs, localDocs) };
  }
  if (!hasUserData(localDocs) || !merge) {
    return { result: serverDocs, push: { set: {}, del: [] } };
  }
  // Zusammenführen: was nur hier existiert, kommt dazu. Bei gleichem Eintrag
  // gilt das Konto, denn dort liegt der gemeinsame Stand aller Geräte.
  const result = Object.assign({}, localDocs, serverDocs);
  return { result, push: diffDocs(serverDocs, result) };
}

// Normaler Abgleich mit dem Konto: base ist der letzte gemeinsame Stand, den
// dieses Gerät kennt. Was sich hier seitdem geändert hat, wird geschrieben und
// gewinnt beim selben Eintrag – es ist die jüngere Absicht. Alles andere kommt
// vom Konto.
function planSync(base, localDocs, serverDocs) {
  const mine = diffDocs(base, localDocs);
  return { result: applyDiff(serverDocs, mine), push: mine };
}
