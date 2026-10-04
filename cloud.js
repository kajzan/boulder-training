/* Konto und Synchronisation über Firebase.
 *
 * Ohne Anmeldung tut diese Datei nichts: Die App speichert wie bisher nur auf
 * dem Gerät. Mit Anmeldung liegen die Daten zusätzlich unter
 * users/<konto>/data/<eintrag> in Firestore; welche Einträge es gibt und wie
 * zusammengeführt wird, regelt sync.js.
 *
 * Ablauf:
 *  - Die App speichert wie immer lokal. Danach ruft sie cloudAfterSave(), und
 *    diese Datei schreibt nur die Einträge, die sich gegenüber dem letzten
 *    gemeinsamen Stand (base) geändert haben.
 *  - Ändert ein anderes Gerät etwas, meldet Firestore den neuen Stand. Er wird
 *    mit den eigenen, noch nicht geschriebenen Änderungen zusammengeführt
 *    und ersetzt den Stand der App.
 *  - Geschrieben wird erst, nachdem einmal ein vollständiger Stand vom Server
 *    kam. Ein halb geladener Stand könnte sonst als Löschung missverstanden
 *    werden. Offline gesammelte Änderungen gehen dabei nicht verloren: Sie
 *    ergeben sich beim nächsten Kontakt aus dem Vergleich mit base.
 */
import {
  initializeApp, getAuth, connectAuthEmulator, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  connectFirestoreEmulator, collection, doc, onSnapshot, writeBatch
} from './vendor/firebase.js';

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAroYR33Ro4u5TwmC-tsDVcl6RZ_qZGaJY',
  authDomain: 'boulder-training.firebaseapp.com',
  projectId: 'boulder-training',
  storageBucket: 'boulder-training.firebasestorage.app',
  messagingSenderId: '118847532076',
  appId: '1:118847532076:web:2851b01b58aab534de7589'
};

// Mit ?emulator in der Adresse spricht die App mit dem lokalen Firebase-
// Emulator statt mit dem echten Projekt. Nur für Tests.
const EMULATOR = new URLSearchParams(location.search).has('emulator');

const SYNC_KEY = 'boulderSync';             // { uid, base } – letzter gemeinsamer Stand
const BACKUP_KEY = 'boulderApp_v2_vorKonto'; // Stand des Geräts vor der ersten Anmeldung
const BATCH_LIMIT = 450;                    // Firestore erlaubt 500 Vorgänge je Schreibpaket

const app = initializeApp(EMULATOR ? { apiKey: 'demo', projectId: 'demo-boulder' } : FIREBASE_CONFIG);
const auth = getAuth(app);
auth.languageCode = 'de';
// Der Zwischenspeicher auf dem Gerät hält auch Schreibvorgänge fest, die
// offline entstanden sind – selbst wenn die App vor dem nächsten Netz
// geschlossen wird.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});
if (EMULATOR) {
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, 'localhost', 8085);
}

const state = {
  user: null,
  ready: false,       // vollständiger Stand vom Server da, Schreiben erlaubt
  base: null,         // letzter gemeinsamer Stand
  unsubscribe: null,
  status: 'idle',     // idle | connecting | offline | pending | synced | error
  lastSync: null,
  error: '',
  busy: false
};

function readSync() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)); } catch (e) { return null; }
}

function writeSync() {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify({ uid: state.user.uid, base: state.base })); } catch (e) {}
}

function dataRef(key) {
  return doc(db, 'users', state.user.uid, 'data', key);
}

// ── Schreiben ──
function push(diff) {
  const ops = Object.keys(diff.set).map(k => ['set', k, diff.set[k]])
    .concat(diff.del.map(k => ['del', k]));
  for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
    const batch = writeBatch(db);
    ops.slice(i, i + BATCH_LIMIT).forEach(([op, k, v]) => {
      if (op === 'set') batch.set(dataRef(k), v);
      else batch.delete(dataRef(k));
    });
    // Offline bleibt das Versprechen offen, bis der Server bestätigt. Die
    // Änderung liegt aber schon im Zwischenspeicher und geht nicht verloren.
    batch.commit().catch(err => setError(describeError(err)));
  }
  state.base = applyDiff(state.base, diff);
  writeSync();
}

// Von der App nach jedem lokalen Speichern aufgerufen
window.cloudAfterSave = function () {
  if (!state.ready) return;
  const diff = diffDocs(state.base, toDocs(getAppData()));
  if (!isEmptyDiff(diff)) push(diff);
};

