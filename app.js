// --- Storage layer: IndexedDB (holds text + photo/video/file blobs) ---
const DB_NAME = "journal-taj";
const STORE = "entries";
let dbPromise;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function idbRequest(store, makeReq) {
  return new Promise(async (resolve, reject) => {
    const d = await db();
    const os = d.transaction(STORE, store).objectStore(STORE);
    const req = makeReq(os);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const getAllEntries = () => idbRequest("readonly", (os) => os.getAll());
const putEntry = (entry) => idbRequest("readwrite", (os) => os.put(entry));
const removeEntry = (id) => idbRequest("readwrite", (os) => os.delete(id));
const clearAllEntries = () => idbRequest("readwrite", (os) => os.clear());

// One-time migration from the old localStorage version
async function migrateFromLocalStorage() {
  const old = localStorage.getItem("notes.v1");
  if (!old) return;
  try {
    for (const n of JSON.parse(old) || []) {
      await putEntry({ ...n, attachments: n.attachments || [] });
    }
  } catch {}
  localStorage.removeItem("notes.v1");
}

// Backfill `created` (+ `date`) on entries made before timestamps existed
async function ensureCreated() {
  for (const e of entries) {
    if (typeof e.created !== "number" || e.created <= 0) {
      const fromId = Number(e.id);
      e.created =
        Number.isFinite(fromId) && fromId > 1e12 ? fromId : e.updated || Date.now();
      e.date = klDateStr(e.created);
      await putEntry(e);
    }
  }
}

// --- Moods (one per entry) ---
const MOODS = [
  { key: "happy", emoji: "😄", label: "Happy" },
  { key: "sad", emoji: "😢", label: "Sad" },
  { key: "anger", emoji: "😠", label: "Anger" },
  { key: "overwhelm", emoji: "😩", label: "Overwhelmed" },
  { key: "aggrieved", emoji: "😞", label: "Aggrieved" },
];
const moodEmoji = (key) => MOODS.find((m) => m.key === key)?.emoji || "";

// --- Date / time helpers (Kuala Lumpur timezone, 24-hour clock) ---
const TZ = "Asia/Kuala_Lumpur";

function klDateStr(ms) {
  // "YYYY-MM-DD" in Kuala Lumpur time — used for grouping/sorting fallback
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(ms);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function klMonthLabel(ms) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, month: "long", year: "numeric",
  }).format(ms);
}

function klDateTimeLabel(ms) {
  // e.g. "Wed, 14 May 2026, 16:30" — 24-hour, Kuala Lumpur time
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, weekday: "short", day: "numeric", month: "short",
    year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(ms);
}

// --- State ---
let entries = [];
let editingId = null;        // null = closed, "new", or an entry id
let draftAttachments = [];   // attachments in the currently open editor
let draftMood = null;        // mood key in the currently open editor
let draftCreated = null;     // creation timestamp for the entry being edited
let objectUrls = [];         // tracked so we can revoke them

// --- Elements ---
const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const searchInput = document.getElementById("searchInput");
const editorEl = document.getElementById("editor");
const titleInput = document.getElementById("titleInput");
const entryDate = document.getElementById("entryDate");
const moodPicker = document.getElementById("moodPicker");
const bodyInput = document.getElementById("bodyInput");
const attachmentsEl = document.getElementById("attachments");
const fileInput = document.getElementById("fileInput");
const deleteBtn = document.getElementById("deleteBtn");

// --- Render list (Read) — filtered by search, sorted by time, grouped by month ---
function render() {
  const q = searchInput.value.trim().toLowerCase();
  listEl.innerHTML = "";

  let visible = entries.filter((e) => !e.deleted);
  if (q) {
    visible = visible.filter(
      (e) =>
        (e.title || "").toLowerCase().includes(q) ||
        (e.body || "").toLowerCase().includes(q)
    );
  }

  // newest first by creation time
  visible.sort((a, b) => (b.created || 0) - (a.created || 0));

  if (visible.length === 0) {
    emptyEl.hidden = false;
    emptyEl.innerHTML = q
      ? "No entries match your search."
      : 'No entries yet. Tap <strong>+ New</strong> to create one.';
    return;
  }
  emptyEl.hidden = true;

  let currentMonth = null;
  visible.forEach((entry) => {
    const m = klMonthLabel(entry.created);
    if (m !== currentMonth) {
      currentMonth = m;
      const head = document.createElement("li");
      head.className = "month-header";
      head.textContent = m;
      listEl.appendChild(head);
    }

    const count = (entry.attachments || []).length;
    const mood = moodEmoji(entry.mood);
    const li = document.createElement("li");
    li.className = "note-card";
    li.innerHTML = `<h3></h3><p></p><time></time>`;
    li.querySelector("h3").textContent = entry.title || "Untitled";
    li.querySelector("p").textContent = entry.body || "No content";
    li.querySelector("time").textContent =
      (mood ? mood + "  " : "") +
      klDateTimeLabel(entry.created) +
      (count ? ` · ${count} attachment${count > 1 ? "s" : ""}` : "");
    li.addEventListener("click", () => openEditor(entry.id));
    listEl.appendChild(li);
  });
}

// --- Mood picker ---
function buildMoodPicker() {
  moodPicker.innerHTML = "";
  MOODS.forEach((m) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mood-btn";
    btn.dataset.key = m.key;
    btn.textContent = m.emoji;
    btn.title = m.label;
    btn.setAttribute("aria-label", m.label);
    btn.addEventListener("click", () => {
      draftMood = draftMood === m.key ? null : m.key; // tap again to clear
      updateMoodSelection();
    });
    moodPicker.appendChild(btn);
  });
}

