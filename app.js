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

// --- State ---
let entries = [];
let editingId = null;        // null = closed, "new", or an entry id
let draftAttachments = [];   // attachments in the currently open editor
let objectUrls = [];         // tracked so we can revoke them

// --- Elements ---
const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const editorEl = document.getElementById("editor");
const titleInput = document.getElementById("titleInput");
const bodyInput = document.getElementById("bodyInput");
const attachmentsEl = document.getElementById("attachments");
const fileInput = document.getElementById("fileInput");
const deleteBtn = document.getElementById("deleteBtn");

// --- Render list (Read) ---
function render() {
  listEl.innerHTML = "";
  emptyEl.hidden = entries.length > 0;

  entries
    .slice()
    .sort((a, b) => b.updated - a.updated)
    .forEach((entry) => {
      const count = (entry.attachments || []).length;
      const li = document.createElement("li");
      li.className = "note-card";
      li.innerHTML = `<h3></h3><p></p><time></time>`;
      li.querySelector("h3").textContent = entry.title || "Untitled";
      li.querySelector("p").textContent = entry.body || "No content";
      li.querySelector("time").textContent =
        new Date(entry.updated).toLocaleString() +
        (count ? ` · ${count} attachment${count > 1 ? "s" : ""}` : "");
      li.addEventListener("click", () => openEditor(entry.id));
      listEl.appendChild(li);
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

    const preview = document.createElement("div");
    preview.className = "preview";
    if (att.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = url;
      preview.appendChild(img);
    } else {
      const icon = document.createElement("div");
      icon.className = "file-icon";
      icon.textContent = att.type.startsWith("video/") ? "🎬" : "📄";
      preview.appendChild(icon);
    }
    preview.addEventListener("click", () => window.open(url, "_blank"));

    const name = document.createElement("span");
    name.className = "att-name";
    name.textContent = att.name;

    const remove = document.createElement("button");
    remove.className = "att-remove";
    remove.type = "button";
    remove.textContent = "✕";
    remove.addEventListener("click", () => {
      draftAttachments = draftAttachments.filter((a) => a.id !== att.id);
      renderAttachments();
    });

    item.append(preview, name, remove);
    attachmentsEl.appendChild(item);
  });
}

// --- Editor open/close ---
function openEditor(id) {
  editingId = id;
  const entry = entries.find((e) => e.id === id);
  titleInput.value = entry ? entry.title : "";
  bodyInput.value = entry ? entry.body : "";
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
  clearObjectUrls();
  editorEl.hidden = true;
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
    entry = { id: Date.now().toString(), title, body, updated: Date.now(), attachments: draftAttachments };
  } else {
    entry = entries.find((e) => e.id === editingId);
    entry.title = title;
    entry.body = body;
    entry.updated = Date.now();
    entry.attachments = draftAttachments;
  }

  await putEntry(entry);
  entries = await getAllEntries();
  render();
  closeEditor();
}

// --- Delete ---
async function deleteCurrent() {
  if (editingId === "new") return closeEditor();
  if (!confirm("Delete this entry?")) return;
  await removeEntry(editingId);
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
document.getElementById("newBtn").addEventListener("click", () => openEditor("new"));
document.getElementById("cancelBtn").addEventListener("click", closeEditor);
document.getElementById("saveBtn").addEventListener("click", saveCurrent);
document.getElementById("attachBtn").addEventListener("click", () => fileInput.click());
deleteBtn.addEventListener("click", deleteCurrent);

// --- Boot ---
(async function init() {
  await migrateFromLocalStorage();
  entries = await getAllEntries();
  render();
})();

// --- Register service worker (offline support) ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
