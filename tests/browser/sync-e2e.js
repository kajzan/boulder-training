/* Ende-zu-Ende: mehrere Geraete gegen den Firebase-Emulator.
 *
 * Aufruf (einmalig: npm install -g firebase-tools; npm install playwright):
 *   firebase emulators:exec --project demo-boulder --only auth,firestore "node tests/browser/sync-e2e.js"
 * Aus dem Hauptverzeichnis starten (dort liegt firebase.json). Braucht Java
 * fuer den Emulator. Laeuft komplett lokal, das echte
 * Firebase-Projekt wird nicht beruehrt. CHROMIUM=<pfad> waehlt einen
 * bestimmten Browser. */
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..'), BASE = '/boulder-training';
const TYPES = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript',
                '.json':'application/manifest+json', '.png':'image/png', '.woff2':'font/woff2' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (!p.startsWith(BASE)) { res.writeHead(404); return res.end(); }
  p = p.slice(BASE.length) || '/'; if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
const URL = `http://localhost:8099${BASE}/?emulator`;

const log = [];
const ok = (n, c, x = '') => { log.push((c ? 'PASS  ' : 'FAIL  ') + n + (c ? '' : '  → ' + x)); if (!c) process.exitCode = 1; };
let browser;
const errors = [];

async function geraet(name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(name + ': ' + e.message));
  page.on('dialog', d => { page.__dialoge = (page.__dialoge || []).concat(d.message()); d.accept(); });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__cloud);
  return { ctx, page, name };
}

async function lokalerStand(g, data) {
  await g.page.evaluate(d => { replaceAppData(d); saveData(); }, data);
}

async function anmelden(g, email, pw, neu) {
  await g.page.click('.tab-btn:nth-child(5)');
  await g.page.fill('#cloudEmail', email);
  await g.page.fill('#cloudPassword', pw);
  await g.page.click(neu ? 'button:text-is("Konto erstellen")' : 'button:text-is("Anmelden")');
}

const synchron = (g, ms = 30000) => g.page.waitForFunction(
  () => window.__cloud.state.ready && window.__cloud.state.status === 'synced', null, { timeout: ms });

const daten = g => g.page.evaluate(() => getAppData());
const zyklus = d => d.cycles.find(c => c.id === d.activeCycleId) || d.cycles[0];
async function warteAuf(g, fn, arg, ms = 30000) {
  await g.page.waitForFunction(fn, arg, { timeout: ms });
}

const START = {
  activeCycleId: 'c1', tests: [], assessments: [],
  cycles: [{ id: 'c1', name: 'Herbst', startDate: '2026-09-07', weeks: 4, weekTargets: [8, 8, 8, 8], notes: {},
    exercises: [
      { id: 'x1', name: 'Hangboard', categories: ['Finger'], intensity: 2 },
      { id: 'x2', name: 'Klimmzüge', categories: ['Pull'], intensity: 2 }
    ],
    sessions: { '2026-09-07': [{ exId: 'x1' }] } }]
};

