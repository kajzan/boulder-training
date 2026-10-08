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

// Was an einem Tag geplant ist: [{ ex, amount, note }]
function plannedItems(cycle, dateStr) {
  if (!isPlanMode(cycle)) return [];
  const plan = weekPlanFor(cycle, weekIndexOfDate(cycle, dateStr));
  if (!plan) return [];
  const wd = weekdayOf(dateStr);
  return plan.items
    .filter(it => (it.days || []).includes(wd))
    .map(it => ({ ex: cycle.exercises.find(e => e.id === it.exId), amount: itemAmount(cycle, it), note: it.note || '' }))
    .filter(x => x.ex);
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

// ── Vorlage in einen Zyklus übernehmen ──
// Übungen gleichen Namens werden wiederverwendet. Die Wochen der Vorlage
// werden neu zugeordnet: erst feste Wochen, dann "jede 4.", dann der Rest.
function applyTemplate(cycle, tpl) {
  const unit = cycleUnit(cycle);
  ensureAssign(cycle);
  const byName = new Map(cycle.exercises.map(ex => [ex.name.trim().toLowerCase(), ex]));
  const keyToId = {};
  tpl.exercises.forEach(t => {
    let ex = byName.get(t.name.trim().toLowerCase());
    if (!ex) {
      ex = cloneExercise(Object.assign({}, t, { intensity: templateAmount(t, unit) }));
      cycle.exercises.push(ex);
      byName.set(t.name.trim().toLowerCase(), ex);
    }
    keyToId[t.key] = ex.id;
  });
  const n = cycle.weeks || 12;
  const assign = Array(n).fill(null);
  const created = tpl.plan.map(w => {
    const plan = { id: newId(), name: w.name, items: w.items.map(([key, days, amount, note]) => {
      const it = { exId: keyToId[key], days: days.slice() };
      if (amount !== undefined && amount !== null) it.amount = templateAmount({ intensity: amount }, unit);
      if (note) it.note = note;
      return it;
    }) };
    cycle.weekPlans.push(plan);
    return [w.applies, plan];
  });
  created.forEach(([a, plan]) => { if (Array.isArray(a)) a.forEach(i => { if (i < n) assign[i] = plan.id; }); });
  created.forEach(([a, plan]) => { if (a && a.every) for (let i = a.every - 1; i < n; i += a.every) assign[i] = plan.id; });
  created.forEach(([a, plan]) => { if (a === 'rest') for (let i = 0; i < n; i++) if (!assign[i]) assign[i] = plan.id; });
  cycle.weekAssign = assign;
  cycle.mode = 'plan';
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

// Wochenplan einschalten. Ohne Wochen hilft die App beim Start: ohne Übungen
// mit einer Vorlage, sonst mit einer Woche, vorgeschlagen aus dem bisherigen
// Training.
function startPlanning(cycle) {
  if (weekPlans(cycle).length) return;
  if (!cycle.exercises.length) { openTemplatePicker(); return; }
  const suggested = suggestExerciseDays(cycle);
  const items = cycle.exercises.map(ex => ({ exId: ex.id, days: suggested[ex.id] || [] })).filter(it => it.days.length);
  openWeekEditor(null, { items, allWeeks: true, fromHistory: items.length > 0 });
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
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function renderPlanning(cycle) {
  ensureAssign(cycle);
  const plans = weekPlans(cycle);
  const n = cycle.weeks || 12;
  const current = getCurrentWeekIndex(cycle);

  const timeline = `
    <div class="tl-grid">
      ${Array.from({ length: n }, (_, i) => {
        const plan = weekPlanFor(cycle, i);
        const color = plan ? weekPlanColor(cycle, plan) : null;
        return `<button type="button" class="tl-cell ${i === current ? 'current' : ''}" onclick="openWeekAssign(${i})"
          style="${color ? `background:${hexA(color, 0.14)};border-color:${hexA(color, 0.45)}` : ''}">
          <span class="tl-num">${i + 1}</span>
          <span class="tl-name" style="${color ? `color:${color}` : ''}">${plan ? esc(plan.name) : '–'}</span>
        </button>`;
      }).join('')}
    </div>`;

  const planRows = plans.map(plan => {
    const color = weekPlanColor(cycle, plan);
    const weeks = weeksOfPlan(cycle, plan);
    const days = planDays(plan);
    return `<div class="list-row" onclick="openWeekEditor('${plan.id}')">
      <span class="plan-swatch" style="background:${color}"></span>
      <div class="list-main">
        <div class="list-title">${esc(plan.name)}</div>
        <div class="list-sub" style="display:block">${weeks.length ? 'Woche ' + formatWeekRanges(weeks) : 'Keiner Woche zugeordnet'}
          · ${days.length ? days.map(d => DAYS_DE[d]).join(' ') : 'keine Tage'} · ${fmtAmount(cycle, planTotal(cycle, plan))}</div>
      </div>
      <span class="chev">›</span>
    </div>`;
  }).join('');

  return `
    <div class="section-hdr" style="margin-top:0"><h2>Wochen</h2>
      <button class="btn btn-primary btn-sm" onclick="openAddWeekSheet()">+ Woche</button></div>
    ${plans.length ? `
      <div class="card">
        <div class="card-title">Zyklus · ${n} ${n === 1 ? 'Woche' : 'Wochen'}</div>
        ${timeline}
        <div class="group-note" style="margin:10px 0 0">Tippe auf eine Woche, um ihr einen Plan zuzuordnen.</div>
      </div>
      <div class="list-group">${planRows}</div>`
    : `<div class="card plan-empty">
        <div class="plan-empty-title">Noch keine Woche geplant</div>
        <div class="text-muted" style="margin-bottom:14px">Stell eine Woche aus deinen Übungen zusammen oder starte mit einer Vorlage.</div>
        <div class="row">
          <button class="btn btn-ghost" onclick="openWeekEditor(null)">Leere Woche</button>
          <button class="btn btn-primary" onclick="openTemplatePicker()">Vorlage</button>
        </div>
      </div>`}
    ${renderLibrarySection()}
  `;
}

function renderLibrarySection() {
  const lib = appData.weekLibrary || [];
  if (!lib.length) return '';
  return `
    <div class="group-label">Mein Repertoire</div>
    <div class="list-group">
      ${lib.map(w => `<div class="list-row" onclick="openLibraryEntry('${esc(w.id)}')">
        <div class="list-main">
          <div class="list-title">${esc(w.name)}</div>
          <div class="list-sub" style="display:block">${w.exercises.length} Übungen · ${libraryDays(w).map(d => DAYS_DE[d]).join(' ')}</div>
        </div>
        <span class="chev">›</span>
      </div>`).join('')}
    </div>`;
}

function libraryDays(w) {
  const set = new Set();
  w.exercises.forEach(ex => (ex.days || []).forEach(d => set.add(d)));
  return [...set].sort((a, b) => a - b);
}

// ── Eine Zykluswoche zuordnen ──
function openWeekAssign(i) {
  const cycle = getActiveCycle();
  if (!cycle) return;
  const current = (cycle.weekAssign || [])[i] || null;
  const wd = getWeekDates(cycle, i);
  openModal(`
    <div class="modal-title" style="margin-bottom:4px">Woche ${i + 1}</div>
    <div class="text-muted" style="margin-bottom:16px">${formatDateRange(wd[0], wd[6])}</div>
    <div class="list-group">
      ${weekPlans(cycle).map(plan => `<div class="list-row" onclick="assignWeek(${i}, '${plan.id}')">
        <span class="plan-swatch" style="background:${weekPlanColor(cycle, plan)}"></span>
        <div class="list-main"><div class="list-title">${esc(plan.name)}</div>
          <div class="list-sub">${fmtAmount(cycle, planTotal(cycle, plan))}</div></div>
        ${plan.id === current ? `<span class="list-check">${CHECK_SVG.replace('#000', 'currentColor')}</span>` : ''}
      </div>`).join('')}
      <div class="list-row" onclick="assignWeek(${i}, null)">
        <span class="plan-swatch" style="background:var(--surface2);border:1px solid var(--border)"></span>
        <div class="list-main"><div class="list-title">Ohne Plan</div><div class="list-sub">Frei trainieren</div></div>
        ${!current ? `<span class="list-check">${CHECK_SVG.replace('#000', 'currentColor')}</span>` : ''}
      </div>
    </div>
    <button class="btn btn-ghost btn-full" style="margin-top:14px" onclick="openWeekEditor(null, { weeks: [${i}] })">Neue Woche für Woche ${i + 1}</button>
    <button class="btn-link" onclick="closeModal()">Fertig</button>
  `);
}

function assignWeek(i, planId) {
  const cycle = getActiveCycle();
  if (!cycle) return;
  ensureAssign(cycle);
  cycle.weekAssign[i] = planId;
  saveData();
  closeModal();
}

// ── Woche hinzufügen ──
function openAddWeekSheet() {
  const lib = appData.weekLibrary || [];
  openModal(`
    <div class="modal-title">Woche hinzufügen</div>
    <div class="list-group">
      <div class="list-row" onclick="openWeekEditor(null)">
        <div class="list-main"><div class="list-title">Leere Woche</div><div class="list-sub">Selbst zusammenstellen</div></div>
        <span class="chev">›</span>
      </div>
      ${lib.length ? `<div class="list-row" onclick="openLibraryPicker()">
        <div class="list-main"><div class="list-title">Aus meinem Repertoire</div><div class="list-sub">${lib.length} gespeicherte ${lib.length === 1 ? 'Woche' : 'Wochen'}</div></div>
        <span class="chev">›</span>
      </div>` : ''}
      <div class="list-row" onclick="openTemplatePicker()">
        <div class="list-main"><div class="list-title">Vorlage übernehmen</div><div class="list-sub">Ganzer Plan mit Aufbau- und Entlastungswochen</div></div>
        <span class="chev">›</span>
      </div>
    </div>
    <button class="btn-link" onclick="closeModal()">Abbrechen</button>
  `);
}

// ═══════════════════════════════════════════════
// WOCHEN-EDITOR
// ═══════════════════════════════════════════════
// Arbeitet auf einer Kopie (weekDraft); erst "Speichern" schreibt in den
// Zyklus. Die Tage stehen untereinander – so denkt man eine Trainingswoche.
let weekDraft = null;

function nextWeekName(cycle) {
  const names = ['Aufbauwoche', 'Entlastungswoche', 'Kraftwoche', 'Technikwoche'];
  const used = new Set(weekPlans(cycle).map(p => p.name));
  return names.find(n => !used.has(n)) || `Woche ${weekPlans(cycle).length + 1}`;
}

// opts: { items, weeks, allWeeks, fromHistory } für neue Wochen
function openWeekEditor(planId, opts = {}) {
  const cycle = getActiveCycle();
  if (!cycle) return;
  ensureAssign(cycle);
  const plan = planId ? weekPlanById(cycle, planId) : null;
  const n = cycle.weeks || 12;
  weekDraft = {
    planId: plan ? plan.id : null,
    name: plan ? plan.name : nextWeekName(cycle),
    items: JSON.parse(JSON.stringify(plan ? plan.items : (opts.items || []))),
    weeks: plan ? weeksOfPlan(cycle, plan)
      : opts.weeks ? opts.weeks.slice()
      : (opts.allWeeks || !weekPlans(cycle).length) ? Array.from({ length: n }, (_, i) => i) : [],
    pickDay: null,
    sel: null,
    notice: opts.fromHistory ? 'Vorgeschlagen aus deinem bisherigen Training – passe die Tage an.' : ''
  };
  openModal('<div id="weekEditor"></div>');
  renderWeekEditor();
}

function renderWeekEditor() {
  const box = document.getElementById('weekEditor');
  const cycle = getActiveCycle();
  if (!box || !cycle || !weekDraft) return;
  const d = weekDraft;
  const n = cycle.weeks || 12;
  const myColor = d.planId ? weekPlanColor(cycle, weekPlanById(cycle, d.planId)) : WEEK_COLORS[weekPlans(cycle).length % WEEK_COLORS.length];
  const exName = id => (cycle.exercises.find(e => e.id === id) || {}).name || '?';
  const total = Math.round(d.items.reduce((s, it) => s + itemAmount(cycle, it) * it.days.length, 0) * 100) / 100;

  const weekChips = Array.from({ length: n }, (_, i) => {
    const on = d.weeks.includes(i);
    const other = !on && weekPlanById(cycle, cycle.weekAssign[i]);
    const otherColor = other && other.id !== d.planId ? weekPlanColor(cycle, other) : null;
    return `<button type="button" class="wk-chip ${on ? 'on' : ''}" onclick="weToggleWeek(${i})"
      style="${on ? `background:${myColor};border-color:${myColor}` : ''}">${i + 1}${otherColor ? `<span class="wk-dot" style="background:${otherColor}"></span>` : ''}</button>`;
  }).join('');

  const dayRows = DAYS_FULL.map((dayName, day) => {
    const items = d.items.filter(it => it.days.includes(day));
    const picking = d.pickDay === day;
    const selItem = d.sel && d.sel.day === day ? d.items.find(it => it.exId === d.sel.exId) : null;
    const available = cycle.exercises.filter(ex => !items.some(it => it.exId === ex.id));
    return `<div class="we-day ${items.length ? 'has' : ''}">
      <div class="we-day-row">
        <span class="we-day-name">${DAYS_DE[day]}</span>
        <div class="we-chips">${items.length ? items.map(it => `
          <button type="button" class="we-chip ${selItem && selItem.exId === it.exId ? 'sel' : ''}" onclick="weSelect(${day}, '${it.exId}')">
            ${esc(exName(it.exId))}<span class="we-amt">${fmtExAmount(cycle, itemAmount(cycle, it))}</span>${it.note ? '<span class="we-has-note">•</span>' : ''}
          </button>`).join('') : '<span class="we-rest">Ruhetag</span>'}</div>
        <button type="button" class="we-add ${picking ? 'on' : ''}" onclick="wePick(${day})" aria-label="Übung am ${dayName} hinzufügen">${picking ? '×' : '+'}</button>
      </div>
      ${picking ? `<div class="we-picker">
        ${available.map(ex => `<button type="button" class="we-option" onclick="weAdd(${day}, '${ex.id}')">${esc(ex.name)}</button>`).join('')}
        <div class="we-new">
          <input type="text" id="weNewName" placeholder="Neue Übung" onkeydown="if(event.key==='Enter')weNewExercise(${day})">
          <input type="number" id="weNewAmt" inputmode="decimal" step="${unitInfo(cycle).step}" min="0" placeholder="${unitInfo(cycle).short || 'Wert'}">
          <button type="button" class="btn btn-primary btn-sm" onclick="weNewExercise(${day})">+</button>
        </div>
      </div>` : ''}
      ${selItem ? `<div class="we-edit">
        <div class="we-edit-row">
          <label>${unitInfo(cycle).amount} in dieser Woche</label>
          <input type="number" inputmode="decimal" step="${unitInfo(cycle).step}" min="0" value="${selItem.amount !== undefined ? selItem.amount : ''}"
            placeholder="${fmtNum(parseFloat((cycle.exercises.find(e => e.id === selItem.exId) || {}).intensity) || 0)}" oninput="weSetAmount(this.value)">
        </div>
        <div class="we-edit-row">
          <label>Hinweis für diese Woche</label>
          <input type="text" value="${esc(selItem.note || '')}" placeholder="z.B. Max Hangs 10 s, 5 Sätze" oninput="weSetNote(this.value)">
        </div>
        <div class="we-edit-actions">
          <button type="button" class="btn btn-ghost btn-sm" onclick="weRemove(${day})">Am ${dayName} entfernen</button>
          <button type="button" class="btn btn-ghost btn-sm" onclick="weSelect(null)">Fertig</button>
        </div>
      </div>` : ''}
    </div>`;
  }).join('');

  box.innerHTML = `
    <input type="text" class="we-title" value="${esc(d.name)}" oninput="weekDraft.name=this.value" aria-label="Name der Woche">
    ${d.notice ? `<div class="sheet-notice">${esc(d.notice)}</div>` : ''}
    <div class="we-section">
      <div class="we-label">Gilt in Woche</div>
      <div class="wk-grid">${weekChips}</div>
      <div class="we-presets">
        <button type="button" onclick="wePreset('all')">Alle</button>
        <button type="button" onclick="wePreset('free')">Alle freien</button>
        <button type="button" onclick="wePreset('every4')">Jede 4.</button>
        <button type="button" onclick="wePreset('none')">Keine</button>
      </div>
    </div>
    <div class="we-section">
      <div class="we-label">Woche <span class="we-total">${fmtAmount(cycle, total)}</span></div>
      ${dayRows}
    </div>
    <button class="btn btn-primary btn-full" style="margin-top:6px" onclick="weSave()">Speichern</button>
    <div class="row" style="margin-top:10px">
      <button class="btn btn-ghost btn-sm" onclick="weToLibrary()">Ins Repertoire</button>
      ${d.planId ? `<button class="btn btn-ghost btn-sm" onclick="weDuplicate()">Duplizieren</button>` : ''}
    </div>
    ${d.planId ? `<button class="btn-link" style="color:var(--red)" onclick="weDelete()">Woche löschen</button>` : ''}
    <button class="btn-link" style="margin-top:0" onclick="closeModal()">Abbrechen</button>
  `;
}

function weToggleWeek(i) {
  const w = weekDraft.weeks;
  const k = w.indexOf(i);
  if (k >= 0) w.splice(k, 1); else w.push(i);
  renderWeekEditor();
}

function wePreset(kind) {
  const cycle = getActiveCycle();
  const n = cycle.weeks || 12;
  const all = Array.from({ length: n }, (_, i) => i);
  if (kind === 'all') weekDraft.weeks = all;
  if (kind === 'none') weekDraft.weeks = [];
  if (kind === 'every4') weekDraft.weeks = all.filter(i => i % 4 === 3);
  if (kind === 'free') weekDraft.weeks = all.filter(i => !cycle.weekAssign[i] || cycle.weekAssign[i] === weekDraft.planId || weekDraft.weeks.includes(i));
  renderWeekEditor();
}

function wePick(day) {
  weekDraft.pickDay = weekDraft.pickDay === day ? null : day;
  weekDraft.sel = null;
  renderWeekEditor();
}

function weAdd(day, exId) {
  const it = weekDraft.items.find(x => x.exId === exId);
  if (it) { if (!it.days.includes(day)) it.days.push(day); it.days.sort((a, b) => a - b); }
  else weekDraft.items.push({ exId, days: [day] });
  weekDraft.pickDay = null;
  weekDraft.notice = '';
  renderWeekEditor();
}

// Neue Übung direkt aus dem Editor – landet auch im Übungskatalog des Zyklus
function weNewExercise(day) {
  const cycle = getActiveCycle();
  const name = (document.getElementById('weNewName')?.value || '').trim();
  if (!name) return;
  const amount = parseFloat((document.getElementById('weNewAmt')?.value || '').replace(',', '.'));
  const ex = { id: newId(), name, categories: [], intensity: isNaN(amount) ? unitInfo(cycle).step * 2 : amount };
  cycle.exercises.push(ex);
  saveData();
  weAdd(day, ex.id);
}

function weSelect(day, exId) {
  weekDraft.sel = day === null ? null : (weekDraft.sel && weekDraft.sel.day === day && weekDraft.sel.exId === exId ? null : { day, exId });
  weekDraft.pickDay = null;
  renderWeekEditor();
}

function selectedItem() {
  return weekDraft && weekDraft.sel ? weekDraft.items.find(it => it.exId === weekDraft.sel.exId) : null;
}

function weSetAmount(raw) {
  const it = selectedItem();
  if (!it) return;
  const v = parseFloat(String(raw).replace(',', '.'));
  if (isNaN(v)) delete it.amount; else it.amount = v;
  const totalEl = document.querySelector('#weekEditor .we-total');
  const cycle = getActiveCycle();
  if (totalEl) totalEl.textContent = fmtAmount(cycle, weekDraft.items.reduce((s, x) => s + itemAmount(cycle, x) * x.days.length, 0));
}

function weSetNote(raw) {
  const it = selectedItem();
  if (!it) return;
  const t = String(raw).trim();
  if (t) it.note = t; else delete it.note;
}

function weRemove(day) {
  const it = selectedItem();
  if (!it) return;
  it.days = it.days.filter(x => x !== day);
  if (!it.days.length) weekDraft.items = weekDraft.items.filter(x => x !== it);
  weekDraft.sel = null;
  renderWeekEditor();
}

// Schreibt den Entwurf in den Zyklus. Gibt die Woche zurück.
function commitWeekDraft() {
  const cycle = getActiveCycle();
  ensureAssign(cycle);
  let plan = weekDraft.planId ? weekPlanById(cycle, weekDraft.planId) : null;
  if (!plan) {
    plan = { id: newId() };
    cycle.weekPlans.push(plan);
    weekDraft.planId = plan.id;
  }
  plan.name = (weekDraft.name || '').trim() || nextWeekName(cycle);
  plan.items = weekDraft.items.filter(it => it.days.length).map(it => {
    const o = { exId: it.exId, days: it.days.slice().sort((a, b) => a - b) };
    if (it.amount !== undefined) o.amount = it.amount;
    if (it.note) o.note = it.note;
    return o;
  });
  cycle.weekAssign = cycle.weekAssign.map((id, i) =>
    weekDraft.weeks.includes(i) ? plan.id : (id === plan.id ? null : id));
  cycle.mode = 'plan';
  saveData();
  return plan;
}

function weSave() {
  commitWeekDraft();
  weekDraft = null;
  closeModal();
  render();
}

function weDuplicate() {
  const cycle = getActiveCycle();
  const plan = commitWeekDraft();
  const copy = { id: newId(), name: plan.name + ' (Kopie)', items: JSON.parse(JSON.stringify(plan.items)) };
  cycle.weekPlans.push(copy);
  saveData();
  openWeekEditor(copy.id);
}

function weDelete() {
  const cycle = getActiveCycle();
  if (!weekDraft.planId || !confirm('Diese Woche löschen? Ihre Zuordnung zu den Zykluswochen geht verloren.')) return;
  cycle.weekPlans = cycle.weekPlans.filter(p => p.id !== weekDraft.planId);
  cycle.weekAssign = cycle.weekAssign.map(id => id === weekDraft.planId ? null : id);
  weekDraft = null;
  saveData();
  closeModal();
  render();
}

// ── Repertoire ──
function weToLibrary() {
  const cycle = getActiveCycle();
  const d = weekDraft;
  const exercises = d.items.filter(it => it.days.length).map(it => {
    const ex = cycle.exercises.find(e => e.id === it.exId) || {};
    const o = { name: ex.name || '?', categories: exerciseCategories(ex), amount: itemAmount(cycle, it), days: it.days.slice() };
    if (ex.desc) o.desc = ex.desc;
    if (ex.measure) { o.measure = true; o.unit = ex.unit || ''; }
    if (it.note) o.note = it.note;
    return o;
  });
  if (!exercises.length) { d.notice = 'Die Woche ist noch leer.'; renderWeekEditor(); return; }
  if (!Array.isArray(appData.weekLibrary)) appData.weekLibrary = [];
  const name = (d.name || '').trim() || 'Woche';
  const same = appData.weekLibrary.find(w => w.name === name);
  if (same && !confirm(`„${name}" gibt es schon im Repertoire. Ersetzen?`)) return;
  const entry = { id: same ? same.id : newId(), name, unit: cycleUnit(cycle), exercises };
  if (same) Object.assign(same, entry); else appData.weekLibrary.push(entry);
  saveData();
  d.notice = `„${name}" ist im Repertoire gespeichert und steht in jedem Zyklus zur Verfügung.`;
  renderWeekEditor();
}

function openLibraryPicker() {
  const lib = appData.weekLibrary || [];
  openModal(`
    <div class="modal-title">Aus meinem Repertoire</div>
    <div class="list-group">
      ${lib.map(w => `<div class="list-row" onclick="insertLibraryWeek('${esc(w.id)}')">
        <div class="list-main"><div class="list-title">${esc(w.name)}</div>
          <div class="list-sub" style="display:block">${w.exercises.map(e => esc(e.name)).join(', ')}</div></div>
        <span class="chev">›</span>
      </div>`).join('')}
    </div>
    <button class="btn-link" onclick="openAddWeekSheet()">Zurück</button>
  `);
}

function openLibraryEntry(id) {
  const w = (appData.weekLibrary || []).find(x => x.id === id);
  if (!w) return;
  const cycle = getActiveCycle();
  const unit = { unit: w.unit };
  openModal(`
    <div class="modal-title" style="margin-bottom:4px">${esc(w.name)}</div>
    <div class="text-muted" style="margin-bottom:14px">Aus deinem Repertoire</div>
    <div class="card">
      ${DAYS_DE.map((dn, day) => {
        const exs = w.exercises.filter(e => (e.days || []).includes(day));
        return exs.length ? `<div class="plan-day"><span class="plan-wd">${dn}</span><span>${exs.map(e => esc(e.name) + ' <span class="text-muted">' + fmtExAmount(unit, e.amount) + '</span>').join(', ')}</span></div>` : '';
      }).join('')}
    </div>
    ${cycle ? `<button class="btn btn-primary btn-full" onclick="insertLibraryWeek('${esc(w.id)}')">In „${esc(cycle.name)}" einfügen</button>` : ''}
    <button class="btn-link" style="color:var(--red)" onclick="deleteLibraryWeek('${esc(w.id)}')">Aus dem Repertoire löschen</button>
    <button class="btn-link" style="margin-top:0" onclick="closeModal()">Schließen</button>
  `);
}

// Fügt eine Repertoire-Woche in den aktiven Zyklus ein und öffnet sie, damit
// gleich die Wochen gewählt werden können, in denen sie gilt.
function insertLibraryWeek(id) {
  const cycle = getActiveCycle();
  const w = (appData.weekLibrary || []).find(x => x.id === id);
  if (!cycle || !w) return;
  ensureAssign(cycle);
  const unit = cycleUnit(cycle);
  const byName = new Map(cycle.exercises.map(ex => [ex.name.trim().toLowerCase(), ex]));
  const items = w.exercises.map(e => {
    const amount = convertAmount(e.amount, w.unit || 'int', unit);
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
  });
  const plan = { id: newId(), name: w.name, items };
  cycle.weekPlans.push(plan);
  cycle.mode = 'plan';
  saveData();
  openWeekEditor(plan.id);
  // Ist im Zyklus noch nichts zugeordnet, gilt sie zunächst überall
  if (!cycle.weekAssign.some(Boolean)) weekDraft.weeks = cycle.weekAssign.map((_, i) => i);
  weekDraft.notice = 'Wähle oben, in welchen Wochen sie gilt.';
  renderWeekEditor();
}

function deleteLibraryWeek(id) {
  if (!confirm('Diese Woche aus dem Repertoire löschen? Zyklen, die sie verwenden, bleiben unverändert.')) return;
  appData.weekLibrary = (appData.weekLibrary || []).filter(w => w.id !== id);
  saveData();
  closeModal();
  render();
}

// ── Vorlagen ──
function openTemplatePicker() {
  const cycle = getActiveCycle();
  if (!cycle) return;
  openModal(`
    <div class="modal-title">Vorlage übernehmen</div>
    <div class="text-muted" style="margin-bottom:16px;line-height:1.5">Übernimmt Übungen und Wochen samt Zuordnung in „${esc(cycle.name)}". Danach lässt sich alles anpassen.</div>
    <div class="list-group">
      ${PLAN_TEMPLATES.map(t => `<div class="list-row" onclick="openTemplateApply('${t.id}')">
        <div class="list-main">
          <div class="list-title">${esc(t.name)}</div>
          <div class="list-sub" style="display:block">${esc(t.level)}</div>
        </div>
        <span class="chev">›</span>
      </div>`).join('')}
    </div>
    <button class="btn-link" onclick="closeModal()">Abbrechen</button>
  `);
}

function templateAppliesText(applies) {
  if (applies === 'rest') return 'alle übrigen Wochen';
  if (applies && applies.every) return `jede ${applies.every}. Woche`;
  if (Array.isArray(applies)) return 'Woche ' + formatWeekRanges(applies);
  return '';
}

function openTemplateApply(tplId) {
  const cycle = getActiveCycle();
  const tpl = PLAN_TEMPLATES.find(t => t.id === tplId);
  if (!cycle || !tpl) return;
  const exName = key => (tpl.exercises.find(e => e.key === key) || {}).name || key;
  openModal(`
    <div class="modal-title" style="margin-bottom:4px">${esc(tpl.name)}</div>
    <div class="text-muted" style="margin-bottom:14px">${esc(tpl.level)}</div>
    ${tpl.plan.map((w, k) => `<div class="card">
      <div class="card-title" style="display:flex;align-items:center;gap:8px">
        <span class="plan-swatch" style="background:${WEEK_COLORS[(weekPlans(cycle).length + k) % WEEK_COLORS.length]}"></span>
        ${esc(w.name)} <span style="text-transform:none;letter-spacing:0;color:var(--text-dim)">· ${templateAppliesText(w.applies)}</span>
      </div>
      ${DAYS_DE.map((dn, day) => {
        const items = w.items.filter(it => it[1].includes(day));
        return items.length ? `<div class="plan-day"><span class="plan-wd">${dn}</span><span>${items.map(it => esc(exName(it[0]))).join(', ')}</span></div>` : '';
      }).join('')}
    </div>`).join('')}
    ${weekPlans(cycle).length ? `<div class="group-note" style="margin:0 0 12px">Deine bisherigen Wochen bleiben erhalten, die Zuordnung übernimmt die Vorlage.</div>` : ''}
    <button class="btn btn-primary btn-full" onclick="applyTemplateToActive('${tpl.id}')">In „${esc(cycle.name)}" übernehmen</button>
    <button class="btn-link" onclick="openTemplatePicker()">Zurück</button>
  `);
}

function applyTemplateToActive(tplId) {
  const cycle = getActiveCycle();
  const tpl = PLAN_TEMPLATES.find(t => t.id === tplId);
  if (!cycle || !tpl) return;
  applyTemplate(cycle, tpl);
  saveData();
  closeModal();
  if (currentView !== 'plan') switchView('plan'); else render();
}
