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
  for (const [i, n] of [[1, 'Uebersicht'], [2, 'Trainingsplan'], [3, 'Assessment'], [4, 'Verlauf'], [5, 'Einstellungen']]) {
    await page.click(`.tab-btn:nth-child(${i})`);
    ok(`Ansicht ${n} rendert`,
      await page.evaluate(() => document.querySelector('.view.active').innerText.trim().length > 0));
  }
  ok('Konto-Kasten erscheint ohne Anmeldung',
    await page.locator('#cloudEmail').isVisible() && await page.locator('button:text-is("Konto erstellen")').isVisible());

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

  // Neustart ohne Netz
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  ok('startet offline', (await page.locator('.tab-btn').count()) === 5);
  await page.click('.tab-btn:nth-child(2)');
  ok('Daten offline vorhanden', await page.locator('.exercise-name:has-text("Hang")').isVisible());
  ok('Reihenfolge ueberlebt den Neustart',
    (await page.locator('#exerciseList .exercise-name').allInnerTexts()).join() === 'Hang,Dehnen,Aufwaermen');
  await page.click('.tab-btn:nth-child(5)');
  ok('Konto-Kasten auch offline da', await page.locator('#cloudEmail').isVisible());

  ok('keine Fehler insgesamt', errs.length === 0, errs.join(' | '));
  console.log(log.join('\n'));
  await browser.close(); server.close();
})().catch(e => { console.log(log.join('\n')); console.log('ABBRUCH:', e.message); process.exit(1); });
