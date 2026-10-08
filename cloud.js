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
  busy: false
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

window.cloudSignIn = () => withBusy((email, password) =>
  signInWithEmailAndPassword(auth, email, password));

// Nach dem Anlegen eine Bestätigungsmail: Sie belegt, dass die Adresse
// wirklich dem Nutzer gehört. Sonst könnte jemand die Adresse eines anderen
// besetzen.
window.cloudSignUp = () => withBusy(async (email, password) => {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await sendEmailVerification(cred.user);
});

window.cloudCheckVerified = () => withBusy(() => refreshVerification(true));

window.cloudResendVerification = () => withBusy(async () => {
  await sendEmailVerification(auth.currentUser);
  alert('Wir haben dir die Bestätigungsmail noch einmal geschickt.');
});

// ── Konto löschen ──
window.cloudDeleteAccountStart = () => {
  openModal(`
    <div class="modal-title">Konto löschen</div>
    <div class="text-muted" style="margin-bottom:14px;line-height:1.5">
      Dein Konto und alle deine Daten in der Cloud werden endgültig gelöscht.
      Auf diesem Gerät bleiben deine Daten erhalten, andere Geräte gleichen
      danach nicht mehr ab.
    </div>
    <div class="field"><label>Passwort zur Bestätigung</label>
      <input type="password" id="cloudDelPw" autocomplete="current-password"></div>
    <div id="cloudDelErr" style="font-size:12px;color:var(--red);margin-bottom:10px"></div>
    <div class="row">
      <button class="btn btn-ghost" onclick="closeModal()">Abbrechen</button>
      <button class="btn btn-danger" id="cloudDelBtn" onclick="cloudDeleteAccountConfirm()">Endgültig löschen</button>
    </div>`);
};

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
    closeModal();
    alert('Dein Konto und alle Daten in der Cloud sind gelöscht. Auf diesem Gerät bleiben deine Daten erhalten.');
  } catch (e) {
    if (err) err.textContent = describeError(e);
    if (btn) { btn.disabled = false; btn.textContent = 'Endgültig löschen'; }
    if (auth.currentUser && !state.unsubscribe) startSync();
  }
};

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
      ${state.user.emailVerified ? '' : `
        <div style="font-size:12px;line-height:1.5;padding:10px 12px;margin-bottom:12px;border-radius:var(--radius-sm);
                    background:var(--accent-dim);border:1px solid var(--accent)">
          Bitte bestätige deine E-Mail-Adresse über den Link in der Mail, die wir dir geschickt haben.
          Danach hier „Bestätigt" tippen.
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" onclick="cloudCheckVerified()" ${state.busy ? 'disabled' : ''}>Bestätigt</button>
            <button class="btn btn-ghost btn-sm" onclick="cloudResendVerification()" ${state.busy ? 'disabled' : ''}>Mail erneut senden</button>
          </div>
        </div>`}
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" onclick="cloudSignOut()">Abmelden</button>
        ${backup ? `<button class="btn btn-ghost btn-sm" onclick="cloudDownloadBackup()">Stand vor der Anmeldung sichern</button>` : ''}
      </div>
      <button class="btn btn-ghost btn-full mt-8" style="font-size:12px;border:none;background:none;color:var(--red)"
        onclick="cloudDeleteAccountStart()">Konto löschen</button>
    </div>`;
}
window.renderCloudBox = renderCloudBox;

if (EMULATOR) window.__cloud = { auth, db, state, doc, collection, onSnapshot, getDocs, writeBatch };
renderCloudBox();
