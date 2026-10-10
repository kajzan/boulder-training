/* Planung: Wochen, Zuordnung und Repertoire
 *
 * Ein Zyklus im Wochenplan-Modus besteht aus Bausteinen:
 *   cycle.exercises   die Übungen (wie bisher, auch im freien Modus)
 *   cycle.weekPlans   Wochen, z.B. "Aufbauwoche" und "Entlastungswoche":
 *                     [{ id, name, items: [{ exId, days: [0..6], amount?, note? }] }]
 *                     amount: Wert in dieser Woche, sonst der der Übung
 *                     note:   Hinweis für diese Woche ("Max Hangs 10 s")
 *   cycle.weekAssign  welche Woche in welcher Zykluswoche gilt:
 *                     [planId | null] je Zykluswoche
 *
 * Das Repertoire (appData.weekLibrary) hält gespeicherte Wochen für spätere
 * Zyklen – vollständig, mit eigenen Übungen, damit es ohne den Ursprungs-
 * zyklus auskommt:
 *   [{ id, name, unit, exercises: [{ name, categories, amount, desc?,
 *      measure?, unit?, days, note? }] }]
 */

const WEEK_COLORS = ['#c8ff00', '#4a9eff', '#ff7eb3', '#ffa726', '#26c6da', '#ab47bc', '#7ddf6e', '#ffca28'];

// ═══════════════════════════════════════════════
// MODELL
// ═══════════════════════════════════════════════
function weekPlans(cycle) {
  return cycle && Array.isArray(cycle.weekPlans) ? cycle.weekPlans : [];
}

function weekPlanById(cycle, id) {
  return weekPlans(cycle).find(p => p.id === id) || null;
}

function weekPlanColor(cycle, plan) {
  const i = weekPlans(cycle).indexOf(plan);
  return WEEK_COLORS[Math.max(0, i) % WEEK_COLORS.length];
}

function weekPlanFor(cycle, weekIndex) {
  if (!isPlanMode(cycle) || weekIndex < 0) return null;
  return weekPlanById(cycle, (cycle.weekAssign || [])[weekIndex]);
}

function weeksOfPlan(cycle, plan) {
  return (cycle.weekAssign || []).map((id, i) => id === plan.id ? i : -1).filter(i => i >= 0);
}

function itemAmount(cycle, item) {
  if (item.amount !== undefined && item.amount !== null && item.amount !== '') return parseFloat(item.amount) || 0;
  const ex = cycle.exercises.find(e => e.id === item.exId);
  return ex ? parseFloat(ex.intensity) || 0 : 0;
}

// Geplanter Umfang einer Woche – zugleich ihr Wochenziel
function planTotal(cycle, plan) {
  return Math.round(plan.items.reduce((s, it) =>
    cycle.exercises.some(e => e.id === it.exId) ? s + itemAmount(cycle, it) * (it.days || []).length : s, 0) * 100) / 100;
}

// Welche Zykluswoche ein Kalendertag ist (Pausen berücksichtigt); -1 außerhalb
function weekIndexOfDate(cycle, dateStr) {
  const idx = trainingDays(cycle, (cycle.weeks || 12) * 7).indexOf(dateStr);
  return idx < 0 ? -1 : Math.floor(idx / 7);
}

// Was laut Wochenplan an einem Tag dran ist – ohne Verschiebungen
function basePlannedItems(cycle, dateStr) {
  const plan = weekPlanFor(cycle, weekIndexOfDate(cycle, dateStr));
  if (!plan) return [];
  const wd = weekdayOf(dateStr);
  return plan.items
    .filter(it => (it.days || []).includes(wd))
    .map(it => ({ ex: cycle.exercises.find(e => e.id === it.exId), amount: itemAmount(cycle, it), note: it.note || '' }))
    .filter(x => x.ex);
}

// ── Trainingstage verschieben ──
// cycle.dayMoves = { 'ursprünglicher Tag': 'neuer Tag' }. Ein verschobener
// Tag ist leer; der Zieltag bekommt dessen Übungen zusätzlich.
function dayMoves(cycle) {
  return cycle && cycle.dayMoves && typeof cycle.dayMoves === 'object' ? cycle.dayMoves : {};
}

// Was an einem Tag geplant ist: [{ ex, amount, note, movedFrom? }]
function plannedItems(cycle, dateStr) {
  if (!isPlanMode(cycle)) return [];
  const moves = dayMoves(cycle);
  const own = moves[dateStr] ? [] : basePlannedItems(cycle, dateStr);
  const moved = Object.keys(moves).filter(from => moves[from] === dateStr && from !== dateStr)
    .flatMap(from => basePlannedItems(cycle, from).map(x => Object.assign({}, x, { movedFrom: from })));
  const seen = new Set();
  return own.concat(moved).filter(x => !seen.has(x.ex.id) && seen.add(x.ex.id));
}

// Die ursprünglichen Tage, deren Training gerade auf diesem Tag liegt
function moveOrigins(cycle, dateStr) {
  const moves = dayMoves(cycle);
  const out = Object.keys(moves).filter(from => moves[from] === dateStr);
  if (!moves[dateStr] && basePlannedItems(cycle, dateStr).length) out.unshift(dateStr);
  return out;
}

function moveTrainingDay(from, to) {
  const cycle = getActiveCycle();
  if (!cycle || from === to) return;
  const moves = Object.assign({}, dayMoves(cycle));
  moveOrigins(cycle, from).forEach(origin => {
    if (origin === to) delete moves[origin]; else moves[origin] = to;
  });
  cycle.dayMoves = moves;
  if (!Object.keys(moves).length) delete cycle.dayMoves;
  saveData();
}

function plannedExercises(cycle, dateStr) {
  return plannedItems(cycle, dateStr).map(x => x.ex);
}

// Wochenziel: im Wochenplan der geplante Umfang, sonst von Hand gesetzt
function getWeekTarget(cycle, i) {
  const plan = weekPlanFor(cycle, i);
  return plan ? planTotal(cycle, plan) : ((cycle.weekTargets || [])[i] || 0);
}

