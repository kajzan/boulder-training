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
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail,
  sendEmailVerification, reauthenticateWithCredential, EmailAuthProvider, deleteUser, signOut,
  applyActionCode, verifyPasswordResetCode, confirmPasswordReset,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  connectFirestoreEmulator, collection, doc, onSnapshot, getDocs, writeBatch,
  FieldPath, deleteField
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
  busy: false,
  sheet: null,        // offene Ansicht im Konto-Fenster, siehe renderSheet
  showPw: false
};

function readSync() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)); } catch (e) { return null; }
}

function writeSync() {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify({ uid: state.user.uid, base: state.base })); } catch (e) {}
}

function docRef(id) {
  return doc(db, 'users', state.user.uid, 'data', id);
}

// ── Schreiben ──
// writes: Ergebnis von storageWrites(); rawDeletes: Einzeldokumente aus der
// Zeit vor der Bündelung, die nach dem Umzug weg können.
function commitWrites(writes, rawDeletes) {
  const ops = writes.map(w => ['group', w]).concat((rawDeletes || []).map(id => ['raw', id]));
  for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
    const batch = writeBatch(db);
    ops.slice(i, i + BATCH_LIMIT).forEach(([art, x]) => {
      if (art === 'raw') { batch.delete(docRef(x)); return; }
      if (x.removeDoc) { batch.delete(docRef(x.id)); return; }
      // Nur die betroffenen Felder schreiben. Jedes Feld wird dabei ganz
      // ersetzt, nicht vermischt – sonst bliebe etwa eine zurückgenommene
      // Intensitätsänderung im alten Wert stehen.
      const k = {};
      const paths = [];
      Object.keys(x.set).forEach(key => { k[key] = x.set[key]; paths.push(new FieldPath('k', key)); });
      x.del.forEach(key => { k[key] = deleteField(); paths.push(new FieldPath('k', key)); });
      batch.set(docRef(x.id), { k }, { mergeFields: paths });
    });
    // Offline bleibt das Versprechen offen, bis der Server bestätigt. Die
    // Änderung liegt aber schon im Zwischenspeicher und geht nicht verloren.
    batch.commit().catch(err => setError(describeError(err)));
  }
}

function push(diff) {
  commitWrites(storageWrites(diff, state.base));
  state.base = applyDiff(state.base, diff);
  writeSync();
}

// Einzeldokumente aus v7 in die gebündelte Ablage umziehen. Unbekannte Arten
// bleiben, wo sie sind – sie stammen dann nicht von uns.
function migrateLegacy(legacy, docs) {
  const known = legacy.filter(id => SYNC_TYPES.has(syncKeyType(id)));
  if (!known.length) return;
  const set = {};
  known.forEach(id => { if (docs[id] !== undefined) set[id] = docs[id]; });
  commitWrites(storageWrites({ set, del: [] }, docs), known);
}

// Von der App nach jedem lokalen Speichern aufgerufen
window.cloudAfterSave = function () {
  if (!state.ready) return;
  const diff = diffDocs(state.base, toDocs(getAppData()));
  if (!isEmptyDiff(diff)) push(diff);
};

// ── Lesen ──
function onServerState(snap) {
  const raw = {};
  snap.docs.forEach(d => { raw[d.id] = d.data(); });
  const { docs: server, legacy } = flattenStorage(raw);

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
    // Ein Gerät mit v7 hat die gebündelten Dokumente nicht verstanden und
    // sie roh als Stand gespeichert. Damit lässt sich nicht vergleichen –
    // dann lieber wie bei einer ersten Verbindung vom Konto ausgehen.
    const baseOk = saved && saved.base && !Object.keys(saved.base).some(isStorageGroup);
    if (saved && saved.uid === state.user.uid && baseOk) {
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
    // Der gemeldete Stand war von vor diesem Schreiben – noch nicht "synchronisiert"
    if (state.status === 'synced') state.status = 'pending';
  }
  state.base = plan.result;
  writeSync();
  if (legacy.length && !snap.metadata.fromCache) migrateLegacy(legacy, plan.result);

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
  // Der gespeicherte Anmeldestand kennt eine inzwischen bestätigte Adresse
  // noch nicht. Mit Netz einmal nachfragen.
  if (user && !user.emailVerified && navigator.onLine) refreshVerification(false);
});

