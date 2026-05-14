// Optional cloud-sync layer for Journal Taj.
//
// Loads Firebase from the CDN. If that fails (e.g. you're offline), the app
// keeps working entirely locally via app.js + IndexedDB — sync just stays off.
// Only the text of each entry syncs; photos/videos remain on the device.

const firebaseConfig = {
  apiKey: "AIzaSyCsqtjFN-1gdg62_RqNlnecwbpNLeo_b1g",
  authDomain: "journal-taj.firebaseapp.com",
  projectId: "journal-taj",
  storageBucket: "journal-taj.firebasestorage.app",
  messagingSenderId: "480365676982",
  appId: "1:480365676982:web:63bf81526f9ad61f919917",
};

const SDK = "https://www.gstatic.com/firebasejs/10.12.2";
const authBtn = document.getElementById("authBtn");
let currentUser = null;

function setAuthLabel(text) {
  if (authBtn) authBtn.textContent = text;
}

(async function initSync() {
  let fb;
  try {
    const [appMod, authMod, fsMod] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`),
    ]);
    fb = { ...appMod, ...authMod, ...fsMod };
  } catch (e) {
    console.warn("Cloud sync unavailable (offline?). Running local-only.", e);
    setAuthLabel("⚠ Offline");
    return; // app.js still works fully on its own
  }

  const {
    initializeApp,
    getAuth, GoogleAuthProvider, signInWithRedirect, getRedirectResult,
    onAuthStateChanged, signOut,
    getFirestore, collection, doc, setDoc, getDocs,
  } = fb;

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const provider = new GoogleAuthProvider();

  const entryRef = (uid, id) => doc(db, "users", uid, "entries", id);

  // Push one entry's text fields to the cloud (attachments stay on-device).
  async function pushEntry(uid, entry) {
    await setDoc(entryRef(uid, entry.id), {
      title: entry.title || "",
      date: entry.date || "",
      mood: entry.mood ?? null,
      body: entry.body || "",
      updated: entry.updated || Date.now(),
      deleted: !!entry.deleted,
    });
  }

  // Two-way merge between the cloud and local IndexedDB — newest `updated` wins.
  async function pullAndMerge(uid) {
    const snap = await getDocs(collection(db, "users", uid, "entries"));
    const cloudById = new Map();
    snap.forEach((d) => cloudById.set(d.id, d.data()));

    const local = await window.JournalApp.getAllEntries();
    const localById = new Map(local.map((e) => [e.id, e]));

    // cloud -> local: pull anything newer or missing locally
    for (const [id, cloud] of cloudById) {
      const loc = localById.get(id);
      if (!loc || (cloud.updated || 0) > (loc.updated || 0)) {
        const merged = {
          id,
          title: cloud.title || "",
          date: cloud.date || "",
          mood: cloud.mood ?? null,
          body: cloud.body || "",
          updated: cloud.updated || 0,
          deleted: !!cloud.deleted,
          attachments: loc ? loc.attachments || [] : [], // keep local media
        };
        await window.JournalApp.putEntry(merged);
        localById.set(id, merged);
      }
    }

    // local -> cloud: push anything newer or missing in the cloud
    for (const [id, loc] of localById) {
      const cloud = cloudById.get(id);
      if (!cloud || (loc.updated || 0) > (cloud.updated || 0)) {
        await pushEntry(uid, loc);
      }
    }

    await window.JournalApp.reload();
  }

  // When the user saves/deletes locally, mirror that change to the cloud.
  window.JournalApp.onLocalChange = async (entry) => {
    if (!currentUser) return;
    try {
      await pushEntry(currentUser.uid, entry);
    } catch (e) {
      console.warn("Cloud push failed (will re-sync on next launch):", e);
    }
  };

  // Complete a redirect-based sign-in, if one is in progress.
  getRedirectResult(auth).catch((e) => console.warn("Redirect sign-in error:", e));

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
      const first = user.displayName ? user.displayName.split(" ")[0] : "Synced";
      setAuthLabel("☁ " + first);
      try {
        await pullAndMerge(user.uid);
      } catch (e) {
        console.error("Sync failed:", e);
      }
    } else {
      setAuthLabel("Sign in");
    }
  });

  if (authBtn) {
    authBtn.addEventListener("click", () => {
      if (currentUser) {
        if (confirm("Sign out? Your entries stay on this device.")) signOut(auth);
      } else {
        signInWithRedirect(auth, provider);
      }
    });
  }
})();