// [0,1,2,4,8,9] → "1–3, 5, 9–10"
function formatWeekRanges(list) {
  const nums = [...new Set(list)].sort((a, b) => a - b).map(i => i + 1);
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > i ? `${nums[i]}–${nums[j]}` : `${nums[i]}`);
    i = j;
  }
  return out.join(', ');
}

function planDays(plan) {
  const set = new Set();
  plan.items.forEach(it => (it.days || []).forEach(d => set.add(d)));
  return [...set].sort((a, b) => a - b);
}

function ensureAssign(cycle) {
  const n = cycle.weeks || 12;
  const a = Array.isArray(cycle.weekAssign) ? cycle.weekAssign.slice(0, n) : [];
  while (a.length < n) a.push(null);
  cycle.weekAssign = a;
  if (!Array.isArray(cycle.weekPlans)) cycle.weekPlans = [];
}

// Früher hatte jede Übung ihre Tage (ex.days). Daraus wird eine
// "Standardwoche", die in allen Wochen gilt.
function migratePlanDays(c) {
  let changed = false;
  const withDays = (c.exercises || []).filter(ex => Array.isArray(ex.days) && ex.days.length);
  if (withDays.length && !Array.isArray(c.weekPlans)) {
    c.weekPlans = [{ id: 'std', name: 'Standardwoche', items: withDays.map(ex => ({
      exId: ex.id, days: ex.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b)
    })) }];
    c.weekAssign = Array.from({ length: c.weeks || 12 }, () => 'std');
    changed = true;
  }
  (c.exercises || []).forEach(ex => { if ('days' in ex) { delete ex.days; changed = true; } });
  if (Array.isArray(c.weekPlans)) {
    const before = JSON.stringify(c.weekAssign);
    ensureAssign(c);
    if (JSON.stringify(c.weekAssign) !== before) changed = true;
  }
  return changed;
}

// Wochen eines Zyklus in einen anderen kopieren (Zyklus kopieren)
function copyPlanStructure(src, dst, idMap) {
  if (!weekPlans(src).length) return;
  const planMap = {};
  dst.weekPlans = weekPlans(src).map(p => {
    const id = newId();
    planMap[p.id] = id;
    return { id, name: p.name, items: p.items.filter(it => idMap[it.exId]).map(it =>
      Object.assign({}, it, { exId: idMap[it.exId], days: (it.days || []).slice() })) };
  });
  dst.weekAssign = Array.from({ length: dst.weeks || 12 }, (_, i) => planMap[(src.weekAssign || [])[i]] || null);
}

// Wochenplan einschalten: ohne geplante Wochen entsteht aus dem bisherigen
// Training ein erster Plan für alle Wochen (wenn es eins gibt)
function startPlanning(cycle) {
  if (!cycle) return;
  if (!weekPlans(cycle).length && cycle.exercises.length) {
    const suggested = suggestExerciseDays(cycle);
    const items = cycle.exercises.map(ex => ({ exId: ex.id, days: suggested[ex.id] || [] })).filter(it => it.days.length);
    if (items.length) {
      ensureAssign(cycle);
      const plan = { id: newId(), name: nextPlanName(cycle), items };
      cycle.weekPlans.push(plan);
      cycle.weekAssign = cycle.weekAssign.map(() => plan.id);
    }
  }
  cycle.mode = 'plan';
  saveData();
  if (typeof currentView !== 'undefined' && currentView !== 'plan' && !cycle.forOther) switchView('plan'); else render();
}

// Wochentage, an denen eine Übung in mindestens 40 % der Trainingswochen dran war
function suggestExerciseDays(cycle) {
  const weeksWithTraining = new Set();
  const counts = {};
  Object.keys(cycle.sessions || {}).forEach(date => {
    const entries = cycle.sessions[date] || [];
    if (!entries.length) return;
    weeksWithTraining.add(Math.floor(daysBetween(cycle.startDate, date) / 7));
    const wd = weekdayOf(date);
    entries.forEach(e => {
      const id = entryId(e);
      counts[id] = counts[id] || [0, 0, 0, 0, 0, 0, 0];
      counts[id][wd]++;
    });
  });
  const need = Math.max(2, Math.ceil(weeksWithTraining.size * 0.4));
  const out = {};
  cycle.exercises.forEach(ex => {
    const c = counts[ex.id];
    out[ex.id] = c ? c.map((n, wd) => n >= need ? wd : -1).filter(wd => wd >= 0) : [];
  });
  return out;
}

// ═══════════════════════════════════════════════
// ANSICHT IM TRAININGSPLAN
// ═══════════════════════════════════════════════
// Alles auf einen Blick, ohne Scrollen:
//   oben      die Wochen des Zyklus als kleine Leiste; die gewählte Woche
//             lässt sich über andere Wochen ziehen (überträgt ihren Plan)
//   Mitte     die gewählte Woche von links nach rechts, Montag bis Sonntag
//   unten     die Übungen – auf einen Tag ziehen, und sie sind geplant
// Übungen an einem Tag lassen sich auf andere Tage ziehen oder nach unten
// auf den Papierkorb; ein Tipp öffnet ein Menü (tauschen, Wert, entfernen).
//
// Gilt ein Wochenplan in mehreren Wochen, wählt "Nur Woche 3 / Alle Wochen",
// ob eine Änderung alle betrifft oder nur diese Woche (dann wird der Plan für
// diese Woche abgetrennt).

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const MORE_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`;
const TRASH_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/></svg>`;

let boardSel = { cycleId: null, week: 0 };
let boardScope = 'all';     // 'all' | 'one'

function boardWeek(cycle) {
  const n = cycle.weeks || 12;
  if (boardSel.cycleId !== cycle.id) {
    const cur = getCurrentWeekIndex(cycle);
    boardSel = { cycleId: cycle.id, week: Math.max(0, Math.min(n - 1, cur)) };
    boardScope = 'all';
  }
  boardSel.week = Math.max(0, Math.min(n - 1, boardSel.week));
  return boardSel.week;
}