function updateMoodSelection() {
  moodPicker.querySelectorAll(".mood-btn").forEach((b) => {
    b.classList.toggle("selected", b.dataset.key === draftMood);
  });
}

// --- Attachment previews inside the editor ---
function clearObjectUrls() {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
}

function renderAttachments() {
  clearObjectUrls();
  attachmentsEl.innerHTML = "";

  draftAttachments.forEach((att) => {
    const url = URL.createObjectURL(att.blob);
    objectUrls.push(url);

    const item = document.createElement("div");
    item.className = "attachment";

    // Remove button — floats in the corner of the attachment
    const remove = document.createElement("button");
    remove.className = "att-remove";
    remove.type = "button";
    remove.textContent = "✕";
    remove.title = "Remove";
    remove.addEventListener("click", () => {
      draftAttachments = draftAttachments.filter((a) => a.id !== att.id);
      renderAttachments();
    });

    if (att.type.startsWith("image/")) {
      // Photo: shown full-width; tap to open full size in a new tab
      const link = document.createElement("a");
      link.className = "att-link";
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      const img = document.createElement("img");
      img.className = "att-media";
      img.src = url;
      img.alt = att.name;
      link.appendChild(img);
      item.append(link, remove);
    } else if (att.type.startsWith("video/")) {
      // Video: inline player, auto-plays muted on a loop; use controls for sound
      const video = document.createElement("video");
      video.className = "att-media";
      video.src = url;
      video.controls = true;
      video.playsInline = true;
      video.muted = true;
      video.autoplay = true;
      video.loop = true;
      item.append(video, remove);
    } else {
      // Any other file: a row that opens the file in a new tab when tapped
      const link = document.createElement("a");
      link.className = "att-file";
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      const icon = document.createElement("span");
      icon.className = "file-icon";
      icon.textContent = "📄";
      const name = document.createElement("span");
      name.className = "att-name";
      name.textContent = att.name;
      link.append(icon, name);
      item.append(link, remove);
    }

    attachmentsEl.appendChild(item);
  });
}

// --- Editor open/close ---
function openEditor(id) {
  editingId = id;
  const entry = entries.find((e) => e.id === id);
  titleInput.value = entry ? entry.title : "";
  // date/time is fixed at creation — shown read-only, never edited
  draftCreated = entry ? entry.created : Date.now();
  entryDate.textContent = klDateTimeLabel(draftCreated);
  bodyInput.value = entry ? entry.body : "";
  draftMood = entry ? entry.mood || null : null;
  updateMoodSelection();
  // copy the array so edits aren't applied until Save
  draftAttachments = entry ? (entry.attachments || []).map((a) => ({ ...a })) : [];
  deleteBtn.hidden = !entry;
  renderAttachments();
  editorEl.hidden = false;
  titleInput.focus();
}

