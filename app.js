// ═══════════════════════════════════════════════
// DATA LAYER
// ═══════════════════════════════════════════════
const STORE_KEY = 'boulderApp_v2';

function loadData() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch(e) {}
  return getDefaultData();
}

function saveData() {
  localStorage.setItem(STORE_KEY, JSON.stringify(appData));
  // Angemeldet: geänderte Einträge ans Konto übertragen (cloud.js)
  if (typeof window !== 'undefined' && window.cloudAfterSave) window.cloudAfterSave();
}

// Für den Abgleich (cloud.js): appData ist eine Variable dieses Skripts und
// von außen nur über diese beiden Funktionen erreichbar.
function getAppData() {
  return appData;
}

// Übernimmt einen Stand, der von einem anderen Gerät kam. Bewusst ohne
// saveData(): Der Stand stammt ja schon vom Konto und muss nicht zurück.
function replaceAppData(data) {
  if (!Array.isArray(data.ascents)) data.ascents = [];
  if (!Array.isArray(data.weekLibrary)) data.weekLibrary = [];
  appData = data;
  localStorage.setItem(STORE_KEY, JSON.stringify(appData));
  render();
}

function getDefaultData() {
  return {
    cycles: [],
    activeCycleId: null,
    tests: [],        // [{id, name, kind, unit, scaleId, higherIsBetter, usesBodyweight, category}]
    assessments: [],  // [{id, date, label, cycleId, bodyweight, results:[{testId, value, note}]}]
    ascents: [],      // Logbuch: [{id, date, scaleId, grade, style, place, name?, note?}]
    weekLibrary: []   // Repertoire gespeicherter Wochen, siehe planning.js
  };
}

function getDefaultCycle(name, weeks) {
  const now = new Date();
  const w = parseInt(weeks) > 0 ? parseInt(weeks) : 12;
  return {
    id: Date.now().toString(),
    name: name || 'Zyklus 1',
    startDate: toDateStr(now),
    weeks: w,
    exercises: [], // [{id, name, intensity}]
    weekTargets: Array(w).fill(0), // [9,10,11,...] per week
    sessions: {}, // { "YYYY-MM-DD": [exerciseId, ...] }
    notes: {}
  };
}

// Migration: ensure all existing cycles have a 'weeks' property
function migrateCycles(d = appData) {
  let changed = false;
  d.cycles.forEach(c => {
    if (typeof c.weeks !== 'number' || c.weeks < 1) {
      c.weeks = 12;
      changed = true;
    }
    // Ensure weekTargets matches weeks length
    if (!Array.isArray(c.weekTargets)) c.weekTargets = [];
    while (c.weekTargets.length < c.weeks) c.weekTargets.push(0);
    if (c.weekTargets.length > c.weeks) c.weekTargets = c.weekTargets.slice(0, c.weeks);

    // Trainingstage standen früher an den Übungen; jetzt in Wochen (planning.js)
    if (migratePlanDays(c)) changed = true;

    // Pausen wurden anfangs in ganzen Wochen gezählt; jetzt in Tagen
    if (Array.isArray(c.pausedWeeks) || Number.isInteger(c.pausedSince)) {
      const weekStart = o => addDays(c.startDate, o * 7);
      c.pauses = (c.pauses || []).concat((c.pausedWeeks || []).filter(Number.isInteger)
        .map(o => ({ from: weekStart(o), to: addDays(weekStart(o), 6) })));
      if (!c.pauses.length) delete c.pauses;
      if (Number.isInteger(c.pausedSince) && !c.pausedAt) c.pausedAt = weekStart(c.pausedSince);
      delete c.pausedWeeks;
      delete c.pausedSince;
      changed = true;
    }

    // Migrate exercises from a single category string to a list of categories.
    // Eine Übung wie eine Campus-Board-Session trainiert mehreres zugleich.
    (c.exercises || []).forEach(ex => {
      if (!Array.isArray(ex.categories)) {
        const single = (ex.category || '').trim();
        ex.categories = single ? [single] : [];
        changed = true;
      }
      if (ex.category !== undefined) { delete ex.category; changed = true; }
    });

    // Migrate sessions from ['id', 'id'] to [{exId: 'id'}, ...]
    if (c.sessions && typeof c.sessions === 'object') {
      Object.keys(c.sessions).forEach(day => {
        const arr = c.sessions[day];
        if (Array.isArray(arr)) {
          let needsMigration = false;
          for (const item of arr) {
            if (typeof item === 'string') { needsMigration = true; break; }
          }
          if (needsMigration) {
            c.sessions[day] = arr.map(item =>
              typeof item === 'string' ? { exId: item } : item
            );
            changed = true;
          }
        }
      });
    }
  });
  if (changed && d === appData) saveData();
  return changed;
}

// Zahl aus einer Eingabe – auch mit deutschem Komma ("4,5")
function parseNum(v) {
  return parseFloat(String(v === undefined || v === null ? '' : v).trim().replace(',', '.'));
}

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDate(str) {
  return new Date(str + 'T00:00:00');
}

let appData = loadData();

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════
const DAYS_DE = ['Mo','Di','Mi','Do','Fr','Sa','So'];
const DAYS_FULL = ['Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag','Sonntag'];
const MONTHS_DE = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];

// Während man im Trainingsplan einen Plan für jemand anderen bearbeitet
// (draftEditId), gilt dieser als aktiv – alle Planungsfunktionen arbeiten
// dann auf ihm. Beim Verlassen des Tabs endet das (siehe switchView).
let draftEditId = null;

function getActiveCycle() {
  if (draftEditId) {
    const draft = appData.cycles.find(c => c.id === draftEditId);
    if (draft) return draft;
    draftEditId = null;
  }
  if (!appData.activeCycleId) return null;
  return appData.cycles.find(c => c.id === appData.activeCycleId) || null;
}

// Eigene Zyklen, ohne Pläne für andere
function ownCycles() {
  return appData.cycles.filter(c => !c.forOther);
}

// ── Session entry helpers (support old format [id,id] and new [{exId, overrideInt?}]) ──
function entryId(entry) {
  return typeof entry === 'string' ? entry : entry.exId;
}
function entryOverride(entry) {
  if (typeof entry !== 'object' || entry === null) return null;
  if (entry.overrideInt === undefined || entry.overrideInt === null || entry.overrideInt === '') return null;
  const v = parseFloat(entry.overrideInt);
  return isNaN(v) ? null : v;
}
function getEffectiveIntensity(cycle, entry) {
  const ov = entryOverride(entry);
  if (ov !== null) return ov;
  const ex = cycle.exercises.find(e => e.id === entryId(entry));
  return ex ? (parseFloat(ex.intensity) || 0) : 0;
}

// ── Einheit eines Zyklus ──
// Gezählt wird wahlweise in Intensitätspunkten, Minuten oder Stunden. Die
// Werte stehen immer im Feld "intensity" – nur Beschriftung, Schrittweite
// und Toleranz hängen von der Einheit ab.
const CYCLE_UNITS = {
  int: { name: 'Intensität', title: 'Intensität', amount: 'Intensitätswert', target: 'Intensitätsziel pro Woche',
         day: 'Tages-Intensität', short: '', step: 0.5, tol: 1, placeholder: 'z.B. 2' },
  min: { name: 'Minuten', title: 'Trainingszeit', amount: 'Dauer in Minuten', target: 'Wochenziel in Minuten',
         day: 'Trainingszeit', short: 'min', step: 5, tol: 60, placeholder: 'z.B. 60' },
  h:   { name: 'Stunden', title: 'Trainingszeit', amount: 'Dauer in Stunden', target: 'Wochenziel in Stunden',
         day: 'Trainingszeit', short: 'h', step: 0.25, tol: 1, placeholder: 'z.B. 1,5' }
};

function cycleUnit(cycle) {
  return cycle && CYCLE_UNITS[cycle.unit] ? cycle.unit : 'int';
}

function unitInfo(cycle) {
  return CYCLE_UNITS[cycleUnit(cycle)];
}

// Umrechnen zwischen den Einheiten. Zwei Punkte Intensität entsprechen einer
// Stunde; beim Umrechnen in Zeit wird auf halbe Stunden aufgerundet.
function toHours(v, unit) {
  if (unit === 'h') return v;
  if (unit === 'min') return v / 60;
  return Math.ceil(v / 2 * 2) / 2;          // Intensität → Stunden, aufgerundet
}

function convertAmount(v, from, to) {
  const x = parseFloat(v) || 0;
  if (from === to) return x;
  if (to === 'int') return Math.round((from === 'min' ? x / 60 : x) * 2 * 2) / 2;
  const h = from === 'int' ? toHours(x, 'int') : (from === 'min' ? Math.ceil(x / 60 * 2) / 2 : x);
  return to === 'min' ? Math.round(h * 60) : h;
}

// Ein Wert mit Einheit: "9,5" bei Intensität, "90 min", "1,5 h"
function fmtAmount(cycle, v) {
  const u = unitInfo(cycle);
  const n = fmtNum(Math.round((parseFloat(v) || 0) * 100) / 100);
  return u.short ? n + ' ' + u.short : n;
}

// Der Wert einer Übung: "×3" bei Intensität, sonst "45 min"
function fmtExAmount(cycle, v) {
  return cycleUnit(cycle) === 'int' ? '×' + fmtNum(parseFloat(v) || 0) : fmtAmount(cycle, v);
}

// ── Categories ──
const CATEGORY_PALETTE = [
  '#2ecc71', '#4a9eff', '#c8ff00', '#ff7eb3',
  '#ffa726', '#ab47bc', '#26c6da', '#ffca28'
];

// ── Kategorien einer Übung ──
// Liste der gesetzten Kategorien, bereinigt. Kann leer sein.
function exerciseCategories(ex) {
  if (!ex || !Array.isArray(ex.categories)) return [];
  const seen = [];
  ex.categories.forEach(c => {
    const t = (c || '').trim();
    if (t && !seen.some(x => x.toLowerCase() === t.toLowerCase())) seen.push(t);
  });
  return seen;
}

// Dasselbe für die Verrechnung: ohne Kategorie zählt eine Übung auf 'Sonstige'.
function exerciseCategoryKeys(ex) {
  const list = exerciseCategories(ex);
  return list.length ? list : ['Sonstige'];
}

// Kategorien aus einem Textfeld lesen bzw. dorthin schreiben ("Pull, Finger").
function parseCategories(str) {
  const out = [];
  (str || '').split(',').forEach(part => {
    const t = part.trim();
    if (t && !out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t);
  });
  return out;
}

function formatCategories(list) {
  return (list || []).join(', ');
}

function getAllCategoriesInCycle(cycle) {
  const set = new Set();
  let hasUncategorized = false;
  (cycle.exercises || []).forEach(ex => {
    const cats = exerciseCategories(ex);
    if (cats.length) cats.forEach(c => set.add(c));
    else hasUncategorized = true;
  });
  const sorted = Array.from(set).sort((a,b) => a.localeCompare(b, 'de'));
  if (hasUncategorized) sorted.push('Sonstige');
  return sorted;
}

// ── Kategorien darstellen ──
function catLabelsHtml(cats, allCats, dotSize) {
  const s = dotSize || 13;
  return cats.map(cat =>
    `<span style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap">
      <span style="color:${categoryColor(cat, allCats)};font-size:${s}px;line-height:1">●</span>${esc(cat)}
    </span>`).join('');
}

function catDotsHtml(cats, allCats, dotSize) {
  const s = dotSize || 11;
  return cats.map(cat =>
    `<span style="color:${categoryColor(cat, allCats)};font-size:${s}px;line-height:1">●</span>`).join('');
}

function categoryColor(cat, allCats) {
  if (!cat || cat === 'Sonstige') return '#888';
  // Index excluding 'Sonstige'
  const realCats = allCats.filter(c => c !== 'Sonstige');
  const idx = realCats.indexOf(cat);
  if (idx < 0) return '#888';
  return CATEGORY_PALETTE[idx % CATEGORY_PALETTE.length];
}

function getWeekCategoryBreakdown(cycle, weekIndex) {
  const days = getWeekDates(cycle, weekIndex);
  const out = {};
  days.forEach(d => {
    const entries = cycle.sessions[d] || [];
    entries.forEach(entry => {
      const ex = cycle.exercises.find(e => e.id === entryId(entry));
      if (!ex) return;
      addSplitIntensity(out, ex, getEffectiveIntensity(cycle, entry));
    });
  });
  return out;
}

// Verteilt die Intensität einer Einheit gleichmäßig auf ihre Kategorien.
//
// Eine Campus-Board-Session mit Intensität 3 auf "Pull" und "Finger" zählt
// also 1,5 je Kategorie, nicht 3 auf beide. Sonst würde die Summe über alle
// Kategorien die tatsächlich geleistete Intensität übersteigen: Das gestapelte
// Diagramm auf der Übersicht wäre höher als der Wochenwert, gegen den es sein
// Ziel vergleicht, und dieselbe Einheit ergäbe in Diagramm und Assessment
// verschiedene Zahlen.
function addSplitIntensity(target, ex, intensity) {
  const cats = exerciseCategoryKeys(ex);
  const share = intensity / cats.length;
  cats.forEach(cat => { target[cat] = (target[cat] || 0) + share; });
}

// ── HTML escape (safe for text content and quoted attribute values) ──
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Antippbare Chips vorhandener Kategorien ──
// multi=true: jeder Chip schaltet seine Kategorie an oder aus, das Feld führt
// eine kommagetrennte Liste. multi=false: der Chip ersetzt den Inhalt (für
// Assessment-Tests, die genau eine Kategorie messen).
function buildCategoryChips(inputId, multi) {
  const cycle = getActiveCycle();
  if (!cycle) return '';
  const allCats = getAllCategoriesInCycle(cycle).filter(c => c !== 'Sonstige');
  if (allCats.length === 0) return '';
  return `<div id="chips_${inputId}" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
    ${renderCategoryChips(inputId, multi)}
  </div>`;
}

function renderCategoryChips(inputId, multi) {
  const cycle = getActiveCycle();
  if (!cycle) return '';
  const allCats = getAllCategoriesInCycle(cycle).filter(c => c !== 'Sonstige');
  const input = document.getElementById(inputId);
  const active = input ? parseCategories(input.value) : [];
  return allCats.map(cat => {
    const color = categoryColor(cat, allCats);
    const on = active.some(c => c.toLowerCase() === cat.toLowerCase());
    const fn = multi ? 'toggleCategoryChip' : 'setCategoryChip';
    return `<button type="button" data-target="${inputId}" data-cat="${esc(cat)}"
      onclick="${fn}(this.dataset.target, this.dataset.cat)"
      style="background:${on ? 'var(--accent-dim)' : 'var(--surface)'};border:1px solid ${on ? 'var(--accent)' : 'var(--border)'};border-radius:14px;padding:5px 10px;font-size:12px;color:var(--text);display:inline-flex;align-items:center;gap:5px;cursor:pointer;font-family:inherit">
      <span style="color:${color};font-size:13px;line-height:1">●</span>
      ${esc(cat)}
    </button>`;
  }).join('');
}

function toggleCategoryChip(inputId, cat) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const list = parseCategories(input.value);
  const idx = list.findIndex(c => c.toLowerCase() === cat.toLowerCase());
  if (idx >= 0) list.splice(idx, 1); else list.push(cat);
  input.value = formatCategories(list);
  refreshCategoryChips(inputId, true);
}

function setCategoryChip(inputId, cat) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.value = cat;
  refreshCategoryChips(inputId, false);
}

function refreshCategoryChips(inputId, multi) {
  const box = document.getElementById('chips_' + inputId);
  if (box) box.innerHTML = renderCategoryChips(inputId, multi);
}

// ── Pausen ──
// Ein Zyklus zählt Trainingstage, keine Kalendertage. Pausierte Tage werden
// übersprungen, alles Spätere rückt um genau so viele Tage nach hinten –
// nach vier Tagen krank geht es mit demselben Trainingstag weiter.
//
// Eine Trainingswoche sind die nächsten sieben nicht pausierten Tage. Liegt
// eine Pause mitten in einer Woche, verteilt sich die Woche eben auf mehr als
// sieben Kalendertage.
//
//   pauses    abgeschlossene Pausen: [{ from, to }] (beide Tage inklusive)
//   pausedAt  eine laufende Pause seit diesem Tag; reicht bis einschließlich
//             heute. Bis zum Fortsetzen lässt sich ab diesem Tag nichts
//             eintragen.
function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

function isCyclePaused(cycle) {
  return !!cycle && typeof cycle.pausedAt === 'string';
}

// Für den Wochenplan: Ist dieser Tag übersprungen?
function isPausedDate(cycle, dateStr, today) {
  if ((cycle.pauses || []).some(p => p && dateStr >= p.from && dateStr <= p.to)) return true;
  return isCyclePaused(cycle) && dateStr >= cycle.pausedAt && dateStr <= (today || toDateStr(new Date()));
}

// Fürs Eintragen: ab Pausenbeginn gesperrt, bis fortgesetzt wird
function isPausedDay(cycle, dateStr) {
  return isCyclePaused(cycle) && dateStr >= cycle.pausedAt;
}

// Die Kalendertage der ersten n Trainingstage. Zwischengespeichert, weil die
// Ansichten das für jede Woche abfragen.
const trainingDayCache = new Map();
function trainingDays(cycle, n) {
  const today = toDateStr(new Date());
  const key = [cycle.id, cycle.startDate, n, today, cycle.pausedAt || '', JSON.stringify(cycle.pauses || [])].join('|');
  if (trainingDayCache.has(key)) return trainingDayCache.get(key);
  const out = [];
  let d = cycle.startDate;
  for (let guard = 0; out.length < n && guard < 20000; guard++) {
    if (!isPausedDate(cycle, d, today)) out.push(d);
    d = addDays(d, 1);
  }
  if (trainingDayCache.size > 200) trainingDayCache.clear();
  trainingDayCache.set(key, out);
  return out;
}

// Pausiert sofort. Wurde heute schon trainiert, beginnt die Pause morgen –
// die Einträge von heute sollen ihrem Tag nicht verloren gehen.
function pauseCycle() {
  const cycle = getActiveCycle();
  if (!cycle) return;
  const today = toDateStr(new Date());
  const trained = (cycle.sessions[today] || []).length > 0;
  cycle.pausedAt = trained ? addDays(today, 1) : today;
  saveData();
  render();
}

// Beendet die Pause; heute ist wieder ein Trainingstag.
function resumeCycle() {
  const cycle = getActiveCycle();
  if (!isCyclePaused(cycle)) return;
  const today = toDateStr(new Date());
  if (today > cycle.pausedAt) {
    cycle.pauses = (cycle.pauses || []).concat([{ from: cycle.pausedAt, to: addDays(today, -1) }]);
  }
  delete cycle.pausedAt;
  saveData();
  render();
}

// Anzahl pausierter Tage in einem Zeitraum (beide Tage inklusive)
function pausedDaysBetween(cycle, from, to) {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (isPausedDate(cycle, d)) n++;
  return n;
}

// Wer pausiert und wieder einsteigt, steht hier: Woche und Tag in der Woche
function trainingPosition(cycle) {
  const today = toDateStr(new Date());
  const upTo = isCyclePaused(cycle) && cycle.pausedAt < today ? cycle.pausedAt : today;
  let n = 0;
  for (let d = cycle.startDate; d < upTo; d = addDays(d, 1)) if (!isPausedDate(cycle, d)) n++;
  const maxDay = (cycle.weeks || 12) * 7 - 1;
  n = Math.min(n, maxDay);
  return { week: Math.floor(n / 7), day: n % 7 };
}

function getWeekDates(cycle, weekIndex) {
  return trainingDays(cycle, (weekIndex + 1) * 7).slice(weekIndex * 7);
}

function getWeekIntensity(cycle, weekIndex) {
  const days = getWeekDates(cycle, weekIndex);
  let total = 0;
  days.forEach(day => {
    const entries = cycle.sessions[day] || [];
    entries.forEach(entry => {
      total += getEffectiveIntensity(cycle, entry);
    });
  });
  return Math.round(total * 10) / 10;
}

// tol: wie weit Ist und Ziel auseinanderliegen dürfen und trotzdem als
// erreicht gelten – 1 Punkt Intensität, aber 15 Minuten.
function intensityClass(current, target, tol = 1) {
  if (target === 0) return 'int-blue';
  const diff = current - target;
  if (current === 0 && target > 0) return 'int-blue';
  if (diff > tol) return 'int-red';
  if (Math.abs(diff) <= tol) return 'int-green-dark';
  if (current > 0 && diff < -tol && current >= target * 0.5) return 'int-green-light';
  return 'int-blue';
}

function intensityLabel(current, target, tol = 1) {
  if (target === 0) return '–';
  const diff = current - target;
  if (diff > tol) return '↑ überschritten';
  if (Math.abs(diff) <= tol) return '✓ erreicht';
  // Schräg nach unten: der Wert liegt unter dem Ziel, wenn auch nur knapp.
  if (current > 0 && current >= target * 0.5) return '↘ fast erreicht';
  return '↓ noch offen';
}

// Während einer Pause ist das die Woche, mit der es danach weitergeht.
function getCurrentWeekIndex(cycle) {
  if (toDateStr(new Date()) < cycle.startDate) return 0;
  return trainingPosition(cycle).week;
}

function formatDateRange(d1, d2) {
  const a = parseDate(d1), b = parseDate(d2);
  return `${a.getDate()}. ${MONTHS_DE[a.getMonth()]} – ${b.getDate()}. ${MONTHS_DE[b.getMonth()]} ${b.getFullYear()}`;
}

// ═══════════════════════════════════════════════
// VIEW ROUTING
// ═══════════════════════════════════════════════
let currentView = 'dashboard';

function switchView(name) {
  if (name !== 'plan') draftEditId = null;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach((b, i) => {
    b.classList.toggle('active', ['dashboard','plan','assessment','history','settings'][i] === name);
  });
  document.getElementById('view-' + name).classList.add('active');
  currentView = name;
  render();
}

function render() {
  if (currentView === 'dashboard') renderDashboard();
  if (currentView === 'plan') renderPlan();
  if (currentView === 'assessment') renderAssessment();
  if (currentView === 'history') renderHistory();
  if (currentView === 'settings') renderSettings();
}