function boardSelect(i) {
  const cycle = getActiveCycle();
  if (!cycle) return;
  boardWeek(cycle);
  boardSel.week = i;
  boardScope = 'all';
  render();
}

function boardStep(d) {
  const cycle = getActiveCycle();
  if (!cycle) return;
  boardSelect(Math.max(0, Math.min((cycle.weeks || 12) - 1, boardWeek(cycle) + d)));
}

function exerciseColor(cycle, exId) {
  const ex = cycle.exercises.find(e => e.id === exId);
  const cats = ex ? exerciseCategories(ex) : [];
  return cats.length ? categoryColor(cats[0], getAllCategoriesInCycle(cycle)) : '#8a8a8a';
}

function renderPlanning(cycle) {
  ensureAssign(cycle);
  const n = cycle.weeks || 12;
  const w = boardWeek(cycle);
  const current = getCurrentWeekIndex(cycle);
  const plan = weekPlanById(cycle, cycle.weekAssign[w]);
  const color = plan ? weekPlanColor(cycle, plan) : null;
  const shared = plan ? weeksOfPlan(cycle, plan) : [];
  const dates = getWeekDates(cycle, w);
  const exName = id => (cycle.exercises.find(e => e.id === id) || {}).name || '?';

  const strip = Array.from({ length: n }, (_, i) => {
    const p = weekPlanById(cycle, cycle.weekAssign[i]);
    const c = p ? weekPlanColor(cycle, p) : '';
    const on = i === w;
    return `<button type="button" class="ws ${on ? 'on' : ''} ${i === current ? 'now' : ''} ${p ? 'has' : ''}" data-drop="week:${i}"
      style="${c ? `--c:${c}` : ''}" onclick="boardSelect(${i})" aria-label="Woche ${i + 1}"
      ${on ? `onpointerdown="dndPress(event, { kind: 'week', plan: ${p ? `'${p.id}'` : 'null'}, label: 'Woche ${i + 1}', color: '${c || '#8a8a8a'}', from: ${i} })"` : ''}>${i + 1}</button>`;
  }).join('');

  const days = DAYS_DE.map((dn, d) => {
    const items = plan ? plan.items.filter(it => (it.days || []).includes(d) && cycle.exercises.some(e => e.id === it.exId)) : [];
    return `<div class="pb-day ${items.length ? 'has' : ''}" data-drop="bday:${d}" onclick="boardAddMenu(this, ${d})">
      <div class="pb-dn">${dn}<span>${dates[d] ? parseDate(dates[d]).getDate() : ''}</span></div>
      <div class="pb-items">${items.map(it => `<button type="button" class="pb-chip" style="--c:${exerciseColor(cycle, it.exId)}"
        onpointerdown="dndPress(event, { kind: 'bex', exId: '${it.exId}', from: ${d}, label: '${esc(jsStr(exName(it.exId)))}' })"
        onclick="event.stopPropagation();boardChipMenu(this, '${it.exId}', ${d})">${esc(exName(it.exId))}${it.note ? '<i></i>' : ''}</button>`).join('')}</div>
      <div class="pb-plus">+</div>
    </div>`;
  }).join('');

  const tokens = cycle.exercises.map(ex => `<button type="button" class="we-token" style="--c:${exerciseColor(cycle, ex.id)}"
      onpointerdown="dndPress(event, { kind: 'bex', exId: '${ex.id}', label: '${esc(jsStr(ex.name))}' })"
      onclick="openEditExerciseModal('${ex.id}')"><span class="tok-dot"></span>${esc(ex.name)}<span class="tok-amt">${fmtExAmount(cycle, ex.intensity)}</span></button>`).join('');

  return `
    <div class="card pb">
      <div class="pb-strip">${strip}</div>
      <div class="pb-head">
        <button type="button" class="pb-nav" onclick="boardStep(-1)" ${w === 0 ? 'disabled' : ''} aria-label="Vorige Woche">‹</button>
        <div class="pb-title">
          <div>Woche ${w + 1}${plan ? ` <span class="pb-tag" style="--c:${color}">${esc(plan.name)}</span>` : ''}</div>
          <div class="pb-sub">${dates.length ? formatDay(dates[0]) + ' – ' + formatDay(dates[6]) : ''}${plan ? ' · ' + fmtAmount(cycle, planTotal(cycle, plan)) : ''}</div>
        </div>
        <button type="button" class="pb-nav" onclick="boardStep(1)" ${w >= n - 1 ? 'disabled' : ''} aria-label="Nächste Woche">›</button>
        <button type="button" class="icon-btn" onclick="openBoardMenu(this)" aria-label="Mehr">${MORE_ICON}</button>
      </div>
      ${shared.length > 1 ? `<div class="seg pb-scope">
        <button type="button" class="${boardScope === 'one' ? 'on' : ''}" onclick="boardScope='one';render()">Nur Woche ${w + 1}</button>
        <button type="button" class="${boardScope === 'all' ? 'on' : ''}" onclick="boardScope='all';render()">Alle ${shared.length} Wochen</button>
      </div>` : ''}
      <div class="pb-days">${days}</div>
      <div class="pb-palette">
        <div class="we-tokens">${tokens}<button type="button" class="we-token add" onclick="openAddExerciseModal()" aria-label="Übung hinzufügen">+ Übung</button></div>
        <div class="we-trash" data-drop="trash">${TRASH_ICON}<span>Entfernen</span></div>
      </div>
    </div>`;
}

