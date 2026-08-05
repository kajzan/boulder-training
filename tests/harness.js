/* Minimale Browser-Attrappe, damit app.js in Node laufen kann.
 *
 * Die App ist bewusst ohne Framework und ohne Build-Schritt gebaut. Statt
 * dafür eine Testinfrastruktur aufzusetzen, laden wir app.js hier im globalen
 * Kontext und stellen die paar Browser-Bausteine bereit, die sie anfasst.
 * Aufruf: node tests/run.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function install() {
  const store = {};
  globalThis.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: k => { delete store[k]; }
  };

  const els = {};
  const fakeEl = id => (els[id] ||= {
    id,
    value: '',
    innerHTML: '',
    textContent: '',
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    nextElementSibling: { style: {} },
    focus() {}
  });

  globalThis.document = {
    getElementById: fakeEl,
    querySelectorAll: () => [],
    createElement: () => ({ click() {}, setAttribute() {}, style: {} })
  };
  globalThis.navigator = {};
  globalThis.window = { addEventListener() {} };
  globalThis.alert = m => { throw new Error('unerwarteter alert: ' + m); };
  globalThis.confirm = () => true;
  globalThis.setTimeout = fn => { /* Modal-Animationen im Test nicht nachspielen */ };

  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'), { filename: 'app.js' });

  return { el: fakeEl, store };
}

/* ── winziges Test-Gerüst ── */
let failures = 0;
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log('\n' + name);
}

function check(name, cond, extra = '') {
  if (cond) {
    console.log('  PASS  ' + name);
  } else {
    console.log('  FAIL  ' + name + (extra ? '  → ' + extra : ''));
    failures++;
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  check(name, a === e, `erwartet ${e}, bekam ${a}`);
}

function done() {
  console.log(failures === 0
    ? `\nALLE TESTS BESTANDEN`
    : `\n${failures} TEST(S) FEHLGESCHLAGEN`);
  process.exit(failures === 0 ? 0 : 1);
}

module.exports = { install, group, check, eq, done };