// ── Komma ohne Lücke ──
// Zahlen stehen oft in der Monospace-Schrift DM Mono. Dort ist jedes Zeichen
// gleich breit, auch das Komma – "6,5" sähe aus wie "6, 5". Deshalb wird das
// Komma zwischen zwei Ziffern in ein schmales Element gesetzt (CSS: .dc).
function tightenCommas(root) {
  if (!root || typeof document === 'undefined' || !document.createTreeWalker) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (/\d,\d/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
  nodes.forEach(node => {
    const parent = node.parentNode;
    if (!parent || parent.namespaceURI !== 'http://www.w3.org/1999/xhtml' || parent.classList.contains('dc')) return;
    if (!/Mono/i.test(getComputedStyle(parent).fontFamily)) return;
    const frag = document.createDocumentFragment();
    const text = node.nodeValue;
    let last = 0;
    for (let i = 1; i < text.length - 1; i++) {
      if (text[i] === ',' && /\d/.test(text[i - 1]) && /\d/.test(text[i + 1])) {
        frag.appendChild(document.createTextNode(text.slice(last, i)));
        const span = document.createElement('span');
        span.className = 'dc';
        span.textContent = ',';
        frag.appendChild(span);
        last = i + 1;
      }
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    parent.replaceChild(frag, node);
  });
}

// Nach jedem Neuzeichnen einmal über die Seite und das offene Fenster
if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
  let pending = false;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    (window.requestAnimationFrame || setTimeout)(() => {
      pending = false;
      observer.disconnect();
      tightenCommas(document.querySelector('.main'));
      tightenCommas(document.getElementById('modalContent'));
      observe();
    });
  });
  const observe = () => {
    ['.main', '#modalContent'].forEach(sel => {
      const el = document.querySelector(sel);
      if (el) observer.observe(el, { childList: true, subtree: true, characterData: true });
    });
  };
  observe();
}

function niceYStep(maxVal) {
  if (maxVal <= 0) return 1;
  // Prefer steps that produce clean integer ticks
  const candidates = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  let best = null;
  let bestDiff = Infinity;
  for (const s of candidates) {
    const intervals = Math.ceil(maxVal / s);
    if (intervals < 2 || intervals > 7) continue;
    const diff = Math.abs(intervals - 5);
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  }
  return best !== null ? best : 1;
}

// Bei langen Zyklen zeigt das Diagramm zunächst zwölf Wochen rund um die
// aktuelle – 52 Balken auf Handybreite sind nicht mehr lesbar. "Alle"
// schaltet auf den ganzen Zyklus.
const CHART_WINDOW = 12;
let chartShowAll = false;

function renderIntensityChart(cycle) {
  const total = cycle.weeks || 12;
  const currentWeek = getCurrentWeekIndex(cycle);
  const windowed = total > CHART_WINDOW && !chartShowAll;
  const from = windowed ? Math.max(0, Math.min(currentWeek - 4, total - CHART_WINDOW)) : 0;
  const W = windowed ? CHART_WINDOW : total;
  const targets = [];
  const actuals = [];
  const breakdowns = [];
  for (let j = 0; j < W; j++) {
    targets.push(getWeekTarget(cycle, from + j));
    actuals.push(getWeekIntensity(cycle, from + j));
    breakdowns.push(getWeekCategoryBreakdown(cycle, from + j));
  }
  const allCats = getAllCategoriesInCycle(cycle);

  // Y scale with nice steps
  const rawMax = Math.max(1, ...targets, ...actuals) * 1.1;
  const step = niceYStep(rawMax);
  const niceMax = Math.ceil(rawMax / step) * step;
  const numSteps = Math.round(niceMax / step);

  // Die Werte einer Woche zeigt das Abtasten mit Finger oder Maus (siehe
  // chartScrub) – dafür muss niemand einen schmalen Balken genau treffen.
  const w = 320, h = 180;
  const padL = 28, padR = 12, padT = 16, padB = 30;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;
  const stepX = chartW / Math.max(W, 1);

  const xFor = j => padL + (j + 0.5) * stepX;
  const yFor = v => padT + chartH - (v / niceMax) * chartH;
  const yZero = yFor(0);

  const barW = W === 1 ? 24 : Math.max(2, Math.min(22, stepX * 0.55));

  // Beschriftung in der Textschrift: In der Monospace-Schrift stünde das
  // Komma mit Lücke da ("0, 5").
  const T = 'font-size="9" fill="var(--text-dim)"';
  const gridLines = [];
  const yLabels = [];
  for (let g = 0; g <= numSteps; g++) {
    const yVal = step * g;
    const yPx = yFor(yVal);
    gridLines.push(`<line x1="${padL}" y1="${yPx}" x2="${w-padR}" y2="${yPx}" stroke="var(--border)" stroke-width="0.5"/>`);
    yLabels.push(`<text x="${padL - 4}" y="${yPx + 3}" ${T} text-anchor="end">${fmtNum(yVal)}</text>`);
  }

  // X-Achse: echte Wochennummern, in sinnvollem Abstand
  const labelStep = W <= 1 ? 1 : W <= 12 ? 2 : W <= 24 ? 4 : W <= 48 ? 8 : 10;
  const xLabels = [];
  for (let j = 0; j < W; j++) {
    const num = from + j + 1;
    if (W === 1 || num % labelStep === 0) {
      xLabels.push(`<text x="${xFor(j)}" y="${h - 14}" ${T} text-anchor="middle">${num}</text>`);
    }
  }

  // Stacked bars per week, ordered by allCats (consistent stack order)
  const bars = [];
  for (let j = 0; j < W; j++) {
    const bd = breakdowns[j];
    if (!bd) continue;
    let yBottomPx = yZero;
    const bx = xFor(j) - barW / 2;
    allCats.forEach(cat => {
      const val = bd[cat] || 0;
      if (val <= 0) return;
      const segH = (val / niceMax) * chartH;
      const segY = yBottomPx - segH;
      bars.push(`<rect x="${bx.toFixed(1)}" y="${segY.toFixed(1)}" width="${barW.toFixed(1)}" height="${segH.toFixed(1)}" fill="${categoryColor(cat, allCats)}" opacity="0.9"/>`);
      yBottomPx = segY;
    });
  }

  // Target line (accent dashed) + dots
  const targetPath = targets.map((v, j) => `${j === 0 ? 'M' : 'L'} ${xFor(j)} ${yFor(v)}`).join(' ');
  const targetDots = targets.map((v, j) => `<circle cx="${xFor(j)}" cy="${yFor(v)}" r="${W > 24 ? 1.2 : 2.5}" fill="var(--accent)"/>`).join('');

  // Unsichtbare Spalten je Woche – tragen die Werte für die Anzeige
  const chartId = 'intChart';
  const touchTargets = Array.from({length: W}, (_, j) => {
    const topY = yFor(Math.max(targets[j], actuals[j], 0.01));
    return `<rect x="${(padL + j * stepX).toFixed(1)}" y="${padT}" width="${stepX.toFixed(1)}" height="${chartH}" fill="transparent" data-col="${j}" data-wk="${from + j}" data-act="${actuals[j]}" data-tgt="${targets[j]}" data-cx="${xFor(j).toFixed(1)}" data-ty="${topY.toFixed(1)}"/>`;
  });
  const tipGroup = `<line id="${chartId}_hl" x1="0" x2="0" y1="${padT}" y2="${h - padB}" stroke="var(--text)" stroke-width="0.6" opacity="0.5" style="display:none" pointer-events="none"/>
    <g id="${chartId}_tip" style="display:none" pointer-events="none" data-unit="${unitInfo(cycle).short}"><rect id="${chartId}_bg" x="0" y="0" width="78" height="42" rx="4" fill="#0a0a0a" opacity="0.9"/><text id="${chartId}_tw" x="0" y="0" font-size="8.5" fill="var(--text-muted)"></text><text id="${chartId}_ta" x="0" y="0" font-size="8.5" fill="#fff"></text><text id="${chartId}_tt" x="0" y="0" font-size="8.5" fill="var(--accent)"></text></g>`;

  // Current week marker (nur, wenn sie im Ausschnitt liegt)
  const cj = currentWeek - from;
  const currentMarker = cj >= 0 && cj < W
    ? `<line x1="${xFor(cj)}" y1="${padT}" x2="${xFor(cj)}" y2="${h - padB}" stroke="var(--accent)" stroke-width="0.5" stroke-dasharray="2,3" opacity="0.4"/>`
    : '';

  const usedCats = allCats.filter(cat => breakdowns.some(bd => (bd[cat] || 0) > 0));
  const legendItem = (color, label) => `<span style="display:inline-flex;align-items:center;gap:4px;color:var(--text-muted)">
      <span style="width:10px;height:10px;background:${color};display:inline-block;border-radius:2px"></span> ${esc(label)}
    </span>`;
  const targetLegend = `<span style="display:inline-flex;align-items:center;gap:4px;color:var(--text-muted)">
    <span style="width:14px;height:2px;background:var(--accent);display:inline-block"></span> Ziel
  </span>`;
  const legendCats = usedCats.length === 0
    ? legendItem('#888', 'Ist')
    : usedCats.map(cat => legendItem(categoryColor(cat, allCats), cat)).join('');

  const title = cycleUnit(cycle) === 'int' ? 'Intensitätsverlauf' : `Trainingszeit (${unitInfo(cycle).short})`;
  return `
    <div class="card">
      <div class="card-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <span>${title}${windowed ? ` · W${from + 1}–${from + W}` : ''}</span>
        ${total > CHART_WINDOW ? `<div class="seg seg-mini">
          <button type="button" class="${chartShowAll ? '' : 'on'}" onclick="chartShowAll=false;renderDashboard()">12 Wo.</button>
          <button type="button" class="${chartShowAll ? 'on' : ''}" onclick="chartShowAll=true;renderDashboard()">Alle</button>
        </div>` : ''}
      </div>
      <svg id="${chartId}" class="scrub-chart" viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;display:block" preserveAspectRatio="xMidYMid meet"
        data-padl="${padL}" data-stepx="${stepX}" data-weeks="${W}"
        onpointerdown="chartScrub(event, this, true)" onpointermove="chartScrub(event, this, false)" onpointerleave="chartLeave(event, this)">
        ${gridLines.join('')}
        ${yLabels.join('')}
        ${currentMarker}
        ${bars.join('')}
        <path d="${targetPath}" stroke="var(--accent)" stroke-width="1.5" fill="none" stroke-dasharray="4,3" opacity="0.95"/>
        ${targetDots}
        ${xLabels.join('')}
        ${touchTargets.join('')}
        ${tipGroup}
      </svg>
      <div style="display:flex;gap:10px 14px;font-size:11px;margin-top:6px;justify-content:center;flex-wrap:wrap">
        ${targetLegend}
        ${legendCats}
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════
// CHART TOOLTIP
// ═══════════════════════════════════════════════
// ── Diagramm abtasten ──
// Finger auflegen und seitlich wischen (oder mit der Maus darüberfahren):
// Die Anzeige folgt der Woche darunter. Ein kurzer Tipp auf die bereits
// gezeigte Woche blendet sie wieder aus.
function chartWeekAt(e, svg) {
  const rect = svg.getBoundingClientRect();
  const vb = (svg.getAttribute('viewBox') || '0 0 320 180').split(' ').map(parseFloat);
  const vx = (e.clientX - rect.left) / rect.width * vb[2];
  const padL = parseFloat(svg.dataset.padl), stepX = parseFloat(svg.dataset.stepx);
  const weeks = parseInt(svg.dataset.weeks, 10);
  return Math.max(0, Math.min(weeks - 1, Math.floor((vx - padL) / stepX)));
}

function chartScrub(e, svg, down) {
  // Maus: schon beim Drüberfahren. Finger: solange er aufliegt.
  if (!down && e.pointerType !== 'mouse' && !(e.buttons & 1)) return;
  const wk = chartWeekAt(e, svg);
  const tip = document.getElementById(svg.id + '_tip');
  const col = svg.querySelector(`rect[data-col="${wk}"]`);
  if (down && e.pointerType !== 'mouse' && tip && col && tip.style.display !== 'none' && tip.getAttribute('data-active') === col.getAttribute('data-wk')) {
    hideChartTooltip(svg.id);
    return;
  }
  const el = svg.querySelector(`rect[data-col="${wk}"]`);
  if (el) showChartTooltip(el, svg.id);
}

function chartLeave(e, svg) {
  if (e.pointerType === 'mouse') hideChartTooltip(svg.id);
}

function hideChartTooltip(id) {
  const tip = document.getElementById(id + '_tip');
  const hl = document.getElementById(id + '_hl');
  if (tip) tip.style.display = 'none';
  if (hl) hl.style.display = 'none';
}

function showChartTooltip(el, id) {
  const tip = document.getElementById(id + '_tip');
  if (!tip) return;
  const wk = el.getAttribute('data-wk');
  tip.setAttribute('data-active', wk);
  const act = parseFloat(el.getAttribute('data-act'));
  const tgt = parseFloat(el.getAttribute('data-tgt'));
  const cx  = parseFloat(el.getAttribute('data-cx'));
  const ty0 = parseFloat(el.getAttribute('data-ty'));
  const unit = tip.getAttribute('data-unit') ? ' ' + tip.getAttribute('data-unit') : '';
  const fmt = v => fmtNum(Math.round(v * 10) / 10) + unit;
  const bg  = document.getElementById(id + '_bg');
  const tw  = document.getElementById(id + '_tw');
  const ta  = document.getElementById(id + '_ta');
  const tt  = document.getElementById(id + '_tt');
  const hl  = document.getElementById(id + '_hl');
  const TW = 78, TH = 42, P = 6;
  const svgW = parseFloat((document.getElementById(id).getAttribute('viewBox') || '0 0 320').split(' ')[2]) || 320;
  // Neben die Linie, damit der Finger die Anzeige nicht verdeckt
  const tx = cx + 8 + TW <= svgW - 2 ? cx + 8 : cx - 8 - TW;
  const ty = Math.max(4, Math.min(ty0 - TH / 2, 180 - 30 - TH));
  bg.setAttribute('x', tx); bg.setAttribute('y', ty);
  tw.textContent = 'Woche ' + (parseInt(wk, 10) + 1);
  tw.setAttribute('x', tx + P); tw.setAttribute('y', ty + 12);
  ta.textContent = 'Ist:  ' + fmt(act);
  ta.setAttribute('x', tx + P); ta.setAttribute('y', ty + 24);
  tt.textContent = 'Ziel: ' + fmt(tgt);
  tt.setAttribute('x', tx + P); tt.setAttribute('y', ty + 36);
  if (hl) { hl.setAttribute('x1', cx); hl.setAttribute('x2', cx); hl.style.display = 'block'; }
  tip.style.display = 'block';
}

// ═══════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════
function renderDashboard() {
  const el = document.getElementById('dashContent');
  const cycle = getActiveCycle();

  if (!cycle) {
    el.innerHTML = `
      <div class="empty" style="padding-bottom:20px">
        <div class="empty-icon">🧗</div>
        <div>Wie möchtest du trainieren?</div>
      </div>
      <div class="choice-card" onclick="openNewCycleModal('plan')">
        <div class="choice-title">Mit Wochenplan</div>
      </div>
      <div class="choice-card" onclick="openNewCycleModal('free')">
        <div class="choice-title">Frei</div>
      </div>
      <div class="choice-card" onclick="openImportPlanModal()">
        <div class="choice-title">Plan von deinem Trainer</div>
      </div>`;
    document.getElementById('navSub').textContent = 'Kein aktiver Zyklus';
    return;
  }

  const totalWeeks = cycle.weeks || 12;
  const weekIdx = getCurrentWeekIndex(cycle);
  const weekDays = getWeekDates(cycle, weekIdx);
  const weekInt = getWeekIntensity(cycle, weekIdx);
  const target = getWeekTarget(cycle, weekIdx);
  const unit = unitInfo(cycle);
  const iClass = intensityClass(weekInt, target, unit.tol);
  const today = toDateStr(new Date());
  const paused = isCyclePaused(cycle);
  const status = cycleStatus(cycle);

  document.getElementById('navSub').textContent = cycle.name + (paused ? ' · Pause'
    : status === 'future' ? ' · startet ' + formatDay(cycle.startDate)
    : status === 'ended' ? ' · beendet'
    : ' · Woche ' + (weekIdx + 1));

  // Stats: count completed exercise sessions across cycle
  let completedExercises = 0;
  let trainingDays = 0;
  for (let i = 0; i < totalWeeks; i++) {
    const days = getWeekDates(cycle, i);
    days.forEach(d => {
      const sess = cycle.sessions[d] || [];
      if (sess.length > 0) {
        trainingDays++;
        completedExercises += sess.length;
      }
    });
  }

  const pct = target > 0 ? Math.min(100, Math.round(weekInt / target * 100)) : 0;
  let barColor = iClass === 'int-blue' ? 'var(--blue)' : iClass === 'int-green-light' ? 'var(--green-light)' : iClass === 'int-green-dark' ? 'var(--green-dark)' : 'var(--red)';

  // Dynamic day labels (actual weekday of each day in the week)
  const dayLabelsShort = weekDays.map(d => {
    const dt = parseDate(d);
    const dow = (dt.getDay() + 6) % 7; // 0=Mon
    return DAYS_DE[dow];
  });

  const pauseCard = paused ? `
    <div class="pause-hero">
      <div class="pause-icon">${PAUSE_ICON}</div>
      <div class="sheet-title">Training pausiert</div>
      <div class="sheet-text">${cycle.pausedAt > today ? 'Ab morgen' : cycle.pausedAt === today ? 'Seit heute' : `Seit ${formatDay(cycle.pausedAt)} · ${pausedDaysBetween(cycle, cycle.pausedAt, today)} Tage`} · weiter mit Woche ${trainingPosition(cycle).week + 1}, Tag ${trainingPosition(cycle).day + 1}</div>
      <button class="btn btn-primary btn-full" style="margin-top:18px" onclick="resumeCycle()">Training fortsetzen</button>
    </div>` : '';

  const weekHdrRight = `<button class="btn btn-ghost btn-sm pause-btn" onclick="pauseCycle()">${PAUSE_ICON} Pausieren</button>`;

  el.innerHTML = `
    ${renderAssessmentReminder()}
    ${paused ? pauseCard : status !== 'running' ? renderStatusCard(cycle, status) : `
    ${isPlanMode(cycle) ? renderTodayCard(cycle, today) : ''}
    <div class="section-hdr"><h2>Diese Woche</h2>${weekHdrRight}</div>

    <div class="card week-card">
      <div class="card-title">Woche ${weekIdx+1} von ${totalWeeks}${(() => {
        const plan = weekPlanFor(cycle, weekIdx);
        return plan ? ` · <span style="color:${weekPlanColor(cycle, plan)}">${esc(plan.name)}</span>` : ` · ${unit.title}`;
      })()}</div>
      <div class="week-total">
        <span class="week-total-val">${fmtNum(weekInt)}</span>
        <span class="text-muted">von ${fmtAmount(cycle, target)}</span>
        <span class="intensity-badge ${iClass}" style="margin-left:auto">${intensityLabel(weekInt, target, unit.tol)}</span>
      </div>
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill" style="width:${pct}%;background:${barColor}"></div>
      </div>
      <div class="week-grid" style="margin-top:16px">
        ${dayLabelsShort.map((d, i) => {
          const dateStr = weekDays[i];
          const exIds = cycle.sessions[dateStr] || [];
          const isToday = dateStr === today;
          const planned = exIds.length === 0 && plannedExercises(cycle, dateStr).length > 0;
          return `<button type="button" class="day-col" onclick="openDayModal('${dateStr}')">
            <span class="day-label ${isToday ? 'today' : ''}">${d}</span>
            <span class="day-dot ${exIds.length > 0 ? 'has-session' : ''} ${planned ? 'planned' : ''} ${isToday ? 'today' : ''}">
              ${exIds.length > 0 ? exIds.length : ''}
            </span>
          </button>`;
        }).join('')}
      </div>
      <div class="week-foot">${formatDateRange(weekDays[0], weekDays[6])} · ${trainingDays} ${trainingDays === 1 ? 'Trainingstag' : 'Trainingstage'} im Zyklus</div>
    </div>
    `}

    ${renderIntensityChart(cycle)}

    ${renderWeekList(cycle, weekIdx, paused || status !== 'running')}
  `;
}

// Noch nicht gestartet oder schon vorbei – dann gibt es kein "Diese Woche"
function cycleStatus(cycle) {
  const today = toDateStr(new Date());
  if (today < cycle.startDate) return 'future';
  if (!isCyclePaused(cycle) && today > getCycleEndDate(cycle)) return 'ended';
  return 'running';
}

function renderStatusCard(cycle, status) {
  const today = toDateStr(new Date());
  if (status === 'future') {
    const n = daysBetween(today, cycle.startDate);
    return `<div class="pause-hero">
      <div class="sheet-title">Startet ${n === 1 ? 'morgen' : `in ${n} Tagen`}</div>
      <div class="sheet-text">${DAYS_FULL[weekdayOf(cycle.startDate)]}, ${formatDay(cycle.startDate)} · ${cycle.weeks || 12} Wochen</div>
    </div>`;
  }
  return `<div class="pause-hero">
    <div class="sheet-title">Zyklus beendet</div>
    <div class="sheet-text">${esc(cycle.name)} · ${formatDateRange(cycle.startDate, getCycleEndDate(cycle))}</div>
    <button class="btn btn-primary btn-full" style="margin-top:18px" onclick="openNewCycleModal()">Neuen Zyklus starten</button>
  </div>`;
}


// Liste aller Wochen. Bei langen Zyklen nur die Umgebung der aktuellen
// Woche, der Rest auf Wunsch – 52 Zeilen will niemand durchscrollen.
const WEEK_LIST_SHORT = 12;
let showAllWeeks = false;

function renderWeekList(cycle, weekIdx, paused) {
  const total = cycle.weeks || 12;
  const unit = unitInfo(cycle);
  const long = total > WEEK_LIST_SHORT;
  const from = long && !showAllWeeks ? Math.max(0, Math.min(weekIdx - 1, total - 5)) : 0;
  const to = long && !showAllWeeks ? Math.min(total, from + 5) : total;
  const rows = [];
  for (let i = from; i < to; i++) {
    const wint = getWeekIntensity(cycle, i);
    const wtgt = getWeekTarget(cycle, i);
    const wc = intensityClass(wint, wtgt, unit.tol);
    const wd = getWeekDates(cycle, i);
    const isCurrent = i === weekIdx && !paused;
    // Pausentage seit dem Ende der Vorwoche bis zum Ende dieser Woche
    const gap = pausedDaysBetween(cycle, i > 0 ? addDays(getWeekDates(cycle, i - 1)[6], 1) : cycle.startDate, wd[6]);
    rows.push(`<div class="week-row ${isCurrent ? 'current-week' : ''}" onclick="openWeekModal(${i})">
      <div class="week-row-left">
        <div class="week-row-num">Woche ${i+1}${isCurrent ? ' · Aktuell' : ''}${(() => {
          const plan = weekPlanFor(cycle, i);
          return plan ? ` <span class="week-plan-tag" style="color:${weekPlanColor(cycle, plan)}">● ${esc(plan.name)}</span>` : '';
        })()}</div>
        <div class="week-row-date">${formatDateRange(wd[0], wd[6])}${gap ? ` <span class="pause-note">· ${gap} ${gap === 1 ? 'Tag' : 'Tage'} Pause</span>` : ''}</div>
        ${isPlanMode(cycle) || wd.some(d => (cycle.sessions[d] || []).length) ? `<div class="wk-dots">${wd.map(d =>
          `<span class="${(cycle.sessions[d] || []).length ? 'done' : plannedItems(cycle, d).length ? 'planned' : ''}" title="${DAYS_DE[weekdayOf(d)]}"></span>`).join('')}</div>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-family:'DM Mono',monospace;font-size:14px;color:var(--text-muted)">${fmtNum(wint)}/${fmtAmount(cycle, wtgt)}</span>
        <span class="intensity-badge ${wc}" style="font-size:11px;padding:3px 8px">${
          wc==='int-blue'?'↓':wc==='int-green-light'?'↘':wc==='int-green-dark'?'✓':'↑'
        }</span>
      </div>
    </div>`);
  }
  return `
    <div class="section-hdr"><h2>${total === 1 ? 'Die Woche' : `Alle ${total} Wochen`}</h2>
      ${long ? `<span class="text-muted" style="font-size:12px">${showAllWeeks ? '' : `${from + 1}–${to} von ${total}`}</span>` : ''}</div>
    ${rows.join('')}
    ${long ? `<button class="btn btn-ghost btn-full btn-sm" style="margin-bottom:8px" onclick="showAllWeeks=!showAllWeeks;renderDashboard()">${showAllWeeks ? 'Weniger anzeigen' : `Alle ${total} Wochen anzeigen`}</button>` : ''}`;
}