// Für Werte in onclick="…'${…}'…": Backslash und Apostroph maskieren
function jsStr(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// "Entlastungswoche" → "Entlastung" – passt in kleine Felder
function shortWeekName(name) {
  const t = name.replace(/ungswoche$/i, 'ung').replace(/\s*woche$/i, '').trim();
  return t || name;
}

function nextPlanName(cycle) {
  const used = new Set(weekPlans(cycle).map(p => p.name));
  for (let i = 0; i < 26; i++) {
    const name = 'Plan ' + String.fromCharCode(65 + i);
    if (!used.has(name)) return name;
  }
  return 'Plan ' + (weekPlans(cycle).length + 1);
}

// Der Plan, den eine Änderung an der gewählten Woche betrifft. Legt einen an,
// wenn die Woche noch leer ist; trennt ihn ab, wenn nur diese Woche gemeint ist.
function boardEditPlan(cycle) {
  ensureAssign(cycle);
  const w = boardWeek(cycle);
  let plan = weekPlanById(cycle, cycle.weekAssign[w]);
  if (!plan) {
    plan = { id: newId(), name: nextPlanName(cycle), items: [] };
    cycle.weekPlans.push(plan);
    cycle.weekAssign[w] = plan.id;
  } else if (boardScope === 'one' && weeksOfPlan(cycle, plan).length > 1) {
    const copy = { id: newId(), name: nextPlanName(cycle), items: JSON.parse(JSON.stringify(plan.items)) };
    cycle.weekPlans.push(copy);
    cycle.weekAssign[w] = copy.id;
    plan = copy;
    boardScope = 'all';
  }
  cycle.mode = cycle.mode || 'plan';
  return plan;
}

// Nach jeder Änderung: leere Einträge weg; ein leerer Plan, der nirgends
// sonst gilt, verschwindet ganz
function boardTidy(cycle, plan) {
  plan.items = plan.items.filter(it => it.days && it.days.length);
  plan.items.forEach(it => it.days.sort((a, b) => a - b));
  if (!plan.items.length && weeksOfPlan(cycle, plan).length <= 1) {
    cycle.weekPlans = cycle.weekPlans.filter(p => p !== plan);
    cycle.weekAssign = cycle.weekAssign.map(id => id === plan.id ? null : id);
  }
  saveData();
  render();
}

function boardAdd(exId, day) {
  const cycle = getActiveCycle();
  if (!cycle) return;
  const plan = boardEditPlan(cycle);
  let it = plan.items.find(x => x.exId === exId);
  if (!it) { it = { exId, days: [] }; plan.items.push(it); }
  if (!it.days.includes(day)) it.days.push(day);
  boardTidy(cycle, plan);
}

function boardRemove(exId, day) {
  const cycle = getActiveCycle();
  if (!cycle) return;
  const plan = boardEditPlan(cycle);
  const it = plan.items.find(x => x.exId === exId);
  if (it) it.days = it.days.filter(d => d !== day);
  boardTidy(cycle, plan);
}

function boardMove(exId, from, to) {
  const cycle = getActiveCycle();
  if (!cycle || from === to) return;
  const plan = boardEditPlan(cycle);
  const it = plan.items.find(x => x.exId === exId);
  if (!it) return;
  it.days = it.days.filter(d => d !== from);
  if (!it.days.includes(to)) it.days.push(to);
  boardTidy(cycle, plan);
}

// An einem Tag eine Übung gegen eine andere tauschen
function boardSwap(exId, day, newExId) {
  const cycle = getActiveCycle();
  if (!cycle || exId === newExId) return;
  const plan = boardEditPlan(cycle);
  const it = plan.items.find(x => x.exId === exId);
  if (it) it.days = it.days.filter(d => d !== day);
  let nu = plan.items.find(x => x.exId === newExId);
  if (!nu) { nu = { exId: newExId, days: [] }; plan.items.push(nu); }
  if (!nu.days.includes(day)) nu.days.push(day);
  boardTidy(cycle, plan);
}

// Tipp auf einen Tag: Übung auswählen
function boardAddMenu(anchor, day) {
  const cycle = getActiveCycle();
  if (!cycle) return;
  const plan = weekPlanById(cycle, (cycle.weekAssign || [])[boardWeek(cycle)]);
  const has = new Set(plan ? plan.items.filter(it => it.days.includes(day)).map(it => it.exId) : []);
  const items = cycle.exercises.filter(ex => !has.has(ex.id))
    .map(ex => ({ label: ex.name, color: exerciseColor(cycle, ex.id), run: () => boardAdd(ex.id, day) }));
  if (items.length) items.push('-');
  items.push({ label: 'Neue Übung', run: () => openAddExerciseModal(day) });
  openMenu(anchor, items, DAYS_FULL[day]);
}

function boardChipMenu(anchor, exId, day) {
  const cycle = getActiveCycle();
  if (!cycle) return;
  const ex = cycle.exercises.find(e => e.id === exId);
  const plan = weekPlanById(cycle, (cycle.weekAssign || [])[boardWeek(cycle)]);
  const it = plan && plan.items.find(x => x.exId === exId);
  const others = cycle.exercises.filter(e => e.id !== exId);
  const items = [];
  if (others.length) items.push({ label: 'Tauschen', run: () => openMenu(anchor, others.map(o => ({
    label: o.name, color: exerciseColor(cycle, o.id), run: () => boardSwap(exId, day, o.id) })), 'Tauschen gegen') });
  items.push({ label: 'Wert und Hinweis', run: () => openItemModal(exId) });
  items.push('-', { label: 'Entfernen', danger: true, run: () => boardRemove(exId, day) });
  openMenu(anchor, items, `${ex ? ex.name : ''} · ${fmtExAmount(cycle, it ? itemAmount(cycle, it) : 0)}`);
}

function openItemModal(exId) {
  const cycle = getActiveCycle();
  const plan = weekPlanById(cycle, (cycle.weekAssign || [])[boardWeek(cycle)]);
  const it = plan && plan.items.find(x => x.exId === exId);
  const ex = cycle.exercises.find(e => e.id === exId);
  if (!it || !ex) return;
  openModal(`
    <div class="modal-title">${esc(ex.name)}</div>
    <div class="field"><label>${unitInfo(cycle).amount}</label>
      <input type="number" id="itemAmount" inputmode="decimal" step="${unitInfo(cycle).step}" min="0"
        value="${it.amount !== undefined ? it.amount : ''}" placeholder="${fmtNum(parseFloat(ex.intensity) || 0)}"></div>
    <div class="field"><label>Hinweis</label>
      <input type="text" id="itemNote" value="${esc(it.note || '')}" placeholder="z.B. Max Hangs 10 s, 5 Sätze"></div>
    <div class="row">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="saveItemModal('${exId}')">Speichern</button>
    </div>`);
}

function saveItemModal(exId) {
  const cycle = getActiveCycle();
  const plan = boardEditPlan(cycle);
  const it = plan.items.find(x => x.exId === exId);
  if (it) {
    const v = parseNum(document.getElementById('itemAmount')?.value);
    if (isNaN(v)) delete it.amount; else it.amount = v;
    const note = (document.getElementById('itemNote')?.value || '').trim();
    if (note) it.note = note; else delete it.note;
  }
  closeModal();
  boardTidy(cycle, plan);
}

// Ordnet Zykluswochen einem Plan zu (null = leer)
function assignWeeks(indices, planId) {
  const cycle = getActiveCycle();
  if (!cycle) return;
  ensureAssign(cycle);
  indices.forEach(i => { if (i >= 0 && i < (cycle.weeks || 12)) cycle.weekAssign[i] = planId; });
  // Pläne, die nirgends mehr gelten und leer sind, aufräumen
  cycle.weekPlans = cycle.weekPlans.filter(p => p.items.length || cycle.weekAssign.includes(p.id));
  saveData();
  render();
}

function openBoardMenu(anchor) {
  const cycle = getActiveCycle();
  if (!cycle) return;
  const n = cycle.weeks || 12;
  const w = boardWeek(cycle);
  const plan = weekPlanById(cycle, cycle.weekAssign[w]);
  const items = [];
  if (plan) {
    items.push({ label: 'Auf alle Wochen übertragen', run: () => assignWeeks(Array.from({ length: n }, (_, i) => i), plan.id) });
    if (w < n - 1) items.push({ label: `Auf Woche ${w + 2}–${n} übertragen`, run: () =>
      assignWeeks(Array.from({ length: n - w - 1 }, (_, k) => w + 1 + k), plan.id) });
    items.push({ label: 'Umbenennen', run: () => renameWeekPlan(plan.id) });
    items.push({ label: 'Im Repertoire speichern', run: () => saveToLibrary(plan.id) });
  }
  if ((appData.weekLibrary || []).length) items.push({ label: 'Aus dem Repertoire', run: () => openLibrarySheet() });
  if (plan) items.push({ label: `Woche ${w + 1} leeren`, danger: true, run: () => assignWeeks([w], null) });
  if (items.length) items.push('-');
  if (weekPlans(cycle).length && !cycle.forOther) items.push({ label: 'In den Kalender', run: () => openCalendarExport() });
  if (cycle.exercises.length && !cycle.forOther) items.push({ label: 'Plan teilen', run: () => openSharePlanModal() });
  if (!cycle.forOther) items.push({ label: 'Wochenplan ausschalten', run: () => togglePlanMode() });
  openMenu(anchor, items);
}

function renameWeekPlan(id) {
  const cycle = getActiveCycle();
  const plan = weekPlanById(cycle, id);
  if (!plan) return;
  const name = prompt('Name', plan.name);
  if (name === null || !name.trim()) return;
  plan.name = name.trim().slice(0, 40);
  saveData();
  render();
}

function deleteWeekPlan(id) {
  const cycle = getActiveCycle();
  const plan = weekPlanById(cycle, id);
  if (!plan) return;
  if (!confirm(`„${plan.name}" löschen?`)) { render(); return false; }
  cycle.weekPlans = cycle.weekPlans.filter(p => p.id !== id);
  cycle.weekAssign = (cycle.weekAssign || []).map(x => x === id ? null : x);
  saveData();
  render();
  return true;
}

// ── Repertoire ──
// Gespeicherte Wochen für spätere Zyklen – vollständig, mit eigenen Übungen.
function saveToLibrary(planId) {
  const cycle = getActiveCycle();
  const plan = weekPlanById(cycle, planId);
  if (!plan) return;
  const exercises = plan.items.filter(it => it.days.length).map(it => {
    const ex = cycle.exercises.find(e => e.id === it.exId) || {};
    const o = { name: ex.name || '?', categories: exerciseCategories(ex), amount: itemAmount(cycle, it), days: it.days.slice() };
    if (ex.desc) o.desc = ex.desc;
    if (ex.measure) { o.measure = true; o.unit = ex.unit || ''; }
    if (it.note) o.note = it.note;
    return o;
  });
  if (!exercises.length) return;
  if (!Array.isArray(appData.weekLibrary)) appData.weekLibrary = [];
  const same = appData.weekLibrary.find(w => w.name === plan.name);
  if (same && !confirm(`„${plan.name}" gibt es schon im Repertoire. Ersetzen?`)) return;
  const entry = { id: same ? same.id : newId(), name: plan.name, unit: cycleUnit(cycle), exercises };
  if (same) Object.assign(same, entry); else appData.weekLibrary.push(entry);
  saveData();
  render();
}

function openLibrarySheet() {
  const lib = appData.weekLibrary || [];
  openModal(`
    <div class="modal-title">Aus dem Repertoire</div>
    <div class="list-group">
      ${lib.map(w => `<div class="swipe-row" data-delete="deleteLibraryWeek('${esc(w.id)}')"><div class="swipe-action">Löschen</div>
        <div class="list-row swipe-content" onclick="useLibraryWeek('${esc(w.id)}')">
          <div class="list-main"><div class="list-title">${esc(w.name)}</div>
            <div class="list-sub">${libraryDays(w).map(d => DAYS_DE[d]).join(' ')} · ${fmtAmount({ unit: w.unit }, w.exercises.reduce((s, e) => s + e.amount * (e.days || []).length, 0))}</div></div>
          <button type="button" class="del-btn" onclick="event.stopPropagation();deleteLibraryWeek('${esc(w.id)}')" aria-label="${esc(w.name)} löschen">×</button>
        </div></div>`).join('')}
    </div>
    <button class="btn-link" onclick="closeModal()">Abbrechen</button>`);
}

// Eine Woche aus dem Repertoire in die gewählte Woche
function useLibraryWeek(id) {
  const cycle = getActiveCycle();
  const lib = (appData.weekLibrary || []).find(w => w.id === id);
  if (!cycle || !lib) return;
  ensureAssign(cycle);
  let plan = weekPlans(cycle).find(p => p.name.trim().toLowerCase() === lib.name.trim().toLowerCase());
  if (!plan) {
    const unit = cycleUnit(cycle);
    const byName = new Map(cycle.exercises.map(ex => [ex.name.trim().toLowerCase(), ex]));
    plan = { id: newId(), name: lib.name, items: lib.exercises.map(e => {
      const amount = convertAmount(e.amount, lib.unit || 'int', unit);
      let ex = byName.get(e.name.trim().toLowerCase());
      if (!ex) {
        ex = cloneExercise(Object.assign({}, e, { intensity: amount }));
        cycle.exercises.push(ex);
        byName.set(e.name.trim().toLowerCase(), ex);
      }
      const it = { exId: ex.id, days: (e.days || []).slice() };
      if (amount !== (parseFloat(ex.intensity) || 0)) it.amount = amount;
      if (e.note) it.note = e.note;
      return it;
    }) };
    cycle.weekPlans.push(plan);
  }
  cycle.weekAssign[boardWeek(cycle)] = plan.id;
  cycle.mode = cycle.mode || 'plan';
  saveData();
  closeModal();
  render();
}

function deleteLibraryWeek(id) {
  const w = (appData.weekLibrary || []).find(x => x.id === id);
  if (!w || !confirm(`„${w.name}" aus dem Repertoire löschen?`)) { if (w) openLibrarySheet(); return; }
  appData.weekLibrary = appData.weekLibrary.filter(x => x.id !== id);
  saveData();
  if (appData.weekLibrary.length) openLibrarySheet(); else closeModal();
}

function libraryDays(w) {
  const set = new Set();
  w.exercises.forEach(ex => (ex.days || []).forEach(d => set.add(d)));
  return [...set].sort((a, b) => a - b);
}

// ── Menü ──
// Kleines Aufklappmenü an einem Knopf. items: { label, color?, check?,
// danger?, run } oder '-' als Trennlinie.
let menuState = null;

function openMenu(anchor, items, title) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'pop-menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = (title ? `<div class="pop-title">${esc(title)}</div>` : '') + items.map((it, k) => it === '-'
    ? '<div class="pop-sep"></div>'
    : `<button type="button" role="menuitem" class="pop-item ${it.danger ? 'danger' : ''}" data-k="${k}">
        ${it.color ? `<span class="pop-dot" style="background:${it.color}"></span>` : ''}
        <span class="pop-label">${esc(it.label)}</span>
        ${it.check ? `<span class="pop-check">${CHECK_SVG.replace('#000', 'currentColor')}</span>` : ''}
      </button>`).join('');
  m.addEventListener('click', e => {
    const b = e.target.closest('.pop-item');
    if (!b) return;
    const it = items[+b.dataset.k];
    closeMenu();
    it.run();
  });
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  m.style.left = left + 'px';
  m.style.top = top + 'px';
  m.style.transformOrigin = `${r.left + r.width / 2 - left}px ${top > r.top ? 0 : h}px`;
  anchor.classList.add('menu-open');
  menuState = { m, anchor };
  requestAnimationFrame(() => m.classList.add('open'));
  // Der öffnende Tipp ist schon durch (Klick kommt nach pointerdown)
  document.addEventListener('pointerdown', menuOutside, true);
  window.addEventListener('scroll', closeMenu, true);
  window.addEventListener('resize', closeMenu);
}