function closeEditor() {
  editingId = null;
  draftAttachments = [];
  draftMood = null;
  draftCreated = null;
  clearObjectUrls();
  editorEl.hidden = true;
}

// Tell the optional cloud-sync module (sync.js) that an entry changed
function notifyChange(entry) {
  if (window.JournalApp && typeof window.JournalApp.onLocalChange === "function") {
    window.JournalApp.onLocalChange(entry);
  }
}

// --- Create / Update ---
async function saveCurrent() {
  const title = titleInput.value.trim();
  const body = bodyInput.value.trim();

  if (!title && !body && draftAttachments.length === 0) {
    closeEditor();
    return; // nothing to save
  }

  let entry;
  if (editingId === "new") {
    // date/time is fixed at creation and can't be edited afterwards
    const created = draftCreated || Date.now();
    entry = {
      id: created.toString(),
      title,
      created,
      date: klDateStr(created),
      mood: draftMood,
      body,
      updated: Date.now(),
      attachments: draftAttachments,
    };
  } else {
    entry = entries.find((e) => e.id === editingId);
    entry.title = title;
    entry.mood = draftMood;
    entry.body = body;
    entry.updated = Date.now();
    entry.attachments = draftAttachments;
    // created / date stay fixed
  }

  await putEntry(entry);
  notifyChange(entry);
  entries = await getAllEntries();
  render();
  closeEditor();
}

// --- Delete ---
async function deleteCurrent() {
  if (editingId === "new") return closeEditor();
  if (!confirm("Delete this entry?")) return;
  // Soft-delete (tombstone) so the deletion can sync to other devices.
  const entry = entries.find((e) => e.id === editingId);
  entry.deleted = true;
  entry.updated = Date.now();
  await putEntry(entry);
  notifyChange(entry);
  entries = await getAllEntries();
  render();
  closeEditor();
}

// --- File picker (photo / video / file) ---
fileInput.addEventListener("change", () => {
  for (const file of fileInput.files) {
    draftAttachments.push({
      id: Date.now().toString() + Math.random().toString(36).slice(2),
      name: file.name,
      type: file.type || "application/octet-stream",
      blob: file, // a File is a Blob — IndexedDB stores it directly
    });
  }
  fileInput.value = ""; // reset so the same file can be picked again
  renderAttachments();
});

// --- Wire up controls ---
buildMoodPicker();
document.getElementById("newBtn").addEventListener("click", () => openEditor("new"));
document.getElementById("cancelBtn").addEventListener("click", closeEditor);
document.getElementById("saveBtn").addEventListener("click", saveCurrent);
document.getElementById("attachBtn").addEventListener("click", () => fileInput.click());
deleteBtn.addEventListener("click", deleteCurrent);
searchInput.addEventListener("input", render);

// --- Ask the browser to keep our data (resist iOS auto-eviction) ---
async function requestPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return;
  try {
    const already = await navigator.storage.persisted();
    if (!already) {
      const granted = await navigator.storage.persist();
      console.log(granted ? "Storage is now persistent." : "Persistent storage not granted.");
    }
  } catch {}
}

// --- Boot ---
(async function init() {
  await requestPersistentStorage();
  await migrateFromLocalStorage();
  entries = await getAllEntries();
  await ensureCreated();
  render();
})();

// --- Expose a small API for the optional cloud-sync module (sync.js) ---
window.JournalApp = {
  getAllEntries,
  putEntry,
  reload: async () => {
    entries = await getAllEntries();
    render();
  },
  clearAll: async () => {
    await clearAllEntries();
    entries = [];
    render();
  },
  onLocalChange: null, // sync.js assigns this to mirror changes to the cloud
};

// --- Register service worker (offline support) ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