const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>';

function formatDay(dateStr) {
  const d = parseDate(dateStr);
  return d.getDate() + '. ' + MONTHS_DE[d.getMonth()];
}

// ═══════════════════════════════════════════════
// WOCHENPLAN
// ═══════════════════════════════════════════════
// Im Wochenplan-Modus gilt in jeder Zykluswoche eine geplante Woche (siehe
// planning.js). Im freien Modus trägt man ein, was man gemacht hat.
function isPlanMode(cycle) {
  return !!cycle && cycle.mode === 'plan';
}

function weekdayOf(dateStr) {
  return (parseDate(dateStr).getDay() + 6) % 7;
}

function renderTodayCard(cycle, today) {
  const planned = plannedItems(cycle, today);
  const done = new Set((cycle.sessions[today] || []).map(entryId));
  const dayName = DAYS_FULL[weekdayOf(today)];

  if (!weekPlans(cycle).length) {
    return `<button type="button" class="card card-btn" onclick="startPlanning(getActiveCycle())">
      <div class="card-title">Heute · ${dayName}</div>
      <div style="color:var(--accent)">Wochenplan einrichten ›</div>
    </button>`;
  }

  if (planned.length === 0) {
    let next = '';
    for (let i = 1; i <= 7 && !next; i++) {
      const ds = addDays(today, i);
      const p = plannedItems(cycle, ds);
      if (p.length) next = `${DAYS_FULL[weekdayOf(ds)]}: ${p.map(x => esc(x.ex.name)).join(', ')}`;
    }
    const thisWeek = weekPlanFor(cycle, weekIndexOfDate(cycle, today));
    return `<button type="button" class="card card-btn" onclick="openDayModal('${today}')">
      <div class="card-title">Heute · ${thisWeek ? 'Ruhetag' : dayName}</div>
      <div class="text-muted">${[thisWeek ? '' : 'Ohne Plan', next].filter(Boolean).join(' · ')}</div>
    </button>`;
  }

  const allDone = planned.every(x => done.has(x.ex.id));
  return `<button type="button" class="card card-btn" onclick="openDayModal('${today}')">
    <div class="card-title">Heute · ${dayName}${allDone ? ' · erledigt ✓' : ''}</div>
    ${planned.map(x => `
      <div class="today-row">
        <div class="check-box ${done.has(x.ex.id) ? 'checked' : ''}" style="width:20px;height:20px">${done.has(x.ex.id) ? CHECK_SVG : ''}</div>
        <div style="flex:1;min-width:0">
          <div class="today-name">${esc(x.ex.name)} <span class="today-amt">${fmtExAmount(cycle, x.amount)}</span></div>
          ${x.note ? `<div class="ex-note">${esc(x.note)}</div>` : x.ex.desc ? `<div class="ex-desc">${esc(x.ex.desc)}</div>` : ''}
        </div>
      </div>`).join('')}
  </button>`;
}

function getKW(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
  return Math.ceil((((d - yearStart) / 86400000) + 1)/7);
}

// ═══════════════════════════════════════════════
// DAY MODAL
// ═══════════════════════════════════════════════
function openDayModal(dateStr, returnToWeek) {
  document.getElementById('modalContent').innerHTML = buildDayModalContent(dateStr, returnToWeek);
  document.getElementById('modalOverlay').classList.add('open');
}

function refreshDayModal(dateStr, returnToWeek) {
  document.getElementById('modalContent').innerHTML = buildDayModalContent(dateStr, returnToWeek);
}

function buildDayModalContent(dateStr, returnToWeek) {
  const cycle = getActiveCycle();
  if (!cycle) return '';
  const d = parseDate(dateStr);
  const dow = (d.getDay() + 6) % 7;
  const title = DAYS_FULL[dow] + ', ' + d.getDate() + '. ' + MONTHS_DE[d.getMonth()];
  // Während der Pause wird nichts eingetragen – sonst wäre es keine Pause.
  if (isPausedDay(cycle, dateStr)) {
    return `
      <div class="pause-hero" style="background:none;border:none;padding-top:4px">
        <div class="pause-icon">${PAUSE_ICON}</div>
        <div class="sheet-title">${title}</div>
        <button class="btn btn-primary btn-full" style="margin-top:18px" onclick="closeModal();resumeCycle()">Training fortsetzen</button>
        <button class="btn-link" onclick="closeModal()">Schließen</button>
      </div>`;
  }
  const entries = cycle.sessions[dateStr] || [];
  const selected = new Set(entries.map(e => entryId(e)));
  const allCats = getAllCategoriesInCycle(cycle);

  // Im Wochenplan stehen die für diesen Wochentag geplanten Übungen oben.
  const plannedList = plannedItems(cycle, dateStr);
  const planned = plannedList.map(x => x.ex);
  const plannedIds = new Set(planned.map(ex => ex.id));
  const planOf = id => plannedList.find(x => x.ex.id === id);
  const others = cycle.exercises.filter(ex => !plannedIds.has(ex.id));

  const exRow = ex => {
        const pl = planOf(ex.id);
        const planAmount = pl ? pl.amount : ex.intensity;
        const checked = selected.has(ex.id);
        const entry = entries.find(e => entryId(e) === ex.id);
        const ov = entry ? entryOverride(entry) : null;
        const inputVal = ov !== null ? ov : ex.intensity;
        const cats = exerciseCategories(ex);
        const unit = ex.unit ? ` (${esc(ex.unit)})` : '';

        return `<div class="check-row day-ex ${checked ? 'done' : ''}">
          <div onclick="toggleDayEx('${dateStr}','${ex.id}', ${returnToWeek !== undefined && returnToWeek !== null ? returnToWeek : 'null'})"
               style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer">
            <div class="check-box ${checked ? 'checked' : ''}" style="flex-shrink:0">
              ${checked ? '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
            </div>
            <div style="flex:1;min-width:0">
              <div class="check-label" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(ex.name)}</div>
              <div class="day-ex-sub">
                ${cats.length ? `<span style="display:inline-flex;gap:5px">${catLabelsHtml(cats, allCats, 12)}</span><span style="color:var(--text-dim)">·</span>` : ''}
                <span>${fmtExAmount(cycle, planAmount)}</span>
                ${ov !== null && ov !== parseFloat(planAmount) ? `<span style="color:var(--accent)">→ ${fmtNum(ov)}</span>` : ''}
              </div>
              ${pl && pl.note ? `<div class="ex-note">${esc(pl.note)}</div>` : ''}
            </div>
          </div>
          ${checked ? `
            <input type="number" step="${unitInfo(cycle).step}" min="0" value="${inputVal}"
              onchange="setOverride('${dateStr}','${ex.id}', this.value)"
              onclick="event.stopPropagation()"
              style="width:62px;text-align:right;padding:6px 8px;font-size:14px;flex-shrink:0"
              title="Wert für diese Einheit anpassen">
          ` : ''}
        </div>
        ${checked && ex.measure ? `
          <div class="measure-row">
            <input type="text" inputmode="decimal" placeholder="Wert${unit}" value="${entry && entry.value !== undefined ? esc(fmtNum(entry.value)) : ''}"
              onchange="setEntryValue('${dateStr}','${ex.id}', this.value)" style="width:96px;flex-shrink:0">
            <input type="text" placeholder="Notiz, z.B. einarmig, Band" value="${entry && entry.note ? esc(entry.note) : ''}"
              onchange="setEntryNote('${dateStr}','${ex.id}', this.value)">
          </div>` : ''}`;
  };

  const exList = cycle.exercises.length === 0
    ? `<div class="empty" style="padding:20px 0"><div>Noch keine Übungen im Plan.<br>Gehe zu <strong>Trainingsplan</strong>.</div></div>`
    : planned.length > 0
      ? `<div class="card-title">Geplant</div>${planned.map(exRow).join('')}` +
        (others.length ? `<div class="card-title" style="margin-top:14px">Weitere Übungen</div>${others.map(exRow).join('')}` : '')
      : `<div class="card-title">Übungen abhaken</div>${cycle.exercises.map(exRow).join('')}`;

  const dayInt = entries.reduce((s, e) => s + getEffectiveIntensity(cycle, e), 0);

  const finishBtn = (returnToWeek !== undefined && returnToWeek !== null && !isNaN(parseFloat(returnToWeek)))
    ? `<button class="btn btn-ghost btn-full" onclick="closeModal();setTimeout(()=>openWeekModal(${returnToWeek}),250)">Fertig · zurück zur Woche</button>`
    : `<button class="btn btn-ghost btn-full" onclick="closeModal()">Fertig</button>`;

  return `
    <div class="day-head">
      <div class="modal-title" style="margin:0">${title}</div>
      <div class="day-total"><span id="dayIntDisplay">${fmtAmount(cycle, dayInt)}</span><span>${unitInfo(cycle).day}</span></div>
    </div>
    ${exList}
    <div class="divider"></div>
    ${finishBtn}
  `;
}

function toggleDayEx(dateStr, exId, returnToWeek) {
  const cycle = getActiveCycle();
  if (!cycle || isPausedDay(cycle, dateStr)) return;
  if (!cycle.sessions[dateStr]) cycle.sessions[dateStr] = [];
  const idx = cycle.sessions[dateStr].findIndex(e => entryId(e) === exId);
  if (idx >= 0) {
    cycle.sessions[dateStr].splice(idx, 1);
  } else {
    // Weicht der Wert dieser Woche vom Standard der Übung ab (Entlastungs-
    // woche), zählt der geplante Wert.
    const entry = { exId };
    const pl = plannedItems(cycle, dateStr).find(x => x.ex.id === exId);
    if (pl && pl.amount !== (parseFloat(pl.ex.intensity) || 0)) entry.overrideInt = pl.amount;
    cycle.sessions[dateStr].push(entry);
  }
  saveData();
  refreshDayModal(dateStr, returnToWeek);
  if (currentView === 'dashboard') renderDashboard();
}

function setOverride(dateStr, exId, value) {
  const cycle = getActiveCycle();
  if (!cycle || !cycle.sessions[dateStr]) return;
  const entry = cycle.sessions[dateStr].find(e => entryId(e) === exId);
  if (!entry || typeof entry !== 'object') return;
  const trimmed = (value || '').toString().trim();
  if (trimmed === '') {
    delete entry.overrideInt;
  } else {
    const v = parseNum(trimmed);
    if (isNaN(v) || v < 0) {
      delete entry.overrideInt;
    } else {
      entry.overrideInt = v;
    }
  }
  saveData();
  // Update just the day-total display (avoid full rerender to keep input focus stable)
  const dayInt = cycle.sessions[dateStr].reduce((s, e) => s + getEffectiveIntensity(cycle, e), 0);
  const totalEl = document.getElementById('dayIntDisplay');
  if (totalEl) totalEl.textContent = fmtAmount(cycle, dayInt);
  if (currentView === 'dashboard') renderDashboard();
}

// ── Optionaler Messwert beim Abhaken ──
// Nur bei Übungen mit "Messwert erfassen". Wert und Notiz sind beide
// freiwillig; die Notiz hält fest, was der Wert bedeutet, wenn die Übung mal
// anders lief (einarmig mit Band statt mit Zusatzgewicht).
function findEntry(dateStr, exId) {
  const cycle = getActiveCycle();
  if (!cycle || !cycle.sessions[dateStr]) return null;
  const entry = cycle.sessions[dateStr].find(e => entryId(e) === exId);
  return entry && typeof entry === 'object' ? entry : null;
}

function setEntryValue(dateStr, exId, raw) {
  const entry = findEntry(dateStr, exId);
  if (!entry) return;
  const v = parseFloat((raw || '').toString().trim().replace(',', '.'));
  if (isNaN(v)) delete entry.value; else entry.value = v;
  saveData();
}

function setEntryNote(dateStr, exId, raw) {
  const entry = findEntry(dateStr, exId);
  if (!entry) return;
  const t = (raw || '').toString().trim();
  if (t) entry.note = t; else delete entry.note;
  saveData();
}

// Alle Messwerte einer Übung, auch aus früheren Zyklen – dort hat dieselbe
// Übung eine andere ID, deshalb wird über den Namen zugeordnet.
function getExerciseMeasurements(name) {
  const want = (name || '').trim().toLowerCase();
  const out = [];
  appData.cycles.forEach(cycle => {
    const ids = new Set((cycle.exercises || [])
      .filter(ex => (ex.name || '').trim().toLowerCase() === want).map(ex => ex.id));
    if (ids.size === 0) return;
    Object.keys(cycle.sessions || {}).forEach(date => {
      (cycle.sessions[date] || []).forEach(e => {
        if (typeof e !== 'object' || !ids.has(e.exId)) return;
        if (e.value === undefined && !e.note) return;
        out.push({ date, value: e.value, note: e.note || '' });
      });
    });
  });
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

function formatMeasure(ex, m) {
  const val = m.value !== undefined ? fmtNum(m.value) + (ex.unit ? ' ' + ex.unit : '') : '';
  return [val, m.note].filter(Boolean).join(' · ');
}

// ═══════════════════════════════════════════════
// WEEK MODAL
// ═══════════════════════════════════════════════
// Eine Woche im Überblick: was schon trainiert ist und was noch geplant ist.
// Geplante Tage lassen sich mit zwei Tipps auf einen anderen Tag legen.
let weekMoveFrom = null;

function openWeekModal(weekIdx) {
  weekMoveFrom = null;
  openModal(`<div id="weekView" data-week="${weekIdx}"></div>`);
  renderWeekView(weekIdx);
}

function startMoveDay(weekIdx, dateStr) {
  weekMoveFrom = weekMoveFrom === dateStr ? null : dateStr;
  renderWeekView(weekIdx);
}

function finishMoveDay(weekIdx, to) {
  if (weekMoveFrom) moveTrainingDay(weekMoveFrom, to);
  weekMoveFrom = null;
  renderWeekView(weekIdx);
  render();
}

function renderWeekView(weekIdx) {
  const box = document.getElementById('weekView');
  const cycle = getActiveCycle();
  if (!box || !cycle) return;
  const days = getWeekDates(cycle, weekIdx);
  const target = getWeekTarget(cycle, weekIdx);
  const wInt = getWeekIntensity(cycle, weekIdx);
  const tol = unitInfo(cycle).tol;
  const iClass = intensityClass(wInt, target, tol);
  const allCats = getAllCategoriesInCycle(cycle);
  const plan = weekPlanFor(cycle, weekIdx);
  const today = toDateStr(new Date());
  const moving = weekMoveFrom && days.includes(weekMoveFrom);

  box.innerHTML = `
    <div class="modal-title" style="margin-bottom:4px">Woche ${weekIdx+1}${plan ? ` · <span style="color:${weekPlanColor(cycle, plan)}">${esc(plan.name)}</span>` : ''}</div>
    <div class="text-muted" style="margin-bottom:14px">${formatDateRange(days[0], days[6])}</div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
      <span class="intensity-badge ${iClass}">${fmtNum(wInt)} / ${fmtAmount(cycle, target)}</span>
      <span class="text-muted">${intensityLabel(wInt, target, tol)}</span>
    </div>
    ${moving ? `<div class="sheet-notice">${DAYS_FULL[weekdayOf(weekMoveFrom)]} verschieben nach …</div>` : ''}
    ${days.map(dateStr => {
      const entries = cycle.sessions[dateStr] || [];
      const planned = plannedItems(cycle, dateStr);
      const dayInt = entries.reduce((s, e) => s + getEffectiveIntensity(cycle, e), 0);
      const plannedTotal = planned.reduce((s, x) => s + x.amount, 0);
      const d = parseDate(dateStr);
      const isFrom = moving && dateStr === weekMoveFrom;
      const isTarget = moving && !isFrom;
      const canMove = !moving && planned.length && !entries.length && dateStr >= today;
      const head = `<div class="wv-head">
          <strong>${DAYS_FULL[weekdayOf(dateStr)]}, ${d.getDate()}. ${MONTHS_DE[d.getMonth()]}${dateStr === today ? ' <span class="wv-today">Heute</span>' : ''}</strong>
          <span class="wv-amount ${entries.length ? 'done' : ''}">${entries.length ? fmtAmount(cycle, dayInt) : planned.length ? 'geplant · ' + fmtAmount(cycle, plannedTotal) : isPausedDay(cycle, dateStr) ? 'Pause' : ''}</span>
        </div>`;
      const body = entries.length
        ? entries.map(entry => {
            const ex = cycle.exercises.find(e => e.id === entryId(entry));
            if (!ex) return '';
            const eff = getEffectiveIntensity(cycle, entry);
            const cats = exerciseCategories(ex);
            return `<div class="wv-item">
              <span style="display:flex;align-items:center;gap:5px">${catDotsHtml(cats, allCats, 11)}
                <span>${esc(ex.name)}${formatMeasure(ex, entry) ? ` <span style="color:var(--text-dim)">· ${esc(formatMeasure(ex, entry))}</span>` : ''}</span></span>
              <span class="wv-val">${fmtAmount(cycle, eff)}</span>
            </div>`;
          }).join('')
        : planned.map(x => `<div class="wv-item planned">
            <span>${esc(x.ex.name)}${x.movedFrom ? ` <span class="wv-moved">· von ${DAYS_DE[weekdayOf(x.movedFrom)]}</span>` : ''}</span>
            <span class="wv-val">${fmtExAmount(cycle, x.amount)}</span>
          </div>`).join('');
      const action = isTarget
        ? `onclick="finishMoveDay(${weekIdx}, '${dateStr}')"`
        : isFrom ? `onclick="startMoveDay(${weekIdx}, '${dateStr}')"`
        : `onclick="closeModal();setTimeout(()=>openDayModal('${dateStr}', ${weekIdx}),250)"`;
      return `<div class="wv-day ${isTarget ? 'target' : ''} ${isFrom ? 'from' : ''} ${!entries.length && !planned.length ? 'empty' : ''}" ${action}>
        ${head}${body}
        ${canMove ? `<button type="button" class="wv-move" onclick="event.stopPropagation();startMoveDay(${weekIdx}, '${dateStr}')">↔ Verschieben</button>` : ''}
        ${isTarget ? `<div class="wv-hint">Hierher verschieben</div>` : ''}
      </div>`;
    }).join('')}
    ${moving ? `<button class="btn btn-ghost btn-full" onclick="startMoveDay(${weekIdx}, weekMoveFrom)">Abbrechen</button>`
      : `<button class="btn btn-ghost btn-full" onclick="closeModal()">Schließen</button>`}
  `;
}

// ═══════════════════════════════════════════════
// PLAN VIEW
// ═══════════════════════════════════════════════
function renderPlan() {
  const el = document.getElementById('planContent');
  const cycle = getActiveCycle();

  if (!cycle) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">📋</div><div>Kein aktiver Zyklus.<br>Erstelle einen in den <strong>Einstellungen</strong>.</div></div>`;
    return;
  }

  const plan = isPlanMode(cycle);

  const planFrom = cycle.planAuthor || cycle.planNote
    ? `<div class="card">
        <div class="card-title">Plan${cycle.planAuthor ? ' von ' + esc(cycle.planAuthor) : ''}</div>
        ${cycle.planNote ? `<div style="font-size:14px;line-height:1.5">${esc(cycle.planNote)}</div>` : ''}
      </div>`
    : '';

  el.innerHTML = `
    ${cycle.forOther ? `<div class="draft-bar">
      <div><div class="draft-label">Plan für jemand anderen</div><div class="draft-name">${esc(cycle.name)}</div></div>
      <button class="btn btn-primary btn-sm" onclick="openSharePlanModal()">Teilen</button>
      <button class="btn btn-ghost btn-sm" onclick="closeDraft()">Fertig</button>
    </div>` : ''}
    ${isCyclePaused(cycle) ? `<div class="list-group" style="margin-bottom:16px">
      <div class="list-row" onclick="resumeCycle()">
        <span class="list-icon">${PAUSE_ICON}</span>
        <div class="list-main"><div class="list-title">Training pausiert</div></div>
        <span style="color:var(--accent);font-size:15px;flex-shrink:0">Fortsetzen</span>
      </div></div>` : ''}
    ${planFrom}
    <div class="section-hdr" style="margin-top:0">
      <h2>Übungen</h2>
      <button class="btn btn-ghost btn-sm" onclick="openAddExerciseModal()">+ Übung</button>
    </div>

    ${cycle.exercises.length === 0
      ? `<div class="card text-muted" style="text-align:center;padding:22px 16px">Noch keine Übungen.${plan ? ' Wähle unten fertige Wochen aus – die Übungen kommen mit.' : ' Füge deine erste hinzu – oder schalte unten den Wochenplan ein.'}</div>`
      : (() => {
          const allCats = getAllCategoriesInCycle(cycle);
          return `<div id="exerciseList">` + cycle.exercises.map(ex => {
            const cats = exerciseCategories(ex);
            return `
            <div class="exercise-item" data-exid="${ex.id}" onclick="openEditExerciseModal('${ex.id}')" style="cursor:pointer">
              <div class="drag-handle" onpointerdown="startExerciseDrag(event, this)" onclick="event.stopPropagation()" title="Ziehen zum Sortieren">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 4h12M2 8h12M2 12h12"/></svg>
              </div>
              <div style="flex:1;min-width:0">
                <div class="exercise-name">${esc(ex.name)}</div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:2px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                  ${cats.length ? catLabelsHtml(cats, allCats, 14) : ''}
                  ${ex.measure ? `<span style="color:var(--text-dim)">· Messwert</span>` : ''}
                </div>
                ${ex.desc ? `<div class="ex-desc">${esc(ex.desc)}</div>` : ''}
              </div>
              <div class="exercise-int">${fmtExAmount(cycle, ex.intensity)}</div>
              <button class="del-btn" onclick="event.stopPropagation(); deleteExercise('${ex.id}')">×</button>
            </div>
          `}).join('') + `</div>`;
        })()
    }
    ${plan ? renderPlanning(cycle) : ''}

    ${plan ? '' : `
    <div class="section-hdr"><h2>Wochenziele</h2></div>
    <div class="card-title">${unitInfo(cycle).target}</div>
    <div class="target-grid">
      ${Array.from({length: cycle.weeks || 12}, (_,i) => {
        const wd = getWeekDates(cycle, i);
        return `<label class="target-cell ${i === getCurrentWeekIndex(cycle) ? 'current' : ''}">
          <span class="tc-week">W${i+1}</span>
          <input type="number" inputmode="decimal" step="${unitInfo(cycle).step}" min="0"
            value="${cycle.weekTargets[i] || 0}" onchange="updateWeekTarget(${i}, this.value)">
          <span class="tc-date">${formatDay(wd[0])}</span>
        </label>`;
      }).join('')}
    </div>
    ${(cycle.weeks || 12) > 4 ? `<button class="btn btn-ghost btn-full btn-sm" style="margin-top:10px" onclick="repeatWeekTargets()">Woche 1–4 auf alle Wochen übertragen</button>` : ''}
    `}

    <div class="list-group" style="margin-top:20px">
      ${plan ? '' : `<div class="list-row" onclick="togglePlanMode()">
        <span class="list-icon">${CALENDAR_ICON}</span>
        <div class="list-main"><div class="list-title">Wochenplan einschalten</div></div>
        <span class="chev">›</span>
      </div>`}
      ${plan && weekPlans(cycle).length ? `<div class="list-row" onclick="openCalendarExport()">
        <span class="list-icon">${CALENDAR_ICON}</span>
        <div class="list-main"><div class="list-title">In den Kalender</div></div>
        <span class="chev">›</span>
      </div>` : ''}
      ${cycle.exercises.length ? `<div class="list-row" onclick="openSharePlanModal()">
        <span class="list-icon">${SHARE_ICON}</span>
        <div class="list-main"><div class="list-title">Plan teilen</div></div>
        <span class="chev">›</span>
      </div>` : ''}
    </div>
  `;
}

