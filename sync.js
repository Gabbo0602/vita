// Vita – sincronizzazione con Firebase (account personale, dati privati per utente)
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
         sendPasswordResetEmail, signOut, setPersistence, indexedDBLocalPersistence }
  from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, doc, setDoc, onSnapshot, collection, deleteDoc }
  from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
setPersistence(auth, indexedDBLocalPersistence).catch(() => {});
let db;
try { db = initializeFirestore(app, { localCache: persistentLocalCache() }); }
catch (e) { db = initializeFirestore(app, {}); }

const C = window.Cloud;
let unsub = [], mainRef = null, jRef = null, mRef = null, timer = null, queue = Promise.resolve(), first = { m: false, j: false };

function clean(o) { return JSON.parse(JSON.stringify(o)); }

function push(what) {
  if (!mainRef) return;
  clearTimeout(timer);
  C.status("Salvataggio…");
  timer = setTimeout(() => {
    const st = C.getState();
    const { journal, notified, accounts, txs, ...main } = st;
    const doJ = what.j;
    what.j = false;
    queue = queue.then(async () => {
      try {
        await setDoc(mainRef, clean({ ...main, updatedAt: Date.now() }));
        if (doJ) await setDoc(jRef, clean({ entries: journal || {}, updatedAt: Date.now() }));
        await setDoc(mRef, clean({ accounts: accounts || [], txs: txs || [], updatedAt: Date.now() }));
        C.status(navigator.onLine ? "✓ Sincronizzato" : "Offline: si sincronizza appena torni online");
      } catch (e) {
        C.status("Errore di sincronizzazione: " + (e.code || e.message));
      }
    });
  }, 600);
}
const pending = { j: false };
C.push = (journalChanged) => { if (journalChanged) pending.j = true; push(pending); };

C.signIn = (email, pw) => signInWithEmailAndPassword(auth, email, pw);
C.signUp = (email, pw) => createUserWithEmailAndPassword(auth, email, pw);
C.reset = (email) => sendPasswordResetEmail(auth, email);
C.signOut = () => signOut(auth);

// --- casella postale: Claude deposita qui, Vita smista e cancella ---
let inboxUnsub = null, inboxToken = null;
function startInbox() {
  const tok = C.getState().settings && C.getState().settings.inboxToken;
  if (!tok || tok === inboxToken || !mainRef) return;
  if (inboxUnsub) inboxUnsub();
  inboxToken = tok;
  inboxUnsub = onSnapshot(collection(db, "inbox", tok, "items"), (qs) => {
    qs.docChanges().forEach(async (ch) => {
      if (ch.type !== "added") return;
      const d = ch.doc.data();
      try { if (d && d.code) C.applyInbox(d.code); } catch (e) {}
      try { await deleteDoc(ch.doc.ref); } catch (e) {}
    });
  }, () => {});
}
C.startInbox = startInbox;

onAuthStateChanged(auth, (user) => {
  unsub.forEach(u => u()); unsub = [];
  if (inboxUnsub) { inboxUnsub(); inboxUnsub = null; inboxToken = null; }
  mainRef = jRef = mRef = null;
  C.user = user ? { email: user.email, uid: user.uid } : null;
  if (!user) { C.status("Non collegato"); C.onUser(); return; }
  C.status("Collegamento…");
  mainRef = doc(db, "users", user.uid, "vita", "main");
  jRef = doc(db, "users", user.uid, "vita", "diario");
  mRef = doc(db, "users", user.uid, "vita", "soldi");
  first = { m: false, j: false };
  let lastMain = null;
  unsub.push(onSnapshot(mainRef, { includeMetadataChanges: true }, (snap) => {
    C.status(snap.metadata.fromCache ? "Offline: si sincronizza appena torni online" : "✓ Sincronizzato");
    if (snap.metadata.hasPendingWrites) return;               // è una nostra modifica
    if (!snap.exists()) {
      if (!first.m && !snap.metadata.fromCache) { first.m = true; C.ensureToken(); pending.j = true; push(pending); setTimeout(startInbox, 1500); } // primo accesso: carica i dati del telefono
      return;
    }
    first.m = true;
    const d = snap.data(), sig = d.updatedAt;
    if (sig && sig === lastMain) return;                      // solo cambio di stato rete, dati uguali
    lastMain = sig;
    C.applyRemote(d, null);
    C.ensureToken(); startInbox();
  }, (e) => C.status("Errore: " + e.code)));
  unsub.push(onSnapshot(jRef, (snap) => {
    if (snap.metadata.hasPendingWrites || !snap.exists()) return;
    C.applyRemote(null, snap.data().entries || {});
  }, () => {}));
  unsub.push(onSnapshot(mRef, (snap) => {
    if (snap.metadata.hasPendingWrites || !snap.exists()) return;
    C.applyRemote(null, null, snap.data());
  }, () => {}));
  C.onUser();
});
addEventListener("online", () => mainRef && C.status("✓ Online"));
C.ready = true;
C.onUser();