// ── Lesen ──
function onServerState(snap) {
  const server = {};
  snap.docs.forEach(d => { server[d.id] = d.data(); });

  if (snap.metadata.fromCache) {
    state.status = 'offline';
  } else if (snap.metadata.hasPendingWrites) {
    state.status = 'pending';
  } else {
    state.status = 'synced';
    state.lastSync = new Date();
  }

  // Vor dem ersten vollständigen Stand vom Server nichts entscheiden
  if (!state.ready && snap.metadata.fromCache) { renderCloudBox(); return; }

  const local = toDocs(getAppData());
  let plan;
  if (!state.ready) {
    const saved = readSync();
    if (saved && saved.uid === state.user.uid && saved.base) {
      // Dieses Gerät war schon verbunden: Offline-Änderungen nachreichen
      state.base = saved.base;
      plan = planSync(state.base, local, server);
    } else {
      // Erste Verbindung dieses Geräts mit dem Konto
      try { localStorage.setItem(BACKUP_KEY, JSON.stringify(getAppData())); } catch (e) {}
      let merge = true;
      if (hasUserData(local) && hasUserData(server)) {
        merge = confirm('Auf diesem Gerät sind schon Trainingsdaten gespeichert, und in deinem Konto auch.\n\n' +
          'OK: beides zusammenführen\nAbbrechen: nur die Daten aus dem Konto verwenden\n\n' +
          'Der bisherige Stand dieses Geräts wird vorher gesichert.');
      }
      state.base = server;
      plan = planFirstLink(local, server, merge);
    }
    state.ready = true;
  } else {
    plan = planSync(state.base, local, server);
  }

  if (!isEmptyDiff(plan.push)) {
    state.base = server;
    push(plan.push);
  }
  state.base = plan.result;
  writeSync();

  if (syncCanon(plan.result) !== syncCanon(local)) {
    replaceAppData(fromDocs(plan.result));
  }
  renderCloudBox();
}

function startSync() {
  state.ready = false;
  state.status = 'connecting';
  state.error = '';
  state.unsubscribe = onSnapshot(
    collection(db, 'users', state.user.uid, 'data'),
    { includeMetadataChanges: true },
    onServerState,
    err => setError(describeError(err))
  );
}

function stopSync() {
  if (state.unsubscribe) state.unsubscribe();
  state.unsubscribe = null;
  state.ready = false;
  state.base = null;
}

onAuthStateChanged(auth, user => {
  stopSync();
  state.user = user;
  state.status = user ? 'connecting' : 'idle';
  if (user) startSync();
  renderCloudBox();
});

// ── Anmeldung ──
function describeError(err) {
  const code = (err && err.code) || '';
  const texte = {
    'auth/invalid-email': 'Die E-Mail-Adresse ist ungültig.',
    'auth/missing-password': 'Bitte ein Passwort eingeben.',
    'auth/weak-password': 'Das Passwort muss mindestens 6 Zeichen haben.',
    'auth/email-already-in-use': 'Für diese Adresse gibt es schon ein Konto. Bitte anmelden.',
    'auth/invalid-credential': 'E-Mail oder Passwort stimmt nicht.',
    'auth/wrong-password': 'E-Mail oder Passwort stimmt nicht.',
    'auth/user-not-found': 'E-Mail oder Passwort stimmt nicht.',
    'auth/too-many-requests': 'Zu viele Versuche. Bitte kurz warten.',
    'auth/network-request-failed': 'Keine Verbindung. Anmelden geht nur mit Internet.',
    'permission-denied': 'Kein Zugriff auf die Daten. Sind die Sicherheitsregeln in Firebase eingetragen?'
  };
  return texte[code] || (err && err.message) || String(err);
}

function setError(text) {
  state.error = text;
  state.status = 'error';
  state.busy = false;
  renderCloudBox();
}

// Die Eingaben werden gelesen, bevor der Kasten neu gezeichnet wird – das
// Neuzeichnen leert die Felder. Die E-Mail bleibt danach stehen, damit man
// nach einem Tippfehler im Passwort nicht alles neu eingeben muss.
async function withBusy(fn) {
  const email = (document.getElementById('cloudEmail')?.value || '').trim();
  const password = document.getElementById('cloudPassword')?.value || '';
  state.formEmail = email;
  state.busy = true;
  state.error = '';
  renderCloudBox();
  try { await fn(email, password); } catch (err) { setError(describeError(err)); return; }
  state.busy = false;
  renderCloudBox();
}