const CALENDAR_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';

// ── Formular für Übungen (Anlegen und Bearbeiten) ──
// p ist das Präfix der Feld-IDs: 'newEx' beim Anlegen, 'editEx' beim Bearbeiten.
function exerciseFormHtml(p, ex) {
  const cycle = getActiveCycle();
  const allCats = getAllCategoriesInCycle(cycle).filter(c => c !== 'Sonstige');
  const datalist = allCats.length > 0
    ? `<datalist id="${p}CatList">${allCats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>`
    : '';
  const measure = !!(ex && ex.measure);
  return `
    <div class="field">
      <label>Name der Übung</label>
      <input type="text" id="${p}Name" value="${ex ? esc(ex.name) : ''}" placeholder="z.B. Kilterboard Session">
    </div>
    <div class="field">
      <label>Kategorien (optional, mehrere möglich)</label>
      <input type="text" id="${p}Cat" value="${ex ? esc(formatCategories(exerciseCategories(ex))) : ''}" placeholder="z.B. Pull, Finger" list="${p}CatList"
        oninput="refreshCategoryChips('${p}Cat', true)">
      ${datalist}
      ${buildCategoryChips(p + 'Cat', true)}
    </div>
    <div class="field">
      <label>${unitInfo(cycle).amount}</label>
      <input type="number" id="${p}Int" step="${unitInfo(cycle).step}" min="0" value="${ex ? ex.intensity : ''}" placeholder="${unitInfo(cycle).placeholder}">
    </div>
    <div class="field">
      <label>Beschreibung (optional)</label>
      <textarea id="${p}Desc" rows="2" placeholder="z.B. 5 × 10 s, 3 min Pause, 20 mm">${ex && ex.desc ? esc(ex.desc) : ''}</textarea>
    </div>
    <div class="check-row" onclick="toggleCheck('${p}Measure');document.getElementById('${p}UnitField').style.display=isChecked('${p}Measure')?'':'none'">
      <div class="check-box ${measure ? 'checked' : ''}" id="${p}Measure" data-on="${measure ? '1' : '0'}">${measure ? CHECK_SVG : ''}</div>
      <div class="check-label">Messwert beim Abhaken erfassen</div>
    </div>
    <div class="field" id="${p}UnitField" style="${measure ? '' : 'display:none'}">
      <label>Einheit</label>
      <input type="text" id="${p}Unit" value="${ex && ex.unit ? esc(ex.unit) : ''}" placeholder="z.B. kg, Wdh., s">
    </div>`;
}

// Liest das Formular; null, wenn Pflichtangaben fehlen.
function readExerciseForm(p) {
  const name = document.getElementById(p + 'Name')?.value?.trim();
  const intensity = parseNum(document.getElementById(p + 'Int')?.value);
  if (!name || isNaN(intensity) || intensity < 0) {
    alert('Bitte Name und einen gültigen Wert eingeben.');
    return null;
  }
  const out = {
    name,
    categories: parseCategories(document.getElementById(p + 'Cat')?.value),
    intensity,
    desc: document.getElementById(p + 'Desc')?.value?.trim() || '',
    measure: isChecked(p + 'Measure'),
    unit: document.getElementById(p + 'Unit')?.value?.trim() || ''
  };
  return out;
}

// Überträgt das Formular auf die Übung. Leere Zusatzfelder werden entfernt,
// damit Übungen ohne sie so schlank bleiben wie bisher.
function applyExerciseForm(ex, form) {
  ex.name = form.name;
  ex.categories = form.categories;
  ex.intensity = form.intensity;
  if (form.desc) ex.desc = form.desc; else delete ex.desc;
  if (form.measure) { ex.measure = true; ex.unit = form.unit; }
  else { delete ex.measure; delete ex.unit; }
  return ex;
}

function openAddExerciseModal() {
  openModal(`
    <div class="modal-title">Übung hinzufügen</div>
    ${exerciseFormHtml('newEx', null)}
    <div class="row" style="margin-top:4px">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="addExercise()">Hinzufügen</button>
    </div>
  `);
  setTimeout(() => document.getElementById('newExName')?.focus(), 300);
}

function addExercise() {
  const form = readExerciseForm('newEx');
  if (!form) return;
  const cycle = getActiveCycle();
  cycle.exercises.push(applyExerciseForm({ id: newId() }, form));
  saveData();
  closeModal();
  renderPlan();
}

function openEditExerciseModal(exId) {
  const cycle = getActiveCycle();
  const ex = cycle.exercises.find(e => e.id === exId);
  if (!ex) return;
  const history = ex.measure ? getExerciseMeasurements(ex.name).slice(0, 8) : [];
  openModal(`
    <div class="modal-title">Übung bearbeiten</div>
    ${exerciseFormHtml('editEx', ex)}
    ${history.length ? `
      <div class="divider"></div>
      <div class="card-title">Letzte Messwerte</div>
      ${history.map(m => `<div class="log-row">
        <span class="text-muted" style="width:56px;flex-shrink:0">${formatDay(m.date)}</span>
        <span>${esc(formatMeasure(ex, m))}</span>
      </div>`).join('')}` : ''}
    <div class="row" style="margin-top:12px">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="saveExerciseEdit('${exId}')">Speichern</button>
    </div>
  `);
}

function saveExerciseEdit(exId) {
  const form = readExerciseForm('editEx');
  if (!form) return;
  const cycle = getActiveCycle();
  const ex = cycle.exercises.find(e => e.id === exId);
  if (!ex) return;
  applyExerciseForm(ex, form);
  saveData();
  closeModal();
  renderPlan();
}

function deleteExercise(exId) {
  const cycle = getActiveCycle();
  const ex = cycle.exercises.find(e => e.id === exId);
  if (!ex) return;
  // Wie oft sie schon abgehakt wurde – das geht mit verloren
  const done = Object.values(cycle.sessions).reduce((n, list) => n + list.filter(e => entryId(e) === exId).length, 0);
  if (!confirm(`„${ex.name}" löschen?` + (done ? `\n\nSie wurde ${done}× abgehakt; diese Einträge gehen mit verloren.` : ''))) return;
  cycle.exercises = cycle.exercises.filter(e => e.id !== exId);
  // also remove from sessions (both legacy strings and new objects)
  Object.keys(cycle.sessions).forEach(day => {
    cycle.sessions[day] = cycle.sessions[day].filter(e => entryId(e) !== exId);
  });
  // und aus den geplanten Wochen
  weekPlans(cycle).forEach(p => { p.items = p.items.filter(it => it.exId !== exId); });
  saveData();
  renderPlan();
}

// ═══════════════════════════════════════════════
// ÜBUNGEN SORTIEREN (ZIEHEN)
// ═══════════════════════════════════════════════
// Pointer-Events statt der HTML5-Drag-API: Letztere reagiert auf iOS nicht auf
// Berührungen, und die App wird vor allem am Handy benutzt. Gezogen wird nur
// am Anfasser, damit Tippen (Bearbeiten) und Wischen (Scrollen) unberührt
// bleiben; dafür braucht der Anfasser touch-action:none.
let exerciseDrag = null;

function startExerciseDrag(e, handle) {
  const el = handle.closest('[data-exid]');
  const parent = el && el.parentElement;
  if (!el || !parent) return;
  e.preventDefault();
  e.stopPropagation();
  exerciseDrag = { el, parent, pointerId: e.pointerId, startY: e.clientY, moved: false };
  el.classList.add('dragging');
  // Bewusst am Fenster und nicht am Anfasser: Beim Umhängen der Zeile wandert
  // der Anfasser mit aus dem Dokument, wodurch er die Zeigerführung verliert
  // und die folgenden Ereignisse verpassen würde. Am Fenster kommen sie in
  // jedem Fall an, ob mit Maus oder Finger.
  window.addEventListener('pointermove', onExerciseDragMove);
  window.addEventListener('pointerup', endExerciseDrag);
  window.addEventListener('pointercancel', endExerciseDrag);
}

function onExerciseDragMove(e) {
  const s = exerciseDrag;
  if (!s || e.pointerId !== s.pointerId) return;
  e.preventDefault();
  s.moved = true;
  applyDragOffset(e.clientY);
  // Bei schnellem Ziehen können mehrere Positionen auf einmal fällig sein.
  let guard = 0;
  while (guard++ < 30 && stepDragOrder(e.clientY)) { /* weiter */ }
}

function applyDragOffset(clientY) {
  exerciseDrag.el.style.transform = `translateY(${clientY - exerciseDrag.startY}px)`;
}

// Tauscht mit dem Nachbarn, sobald die Mitte der gezogenen Zeile dessen Mitte
// erreicht hat. Gibt true zurück, wenn getauscht wurde.
//
// Der Vergleich ist bewusst nicht streng: Zieht man um genau eine Zeilenhöhe,
// liegen beide Mitten nach dem Ausgleich exakt aufeinander, und mit ">" bliebe
// die Zeile eine Position zurück. Zum Hin- und Herspringen führt das nicht,
// weil der Ausgleich die Zeile bei jedem Tausch über den Gleichstand
// hinausträgt.
function stepDragOrder(clientY) {
  const { el, parent } = exerciseDrag;
  const rect = el.getBoundingClientRect();
  const center = rect.top + rect.height / 2;

  const next = el.nextElementSibling;
  if (next && next.dataset.exid) {
    const r = next.getBoundingClientRect();
    if (center >= r.top + r.height / 2) {
      return moveDragged(() => parent.insertBefore(next, el), clientY);
    }
  }
  const prev = el.previousElementSibling;
  if (prev && prev.dataset.exid) {
    const r = prev.getBoundingClientRect();
    if (center <= r.top + r.height / 2) {
      return moveDragged(() => parent.insertBefore(el, prev), clientY);
    }
  }
  return false;
}

// Durch das Umhängen wandert die Zeile im Layout. Damit sie optisch unter dem
// Finger stehen bleibt, wird der Startpunkt um genau diese Strecke mitgezogen.
// offsetTop ist dafür der richtige Messwert, weil transform das Layout nicht
// verändert.
function moveDragged(fn, clientY) {
  const before = exerciseDrag.el.offsetTop;
  fn();
  exerciseDrag.startY += exerciseDrag.el.offsetTop - before;
  applyDragOffset(clientY);
  return true;
}

function endExerciseDrag(e) {
  const s = exerciseDrag;
  if (!s || (e && e.pointerId !== s.pointerId)) return;
  window.removeEventListener('pointermove', onExerciseDragMove);
  window.removeEventListener('pointerup', endExerciseDrag);
  window.removeEventListener('pointercancel', endExerciseDrag);
  s.el.style.transform = '';
  s.el.classList.remove('dragging');
  exerciseDrag = null;
  if (!s.moved) return;   // reines Antippen des Anfassers ändert nichts
  // Nach einem Zug folgt noch ein Klick. Ohne diese Sperre würde er die Zeile
  // zum Bearbeiten öffnen. Der Zeitgeber räumt sie auch dann weg, wenn gar
  // kein Klick mehr kommt – etwa bei Bedienung per Finger.
  window.addEventListener('click', swallowDragClick, true);
  setTimeout(() => window.removeEventListener('click', swallowDragClick, true), 350);
  const ids = Array.from(s.parent.children).map(c => c.dataset.exid).filter(Boolean);
  reorderExercises(ids);
  renderPlan();
}

function swallowDragClick(e) {
  e.stopPropagation();
  e.preventDefault();
  window.removeEventListener('click', swallowDragClick, true);
}

// Bringt cycle.exercises in die Reihenfolge der übergebenen IDs. Übungen, die
// nicht in der Liste vorkommen, bleiben erhalten und wandern ans Ende.
function reorderExercises(ids) {
  const cycle = getActiveCycle();
  if (!cycle) return;
  const byId = new Map(cycle.exercises.map(ex => [ex.id, ex]));
  const sorted = [];
  ids.forEach(id => {
    if (byId.has(id)) { sorted.push(byId.get(id)); byId.delete(id); }
  });
  byId.forEach(ex => sorted.push(ex));
  cycle.exercises = sorted;
  saveData();
}

// Lange Zyklen: das Muster der ersten vier Wochen (z.B. 3 + 1) fortsetzen
function repeatWeekTargets() {
  const cycle = getActiveCycle();
  if (!cycle) return;
  const n = cycle.weeks || 12;
  if (!confirm(`Die Ziele von Woche 1–4 auf alle ${n} Wochen übertragen? Spätere Ziele werden überschrieben.`)) return;
  const muster = cycle.weekTargets.slice(0, 4);
  cycle.weekTargets = Array.from({ length: n }, (_, i) => muster[i % 4] || 0);
  saveData();
  renderPlan();
}

function updateWeekTarget(weekIdx, val) {
  const cycle = getActiveCycle();
  cycle.weekTargets[weekIdx] = Math.max(0, parseNum(val) || 0);
  saveData();
  if (currentView === 'dashboard') renderDashboard();
}

// ═══════════════════════════════════════════════
// HISTORY VIEW
// ═══════════════════════════════════════════════
function renderHistory() {
  const el = document.getElementById('historyContent');
  if (ownCycles().length === 0) {
    el.innerHTML = renderLogbook();
    focusLogGrades();
    return;
  }

  const sorted = ownCycles().sort((a,b) => b.startDate.localeCompare(a.startDate));
  el.innerHTML = renderLogbook() + `<div class="section-hdr"><h2>Zyklen</h2></div>` +
    sorted.map(cycle => {
      const wks = cycle.weeks || 12;
      const endDate = parseDate(getCycleEndDate(cycle));
      const totalInt = Array.from({length: wks}, (_,i) => getWeekIntensity(cycle, i)).reduce((a,b)=>a+b,0);
      let sessionDays = 0;
      let completedExercises = 0;
      Object.values(cycle.sessions).forEach(s => {
        if (s.length > 0) {
          sessionDays++;
          completedExercises += s.length;
        }
      });
      const isActive = cycle.id === appData.activeCycleId;
      // % of planned intensity achieved across completed weeks only
      const todayStr = toDateStr(new Date());
      let compTgtSum = 0, compActSum = 0;
      for (let i = 0; i < wks; i++) {
        const wDays = getWeekDates(cycle, i);
        if (wDays[6] < todayStr) {
          compTgtSum += getWeekTarget(cycle, i);
          compActSum += getWeekIntensity(cycle, i);
        }
      }
      const pctStr = compTgtSum > 0 ? Math.round(compActSum / compTgtSum * 100) + '% Ziel' : null;
      return `<div class="cycle-card" onclick="openCycleDetail('${cycle.id}')">
        <div class="cycle-card-hdr">
          <div class="cycle-card-title">${esc(cycle.name)}</div>
          ${isActive ? '<span class="intensity-badge int-green-dark" style="font-size:11px">Aktiv</span>' : ''}
        </div>
        <div class="cycle-dates">${formatDateRange(cycle.startDate, toDateStr(endDate))} · ${wks} Wochen</div>
        <div style="display:flex;gap:16px;margin-top:8px;flex-wrap:wrap">
          <span class="text-muted">${cycleUnit(cycle) === 'int' ? fmtNum(Math.round(totalInt*10)/10) + ' Gesamt-Int.' : fmtAmount(cycle, totalInt) + ' gesamt'}</span>
          <span class="text-muted">${sessionDays} Trainingstage</span>
          <span class="text-muted">${completedExercises} Übungen absolviert</span>
          ${pctStr ? `<span class="text-muted">${pctStr} erreicht</span>` : ''}
        </div>
      </div>`;
    }).join('');
  focusLogGrades();
}

function openCycleDetail(cycleId) {
  const cycle = appData.cycles.find(c => c.id === cycleId);
  if (!cycle) return;

  const content = `
    <div class="modal-title">${esc(cycle.name)}</div>
    <div class="text-muted" style="margin-bottom:16px">Gestartet: ${parseDate(cycle.startDate).toLocaleDateString('de-DE')}</div>

    <div class="card-title">Wochenübersicht · ${unitInfo(cycle).title}</div>
    <div class="target-grid">
      ${Array.from({length: cycle.weeks || 12}, (_,i) => {
        const wint = getWeekIntensity(cycle, i);
        const wtgt = getWeekTarget(cycle, i);
        const wc = intensityClass(wint, wtgt, unitInfo(cycle).tol);
        return `<div class="target-cell read">
          <span class="tc-week">W${i+1}</span>
          <span class="tc-val intensity-badge ${wc}" style="padding:2px 6px;font-size:12px">${fmtNum(wint)}/${fmtNum(wtgt)}</span>
          <span class="tc-date">${formatDay(getWeekDates(cycle, i)[0])}</span>
        </div>`;
      }).join('')}
    </div>

    <div class="divider"></div>
    <div class="card-title">Übungen in diesem Zyklus</div>
    ${(() => {
      const allCats = getAllCategoriesInCycle(cycle);
      return cycle.exercises.map(ex => {
        const cats = exerciseCategories(ex);
        return `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
          <span style="display:flex;align-items:center;gap:6px;font-size:14px;min-width:0;flex-wrap:wrap">
            ${catDotsHtml(cats, allCats, 12)}
            <span>${esc(ex.name)}${cats.length ? ` <span style="color:var(--text-dim);font-size:11px">· ${esc(cats.join(', '))}</span>` : ''}</span>
          </span>
          <span style="font-family:'DM Mono',monospace;font-size:13px;color:var(--accent)">${fmtExAmount(cycle, ex.intensity)}</span>
        </div>`;
      }).join('');
    })()}

    <div class="divider"></div>
    <button class="btn btn-ghost btn-full" onclick="closeModal()">Schließen</button>
  `;
  openModal(content);
}

// ═══════════════════════════════════════════════
// LOGBUCH
// ═══════════════════════════════════════════════
// appData.ascents: [{id, date, scaleId, grade, style, place, name?, note?}]
// grade ist der Index in der Skala (wie bei Assessment-Tests), damit sich
// Grade sortieren und zählen lassen.
const ASCENT_STYLES = { flash: 'Flash', top: 'Top', project: 'Projekt' };
const ASCENT_PLACES = { halle: 'Halle', board: 'Board', fels: 'Fels' };
const LOG_PREVIEW = 10;
let logShowAll = false;

function migrateLogbook(d = appData) {
  let changed = false;
  if (!Array.isArray(d.ascents)) { d.ascents = []; changed = true; }
  if (!Array.isArray(d.weekLibrary)) { d.weekLibrary = []; changed = true; }
  if (changed && d === appData) saveData();
  return changed;
}

// Bringt einen fremden Stand (Sicherungsdatei, Konto-Sicherung) auf den
// aktuellen Aufbau, ohne ihn zu speichern.
function normalizeData(d) {
  if (!Array.isArray(d.cycles)) d.cycles = [];
  if (d.activeCycleId === undefined) d.activeCycleId = null;
  migrateCycles(d);
  migrateAssessments(d);
  migrateLogbook(d);
  return d;
}

function ascentGrade(a) {
  const steps = (SCALES[a.scaleId] || SCALES.font).steps;
  return steps[a.grade] !== undefined ? steps[a.grade] : '?';
}

function sortedAscents() {
  return [...appData.ascents].sort((a, b) =>
    b.date.localeCompare(a.date) || String(b.id).localeCompare(String(a.id)));
}

// Pyramide je Skala: Flash und Top je Grad, vom höchsten Grad abwärts.
// Projekte zählen nicht – sie sind (noch) nicht geschafft.
function gradePyramid(scaleId) {
  const counts = {};
  appData.ascents.forEach(a => {
    if (a.scaleId !== scaleId || a.style === 'project') return;
    const c = counts[a.grade] || (counts[a.grade] = { flash: 0, top: 0 });
    c[a.style === 'flash' ? 'flash' : 'top']++;
  });
  const grades = Object.keys(counts).map(Number).sort((a, b) => b - a);
  return grades.map(g => ({ grade: g, flash: counts[g].flash, top: counts[g].top }));
}

// ── Logbuch-Ansicht ──
// Bewusst schlicht: Grad antippen, fertig. Ein Tipp trägt einen Top für
// heute ein; mit "Flash" vorher als Flash. Gelöscht wird durch Antippen
// eines Eintrags. Ort, Name und Projekte gibt es nicht mehr – ältere
// Einträge damit bleiben erhalten, Projekte zählen nicht.
let logFlash = false;
let logScaleSel = null;
let logDate = null;          // null = heute
let logAdded = null;         // zuletzt eingetragen – für die kurze Bestätigung