function closeMenu() {
  if (!menuState) return;
  menuState.m.remove();
  menuState.anchor.classList.remove('menu-open');
  menuState = null;
  document.removeEventListener('pointerdown', menuOutside, true);
  window.removeEventListener('scroll', closeMenu, true);
  window.removeEventListener('resize', closeMenu);
}

// Ein Tipp daneben schließt nur das Menü
function menuOutside(e) {
  if (!menuState || menuState.m.contains(e.target)) return;
  closeMenu();
  window.addEventListener('click', swallowDragClick, true);
  setTimeout(() => window.removeEventListener('click', swallowDragClick, true), 400);
}

// ── Ziehen & Ablegen ──
// Pointer-Events statt der HTML5-Drag-API (die auf iOS nicht greift). Ein
// kurzer Tipp bleibt ein normaler Klick; erst ab ein paar Pixeln Bewegung
// wird gezogen. Ziele tragen data-drop="art:wert".
//   kind 'week'  gewählte Woche → andere Wochen der Leiste "week:i"
//                (über mehrere ziehen = alle bekommen ihren Plan)
//   kind 'bex'   Übung → Tag der Woche "bday:d", ab einem Tag auch
//                "trash" zum Entfernen
//   kind 'date'  geplanter Trainingstag → anderer Tag "date:yyyy-mm-dd"
let dnd = null;