(async () => {
  await new Promise(r => server.listen(8099, r));
  browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});

  // ── 1. Handy hat Daten und legt ein Konto an ──
  const handy = await geraet('Handy');
  await lokalerStand(handy, START);
  await anmelden(handy, 'kajetan@test.de', 'geheim123', true);
  await synchron(handy);
  const uid = await handy.page.evaluate(() => window.__cloud.state.user.uid);
  ok('Handy: Konto angelegt und synchronisiert', !!uid);
  const anzahl = await handy.page.evaluate(() => Object.keys(window.__cloud.state.base).length);
  ok('Handy: lokale Daten ins Konto hochgeladen', anzahl >= 5, 'Eintraege: ' + anzahl);
  await handy.page.screenshot({ path: path.join(__dirname, 'shot-konto.png') });

  // ── 2. Laptop ohne Daten meldet sich an ──
  const laptop = await geraet('Laptop');
  await anmelden(laptop, 'kajetan@test.de', 'geheim123', false);
  await synchron(laptop);
  const ld = await daten(laptop);
  ok('Laptop: bekommt die Daten vom Handy',
    zyklus(ld) && zyklus(ld).name === 'Herbst' && zyklus(ld).exercises.length === 2,
    JSON.stringify(ld).slice(0, 200));
  ok('Laptop: keine Rueckfrage, weil er selbst nichts hatte', !(laptop.page.__dialoge || []).length);

  // ── 3. Live: Laptop legt eine Uebung an, das Handy sieht sie ──
  await laptop.page.evaluate(() => {
    getActiveCycle().exercises.push({ id: 'x3', name: 'Campus', categories: ['Pull', 'Finger'], intensity: 3 });
    saveData();
  });
  await warteAuf(handy, () => getActiveCycle() && getActiveCycle().exercises.some(e => e.id === 'x3'));
  ok('Handy: sieht die neue Uebung vom Laptop ohne Neustart', true);
  await handy.page.click('.tab-btn:nth-child(2)');
  ok('Handy: Anzeige ist aktualisiert', await handy.page.locator('.exercise-name:has-text("Campus")').isVisible());

  // ── 4. Offline: beide haken am selben Tag Verschiedenes ab ──
  await handy.ctx.setOffline(true);
  await handy.page.evaluate(() => toggleDayEx('2026-09-08', 'x1'));
  await laptop.page.evaluate(() => toggleDayEx('2026-09-08', 'x2'));
  await synchron(laptop);
  ok('Handy: arbeitet offline weiter', (await daten(handy)).cycles[0].sessions['2026-09-08'].length === 1);
  await handy.ctx.setOffline(false);
  const beide = () => {
    const s = (getActiveCycle().sessions['2026-09-08'] || []).map(e => e.exId).sort();
    return s.join() === 'x1,x2';
  };
  await warteAuf(handy, beide, null, 60000);
  ok('Handy: nach dem Wiederverbinden sind beide Haken da', true);
  await warteAuf(laptop, beide, null, 60000);
  ok('Laptop: hat den offline gesetzten Haken vom Handy bekommen', true);

  // ── 5. Neustart ohne Netz ──
  await handy.ctx.setOffline(true);
  await handy.page.reload({ waitUntil: 'load' });
  await handy.page.waitForFunction(() => window.__cloud, null, { timeout: 20000 });
  const angemeldet = await handy.page.waitForFunction(() => !!window.__cloud.state.user, null, { timeout: 15000 })
    .then(() => true, () => false);
  ok('Handy: startet offline und ist weiter angemeldet', angemeldet);
  ok('Handy: zeigt offline den richtigen Status',
    await handy.page.evaluate(() => ['offline', 'connecting'].includes(window.__cloud.state.status)),
    await handy.page.evaluate(() => window.__cloud.state.status));
  ok('Handy: Daten offline vorhanden',
    (await daten(handy)).cycles[0].exercises.some(e => e.id === 'x3'));
  await handy.page.evaluate(() => { getActiveCycle().name = 'Herbst offline'; saveData(); });
  await handy.ctx.setOffline(false);
  await warteAuf(laptop, () => getActiveCycle() && getActiveCycle().name === 'Herbst offline', null, 60000);
  ok('Laptop: Aenderung aus dem Offline-Neustart kommt an', true);

  // ── 6. Drittes Geraet mit eigenen Daten: zusammenfuehren ──
  const tablet = await geraet('Tablet');
  await lokalerStand(tablet, { activeCycleId: 'c9', tests: [], assessments: [],
    cycles: [{ id: 'c9', name: 'Vom Tablet', startDate: '2026-08-01', weeks: 1, weekTargets: [3],
               notes: {}, exercises: [], sessions: {} }] });
  await anmelden(tablet, 'kajetan@test.de', 'geheim123', false);
  await synchron(tablet);
  ok('Tablet: fragt vor dem Zusammenfuehren nach',
    (tablet.page.__dialoge || []).some(m => m.includes('zusammenführen')), JSON.stringify(tablet.page.__dialoge));
  const td = await daten(tablet);
  ok('Tablet: hat beide Zyklen', td.cycles.map(c => c.id).sort().join() === 'c1,c9', JSON.stringify(td.cycles.map(c => c.id)));
  await warteAuf(laptop, () => getAppData().cycles.some(c => c.id === 'c9'));
  ok('Laptop: bekommt den Zyklus vom Tablet', true);
  ok('Tablet: Stand vor der Anmeldung wurde gesichert',
    await tablet.page.evaluate(() => JSON.parse(localStorage.getItem('boulderApp_v2_vorKonto')).cycles[0].id === 'c9'));

  // ── 7. Fremdes Konto kommt nicht an die Daten ──
  const fremd = await geraet('Fremd');
  await anmelden(fremd, 'fremd@test.de', 'geheim123', true);
  await synchron(fremd);
  const zugriff = await fremd.page.evaluate(uid => new Promise(res => {
    const c = window.__cloud;
    const stop = c.onSnapshot(c.collection(c.db, 'users', uid, 'data'),
      () => { stop(); res('gelesen'); }, e => res(e.code));
  }), uid);
  ok('fremdes Konto: Lesen fremder Daten wird abgelehnt', zugriff === 'permission-denied', zugriff);
  ok('fremdes Konto: sieht nur seine eigenen (leeren) Daten', (await daten(fremd)).cycles.length === 0);

  // ── 8. Falsches Passwort ──
  const fehl = await geraet('Fehl');
  await anmelden(fehl, 'kajetan@test.de', 'falsch999', false);
  await fehl.page.waitForSelector('text=E-Mail oder Passwort stimmt nicht.', { timeout: 15000 });
  ok('falsches Passwort: verstaendliche Meldung', true);

  // ── 9. Abmelden behaelt die Daten auf dem Geraet ──
  await laptop.page.click('.tab-btn:nth-child(5)');
  await laptop.page.click('button:text-is("Abmelden")');
  await laptop.page.waitForFunction(() => !window.__cloud.state.user);
  ok('Laptop: abgemeldet, Daten bleiben auf dem Geraet', (await daten(laptop)).cycles.length === 2);
  await laptop.page.evaluate(() => { getAppData().cycles[0].name = 'nur lokal'; saveData(); });
  await handy.page.waitForTimeout(3000);
  ok('Laptop: nach dem Abmelden wird nichts mehr uebertragen',
    !(await daten(handy)).cycles.some(c => c.name === 'nur lokal'));

  await handy.page.click('.tab-btn:nth-child(5)');
  await handy.page.screenshot({ path: path.join(__dirname, 'shot-konto-synchron.png') });
  await fremd.page.click('.tab-btn:nth-child(5)').catch(() => {});

  ok('keine JS-Fehler', errors.length === 0, errors.join(' | '));
  console.log(log.join('\n'));
  await browser.close(); server.close();
})().catch(e => { console.log(log.join('\n')); console.log('ABBRUCH:', e.message); process.exit(1); });