function logScale() {
  if (logScaleSel) return logScaleSel;
  const last = sortedAscents()[0];
  return last && SCALES[last.scaleId] ? last.scaleId : 'font';
}

// Der Grad, um den sich das Klettern gerade dreht: Median der letzten 20 Tops
function typicalGrade(scaleId) {
  const g = sortedAscents().filter(a => a.scaleId === scaleId && a.style !== 'project').slice(0, 20).map(a => a.grade).sort((x, y) => x - y);
  return g.length ? g[Math.floor(g.length / 2)] : Math.min(4, SCALES[scaleId].steps.length - 1);
}

function renderPyramid(scaleId) {
  const steps = (SCALES[scaleId] || SCALES.font).steps;
  const rows = gradePyramid(scaleId);
  if (!rows.length) return '';
  const shown = rows.slice(0, 6);
  const max = Math.max(...shown.map(r => r.flash + r.top));
  const total = rows.reduce((s, r) => s + r.flash + r.top, 0);
  return `<div class="card">
    <div class="log-summary">
      <div><div class="log-big">${steps[rows[0].grade]}</div><div class="stat-lbl">Höchster Grad</div></div>
      <div style="text-align:right"><div class="log-big">${total}</div><div class="stat-lbl">${total === 1 ? 'Boulder' : 'Boulder'} gesamt</div></div>
    </div>
    ${shown.map(r => `<div class="pyr-row">
      <span class="pyr-grade">${steps[r.grade]}</span>
      <span class="pyr-bar"><span style="width:${(r.flash + r.top) / max * 100}%"></span></span>
      <span class="pyr-count">${r.flash + r.top}</span>
    </div>`).join('')}
  </div>`;
}

function renderLogbook() {
  const scaleId = logScale();
  const steps = SCALES[scaleId].steps;
  const today = toDateStr(new Date());
  const day = logDate || today;
  const typical = typicalGrade(scaleId);

  // Einträge nach Tag
  const byDay = new Map();
  sortedAscents().filter(a => a.style !== 'project').forEach(a => {
    if (!byDay.has(a.date)) byDay.set(a.date, []);
    byDay.get(a.date).push(a);
  });
  const days = [...byDay.keys()].sort((x, y) => y.localeCompare(x));
  const dayEntries = (byDay.get(day) || []).slice().sort((x, y) => y.grade - x.grade);
  const total = days.reduce((s, d) => s + byDay.get(d).length, 0);
  const chip = a => `<button type="button" class="log-chip ${a.style === 'flash' ? 'flash' : ''} ${logAdded === a.id ? 'new' : ''}"
      onclick="removeAscent('${esc(a.id)}')" title="Antippen zum Löschen">${esc(ascentGrade(a))}${a.style === 'flash' ? '<span class="log-flash">⚡</span>' : ''}</button>`;
  const dayLabel = d => d === today ? 'Heute' : d === addDays(today, -1) ? 'Gestern' : `${DAYS_DE[weekdayOf(d)]}, ${formatDay(d)}`;

  return `
    <div class="section-hdr" style="margin-top:0"><h2>Logbuch</h2>
      <div class="seg seg-mini">${Object.keys(SCALES).map(k =>
        `<button type="button" class="${k === scaleId ? 'on' : ''}" onclick="logScaleSel='${k}';renderHistory()">${k === 'font' ? 'Font' : k === 'vscale' ? 'V' : 'Halle'}</button>`).join('')}</div>
    </div>

    <div class="card log-add">
      <div class="log-add-hdr">
        <span class="card-title" style="margin:0">${day === today ? 'Heute' : dayLabel(day)} geschafft</span>
        <button type="button" class="log-flash-toggle ${logFlash ? 'on' : ''}" onclick="logFlash=!logFlash;renderHistory()">⚡ Flash</button>
      </div>
      <div class="log-grades" data-focus="${typical}">
        ${steps.map((g, i) => `<button type="button" class="log-grade" onclick="quickAddAscent(${i})">${g}</button>`).join('')}
      </div>
      ${dayEntries.length ? `<div class="log-today">${dayEntries.map(chip).join('')}</div>` : ''}
      <div class="log-add-foot">
        <span>${dayEntries.length ? `${dayEntries.length} ${day === today ? 'heute' : 'an diesem Tag'}` : ''}</span>
        <label class="log-date">${day === today ? 'Anderer Tag' : 'Tag'}
          <input type="date" value="${day}" max="${today}" onchange="logDate=this.value===toDateStr(new Date())?null:this.value;renderHistory()">
        </label>
      </div>
    </div>

    ${days.length ? `
      ${renderPyramid(scaleId)}
      <div class="list-group">
        <div class="list-row" onclick="openLogHistory()">
          <div class="list-main"><div class="list-title">Verlauf</div>
            <div class="list-sub">${total} Boulder an ${days.length} ${days.length === 1 ? 'Tag' : 'Tagen'}</div></div>
          <span class="chev">›</span>
        </div>
      </div>`
    : ''}`;
}

// Alle Tage, nach Monaten gegliedert – in einem eigenen Fenster, damit die
// Logbuch-Seite kurz bleibt.
function openLogHistory() {
  openModal('<div id="logHistory"></div>');
  renderLogHistory();
}

function renderLogHistory() {
  const box = document.getElementById('logHistory');
  if (!box) return;
  const today = toDateStr(new Date());
  const byDay = new Map();
  sortedAscents().filter(a => a.style !== 'project').forEach(a => {
    if (!byDay.has(a.date)) byDay.set(a.date, []);
    byDay.get(a.date).push(a);
  });
  const days = [...byDay.keys()].sort((x, y) => y.localeCompare(x));
  const months = [];
  days.forEach(d => {
    const key = d.slice(0, 7);
    if (!months.length || months[months.length - 1].key !== key) months.push({ key, days: [] });
    months[months.length - 1].days.push(d);
  });
  const monthName = key => { const d = parseDate(key + '-01'); return d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }); };
  const label = d => d === today ? 'Heute' : `${DAYS_DE[weekdayOf(d)]}, ${formatDay(d)}`;
  box.innerHTML = `
    <div class="modal-title">Verlauf</div>
    ${months.map(m => `
      <div class="group-label" style="margin-top:14px">${esc(monthName(m.key))}</div>
      <div class="list-group">
        ${m.days.map(d => `<div class="swipe-row" data-delete="removeAscentDay('${d}')"><div class="swipe-action">Löschen</div>
          <div class="log-day swipe-content">
          <div class="log-day-name">${label(d)} <span>${byDay.get(d).length} <button type="button" class="day-del" onclick="removeAscentDay('${d}')" aria-label="Ganzen Tag löschen">Tag löschen</button></span></div>
          <div class="log-chips">${byDay.get(d).sort((x, y) => y.grade - x.grade).map(a => `<button type="button" class="log-chip ${a.style === 'flash' ? 'flash' : ''}"
            onclick="removeAscent('${esc(a.id)}')">${esc(ascentGrade(a))}${a.style === 'flash' ? '<span class="log-flash">⚡</span>' : ''}</button>`).join('')}</div>
        </div></div>`).join('')}
      </div>`).join('') || '<div class="text-muted">Noch keine Einträge.</div>'}
    <button class="btn btn-ghost btn-full" style="margin-top:14px" onclick="closeModal()">Fertig</button>`;
}

function removeAscentDay(date) {
  const n = appData.ascents.filter(a => a.date === date && a.style !== 'project').length;
  if (!n || !confirm(`Alle ${n} Boulder vom ${formatDay(date)} löschen?`)) { renderLogHistory(); return; }
  appData.ascents = appData.ascents.filter(a => !(a.date === date && a.style !== 'project'));
  saveData();
  renderHistory();
  renderLogHistory();
}

function quickAddAscent(grade) {
  const a = { id: newId(), date: logDate || toDateStr(new Date()), scaleId: logScale(), grade, style: logFlash ? 'flash' : 'top' };
  appData.ascents.push(a);
  logAdded = a.id;
  logFlash = false;
  saveData();
  renderHistory();
  if (navigator.vibrate) navigator.vibrate(10);
  setTimeout(() => { if (logAdded === a.id) { logAdded = null; } }, 1500);
}

function removeAscent(id) {
  const a = appData.ascents.find(x => x.id === id);
  if (!a) return;
  if (!confirm(`${ascentGrade(a)}${a.style === 'flash' ? ' (Flash)' : ''} vom ${formatDay(a.date)} löschen?`)) return;
  appData.ascents = appData.ascents.filter(x => x.id !== id);
  saveData();
  renderHistory();
  renderLogHistory();
}

// Die Grad-Leiste so schieben, dass der übliche Grad sichtbar ist
function focusLogGrades() {
  const row = document.querySelector && document.querySelector('.log-grades');
  if (!row || !row.children) return;
  const btn = row.children[parseInt(row.dataset.focus, 10) || 0];
  if (btn) row.scrollLeft = Math.max(0, btn.offsetLeft - row.clientWidth / 2 + btn.offsetWidth / 2);
}

// ── Kleine Umschalter (Flash/Top/Projekt, Halle/Board/Fels) ──
function segHtml(id, options, current) {
  return `<div class="seg" id="${id}" data-val="${current}">${Object.keys(options).map(k =>
    `<button type="button" data-v="${k}" class="${k === current ? 'on' : ''}" onclick="pickSeg('${id}','${k}')">${options[k]}</button>`).join('')}</div>`;
}

function pickSeg(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  el.dataset.val = val;
  if (el.querySelectorAll) el.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === val));
}


// ═══════════════════════════════════════════════
// SETTINGS VIEW
// ═══════════════════════════════════════════════
function renderSettings() {
  const el = document.getElementById('settingsContent');
  const cycle = getActiveCycle();
  const plan = isPlanMode(cycle);
  const undo = getUndoInfo();
  el.innerHTML = `
    <div class="group-label" style="margin-top:0">Konto</div>
    <div class="list-group" id="cloudBox">
      <div class="list-row"><div class="list-main"><div class="list-sub">Konto wird geladen …</div></div></div>
    </div>

    <div class="group-label">Training</div>
    <div class="list-group">
      <div class="list-row" onclick="openCyclesModal()">
        <div class="list-main">
          <div class="list-title">${cycle ? esc(cycle.name) : 'Kein aktiver Zyklus'}</div>
          <div class="list-sub">${cycle
            ? (isCyclePaused(cycle) ? 'Pausiert · bis ' + formatDay(getCycleEndDate(cycle))
              : cycleStatus(cycle) === 'future' ? `Startet am ${formatDay(cycle.startDate)}`
              : cycleStatus(cycle) === 'ended' ? `Beendet am ${formatDay(getCycleEndDate(cycle))}`
              : `Woche ${getCurrentWeekIndex(cycle) + 1} von ${cycle.weeks || 12} · bis ${formatDay(getCycleEndDate(cycle))}`)
            : `${appData.cycles.length} ${appData.cycles.length === 1 ? 'Zyklus' : 'Zyklen'} gespeichert`}</div>
        </div>
        <span class="chev">›</span>
      </div>
      ${cycle ? `
      <div class="list-row" onclick="togglePlanMode()">
        <div class="list-main">
          <div class="list-title">Wochenplan</div>
        </div>
        <span class="switch ${plan ? 'on' : ''}"></span>
      </div>` : ''}
      <div class="list-row" onclick="openNewCycleModal()">
        <div class="list-main"><div class="list-title" style="color:var(--accent)">Neuen Zyklus starten</div></div>
      </div>
      <div class="list-row" onclick="openImportPlanModal()">
        <div class="list-main"><div class="list-title">Plan importieren</div></div>
        <span class="chev">›</span>
      </div>
    </div>

    <div class="group-label">Pläne für andere</div>
    <div class="list-group">
      ${appData.cycles.filter(c => c.forOther).map(c => `<div class="swipe-row" data-delete="deleteDraft('${c.id}')">
        <div class="swipe-action">Löschen</div>
        <div class="swipe-content list-row" onclick="editDraft('${c.id}')">
          <div class="list-main"><div class="list-title">${esc(c.name)}</div>
            <div class="list-sub">${c.weeks || 12} Wochen · ${weekPlans(c).length} ${weekPlans(c).length === 1 ? 'Wochenart' : 'Wochenarten'}</div></div>
          <button class="del-btn" onclick="event.stopPropagation();deleteDraft('${c.id}')" aria-label="${esc(c.name)} löschen">×</button>
        </div>
      </div>`).join('')}
      <div class="list-row" onclick="openNewDraftModal()">
        <div class="list-main"><div class="list-title" style="color:var(--accent)">Plan für jemand anderen erstellen</div></div>
      </div>
    </div>

    <div class="group-label">Daten</div>
    <div class="list-group">
      <div class="list-row" onclick="exportData()">
        <div class="list-main"><div class="list-title">Sicherung exportieren</div></div>
        <span class="chev">›</span>
      </div>
      <div class="list-row" onclick="importDataPrompt()">
        <div class="list-main"><div class="list-title">Sicherung wiederherstellen</div></div>
        <span class="chev">›</span>
      </div>
      ${undo ? `<div class="list-row" onclick="undoImport()">
        <div class="list-main"><div class="list-title">Wiederherstellen rückgängig machen</div><div class="list-sub">Stand vom ${formatDay(toDateStr(new Date(undo.at)))}</div></div>
        <span class="chev">›</span>
      </div>` : ''}
    </div>

    <div class="settings-foot">Boulder Training${typeof APP_VERSION !== 'undefined'
      ? `<br>Version ${esc(APP_VERSION.name)} · ${esc(formatVersionDate(APP_VERSION.date))}` : ''}</div>
  `;
  // Die Konto-Zeile füllt cloud.js; ohne Firebase bleibt der Platzhalter.
  if (window.renderCloudBox) window.renderCloudBox();
}

// "2026-10-08 19:52" → "8. Okt 2026, 19:52 Uhr"
function formatVersionDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/.exec(str || '');
  if (!m) return str || '';
  return `${parseInt(m[3], 10)}. ${MONTHS_DE[parseInt(m[2], 10) - 1]} ${m[1]}, ${m[4]} Uhr`;
}

// ── Zyklen verwalten ──
function openCyclesModal() {
  openModal(`<div id="cyclesSheet"></div>`);
  renderCyclesSheet();
}

function renderCyclesSheet() {
  const box = document.getElementById('cyclesSheet');
  if (!box) return;
  const cycles = ownCycles().sort((a, b) => b.startDate.localeCompare(a.startDate));
  box.innerHTML = `
    <div class="modal-title">Zyklen</div>
    ${cycles.length ? `<div class="list-group">
      ${cycles.map(c => `
        <div class="list-row" onclick="setActiveCycle('${c.id}')">
          <div class="list-main">
            <div class="list-title">${esc(c.name)}</div>
            <div class="list-sub">${formatDateRange(c.startDate, getCycleEndDate(c))}</div>
          </div>
          ${c.id === appData.activeCycleId ? `<span class="list-check">${CHECK_SVG.replace('#000', 'currentColor')}</span>` : ''}
          <button class="del-btn" onclick="event.stopPropagation();deleteCycle('${c.id}')" title="Zyklus löschen">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/></svg>
          </button>
        </div>`).join('')}
    </div>`
    : `<div class="text-muted" style="margin-bottom:14px">Noch keine Zyklen.</div>`}
    ${getActiveCycle() ? `<button class="btn btn-ghost btn-full" style="margin-top:14px;color:var(--red)" onclick="confirmEndCycle()">Aktiven Zyklus abschließen</button>` : ''}
    <button class="btn btn-ghost btn-full" style="margin-top:10px" onclick="closeModal()">Fertig</button>
  `;
}

// mode: 'plan' oder 'free' vorauswählen (aus der Startseite); sonst wie der
// aktive Zyklus.
function openNewCycleModal(mode) {
  const active = getActiveCycle();
  const m = mode || (isPlanMode(active) ? 'plan' : 'free');
  const otherCycles = appData.cycles;
  const content = `
    <div class="modal-title">Neuen Zyklus starten</div>
    <div class="field">
      <label>Name des Zyklus</label>
      <input type="text" id="newCycleName" placeholder="z.B. Frühjahr 2027">
    </div>
    <div class="field">
      <label>Art</label>
      <select id="newCycleMode" onchange="onCopySelect()">
        <option value="plan" ${m === 'plan' ? 'selected' : ''}>Wochenplan – feste Trainingstage</option>
        <option value="free" ${m === 'free' ? 'selected' : ''}>Frei – eintragen, was du gemacht hast</option>
      </select>
    </div>
    <div class="field">
      <label>Gezählt wird in</label>
      <div class="seg" id="newCycleUnit" data-val="${cycleUnit(active)}">
        ${Object.keys(CYCLE_UNITS).map(k => `<button type="button" data-v="${k}" class="${k === cycleUnit(active) ? 'on' : ''}" onclick="pickSeg('newCycleUnit','${k}')">${CYCLE_UNITS[k].name}</button>`).join('')}
      </div>
    </div>
    <div class="field">
      <label>Start mit</label>
      <select id="copyFromCycle" onchange="onCopySelect(true)">
        <option value="">Leer</option>
        <optgroup label="Vorlagen">
          ${PLAN_TEMPLATES.map(t => `<option value="tpl:${t.id}">${esc(t.name)}</option>`).join('')}
        </optgroup>
        ${otherCycles.length ? `<optgroup label="Kopie von">
          ${otherCycles.map(c => `<option value="${c.id}">${esc(c.name)} (${c.exercises.length} Übungen, ${c.weeks||12} Wo.)</option>`).join('')}
        </optgroup>` : ''}
      </select>
      <div id="copyInfo" style="font-size:11px;color:var(--text-muted);margin-top:6px;line-height:1.5"></div>
    </div>
    <div class="field">
      <label>Startdatum (beliebiger Wochentag)</label>
      <input type="date" id="newCycleDate" value="${toDateStr(new Date())}">
    </div>
    <div class="field">
      <label>Anzahl Wochen (1–52)</label>
      <input type="number" id="newCycleWeeks" min="1" max="52" step="1" value="12">
    </div>
    <div class="row" style="margin-top:4px">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="createCycle()">Starten</button>
    </div>
  `;
  openModal(content);
  onCopySelect();
}

function getTemplate(value) {
  if (!value || !value.startsWith('tpl:')) return null;
  return PLAN_TEMPLATES.find(t => t.id === value.slice(4)) || null;
}

// Wert einer Vorlagen-Übung in der gewählten Einheit
function templateAmount(ex, unit) {
  return convertAmount(ex.intensity, 'int', unit);
}

// changed: true, wenn die Auswahl gerade geändert wurde (dann Wochenzahl und
// Art übernehmen), sonst nur den Hinweis auffrischen.
function onCopySelect(changed) {
  const value = document.getElementById('copyFromCycle')?.value;
  const info = document.getElementById('copyInfo');
  const wInput = document.getElementById('newCycleWeeks');
  const modeSel = document.getElementById('newCycleMode');
  const tpl = getTemplate(value);
  const src = !tpl && value ? appData.cycles.find(c => c.id === value) : null;
  if (changed && tpl) {
    if (wInput) wInput.value = tpl.weeks;
    if (modeSel) modeSel.value = 'plan';
  }
  if (changed && src && wInput) wInput.value = src.weeks || 12;
  // Die Werte einer Kopie stehen in der Einheit des Originals
  if (changed && src) pickSeg('newCycleUnit', cycleUnit(src));
  if (!info) return;
  if (tpl) {
    info.innerHTML = `${esc(tpl.level)}<br>${tpl.exercises.length} Übungen in ${tpl.plan.length} Wochen: ${tpl.plan.map(w => esc(w.name)).join(', ')}. Ein Vorschlag – alles lässt sich danach anpassen.`;
  } else if (src) {
    info.textContent = `Übungen, geplante Wochen, Wochenziele und Wochenanzahl werden übernommen. Gezählt wird wie dort in ${unitInfo(src).name}.`;
  } else {
    info.textContent = '';
  }
}

function createCycle() {
  const copyFromId = document.getElementById('copyFromCycle')?.value;
  const tpl = getTemplate(copyFromId);
  const name = document.getElementById('newCycleName')?.value?.trim() || (tpl ? tpl.name.split(' · ')[0] : '');
  const date = document.getElementById('newCycleDate')?.value;
  const weeksRaw = document.getElementById('newCycleWeeks')?.value;
  const weeks = Math.max(1, Math.min(52, parseInt(weeksRaw) || 12));
  const mode = document.getElementById('newCycleMode')?.value;
  if (!name) { alert('Bitte einen Namen eingeben.'); return; }
  const cycle = getDefaultCycle(name, weeks);
  if (date) cycle.startDate = date;
  if (mode === 'plan') cycle.mode = 'plan';
  const unit = document.getElementById('newCycleUnit')?.dataset?.val;
  if (unit && unit !== 'int' && CYCLE_UNITS[unit]) cycle.unit = unit;

  if (tpl) {
    applyTemplate(cycle, tpl);
  } else if (copyFromId) {
    const src = appData.cycles.find(c => c.id === copyFromId);
    if (src) {
      const idMap = {};
      cycle.exercises = src.exercises.map(ex => { const c = cloneExercise(ex); idMap[ex.id] = c.id; return c; });
      copyPlanStructure(src, cycle, idMap);
      if (isPlanMode(src)) cycle.mode = 'plan';
      // Die Werte sind in der Einheit des Originals
      if (cycleUnit(src) !== 'int') cycle.unit = cycleUnit(src); else delete cycle.unit;
      // Copy week targets, truncating or padding as needed
      const srcTargets = src.weekTargets || [];
      cycle.weekTargets = Array(weeks).fill(0).map((_, i) => srcTargets[i] || 0);
    }
  }

  appData.cycles.push(cycle);
  appData.activeCycleId = cycle.id;
  saveData();
  closeModal();
  render();
  // Leerer Wochenplan: gleich fertige Wochen zur Auswahl anbieten
  if (isPlanMode(cycle) && !cycle.exercises.length) setTimeout(() => { switchView('plan'); openAddWeekSheet(); }, 300);
}

// Kopie einer Übung mit neuer ID – für Vorlagen, kopierte Zyklen und
// geteilte Pläne. Übernimmt nur den Plan, keine Trainingsdaten.
function cloneExercise(ex) {
  const out = {
    id: Date.now().toString() + Math.random().toString(36).slice(2,7),
    name: ex.name,
    categories: exerciseCategories(ex),   // eigene Kopie, nicht dieselbe Liste
    intensity: ex.intensity
  };
  if (ex.desc) out.desc = ex.desc;
  if (ex.measure) { out.measure = true; out.unit = ex.unit || ''; }
  return out;
}