function dndPress(e, spec) {
  if (e.button > 0 || dnd) return;
  dnd = { spec, src: e.currentTarget, x: e.clientX, y: e.clientY, active: false, over: null, painted: [],
    scroller: e.currentTarget.closest('.modal, .draft-body') || document.scrollingElement || document.documentElement };
  window.addEventListener('pointermove', dndMove);
  window.addEventListener('pointerup', dndUp);
  window.addEventListener('pointercancel', dndCancel);
}

function dndAccepts(spec, target) {
  const t = target.dataset.drop || '';
  if (spec.kind === 'week') return t.startsWith('week:');
  if (spec.kind === 'bex') return t.startsWith('bday:') ? +t.slice(5) !== spec.from : (t === 'trash' && spec.from !== undefined);
  if (spec.kind === 'date') return t.startsWith('date:') && t.slice(5) !== spec.from;
  return false;
}

function dndMove(e) {
  const s = dnd;
  if (!s) return;
  s.cx = e.clientX; s.cy = e.clientY;
  if (!s.active) {
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < 6) return;
    s.active = true;
    closeMenu();
    const g = document.createElement('div');
    g.className = 'dnd-ghost';
    if (s.spec.color) g.style.setProperty('--c', s.spec.color);
    g.innerHTML = `${s.spec.color ? '<span class="tok-dot"></span>' : ''}${esc(s.spec.label || '')}`;
    document.body.appendChild(g);
    s.ghost = g;
    s.src.classList.add('dnd-src');
    document.body.classList.add('dnd-on', 'dnd-' + s.spec.kind + (s.spec.from !== undefined ? '-from' : ''));
    dndAutoScroll();
  }
  e.preventDefault();
  if (!s.gw) s.gw = s.ghost.offsetWidth;
  const gx = Math.max(8, Math.min(e.clientX - 20, window.innerWidth - s.gw - 8));
  s.ghost.style.transform = `translate(${gx}px, ${e.clientY - 54}px)`;
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const target = hit && hit.closest('[data-drop]');
  const ok = target && dndAccepts(s.spec, target) ? target : null;
  if (ok !== s.over) {
    if (s.over) s.over.classList.remove('drop-over');
    if (ok) ok.classList.add('drop-over');
    s.over = ok;
  }
  if (ok && s.spec.kind === 'week') {
    const i = +ok.dataset.drop.slice(5);
    if (!s.painted.includes(i)) {
      s.painted.push(i);
      ok.style.setProperty('--c', s.spec.color);
      ok.classList.toggle('has', !!s.spec.plan);
      ok.classList.add('painted');
    }
  }
}

