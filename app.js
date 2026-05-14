// --- Storage layer (device-only, via localStorage) ---
const STORAGE_KEY = "notes.v1";

function loadNotes() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveNotes(notes) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
}

// --- State ---
let notes = loadNotes();
let editingId = null; // null while editor is closed; note id or "new" while open

// --- Elements ---
const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const editorEl = document.getElementById("editor");
const titleInput = document.getElementById("titleInput");
const bodyInput = document.getElementById("bodyInput");
const deleteBtn = document.getElementById("deleteBtn");

// --- Render (Read) ---
function render() {
  listEl.innerHTML = "";
  emptyEl.hidden = notes.length > 0;

  notes
    .slice()
    .sort((a, b) => b.updated - a.updated)
    .forEach((note) => {
      const li = document.createElement("li");
      li.className = "note-card";
      li.innerHTML = `
        <h3></h3>
        <p></p>
        <time></time>
      `;
      li.querySelector("h3").textContent = note.title || "Untitled";
      li.querySelector("p").textContent = note.body || "No content";
      li.querySelector("time").textContent = new Date(note.updated).toLocaleString();
      li.addEventListener("click", () => openEditor(note.id));
      listEl.appendChild(li);
    });
}

// --- Editor open/close ---
function openEditor(id) {
  editingId = id;
  const note = notes.find((n) => n.id === id);
  titleInput.value = note ? note.title : "";
  bodyInput.value = note ? note.body : "";
  deleteBtn.hidden = !note; // only show Delete for existing notes
  editorEl.hidden = false;
  titleInput.focus();
}

function closeEditor() {
  editingId = null;
  editorEl.hidden = true;
}

// --- Create / Update ---
function saveCurrent() {
  const title = titleInput.value.trim();
  const body = bodyInput.value.trim();

  if (!title && !body) {
    closeEditor();
    return; // nothing to save
  }

  if (editingId === "new") {
    notes.push({ id: Date.now().toString(), title, body, updated: Date.now() });
  } else {
    const note = notes.find((n) => n.id === editingId);
    note.title = title;
    note.body = body;
    note.updated = Date.now();
  }

  saveNotes(notes);
  render();
  closeEditor();
}

// --- Delete ---
function deleteCurrent() {
  if (editingId === "new") return closeEditor();
  if (!confirm("Delete this note?")) return;
  notes = notes.filter((n) => n.id !== editingId);
  saveNotes(notes);
  render();
  closeEditor();
}

// --- Wire up controls ---
document.getElementById("newBtn").addEventListener("click", () => openEditor("new"));
document.getElementById("cancelBtn").addEventListener("click", closeEditor);
document.getElementById("saveBtn").addEventListener("click", saveCurrent);
deleteBtn.addEventListener("click", deleteCurrent);

render();

// --- Register service worker (offline support) ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