// Holt den Bestätigungsstand vom Server. Erst ein frisches Anmelde-Token trägt
// ihn auch zu Firestore; danach den Abgleich neu starten.
async function refreshVerification(laut) {
  const user = auth.currentUser;
  if (!user) return;
  await user.reload();
  if (user.emailVerified) {
    await user.getIdToken(true);
    stopSync();
    startSync();
  } else if (laut) {
    throw { message: 'Die Adresse ist noch nicht bestätigt. Bitte den Link in der Mail antippen.' };
  }
  renderCloudBox();
}

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
    'auth/requires-recent-login': 'Bitte zur Sicherheit das Passwort eingeben.'
  };
  if (code === 'permission-denied') {
    return state.user && !state.user.emailVerified
      ? 'Bitte bestätige zuerst deine E-Mail-Adresse, dann werden deine Daten abgeglichen.'
      : 'Kein Zugriff auf die Daten. Sind die Sicherheitsregeln in Firebase eingetragen?';
  }
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

// ── Anmelden und Konto anlegen ──
// Beides läuft in einem eigenen Fenster (Sheet), das je nach Schritt eine
// andere Ansicht zeigt. state.sheet bestimmt, welche.
window.cloudSignIn = () => withBusy(async (email, password) => {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  state.sheet = cred.user.emailVerified ? null : 'verify';
  if (!state.sheet) closeModal();
});

// Nach dem Anlegen eine Bestätigungsmail: Sie belegt, dass die Adresse
// wirklich dem Nutzer gehört. Sonst könnte jemand die Adresse eines anderen
// besetzen.
window.cloudSignUp = () => withBusy(async (email, password) => {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  state.sheet = 'verify';
  await sendEmailVerification(cred.user);
});

window.cloudCheckVerified = () => withBusy(() => refreshVerification(true));

window.cloudResendVerification = () => withBusy(async () => {
  await sendEmailVerification(auth.currentUser);
  state.notice = 'Mail ist unterwegs. Schau auch im Spam-Ordner nach.';
});

window.cloudResetPassword = () => withBusy(async email => {
  if (!email) throw { message: 'Bitte zuerst deine E-Mail-Adresse eingeben.' };
  await sendPasswordResetEmail(auth, email);
  state.sheet = 'resetSent';
});

window.cloudSignOut = () => {
  if (!confirm('Abmelden?\n\nDeine Daten bleiben auf diesem Gerät, werden aber nicht mehr abgeglichen.')) return;
  stopSync();
  try { localStorage.removeItem(SYNC_KEY); } catch (e) {}
  signOut(auth);
  closeModal();
};

window.cloudDownloadBackup = () => {
  const raw = localStorage.getItem(BACKUP_KEY);
  if (!raw) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
  a.download = 'boulder-stand-vor-anmeldung.json';
  a.click();
};

// ── Konto löschen ──
window.cloudDeleteAccountStart = () => { state.sheet = 'delete'; state.error = ''; renderSheet(); };

window.cloudDeleteAccountConfirm = async () => {
  const user = auth.currentUser;
  const pw = document.getElementById('cloudDelPw')?.value || '';
  const btn = document.getElementById('cloudDelBtn');
  const err = document.getElementById('cloudDelErr');
  if (!user) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Wird gelöscht …'; }
  try {
    // Firebase verlangt für das Löschen eine frische Anmeldung
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, pw));
    stopSync();
    const snap = await getDocs(collection(db, 'users', user.uid, 'data'));
    for (let i = 0; i < snap.docs.length; i += BATCH_LIMIT) {
      const batch = writeBatch(db);
      snap.docs.slice(i, i + BATCH_LIMIT).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    await deleteUser(user);
    try { localStorage.removeItem(SYNC_KEY); } catch (e) {}
    state.sheet = 'deleted';
    renderSheet();
  } catch (e) {
    if (err) err.textContent = describeError(e);
    if (btn) { btn.disabled = false; btn.textContent = 'Endgültig löschen'; }
    if (auth.currentUser && !state.unsubscribe) startSync();
  }
};