// Am oberen und unteren Rand läuft die Liste mit
function dndAutoScroll() {
  const s = dnd;
  if (!s || !s.active) return;
  if (s.cy !== undefined) {
    const isPage = s.scroller === document.scrollingElement || s.scroller === document.documentElement;
    const r = isPage ? { top: 0, bottom: window.innerHeight } : s.scroller.getBoundingClientRect();
    const edge = 56;
    const dy = s.cy < r.top + edge ? -Math.ceil((r.top + edge - s.cy) / 4)
      : s.cy > r.bottom - edge ? Math.ceil((s.cy - (r.bottom - edge)) / 4) : 0;
    if (dy) s.scroller.scrollTop += dy;
  }
  requestAnimationFrame(dndAutoScroll);
}

function dndCleanup() {
  const s = dnd;
  dnd = null;
  window.removeEventListener('pointermove', dndMove);
  window.removeEventListener('pointerup', dndUp);
  window.removeEventListener('pointercancel', dndCancel);
  if (!s) return null;
  if (s.ghost) s.ghost.remove();
  if (s.over) s.over.classList.remove('drop-over');
  s.src.classList.remove('dnd-src');
  document.body.className = document.body.className.split(' ').filter(c => !c.startsWith('dnd-')).join(' ');
  return s;
}

function dndCancel() {
  const s = dndCleanup();
  if (s && s.active) render();
}

function dndUp() {
  const s = dndCleanup();
  if (!s || !s.active) return;
  window.addEventListener('click', swallowDragClick, true);
  setTimeout(() => window.removeEventListener('click', swallowDragClick, true), 350);
  dndDrop(s.spec, s.over ? s.over.dataset.drop : null, s.painted);
}

function dndDrop(spec, target, painted) {
  if (spec.kind === 'week') {
    const weeks = (painted || []).filter(i => i !== spec.from);
    if (weeks.length) assignWeeks(weeks, spec.plan || null); else render();
    return;
  }
  if (spec.kind === 'bex') {
    if (!target) return;
    if (target === 'trash') boardRemove(spec.exId, spec.from);
    else if (spec.from === undefined) boardAdd(spec.exId, +target.slice(5));
    else boardMove(spec.exId, spec.from, +target.slice(5));
    return;
  }
  if (spec.kind === 'date' && target) {
    moveTrainingDay(spec.from, target.slice(5));
    weekMoveFrom = null;
    if (spec.week !== undefined && document.getElementById('weekView')) renderWeekView(spec.week);
    render();
  }
}

// ── Nach links wischen zum Löschen ──
// Für Zeilen mit .swipe-row; data-delete enthält den Aufruf. Ein kurzer
// Wisch legt den Löschen-Knopf frei, ein weiter Wisch löscht sofort.
let swipeState = null;

function swipeDown(e) {
  const content = e.target.closest && e.target.closest('.swipe-content');
  if (!content) return;
  document.querySelectorAll('.swipe-row.open').forEach(r => { if (r !== content.parentNode) closeSwipe(r); });
  swipeState = { row: content.parentNode, content, x: e.clientX, y: e.clientY, dx: 0, active: false,
    base: content.parentNode.classList.contains('open') ? -88 : 0 };
}

function swipeMove(e) {
  const s = swipeState;
  if (!s) return;
  const dx = e.clientX - s.x, dy = e.clientY - s.y;
  if (!s.active) {
    if (Math.abs(dx) < 8) return;
    if (Math.abs(dy) > Math.abs(dx)) { swipeState = null; return; }
    s.active = true;
  }
  s.dx = dx;
  const x = Math.min(0, Math.max(-s.row.offsetWidth, s.base + dx));
  s.content.style.transition = 'none';
  s.content.style.transform = `translateX(${x}px)`;
}

function swipeUp() {
  const s = swipeState;
  swipeState = null;
  if (!s || !s.active) return;
  const x = s.base + s.dx;
  s.content.style.transition = '';
  window.addEventListener('click', swallowDragClick, true);
  setTimeout(() => window.removeEventListener('click', swallowDragClick, true), 350);
  if (x < -s.row.offsetWidth * 0.6) { s.content.style.transform = `translateX(-100%)`; runSwipeDelete(s.row); return; }
  if (x < -44) { s.row.classList.add('open'); s.content.style.transform = 'translateX(-88px)'; }
  else closeSwipe(s.row);
}

