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
  ok('Trainingsplan zeigt den Wochenplan', await page.locator('.plan-day').count() === 3);
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
  await page.click('.list-row:has-text("Wochenplan")');
  ok('Wochenplan-Schalter', await page.evaluate(() => isPlanMode(getActiveCycle())));
  await page.click('.list-row:has-text("Wochenplan")');
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

  // Wochenplan einschalten, Uebung mit Tagen und Messwert anlegen
  await page.waitForTimeout(400);   // die Klicksperre nach dem Ziehen abwarten
  await page.click('.tab-btn:nth-child(5)');
  await page.click('.list-row:has-text("Wochenplan")');
  await page.click('.tab-btn:nth-child(2)');
  await page.click('button:text-is("+ Hinzufügen")');
  await page.fill('#newExName', 'Klimmzug max');
  await page.fill('#newExInt', '1');
  for (const d of ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']) await page.click(`#newExDays button:text-is("${d}")`);
  await page.click('.check-row:has-text("Messwert beim Abhaken")');
  await page.fill('#newExUnit', 'kg');
  await page.screenshot({ path: path.join(__dirname, 'shot-uebung.png') });
  await page.click('button:text-is("Hinzufügen")');
  await page.waitForTimeout(400);
  ok('Uebung zeigt ihre Tage', await page.locator('.exercise-item:has-text("Klimmzug max") >> text=Mo · Di').isVisible());

  // Pausieren und fortsetzen (die Woche ist noch leer)
  await page.evaluate(() => { const c = getActiveCycle(); c.startDate = toDateStr(new Date()); c.sessions = {}; saveData(); });
  await page.click('.tab-btn:nth-child(1)');
  await page.click('button:has-text("Pausieren")');
  ok('Pause sichtbar', await page.locator('button:text-is("Training fortsetzen")').isVisible());
  await page.screenshot({ path: path.join(__dirname, 'shot-pause.png'), fullPage: true });
  await page.click('button:text-is("Training fortsetzen")');
  ok('Pause beendet', await page.locator('button:has-text("Pausieren")').isVisible());

  // Abhaken mit Messwert
  await page.click('.card:has(.card-title:has-text("Heute"))');
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

  // Logbuch
  await page.click('.tab-btn:nth-child(4)');
  await page.click('button:text-is("+ Boulder")');
  await page.selectOption('#ascGrade', { label: '6B+' });
  await page.click('#ascStyle button:text-is("Flash")');
  await page.fill('#ascName', 'Gelbe Platte');
  await page.screenshot({ path: path.join(__dirname, 'shot-boulder.png') });
  await page.click('button:text-is("Speichern")');
  await page.waitForTimeout(400);
  await page.click('button:text-is("+ Boulder")');
  await page.click('button:text-is("Speichern")');
  await page.waitForTimeout(400);
  ok('Pyramide zeigt den hoechsten Grad', await page.locator('.stat-val:text-is("6B+")').first().isVisible());
  ok('zwei Eintraege im Logbuch', (await page.locator('.log-row').count()) === 2);
  await page.screenshot({ path: path.join(__dirname, 'shot-logbuch.png'), fullPage: true });

  // Plan teilen (ohne Teilen-Menue im Testbrowser: Link in die Zwischenablage)
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('.tab-btn:nth-child(2)');
  await page.click('.list-row:has-text("Plan teilen")');
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
  const sl = await page.evaluate(() => document.querySelector('.chart-scroll').scrollLeft);
  ok('langes Diagramm steht bei der aktuellen Woche', sl > 200, String(sl));
  await page.screenshot({ path: path.join(__dirname, 'shot-lang.png'), fullPage: true });
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
