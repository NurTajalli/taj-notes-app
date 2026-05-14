// Optional cloud-sync layer for Journal Taj.
//
// Loads Firebase from the CDN. If that fails (e.g. you're offline), the app
// keeps working entirely locally via app.js + IndexedDB — sync just stays off.
// Only the text of each entry syncs; photos/videos remain on the device.
//
// Auth uses email + password (an in-app form) rather than Google sign-in,
// because popups/redirects don't work inside an installed iOS Home Screen app.

const firebaseConfig = {
  apiKey: "AIzaSyCsqtjFN-1gdg62_RqNlnecwbpNLeo_b1g",
  authDomain: "journal-taj.firebaseapp.com",
  projectId: "journal-taj",
  storageBucket: "journal-taj.firebasestorage.app",
  messagingSenderId: "480365676982",
  appId: "1:480365676982:web:63bf81526f9ad61f919917",
};

const SDK = "https://www.gstatic.com/firebasejs/10.12.2";

// --- UI elements ---
const authBtn = document.getElementById("authBtn");
const authModal = document.getElementById("authModal");
const authEmail = document.getElementById("authEmail");
const authPass = document.getElementById("authPass");
const authError = document.getElementById("authError");

let currentUser = null;

function setAuthLabel(text) {
  if (authBtn) authBtn.textContent = text;
}
function showAuthError(msg) {
  authError.textContent = msg || "";
  authError.hidden = !msg;
}
function openAuthModal() {
  showAuthError("");
  authModal.hidden = false;
  authEmail.focus();
}
function closeAuthModal() {
  authModal.hidden = true;
  authPass.value = "";
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
    getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword,
    onAuthStateChanged, signOut,
    getFirestore, collection, doc, setDoc, getDocs,
  } = fb;

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);

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

  // Turn a Firebase auth error into a plain-language message.
  function friendlyError(e) {
    const code = e.code || "";
    if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found"].includes(code))
      return "Wrong email or password. New here? Tap Create account.";
    if (code === "auth/email-already-in-use")
      return "That email already has an account — tap Sign in instead.";
    if (code === "auth/invalid-email") return "That doesn't look like a valid email.";
    if (code === "auth/weak-password") return "Password must be at least 6 characters.";
    if (code === "auth/network-request-failed") return "No internet connection.";
    if (code === "auth/operation-not-allowed")
      return "Email sign-in isn't enabled in the Firebase console yet.";
    return (code || "Error") + ": " + (e.message || "");
  }

  async function doSignIn() {
    const email = authEmail.value.trim();
    const pass = authPass.value;
    if (!email || !pass) return showAuthError("Enter your email and password.");
    try {
      await signInWithEmailAndPassword(auth, email, pass);
      closeAuthModal();
    } catch (e) {
      console.error("Sign-in error:", e);
      showAuthError(friendlyError(e));
    }
  }

  async function doCreate() {
    const email = authEmail.value.trim();
    const pass = authPass.value;
    if (!email || !pass) return showAuthError("Enter your email and password.");
    if (pass.length < 6) return showAuthError("Password must be at least 6 characters.");
    try {
      await createUserWithEmailAndPassword(auth, email, pass);
      closeAuthModal();
    } catch (e) {
      console.error("Create-account error:", e);
      showAuthError(friendlyError(e));
    }
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

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
      const name = user.email ? user.email.split("@")[0] : "Synced";
      setAuthLabel("☁ " + name);
      try {
        await pullAndMerge(user.uid);
      } catch (e) {
        console.error("Sync failed:", e);
        alert("Signed in, but sync failed:\n" + (e.code || "") + "\n" + (e.message || ""));
      }
    } else {
      setAuthLabel("Sign in");
    }
  });

  // Wire up the auth button + modal.
  if (authBtn) {
    authBtn.addEventListener("click", async () => {
      if (currentUser) {
        if (
          confirm(
            "Sign out and clear this device?\n\n" +
              "Synced text entries will come back when you sign in again. " +
              "Photos/videos aren't synced and will be permanently deleted."
          )
        ) {
          await signOut(auth);
          await window.JournalApp.clearAll();
        }
      } else {
        openAuthModal();
      }
    });
  }
  document.getElementById("authSignIn").addEventListener("click", doSignIn);
  document.getElementById("authCreate").addEventListener("click", doCreate);
  document.getElementById("authCancel").addEventListener("click", closeAuthModal);
})();
