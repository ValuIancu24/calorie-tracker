"use strict";

const STORAGE_KEY = "ct_entries";
const API_URL = "/.netlify/functions/analyze";

// ---------------- Utilitare dată ----------------
// Data locală în format YYYY-MM-DD dintr-un obiect Date. Cheia după care grupăm mesele pe zile.
function dateStrFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayStr() {
  return dateStrFromDate(new Date());
}
// Data (YYYY-MM-DD) a unui timestamp oarecare - ca date și ts să fie mereu de acord.
function dateStrFromTs(ts) {
  return dateStrFromDate(new Date(ts));
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
// Valoare pentru <input type="datetime-local"> pornind de la un Date (ora locală).
function toDatetimeLocal(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
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
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---------------- Imagini ----------------
// Redimensionează poza la max `maxSize` px pe latura lungă și întoarce un data URL JPEG.
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

// Redimensionează + trimite poza la model. Întoarce { thumb, result }.
// `onThumb` e chemat imediat ce miniatura e gata, ca să arătăm poza cât timp se analizează.
async function analyzeFile(file, onThumb) {
  const sendUrl = await fileToScaledDataUrl(file, 1024, 0.85);
  const thumbUrl = await fileToScaledDataUrl(file, 320, 0.7);
  if (onThumb) onThumb(thumbUrl);

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
  return { thumb: thumbUrl, result: data };
}

// ---------------- Elemente DOM ----------------
const el = {
  headerTitle: document.getElementById("header-title"),
  headerDate: document.getElementById("header-date"),
  // acasă
  photoInput: document.getElementById("photo-input"),
  previewCard: document.getElementById("preview-card"),
  previewImg: document.getElementById("preview-img"),
  status: document.getElementById("analyze-status"),
  result: document.getElementById("result"),
  actions: document.getElementById("result-actions"),
  saveBtn: document.getElementById("save-btn"),
  discardBtn: document.getElementById("discard-btn"),
  // statistici
  totals: document.getElementById("totals"),
  entries: document.getElementById("entries"),
  periodModes: document.getElementById("period-modes"),
  periodNav: document.getElementById("period-nav"),
  periodPrev: document.getElementById("period-prev"),
  periodNext: document.getElementById("period-next"),
  periodLabel: document.getElementById("period-label"),
  periodRange: document.getElementById("period-range"),
  rangeStart: document.getElementById("range-start"),
  rangeEnd: document.getElementById("range-end"),
  addManualBtn: document.getElementById("add-manual-btn"),
  // modal adăugare manuală
  manualModal: document.getElementById("manual-modal"),
  manualPhoto: document.getElementById("manual-photo"),
  manualPreview: document.getElementById("manual-preview"),
  manualStatus: document.getElementById("manual-status"),
  manualResult: document.getElementById("manual-result"),
  manualDatetime: document.getElementById("manual-datetime"),
  manualSave: document.getElementById("manual-save"),
  manualCancel: document.getElementById("manual-cancel"),
  // lightbox
  lightbox: document.getElementById("lightbox"),
  lightboxImg: document.getElementById("lightbox-img"),
  // views
  viewHome: document.getElementById("view-home"),
  viewStats: document.getElementById("view-stats")
};

// ---------------- Flux poză -> analiză (Acasă) ----------------
// Rezultatul curent, în așteptare până apeși "Adaugă" sau "Renunță".
let pending = null; // { thumb, result }

el.photoInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  resetPreview();
  el.previewCard.classList.remove("hidden");
  el.status.textContent = "Pregătesc poza...";

  try {
    const { thumb, result } = await analyzeFile(file, (t) => {
      el.previewImg.src = t;
      el.status.textContent = "Analizez poza... (poate dura câteva secunde)";
    });
    pending = { thumb, result };
    showResult(result);
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

// HTML-ul cu rezultatul analizei (folosit și pe Acasă, și în modalul de adăugare manuală).
function resultHtml(d) {
  return `
    <h2>${escapeHtml(d.food_name)}</h2>
    <div class="kcal">${d.calories} kcal</div>
    <div class="macros">
      <div class="macro"><div class="val">${d.protein_g}g</div><div class="lbl">Proteine</div></div>
      <div class="macro"><div class="val">${d.carbs_g}g</div><div class="lbl">Carbo</div></div>
      <div class="macro"><div class="val">${d.fat_g}g</div><div class="lbl">Grăsimi</div></div>
    </div>
    <div class="meta">Porție estimată: ~${d.grams}g · încredere: ${escapeHtml(d.confidence)}</div>
  `;
}

function showResult(d) {
  el.status.textContent = "";
  el.result.innerHTML = resultHtml(d);
  el.result.classList.remove("hidden");
  el.actions.classList.remove("hidden");
}

el.saveBtn.addEventListener("click", () => {
  if (!pending) return;
  const r = pending.result;
  const ts = Date.now();
  addEntry({
    id: newId(),
    date: dateStrFromTs(ts),
    ts,
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
  goToDay(ts); // sari la ziua de azi, unde tocmai am adăugat
  switchView("stats");
});

el.discardBtn.addEventListener("click", () => {
  resetPreview();
  el.previewCard.classList.add("hidden");
});

// ---------------- Adăugare manuală (poză + dată/oră alese) ----------------
// La fel ca pe Acasă (numele + valorile vin de la model), dar cu dată/oră la alegere,
// ca mesele adăugate ulterior să se așeze corect cronologic.
let pendingManual = null; // { thumb, result }

el.addManualBtn.addEventListener("click", openManualModal);
el.manualCancel.addEventListener("click", closeManualModal);
el.manualModal.addEventListener("click", (e) => {
  if (e.target === el.manualModal) closeManualModal(); // click pe fundal = închide
});

function openManualModal() {
  pendingManual = null;
  el.manualPhoto.value = "";
  el.manualPreview.src = "";
  el.manualPreview.classList.add("hidden");
  el.manualResult.innerHTML = "";
  el.manualResult.classList.add("hidden");
  el.manualStatus.textContent = "";
  el.manualDatetime.value = toDatetimeLocal(new Date());
  el.manualSave.disabled = true;
  el.manualModal.classList.remove("hidden");
}
function closeManualModal() {
  el.manualModal.classList.add("hidden");
}

el.manualPhoto.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  pendingManual = null;
  el.manualSave.disabled = true;
  el.manualResult.classList.add("hidden");
  el.manualStatus.textContent = "Analizez poza... (poate dura câteva secunde)";

  try {
    const { thumb, result } = await analyzeFile(file, (t) => {
      el.manualPreview.src = t;
      el.manualPreview.classList.remove("hidden");
    });
    pendingManual = { thumb, result };
    el.manualStatus.textContent = "";
    el.manualResult.innerHTML = resultHtml(result);
    el.manualResult.classList.remove("hidden");
    el.manualSave.disabled = false;
  } catch (err) {
    el.manualStatus.textContent =
      "Eroare: " + err.message + ". Încearcă din nou.";
  } finally {
    el.manualPhoto.value = "";
  }
});

el.manualSave.addEventListener("click", () => {
  if (!pendingManual) return;
  const value = el.manualDatetime.value;
  if (!value) {
    el.manualStatus.textContent = "Alege data și ora.";
    return;
  }
  const ts = new Date(value).getTime();
  const r = pendingManual.result;
  addEntry({
    id: newId(),
    date: dateStrFromTs(ts),
    ts,
    thumb: pendingManual.thumb,
    food_name: r.food_name,
    grams: r.grams,
    calories: r.calories,
    protein_g: r.protein_g,
    carbs_g: r.carbs_g,
    fat_g: r.fat_g
  });
  closeManualModal();
  goToDay(ts); // sari la ziua mesei ca să confirmi că s-a așezat corect
});

// ---------------- Statistici ----------------
let statsMode = "day"; // day | week | month | year | custom
let anchor = new Date(); // referință pentru zi/săpt/lună/an
let customStart = todayStr();
let customEnd = todayStr();

// Intervalul [start, end] (YYYY-MM-DD, inclusiv la ambele capete) pentru modul curent.
function periodRange() {
  if (statsMode === "custom") {
    return customStart <= customEnd
      ? [customStart, customEnd]
      : [customEnd, customStart];
  }
  const d = new Date(anchor);
  if (statsMode === "day") {
    const s = dateStrFromDate(d);
    return [s, s];
  }
  if (statsMode === "week") {
    const offset = (d.getDay() + 6) % 7; // 0 = luni
    const start = new Date(d);
    start.setDate(d.getDate() - offset);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return [dateStrFromDate(start), dateStrFromDate(end)];
  }
  if (statsMode === "month") {
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return [dateStrFromDate(start), dateStrFromDate(end)];
  }
  // year
  const start = new Date(d.getFullYear(), 0, 1);
  const end = new Date(d.getFullYear(), 11, 31);
  return [dateStrFromDate(start), dateStrFromDate(end)];
}

function periodLabelText(start, end) {
  if (statsMode === "day") return prettyDate(start);
  if (statsMode === "year") return start.slice(0, 4);
  if (statsMode === "month") {
    const label = new Date(anchor).toLocaleDateString("ro-RO", {
      month: "long",
      year: "numeric"
    });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  // week + custom: interval
  return `${prettyDate(start)} - ${prettyDate(end)}`;
}

function shiftAnchor(dir) {
  const d = new Date(anchor);
  if (statsMode === "day") d.setDate(d.getDate() + dir);
  else if (statsMode === "week") d.setDate(d.getDate() + dir * 7);
  else if (statsMode === "month") d.setMonth(d.getMonth() + dir);
  else if (statsMode === "year") d.setFullYear(d.getFullYear() + dir);
  anchor = d;
  renderStats();
}

// Sincronizează butoanele + ce se vede (navigare vs interval) cu modul curent.
function syncModeUI(mode) {
  el.periodModes.querySelectorAll(".period-mode").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  el.periodNav.classList.toggle("hidden", mode === "custom");
  el.periodRange.classList.toggle("hidden", mode !== "custom");
}

function setMode(mode) {
  statsMode = mode;
  if (mode === "custom") {
    customStart = todayStr();
    customEnd = todayStr();
    el.rangeStart.value = customStart;
    el.rangeEnd.value = customEnd;
  } else {
    anchor = new Date();
  }
  syncModeUI(mode);
  renderStats();
}

// Sari la vederea pe o zi anume (folosit după ce adaugi o masă).
function goToDay(ts) {
  statsMode = "day";
  anchor = new Date(ts);
  syncModeUI("day");
  renderStats();
}

// Wiring selector
el.periodModes.addEventListener("click", (e) => {
  const btn = e.target.closest(".period-mode");
  if (btn) setMode(btn.dataset.mode);
});
el.periodPrev.addEventListener("click", () => shiftAnchor(-1));
el.periodNext.addEventListener("click", () => shiftAnchor(1));
el.rangeStart.addEventListener("change", () => {
  customStart = el.rangeStart.value || todayStr();
  renderStats();
});
el.rangeEnd.addEventListener("change", () => {
  customEnd = el.rangeEnd.value || todayStr();
  renderStats();
});

function renderStats() {
  const [start, end] = periodRange();
  el.periodLabel.textContent = periodLabelText(start, end);

  const items = loadEntries()
    .filter((e) => e.date >= start && e.date <= end)
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

  // Zile distincte în care există mese (pentru media zilnică).
  const dayKeys = [...new Set(items.map((e) => e.date))];
  const dayCount = dayKeys.length;

  const mealsLbl = `${items.length} ${items.length === 1 ? "masă" : "mese"}`;
  const totalLbl =
    dayCount >= 2
      ? `Total perioadă · ${mealsLbl} · ${dayCount} zile`
      : `Total · ${mealsLbl}`;

  // Media zilnică apare doar de la 2 zile cu date în sus (pe o zi ar fi redundantă).
  let avgHtml = "";
  if (dayCount >= 2) {
    avgHtml = `
      <div class="total-avg">
        Media zilnică: <b>${Math.round(sum.calories / dayCount)} kcal</b>
        · ${Math.round(sum.protein_g / dayCount)}P
        / ${Math.round(sum.carbs_g / dayCount)}C
        / ${Math.round(sum.fat_g / dayCount)}G
      </div>`;
  }

  el.totals.innerHTML = `
    <div class="total-kcal">${sum.calories} kcal</div>
    <div class="total-lbl">${totalLbl}</div>
    <div class="total-macros">
      <div class="macro"><div class="val">${sum.protein_g}g</div><div class="lbl">Proteine</div></div>
      <div class="macro"><div class="val">${sum.carbs_g}g</div><div class="lbl">Carbo</div></div>
      <div class="macro"><div class="val">${sum.fat_g}g</div><div class="lbl">Grăsimi</div></div>
    </div>
    ${avgHtml}
  `;

  if (items.length === 0) {
    el.entries.innerHTML = `<div class="empty">Nicio masă în perioada aleasă.</div>`;
    return;
  }

  // Grupare pe zile, cea mai recentă zi sus.
  const byDay = new Map();
  for (const e of items) {
    if (!byDay.has(e.date)) byDay.set(e.date, []);
    byDay.get(e.date).push(e);
  }
  const days = [...byDay.keys()].sort().reverse();
  const showDayHeaders = days.length > 1;

  el.entries.innerHTML = days
    .map((date) => {
      const dayItems = byDay.get(date);
      const dayKcal = dayItems.reduce((a, e) => a + e.calories, 0);
      const header = showDayHeaders
        ? `<div class="day-header"><span>${prettyDate(date)}</span><span>${dayKcal} kcal</span></div>`
        : "";
      return header + dayItems.map(entryHtml).join("");
    })
    .join("");
}

function entryHtml(e) {
  const thumb = e.thumb
    ? `<img src="${e.thumb}" class="entry-thumb" alt="${escapeHtml(e.food_name)}" />`
    : `<div class="entry-thumb placeholder">🍽</div>`;
  return `
    <div class="entry">
      ${thumb}
      <div class="info">
        <div class="name">${escapeHtml(e.food_name)}</div>
        <div class="sub">~${e.grams}g · ${e.protein_g}P / ${e.carbs_g}C / ${e.fat_g}G · ${prettyTime(e.ts)}</div>
        <div class="kcal">${e.calories} kcal</div>
      </div>
      <button class="del" data-id="${e.id}" title="Șterge">🗑</button>
    </div>`;
}

// Click pe listă: ștergere (delegare) sau mărirea pozei.
el.entries.addEventListener("click", (e) => {
  const del = e.target.closest(".del");
  if (del) {
    deleteEntry(del.dataset.id);
    return;
  }
  const img = e.target.closest("img.entry-thumb");
  if (img) openLightbox(img.src);
});

// ---------------- Lightbox (poză mărită) ----------------
function openLightbox(src) {
  el.lightboxImg.src = src;
  el.lightbox.classList.remove("hidden");
}
el.lightbox.addEventListener("click", () => {
  el.lightbox.classList.add("hidden");
  el.lightboxImg.src = "";
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
el.rangeStart.value = customStart;
el.rangeEnd.value = customEnd;
renderStats();