window.cloudSignIn = () => withBusy((email, password) =>
  signInWithEmailAndPassword(auth, email, password));

window.cloudSignUp = () => withBusy((email, password) =>
  createUserWithEmailAndPassword(auth, email, password));

window.cloudResetPassword = () => withBusy(async email => {
  if (!email) throw { message: 'Bitte zuerst die E-Mail-Adresse eingeben.' };
  await sendPasswordResetEmail(auth, email);
  alert('Wir haben dir eine E-Mail zum Zurücksetzen des Passworts geschickt. ' +
        'Danach kannst du dich hier mit dem neuen Passwort anmelden.');
});

window.cloudSignOut = () => {
  if (!confirm('Abmelden?\n\nDeine Daten bleiben auf diesem Gerät, werden aber nicht mehr abgeglichen.')) return;
  stopSync();
  try { localStorage.removeItem(SYNC_KEY); } catch (e) {}
  signOut(auth);
};

window.cloudDownloadBackup = () => {
  const raw = localStorage.getItem(BACKUP_KEY);
  if (!raw) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
  a.download = 'boulder-stand-vor-anmeldung.json';
  a.click();
};

// ── Anzeige in den Einstellungen ──
function statusText() {
  const zeit = state.lastSync
    ? state.lastSync.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
  switch (state.status) {
    case 'connecting': return { text: 'Verbinde …', color: 'var(--text-muted)' };
    case 'offline': return { text: 'Offline – Änderungen werden abgeglichen, sobald Netz da ist', color: 'var(--blue)' };
    case 'pending': return { text: 'Änderungen werden übertragen …', color: 'var(--text-muted)' };
    case 'synced': return { text: 'Synchronisiert' + (zeit ? ' · ' + zeit : ''), color: 'var(--green-dark)' };
    case 'error': return { text: state.error, color: 'var(--red)' };
    default: return { text: '', color: 'var(--text-muted)' };
  }
}

function renderCloudBox() {
  const box = document.getElementById('cloudBox');
  if (!box) return;

  if (!state.user) {
    box.innerHTML = `
      <div class="card">
        <div class="text-muted" style="margin-bottom:12px">Mit einem Konto hast du deine Daten auf allen Geräten. Ohne Konto bleibt alles nur auf diesem Gerät.</div>
        <div class="field"><label>E-Mail</label>
          <input type="email" id="cloudEmail" autocomplete="username" autocapitalize="off" value="${esc(state.formEmail || '')}"></div>
        <div class="field"><label>Passwort (mind. 6 Zeichen)</label>
          <input type="password" id="cloudPassword" autocomplete="current-password"></div>
        ${state.error ? `<div style="font-size:12px;color:var(--red);margin-bottom:10px">${esc(state.error)}</div>` : ''}
        <div class="row">
          <button class="btn btn-ghost" onclick="cloudSignUp()" ${state.busy ? 'disabled' : ''}>Konto erstellen</button>
          <button class="btn btn-primary" onclick="cloudSignIn()" ${state.busy ? 'disabled' : ''}>Anmelden</button>
        </div>
        <button class="btn btn-ghost btn-full mt-8" style="font-size:12px;border:none;background:none;color:var(--text-muted)"
          onclick="cloudResetPassword()" ${state.busy ? 'disabled' : ''}>Passwort vergessen?</button>
      </div>`;
    return;
  }

  const s = statusText();
  const backup = localStorage.getItem(BACKUP_KEY);
  box.innerHTML = `
    <div class="card">
      <div style="font-weight:600;font-size:15px;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis">${esc(state.user.email || '')}</div>
      <div style="font-size:12px;color:${s.color};margin-bottom:12px">${esc(s.text)}</div>
      <button class="btn btn-ghost btn-sm" onclick="cloudSignOut()">Abmelden</button>
      ${backup ? `<button class="btn btn-ghost btn-sm" style="margin-left:6px" onclick="cloudDownloadBackup()">Stand vor der Anmeldung sichern</button>` : ''}
    </div>`;
}
window.renderCloudBox = renderCloudBox;

if (EMULATOR) window.__cloud = { auth, db, state, doc, collection, onSnapshot };
renderCloudBox();