// ── Bestätigung automatisch erkennen ──
// Wer den Link in der Mail antippt, landet im Browser und kommt danach zur
// App zurück. Beim Zurückkommen und, solange das Fenster offen ist, alle paar
// Sekunden fragt die App nach – ein "Bestätigt"-Knopf ist nicht mehr nötig.
let verifyTimer = null;
function watchVerification() {
  const waiting = state.user && !state.user.emailVerified && sheetOpen() && state.sheet === 'verify';
  if (waiting && !verifyTimer) {
    verifyTimer = setInterval(() => {
      if (!(state.user && !state.user.emailVerified && sheetOpen() && state.sheet === 'verify')) {
        clearInterval(verifyTimer); verifyTimer = null; return;
      }
      if (navigator.onLine) refreshVerification(false).catch(() => {});
    }, 4000);
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user && !state.user.emailVerified && navigator.onLine) {
    refreshVerification(false).catch(() => {});
  }
});

// ── Link aus der Mail (eigene Seite statt der von Firebase) ──
// In Firebase unter Authentication → Vorlagen → Aktions-URL steht die Adresse
// der App. Der Link öffnet sie dann mit ?mode=…&oobCode=…, und die App erledigt
// die Bestätigung selbst – im eigenen Design und auf Deutsch.
const ACTION = (() => {
  const p = new URLSearchParams(location.search);
  return p.get('mode') && p.get('oobCode') ? { mode: p.get('mode'), code: p.get('oobCode') } : null;
})();

function actionScreen(html) {
  let el = document.getElementById('actionScreen');
  if (!el) {
    el = document.createElement('div');
    el.id = 'actionScreen';
    el.className = 'action-screen';
    document.body.appendChild(el);
  }
  el.innerHTML = `<div class="action-card"><div class="action-logo">⬟ BOULDER</div>${html}</div>`;
}

function appHome() {
  return location.pathname + (EMULATOR ? '?emulator' : '');
}

const ICON_OK = '<div class="action-icon ok"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>';
const ICON_FAIL = '<div class="action-icon fail"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg></div>';

async function handleAction({ mode, code }) {
  history.replaceState(null, '', appHome());
  const back = `<a class="btn btn-primary btn-full" href="${appHome()}">Zur App</a>`;
  const failed = text => actionScreen(`${ICON_FAIL}<h1>Das hat nicht geklappt</h1><p>${text}</p>${back}`);
  actionScreen('<div class="action-spin"></div><p>Einen Moment …</p>');

  if (mode === 'verifyEmail') {
    try {
      await applyActionCode(auth, code);
      if (auth.currentUser) refreshVerification(false).catch(() => {});
      actionScreen(`${ICON_OK}<h1>E-Mail bestätigt</h1>
        <p>Dein Konto ist bereit. Wechsle zurück zur Boulder-App – die Synchronisation startet dort von selbst.</p>
        <p class="action-small">Dieses Fenster kannst du schließen.</p>${back}`);
    } catch (e) {
      failed('Der Link ist abgelaufen oder wurde schon benutzt. In der App unter Einstellungen → Konto kannst du dir eine neue Mail schicken.');
    }
    return;
  }

  if (mode === 'resetPassword') {
    let email;
    try { email = await verifyPasswordResetCode(auth, code); }
    catch (e) { return failed('Der Link ist abgelaufen oder wurde schon benutzt. Fordere in der App einen neuen an.'); }
    actionScreen(`<h1>Neues Passwort</h1>
      <p>für ${esc(email)}</p>
      <div class="field" style="text-align:left"><input type="password" id="newPw" placeholder="Mindestens 6 Zeichen" autocomplete="new-password"></div>
      <div id="newPwErr" class="sheet-error"></div>
      <button class="btn btn-primary btn-full" id="newPwBtn">Passwort speichern</button>`);
    document.getElementById('newPwBtn').onclick = async () => {
      const pw = document.getElementById('newPw').value;
      try {
        await confirmPasswordReset(auth, code, pw);
        actionScreen(`${ICON_OK}<h1>Passwort geändert</h1><p>Melde dich in der App mit deinem neuen Passwort an.</p>${back}`);
      } catch (e) {
        document.getElementById('newPwErr').textContent = describeError(e);
      }
    };
    return;
  }

  failed('Dieser Link wird von der App nicht unterstützt.');
}
if (ACTION) handleAction(ACTION);