// ── Pläne für andere ──
function openNewDraftModal() {
  const own = ownCycles();
  openModal(`
    <div class="modal-title" style="margin-bottom:4px">Plan für jemand anderen</div>
    <div class="field"><label>Für wen?</label>
      <input type="text" id="draftWho" placeholder="z.B. Lisa" maxlength="40"></div>
    <div class="row">
      <div class="field"><label>Wochen</label><input type="number" id="draftWeeks" min="1" max="52" value="8"></div>
      <div class="field"><label>Gezählt in</label>
        <select id="draftUnit">${Object.keys(CYCLE_UNITS).map(k => `<option value="${k}">${CYCLE_UNITS[k].name}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Start mit</label>
      <select id="draftFrom">
        <option value="">Leer – Wochen auswählen</option>
        <optgroup label="Vorlagen">${PLAN_TEMPLATES.map(t => `<option value="tpl:${t.id}">${esc(t.name)}</option>`).join('')}</optgroup>
        ${own.length ? `<optgroup label="Kopie von">${own.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</optgroup>` : ''}
      </select>
    </div>
    <button class="btn btn-primary btn-full" onclick="createDraft()">Plan erstellen</button>
    <button class="btn-link" onclick="closeModal()">Abbrechen</button>
  `);
}

function createDraft() {
  const who = (document.getElementById('draftWho')?.value || '').trim();
  const weeks = Math.max(1, Math.min(52, parseInt(document.getElementById('draftWeeks')?.value, 10) || 8));
  const unit = document.getElementById('draftUnit')?.value || 'int';
  const from = document.getElementById('draftFrom')?.value || '';
  const cycle = getDefaultCycle(who ? `Plan für ${who}` : 'Plan für jemand anderen', weeks);
  cycle.id = newId();
  cycle.forOther = who || '?';
  cycle.mode = 'plan';
  if (unit !== 'int') cycle.unit = unit;
  const tpl = getTemplate(from);
  if (tpl) applyTemplate(cycle, tpl);
  else if (from) {
    const src = appData.cycles.find(c => c.id === from);
    if (src) {
      const idMap = {};
      cycle.exercises = src.exercises.map(ex => { const c = cloneExercise(ex); idMap[ex.id] = c.id; return c; });
      copyPlanStructure(src, cycle, idMap);
      if (cycleUnit(src) !== 'int') cycle.unit = cycleUnit(src); else delete cycle.unit;
    }
  }
  appData.cycles.push(cycle);
  saveData();
  closeModal();
  editDraft(cycle.id);
  if (!cycle.exercises.length) setTimeout(openAddWeekSheet, 300);
}

function editDraft(id) {
  switchView('plan');
  draftEditId = id;
  weekSel = [];
  render();
}

function closeDraft() {
  draftEditId = null;
  switchView('settings');
}

function deleteDraft(id) {
  const c = appData.cycles.find(x => x.id === id);
  if (!c || !confirm(`„${c.name}" löschen?`)) { render(); return; }
  appData.cycles = appData.cycles.filter(x => x.id !== id);
  if (draftEditId === id) draftEditId = null;
  saveData();
  render();
}

function togglePlanMode() {
  const cycle = getActiveCycle();
  if (!cycle) return;
  // Die geplanten Wochen bleiben beim Ausschalten erhalten; sie gelten
  // wieder, sobald der Wochenplan erneut eingeschaltet wird.
  if (isPlanMode(cycle)) delete cycle.mode; else cycle.mode = 'plan';
  saveData();
  render();
  // Frisch eingeschaltet und noch nichts geplant: beim Start helfen
  if (isPlanMode(cycle)) startPlanning(cycle);
}

function setActiveCycle(id) {
  appData.activeCycleId = id;
  saveData();
  render();
  renderCyclesSheet();
}

function deleteCycle(id) {
  const cycle = appData.cycles.find(c => c.id === id);
  if (!cycle) return;
  if (!confirm(`Zyklus "${cycle.name}" wirklich endgültig löschen?\n\nAlle zugehörigen Trainingsdaten gehen verloren.`)) return;
  appData.cycles = appData.cycles.filter(c => c.id !== id);
  if (appData.activeCycleId === id) {
    const own = ownCycles();
    appData.activeCycleId = own.length > 0 ? own[own.length - 1].id : null;
  }
  saveData();
  render();
  renderCyclesSheet();
}

function confirmEndCycle() {
  if (!confirm('Zyklus wirklich abschließen? Du kannst danach einen neuen starten. Die Daten bleiben erhalten.')) return;
  appData.activeCycleId = null;
  saveData();
  render();
  renderCyclesSheet();
}

// ═══════════════════════════════════════════════
// SICHERUNG
// ═══════════════════════════════════════════════
// Das Konto gleicht ab, es sichert nicht: Ein Versehen wird genauso auf alle
// Geräte übertragen. Deshalb gibt es weiter die Sicherung als Datei, und vor
// jedem Wiederherstellen merkt sich die App den bisherigen Stand.
const UNDO_KEY = 'boulderApp_vorImport';
let pendingRestore = null;

function exportData() {
  const json = JSON.stringify(appData, null, 2);
  const blob = new Blob([json], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `boulder-sicherung-${toDateStr(new Date())}.json`; a.click();
}

function dataSummary(d) {
  const days = new Set();
  d.cycles.forEach(c => Object.keys(c.sessions || {}).forEach(k => {
    if ((c.sessions[k] || []).length) days.add(k);
  }));
  const n = (x, one, many) => `${x} ${x === 1 ? one : many}`;
  return [n(d.cycles.length, 'Zyklus', 'Zyklen'), n(days.size, 'Trainingstag', 'Trainingstage'),
          n((d.assessments || []).length, 'Messung', 'Messungen'), n((d.ascents || []).length, 'Boulder', 'Boulder')].join(' · ');
}

function importDataPrompt() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json,application/json';
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      let data;
      try { data = JSON.parse(ev.target.result); } catch { data = null; }
      if (!data || !Array.isArray(data.cycles)) { alert('Diese Datei ist keine Sicherung der Boulder-App.'); return; }
      openRestoreModal(normalizeData(data), 'Datei ' + file.name);
    };
    reader.readAsText(file);
  };
  input.click();
}

// source: Herkunft für die Anzeige, z.B. "Datei …" oder "Sicherung vom …"
function openRestoreModal(data, source) {
  pendingRestore = data;
  openModal(`
    <div class="modal-title">Sicherung wiederherstellen</div>
    <div class="text-muted" style="margin-bottom:4px">${esc(source)}</div>
    <div class="text-muted" style="margin-bottom:16px;font-size:12px">${esc(dataSummary(data))}</div>
    <div class="list-group">
      <div class="list-row" onclick="applyRestore('merge')">
        <div class="list-main"><div class="list-title">Hinzufügen</div></div>
        <span class="chev">›</span>
      </div>
      <div class="list-row" onclick="applyRestore('replace')">
        <div class="list-main"><div class="list-title" style="color:var(--red)">Alles ersetzen</div></div>
        <span class="chev">›</span>
      </div>
    </div>
    <button class="btn btn-ghost btn-full" style="margin-top:14px" onclick="closeModal()">Abbrechen</button>`);
}

// Gleicher Eintrag in beiden: der Stand auf dem Gerät gewinnt. Was nur in der
// Sicherung steht – ein Zyklus, ein Haken, ein Boulder –, kommt dazu.
function mergeData(current, incoming) {
  return fromDocs(Object.assign({}, toDocs(incoming), toDocs(current)));
}

function applyRestore(mode) {
  if (!pendingRestore) return;
  try {
    localStorage.setItem(UNDO_KEY, JSON.stringify({ at: new Date().toISOString(), data: appData }));
  } catch (e) {}
  appData = normalizeData(mode === 'merge' ? mergeData(appData, pendingRestore) : pendingRestore);
  pendingRestore = null;
  saveData();
  closeModal();
  render();
}

