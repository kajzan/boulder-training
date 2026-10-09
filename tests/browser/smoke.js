/* Rauchtest im echten Browser: die App ohne Konto, wie sie jeder zuerst sieht.
 *
 * Aufruf (einmalig: npm install playwright):
 *   node tests/browser/smoke.js
 * CHROMIUM=<pfad> waehlt einen bestimmten Browser. Braucht kein Netz und
 * keinen Emulator. */
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..'), BASE = '/boulder-training';
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
                '.json': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2' };
let versionOverride = null;   // simuliert eine neu veroeffentlichte Version
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (!p.startsWith(BASE)) { res.writeHead(404); return res.end(); }
  p = p.slice(BASE.length) || '/'; if (p.endsWith('/')) p += 'index.html';
  if (versionOverride && (p === '/version.js' || p === '/sw.js')) {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(p === '/version.js'
      ? `const APP_VERSION = { name: '${versionOverride}', date: '2030-01-01 12:00' };`
      : fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8').replace(/const VERSION = 'v\d+';/, `const VERSION = 'v${versionOverride}';`));
  }
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});

const log = [];
const ok = (n, c, x = '') => { log.push((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '  → ' + x)); if (!c) process.exitCode = 1; };

(async () => {
  await new Promise(r => server.listen(8094, r));
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(`http://localhost:8094${BASE}/`, { waitUntil: 'networkidle' });

  ok('App laedt ohne Fehler', errs.length === 0, errs.join(' | '));
  ok('fuenf Tabs', (await page.locator('.tab-btn').count()) === 5);
  ok('Schrift lokal', await page.evaluate(() => document.fonts.check("16px 'DM Sans'")));
  ok('Service Worker aktiv', await page.evaluate(() => navigator.serviceWorker.ready.then(r => !!r.active)));
  ok('Scope deckt den Unterpfad',
    await page.evaluate(() => navigator.serviceWorker.ready.then(r => r.scope.endsWith('/boulder-training/'))));

  // Erster Start: Wahl zwischen Wochenplan und frei, Zyklus aus Vorlage
  ok('erster Start bietet Wochenplan, frei und Trainer-Plan an', (await page.locator('.choice-card').count()) === 3);
  await page.screenshot({ path: path.join(__dirname, 'shot-start.png') });
  await page.click('.choice-card:has-text("Mit Wochenplan")');
  ok('Wochenplan ist vorgewaehlt', (await page.inputValue('#newCycleMode')) === 'plan');
  await page.selectOption('#copyFromCycle', 'tpl:fortgeschritten');
  ok('Vorlage setzt die Wochenzahl', (await page.inputValue('#newCycleWeeks')) === '12');
  ok('Vorlage erklaert sich', (await page.locator('#copyInfo').innerText()).includes('Entlastungswoche'));
  await page.screenshot({ path: path.join(__dirname, 'shot-vorlage.png') });
  await page.click('button:text-is("Starten")');
  await page.waitForTimeout(400);
  ok('Uebersicht zeigt den heutigen Tag', await page.locator('.card-title:has-text("Heute")').isVisible());
  await page.screenshot({ path: path.join(__dirname, 'shot-heute.png'), fullPage: true });
  await page.click('.tab-btn:nth-child(2)');
  ok('Planung zeigt 12 Wochen und 3 Wochenarten', await page.locator('.tl-cell').count() === 12 &&
    await page.locator('#planContent .wk-token:not(.add)').count() === 3);
  ok('Uebungen stehen ueber der Planung', await page.evaluate(() => {
    const h = [...document.querySelectorAll('#planContent .section-hdr h2')].map(x => x.textContent);
    return h.indexOf('Übungen') < h.indexOf('Planung');
  }));
  // Woche 2 antippen, im Menü Entlastungswoche wählen
  await page.click('.tl-cell >> nth=1');
  ok('Kachel öffnet das Wochenmenü', await page.locator('.pop-menu .pop-item').count() >= 4);
  await page.screenshot({ path: path.join(__dirname, 'shot-wochenmenue.png') });
  await page.click('.pop-menu .pop-item:has-text("Entlastungswoche")');
  ok('Woche 2 als Entlastung zugeordnet', await page.locator('.tl-cell >> nth=1 >> .tl-name').textContent() === 'Entlastung' &&
    await page.locator('.pop-menu').count() === 0);
  // Aufbauwoche auf Woche 2 und 3 ziehen
  await drag(page, '#planContent .wk-token:has-text("Aufbauwoche")', ['.tl-cell >> nth=1', '.tl-cell >> nth=2']);
  ok('Ziehen ordnet zu, auch über mehrere Wochen', await page.locator('.tl-cell >> nth=1 >> .tl-name').textContent() === 'Aufbau' &&
    await page.locator('.tl-cell >> nth=2 >> .tl-name').textContent() === 'Aufbau');
  ok('nach dem Ziehen öffnet sich kein Editor', !(await page.locator('#weekEditor').count()));
  // Antippen und daneben tippen schließt das Menü nur
  await page.click('.tl-cell >> nth=0');
  await page.mouse.click(5, 5);
  ok('Tipp daneben schließt das Menü', await page.locator('.pop-menu').count() === 0);
  // Löschen über das Menü im Editor
  await page.click('#planContent .wk-token:has-text("Belastungswoche")');
  await page.waitForSelector('#weekEditor');
  await page.click('#weekEditor .we-head .icon-btn');
  await page.click('.pop-menu .pop-item:has-text("Wochenart löschen")');
  await page.waitForTimeout(400);
  ok('Wochenart über das Menü gelöscht', await page.locator('#planContent .wk-token:not(.add)').count() === 2);
  await page.screenshot({ path: path.join(__dirname, 'shot-plan.png'), fullPage: true });
  await page.click('.tab-btn:nth-child(1)');

  await page.evaluate(() => {
    const c = getDefaultCycle('S', 4);
    c.exercises = [
      { id: 'a', name: 'Aufwaermen', categories: ['Basis'], intensity: 1 },
      { id: 'b', name: 'Hang', categories: ['Finger', 'Pull'], intensity: 3 },
      { id: 'c', name: 'Dehnen', categories: [], intensity: 1 }
    ];
    c.sessions[getWeekDates(c, 0)[0]] = [{ exId: 'b' }];
    replaceAppData({ cycles: [c], activeCycleId: c.id, assessments: [],
      tests: [{ id: 't', name: 'Max Hang', kind: 'number', unit: 'kg', category: 'Finger',
                higherIsBetter: true, usesBodyweight: true }] });
    saveData();
  });
  for (const [i, n] of [[1, 'Uebersicht'], [2, 'Trainingsplan'], [3, 'Assessment'], [4, 'Logbuch'], [5, 'Einstellungen']]) {
    await page.click(`.tab-btn:nth-child(${i})`);
    ok(`Ansicht ${n} rendert`,
      await page.evaluate(() => document.querySelector('.view.active').innerText.trim().length > 0));
  }
  ok('Version mit Datum in den Einstellungen',
    /Version \d+ · \d+\. \w+ \d{4}, \d{2}:\d{2} Uhr/.test(await page.locator('.settings-foot').innerText()));
  ok('Service Worker und Anzeige haben dieselbe Version',
    await page.evaluate(() => caches.keys().then(k => k.includes('boulder-v' + APP_VERSION.name))));
  ok('Konto-Zeile erscheint ohne Anmeldung', await page.locator('#cloudBox >> text=Anmelden').isVisible());
  await page.screenshot({ path: path.join(__dirname, 'shot-einstellungen.png'), fullPage: true });
  await page.click('#cloudBox .list-row');
  ok('Anmelden-Fenster oeffnet sich', await page.locator('#cloudEmail').isVisible());
  await page.click('#accountSheet .seg button:text-is("Registrieren")');
  await page.fill('#cloudPassword', 'abc');
  await page.click('#cloudPwToggle');
  ok('Passwort laesst sich anzeigen', (await page.getAttribute('#cloudPassword', 'type')) === 'text');
  ok('Registrieren zeigt den passenden Knopf', await page.locator('#accountSheet .btn-primary:text-is("Konto erstellen")').isVisible());
  await page.screenshot({ path: path.join(__dirname, 'shot-registrieren.png') });
  await page.click('#accountSheet .seg button:text-is("Anmelden")');
  ok('Wechsel zurueck behaelt die Eingabe nicht faelschlich leer',
    await page.locator('#accountSheet .btn-primary:text-is("Anmelden")').isVisible());
  await page.evaluate(() => closeModal());
  await page.waitForTimeout(300);
  await page.click('#settingsContent .list-row:has-text("Wochenplan")');
  ok('Wochenplan-Schalter', await page.evaluate(() => isPlanMode(getActiveCycle())));
  await page.waitForSelector('#weekEditor');
  ok('Einschalten ohne Wochen oeffnet eine neue Woche', true);
  await page.screenshot({ path: path.join(__dirname, 'shot-plan-einrichten.png') });
  await page.click('#weekEditor button:text-is("Abbrechen")');
  await page.waitForTimeout(300);
  await page.click('#settingsContent .list-row:has-text("Wochenplan")');
  await page.click('#settingsContent .list-row >> nth=1');
  ok('Zyklen-Fenster', await page.locator('#cyclesSheet .list-row').count() === 1);
  await page.click('#cyclesSheet button:text-is("Fertig")');
  await page.waitForTimeout(300);

  // Sortieren per Ziehen
  await page.click('.tab-btn:nth-child(2)');
  const h = await page.locator('#exerciseList .exercise-item').first()
    .evaluate(el => el.getBoundingClientRect().height + 8);
  const b = await page.locator('#exerciseList .drag-handle').first().boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + h * 2 * i / 12);
  await page.mouse.up();
  ok('Sortieren per Ziehen', (await page.locator('#exerciseList .exercise-name').allInnerTexts()).join() ===
    'Hang,Dehnen,Aufwaermen');

  // Uebung mit Messwert anlegen, dann eine Woche planen, in der sie taeglich dran ist
  await page.waitForTimeout(400);   // die Klicksperre nach dem Ziehen abwarten
  await page.click('button:text-is("+ Übung")');
  await page.fill('#newExName', 'Klimmzug max');
  await page.fill('#newExInt', '1');
  await page.click('.check-row:has-text("Messwert beim Abhaken")');
  await page.fill('#newExUnit', 'kg');
  await page.screenshot({ path: path.join(__dirname, 'shot-uebung.png') });
  await page.click('#modalContent button:text-is("Hinzufügen")');
  await page.waitForTimeout(400);
  await page.click('.tab-btn:nth-child(5)');
  await page.click('#settingsContent .list-row:has-text("Wochenplan")');
  await page.waitForSelector('#weekEditor');
  await page.fill('.we-title', 'Testwoche');
  for (let d = 0; d < 7; d++) {
    if (d < 4) {
      await page.click(`#weekEditor .we-day >> nth=${d} >> .we-add`);
      await page.click('.pop-menu .pop-item:has-text("Klimmzug max")');
    } else {
      await drag(page, '#weekEditor .we-token:has-text("Klimmzug max")', [`#weekEditor .we-day >> nth=${d}`]);
    }
  }
  await page.click('#weekEditor .we-chip >> nth=0');
  await page.fill('#weekEditor .we-edit-row input >> nth=1', 'einarmig erlaubt');
  await page.click('#weekEditor button:text-is("Fertig")');
  await page.screenshot({ path: path.join(__dirname, 'shot-woche.png'), fullPage: true });
  await page.click('#weekEditor button:text-is("Speichern")');
  await page.waitForTimeout(400);
  ok('Woche gespeichert und ueberall zugeordnet', await page.evaluate(() => {
    const c = getActiveCycle(), p = weekPlans(c)[0];
    return p.name === 'Testwoche' && p.items[0].days.length === 7 && c.weekAssign.every(id => id === p.id);
  }));
  await page.click('.tab-btn:nth-child(2)');
  ok('Planung zeigt die Woche in der Leiste', await page.locator('.tl-name:text-is("Test")').count() === 4);
  await page.screenshot({ path: path.join(__dirname, 'shot-planung.png'), fullPage: true });

  // Pausieren und fortsetzen (die Woche ist noch leer)
  await page.evaluate(() => { const c = getActiveCycle(); c.startDate = toDateStr(new Date()); c.sessions = {}; saveData(); });
  await page.click('.tab-btn:nth-child(1)');
  await page.click('button:has-text("Pausieren")');
  ok('Pause sichtbar', await page.locator('button:text-is("Training fortsetzen")').isVisible());
  await page.screenshot({ path: path.join(__dirname, 'shot-pause.png'), fullPage: true });
  await page.click('button:text-is("Training fortsetzen")');
  ok('Pause beendet', await page.locator('button:has-text("Pausieren")').isVisible());

  // Abhaken mit Messwert
  ok('Heute-Karte zeigt den Hinweis der Woche', await page.locator('.card-btn .ex-note:text-is("einarmig erlaubt")').isVisible());
  await page.click('.card-btn:has(.card-title:has-text("Heute"))');
  await page.waitForTimeout(300);
  await page.click('#modalContent .check-label:text-is("Klimmzug max")');
  await page.fill('.measure-row input >> nth=0', '12,5');
  await page.fill('.measure-row input >> nth=1', 'einarmig, Band');
  await page.locator('.measure-row input >> nth=1').press('Tab');
  await page.screenshot({ path: path.join(__dirname, 'shot-messwert.png') });
  ok('Messwert gespeichert', await page.evaluate(() => {
    const c = getActiveCycle(), e = (c.sessions[toDateStr(new Date())] || [])[0];
    return !!e && e.value === 12.5 && e.note === 'einarmig, Band';
  }));
  await page.click('button:text-is("Fertig")');

  // Logbuch: Grad antippen, fertig
  await page.click('.tab-btn:nth-child(4)');
  await page.click('.log-grade:text-is("6B+")');
  await page.click('.log-flash-toggle');
  await page.click('.log-grade:text-is("6C")');
  ok('zwei Tipps, zwei Eintraege', (await page.locator('.log-chip').count()) === 2 &&
    await page.locator('.log-chip.flash:has-text("6C")').isVisible());
  ok('Pyramide zeigt den hoechsten Grad', await page.locator('.log-big:text-is("6C")').isVisible());
  await page.screenshot({ path: path.join(__dirname, 'shot-logbuch.png'), fullPage: true });
  await page.click('.log-chip:has-text("6B+")');
  ok('Antippen loescht', (await page.locator('.log-chip').count()) === 1);
  await page.click('.list-row:has-text("Verlauf")');
  await page.click('#logHistory .day-del');
  await page.waitForTimeout(300);
  ok('ganzen Tag im Verlauf geloescht', await page.evaluate(() => getAppData().ascents.length === 0));
  await page.evaluate(() => closeModal());
  await page.waitForTimeout(300);

  // Plan teilen (ohne Teilen-Menue im Testbrowser: Link in die Zwischenablage)
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('.tab-btn:nth-child(2)');
  await page.click('#planContent .section-hdr .icon-btn');
  await page.click('.pop-menu .pop-item:has-text("Plan teilen")');
  await page.fill('#sharePlanAuthor', 'Trainerin Lisa');
  await page.fill('#sharePlanNote', 'Immer gut aufwaermen.');
  await page.click('button:has-text("Link teilen")');
  await page.waitForSelector('#sharePlanUrl');
  const link = await page.inputValue('#sharePlanUrl');
  ok('Plan-Link erzeugt', link.includes('#plan=z'), link.slice(0, 60));
  ok('Link liegt in der Zwischenablage', (await page.evaluate(() => navigator.clipboard.readText())) === link);
  await page.screenshot({ path: path.join(__dirname, 'shot-teilen.png') });
  await page.evaluate(() => closeModal());

  // Ein Schueler oeffnet den Link in einem frischen Browser
  const schueler = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const sp = await schueler.newPage();
  sp.on('pageerror', e => errs.push('Schueler: ' + e.message));
  await sp.goto(link, { waitUntil: 'networkidle' });
  await sp.waitForSelector('button:text-is("Als neuen Zyklus starten")');
  ok('Link zeigt den Plan', await sp.locator('.modal-title:text-is("S")').isVisible() &&
    await sp.locator('text=von Trainerin Lisa').isVisible());
  ok('Link wird aus der Adresse entfernt', !(await sp.evaluate(() => location.hash)));
  await sp.screenshot({ path: path.join(__dirname, 'shot-plan-vorschau.png') });
  await sp.click('button:text-is("Als neuen Zyklus starten")');
  await sp.waitForTimeout(300);
  ok('Schueler hat den Plan als Zyklus', await sp.evaluate(() =>
    getActiveCycle().exercises.some(e => e.name === 'Klimmzug max' && e.unit === 'kg') &&
    getActiveCycle().planAuthor === 'Trainerin Lisa' &&
    Object.keys(getActiveCycle().sessions).length === 0));
  await schueler.close();

  // Import per Einfuegen in der App
  await page.click('.tab-btn:nth-child(5)');
  await page.click('.list-row:has-text("Plan importieren")');
  await page.fill('#planCode', 'kein link');
  await page.click('button:text-is("Weiter")');
  ok('ungueltiger Link: Hinweis', await page.locator('#planCodeErr:has-text("kein gültiger")').isVisible());
  await page.click('button:text-is("Aus Zwischenablage einfügen")');
  await page.waitForSelector('button:text-is("Als neuen Zyklus starten")');
  ok('Einfuegen aus der Zwischenablage oeffnet die Vorschau', true);
  await page.evaluate(() => closeModal());
  await page.waitForTimeout(300);

  // Sicherung: exportieren, wiederherstellen (hinzufuegen), rueckgaengig
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.list-row:has-text("Sicherung exportieren")')]);
  const datei = path.join(__dirname, 'sicherung-test.json');
  await dl.saveAs(datei);
  ok('Sicherung traegt das Datum im Namen', /boulder-sicherung-\d{4}-\d{2}-\d{2}\.json/.test(dl.suggestedFilename()));
  const vorher = await page.evaluate(() => JSON.stringify(toDocs(getAppData())));
  await page.evaluate(() => { getAppData().cycles.push(getDefaultCycle('Nach dem Export', 2)); saveData(); });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.list-row:has-text("Sicherung wiederherstellen")')]);
  await chooser.setFiles(datei);
  await page.waitForSelector('#modalContent .list-row:has-text("Hinzufügen")');
  await page.screenshot({ path: path.join(__dirname, 'shot-wiederherstellen.png') });
  await page.click('#modalContent .list-row:has-text("Hinzufügen")');
  await page.waitForTimeout(300);
  ok('Hinzufuegen behaelt den neueren Zyklus', await page.evaluate(() => getAppData().cycles.some(c => c.name === 'Nach dem Export')));
  await page.click('.list-row:has-text("rückgängig")');
  ok('Rueckgaengig-Zeile funktioniert', await page.evaluate(() => getAppData().cycles.some(c => c.name === 'Nach dem Export')) &&
    !(await page.locator('.list-row:has-text("rückgängig")').count()));
  fs.unlinkSync(datei);
  void vorher;

  // So sieht es auf dem iPhone aus
  const iphone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  const ip = await iphone.newPage();
  await ip.goto(`http://localhost:8094${BASE}/`, { waitUntil: 'networkidle' });
  ok('iPhone bekommt das Apple-Aussehen', await ip.evaluate(() => document.documentElement.classList.contains('apple')));
  await ip.click('.tab-btn:nth-child(5)');
  await ip.screenshot({ path: path.join(__dirname, 'shot-iphone-einstellungen.png') });
  await iphone.close();

  // Langer Zyklus in Minuten: Diagramm verschiebbar, auf die aktuelle Woche gerichtet
  const vorherAktiv = await page.evaluate(() => getAppData().activeCycleId);
  await page.evaluate(() => {
    const c = getDefaultCycle('Jahresplan', 52);
    c.unit = 'min';
    c.startDate = addDays(toDateStr(new Date()), -7 * 30);
    c.weekTargets = Array.from({ length: 52 }, (_, i) => [240, 270, 300, 150][i % 4]);
    c.exercises = [{ id: 'm1', name: 'Bouldern', categories: ['Kraft'], intensity: 90 }];
    for (let i = 0; i < 30 * 7; i += 2) c.sessions[addDays(c.startDate, i)] = [{ exId: 'm1' }];
    getAppData().cycles.push(c); getAppData().activeCycleId = c.id; saveData(); render();
  });
  await page.click('.tab-btn:nth-child(1)');
  await page.waitForTimeout(300);
  // Langer Zyklus: zunaechst 12 Wochen rund um die aktuelle
  ok('langer Zyklus: Diagramm zeigt 12 Wochen', (await page.locator('#intChart rect[data-col]').count()) === 12);
  // Maus: Drueberfahren zeigt die Woche
  const cb = await page.locator('#intChart').boundingBox();
  const xWoche = async wk => { const r = await page.locator(`#intChart rect[data-wk="${wk}"]`).boundingBox(); return r.x + r.width / 2; };
  await page.mouse.move(await xWoche(30), cb.y + cb.height / 2);
  ok('Maus ueber Woche 31 zeigt deren Werte', (await page.locator('#intChart_tw').textContent()) === 'Woche 31' &&
    (await page.locator('#intChart_tt').textContent()).includes('300 min'));
  await page.mouse.move(cb.x + cb.width / 2, cb.y - 40);
  ok('Maus weg: Anzeige verschwindet', !(await page.locator('#intChart_tip').isVisible()));
  // Finger: auflegen und seitlich wischen (Zeigerereignisse wie auf dem Handy)
  await page.evaluate(({ a, b, y }) => {
    const svg = document.getElementById('intChart');
    const ev = (type, x, buttons) => svg.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch', clientX: x, clientY: y, buttons }));
    ev('pointerdown', a, 1); ev('pointermove', (a + b) / 2, 1); ev('pointermove', b, 1); ev('pointerup', b, 0);
  }, { a: await xWoche(27), b: await xWoche(34), y: cb.y + cb.height / 2 });
  ok('Wischen mit dem Finger: Anzeige folgt bis Woche 35', (await page.locator('#intChart_tw').textContent()) === 'Woche 35' &&
    await page.locator('#intChart_tip').isVisible());
  await page.click('#intChart >> xpath=../.. >> button:text-is("Alle")');
  ok('"Alle" zeigt alle 52 Wochen', (await page.locator('#intChart rect[data-col]').count()) === 52);
  await page.screenshot({ path: path.join(__dirname, 'shot-lang-alle.png') });
  await page.click('button:text-is("12 Wo.")');
  await page.screenshot({ path: path.join(__dirname, 'shot-lang.png'), fullPage: true });
  await page.evaluate(() => { const c = getActiveCycle(); c.weekTargets[getCurrentWeekIndex(c)] = 6.5; c.unit = undefined; saveData(); render(); });
  await page.waitForTimeout(200);
  ok('Komma ohne Luecke in Monospace-Zahlen', await page.evaluate(() => {
    const dc = document.querySelector('.main .dc');
    return !!dc && dc.textContent === ',' && getComputedStyle(dc).marginLeft.startsWith('-');
  }));
  await page.click('.tab-btn:nth-child(2)');
  await page.screenshot({ path: path.join(__dirname, 'shot-lang-plan.png'), fullPage: true });
  await page.evaluate(id => { const d = getAppData(); d.cycles.pop(); d.activeCycleId = id; saveData(); render(); }, vorherAktiv);

  // Grosse Bildschirme: PC mit Seitenleiste, iPad mit zentrierten Dialogen
  for (const [name, vp, ua] of [
    ['pc', { width: 1280, height: 800 }, null],
    ['ipad', { width: 820, height: 1180 }, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15']
  ]) {
    const gross = await browser.newContext(Object.assign({ viewport: vp }, ua ? { userAgent: ua, hasTouch: true } : {}));
    const gp = await gross.newPage();
    gp.on('pageerror', e => errs.push(name + ': ' + e.message));
    await gp.goto(`http://localhost:8094${BASE}/`, { waitUntil: 'networkidle' });
    await gp.evaluate(daten => { replaceAppData(JSON.parse(daten)); }, await page.evaluate(() => JSON.stringify(getAppData())));
    await gp.click('.tab-btn:nth-child(1)');
    await gp.waitForTimeout(300);
    const breite = await gp.evaluate(() => document.querySelector('.view.active').getBoundingClientRect().width);
    ok(`${name}: Inhalt in Lesebreite`, breite <= 720 && breite > 600, String(breite));
    if (name === 'pc') {
      ok('pc: Navigation als Seitenleiste', await gp.evaluate(() => getComputedStyle(document.querySelector('.tabs')).flexDirection === 'column'));
    }
    await gp.screenshot({ path: path.join(__dirname, `shot-${name}-uebersicht.png`) });
    await gp.click('.tab-btn:nth-child(2)');
    await gp.click('#exerciseList .exercise-item >> nth=0');
    await gp.waitForTimeout(400);
    const box = await gp.locator('#modalBox').boundingBox();
    ok(`${name}: Fenster als zentrierter Dialog`, box.width <= 520 && box.y > 20, JSON.stringify(box));
    await gp.screenshot({ path: path.join(__dirname, `shot-${name}-dialog.png`) });
    await gp.keyboard.press('Escape');
    await gp.waitForTimeout(300);
    ok(`${name}: Escape schliesst das Fenster`, !(await gp.evaluate(() => document.getElementById('modalOverlay').classList.contains('open'))));
    await gross.close();
  }

  // Wochenansicht: geplanten Tag verschieben
  const aktivVorher = await page.evaluate(() => getAppData().activeCycleId);
  await page.evaluate(() => {
    const c = getDefaultCycle('Verschieben', 4); c.mode = 'plan'; c.startDate = toDateStr(new Date());
    getAppData().cycles.push(c); getAppData().activeCycleId = c.id; applyTemplate(c, PLAN_TEMPLATES[1]); saveData(); switchView('dashboard');
  });
  await page.click('.week-row >> nth=1');
  await page.waitForSelector('#weekView');
  const planVorher = await page.evaluate(() => { const c = getActiveCycle(); return getWeekDates(c, 1).map(d => plannedItems(c, d).length); });
  const von = planVorher.findIndex(n => n > 0), nach = planVorher.findIndex(n => n === 0);
  await drag(page, `#weekView .wv-day >> nth=${von} >> .wv-grip`, [`#weekView .wv-day >> nth=${nach}`], 'shot-verschieben.png');
  const planDanach = await page.evaluate(() => { const c = getActiveCycle(); return getWeekDates(c, 1).map(d => plannedItems(c, d).length); });
  ok('Trainingstag in der Woche verschoben', planDanach[von] === 0 && planDanach[nach] === planVorher[von], JSON.stringify([planVorher, planDanach]));
  await page.click('#weekView button:text-is("Schließen")');
  await page.waitForTimeout(300);

  // Kalender-Export
  await page.click('.tab-btn:nth-child(2)');
  await page.click('#planContent .section-hdr .icon-btn');
  await page.click('.pop-menu .pop-item:has-text("In den Kalender")');
  const [ics] = await Promise.all([page.waitForEvent('download'), page.click('#modalContent button:text-is("Exportieren")')]);
  const icsPfad = path.join(__dirname, 'test.ics');
  await ics.saveAs(icsPfad);
  const icsText = fs.readFileSync(icsPfad, 'utf8');
  ok('Kalenderdatei mit Terminen', icsText.startsWith('BEGIN:VCALENDAR') && (icsText.match(/BEGIN:VEVENT/g) || []).length >= 10, String((icsText.match(/BEGIN:VEVENT/g) || []).length));
  fs.unlinkSync(icsPfad);

  // Plan fuer jemand anderen
  await page.click('.tab-btn:nth-child(5)');
  await page.click('.list-row:has-text("Plan für jemand anderen erstellen")');
  await page.fill('#draftWho', 'Mara');
  await page.selectOption('#draftFrom', 'tpl:einsteiger');
  await page.click('button:text-is("Plan erstellen")');
  await page.waitForTimeout(400);
  ok('Entwurf im Trainingsplan', await page.locator('.draft-bar:has-text("Plan für Mara")').isVisible());
  await page.screenshot({ path: path.join(__dirname, 'shot-entwurf.png'), fullPage: true });
  await page.click('.draft-bar button:text-is("Fertig")');
  ok('danach wieder der eigene Zyklus', await page.evaluate(() => getActiveCycle().name === 'Verschieben'));
  ok('Entwurf in den Einstellungen', await page.locator('#settingsContent .list-row:has-text("Plan für Mara")').isVisible());
  await page.evaluate(id => { const d = getAppData(); d.cycles = d.cycles.filter(c => c.name !== 'Verschieben' && !c.forOther); d.activeCycleId = id; saveData(); render(); }, aktivVorher);

  // Neue Version veroeffentlicht: Die App merkt es beim Zurueckkommen und laedt neu
  await page.click('.tab-btn:nth-child(1)');
  versionOverride = '9999';
  const neuGeladen = page.waitForEvent('load', { timeout: 20000 }).then(() => true, () => false);
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));
  ok('neue Version wird erkannt und geladen', await neuGeladen);
  await page.waitForFunction(() => typeof APP_VERSION !== 'undefined' && APP_VERSION.name === '9999', null, { timeout: 10000 })
    .then(() => ok('danach laeuft die neue Version', true), () => ok('danach laeuft die neue Version', false));
  versionOverride = null;

  // Neustart ohne Netz
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  ok('startet offline', (await page.locator('.tab-btn').count()) === 5);
  await page.click('.tab-btn:nth-child(2)');
  ok('Daten offline vorhanden', await page.locator('.exercise-name:has-text("Hang")').isVisible());
  ok('Reihenfolge ueberlebt den Neustart',
    (await page.locator('#exerciseList .exercise-name').allInnerTexts()).join() === 'Hang,Dehnen,Aufwaermen,Klimmzug max');
  await page.click('.tab-btn:nth-child(5)');
  ok('Konto-Zeile auch offline da', await page.locator('#cloudBox >> text=Anmelden').isVisible());

  ok('keine Fehler insgesamt', errs.length === 0, errs.join(' | '));
  console.log(log.join('\n'));
  await browser.close(); server.close();
})().catch(e => { console.log(log.join('\n')); console.log('ABBRUCH:', e.message); process.exit(1); });

// Zieht mit der Maus (Pointer-Events) von einem Element über weitere Ziele
async function drag(page, from, targets, shot) {
  const box = async sel => { const l = page.locator(sel).first(); await l.scrollIntoViewIfNeeded(); return l.boundingBox(); };
  const a = await box(from);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  let x = a.x + a.width / 2, y = a.y + a.height / 2;
  for (const t of targets) {
    const b = await page.locator(t).first().boundingBox();
    const tx = b.x + b.width / 2, ty = b.y + b.height / 2;
    for (let i = 1; i <= 8; i++) await page.mouse.move(x + (tx - x) * i / 8, y + (ty - y) * i / 8);
    x = tx; y = ty;
  }
  if (shot) await page.screenshot({ path: path.join(__dirname, shot) });
  await page.mouse.up();
  await page.waitForTimeout(400);
}