// ── Anzeige ──
function statusText() {
  const zeit = state.lastSync
    ? state.lastSync.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
  switch (state.status) {
    case 'connecting': return { text: 'Verbinde …', color: 'var(--text-muted)' };
    case 'offline': return { text: 'Offline – wird abgeglichen, sobald Netz da ist', color: 'var(--blue)' };
    case 'pending': return { text: 'Wird übertragen …', color: 'var(--text-muted)' };
    case 'synced': return { text: 'Synchronisiert' + (zeit ? ' · ' + zeit : ''), color: 'var(--green-dark)' };
    case 'error': return { text: state.error, color: 'var(--red)' };
    default: return { text: '', color: 'var(--text-muted)' };
  }
}

const ICON_USER = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>';

// Die Konto-Zeile in den Einstellungen
function renderCloudBox() {
  const box = document.getElementById('cloudBox');
  if (box) {
    const u = state.user;
    if (!u) {
      box.innerHTML = `
        <div class="list-row" onclick="openAccountSheet('signin')">
          <div class="avatar">${ICON_USER}</div>
          <div class="list-main">
            <div class="list-title">Anmelden</div>
            <div class="list-sub">Deine Daten auf allen Geräten</div>
          </div>
          <span class="chev">›</span>
        </div>`;
    } else {
      const s = statusText();
      const sub = u.emailVerified
        ? `<span class="dot" style="background:${s.color}"></span>${esc(s.text)}`
        : `<span style="color:var(--accent)">E-Mail noch nicht bestätigt</span>`;
      box.innerHTML = `
        <div class="list-row" onclick="openAccountSheet('${u.emailVerified ? 'account' : 'verify'}')">
          <div class="avatar filled">${esc((u.email || '?')[0].toUpperCase())}</div>
          <div class="list-main">
            <div class="list-title" style="overflow:hidden;text-overflow:ellipsis">${esc(u.email || '')}</div>
            <div class="list-sub">${sub}</div>
          </div>
          <span class="chev">›</span>
        </div>`;
    }
  }
  renderSheet();
  watchVerification();
}
window.renderCloudBox = renderCloudBox;

function sheetOpen() {
  return !!document.getElementById('accountSheet') &&
    document.getElementById('modalOverlay').classList.contains('open');
}

window.openAccountSheet = view => {
  state.sheet = view;
  state.error = state.status === 'error' ? state.error : '';
  state.notice = '';
  openModal('<div id="accountSheet"></div>');
  renderCloudBox();
};

window.cloudSwitchSheet = view => {
  state.formEmail = (document.getElementById('cloudEmail')?.value || state.formEmail || '').trim();
  state.sheet = view;
  state.error = '';
  renderSheet();
};

window.cloudTogglePw = () => {
  state.showPw = !state.showPw;
  const input = document.getElementById('cloudPassword');
  if (input) input.type = state.showPw ? 'text' : 'password';
  const btn = document.getElementById('cloudPwToggle');
  if (btn) btn.textContent = state.showPw ? 'Verbergen' : 'Zeigen';
};

