/* Erkundungstest: viele Szenarien und Randfälle. Nach jedem Schritt werden
 * alle Ansichten gerendert, JS-Fehler gesammelt und die Daten auf
 * Stimmigkeit geprüft (siehe __check). Aufruf: node tests/browser/explore.js */
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '../..'), BASE = '/boulder-training';
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]).slice(BASE.length) || '/'; if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
const problems = [];
const note = (scenario, msg) => { problems.push(`[${scenario}] ${msg}`); };

(async () => {
  await new Promise(r => server.listen(8096, r));
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  let scenario = 'start';
  page.on('pageerror', e => note(scenario, 'JS-Fehler: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') note(scenario, 'Konsole: ' + m.text()); });
  page.on('dialog', d => d.accept());
  await page.goto(`http://localhost:8096${BASE}/`, { waitUntil: 'networkidle' });

  // Hilfsfunktionen in der Seite
  await page.addScriptTag({ content: `
    // Ein Beispielplan: Aufbau in drei von vier Wochen, jede 4. Entlastung
    window.__demoPlan = function (c) {
      c.mode = 'plan';
      c.exercises = c.exercises.concat([{ id: 'd1', name: 'Limit', categories: ['Kraft'], intensity: 3 },
        { id: 'd2', name: 'Volumen', categories: ['Technik'], intensity: 2.5 }, { id: 'd3', name: 'Ausgleich', categories: [], intensity: 1 }]);
      c.weekPlans = [{ id: 'DA', name: 'Aufbau', items: [{ exId: 'd1', days: [0] }, { exId: 'd2', days: [2] }, { exId: 'd3', days: [0, 4] }] },
        { id: 'DE', name: 'Entlastung', items: [{ exId: 'd2', days: [0, 4], amount: 1.5 }] }];
      c.weekAssign = Array.from({ length: c.weeks || 12 }, (_, i) => i % 4 === 3 ? 'DE' : 'DA');
    };
    window.__check = function () {
      const out = [];
      const d = getAppData();
      d.cycles.forEach(c => {
        if (!Array.isArray(c.weekTargets) || c.weekTargets.length !== c.weeks) out.push(c.name + ': weekTargets-Länge ' + (c.weekTargets||[]).length + ' statt ' + c.weeks);
        const exIds = new Set(c.exercises.map(e => e.id));
        if (exIds.size !== c.exercises.length) out.push(c.name + ': doppelte Übungs-IDs');
        Object.keys(c.sessions).forEach(day => (c.sessions[day] || []).forEach(e => { if (!exIds.has(entryId(e))) out.push(c.name + ': Haken ohne Übung am ' + day); }));
        if (Array.isArray(c.weekPlans)) {
          if (!Array.isArray(c.weekAssign) || c.weekAssign.length !== c.weeks) out.push(c.name + ': weekAssign-Länge ' + (c.weekAssign||[]).length);
          const ids = new Set(c.weekPlans.map(p => p.id));
          (c.weekAssign || []).forEach((a, i) => { if (a && !ids.has(a)) out.push(c.name + ': Woche ' + (i+1) + ' zeigt auf gelöschte Wochenart'); });
          c.weekPlans.forEach(p => p.items.forEach(it => { if (!exIds.has(it.exId)) out.push(c.name + ': Wochenart ' + p.name + ' enthält gelöschte Übung'); }));
          const names = c.weekPlans.map(p => p.name.toLowerCase());
          if (new Set(names).size !== names.length) out.push(c.name + ': doppelte Wochenarten ' + names.join(','));
        }
        for (let i = 0; i < c.weeks; i++) {
          const wd = getWeekDates(c, i);
          if (wd.length !== 7 || new Set(wd).size !== 7) out.push(c.name + ': Woche ' + (i+1) + ' hat keine 7 Tage');
          if (i > 0 && wd[0] <= getWeekDates(c, i - 1)[6]) out.push(c.name + ': Wochen überlappen');
          const t = getWeekTarget(c, i);
          if (typeof t !== 'number' || isNaN(t)) out.push(c.name + ': Ziel Woche ' + (i+1) + ' = ' + t);
        }
      });
      if (d.activeCycleId && !d.cycles.some(c => c.id === d.activeCycleId)) out.push('aktiver Zyklus existiert nicht');
      // Abgleich hin und zurück
      const docs = toDocs(d);
      if (syncCanon(toDocs(fromDocs(docs))) !== syncCanon(docs)) out.push('Abgleich hin/zurück nicht stabil');
      // alle Ansichten rendern
      ['dashboard','plan','assessment','history','settings'].forEach(v => {
        try { switchView(v); } catch (e) { out.push('Ansicht ' + v + ': ' + e.message); }
        const txt = document.querySelector('.view.active').innerHTML;
        if (/undefined|NaN|\\[object Object\\]|null(?![a-zA-Z])/.test(txt.replace(/<[^>]+>/g, ' '))) {
          const m = txt.replace(/<[^>]+>/g, ' ').match(/.{0,40}(undefined|NaN|\\[object Object\\]|null(?![a-zA-Z])).{0,40}/);
          out.push('Ansicht ' + v + ' zeigt: ' + (m ? m[0].replace(/\\s+/g, ' ') : '?'));
        }
      });
      switchView('dashboard');
      return out;
    };
    window.__fresh = function (data) { replaceAppData(normalizeData(data || getDefaultData())); saveData(); render(); };
  ` });

  async function step(name, fn) {
    scenario = name;
    try { await fn(); } catch (e) { note(name, 'Abbruch: ' + e.message.split('\n')[0]); }
    try { await page.evaluate(() => closeModal()); } catch (e) {}
    await page.waitForTimeout(80);
    const issues = await page.evaluate(() => window.__check()).catch(e => ['check: ' + e.message]);
    issues.forEach(i => note(name, i));
  }

  // ── 1. Leerer Start ──
  await step('leer', async () => { await page.evaluate(() => __fresh()); });

  // ── 2. Freier Zyklus, Übungen, Haken, Overrides, Messwerte ──
  await step('frei', async () => {
    await page.evaluate(() => {
      __fresh();
      el = id => document.getElementById(id);
      openNewCycleModal('free');
      el('newCycleName').value = 'Frei'; el('newCycleWeeks').value = '6';
      createCycle();
      const c = getActiveCycle();
      ['Bouldern', 'Hangboard', 'Dehnen'].forEach((n, i) => { openAddExerciseModal(); el('newExName').value = n; el('newExInt').value = String(i + 1); el('newExCat').value = i ? 'Finger, Pull' : ''; addExercise(); });
      c.exercises[1].measure = true; c.exercises[1].unit = 'kg';
      const d0 = getWeekDates(c, 0)[0];
      toggleDayEx(d0, c.exercises[0].id); toggleDayEx(d0, c.exercises[1].id);
      setOverride(d0, c.exercises[0].id, '4,5');  // Komma!
      setEntryValue(d0, c.exercises[1].id, '12,5'); setEntryNote(d0, c.exercises[1].id, '<b>x</b>');
      openDayModal(d0); openWeekModal(0); openEditExerciseModal(c.exercises[1].id);
    });
    const ov = await page.evaluate(() => getActiveCycle().sessions[getWeekDates(getActiveCycle(), 0)[0]][0].overrideInt);
    if (ov !== 4.5) note('frei', 'Override mit Komma "4,5" wurde zu ' + ov);
  });

  // ── 3. Übung löschen, die in einer Wochenart steckt ──
  await step('übung löschen im plan', async () => {
    await page.evaluate(() => {
      const c = getActiveCycle();
      c.mode = 'plan';
      boardAdd(c.exercises[2].id, 0); dndDrop({ kind: 'bex', exId: c.exercises[0].id }, 'bday:2');
      deleteExercise(c.exercises[2].id);
    });
  });

  // ── 4. Neue Zyklen über alle Einheiten und Längen, planen am Brett ──
  for (const unit of ['int', 'min', 'h']) for (const weeks of [1, 4, 12, 52]) {
    await step(`brett ${unit} ${weeks}w`, async () => {
      await page.evaluate(({ unit, weeks }) => {
        __fresh();
        const el = id => document.getElementById(id);
        openNewCycleModal('plan');
        el('newCycleName').value = 'V'; el('newCycleWeeks').value = String(weeks); pickSeg('newCycleUnit', unit);
        createCycle();
        const c = getActiveCycle();
        openAddExerciseModal(3); el('newExName').value = 'Bouldern'; el('newExInt').value = unit === 'min' ? '90' : '2'; addExercise();
        openBoardMenu(document.body); document.querySelector('.pop-item') && document.querySelector('.pop-item').click();
        closeMenu();
        assignWeeks(Array.from({ length: weeks }, (_, i) => i), c.weekAssign[boardWeek(c)]);
      }, { unit, weeks });
      const r = await page.evaluate(() => { const c = getActiveCycle(); return { u: c.unit || 'int', t: getWeekTarget(c, 0), n: c.weekAssign.filter(Boolean).length, w: c.weeks }; });
      if (r.u !== unit) note(`brett ${unit} ${weeks}w`, 'Einheit ' + r.u);
      if (!(r.t > 0)) note(`brett ${unit} ${weeks}w`, 'Wochenziel 1 = ' + r.t);
      if (r.n !== r.w) note(`brett ${unit} ${weeks}w`, 'zugeordnet ' + r.n + ' von ' + r.w);
    });
  }

  // ── 5. Am Brett: ziehen, über Wochen ziehen, nur diese Woche, tauschen, Papierkorb ──
  await step('brett', async () => {
    await page.evaluate(() => {
      __fresh();
      const c = getDefaultCycle('P', 12); getAppData().cycles.push(c); getAppData().activeCycleId = c.id;
      __demoPlan(c); c.weekAssign = Array(12).fill(null); saveData();
      switchView('plan');
      boardSelect(0);
      dndDrop({ kind: 'bex', exId: 'd1' }, 'bday:0'); dndDrop({ kind: 'bex', exId: 'd2' }, 'bday:2'); dndDrop({ kind: 'bex', exId: 'd2', from: 2 }, 'bday:3');
      dndDrop({ kind: 'week', plan: c.weekAssign[0], from: 0 }, 'week:11', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      boardSelect(3); boardScope = 'one'; boardSwap('d1', 0, 'd3');
      boardSelect(5); dndDrop({ kind: 'bex', exId: 'd2', from: 3 }, 'trash');
      boardSelect(11); assignWeeks([11], null);
      boardStep(1); boardStep(-20);
      c.weekPlans.forEach(p => { if (!p.items.length) throw new Error('leerer Plan bleibt: ' + p.name); });
    });
  });

  // ── 6. Wochenart löschen, die zugeordnet ist ──
  await step('wochenart löschen', async () => {
    await page.evaluate(() => { const c = getActiveCycle(); deleteWeekPlan(weekPlans(c)[0].id); });
  });

  // ── 7. Repertoire: speichern, in Zyklus mit anderer Einheit, löschen ──
  await step('repertoire', async () => {
    await page.evaluate(() => {
      const c = getActiveCycle();
      saveToLibrary(weekPlans(c)[0].id); saveToLibrary(weekPlans(c)[0].id);
      const c2 = getDefaultCycle('R', 3); c2.unit = 'min'; c2.mode = 'plan'; getAppData().cycles.push(c2); getAppData().activeCycleId = c2.id; saveData();
      useLibraryWeek(getAppData().weekLibrary[0].id); openLibrarySheet();
      saveData();
      deleteLibraryWeek(getAppData().weekLibrary[0].id);
    });
    const n = await page.evaluate(() => getAppData().weekLibrary.length);
    if (n !== 0) note('repertoire', 'Repertoire nach Löschen: ' + n);
  });

  // ── 8. Pause: heute, über Wochenwechsel, Fortsetzen, nochmal ──
  await step('pause', async () => {
    await page.evaluate(() => {
      const c = getActiveCycle();
      c.startDate = addDays(toDateStr(new Date()), -10);
      pauseCycle(); resumeCycle(); pauseCycle();
      c.pausedAt = addDays(toDateStr(new Date()), -5);  // läuft seit 5 Tagen
      saveData(); render();
      openDayModal(toDateStr(new Date()));
      resumeCycle();
      pauseCycle(); c.pausedAt = addDays(toDateStr(new Date()), -2); resumeCycle();
    });
  });

  // ── 9. Zyklus in der Zukunft / längst vorbei ──
  await step('zukunft', async () => { await page.evaluate(() => { getActiveCycle().startDate = addDays(toDateStr(new Date()), 30); saveData(); render(); }); });
  await step('vergangen', async () => { await page.evaluate(() => { getActiveCycle().startDate = addDays(toDateStr(new Date()), -400); saveData(); render(); }); });

  // ── 10. Zyklus kopieren, wechseln, löschen ──
  await step('zyklen', async () => {
    await page.evaluate(() => {
      const el = id => document.getElementById(id);
      const src = getAppData().cycles[0];
      openNewCycleModal(); el('newCycleName').value = 'Kopie'; el('copyFromCycle').value = src.id; createCycle();
      setActiveCycle(src.id); deleteCycle(src.id); deleteCycle(getAppData().cycles[0].id);
    });
  });

  // ── 11. Geteilter Plan hin und zurück, auch über die UI ──
  await step('teilen', async () => {
    await page.evaluate(async () => {
      __fresh();
      const c = getDefaultCycle('S', 8); getAppData().cycles.push(c); getAppData().activeCycleId = c.id;
      __demoPlan(c); saveData();
      const plan = await decodePlan(planLink(await encodePlan(planFromCycle(c, 'A "B" <C>', 'Note'))));
      openPlanPreview(plan, true);
      startImportedPlan();
    });
  });

  // ── 12. Sicherung: hinzufügen, ersetzen, rückgängig, mit Altdaten ──
  await step('sicherung', async () => {
    await page.evaluate(() => {
      const snap = JSON.parse(JSON.stringify(getAppData()));
      snap.cycles.forEach(c => { c.exercises.forEach(e => e.days = [0]); delete c.weekPlans; delete c.weekAssign; });
      openRestoreModal(normalizeData(snap), 'x'); applyRestore('merge');
      openRestoreModal(normalizeData(JSON.parse(JSON.stringify(snap))), 'x'); applyRestore('replace');
      undoImport();
    });
  });

  // ── 13. Logbuch: alle Skalen, anderer Tag, löschen, Verlauf ──
  await step('logbuch', async () => {
    await page.evaluate(() => {
      switchView('history');
      ['font', 'vscale', 'gym'].forEach(sc => { logScaleSel = sc; renderHistory(); quickAddAscent(SCALES[sc].steps.length - 1); quickAddAscent(0); });
      logDate = addDays(toDateStr(new Date()), -40); quickAddAscent(3); logDate = null;
      logScaleSel = 'gym'; renderHistory();
      openLogHistory(); removeAscent(getAppData().ascents[0].id);
    });
  });

  // ── 14. Assessments: alle Arten, Körpergewicht, Zählwerte ──
  await step('assessment', async () => {
    await page.evaluate(() => {
      const el = id => document.getElementById(id);
      switchView('assessment');
      [['number', 'kg', true], ['time', '', false], ['scale', '', false], ['counts', '', false]].forEach(([kind, unit, bw], i) => {
        openTestModal(); el('testName').value = 'T' + i; el('testKind').value = kind; onTestKindChange();
        if (unit) el('testUnit').value = unit; if (bw) toggleCheck('testBw'); saveTest(null);
      });
      openAssessmentModal();
    });
    // Formular im Browser ausfüllen
    const inputs = await page.locator('#modalContent input').count();
    if (!inputs) note('assessment', 'Messformular ohne Eingabefelder');
    await page.evaluate(() => {
      document.querySelectorAll('#modalContent input[type=number], #modalContent input[type=text]').forEach((i, k) => { if (!i.value) i.value = String(10 + k); });
      const save = [...document.querySelectorAll('#modalContent button')].find(b => /Speichern/.test(b.textContent));
      if (save) save.click();
      getAppData().tests.forEach(t => openTestProgressModal(t.id));
    });
  });

  // ── 15. Einheit-Grenzfälle und lange Namen ──
  await step('lange namen', async () => {
    await page.evaluate(() => {
      const c = getActiveCycle() || (() => { const x = getDefaultCycle('L', 2); getAppData().cycles.push(x); getAppData().activeCycleId = x.id; return x; })();
      c.exercises.push({ id: 'lang', name: 'X'.repeat(200) + "'\"<>", categories: ['<i>'], intensity: 0 });
      c.mode = 'plan';
      boardAdd('lang', 0); weekPlanById(c, c.weekAssign[boardWeek(c)]).name = "Woche 'mit' \"Zeichen\" <b>";
      saveData(); render();
    });
  });

  // ── 16. Frei → Wochenplan mit Vorschlag aus der Historie, aus und wieder an ──
  await step('frei zu plan', async () => {
    await page.evaluate(() => {
      __fresh();
      const c = getDefaultCycle('H', 8); c.startDate = addDays(toDateStr(new Date()), -21);
      c.exercises = [{ id: 'a', name: 'A', categories: [], intensity: 2 }, { id: 'b', name: 'B', categories: [], intensity: 1 }];
      for (let w = 0; w < 3; w++) { c.sessions[addDays(c.startDate, w * 7)] = [{ exId: 'a' }]; c.sessions[addDays(c.startDate, w * 7 + 2)] = [{ exId: 'b' }]; }
      getAppData().cycles.push(c); getAppData().activeCycleId = c.id; saveData();
      switchView('settings'); togglePlanMode();
      if (weekPlans(c).length !== 1 || weekPlans(c)[0].items.length !== 2) throw new Error('kein Vorschlag: ' + JSON.stringify(weekPlans(c)));
      togglePlanMode(); togglePlanMode();   // aus und wieder an: keine zweite Woche
      if (weekPlans(c).length !== 1) throw new Error('Wochen nach aus/an: ' + weekPlans(c).length);
    });
  });

  // ── 17. Ein-Wochen-Zyklus mit Pause und Vorlage ──
  await step('eine woche', async () => {
    await page.evaluate(() => {
      __fresh();
      const c = getDefaultCycle('E', 1); getAppData().cycles.push(c); getAppData().activeCycleId = c.id;
      __demoPlan(c); saveData();
      pauseCycle(); render(); resumeCycle();
      openWeekModal(0); openDayModal(getWeekDates(c, 0)[3], 0);
    });
  });

  // ── 18. Sehr alte Sicherung (Strings als Haken, Kategorie als Text) ──
  await step('alte sicherung', async () => {
    await page.evaluate(() => {
      const alt = { cycles: [{ id: 'o', name: 'Alt', startDate: '2025-01-06', weekTargets: [3],
        exercises: [{ id: 'e', name: 'E', category: 'Finger', intensity: '2' }], sessions: { '2025-01-06': ['e'] } }], activeCycleId: 'o' };
      openRestoreModal(normalizeData(alt), 'alt'); applyRestore('replace');
    });
  });

  // ── 19. Ohne Zyklus: alle Ansichten, Logbuch eintragen, Plan importieren ──
  await step('ohne zyklus', async () => {
    await page.evaluate(() => {
      __fresh();
      switchView('history'); quickAddAscent(5);
      switchView('plan'); openImportPlanModal();
    });
  });

  // ── 20. Klicks durch die echte Oberfläche: Zyklus mit Wochenplan anlegen ──
  await step('ui wochenplan', async () => {
    await page.evaluate(() => { __fresh(); switchView('dashboard'); });
    await page.click('.choice-card:has-text("Mit Wochenplan")');
    await page.fill('#newCycleName', 'UI');
    await page.click('button:text-is("Starten")');
    await page.waitForSelector('#planContent .pb', { timeout: 5000 });
    await page.click('#planContent .we-token.add');
    await page.fill('#newExName', 'Bouldern'); await page.fill('#newExInt', '3');
    await page.click('#modalContent button:text-is("Hinzufügen")');
    await page.waitForTimeout(300);
    await page.click('#planContent .pb-day >> nth=1 >> .pb-plus');
    await page.click('.pop-menu .pop-item:has-text("Bouldern")');
    await page.click('#planContent .pb-head .icon-btn');
    await page.click('.pop-menu .pop-item:has-text("Auf alle Wochen übertragen")');
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => { const c = getActiveCycle(); return [weekPlans(c).length, c.weekAssign.filter(Boolean).length, c.exercises.length]; });
    if (r[0] !== 1 || r[1] !== 12 || r[2] !== 1) throw new Error('Ergebnis ' + JSON.stringify(r));
    await page.click('.tab-btn:nth-child(1)');
    await page.waitForTimeout(200);
  });

  // ── 21. Doppelte IDs beim schnellen Anlegen ──
  await step('schnell anlegen', async () => {
    await page.evaluate(() => {
      const el = id => document.getElementById(id);
      for (let i = 0; i < 5; i++) { openAddExerciseModal(); el('newExName').value = 'S' + i; el('newExInt').value = '1'; addExercise(); }
    });
  });

  // ── 22. Verschieben über Pausen und Wochengrenzen, Kalender, Entwürfe ──
  await step('verschieben', async () => {
    await page.evaluate(() => {
      __fresh();
      const c = getDefaultCycle('M', 4); c.mode = 'plan'; c.startDate = addDays(toDateStr(new Date()), -3);
      getAppData().cycles.push(c); getAppData().activeCycleId = c.id; __demoPlan(c); saveData();
      const w = getWeekDates(c, 1);
      moveTrainingDay(w[0], w[6]); moveTrainingDay(w[6], getWeekDates(c, 2)[0]);   // auch über die Woche hinaus
      openWeekModal(1); startMoveDay(1, w[2]); finishMoveDay(1, w[3]);
      pauseCycle(); resumeCycle();
      openCalendarExport(); buildIcs(c, { range: 'all', time: '', duration: 60 });
      const ics = buildIcs(c, { range: 'future', time: '07:15', duration: 180 });
      if (!/BEGIN:VEVENT/.test(ics)) throw new Error('keine Termine');
    });
  });
  await step('entwürfe', async () => {
    await page.evaluate(() => {
      const el = id => document.getElementById(id);
      openNewDraftModal(); el('draftWho').value = '<Kim>'; el('draftFrom').value = ''; createDraft();
      closeModal();
      const d = getActiveCycle(); d.exercises.push({ id: 'dx', name: 'Hang', categories: [], intensity: 1 }); boardAdd('dx', 2); render();
      switchView('dashboard'); switchView('settings');
      openNewDraftModal(); el('draftWho').value = ''; el('draftFrom').value = getAppData().cycles[0].id; createDraft();
      closeDraft();
    });
  });

  console.log(problems.length ? problems.join('\n') : 'KEINE PROBLEME');
  if (problems.length) process.exitCode = 1;
  await browser.close(); server.close();
})();