function closeSwipe(row) {
  row.classList.remove('open');
  const c = row.querySelector('.swipe-content');
  if (c) c.style.transform = '';
}

function runSwipeDelete(row) {
  const call = row.dataset.delete;
  const m = /^(\w+)\('([^']*)'\)$/.exec(call || '');
  if (m && typeof window[m[1]] === 'function') window[m[1]](m[2]);
}

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('pointerdown', swipeDown);
  document.addEventListener('pointermove', swipeMove);
  document.addEventListener('pointerup', swipeUp);
  document.addEventListener('pointercancel', () => { if (swipeState) closeSwipe(swipeState.row); swipeState = null; });
  document.addEventListener('click', e => {
    const btn = e.target.closest && e.target.closest('.swipe-action');
    if (btn) runSwipeDelete(btn.parentNode);
  });
}

// ═══════════════════════════════════════════════
// KALENDER-EXPORT
// ═══════════════════════════════════════════════
// Die geplanten Trainingstage als .ics-Datei – lässt sich in jeden Kalender
// übernehmen (iPhone, Google, Outlook). Mit Uhrzeit als Termin, sonst
// ganztägig. Verschiebungen und Pausen sind berücksichtigt.
let calOpts = { range: 'future', time: '18:00', duration: 120 };

function plannedTrainingDays(cycle, from) {
  const days = trainingDays(cycle, (cycle.weeks || 12) * 7);
  return days.filter(d => d >= from).map(d => ({ date: d, items: plannedItems(cycle, d) })).filter(x => x.items.length);
}

function icsText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Zeilen über 75 Bytes werden nach RFC 5545 umgebrochen (Folgezeile mit Leerzeichen)
function icsFold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function buildIcs(cycle, opts) {
  const from = opts.range === 'all' ? cycle.startDate : toDateStr(new Date());
  const compact = d => d.replace(/-/g, '');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Boulder Training//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsText('Training · ' + cycle.name)];
  plannedTrainingDays(cycle, from).forEach(({ date, items }) => {
    lines.push('BEGIN:VEVENT', `UID:${compact(date)}-${String(cycle.id).replace(/[^\w-]/g, '')}@boulder-training`, 'DTSTAMP:' + stamp);
    if (opts.time) {
      const [h, m] = opts.time.split(':').map(Number);
      const start = new Date(parseDate(date).getTime() + (h * 60 + m) * 60000);
      const end = new Date(start.getTime() + (opts.duration || 120) * 60000);
      const loc = d => `${toDateStr(d).replace(/-/g, '')}T${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}00`;
      lines.push('DTSTART:' + loc(start), 'DTEND:' + loc(end));
    } else {
      lines.push('DTSTART;VALUE=DATE:' + compact(date), 'DTEND;VALUE=DATE:' + compact(addDays(date, 1)));
    }
    const week = weekIndexOfDate(cycle, date);
    lines.push('SUMMARY:' + icsText('Training: ' + items.map(x => x.ex.name).join(', ')));
    lines.push('DESCRIPTION:' + icsText([`${cycle.name} · Woche ${week + 1}`]
      .concat(items.map(x => `• ${x.ex.name} (${fmtExAmount(cycle, x.amount)})${x.note ? ' – ' + x.note : ''}`)).join('\n')));
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

function openCalendarExport() {
  const cycle = getActiveCycle();
  if (!cycle) return;
  const from = calOpts.range === 'all' ? cycle.startDate : toDateStr(new Date());
  const n = plannedTrainingDays(cycle, from).length;
  openModal(`
    <div class="modal-title">In den Kalender</div>
    <div class="field"><label>Zeitraum</label>
      <div class="seg">
        <button type="button" class="${calOpts.range === 'future' ? 'on' : ''}" onclick="calOpts.range='future';openCalendarExport()">Ab heute</button>
        <button type="button" class="${calOpts.range === 'all' ? 'on' : ''}" onclick="calOpts.range='all';openCalendarExport()">Ganzer Zyklus</button>
      </div>
    </div>
    <div class="row">
      <div class="field"><label>Uhrzeit</label>
        <input type="time" id="calTime" value="${calOpts.time}" onchange="calOpts.time=this.value"></div>
      <div class="field"><label>Dauer</label>
        <select id="calDur" onchange="calOpts.duration=parseInt(this.value,10)">
          ${[60, 90, 120, 150, 180].map(m => `<option value="${m}" ${calOpts.duration === m ? 'selected' : ''}>${fmtNum(m / 60)} h</option>`).join('')}
        </select></div>
    </div>
    <div class="check-row" onclick="calOpts.time=calOpts.time?'':'18:00';openCalendarExport()">
      <div class="check-box ${calOpts.time ? '' : 'checked'}">${calOpts.time ? '' : CHECK_SVG}</div>
      <div class="check-label">Ganztägig, ohne Uhrzeit</div>
    </div>
    <div class="group-note" style="margin:10px 0 16px">${n} ${n === 1 ? 'Trainingstag' : 'Trainingstage'}</div>
    <button class="btn btn-primary btn-full" ${n ? '' : 'disabled'} onclick="doCalendarExport()">Exportieren</button>
    <button class="btn-link" onclick="closeModal()">Abbrechen</button>
  `);
  if (!calOpts.time) { const t = document.getElementById('calTime'); if (t) t.disabled = true; const dsel = document.getElementById('calDur'); if (dsel) dsel.disabled = true; }
}

async function doCalendarExport() {
  const cycle = getActiveCycle();
  if (!cycle) return;
  const t = document.getElementById('calTime');
  if (t && !t.disabled) calOpts.time = t.value;
  const ics = buildIcs(cycle, calOpts);
  const name = `training-${(cycle.name || 'plan').toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-')}.ics`;
  const file = typeof File === 'function' ? new File([ics], name, { type: 'text/calendar' }) : null;
  // Auf dem iPhone öffnet das Teilen-Menü direkt "Zum Kalender hinzufügen"
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Training · ' + cycle.name }); closeModal(); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = name;
  a.click();
  closeModal();
}