function renderSheet() {
  const el = document.getElementById('accountSheet');
  if (!el) return;
  const u = state.user;
  let view = state.sheet;
  // Der Stand kann sich unter dem offenen Fenster ändern (Bestätigung kam an,
  // anderes Gerät hat abgemeldet). Dann die passende Ansicht zeigen.
  if (u && (view === 'signin' || view === 'signup')) view = u.emailVerified ? 'account' : 'verify';
  if (u && u.emailVerified && view === 'verify') view = 'verified';
  if (!u && (view === 'account' || view === 'verify' || view === 'delete')) view = 'signin';
  state.sheet = view;

  const busy = state.busy ? 'disabled' : '';
  const error = state.error && state.status !== 'synced'
    ? `<div class="sheet-error">${esc(state.error)}</div>` : '';
  const notice = state.notice ? `<div class="sheet-notice">${esc(state.notice)}</div>` : '';

  if (view === 'signin' || view === 'signup') {
    const up = view === 'signup';
    el.innerHTML = `
      <div class="sheet-head">
        <div class="sheet-title">${up ? 'Konto erstellen' : 'Willkommen zurück'}</div>
        <div class="sheet-text">${up
          ? 'Mit einem Konto sind deine Trainingsdaten auf all deinen Geräten – und sicher, falls das Handy verloren geht.'
          : 'Melde dich an, um deine Daten auf diesem Gerät abzugleichen.'}</div>
      </div>
      <div class="seg" style="margin-bottom:16px">
        <button type="button" class="${up ? '' : 'on'}" onclick="cloudSwitchSheet('signin')">Anmelden</button>
        <button type="button" class="${up ? 'on' : ''}" onclick="cloudSwitchSheet('signup')">Registrieren</button>
      </div>
      <div class="field"><label>E-Mail</label>
        <input type="email" id="cloudEmail" autocomplete="username" autocapitalize="off" inputmode="email"
          value="${esc(state.formEmail || '')}" placeholder="name@beispiel.de"></div>
      <div class="field"><label>Passwort</label>
        <div class="pw-wrap">
          <input type="${state.showPw ? 'text' : 'password'}" id="cloudPassword"
            autocomplete="${up ? 'new-password' : 'current-password'}" placeholder="${up ? 'Mindestens 6 Zeichen' : ''}"
            onkeydown="if(event.key==='Enter')${up ? 'cloudSignUp' : 'cloudSignIn'}()">
          <button type="button" class="pw-toggle" id="cloudPwToggle" onclick="cloudTogglePw()">${state.showPw ? 'Verbergen' : 'Zeigen'}</button>
        </div>
      </div>
      ${error}
      <button class="btn btn-primary btn-full" onclick="${up ? 'cloudSignUp' : 'cloudSignIn'}()" ${busy}>
        ${state.busy ? 'Einen Moment …' : up ? 'Konto erstellen' : 'Anmelden'}</button>
      ${up
        ? `<div class="sheet-small">Wir schicken dir eine Mail, um deine Adresse zu bestätigen. Deine Daten auf diesem Gerät bleiben erhalten und werden mitgenommen.</div>`
        : `<button class="btn-link" onclick="cloudResetPassword()" ${busy}>Passwort vergessen?</button>`}`;
    return;
  }

  if (view === 'verify') {
    el.innerHTML = `
      <div class="sheet-hero">
        <div class="action-icon mail"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg></div>
        <div class="sheet-title">Bestätige deine E-Mail</div>
        <div class="sheet-text">Wir haben eine Mail an <strong>${esc(u.email || '')}</strong> geschickt. Tippe auf den Link darin – danach geht es hier von selbst weiter.</div>
        <div class="waiting"><span class="action-spin small"></span>Warte auf Bestätigung …</div>
      </div>
      ${notice}${state.error && state.status !== 'error' ? error : ''}
      <button class="btn btn-ghost btn-full" onclick="cloudResendVerification()" ${busy}>Mail erneut senden</button>
      <div class="sheet-small">Keine Mail? Schau im Spam-Ordner nach. Absender ist noreply@boulder-training.firebaseapp.com.</div>
      <button class="btn-link" onclick="closeModal()">Später</button>`;
    return;
  }

  if (view === 'verified') {
    el.innerHTML = `
      <div class="sheet-hero">
        ${ICON_OK}
        <div class="sheet-title">Alles bereit</div>
        <div class="sheet-text">Deine E-Mail ist bestätigt. Deine Daten werden ab jetzt auf all deinen Geräten abgeglichen.</div>
      </div>
      <button class="btn btn-primary btn-full" onclick="closeModal()">Fertig</button>`;
    return;
  }

  if (view === 'resetSent') {
    el.innerHTML = `
      <div class="sheet-hero">
        <div class="action-icon mail"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg></div>
        <div class="sheet-title">Mail ist unterwegs</div>
        <div class="sheet-text">Über den Link in der Mail an <strong>${esc(state.formEmail || '')}</strong> legst du ein neues Passwort fest. Danach meldest du dich hier damit an.</div>
      </div>
      <button class="btn btn-primary btn-full" onclick="cloudSwitchSheet('signin')">Zur Anmeldung</button>`;
    return;
  }

  if (view === 'delete') {
    el.innerHTML = `
      <div class="sheet-head">
        <div class="sheet-title">Konto löschen</div>
        <div class="sheet-text">Dein Konto und alle deine Daten in der Cloud werden endgültig gelöscht. Auf diesem Gerät bleiben sie erhalten, andere Geräte gleichen nicht mehr ab.</div>
      </div>
      <div class="field"><label>Passwort zur Bestätigung</label>
        <input type="password" id="cloudDelPw" autocomplete="current-password"></div>
      <div id="cloudDelErr" class="sheet-error"></div>
      <button class="btn btn-danger btn-full" id="cloudDelBtn" onclick="cloudDeleteAccountConfirm()">Endgültig löschen</button>
      <button class="btn-link" onclick="cloudSwitchSheet('account')">Abbrechen</button>`;
    return;
  }

  if (view === 'deleted') {
    el.innerHTML = `
      <div class="sheet-hero">
        ${ICON_OK}
        <div class="sheet-title">Konto gelöscht</div>
        <div class="sheet-text">Dein Konto und alle Daten in der Cloud sind gelöscht. Auf diesem Gerät bleiben deine Daten erhalten.</div>
      </div>
      <button class="btn btn-primary btn-full" onclick="closeModal()">Fertig</button>`;
    return;
  }

  // account
  const s = statusText();
  const backup = localStorage.getItem(BACKUP_KEY);
  el.innerHTML = `
    <div class="sheet-hero" style="padding-top:4px">
      <div class="avatar filled big">${esc((u.email || '?')[0].toUpperCase())}</div>
      <div class="sheet-title" style="font-size:16px;word-break:break-all">${esc(u.email || '')}</div>
      <div class="sheet-text sheet-status"><span class="dot" style="background:${s.color}"></span>${esc(s.text)}</div>
    </div>
    <div class="list-group">
      ${backup ? `<div class="list-row" onclick="cloudDownloadBackup()">
        <div class="list-main"><div class="list-title">Stand vor der Anmeldung</div><div class="list-sub">Als Datei sichern</div></div>
        <span class="chev">›</span></div>` : ''}
      <div class="list-row" onclick="cloudSignOut()">
        <div class="list-main"><div class="list-title">Abmelden</div></div>
      </div>
      <div class="list-row" onclick="cloudDeleteAccountStart()">
        <div class="list-main"><div class="list-title" style="color:var(--red)">Konto löschen</div></div>
      </div>
    </div>
    <button class="btn btn-ghost btn-full" style="margin-top:14px" onclick="closeModal()">Fertig</button>`;
}

if (EMULATOR) window.__cloud = { auth, db, state, doc, collection, onSnapshot, getDocs, writeBatch };
renderCloudBox();
