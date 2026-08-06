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
}

function getDefaultData() {
  return {
    cycles: [],
    activeCycleId: null,
    tests: [],        // [{id, name, kind, unit, scaleId, higherIsBetter, usesBodyweight, category}]
    assessments: []   // [{id, date, label, cycleId, bodyweight, results:[{testId, value, note}]}]
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
function migrateCycles() {
  let changed = false;
  appData.cycles.forEach(c => {
    if (typeof c.weeks !== 'number' || c.weeks < 1) {
      c.weeks = 12;
      changed = true;
    }
    // Ensure weekTargets matches weeks length
    if (!Array.isArray(c.weekTargets)) c.weekTargets = [];
    while (c.weekTargets.length < c.weeks) c.weekTargets.push(0);
    if (c.weekTargets.length > c.weeks) c.weekTargets = c.weekTargets.slice(0, c.weeks);

    // Ensure each exercise has a category field
    (c.exercises || []).forEach(ex => {
      if (ex.category === undefined || ex.category === null) {
        ex.category = '';
        changed = true;
      }
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
  if (changed) saveData();
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

function getActiveCycle() {
  if (!appData.activeCycleId) return null;
  return appData.cycles.find(c => c.id === appData.activeCycleId) || null;
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

// ── Categories ──
const CATEGORY_PALETTE = [
  '#2ecc71', '#4a9eff', '#c8ff00', '#ff7eb3',
  '#ffa726', '#ab47bc', '#26c6da', '#ffca28'
];

function getAllCategoriesInCycle(cycle) {
  const set = new Set();
  let hasUncategorized = false;
  (cycle.exercises || []).forEach(ex => {
    if (ex.category && ex.category.trim()) set.add(ex.category.trim());
    else hasUncategorized = true;
  });
  const sorted = Array.from(set).sort((a,b) => a.localeCompare(b, 'de'));
  if (hasUncategorized) sorted.push('Sonstige');
  return sorted;
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
      const cat = (ex.category && ex.category.trim()) ? ex.category.trim() : 'Sonstige';
      const eff = getEffectiveIntensity(cycle, entry);
      out[cat] = (out[cat] || 0) + eff;
    });
  });
  return out;
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

// ── Build tappable chips of existing categories ──
function buildCategoryChips(inputId) {
  const cycle = getActiveCycle();
  if (!cycle) return '';
  const allCats = getAllCategoriesInCycle(cycle).filter(c => c !== 'Sonstige');
  if (allCats.length === 0) return '';
  return `<div style="font-size:11px;color:var(--text-muted);margin-top:8px;margin-bottom:4px">Vorhandene Kategorien (tippen zum Übernehmen):</div>
  <div style="display:flex;flex-wrap:wrap;gap:6px">
    ${allCats.map(cat => {
      const color = categoryColor(cat, allCats);
      return `<button type="button" data-target="${inputId}" data-cat="${esc(cat)}"
        onclick="document.getElementById(this.dataset.target).value=this.dataset.cat"
        style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:5px 10px;font-size:12px;color:var(--text);display:inline-flex;align-items:center;gap:5px;cursor:pointer;font-family:inherit">
        <span style="color:${color};font-size:13px;line-height:1">●</span>
        ${esc(cat)}
      </button>`;
    }).join('')}
  </div>`;
}

function getWeekDates(cycle, weekIndex) {
  const start = parseDate(cycle.startDate);
  start.setHours(0,0,0,0);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + weekIndex * 7 + i);
    days.push(toDateStr(d));
  }
  return days;
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

function intensityClass(current, target) {
  if (target === 0) return 'int-blue';
  const diff = current - target;
  if (current === 0 && target > 0) return 'int-blue';
  if (diff > 1) return 'int-red';
  if (Math.abs(diff) <= 1) return 'int-green-dark';
  if (current > 0 && diff < -1 && current >= target * 0.5) return 'int-green-light';
  return 'int-blue';
}

function intensityLabel(current, target) {
  if (target === 0) return '–';
  const diff = current - target;
  if (diff > 1) return '↑ überschritten';
  if (Math.abs(diff) <= 1) return '✓ erreicht';
  // Schräg nach unten: der Wert liegt unter dem Ziel, wenn auch nur knapp.
  if (current > 0 && current >= target * 0.5) return '↘ fast erreicht';
  return '↓ noch offen';
}

function getCurrentWeekIndex(cycle) {
  const start = parseDate(cycle.startDate);
  start.setHours(0,0,0,0);
  const today = new Date();
  today.setHours(0,0,0,0);
  const diffDays = Math.floor((today - start) / (1000 * 60 * 60 * 24));
  const weekIdx = Math.floor(diffDays / 7);
  const maxW = (cycle.weeks || 12) - 1;
  return Math.max(0, Math.min(maxW, weekIdx));
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

function renderIntensityChart(cycle) {
  const W = cycle.weeks || 12;
  const targets = [];
  const actuals = [];
  const breakdowns = [];
  for (let i = 0; i < W; i++) {
    targets.push(cycle.weekTargets[i] || 0);
    actuals.push(getWeekIntensity(cycle, i));
    breakdowns.push(getWeekCategoryBreakdown(cycle, i));
  }
  const currentWeek = getCurrentWeekIndex(cycle);
  const allCats = getAllCategoriesInCycle(cycle);

  // Y scale with nice steps
  const rawMax = Math.max(1, ...targets, ...actuals) * 1.1;
  const step = niceYStep(rawMax);
  const niceMax = Math.ceil(rawMax / step) * step;
  const numSteps = Math.round(niceMax / step);

  // SVG dimensions
  const w = 320, h = 180;
  const padL = 28, padR = 12, padT = 16, padB = 30;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;
  const stepX = chartW / Math.max(W, 1);

  const xFor = i => padL + (i + 0.5) * stepX;
  const yFor = v => padT + chartH - (v / niceMax) * chartH;
  const yZero = yFor(0);

  // Bar width
  const barW = W === 1 ? 24 : Math.max(2, Math.min(22, stepX * 0.55));

  const fmtY = v => (v === Math.floor(v)) ? v.toString() : v.toFixed(1).replace(/\.0$/, '');

  // Y axis grid + labels
  const gridLines = [];
  for (let g = 0; g <= numSteps; g++) {
    const yVal = step * g;
    const yPx = yFor(yVal);
    gridLines.push(`<line x1="${padL}" y1="${yPx}" x2="${w-padR}" y2="${yPx}" stroke="var(--border)" stroke-width="0.5"/>`);
    gridLines.push(`<text x="${padL - 4}" y="${yPx + 3}" font-size="9" fill="var(--text-dim)" text-anchor="end" font-family="DM Mono, monospace">${fmtY(yVal)}</text>`);
  }

  // X axis labels: even numbers with sensible spacing
  const labelStep = W <= 1 ? 1 : W <= 12 ? 2 : W <= 24 ? 4 : W <= 48 ? 8 : 10;
  const xLabels = [];
  if (W === 1) {
    xLabels.push(`<text x="${xFor(0)}" y="${h - 14}" font-size="9" fill="var(--text-dim)" text-anchor="middle" font-family="DM Mono, monospace">1</text>`);
  } else {
    for (let weekNum = labelStep; weekNum <= W; weekNum += labelStep) {
      const i = weekNum - 1;
      xLabels.push(`<text x="${xFor(i)}" y="${h - 14}" font-size="9" fill="var(--text-dim)" text-anchor="middle" font-family="DM Mono, monospace">${weekNum}</text>`);
    }
  }

  // Stacked bars per week, ordered by allCats (consistent stack order)
  const bars = [];
  for (let i = 0; i < W; i++) {
    const bd = breakdowns[i];
    if (!bd) continue;
    let yBottomPx = yZero;
    const bx = xFor(i) - barW / 2;
    allCats.forEach(cat => {
      const val = bd[cat] || 0;
      if (val <= 0) return;
      const segH = (val / niceMax) * chartH;
      const segY = yBottomPx - segH;
      const color = categoryColor(cat, allCats);
      bars.push(`<rect x="${bx.toFixed(1)}" y="${segY.toFixed(1)}" width="${barW.toFixed(1)}" height="${segH.toFixed(1)}" fill="${color}" opacity="0.9"/>`);
      yBottomPx = segY;
    });
  }

  // Target line (accent dashed) + dots
  const targetPath = targets.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(v)}`).join(' ');
  const targetDots = targets.map((v, i) => `<circle cx="${xFor(i)}" cy="${yFor(v)}" r="2.5" fill="var(--accent)"/>`).join('');

  // Interactive tooltip: transparent touch targets + floating tooltip group
  const chartId = 'intChart';
  const touchTargets = Array.from({length: W}, (_, i) => {
    const cx = xFor(i);
    const tx = padL + i * stepX;
    const topY = yFor(Math.max(targets[i], actuals[i], 0.01));
    return `<rect x="${tx.toFixed(1)}" y="${padT}" width="${stepX.toFixed(1)}" height="${chartH}" fill="transparent" data-wk="${i}" data-act="${actuals[i]}" data-tgt="${targets[i]}" data-cx="${cx.toFixed(1)}" data-ty="${topY.toFixed(1)}" onclick="showChartTooltip(this,'${chartId}')"/>`;
  });
  const tipGroup = `<g id="${chartId}_tip" style="display:none" pointer-events="none"><rect id="${chartId}_bg" x="0" y="0" width="72" height="30" rx="3" fill="#0a0a0a" opacity="0.85"/><text id="${chartId}_ta" x="0" y="0" font-size="8.5" fill="#fff" font-family="DM Mono,monospace"></text><text id="${chartId}_tt" x="0" y="0" font-size="8.5" fill="var(--accent)" font-family="DM Mono,monospace"></text></g>`;

  // Current week marker
  const cwX = xFor(currentWeek);
  const currentMarker = `<line x1="${cwX}" y1="${padT}" x2="${cwX}" y2="${h - padB}" stroke="var(--accent)" stroke-width="0.5" stroke-dasharray="2,3" opacity="0.4"/>`;

  // Determine which categories actually have data, for legend
  const usedCats = allCats.filter(cat => {
    return breakdowns.some(bd => (bd[cat] || 0) > 0);
  });

  // Legend
  const targetLegend = `<span style="display:inline-flex;align-items:center;gap:4px;color:var(--text-muted)">
    <span style="width:14px;height:2px;background:var(--accent);display:inline-block;border-top:1px dashed transparent"></span> Ziel
  </span>`;

  let legendCats;
  if (usedCats.length === 0) {
    legendCats = `<span style="display:inline-flex;align-items:center;gap:4px;color:var(--text-muted)">
      <span style="width:10px;height:10px;background:#888;display:inline-block;border-radius:2px"></span> Ist
    </span>`;
  } else {
    legendCats = usedCats.map(cat => {
      const color = categoryColor(cat, allCats);
      return `<span style="display:inline-flex;align-items:center;gap:4px;color:var(--text-muted)">
        <span style="width:10px;height:10px;background:${color};display:inline-block;border-radius:2px"></span> ${esc(cat)}
      </span>`;
    }).join('');
  }

  return `
    <div class="card">
      <div class="card-title">Intensitätsverlauf</div>
      <svg id="${chartId}" viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;display:block" preserveAspectRatio="xMidYMid meet">
        ${gridLines.join('')}
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
function showChartTooltip(el, id) {
  const tip = document.getElementById(id + '_tip');
  if (!tip) return;
  const wk = el.getAttribute('data-wk');
  // Toggle off if same bar tapped again
  if (tip.getAttribute('data-active') === wk && tip.style.display !== 'none') {
    tip.style.display = 'none'; return;
  }
  tip.setAttribute('data-active', wk);
  const act = parseFloat(el.getAttribute('data-act'));
  const tgt = parseFloat(el.getAttribute('data-tgt'));
  const cx  = parseFloat(el.getAttribute('data-cx'));
  const ty0 = parseFloat(el.getAttribute('data-ty'));
  const fmt = v => (v === Math.floor(v)) ? v.toString() : v.toFixed(1).replace(/\.0$/, '');
  const bg  = document.getElementById(id + '_bg');
  const ta  = document.getElementById(id + '_ta');
  const tt  = document.getElementById(id + '_tt');
  const TW = 72, TH = 30, P = 5;
  const tx = Math.max(P, Math.min(320 - TW - P, cx - TW / 2));
  const ty = Math.max(P, ty0 - TH - 6);
  bg.setAttribute('x', tx); bg.setAttribute('y', ty);
  ta.textContent = 'Ist:  ' + fmt(act);
  ta.setAttribute('x', tx + P); ta.setAttribute('y', ty + 12);
  tt.textContent = 'Ziel: ' + fmt(tgt);
  tt.setAttribute('x', tx + P); tt.setAttribute('y', ty + 24);
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
      <div class="empty">
        <div class="empty-icon">🧗</div>
        <div>Noch kein aktiver Trainingszyklus.<br>Erstelle deinen ersten Zyklus in den <strong>Einstellungen</strong>.</div>
        <br>
        <button class="btn btn-primary" onclick="switchView('settings')">→ Einstellungen</button>
      </div>`;
    document.getElementById('navSub').textContent = 'Kein aktiver Zyklus';
    return;
  }

  const totalWeeks = cycle.weeks || 12;
  const weekIdx = getCurrentWeekIndex(cycle);
  const weekDays = getWeekDates(cycle, weekIdx);
  const weekInt = getWeekIntensity(cycle, weekIdx);
  const target = cycle.weekTargets[weekIdx] || 0;
  const iClass = intensityClass(weekInt, target);
  const today = toDateStr(new Date());

  document.getElementById('navSub').textContent = cycle.name + ' · Woche ' + (weekIdx + 1);

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

  el.innerHTML = `
    ${renderAssessmentReminder()}
    <div class="section-hdr"><h2>Diese Woche</h2><span class="text-muted">KW${getKW(new Date())}</span></div>

    <div class="card mb-0">
      <div class="card-title">Woche ${weekIdx+1} von ${totalWeeks} · Intensität</div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px">
        <span style="font-family:'DM Mono',monospace;font-size:32px;color:var(--accent)">${weekInt}</span>
        <span class="text-muted">/ ${target} Ziel</span>
        <span class="intensity-badge ${iClass}" style="margin-left:auto">${intensityLabel(weekInt, target)}</span>
      </div>
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill" style="width:${pct}%;background:${barColor}"></div>
      </div>
    </div>

    <div class="stats-row" style="margin-top:10px">
      <div class="stat-card">
        <div class="stat-val">${weekIdx+1}<span style="font-size:13px;color:var(--text-muted)">/${totalWeeks}</span></div>
        <div class="stat-lbl">Aktuelle Woche</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">${trainingDays}</div>
        <div class="stat-lbl">Trainingstage gesamt</div>
      </div>
    </div>

    ${renderIntensityChart(cycle)}

    <div class="section-hdr" style="margin-top:8px"><h2>Diese Trainingswoche</h2></div>
    <div class="card">
      <div class="week-grid">
        ${dayLabelsShort.map((d, i) => {
          const dateStr = weekDays[i];
          const exIds = cycle.sessions[dateStr] || [];
          const isToday = dateStr === today;
          return `<div class="day-col">
            <div class="day-label" style="${isToday ? 'color:var(--accent)' : ''}">${d}</div>
            <div class="day-dot ${exIds.length > 0 ? 'has-session' : ''}"
                 style="${isToday ? 'border-color:var(--accent);' : ''}"
                 onclick="openDayModal('${dateStr}')">
              ${exIds.length > 0 ? exIds.length : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
      <div style="text-align:center;font-size:12px;color:var(--text-muted);margin-top:4px">${formatDateRange(weekDays[0], weekDays[6])}</div>
    </div>

    <div class="section-hdr"><h2>Alle ${totalWeeks} Wochen</h2></div>
    ${Array.from({length: totalWeeks}, (_,i) => {
      const wint = getWeekIntensity(cycle, i);
      const wtgt = cycle.weekTargets[i] || 0;
      const wc = intensityClass(wint, wtgt);
      const wd = getWeekDates(cycle, i);
      const isCurrent = i === weekIdx;
      return `<div class="week-row ${isCurrent ? 'current-week' : ''}" onclick="openWeekModal(${i})">
        <div class="week-row-left">
          <div class="week-row-num">Woche ${i+1}${isCurrent ? ' · Aktuell' : ''}</div>
          <div class="week-row-date">${formatDateRange(wd[0], wd[6])}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-family:'DM Mono',monospace;font-size:14px;color:var(--text-muted)">${wint}/${wtgt}</span>
          <span class="intensity-badge ${wc}" style="font-size:11px;padding:3px 8px">${
            wc==='int-blue'?'↓':wc==='int-green-light'?'↘':wc==='int-green-dark'?'✓':'↑'
          }</span>
        </div>
      </div>`;
    }).join('')}
  `;
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
  const entries = cycle.sessions[dateStr] || [];
  const selected = new Set(entries.map(e => entryId(e)));
  const allCats = getAllCategoriesInCycle(cycle);

  const exList = cycle.exercises.length === 0
    ? `<div class="empty" style="padding:20px 0"><div>Noch keine Übungen im Plan.<br>Gehe zu <strong>Trainingsplan</strong>.</div></div>`
    : cycle.exercises.map(ex => {
        const checked = selected.has(ex.id);
        const entry = entries.find(e => entryId(e) === ex.id);
        const ov = entry ? entryOverride(entry) : null;
        const inputVal = ov !== null ? ov : ex.intensity;
        const cat = (ex.category && ex.category.trim()) ? ex.category.trim() : '';
        const catColor = cat ? categoryColor(cat, allCats) : '';

        return `<div class="check-row" style="display:flex;align-items:center;gap:8px;padding:6px 0">
          <div onclick="toggleDayEx('${dateStr}','${ex.id}', ${returnToWeek !== undefined && returnToWeek !== null ? returnToWeek : 'null'})"
               style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer">
            <div class="check-box ${checked ? 'checked' : ''}" style="flex-shrink:0">
              ${checked ? '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
            </div>
            <div style="flex:1;min-width:0">
              <div class="check-label" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(ex.name)}</div>
              <div style="font-size:11px;color:var(--text-muted);font-family:'DM Mono',monospace;display:flex;align-items:center;gap:5px">
                ${cat ? `<span style="color:${catColor};font-size:13px;line-height:1">●</span><span style="font-family:'DM Sans',sans-serif">${esc(cat)}</span><span style="color:var(--text-dim)">·</span>` : ''}
                <span>Std: ${ex.intensity}</span>
                ${ov !== null ? `<span style="color:var(--accent)">→ ${ov}</span>` : ''}
              </div>
            </div>
          </div>
          ${checked ? `
            <input type="number" step="0.5" min="0" value="${inputVal}"
              onchange="setOverride('${dateStr}','${ex.id}', this.value)"
              onclick="event.stopPropagation()"
              style="width:62px;text-align:right;padding:6px 8px;font-size:14px;flex-shrink:0"
              title="Intensität für diese Einheit anpassen">
          ` : ''}
        </div>`;
      }).join('');

  const dayInt = entries.reduce((s, e) => s + getEffectiveIntensity(cycle, e), 0);

  const finishBtn = (returnToWeek !== undefined && returnToWeek !== null && !isNaN(parseFloat(returnToWeek)))
    ? `<button class="btn btn-ghost btn-full" onclick="closeModal();setTimeout(()=>openWeekModal(${returnToWeek}),250)">Fertig · zurück zur Woche</button>`
    : `<button class="btn btn-ghost btn-full" onclick="closeModal()">Fertig</button>`;

  return `
    <div class="modal-title">${title}</div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
      <span class="text-muted">Tages-Intensität:</span>
      <span id="dayIntDisplay" style="font-family:'DM Mono',monospace;font-size:18px;color:var(--accent)">${Math.round(dayInt*10)/10}</span>
    </div>
    <div class="card-title">Übungen abhaken</div>
    ${exList}
    <div class="divider"></div>
    ${finishBtn}
  `;
}

function toggleDayEx(dateStr, exId, returnToWeek) {
  const cycle = getActiveCycle();
  if (!cycle) return;
  if (!cycle.sessions[dateStr]) cycle.sessions[dateStr] = [];
  const idx = cycle.sessions[dateStr].findIndex(e => entryId(e) === exId);
  if (idx >= 0) {
    cycle.sessions[dateStr].splice(idx, 1);
  } else {
    cycle.sessions[dateStr].push({ exId });
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
    const v = parseFloat(trimmed);
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
  if (totalEl) totalEl.textContent = Math.round(dayInt * 10) / 10;
  if (currentView === 'dashboard') renderDashboard();
}

// ═══════════════════════════════════════════════
// WEEK MODAL
// ═══════════════════════════════════════════════
function openWeekModal(weekIdx) {
  const cycle = getActiveCycle();
  if (!cycle) return;
  const days = getWeekDates(cycle, weekIdx);
  const target = cycle.weekTargets[weekIdx] || 0;
  const wInt = getWeekIntensity(cycle, weekIdx);
  const iClass = intensityClass(wInt, target);
  const allCats = getAllCategoriesInCycle(cycle);

  const content = `
    <div class="modal-title">Woche ${weekIdx+1}</div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
      <span class="intensity-badge ${iClass}">${wInt} / ${target}</span>
      <span class="text-muted">${intensityLabel(wInt, target)}</span>
    </div>
    <div style="margin-bottom:8px"><span class="text-muted">${formatDateRange(days[0], days[6])}</span></div>
    <div style="font-size:11px;color:var(--text-dim);margin-bottom:12px">Tippe auf einen Tag, um Übungen einzutragen oder zu bearbeiten.</div>
    <div class="divider" style="margin-top:0"></div>
    ${days.map((dateStr, i) => {
      const entries = cycle.sessions[dateStr] || [];
      const dayInt = entries.reduce((s, e) => s + getEffectiveIntensity(cycle, e), 0);
      const d = parseDate(dateStr);
      const dow = (d.getDay() + 6) % 7;
      return `<div style="margin-bottom:10px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;cursor:pointer" onclick="closeModal();setTimeout(()=>openDayModal('${dateStr}', ${weekIdx}),250)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:${entries.length>0?'6px':'0'}">
          <strong style="font-size:13px">${DAYS_FULL[dow]}, ${d.getDate()}. ${MONTHS_DE[d.getMonth()]}</strong>
          <span style="font-family:'DM Mono',monospace;font-size:12px;color:${entries.length>0?'var(--accent)':'var(--text-dim)'}">
            ${entries.length > 0 ? Math.round(dayInt*10)/10 : '+ eintragen'}
          </span>
        </div>
        ${entries.length === 0
          ? ''
          : entries.map(entry => {
              const ex = cycle.exercises.find(e => e.id === entryId(entry));
              if (!ex) return '';
              const eff = getEffectiveIntensity(cycle, entry);
              const ov = entryOverride(entry);
              const cat = (ex.category && ex.category.trim()) ? ex.category.trim() : '';
              const catColor = cat ? categoryColor(cat, allCats) : '';
              return `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px">
                <span style="display:flex;align-items:center;gap:5px">
                  ${cat ? `<span style="color:${catColor};font-size:11px;line-height:1">●</span>` : ''}
                  <span>${esc(ex.name)}</span>
                </span>
                <span style="font-family:'DM Mono',monospace;color:var(--text-muted)">
                  ${ov !== null ? `<span style="color:var(--accent)">${eff}</span> <span style="color:var(--text-dim);font-size:10px">(Std: ${ex.intensity})</span>` : eff}
                </span>
              </div>`;
            }).join('')
        }
      </div>`;
    }).join('')}
    <button class="btn btn-ghost btn-full" onclick="closeModal()">Schließen</button>
  `;
  openModal(content);
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

  el.innerHTML = `
    <div class="section-hdr" style="margin-top:0">
      <h2>Übungen</h2>
      <button class="btn btn-primary btn-sm" onclick="openAddExerciseModal()">+ Hinzufügen</button>
    </div>

    ${cycle.exercises.length === 0
      ? `<div class="empty"><div class="empty-icon">💪</div><div>Noch keine Übungen.<br>Füge deine erste Übung hinzu!</div></div>`
      : (() => {
          const allCats = getAllCategoriesInCycle(cycle);
          return cycle.exercises.map(ex => {
            const cat = (ex.category && ex.category.trim()) ? ex.category.trim() : '';
            const catColor = cat ? categoryColor(cat, allCats) : '#888';
            return `
            <div class="exercise-item" onclick="openEditExerciseModal('${ex.id}')" style="cursor:pointer">
              <div style="flex:1;min-width:0">
                <div class="exercise-name">${esc(ex.name)}</div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:2px;display:flex;align-items:center;gap:5px">
                  ${cat ? `<span style="color:${catColor};font-size:14px;line-height:1">●</span><span>${esc(cat)}</span><span style="color:var(--text-dim)">·</span>` : ''}
                  <span>Tippen zum Bearbeiten</span>
                </div>
              </div>
              <div class="exercise-int">×${ex.intensity}</div>
              <button class="del-btn" onclick="event.stopPropagation(); deleteExercise('${ex.id}')">×</button>
            </div>
          `}).join('');
        })()
    }

    <div class="divider"></div>
    <div class="section-hdr"><h2>Wochenziele</h2></div>
    <div class="card-title">Intensitätsziel pro Woche (1–${cycle.weeks || 12})</div>
    ${Array.from({length: cycle.weeks || 12}, (_,i) => {
      const wd = getWeekDates(cycle, i);
      return `
      <div class="exercise-item" style="padding:10px 14px">
        <div style="flex:1">
          <div style="font-size:13px">Woche ${i+1}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${formatDateRange(wd[0], wd[6])}</div>
        </div>
        <input type="number" step="0.5" min="0"
          style="width:80px;text-align:right;padding:6px 10px"
          value="${cycle.weekTargets[i] || 0}"
          onchange="updateWeekTarget(${i}, this.value)">
      </div>
    `}).join('')}
  `;
}

function openAddExerciseModal() {
  const cycle = getActiveCycle();
  const allCats = getAllCategoriesInCycle(cycle).filter(c => c !== 'Sonstige');
  const datalist = allCats.length > 0
    ? `<datalist id="catList">${allCats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>`
    : '';
  const content = `
    <div class="modal-title">Übung hinzufügen</div>
    <div class="field">
      <label>Name der Übung</label>
      <input type="text" id="newExName" placeholder="z.B. Kilterboard Session">
    </div>
    <div class="field">
      <label>Kategorie (optional)</label>
      <input type="text" id="newExCat" placeholder="z.B. Krafttraining, Klettern, Fingertraining" list="catList">
      ${datalist}
      ${buildCategoryChips('newExCat')}
    </div>
    <div class="field">
      <label>Intensitätswert</label>
      <input type="number" id="newExInt" step="0.5" min="0" placeholder="z.B. 2">
    </div>
    <div class="row" style="margin-top:4px">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="addExercise()">Hinzufügen</button>
    </div>
  `;
  openModal(content);
  setTimeout(() => document.getElementById('newExName')?.focus(), 300);
}

function addExercise() {
  const name = document.getElementById('newExName')?.value?.trim();
  const category = document.getElementById('newExCat')?.value?.trim() || '';
  const intensity = parseFloat(document.getElementById('newExInt')?.value);
  if (!name || isNaN(intensity) || intensity < 0) {
    alert('Bitte Name und gültigen Intensitätswert eingeben.');
    return;
  }
  const cycle = getActiveCycle();
  cycle.exercises.push({ id: Date.now().toString(), name, category, intensity });
  saveData();
  closeModal();
  renderPlan();
}

function openEditExerciseModal(exId) {
  const cycle = getActiveCycle();
  const ex = cycle.exercises.find(e => e.id === exId);
  if (!ex) return;
  const allCats = getAllCategoriesInCycle(cycle).filter(c => c !== 'Sonstige');
  const datalist = allCats.length > 0
    ? `<datalist id="catListEdit">${allCats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>`
    : '';
  const content = `
    <div class="modal-title">Übung bearbeiten</div>
    <div class="field">
      <label>Name der Übung</label>
      <input type="text" id="editExName" value="${esc(ex.name)}">
    </div>
    <div class="field">
      <label>Kategorie (optional)</label>
      <input type="text" id="editExCat" value="${esc(ex.category || '')}" placeholder="z.B. Krafttraining" list="catListEdit">
      ${datalist}
      ${buildCategoryChips('editExCat')}
    </div>
    <div class="field">
      <label>Intensitätswert</label>
      <input type="number" id="editExInt" step="0.5" min="0" value="${ex.intensity}">
    </div>
    <div class="row" style="margin-top:4px">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="saveExerciseEdit('${exId}')">Speichern</button>
    </div>
  `;
  openModal(content);
  setTimeout(() => document.getElementById('editExName')?.focus(), 300);
}

function saveExerciseEdit(exId) {
  const name = document.getElementById('editExName')?.value?.trim();
  const category = document.getElementById('editExCat')?.value?.trim() || '';
  const intensity = parseFloat(document.getElementById('editExInt')?.value);
  if (!name || isNaN(intensity) || intensity < 0) {
    alert('Bitte Name und gültigen Intensitätswert eingeben.');
    return;
  }
  const cycle = getActiveCycle();
  const ex = cycle.exercises.find(e => e.id === exId);
  if (!ex) return;
  ex.name = name;
  ex.category = category;
  ex.intensity = intensity;
  saveData();
  closeModal();
  renderPlan();
}

function deleteExercise(exId) {
  if (!confirm('Übung wirklich löschen?')) return;
  const cycle = getActiveCycle();
  cycle.exercises = cycle.exercises.filter(e => e.id !== exId);
  // also remove from sessions (both legacy strings and new objects)
  Object.keys(cycle.sessions).forEach(day => {
    cycle.sessions[day] = cycle.sessions[day].filter(e => entryId(e) !== exId);
  });
  saveData();
  renderPlan();
}

function updateWeekTarget(weekIdx, val) {
  const cycle = getActiveCycle();
  cycle.weekTargets[weekIdx] = parseFloat(val) || 0;
  saveData();
  if (currentView === 'dashboard') renderDashboard();
}

// ═══════════════════════════════════════════════
// HISTORY VIEW
// ═══════════════════════════════════════════════
function renderHistory() {
  const el = document.getElementById('historyContent');
  if (appData.cycles.length === 0) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">📊</div><div>Noch keine Trainingszyklen vorhanden.</div></div>`;
    return;
  }

  const sorted = [...appData.cycles].sort((a,b) => b.startDate.localeCompare(a.startDate));
  el.innerHTML = `<div class="section-hdr" style="margin-top:0"><h2>Alle Zyklen</h2></div>` +
    sorted.map(cycle => {
      const wks = cycle.weeks || 12;
      const endDate = new Date(parseDate(cycle.startDate).getTime() + wks*7*24*3600*1000 - 86400000);
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
          compTgtSum += (cycle.weekTargets[i] || 0);
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
          <span class="text-muted">${Math.round(totalInt*10)/10} Gesamt-Int.</span>
          <span class="text-muted">${sessionDays} Trainingstage</span>
          <span class="text-muted">${completedExercises} Übungen absolviert</span>
          ${pctStr ? `<span class="text-muted">${pctStr} erreicht</span>` : ''}
        </div>
      </div>`;
    }).join('');
}

function openCycleDetail(cycleId) {
  const cycle = appData.cycles.find(c => c.id === cycleId);
  if (!cycle) return;

  const content = `
    <div class="modal-title">${esc(cycle.name)}</div>
    <div class="text-muted" style="margin-bottom:16px">Gestartet: ${parseDate(cycle.startDate).toLocaleDateString('de-DE')}</div>

    <div class="card-title">Wochenübersicht</div>
    ${Array.from({length: cycle.weeks || 12}, (_,i) => {
      const wint = getWeekIntensity(cycle, i);
      const wtgt = cycle.weekTargets[i] || 0;
      const wc = intensityClass(wint, wtgt);
      const days = getWeekDates(cycle, i);
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:13px">Woche ${i+1}</span>
        <span style="font-size:12px;color:var(--text-muted)">${formatDateRange(days[0],days[6])}</span>
        <span class="intensity-badge ${wc}" style="font-size:11px;padding:2px 8px">${wint}/${wtgt}</span>
      </div>`;
    }).join('')}

    <div class="divider"></div>
    <div class="card-title">Übungen in diesem Zyklus</div>
    ${(() => {
      const allCats = getAllCategoriesInCycle(cycle);
      return cycle.exercises.map(ex => {
        const cat = (ex.category && ex.category.trim()) ? ex.category.trim() : '';
        const catColor = cat ? categoryColor(cat, allCats) : '';
        return `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
          <span style="display:flex;align-items:center;gap:6px;font-size:14px">
            ${cat ? `<span style="color:${catColor};font-size:12px;line-height:1">●</span>` : ''}
            <span>${esc(ex.name)}${cat ? ` <span style="color:var(--text-dim);font-size:11px">· ${esc(cat)}</span>` : ''}</span>
          </span>
          <span style="font-family:'DM Mono',monospace;font-size:13px;color:var(--accent)">×${ex.intensity}</span>
        </div>`;
      }).join('');
    })()}

    <div class="divider"></div>
    <button class="btn btn-ghost btn-full" onclick="closeModal()">Schließen</button>
  `;
  openModal(content);
}

// ═══════════════════════════════════════════════
// SETTINGS VIEW
// ═══════════════════════════════════════════════
function renderSettings() {
  const el = document.getElementById('settingsContent');
  const cycle = getActiveCycle();
  el.innerHTML = `
    <div class="section-hdr" style="margin-top:0"><h2>Zyklus</h2></div>

    <div class="card">
      <div class="card-title">Aktiver Zyklus</div>
      ${cycle
        ? `<div style="font-weight:600;font-size:15px;margin-bottom:4px">${esc(cycle.name)}</div>
           <div class="text-muted">Gestartet: ${parseDate(cycle.startDate).toLocaleDateString('de-DE')}</div>
           <div class="divider"></div>
           <button class="btn btn-danger btn-sm" onclick="confirmEndCycle()">Zyklus abschließen</button>`
        : `<div class="text-muted">Kein aktiver Zyklus.</div>`
      }
    </div>

    <button class="btn btn-primary btn-full" style="margin-bottom:12px" onclick="openNewCycleModal()">
      + Neuen Zyklus starten
    </button>

    ${appData.cycles.length > 0 ? `
      <div class="card-title" style="margin-top:8px">Zyklus wechseln / löschen</div>
      ${appData.cycles.map(c => `
        <div class="week-row ${c.id === appData.activeCycleId ? 'current-week' : ''}">
          <div class="week-row-left" onclick="setActiveCycle('${c.id}')" style="cursor:pointer">
            <div class="week-row-name">${esc(c.name)}</div>
            <div class="week-row-date">${parseDate(c.startDate).toLocaleDateString('de-DE')}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            ${c.id === appData.activeCycleId ? '<span class="intensity-badge int-green-dark" style="font-size:11px">Aktiv</span>' : ''}
            <button class="del-btn" onclick="deleteCycle('${c.id}')" title="Zyklus löschen">🗑</button>
          </div>
        </div>
      `).join('')}
    ` : ''}

    <div class="divider"></div>
    <div class="section-hdr"><h2>Daten</h2></div>
    <button class="btn btn-ghost btn-full" style="margin-bottom:10px" onclick="exportData()">Daten exportieren</button>
    <button class="btn btn-ghost btn-full" onclick="importDataPrompt()">Daten importieren</button>
    <div style="height:10px"></div>
    <div class="text-muted" style="font-size:11px;text-align:center">Boulder Training App · Alle Daten lokal gespeichert</div>
  `;
}

function openNewCycleModal() {
  const otherCycles = appData.cycles;
  const copyOptions = otherCycles.length > 0
    ? `<div class="field">
        <label>Von vorhandenem Zyklus kopieren (optional)</label>
        <select id="copyFromCycle" onchange="onCopySelect()">
          <option value="">– Leer starten –</option>
          ${otherCycles.map(c => `<option value="${c.id}">${esc(c.name)} (${c.exercises.length} Übungen, ${c.weeks||12} Wo.)</option>`).join('')}
        </select>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Übungen, Wochenziele und Wochenanzahl werden übernommen.</div>
      </div>`
    : '';

  const content = `
    <div class="modal-title">Neuen Zyklus starten</div>
    <div class="field">
      <label>Name des Zyklus</label>
      <input type="text" id="newCycleName" placeholder="z.B. Frühjahr 2025">
    </div>
    <div class="field">
      <label>Startdatum (beliebiger Wochentag)</label>
      <input type="date" id="newCycleDate" value="${toDateStr(new Date())}">
    </div>
    <div class="field">
      <label>Anzahl Wochen (1–52)</label>
      <input type="number" id="newCycleWeeks" min="1" max="52" step="1" value="12">
    </div>
    ${copyOptions}
    <div class="row" style="margin-top:4px">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="createCycle()">Starten</button>
    </div>
  `;
  openModal(content);
}

function onCopySelect() {
  const sel = document.getElementById('copyFromCycle');
  const id = sel?.value;
  if (!id) return;
  const src = appData.cycles.find(c => c.id === id);
  if (src) {
    const wInput = document.getElementById('newCycleWeeks');
    if (wInput) wInput.value = src.weeks || 12;
  }
}

function createCycle() {
  const name = document.getElementById('newCycleName')?.value?.trim();
  const date = document.getElementById('newCycleDate')?.value;
  const weeksRaw = document.getElementById('newCycleWeeks')?.value;
  const weeks = Math.max(1, Math.min(52, parseInt(weeksRaw) || 12));
  const copyFromId = document.getElementById('copyFromCycle')?.value;
  if (!name) { alert('Bitte einen Namen eingeben.'); return; }
  const cycle = getDefaultCycle(name, weeks);
  if (date) cycle.startDate = date;

  // Copy exercises and week targets from selected cycle
  if (copyFromId) {
    const src = appData.cycles.find(c => c.id === copyFromId);
    if (src) {
      cycle.exercises = src.exercises.map(ex => ({
        id: Date.now().toString() + Math.random().toString(36).slice(2,7),
        name: ex.name,
        category: ex.category || '',
        intensity: ex.intensity
      }));
      // Copy week targets, truncating or padding as needed
      const srcTargets = src.weekTargets || [];
      cycle.weekTargets = Array(weeks).fill(0).map((_, i) => srcTargets[i] || 0);
    }
  }

  appData.cycles.push(cycle);
  appData.activeCycleId = cycle.id;
  saveData();
  closeModal();
  renderSettings();
}

function setActiveCycle(id) {
  appData.activeCycleId = id;
  saveData();
  renderSettings();
}

function deleteCycle(id) {
  const cycle = appData.cycles.find(c => c.id === id);
  if (!cycle) return;
  if (!confirm(`Zyklus "${cycle.name}" wirklich endgültig löschen?\n\nAlle zugehörigen Trainingsdaten gehen verloren.`)) return;
  appData.cycles = appData.cycles.filter(c => c.id !== id);
  if (appData.activeCycleId === id) {
    appData.activeCycleId = appData.cycles.length > 0 ? appData.cycles[appData.cycles.length - 1].id : null;
  }
  saveData();
  renderSettings();
}

function confirmEndCycle() {
  if (!confirm('Zyklus wirklich abschließen? Du kannst danach einen neuen starten. Die Daten bleiben erhalten.')) return;
  appData.activeCycleId = null;
  saveData();
  renderSettings();
}

function exportData() {
  const json = JSON.stringify(appData, null, 2);
  const blob = new Blob([json], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'boulder-backup.json'; a.click();
}

function importDataPrompt() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = e => {
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (imported.cycles && Array.isArray(imported.cycles)) {
          appData = imported;
          // Aeltere Sicherungen kennen noch keine Tests/Assessments
          migrateCycles();
          migrateAssessments();
          saveData();
          alert('Import erfolgreich!');
          render();
        } else { alert('Ungültige Datei.'); }
      } catch { alert('Fehler beim Importieren.'); }
    };
    reader.readAsText(file);
  };
  input.click();
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
  number: 'Zahl – kg, Wdh., cm, km …',
  time:   'Zeit – Sekunden oder mm:ss',
  scale:  'Skala – ein Grad',
  counts: 'Anzahl je Grad – z.B. 12 Siebener, 5 Achter'
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

function migrateAssessments() {
  let changed = false;
  if (!Array.isArray(appData.tests)) { appData.tests = []; changed = true; }
  if (!Array.isArray(appData.assessments)) { appData.assessments = []; changed = true; }
  appData.tests.forEach(t => {
    if (!t.kind) { t.kind = 'number'; changed = true; }
    if (t.unit === undefined) { t.unit = ''; changed = true; }
    if (t.category === undefined) { t.category = ''; changed = true; }
    if (t.higherIsBetter === undefined) { t.higherIsBetter = true; changed = true; }
    if (t.usesBodyweight === undefined) { t.usesBodyweight = false; changed = true; }
  });
  appData.assessments.forEach(a => {
    if (!Array.isArray(a.results)) { a.results = []; changed = true; }
  });
  if (changed) saveData();
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

function getCycleEndDate(cycle) {
  const d = parseDate(cycle.startDate);
  d.setDate(d.getDate() + (cycle.weeks || 12) * 7 - 1);
  return toDateStr(d);
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
        const cat = (ex.category && ex.category.trim()) ? ex.category.trim() : 'Sonstige';
        out[cat] = (out[cat] || 0) + getEffectiveIntensity(cycle, entry);
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
  return appData.cycles.find(c =>
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
    ? `<div class="empty" style="padding:24px 0"><div class="empty-icon">📏</div><div>${
        tests.length === 0
          ? 'Lege zuerst unten einen Test an.'
          : 'Noch keine Messung erfasst.'
      }</div></div>`
    : measurements.map(a => {
        const cycle = appData.cycles.find(c => c.id === a.cycleId);
        const d = parseDate(a.date);
        return `<div class="week-row" onclick="openAssessmentModal('${a.id}')">
          <div class="week-row-left">
            <div class="week-row-name">${esc(a.label || 'Messung')}</div>
            <div class="week-row-date">${d.toLocaleDateString('de-DE')}${
              cycle ? ' · ' + esc(cycle.name) : ''}</div>
          </div>
          <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
            <span style="font-family:'DM Mono',monospace;font-size:13px;color:var(--text-muted)">${
              a.results.length} ${a.results.length === 1 ? 'Wert' : 'Werte'}</span>
            <button class="del-btn" onclick="event.stopPropagation(); deleteAssessment('${a.id}')" title="Messung löschen">×</button>
          </div>
        </div>`;
      }).join('');

  const testList = tests.length === 0
    ? `<div class="empty" style="padding:24px 0"><div class="empty-icon">🎯</div><div>Noch keine Tests.<br>Z.B. „Max Hang 20 mm" oder „Max Klimmzüge".</div></div>`
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
        return `<div class="exercise-item" onclick="openTestProgressModal('${t.id}')" style="cursor:pointer">
          <div style="flex:1;min-width:0">
            <div class="exercise-name">${esc(t.name)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px;display:flex;align-items:center;gap:5px;flex-wrap:wrap">
              ${cat ? `<span style="color:${catColor};font-size:14px;line-height:1">●</span><span>${esc(cat)}</span><span style="color:var(--text-dim)">·</span>` : ''}
              <span>${esc(kindText)}</span>
            </div>
          </div>
          <div class="exercise-int">${latest ? formatTestValue(t, latest.value) : '–'}</div>
          <button class="del-btn" onclick="event.stopPropagation(); deleteTest('${t.id}')" title="Test löschen">×</button>
        </div>`;
      }).join('');

  el.innerHTML = `
    <div class="section-hdr" style="margin-top:0">
      <h2>Messungen</h2>
      ${tests.length > 0
        ? `<button class="btn btn-primary btn-sm" onclick="openAssessmentModal()">+ Neue Messung</button>`
        : ''}
    </div>
    ${measureList}

    <div class="divider"></div>
    <div class="section-hdr">
      <h2>Tests</h2>
      <button class="btn btn-primary btn-sm" onclick="openTestModal()">+ Test</button>
    </div>
    ${testList}
    ${tests.length > 0
      ? `<div style="font-size:11px;color:var(--text-dim);text-align:center;margin-top:8px">Tippe einen Test an, um seinen Verlauf zu sehen.</div>`
      : ''}
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
    <div style="font-size:11px;color:var(--text-dim);margin:2px 0 10px 32px">Ausschalten z.B. bei Finger-Boden-Abstand oder Pace.</div>
    <div class="check-row" id="testBwRow" onclick="toggleCheck('testBw')">
      <div class="check-box ${t && t.usesBodyweight ? 'checked' : ''}" id="testBw" data-on="${t && t.usesBodyweight ? '1' : '0'}">
        ${t && t.usesBodyweight ? CHECK_SVG : ''}
      </div>
      <div class="check-label">Körpergewicht einbeziehen</div>
    </div>
    <div style="font-size:11px;color:var(--text-dim);margin:2px 0 10px 32px">Für Zusatzgewicht am Gurt. Rechnet Prozente auf der Gesamtlast statt auf dem Zusatzgewicht.</div>
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
  if (currentView === 'dashboard') renderDashboard();
  if (currentView === 'assessment') renderAssessment();
  if (currentView === 'history') renderHistory();
}

function closeModalOnBg(e) {
  if (e.target === document.getElementById('modalOverlay')) closeModal();
}

// ═══════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════
migrateCycles();
migrateAssessments();
render();

// Offline-Fähigkeit. Fehlt beim Öffnen als lokale Datei – dann läuft die App
// wie bisher, nur eben ohne Zwischenspeicher.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
