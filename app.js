"use strict";

const STORAGE_KEY = "ct_entries";
const API_URL = "/.netlify/functions/analyze";

// ---------------- Utilitare dată ----------------
// Data locală în format YYYY-MM-DD. Cheia după care grupăm mesele pe zile.
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function prettyDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}
function prettyTime(ts) {
  return new Date(ts).toLocaleTimeString("ro-RO", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

// ---------------- Stocare (localStorage = pe telefon) ----------------
function loadEntries() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}
function saveEntries(entries) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}
function addEntry(entry) {
  const entries = loadEntries();
  entries.push(entry);
  saveEntries(entries);
}
function deleteEntry(id) {
  saveEntries(loadEntries().filter((e) => e.id !== id));
  renderStats();
}

// ---------------- Imagini ----------------
// Redimensionează poza la max `maxSize` px pe latura lungă și întoarce un data URL JPEG.
// Folosim o versiune mică (~1024) pentru trimis la model și una foarte mică (~320) pentru stocare.
function fileToScaledDataUrl(file, maxSize, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, maxSize / Math.max(width, height));
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// ---------------- Elemente DOM ----------------
const el = {
  headerTitle: document.getElementById("header-title"),
  headerDate: document.getElementById("header-date"),
  photoInput: document.getElementById("photo-input"),
  previewCard: document.getElementById("preview-card"),
  previewImg: document.getElementById("preview-img"),
  status: document.getElementById("analyze-status"),
  result: document.getElementById("result"),
  actions: document.getElementById("result-actions"),
  saveBtn: document.getElementById("save-btn"),
  discardBtn: document.getElementById("discard-btn"),
  totals: document.getElementById("totals"),
  entries: document.getElementById("entries"),
  viewHome: document.getElementById("view-home"),
  viewStats: document.getElementById("view-stats")
};

// Rezultatul curent, în așteptare până apeși "Adaugă" sau "Renunță".
let pending = null; // { thumb, result }

// ---------------- Flux poză -> analiză ----------------
el.photoInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  resetPreview();
  el.previewCard.classList.remove("hidden");
  el.status.textContent = "Pregătesc poza...";

  try {
    const sendUrl = await fileToScaledDataUrl(file, 1024, 0.85);
    const thumbUrl = await fileToScaledDataUrl(file, 320, 0.7);
    el.previewImg.src = thumbUrl;
    el.status.textContent = "Analizez poza... (poate dura câteva secunde)";

    const base64 = sendUrl.split(",")[1];
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_base64: base64, media_type: "image/jpeg" })
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || "HTTP " + res.status);
    }

    pending = { thumb: thumbUrl, result: data };
    showResult(data);
  } catch (err) {
    el.status.textContent = "Eroare: " + err.message + ". Încearcă din nou.";
  } finally {
    // Golește input-ul ca să poți re-selecta aceeași poză.
    el.photoInput.value = "";
  }
});

function resetPreview() {
  pending = null;
  el.result.classList.add("hidden");
  el.actions.classList.add("hidden");
  el.result.innerHTML = "";
}

function showResult(d) {
  el.status.textContent = "";
  el.result.innerHTML = `
    <h2>${escapeHtml(d.food_name)}</h2>
    <div class="kcal">${d.calories} kcal</div>
    <div class="macros">
      <div class="macro"><div class="val">${d.protein_g}g</div><div class="lbl">Proteine</div></div>
      <div class="macro"><div class="val">${d.carbs_g}g</div><div class="lbl">Carbo</div></div>
      <div class="macro"><div class="val">${d.fat_g}g</div><div class="lbl">Grăsimi</div></div>
    </div>
    <div class="meta">Porție estimată: ~${d.grams}g · încredere: ${escapeHtml(d.confidence)}</div>
  `;
  el.result.classList.remove("hidden");
  el.actions.classList.remove("hidden");
}

el.saveBtn.addEventListener("click", () => {
  if (!pending) return;
  const r = pending.result;
  addEntry({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    date: todayStr(),
    ts: Date.now(),
    thumb: pending.thumb,
    food_name: r.food_name,
    grams: r.grams,
    calories: r.calories,
    protein_g: r.protein_g,
    carbs_g: r.carbs_g,
    fat_g: r.fat_g
  });
  resetPreview();
  el.previewCard.classList.add("hidden");
  switchView("stats");
});

el.discardBtn.addEventListener("click", () => {
  resetPreview();
  el.previewCard.classList.add("hidden");
});

// ---------------- Statistici (ziua de azi) ----------------
function renderStats() {
  const today = todayStr();
  const items = loadEntries()
    .filter((e) => e.date === today)
    .sort((a, b) => a.ts - b.ts);

  const sum = items.reduce(
    (acc, e) => {
      acc.calories += e.calories;
      acc.protein_g += e.protein_g;
      acc.carbs_g += e.carbs_g;
      acc.fat_g += e.fat_g;
      return acc;
    },
    { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }
  );

  el.totals.innerHTML = `
    <div class="total-kcal">${sum.calories} kcal</div>
    <div class="total-lbl">Total azi · ${items.length} ${items.length === 1 ? "masă" : "mese"}</div>
    <div class="total-macros">
      <div class="macro"><div class="val">${sum.protein_g}g</div><div class="lbl">Proteine</div></div>
      <div class="macro"><div class="val">${sum.carbs_g}g</div><div class="lbl">Carbo</div></div>
      <div class="macro"><div class="val">${sum.fat_g}g</div><div class="lbl">Grăsimi</div></div>
    </div>
  `;

  if (items.length === 0) {
    el.entries.innerHTML = `<div class="empty">Nicio masă adăugată azi.<br />Fă o poză din tab-ul „Acasă”.</div>`;
    return;
  }

  el.entries.innerHTML = items
    .map(
      (e) => `
    <div class="entry">
      <img src="${e.thumb}" alt="${escapeHtml(e.food_name)}" />
      <div class="info">
        <div class="name">${escapeHtml(e.food_name)}</div>
        <div class="sub">~${e.grams}g · ${e.protein_g}P / ${e.carbs_g}C / ${e.fat_g}G · ${prettyTime(e.ts)}</div>
        <div class="kcal">${e.calories} kcal</div>
      </div>
      <button class="del" data-id="${e.id}" title="Șterge">🗑</button>
    </div>`
    )
    .join("");
}

// Ștergere prin delegare de evenimente.
el.entries.addEventListener("click", (e) => {
  const btn = e.target.closest(".del");
  if (btn) deleteEntry(btn.dataset.id);
});

// ---------------- Navigare între tab-uri ----------------
function switchView(view) {
  const isHome = view === "home";
  el.viewHome.classList.toggle("active", isHome);
  el.viewStats.classList.toggle("active", !isHome);
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.view === view);
  });
  el.headerTitle.textContent = isHome ? "Astăzi" : "Statistici";
  if (!isHome) renderStats();
}
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
});

// ---------------- Helper securitate ----------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------- Init ----------------
el.headerDate.textContent = prettyDate(todayStr());
renderStats();
