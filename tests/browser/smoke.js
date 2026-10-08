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
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (!p.startsWith(BASE)) { res.writeHead(404); return res.end(); }
  p = p.slice(BASE.length) || '/'; if (p.endsWith('/')) p += 'index.html';
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
  ok('erster Start bietet Wochenplan und frei an', (await page.locator('.choice-card').count()) === 2);
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
  await page.click('a:text-is("Pausieren")');
  ok('Pause sichtbar', await page.locator('button:text-is("Training fortsetzen")').isVisible());
  await page.screenshot({ path: path.join(__dirname, 'shot-pause.png'), fullPage: true });
  await page.click('button:text-is("Training fortsetzen")');
  ok('Pause beendet', await page.locator('a:text-is("Pausieren")').isVisible());

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