function getUndoInfo() {
  try {
    const raw = localStorage.getItem(UNDO_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function undoImport() {
  const undo = getUndoInfo();
  if (!undo || !undo.data) return;
  if (!confirm('Den Stand von vor dem letzten Wiederherstellen zurückholen?')) return;
  appData = normalizeData(undo.data);
  try { localStorage.removeItem(UNDO_KEY); } catch (e) {}
  saveData();
  render();
}

// ═══════════════════════════════════════════════
// PLÄNE TEILEN
// ═══════════════════════════════════════════════
// Ein Trainer schickt einen Plan als Link. Der Plan steckt komprimiert im Link
// selbst (nach dem #, das nie an einen Server geht) – es braucht dafür weder
// ein Konto noch eine Verbindung zwischen den Konten. Mitgeschickt wird nur
// der Plan: Übungen, Tage, Beschreibungen, Wochenziele. Keine Trainingsdaten.
const PLAN_LIMITS = { name: 80, author: 60, note: 600, desc: 600, unit: 12, cat: 30, cats: 5, exercises: 40, plans: 12, items: 60 };

// Form eines geteilten Plans (v2):
//   { v: 2, name, unit, weeks, weekTargets, author?, note?,
//     exercises: [{ name, categories, intensity, desc?, measure?, unit? }],
//     plans: [{ name, items: [{ ex: Index in exercises, days, amount?, note? }] }],
//     assign: [Index in plans oder -1, je Zykluswoche] }
// Links der ersten Fassung (v1) hatten die Tage an den Übungen; daraus wird
// beim Einlesen eine "Standardwoche".
function planFromCycle(cycle, author, note) {
  const weeks = cycle.weeks || 12;
  const exIndex = new Map(cycle.exercises.map((ex, i) => [ex.id, i]));
  const plans = weekPlans(cycle);
  const plan = {
    v: 2,
    name: cycle.name,
    unit: cycleUnit(cycle),
    weeks,
    weekTargets: (cycle.weekTargets || []).slice(0, weeks),
    exercises: cycle.exercises.map(ex => {
      const o = { name: ex.name, categories: exerciseCategories(ex), intensity: parseFloat(ex.intensity) || 0 };
      if (ex.desc) o.desc = ex.desc;
      if (ex.measure) { o.measure = true; o.unit = ex.unit || ''; }
      return o;
    }),
    plans: plans.map(p => ({ name: p.name, items: p.items.filter(it => exIndex.has(it.exId)).map(it => {
      const o = { ex: exIndex.get(it.exId), days: (it.days || []).slice() };
      if (it.amount !== undefined) o.amount = it.amount;
      if (it.note) o.note = it.note;
      return o;
    }) })),
    assign: Array.from({ length: weeks }, (_, i) => plans.findIndex(p => p.id === (cycle.weekAssign || [])[i]))
  };
  if (author) plan.author = author;
  if (note) plan.note = note;
  return plan;
}

// Ein Plan aus einem Link ist fremde Eingabe: nur bekannte Felder mit
// passenden Typen übernehmen, Längen begrenzen. Wirft bei Unbrauchbarem.
function validatePlan(p) {
  const str = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';
  const num = v => (typeof v === 'number' && isFinite(v) && v >= 0) ? Math.min(v, 1000) : 0;
  const dayList = d => Array.isArray(d) ? [...new Set(d.filter(x => Number.isInteger(x) && x >= 0 && x <= 6))].sort() : [];
  if (!p || typeof p !== 'object' || !Array.isArray(p.exercises)) throw new Error('kein Plan');
  const L = PLAN_LIMITS;
  const weeks = Math.max(1, Math.min(52, parseInt(p.weeks, 10) || 12));
  const rawEx = p.exercises.slice(0, L.exercises);
  const indexMap = [];   // Index im Link → Index nach dem Bereinigen
  const exercises = [];
  rawEx.forEach((ex, i) => {
    if (!ex || typeof ex !== 'object') return;
    const name = str(ex.name, L.name);
    if (!name) return;
    const o = {
      name,
      categories: (Array.isArray(ex.categories) ? ex.categories : []).map(c => str(c, L.cat)).filter(Boolean).slice(0, L.cats),
      intensity: num(ex.intensity)
    };
    if (str(ex.desc, L.desc)) o.desc = str(ex.desc, L.desc);
    if (ex.measure === true) { o.measure = true; o.unit = str(ex.unit, L.unit); }
    indexMap[i] = exercises.length;
    exercises.push(o);
  });
  if (!exercises.length) throw new Error('keine Übungen');

  let plans = [];
  let assign = Array(weeks).fill(-1);
  if (Array.isArray(p.plans)) {
    plans = p.plans.slice(0, L.plans).map(pl => ({
      name: str(pl && pl.name, L.name) || 'Woche',
      items: (pl && Array.isArray(pl.items) ? pl.items : []).slice(0, L.items).map(it => {
        if (!it || !Number.isInteger(it.ex) || indexMap[it.ex] === undefined) return null;
        const days = dayList(it.days);
        if (!days.length) return null;
        const o = { ex: indexMap[it.ex], days };
        if (typeof it.amount === 'number') o.amount = num(it.amount);
        if (str(it.note, L.desc)) o.note = str(it.note, L.desc);
        return o;
      }).filter(Boolean)
    }));
    if (Array.isArray(p.assign)) {
      assign = assign.map((_, i) => Number.isInteger(p.assign[i]) && p.assign[i] >= 0 && p.assign[i] < plans.length ? p.assign[i] : -1);
    }
  } else {
    // v1: Tage an den Übungen → eine Standardwoche für alle Wochen
    const items = rawEx.map((ex, i) => ex && indexMap[i] !== undefined && dayList(ex.days).length
      ? { ex: indexMap[i], days: dayList(ex.days) } : null).filter(Boolean);
    if (items.length) { plans = [{ name: 'Standardwoche', items }]; assign = assign.map(() => 0); }
  }

  const plan = {
    v: 2,
    name: str(p.name, L.name) || 'Trainingsplan',
    unit: CYCLE_UNITS[p.unit] ? p.unit : 'int',
    weeks,
    weekTargets: Array.from({ length: weeks }, (_, i) => num(Array.isArray(p.weekTargets) ? p.weekTargets[i] : 0)),
    exercises,
    plans,
    assign
  };
  if (str(p.author, L.author)) plan.author = str(p.author, L.author);
  if (str(p.note, L.note)) plan.note = str(p.note, L.note);
  return plan;
}

function b64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipeBytes(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

// "z…" komprimiert, "j…" unkomprimiert (für Browser ohne CompressionStream)
async function encodePlan(plan) {
  const bytes = new TextEncoder().encode(JSON.stringify(plan));
  if (typeof CompressionStream === 'function') {
    try { return 'z' + b64url(await pipeBytes(bytes, new CompressionStream('deflate-raw'))); } catch (e) {}
  }
  return 'j' + b64url(bytes);
}

// Nimmt den ganzen Link oder nur den Code.
async function decodePlan(text) {
  const t = String(text || '').trim();
  const m = t.match(/plan=([A-Za-z0-9_-]+)/);
  const code = m ? m[1] : (/^[zj][A-Za-z0-9_-]+$/.test(t) ? t : '');
  if (!code) throw new Error('kein Code');
  let bytes = fromB64url(code.slice(1));
  if (code[0] === 'z') bytes = await pipeBytes(bytes, new DecompressionStream('deflate-raw'));
  return validatePlan(JSON.parse(new TextDecoder().decode(bytes)));
}

function planLink(code) {
  return location.origin + location.pathname + '#plan=' + code;
}

const SHARE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"/></svg>';

function openSharePlanModal() {
  const cycle = getActiveCycle();
  if (!cycle || !cycle.exercises.length) return;
  let author = '';
  try { author = localStorage.getItem('boulderPlanAuthor') || ''; } catch (e) {}
  openModal(`
    <div class="modal-title">Plan teilen</div>
    <div class="text-muted" style="margin-bottom:16px">${esc(cycle.name)}</div>
    <div class="field"><label>Dein Name (optional)</label>
      <input type="text" id="sharePlanAuthor" maxlength="${PLAN_LIMITS.author}" value="${esc(author)}" placeholder="z.B. Trainerin Lisa"></div>
    <div class="field"><label>Hinweis (optional)</label>
      <textarea id="sharePlanNote" rows="2" maxlength="${PLAN_LIMITS.note}" placeholder="z.B. Vor jeder Einheit 20 min aufwärmen."></textarea></div>
    <div id="shareResult"></div>
    <button class="btn btn-primary btn-full" onclick="sharePlan()">${SHARE_ICON} Link teilen</button>
    <button class="btn-link" onclick="closeModal()">Abbrechen</button>
  `);
}

async function sharePlan() {
  const cycle = getActiveCycle();
  if (!cycle) return;
  const author = document.getElementById('sharePlanAuthor')?.value?.trim() || '';
  const note = document.getElementById('sharePlanNote')?.value?.trim() || '';
  try { localStorage.setItem('boulderPlanAuthor', author); } catch (e) {}
  const url = planLink(await encodePlan(planFromCycle(cycle, author, note)));
  const box = document.getElementById('shareResult');
  // Auf iPhone und Mac das Teilen-Menü des Systems, sonst in die Zwischenablage
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Trainingsplan: ' + cycle.name, text: `Trainingsplan „${cycle.name}" für die Boulder-App`, url });
      return closeModal();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  let copied = false;
  try { await navigator.clipboard.writeText(url); copied = true; } catch (e) {}
  if (box) box.innerHTML = `
    ${copied ? `<div class="sheet-notice">Link kopiert</div>` : ''}
    <div class="field"><input type="text" id="sharePlanUrl" readonly value="${esc(url)}" onclick="this.select()"></div>`;
}

function openImportPlanModal() {
  openModal(`
    <div class="modal-title">Plan importieren</div>
    <div class="field">
      <textarea id="planCode" rows="3" placeholder="https://…#plan=…" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
    </div>
    ${navigator.clipboard && navigator.clipboard.readText
      ? `<button class="btn btn-ghost btn-full" style="margin-bottom:10px" onclick="pastePlanCode()">Aus Zwischenablage einfügen</button>` : ''}
    <div id="planCodeErr" class="sheet-error"></div>
    <button class="btn btn-primary btn-full" onclick="readPlanCode()">Weiter</button>
    <button class="btn-link" onclick="closeModal()">Abbrechen</button>
  `);
}

async function pastePlanCode() {
  try {
    const t = await navigator.clipboard.readText();
    const el = document.getElementById('planCode');
    if (el) el.value = t;
    readPlanCode();
  } catch (e) {}
}

async function readPlanCode() {
  const text = document.getElementById('planCode')?.value || '';
  try {
    openPlanPreview(await decodePlan(text));
  } catch (e) {
    const err = document.getElementById('planCodeErr');
    if (err) err.textContent = 'Das ist kein gültiger Plan-Link. Bitte den ganzen Link einfügen.';
  }
}

let pendingPlan = null;

// fromLink: der Plan kam über einen geöffneten Link (Browser). Auf dem iPhone
// ist das Safari und nicht die App vom Home-Bildschirm – die haben getrennte
// Speicher. Dann zusätzlich erklären, wie der Plan in die App kommt.
function openPlanPreview(plan, fromLink) {
  pendingPlan = plan;
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent || '');
  // Je Woche des Plans: Name, wann sie gilt, was an welchem Tag dran ist
  const weekCards = plan.plans.map((w, k) => {
    const weeksOf = plan.assign.map((a, i) => a === k ? i : -1).filter(i => i >= 0);
    const rows = DAYS_DE.map((d, day) => {
      const names = w.items.filter(it => it.days.includes(day)).map(it => esc(plan.exercises[it.ex].name));
      return names.length ? `<div class="plan-day"><span class="plan-wd">${d}</span><span>${names.join(', ')}</span></div>` : '';
    }).join('');
    return `<div class="card">
      <div class="card-title" style="display:flex;align-items:center;gap:8px">
        <span class="plan-swatch" style="background:${WEEK_COLORS[k % WEEK_COLORS.length]}"></span>${esc(w.name)}
        <span style="text-transform:none;letter-spacing:0;color:var(--text-dim)">${weeksOf.length ? '· Woche ' + formatWeekRanges(weeksOf) : ''}</span>
      </div>${rows}</div>`;
  }).join('');
  openModal(`
    <div class="modal-title" style="margin-bottom:4px">${esc(plan.name)}</div>
    <div class="text-muted" style="margin-bottom:14px">${plan.author ? 'von ' + esc(plan.author) + ' · ' : ''}${plan.weeks} ${plan.weeks === 1 ? 'Woche' : 'Wochen'} · ${plan.exercises.length} Übungen · in ${unitInfo(plan).name}</div>
    ${fromLink && ios && !standalone ? `
      <div class="sheet-notice" style="line-height:1.5">Für die App vom Home-Bildschirm: Link kopieren, dort unter Einstellungen → Plan importieren einfügen.
        <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="navigator.clipboard.writeText(location.href.split('#')[0] + '#plan=' + (window.__planCode || ''));this.textContent='Kopiert'">Link kopieren</button>
      </div>` : ''}
    ${plan.note ? `<div class="card" style="font-size:14px;line-height:1.5">${esc(plan.note)}</div>` : ''}
    ${weekCards}
    <div class="list-group" style="margin-bottom:16px">
      ${plan.exercises.map(ex => `<div class="list-row" style="cursor:default;align-items:flex-start">
        <div class="list-main">
          <div class="list-title">${esc(ex.name)}</div>
          ${ex.desc ? `<div class="list-sub" style="display:block;line-height:1.4">${esc(ex.desc)}</div>` : ''}
        </div>
        <span class="exercise-int" style="margin:2px 0 0">${fmtExAmount(plan, ex.intensity)}</span>
      </div>`).join('')}
    </div>
    <div class="field"><label>Start am</label><input type="date" id="planStart" value="${toDateStr(new Date())}"></div>
    <button class="btn btn-primary btn-full" onclick="startImportedPlan()">Als neuen Zyklus starten</button>
    <button class="btn-link" onclick="closeModal()">Abbrechen</button>
  `);
}

function startImportedPlan() {
  const plan = pendingPlan;
  if (!plan) return;
  const cycle = getDefaultCycle(plan.name, plan.weeks);
  const start = document.getElementById('planStart')?.value;
  if (start) cycle.startDate = start;
  if (plan.unit && plan.unit !== 'int') cycle.unit = plan.unit;
  cycle.exercises = plan.exercises.map(cloneExercise);
  if (plan.plans.length) {
    cycle.mode = 'plan';
    cycle.weekPlans = plan.plans.map(w => ({ id: newId(), name: w.name, items: w.items.map(it => {
      const o = { exId: cycle.exercises[it.ex].id, days: it.days.slice() };
      if (it.amount !== undefined) o.amount = it.amount;
      if (it.note) o.note = it.note;
      return o;
    }) }));
    cycle.weekAssign = plan.assign.slice(0, cycle.weeks).map(a => a >= 0 ? cycle.weekPlans[a].id : null);
  }
  cycle.weekTargets = plan.weekTargets.slice(0, cycle.weeks);
  if (plan.author) cycle.planAuthor = plan.author;
  if (plan.note) cycle.planNote = plan.note;
  appData.cycles.push(cycle);
  appData.activeCycleId = cycle.id;
  pendingPlan = null;
  saveData();
  closeModal();
  switchView('dashboard');
}

// Wurde die App über einen Plan-Link geöffnet?
async function checkPlanLink() {
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  const m = (location.hash || '').match(/^#plan=([A-Za-z0-9_-]+)/);
  if (!m) return;
  window.__planCode = m[1];
  history.replaceState(null, '', location.pathname + location.search);
  try { openPlanPreview(await decodePlan(m[1]), true); }
  catch (e) { alert('Dieser Plan-Link ist unvollständig oder beschädigt.'); }
}

// ═══════════════════════════════════════════════
// ASSESSMENTS – MODELL
// ═══════════════════════════════════════════════

// Geordnete Skalen für Tests, deren Ergebnis keine Zahl ist. Fortschritt wird
// hier in Graden gezählt, nicht in Prozent – von 6B auf 6C sind keine "8 %",
// die Rechnung hätte keine Bedeutung.
const SCALES = {
  font: {
    name: 'Font (Boulder)',
    steps: ['5A','5B','5C','6A','6A+','6B','6B+','6C','6C+','7A','7A+','7B','7B+',
            '7C','7C+','8A','8A+','8B','8B+','8C','8C+','9A']
  },
  vscale: {
    name: 'V-Skala',
    steps: ['V0','V1','V2','V3','V4','V5','V6','V7','V8','V9','V10','V11','V12',
            'V13','V14','V15','V16','V17']
  },
  gym: {
    name: 'Halle 1–9',
    steps: ['1','2','3','4','5','6','7','8','9']
  }
};

const TEST_KINDS = {
  number: 'Zahl',
  time:   'Zeit',
  scale:  'Grad',
  counts: 'Anzahl je Grad'
};

// 'counts' speichert statt einer Zahl ein Objekt { Skalenindex: Anzahl },
// z.B. { "6": 12, "7": 5 } für zwölf Siebener und fünf Achter in der Halle.
// Verglichen wird über die Gesamtzahl der Routen.
function isCounts(test) {
  return test && test.kind === 'counts';
}

function countsTotal(value) {
  if (!value || typeof value !== 'object') return 0;
  return Object.keys(value).reduce((s, k) => s + (parseFloat(value[k]) || 0), 0);
}

function formatCounts(test, value) {
  const steps = testScale(test).steps;
  const parts = Object.keys(value || {})
    .map(k => ({ i: parseInt(k, 10), n: parseFloat(value[k]) || 0 }))
    .filter(x => x.n > 0 && steps[x.i] !== undefined)
    .sort((a, b) => a.i - b.i)
    .map(x => x.n + '× ' + steps[x.i]);
  return parts.length ? parts.join(' · ') : '–';
}

function migrateAssessments(d = appData) {
  let changed = false;
  if (!Array.isArray(d.tests)) { d.tests = []; changed = true; }
  if (!Array.isArray(d.assessments)) { d.assessments = []; changed = true; }
  d.tests.forEach(t => {
    if (!t.kind) { t.kind = 'number'; changed = true; }
    if (t.unit === undefined) { t.unit = ''; changed = true; }
    if (t.category === undefined) { t.category = ''; changed = true; }
    if (t.higherIsBetter === undefined) { t.higherIsBetter = true; changed = true; }
    if (t.usesBodyweight === undefined) { t.usesBodyweight = false; changed = true; }
  });
  d.assessments.forEach(a => {
    if (!Array.isArray(a.results)) { a.results = []; changed = true; }
  });
  if (changed && d === appData) saveData();
  return changed;
}

function getTest(testId) {
  return appData.tests.find(t => t.id === testId) || null;
}

function testScale(test) {
  if (!test || (test.kind !== 'scale' && test.kind !== 'counts')) return null;
  return SCALES[test.scaleId] || SCALES.font;
}

// Die Zahl, mit der gerechnet und gezeichnet wird. Bei 'counts' ist das die
// Gesamtzahl der Routen, sonst der Wert selbst.
function testNumericValue(test, value) {
  return isCounts(test) ? countsTotal(value) : value;
}

function anyTestUsesBodyweight() {
  return appData.tests.some(t => t.usesBodyweight);
}

// Verschiebt sich mit jeder Pause nach hinten.
function getCycleEndDate(cycle) {
  return getWeekDates(cycle, (cycle.weeks || 12) - 1)[6];
}

// ── Werte formatieren und einlesen ──
function formatSeconds(sec) {
  const sign = sec < 0 ? '-' : '';
  const s = Math.abs(sec);
  if (s < 60) return sign + fmtNum(s) + ' s';
  let m = Math.floor(s / 60);
  let rest = Math.round(s - m * 60);
  if (rest === 60) { m += 1; rest = 0; }   // 119,6 s darf nicht "1:60" werden
  return sign + m + ':' + String(rest).padStart(2, '0');
}

function fmtNum(v) {
  return (Math.round(v * 100) / 100).toString().replace('.', ',');
}

function formatTestValue(test, value) {
  if (value === null || value === undefined) return '–';
  if (isCounts(test)) return formatCounts(test, value);
  if (isNaN(value)) return '–';
  if (test.kind === 'time') return formatSeconds(value);
  if (test.kind === 'scale') {
    const steps = testScale(test).steps;
    return steps[value] !== undefined ? steps[value] : '?';
  }
  return fmtNum(value) + (test.unit ? ' ' + test.unit : '');
}

// Nimmt "12,5", "12.5", "1:30" und negative Werte (z.B. Finger unter Bodenniveau).
function parseTestValue(test, raw) {
  const s = (raw === null || raw === undefined ? '' : raw).toString().trim().replace(',', '.');
  if (s === '') return null;
  if (test.kind === 'scale') {
    const i = parseInt(s, 10);
    return isNaN(i) ? null : i;
  }
  if (test.kind === 'time' && s.indexOf(':') >= 0) {
    const parts = s.split(':');
    const m = parseFloat(parts[0]), sec = parseFloat(parts[1]);
    if (isNaN(m) || isNaN(sec)) return null;
    return (m < 0 ? -1 : 1) * (Math.abs(m) * 60 + sec);
  }
  const v = parseFloat(s);
  return isNaN(v) ? null : v;
}

// ── Fortschritt zwischen zwei Messungen ──
// Prozentwerte entstehen nur dort, wo sie etwas aussagen: Skalen zählen in
// Graden, und bei Tests mit Körpergewichtsbezug rechnet der Prozentwert auf
// der Gesamtlast statt auf dem Zusatzgewicht. Sonst wird der Fortschritt grob
// überschätzt – +5 kg auf +10 kg sind eben keine "+100 %".
function compareMeasurements(test, prev, curr) {
  if (!prev || !curr) return null;

  if (isCounts(test)) {
    const a = countsTotal(prev.value), b = countsTotal(curr.value);
    const d = b - a;
    const res = { diff: d, better: d === 0 ? null : (test.higherIsBetter ? d > 0 : d < 0) };
    res.absText = (d > 0 ? '+' : '') + d + (Math.abs(d) === 1 ? ' Route' : ' Routen');
    res.detail = a + ' → ' + b + ' Routen gesamt';
    if (a !== 0) res.pctText = (b - a > 0 ? '+' : '') + fmtNum((b - a) / Math.abs(a) * 100) + ' %';
    return res;
  }

  const diff = curr.value - prev.value;
  const out = { diff, better: diff === 0 ? null : (test.higherIsBetter ? diff > 0 : diff < 0) };

  if (test.kind === 'scale') {
    const steps = testScale(test).steps;
    out.absText = (diff > 0 ? '+' : '') + diff + (Math.abs(diff) === 1 ? ' Grad' : ' Grade');
    out.detail = steps[prev.value] + ' → ' + steps[curr.value];
    return out;
  }

  out.absText = (diff > 0 ? '+' : '') + formatTestValue(test, diff);

  const withBw = test.usesBodyweight && prev.bodyweight > 0 && curr.bodyweight > 0;
  const base = withBw ? prev.bodyweight + prev.value : prev.value;
  const now  = withBw ? curr.bodyweight + curr.value : curr.value;
  if (base !== 0) {
    const pct = (now - base) / Math.abs(base) * 100;
    out.pctText = (pct > 0 ? '+' : '') + fmtNum(pct) + ' %';
  }
  if (withBw) {
    out.pctBasis = 'Gesamtlast';
    out.detail = fmtNum(base / prev.bodyweight) + '× KG → ' + fmtNum(now / curr.bodyweight) + '× KG';
  }
  return out;
}

// ── Trainingsvolumen in einem Zeitraum ──
// Summiert die Intensität je Kategorie zwischen zwei Daten, über ALLE Zyklen
// hinweg. Der Zeitraum ergibt sich aus den Messungen und darf deshalb
// Zyklusgrenzen überschreiten – ein Assessment ist ein freier Zeitpunkt und
// kein Anhängsel des Zyklus.
// fromDate ist exklusiv, toDate inklusive: der Tag der letzten Messung zählt
// zum vorigen Zeitraum und wird nicht doppelt gezählt.
function getCategoryVolume(fromDate, toDate) {
  const out = {};
  appData.cycles.forEach(cycle => {
    Object.keys(cycle.sessions || {}).forEach(day => {
      if (fromDate && day <= fromDate) return;
      if (toDate && day > toDate) return;
      (cycle.sessions[day] || []).forEach(entry => {
        const ex = (cycle.exercises || []).find(e => e.id === entryId(entry));
        if (!ex) return;
        addSplitIntensity(out, ex, getEffectiveIntensity(cycle, entry));
      });
    });
  });
  Object.keys(out).forEach(k => { out[k] = Math.round(out[k] * 10) / 10; });
  return out;
}

// Volumen einer einzelnen Kategorie; ignoriert Groß-/Kleinschreibung und
// Leerzeichen, damit "Finger" und "finger" nicht auseinanderfallen.
function getCategoryVolumeFor(fromDate, toDate, category) {
  const want = (category || '').trim().toLowerCase();
  if (!want) return 0;
  const vol = getCategoryVolume(fromDate, toDate);
  let total = 0;
  Object.keys(vol).forEach(cat => {
    if (cat.trim().toLowerCase() === want) total += vol[cat];
  });
  return Math.round(total * 10) / 10;
}

// Die letzte Messung vor einem Datum – definiert den Beginn des Zeitraums.
function getPreviousAssessment(dateStr, excludeId) {
  return appData.assessments
    .filter(a => a.id !== excludeId && a.date < dateStr)
    .sort((a, b) => b.date.localeCompare(a.date))[0] || null;
}

// Der Zyklus, in den ein Datum fällt – dient als Startpunkt, solange es noch
// keine frühere Messung gibt.
function findCycleForDate(dateStr) {
  return ownCycles().find(c =>
    dateStr >= c.startDate && dateStr <= getCycleEndDate(c)) || null;
}

function daysBetween(fromDate, toDate) {
  return Math.round((parseDate(toDate) - parseDate(fromDate)) / 86400000);
}

// Alle Messpunkte eines Tests, chronologisch, inkl. Körpergewicht des Messtags.
function getTestSeries(testId) {
  const test = getTest(testId);
  if (!test) return [];
  return appData.assessments
    .map(a => {
      const r = a.results.find(x => x.testId === testId);
      if (!r || r.value === null || r.value === undefined) return null;
      return { date: a.date, label: a.label, value: r.value, note: r.note || '',
               bodyweight: a.bodyweight || 0, assessmentId: a.id };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ═══════════════════════════════════════════════
// ASSESSMENTS – ANSICHT
// ═══════════════════════════════════════════════
function renderAssessment() {
  const el = document.getElementById('assessmentContent');
  const tests = appData.tests;
  const measurements = [...appData.assessments].sort((a, b) => b.date.localeCompare(a.date));
  const allCats = getAllCategoriesInCycle(getActiveCycle() || { exercises: [] });

  const measureList = measurements.length === 0
    ? `<div class="card text-muted" style="text-align:center">${
        tests.length === 0 ? 'Lege zuerst oben einen Test an.' : 'Noch keine Messung erfasst.'}</div>`
    : measurements.map(a => {
        const cycle = appData.cycles.find(c => c.id === a.cycleId);
        const d = parseDate(a.date);
        return `<div class="list-row" onclick="openAssessmentModal('${a.id}')">
          <div class="list-main">
            <div class="list-title">${esc(a.label || 'Messung')}</div>
            <div class="list-sub">${d.getDate()}. ${MONTHS_DE[d.getMonth()]} ${d.getFullYear()}${cycle ? ' · ' + esc(cycle.name) : ''}</div>
          </div>
          <span class="list-value">${a.results.length} ${a.results.length === 1 ? 'Wert' : 'Werte'}</span>
          <button class="del-btn" onclick="event.stopPropagation(); deleteAssessment('${a.id}')" title="Messung löschen">×</button>
        </div>`;
      }).join('');

  const testList = tests.length === 0
    ? ''
    : tests.map(t => {
        const cat = (t.category && t.category.trim()) ? t.category.trim() : '';
        const catColor = cat ? categoryColor(cat, allCats) : '#888';
        const series = getTestSeries(t.id);
        const latest = series.length > 0 ? series[series.length - 1] : null;
        let kindText = isCounts(t) ? testScale(t).name + ' · Anzahl je Grad'
                     : t.kind === 'scale' ? testScale(t).name
                     : t.kind === 'time' ? 'Zeit'
                     : (t.unit || 'Zahl');
        if (!t.higherIsBetter) kindText += ' · weniger ist besser';
        if (t.usesBodyweight) kindText += ' · mit KG';
        return `<div class="list-row" onclick="openTestProgressModal('${t.id}')">
          <div class="list-main">
            <div class="list-title">${esc(t.name)}</div>
            <div class="list-sub" style="flex-wrap:wrap">
              ${cat ? `<span style="color:${catColor};line-height:1">●</span><span>${esc(cat)}</span><span style="color:var(--text-dim)">·</span>` : ''}
              <span>${esc(kindText)}</span>
            </div>
          </div>
          <span class="list-value accent">${latest ? formatTestValue(t, latest.value) : '–'}</span>
          <button class="del-btn" onclick="event.stopPropagation(); deleteTest('${t.id}')" title="Test löschen">×</button>
        </div>`;
      }).join('');

  el.innerHTML = `
    <div class="section-hdr" style="margin-top:0">
      <h2>Tests</h2>
      <button class="btn ${tests.length ? 'btn-ghost' : 'btn-primary'} btn-sm" onclick="openTestModal()">+ Test</button>
    </div>
    ${tests.length ? `<div class="list-group">${testList}</div>` : ''}

    <div class="section-hdr">
      <h2>Messungen</h2>
      ${tests.length > 0 ? `<button class="btn btn-primary btn-sm" onclick="openAssessmentModal()">+ Messung</button>` : ''}
    </div>
    ${measurements.length ? `<div class="list-group">${measureList}</div>` : measureList}
  `;
}

// ── Erinnerung auf der Übersicht, sobald die letzte Zykluswoche läuft ──
// Erledigt ist sie, wenn im Zeitfenster der letzten Woche (oder danach)
// überhaupt gemessen wurde – unabhängig davon, ob die Messung einem Zyklus
// zugeordnet wurde. Messungen früher im Zyklus lösen sie nicht ab: Wer in
// Woche sechs misst, soll am Ende trotzdem erinnert werden.
function getAssessmentReminder() {
  const cycle = getActiveCycle();
  if (!cycle) return null;
  const end = getCycleEndDate(cycle);
  const daysLeft = daysBetween(toDateStr(new Date()), end);
  if (daysLeft > 7) return null;
  const ws = parseDate(end);
  ws.setDate(ws.getDate() - 6);
  const windowStart = toDateStr(ws);
  if (appData.assessments.some(a => a.date >= windowStart)) return null;
  return { end, daysLeft, needsTests: appData.tests.length === 0 };
}

function renderAssessmentReminder() {
  const r = getAssessmentReminder();
  if (!r) return '';
  const when = r.daysLeft < 0 ? 'Der Zyklus ist beendet.'
             : r.daysLeft === 0 ? 'Der Zyklus endet heute.'
             : `Der Zyklus endet in ${r.daysLeft} ${r.daysLeft === 1 ? 'Tag' : 'Tagen'}.`;
  // Ohne Tests wäre der Knopf eine Sackgasse – dann zuerst dorthin führen.
  const text = r.needsTests
    ? when + ' Lege Tests an, um deinen Stand zu messen.'
    : when + ' Zeit, deinen Stand zu messen.';
  const action = r.needsTests
    ? `<button class="btn btn-primary btn-sm" onclick="switchView('assessment');setTimeout(openTestModal,50)">Tests anlegen</button>`
    : `<button class="btn btn-primary btn-sm" onclick="switchView('assessment');setTimeout(openAssessmentModal,50)">Messen</button>`;
  return `
    <div class="card" style="border-color:var(--accent);background:var(--accent-dim)">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="flex:1">
          <div style="font-weight:600;font-size:14px;margin-bottom:2px">Assessment fällig</div>
          <div style="font-size:12px;color:var(--text-muted)">${text}</div>
        </div>
        ${action}
      </div>
    </div>`;
}

// ═══════════════════════════════════════════════
// ASSESSMENTS – TEST ANLEGEN / BEARBEITEN
// ═══════════════════════════════════════════════
function openTestModal(testId) {
  const t = testId ? getTest(testId) : null;
  const kind = t ? t.kind : 'number';
  const cycle = getActiveCycle();
  const allCats = cycle ? getAllCategoriesInCycle(cycle).filter(c => c !== 'Sonstige') : [];
  const datalist = allCats.length > 0
    ? `<datalist id="testCatList">${allCats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>`
    : '';

  openModal(`
    <div class="modal-title">${t ? 'Test bearbeiten' : 'Test anlegen'}</div>
    <div class="field">
      <label>Name</label>
      <input type="text" id="testName" value="${t ? esc(t.name) : ''}" placeholder="z.B. Max Hang 20 mm (10 s)">
    </div>
    <div class="field">
      <label>Art der Messung</label>
      <select id="testKind" onchange="onTestKindChange()">
        ${Object.keys(TEST_KINDS).map(k =>
          `<option value="${k}" ${k === kind ? 'selected' : ''}>${TEST_KINDS[k]}</option>`).join('')}
      </select>
    </div>
    <div class="field" id="testUnitField">
      <label>Einheit</label>
      <input type="text" id="testUnit" value="${t ? esc(t.unit || '') : ''}" placeholder="z.B. kg, Wdh., cm, km">
    </div>
    <div class="field" id="testScaleField">
      <label>Skala</label>
      <select id="testScale">
        ${Object.keys(SCALES).map(k =>
          `<option value="${k}" ${t && t.scaleId === k ? 'selected' : ''}>${SCALES[k].name}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label>Kategorie (optional) – verknüpft den Test mit deinem Trainingsplan</label>
      <input type="text" id="testCat" value="${t ? esc(t.category || '') : ''}" placeholder="z.B. Finger" list="testCatList">
      ${datalist}
      ${buildCategoryChips('testCat')}
    </div>
    <div class="divider"></div>
    <div class="check-row" onclick="toggleCheck('testHigher')">
      <div class="check-box ${!t || t.higherIsBetter ? 'checked' : ''}" id="testHigher" data-on="${!t || t.higherIsBetter ? '1' : '0'}">
        ${!t || t.higherIsBetter ? CHECK_SVG : ''}
      </div>
      <div class="check-label">Höherer Wert ist besser</div>
    </div>
    <div class="check-row" id="testBwRow" onclick="toggleCheck('testBw')">
      <div class="check-box ${t && t.usesBodyweight ? 'checked' : ''}" id="testBw" data-on="${t && t.usesBodyweight ? '1' : '0'}">
        ${t && t.usesBodyweight ? CHECK_SVG : ''}
      </div>
      <div class="check-label">Körpergewicht einbeziehen</div>
    </div>
    <div class="divider"></div>
    <div class="row">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="saveTest(${t ? `'${t.id}'` : 'null'})">Speichern</button>
    </div>
  `);
  onTestKindChange();
  setTimeout(() => document.getElementById('testName')?.focus(), 300);
}

const CHECK_SVG = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function toggleCheck(id) {
  const box = document.getElementById(id);
  if (!box) return;
  const on = box.dataset.on !== '1';
  box.dataset.on = on ? '1' : '0';
  box.classList.toggle('checked', on);
  box.innerHTML = on ? CHECK_SVG : '';
}

function isChecked(id) {
  const box = document.getElementById(id);
  return !!box && box.dataset.on === '1';
}

// Einheit und Skala schließen einander aus; Körpergewicht ergibt nur bei
// Zahlenwerten Sinn (Zusatzgewicht in kg).
function onTestKindChange() {
  const kind = document.getElementById('testKind')?.value;
  const unitField = document.getElementById('testUnitField');
  const scaleField = document.getElementById('testScaleField');
  const bwRow = document.getElementById('testBwRow');
  if (unitField) unitField.style.display = kind === 'number' ? '' : 'none';
  if (scaleField) scaleField.style.display = (kind === 'scale' || kind === 'counts') ? '' : 'none';
  if (bwRow) {
    const show = kind === 'number';
    bwRow.style.display = show ? '' : 'none';
    bwRow.nextElementSibling.style.display = show ? '' : 'none';
    if (!show) {
      const box = document.getElementById('testBw');
      if (box) { box.dataset.on = '0'; box.classList.remove('checked'); box.innerHTML = ''; }
    }
  }
}

function saveTest(testId) {
  const name = document.getElementById('testName')?.value?.trim();
  if (!name) { alert('Bitte einen Namen eingeben.'); return; }
  const kind = document.getElementById('testKind').value;
  const data = {
    name,
    kind,
    unit: kind === 'number' ? (document.getElementById('testUnit')?.value?.trim() || '') : '',
    scaleId: (kind === 'scale' || kind === 'counts') ? document.getElementById('testScale').value : undefined,
    category: document.getElementById('testCat')?.value?.trim() || '',
    higherIsBetter: isChecked('testHigher'),
    usesBodyweight: kind === 'number' && isChecked('testBw')
  };
  const existing = testId ? getTest(testId) : null;
  if (existing) {
    Object.assign(existing, data);
  } else {
    appData.tests.push(Object.assign({ id: newId() }, data));
  }
  saveData();
  closeModal();
  renderAssessment();
}

function deleteTest(testId) {
  const t = getTest(testId);
  if (!t) return;
  if (!confirm(`Test "${t.name}" wirklich löschen?\n\nAlle erfassten Messwerte dieses Tests gehen verloren.`)) return;
  appData.tests = appData.tests.filter(x => x.id !== testId);
  appData.assessments.forEach(a => {
    a.results = a.results.filter(r => r.testId !== testId);
  });
  saveData();
  closeModal();
  renderAssessment();
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ═══════════════════════════════════════════════
// ASSESSMENTS – TRAINING SEIT DER LETZTEN MESSUNG
// ═══════════════════════════════════════════════
// Zeigt beim Eintragen, was im Zeitraum bis zu diesem Messtag tatsächlich
// trainiert wurde – aufgeschlüsselt nach Kategorie. Damit steht die Zahl, die
// man gleich einträgt, direkt neben dem Training, das zu ihr geführt hat.
function buildVolumeSince(dateStr, excludeId) {
  if (!dateStr) return '';
  const prev = getPreviousAssessment(dateStr, excludeId);
  let from, quelle;
  if (prev) {
    from = prev.date;
    quelle = 'seit der Messung „' + esc(prev.label || 'ohne Bezeichnung') + '"';
  } else {
    const cyc = findCycleForDate(dateStr);
    if (!cyc) return `<div style="font-size:12px;color:var(--text-muted)">Erste Messung – ab hier wird gezählt.</div>`;
    from = cyc.startDate;
    quelle = 'seit Beginn von „' + esc(cyc.name) + '"';
  }

  const tage = daysBetween(from, dateStr);
  if (tage <= 0) {
    return `<div style="font-size:12px;color:var(--text-muted)">Kein Zeitraum – es gibt bereits eine Messung an diesem Tag oder danach.</div>`;
  }

  const vol = getCategoryVolume(from, dateStr);
  const cats = Object.keys(vol).filter(c => vol[c] > 0).sort((a, b) => vol[b] - vol[a]);
  const kopf = `<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">${
    quelle} · ${tage} ${tage === 1 ? 'Tag' : 'Tage'} (ab ${parseDate(from).toLocaleDateString('de-DE')})</div>`;

  if (cats.length === 0) {
    return kopf + `<div style="font-size:12px;color:var(--text-muted)">In diesem Zeitraum ist kein Training eingetragen.</div>`;
  }

  const max = Math.max(...cats.map(c => vol[c]));
  const allCats = getAllCategoriesInCycle(getActiveCycle() || { exercises: [] });
  const gesamt = Math.round(cats.reduce((s, c) => s + vol[c], 0) * 10) / 10;

  return kopf + cats.map(cat => {
    const color = categoryColor(cat, allCats);
    const breite = Math.max(3, Math.round(vol[cat] / max * 100));
    return `<div style="margin-bottom:7px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:3px">
        <span style="font-size:13px;display:flex;align-items:center;gap:6px;min-width:0">
          <span style="color:${color};font-size:13px;line-height:1;flex-shrink:0">●</span>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(cat)}</span>
        </span>
        <span style="font-family:'DM Mono',monospace;font-size:13px;color:var(--accent);flex-shrink:0">${fmtNum(vol[cat])}</span>
      </div>
      <div class="progress-bar-wrap" style="margin-top:0;height:4px">
        <div class="progress-bar-fill" style="width:${breite}%;background:${color}"></div>
      </div>
    </div>`;
  }).join('') + `<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-top:8px;padding-top:6px;border-top:1px solid var(--border)">
      <span>Gesamt</span><span style="font-family:'DM Mono',monospace">${fmtNum(gesamt)}</span>
    </div>`;
}

// Wird beim Ändern des Datums aufgerufen – der Zeitraum verschiebt sich mit.
function refreshVolumeSince() {
  const box = document.getElementById('assVolume');
  if (!box) return;
  box.innerHTML = buildVolumeSince(
    document.getElementById('assDate')?.value,
    box.dataset.editing || null
  );
}

// ═══════════════════════════════════════════════
// ASSESSMENTS – MESSUNG ERFASSEN
// ═══════════════════════════════════════════════
function openAssessmentModal(assessmentId) {
  if (appData.tests.length === 0) {
    alert('Lege zuerst mindestens einen Test an.');
    return;
  }
  const a = assessmentId ? appData.assessments.find(x => x.id === assessmentId) : null;
  const cycle = getActiveCycle();
  // Voreinstellung ist heute. Eine Messung ist ein freier Zeitpunkt – das
  // Zyklusende ist nur einer von vielen sinnvollen, nicht der einzige.
  const defDate = toDateStr(new Date());
  const defLabel = '';

  const bwField = anyTestUsesBodyweight() ? `
    <div class="field">
      <label>Körpergewicht (kg)</label>
      <input type="number" id="assBw" step="0.1" value="${a && a.bodyweight ? a.bodyweight : ''}" placeholder="z.B. 72">
    </div>` : '';

  const inputs = appData.tests.map(t => {
    const r = a ? a.results.find(x => x.testId === t.id) : null;
    const val = r && r.value !== null && r.value !== undefined ? r.value : '';
    let field;
    if (isCounts(t)) {
      // Ein kompaktes Feld je Grad – die Halle hat neun, das passt in ein Raster.
      const steps = testScale(t).steps;
      const cur = (r && r.value) || {};
      return `<div class="day-exercise-item" style="flex-direction:column;align-items:stretch;gap:8px">
        <div>
          <div style="font-size:14px">${esc(t.name)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${esc(testScale(t).name)} · Anzahl je Grad</div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:6px">
          ${steps.map((s, i) => `<div>
            <div style="font-size:10px;color:var(--text-muted);text-align:center;margin-bottom:2px">${esc(s)}</div>
            <input type="number" min="0" step="1" id="res_${t.id}_${i}"
              value="${cur[i] ? cur[i] : ''}" placeholder="0"
              style="text-align:center;padding:6px 4px;font-size:14px">
          </div>`).join('')}
        </div>
      </div>`;
    }
    if (t.kind === 'scale') {
      const steps = testScale(t).steps;
      field = `<select id="res_${t.id}" style="width:120px;flex-shrink:0">
        <option value="">–</option>
        ${steps.map((s, i) => `<option value="${i}" ${val === i ? 'selected' : ''}>${esc(s)}</option>`).join('')}
      </select>`;
    } else if (t.kind === 'time') {
      field = `<input type="text" inputmode="decimal" id="res_${t.id}" value="${val === '' ? '' : esc(formatTimeInput(val))}"
        placeholder="12,5 oder 1:30" style="width:120px;text-align:right;flex-shrink:0">`;
    } else {
      field = `<input type="number" step="any" id="res_${t.id}" value="${val}"
        placeholder="${esc(t.unit || '')}" style="width:120px;text-align:right;flex-shrink:0">`;
    }
    return `<div class="day-exercise-item" style="gap:10px">
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</div>
        <div style="font-size:11px;color:var(--text-muted)">${
          t.kind === 'scale' ? esc(testScale(t).name) : esc(t.unit || (t.kind === 'time' ? 'Zeit' : ''))}</div>
      </div>
      ${field}
    </div>`;
  }).join('');

  openModal(`
    <div class="modal-title">${a ? 'Messung bearbeiten' : 'Neue Messung'}</div>
    <div class="field">
      <label>Datum</label>
      <input type="date" id="assDate" value="${a ? a.date : defDate}" onchange="refreshVolumeSince()">
    </div>
    <div class="field">
      <label>Bezeichnung</label>
      <input type="text" id="assLabel" value="${a ? esc(a.label || '') : esc(defLabel)}" placeholder="z.B. Start Zyklus, Woche 8, Nach dem Urlaub">
    </div>
    <div class="field">
      <label>Gehört zu Zyklus (optional)</label>
      <select id="assCycle">
        <option value="">– kein Bezug –</option>
        ${appData.cycles.map(c => {
          const sel = a ? (a.cycleId === c.id) : (cycle && cycle.id === c.id);
          return `<option value="${c.id}" ${sel ? 'selected' : ''}>${esc(c.name)}</option>`;
        }).join('')}
      </select>
    </div>
    ${bwField}

    <div class="card" style="margin-top:4px">
      <div class="card-title">Training seit der letzten Messung</div>
      <div id="assVolume" data-editing="${a ? a.id : ''}">${buildVolumeSince(a ? a.date : defDate, a ? a.id : null)}</div>
    </div>

    <div class="divider"></div>
    <div class="card-title">Ergebnisse</div>
    <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">Leer lassen, was du nicht gemessen hast.</div>
    ${inputs}
    <div class="divider"></div>
    <div class="row">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="saveAssessment(${a ? `'${a.id}'` : 'null'})">Speichern</button>
    </div>
    ${a ? `<button class="btn btn-danger btn-full mt-8" onclick="deleteAssessment('${a.id}')">Messung löschen</button>` : ''}
  `);
}

// Sekunden für das Eingabefeld: unter einer Minute schlicht als Zahl,
// darüber als mm:ss – so wie man es auch wieder eintippen würde.
function formatTimeInput(sec) {
  if (sec < 60) return fmtNum(sec);
  const m = Math.floor(sec / 60);
  const rest = Math.round((sec - m * 60) * 10) / 10;
  return m + ':' + (rest < 10 ? '0' : '') + fmtNum(rest);
}

function saveAssessment(assessmentId) {
  const date = document.getElementById('assDate')?.value;
  if (!date) { alert('Bitte ein Datum wählen.'); return; }
  const label = document.getElementById('assLabel')?.value?.trim() || '';
  const cycleId = document.getElementById('assCycle')?.value || null;
  const bwRaw = document.getElementById('assBw')?.value;
  const bodyweight = bwRaw ? parseFloat(bwRaw.replace(',', '.')) : 0;

  const results = [];
  appData.tests.forEach(t => {
    if (isCounts(t)) {
      const counts = {};
      testScale(t).steps.forEach((s, i) => {
        const n = parseInt(document.getElementById(`res_${t.id}_${i}`)?.value, 10);
        if (!isNaN(n) && n > 0) counts[i] = n;
      });
      if (Object.keys(counts).length > 0) results.push({ testId: t.id, value: counts });
      return;
    }
    const raw = document.getElementById('res_' + t.id)?.value;
    const value = parseTestValue(t, raw);
    if (value === null) return;
    results.push({ testId: t.id, value });
  });

  const existing = assessmentId ? appData.assessments.find(x => x.id === assessmentId) : null;
  const payload = { date, label, cycleId, bodyweight: isNaN(bodyweight) ? 0 : bodyweight, results };
  if (existing) {
    Object.assign(existing, payload);
  } else {
    appData.assessments.push(Object.assign({ id: newId() }, payload));
  }
  saveData();
  closeModal();
  renderAssessment();
}

function deleteAssessment(assessmentId) {
  const a = appData.assessments.find(x => x.id === assessmentId);
  if (!a) return;
  const what = a.label ? `„${a.label}"` : 'diese Messung';
  if (!confirm(`Messung ${what} wirklich löschen?`)) return;
  appData.assessments = appData.assessments.filter(x => x.id !== assessmentId);
  saveData();
  closeModal();
  renderAssessment();
}

// ═══════════════════════════════════════════════
// ASSESSMENTS – VERLAUFSDIAGRAMM
// ═══════════════════════════════════════════════
// Liniendiagramm über die Zeit. Die X-Achse ist zeitproportional, nicht nach
// Messung durchnummeriert: Eine Pause von drei Monaten soll auch wie eine
// Pause aussehen.
function renderTestChart(test, series) {
  if (series.length < 2) return '';

  const vals = series.map(p => testNumericValue(test, p.value));
  const times = series.map(p => parseDate(p.date).getTime());
  const tMin = times[0], tMax = times[times.length - 1];
  const span = Math.max(1, tMax - tMin);

  const w = 320, h = 170;
  const padL = 34, padR = 12, padT = 14, padB = 26;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;

  // Y-Bereich mit etwas Luft; bei Skalen ganzzahlig, sonst mit runden Schritten
  const lo = Math.min(...vals), hi = Math.max(...vals);
  let yMin, yMax, step;
  if (test.kind === 'scale') {
    yMin = Math.max(0, Math.floor(lo) - 1);
    yMax = Math.ceil(hi) + 1;
    step = Math.max(1, Math.round((yMax - yMin) / 4));
  } else {
    const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.1 || 1;
    yMin = lo - pad; yMax = hi + pad;
    if (yMin > 0 && yMin < (yMax - yMin)) yMin = 0;   // Nulllinie zeigen, wo sinnvoll
    step = niceYStep(yMax - yMin);
    yMin = Math.floor(yMin / step) * step;
    yMax = Math.ceil(yMax / step) * step;
  }
  if (yMax === yMin) yMax = yMin + (step || 1);

  const xFor = t => padL + ((t - tMin) / span) * chartW;
  const yFor = v => padT + chartH - ((v - yMin) / (yMax - yMin)) * chartH;

  const yLabel = v => test.kind === 'scale'
    ? (testScale(test).steps[Math.round(v)] || '')
    : test.kind === 'time' ? formatSeconds(v)
    : fmtNum(v);

  const grid = [];
  for (let v = yMin; v <= yMax + 1e-9; v += step) {
    const y = yFor(v);
    grid.push(`<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="0.5"/>`);
    const lbl = yLabel(v);
    if (lbl !== '') {
      grid.push(`<text x="${padL - 4}" y="${(y + 3).toFixed(1)}" font-size="8.5" fill="var(--text-dim)" text-anchor="end" font-family="DM Mono, monospace">${esc(lbl)}</text>`);
    }
  }

  const path = series.map((p, i) =>
    `${i === 0 ? 'M' : 'L'} ${xFor(times[i]).toFixed(1)} ${yFor(vals[i]).toFixed(1)}`).join(' ');
  const dots = series.map((p, i) =>
    `<circle cx="${xFor(times[i]).toFixed(1)}" cy="${yFor(vals[i]).toFixed(1)}" r="3" fill="var(--accent)"/>`).join('');

  // Nur erste und letzte Messung datieren – dazwischen wird es auf dem Handy zu eng
  const dLbl = d => { const x = parseDate(d); return x.getDate() + '.' + (x.getMonth() + 1) + '.'; };
  const xLabels = `
    <text x="${padL}" y="${h - 8}" font-size="8.5" fill="var(--text-dim)" text-anchor="start" font-family="DM Mono, monospace">${dLbl(series[0].date)}</text>
    <text x="${w - padR}" y="${h - 8}" font-size="8.5" fill="var(--text-dim)" text-anchor="end" font-family="DM Mono, monospace">${dLbl(series[series.length - 1].date)}</text>`;

  return `
    <div class="card">
      <div class="card-title">Verlauf</div>
      <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;display:block" preserveAspectRatio="xMidYMid meet">
        ${grid.join('')}
        <path d="${path}" stroke="var(--accent)" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
        ${dots}
        ${xLabels}
      </svg>
    </div>`;
}

// ═══════════════════════════════════════════════
// ASSESSMENTS – TRAINING GEGEN LEISTUNG
// ═══════════════════════════════════════════════
// Stellt je Zyklus das Trainingsvolumen der verknüpften Kategorie neben die
// Leistungsveränderung. Zwischenstände bleiben außen vor – verglichen werden
// Zyklusabschlüsse.
function renderVolumeVsPerformance(test) {
  const cat = (test.category || '').trim();
  if (!cat) return '';
  const series = getTestSeries(test.id);
  if (series.length < 2) return '';

  // Je Abschnitt zwischen zwei Messungen: was wurde trainiert, was kam dabei
  // heraus. Die Abschnitte kommen aus den Messungen selbst und dürfen
  // Zyklusgrenzen überschreiten.
  const rows = series.slice(1).map((p, i) => {
    const prev = series[i];
    const cmp = compareMeasurements(test, prev, p);
    const vol = getCategoryVolumeFor(prev.date, p.date, cat);
    const tage = daysBetween(prev.date, p.date);
    const color = !cmp || cmp.better === null ? 'var(--text-muted)'
                : cmp.better ? 'var(--green-dark)' : 'var(--red)';
    return `<div style="display:flex;align-items:center;gap:8px;padding:9px 0;border-bottom:1px solid var(--border)">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px">${parseDate(prev.date).toLocaleDateString('de-DE')} → ${parseDate(p.date).toLocaleDateString('de-DE')}</div>
        <div style="font-size:11px;color:var(--text-muted)">${tage} ${tage === 1 ? 'Tag' : 'Tage'} · ${fmtNum(vol)} Punkte ${esc(cat)}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-family:'DM Mono',monospace;font-size:13px;color:var(--accent)">${formatTestValue(test, p.value)}</div>
        <div style="font-family:'DM Mono',monospace;font-size:11px;color:${color}">${esc(cmp.absText)}</div>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="divider"></div>
    <div class="card-title">Training gegen Leistung</div>
    <div style="font-size:11px;color:var(--text-dim);margin-bottom:6px">
      Trainingsvolumen der Kategorie „${esc(cat)}" im jeweiligen Zeitraum zwischen zwei
      Messungen, daneben die Veränderung in diesem Test.
    </div>
    ${rows}
    <div style="font-size:11px;color:var(--text-dim);margin-top:8px;line-height:1.5">
      Das zeigt einen Zusammenhang, keine Ursache. Schlaf, Ernährung, Deload und
      Alltagsstress hängen mit drin und tauchen hier nicht auf.
    </div>`;
}

// ═══════════════════════════════════════════════
// ASSESSMENTS – VERLAUF EINES TESTS
// ═══════════════════════════════════════════════
function openTestProgressModal(testId) {
  const t = getTest(testId);
  if (!t) return;
  const series = getTestSeries(testId);

  let body;
  if (series.length === 0) {
    body = `<div class="empty" style="padding:20px 0"><div>Noch kein Messwert für diesen Test.</div></div>`;
  } else {
    const rows = series.map((p, i) => {
      const cmp = i > 0 ? compareMeasurements(t, series[i - 1], p) : null;
      const color = !cmp || cmp.better === null ? 'var(--text-muted)'
                  : cmp.better ? 'var(--green-dark)' : 'var(--red)';
      return `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <span style="font-size:12px;color:var(--text-muted)">${parseDate(p.date).toLocaleDateString('de-DE')}${
            p.label ? ' · ' + esc(p.label) : ''}</span>
          <span style="font-family:'DM Mono',monospace;font-size:16px;color:var(--accent)">${formatTestValue(t, p.value)}</span>
        </div>
        ${cmp ? `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-top:3px">
          <span style="font-size:11px;color:var(--text-dim)">${cmp.detail ? esc(cmp.detail) : ''}</span>
          <span style="font-family:'DM Mono',monospace;font-size:12px;color:${color}">
            ${esc(cmp.absText)}${cmp.pctText ? ' · ' + esc(cmp.pctText) : ''}
          </span>
        </div>` : ''}
      </div>`;
    }).join('');

    const first = series[0], last = series[series.length - 1];
    const total = series.length > 1 ? compareMeasurements(t, first, last) : null;
    const totalColor = !total || total.better === null ? 'var(--text-muted)'
                     : total.better ? 'var(--green-dark)' : 'var(--red)';
    const summary = total ? `
      <div class="card" style="margin-bottom:14px">
        <div class="card-title">Gesamt über ${series.length} Messungen</div>
        <div style="display:flex;align-items:baseline;gap:10px">
          <span style="font-family:'DM Mono',monospace;font-size:24px;color:${totalColor}">${esc(total.absText)}</span>
          ${total.pctText ? `<span style="font-family:'DM Mono',monospace;font-size:15px;color:${totalColor}">${esc(total.pctText)}</span>` : ''}
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">
          ${formatTestValue(t, first.value)} → ${formatTestValue(t, last.value)}${
            total.pctBasis ? ' · Prozent bezogen auf ' + esc(total.pctBasis) : ''}
        </div>
      </div>` : '';

    body = summary + renderTestChart(t, series)
         + `<div class="card-title">Einzelne Messungen</div>` + rows
         + renderVolumeVsPerformance(t);
  }

  const cat = (t.category && t.category.trim()) ? t.category.trim() : '';
  openModal(`
    <div class="modal-title">${esc(t.name)}</div>
    <div class="text-muted" style="margin-bottom:14px">
      ${isCounts(t) ? esc(testScale(t).name) + ' · Anzahl je Grad'
        : t.kind === 'scale' ? esc(testScale(t).name)
        : esc(t.unit || 'Zeit')}${
        cat ? ' · Kategorie ' + esc(cat) : ''}${
        t.higherIsBetter ? '' : ' · weniger ist besser'}
    </div>
    ${body}
    <div class="divider"></div>
    <div class="row">
      <button class="btn btn-ghost" onclick="closeModal();setTimeout(()=>openTestModal('${t.id}'),250)">Test bearbeiten</button>
      <button class="btn btn-danger" onclick="deleteTest('${t.id}')">Löschen</button>
    </div>
    <button class="btn btn-ghost btn-full mt-8" onclick="closeModal()">Schließen</button>
  `);
}

// ═══════════════════════════════════════════════
// MODAL
// ═══════════════════════════════════════════════
function openModal(content) {
  document.getElementById('modalContent').innerHTML = content;
  document.getElementById('modalOverlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  if (reloadPending) { location.reload(); return; }
  if (currentView === 'dashboard') renderDashboard();
  if (currentView === 'assessment') renderAssessment();
  if (currentView === 'history') renderHistory();
  if (currentView === 'settings') renderSettings();
}

// Am PC schließt Escape das offene Fenster
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('modalOverlay')?.classList.contains('open')) closeModal();
  });
}

function closeModalOnBg(e) {
  if (e.target === document.getElementById('modalOverlay')) closeModal();
}

// ═══════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════
migrateCycles();
migrateAssessments();
migrateLogbook();
render();
checkPlanLink();

// Offline-Fähigkeit. Fehlt beim Öffnen als lokale Datei – dann läuft die App
// wie bisher, nur eben ohne Zwischenspeicher.
//
// Updates: Eine App vom Home-Bildschirm wird beim Öffnen oft nur fortgesetzt
// und nicht neu geladen. Deshalb fragt sie bei jedem Zurückkommen nach einer
// neuen Version. Ist eine da, übernimmt der neue Service Worker sofort und die
// App lädt sich neu – mit offenem Fenster erst, wenn es geschlossen wird.
var reloadPending = false;   // var: closeModal liest es auch vor dieser Zeile

function reloadForUpdate() {
  const modalOpen = document.getElementById('modalOverlay')?.classList.contains('open');
  if (modalOpen) { reloadPending = true; return; }
  location.reload();
}

if ('serviceWorker' in navigator) {
  let controller = navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Beim allerersten Installieren übernimmt der Service Worker nur – da
    // gibt es nichts Neues zu laden. Erst ein Wechsel ist ein Update.
    const wasControlled = !!controller;
    controller = navigator.serviceWorker.controller;
    if (!wasControlled || reloading) return;
    reloading = true;
    reloadForUpdate();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
  });
}
