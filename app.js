"use strict";

const STORAGE_KEY = "ct_entries";
const PROFILE_KEY = "ct_profile";
const VIEW_KEY = "ct_view";
const API_URL = "/.netlify/functions/analyze";
const EXERCISE_URL = "/.netlify/functions/exercise";

// Factor de activitate peste metabolismul bazal (BMR) pentru "cat arde corpul intr-o zi
// normala, fara sport intentionat". Exercitiile logate se adauga separat deasupra, ca sa
// nu numaram sportul de doua ori.
const ACTIVITY_FACTOR = 1.2;

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

// O intrare fara `type` (dinainte de exercitii) e considerata masa.
function isExercise(e) {
  return e.type === "exercise";
}

// ---------------- Profil + formule (IMC / BMR / deficit) ----------------
function loadProfile() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_KEY)) || null;
  } catch {
    return null;
  }
}
function saveProfile(p) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
}
function profileComplete(p) {
  return !!(p && p.sex && p.age > 0 && p.height_cm > 0 && p.weight_kg > 0);
}

// Indice de masa corporala = kg / m^2.
function computeBmi(weightKg, heightCm) {
  const m = heightCm / 100;
  if (!m) return 0;
  return weightKg / (m * m);
}
function bmiCategory(bmi) {
  if (bmi < 18.5) return "subponderal";
  if (bmi < 25) return "normal";
  if (bmi < 30) return "supraponderal";
  return "obezitate";
}

// Metabolism bazal (Mifflin-St Jeor) - are nevoie de sex.
function computeBmr(p) {
  const base = 10 * p.weight_kg + 6.25 * p.height_cm - 5 * p.age;
  return p.sex === "F" ? base - 161 : base + 5;
}
// Cate calorii arde corpul intr-o zi normala (BMR * factor sedentar).
function bodyBurn(p) {
  return Math.round(computeBmr(p) * ACTIVITY_FACTOR);
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

// Redimensionează + trimite poza (și eventualele notițe) la model. Întoarce { thumb, result }.
// `onThumb` e chemat imediat ce miniatura e gata, ca să arătăm poza cât timp se analizează.
async function analyzeFile(file, notes, onThumb) {
  const sendUrl = await fileToScaledDataUrl(file, 1024, 0.85);
  const thumbUrl = await fileToScaledDataUrl(file, 320, 0.7);
  if (onThumb) onThumb(thumbUrl);

  const base64 = sendUrl.split(",")[1];
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image_base64: base64,
      media_type: "image/jpeg",
      notes: (notes || "").trim()
    })
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
  notesInput: document.getElementById("notes-input"),
  analyzeBtn: document.getElementById("analyze-btn"),
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
  manualNotes: document.getElementById("manual-notes"),
  manualAnalyze: document.getElementById("manual-analyze"),
  manualStatus: document.getElementById("manual-status"),
  manualResult: document.getElementById("manual-result"),
  manualDatetime: document.getElementById("manual-datetime"),
  manualSave: document.getElementById("manual-save"),
  manualCancel: document.getElementById("manual-cancel"),
  // modal adaugă din nou
  readdModal: document.getElementById("readd-modal"),
  readdSummary: document.getElementById("readd-summary"),
  readdDatetime: document.getElementById("readd-datetime"),
  readdStatus: document.getElementById("readd-status"),
  readdSave: document.getElementById("readd-save"),
  readdCancel: document.getElementById("readd-cancel"),
  // profil (date personale)
  profileSex: document.getElementById("profile-sex"),
  profileAge: document.getElementById("profile-age"),
  profileHeight: document.getElementById("profile-height"),
  profileWeight: document.getElementById("profile-weight"),
  profileSave: document.getElementById("profile-save"),
  profileStatus: document.getElementById("profile-status"),
  profileSummary: document.getElementById("profile-summary"),
  // exerciții
  homeAddExercise: document.getElementById("home-add-exercise"),
  addExerciseBtn: document.getElementById("add-exercise-btn"),
  exerciseModal: document.getElementById("exercise-modal"),
  exerciseText: document.getElementById("exercise-text"),
  exerciseEstimate: document.getElementById("exercise-estimate"),
  exerciseStatus: document.getElementById("exercise-status"),
  exerciseResult: document.getElementById("exercise-result"),
  exerciseDatetime: document.getElementById("exercise-datetime"),
  exerciseSave: document.getElementById("exercise-save"),
  exerciseCancel: document.getElementById("exercise-cancel"),
  // modal detalii exercițiu
  exerciseDetailModal: document.getElementById("exercise-detail-modal"),
  exerciseDetailTitle: document.getElementById("exercise-detail-title"),
  exerciseDetailBody: document.getElementById("exercise-detail-body"),
  exerciseDetailClose: document.getElementById("exercise-detail-close"),
  // modal detalii masă
  mealDetailModal: document.getElementById("meal-detail-modal"),
  mealDetailTitle: document.getElementById("meal-detail-title"),
  mealDetailBody: document.getElementById("meal-detail-body"),
  mealDetailClose: document.getElementById("meal-detail-close"),
  // lightbox
  lightbox: document.getElementById("lightbox"),
  lightboxImg: document.getElementById("lightbox-img"),
  // views
  viewHome: document.getElementById("view-home"),
  viewStats: document.getElementById("view-stats")
};

// ---------------- Flux poză -> analiză (Acasă) ----------------
let pendingFile = null; // fișierul selectat, înainte de analiză
let pending = null; // { thumb, result } după analiză, până la Adaugă / Renunță

// La selectarea pozei arătăm preview + notițe; analiza pornește abia la butonul "Analizează",
// ca să apucăm să scriem notițe.
el.photoInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  pendingFile = file;
  resetPreview();
  el.previewImg.src = URL.createObjectURL(file);
  el.previewCard.classList.remove("hidden");
  el.notesInput.value = "";
  el.analyzeBtn.classList.remove("hidden");
  el.status.textContent = "";
  // Golește input-ul ca să poți re-selecta aceeași poză.
  el.photoInput.value = "";
});

el.analyzeBtn.addEventListener("click", async () => {
  if (!pendingFile) return;
  el.analyzeBtn.classList.add("hidden");
  el.status.textContent = "Analizez poza... (poate dura câteva secunde)";
  try {
    const { thumb, result } = await analyzeFile(
      pendingFile,
      el.notesInput.value,
      (t) => {
        el.previewImg.src = t;
      }
    );
    pending = { thumb, result, notes: el.notesInput.value.trim() };
    showResult(result);
  } catch (err) {
    el.status.textContent = "Eroare: " + err.message + ". Încearcă din nou.";
    el.analyzeBtn.classList.remove("hidden");
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
    fat_g: r.fat_g,
    notes: pending.notes
  });
  resetPreview();
  el.previewCard.classList.add("hidden");
  pendingFile = null;
  goToDay(ts); // sari la ziua de azi, unde tocmai am adăugat
  switchView("stats");
});

el.discardBtn.addEventListener("click", () => {
  resetPreview();
  el.previewCard.classList.add("hidden");
  pendingFile = null;
});

// ---------------- Adăugare manuală (poză + notițe + dată/oră alese) ----------------
let manualFile = null;
let pendingManual = null; // { thumb, result }

el.addManualBtn.addEventListener("click", openManualModal);
el.manualCancel.addEventListener("click", closeManualModal);
el.manualModal.addEventListener("click", (e) => {
  if (e.target === el.manualModal) closeManualModal(); // click pe fundal = închide
});

function openManualModal() {
  manualFile = null;
  pendingManual = null;
  el.manualPhoto.value = "";
  el.manualPreview.src = "";
  el.manualPreview.classList.add("hidden");
  el.manualNotes.value = "";
  el.manualResult.innerHTML = "";
  el.manualResult.classList.add("hidden");
  el.manualStatus.textContent = "";
  const now = new Date();
  el.manualDatetime.value = toDatetimeLocal(now);
  el.manualDatetime.max = toDatetimeLocal(now); // fără mese în viitor
  el.manualAnalyze.disabled = true;
  el.manualSave.disabled = true;
  el.manualModal.classList.remove("hidden");
}
function closeManualModal() {
  el.manualModal.classList.add("hidden");
}

el.manualPhoto.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  manualFile = file;
  pendingManual = null;
  el.manualPreview.src = URL.createObjectURL(file);
  el.manualPreview.classList.remove("hidden");
  el.manualResult.classList.add("hidden");
  el.manualStatus.textContent = "";
  el.manualAnalyze.disabled = false;
  el.manualSave.disabled = true;
  el.manualPhoto.value = "";
});

el.manualAnalyze.addEventListener("click", async () => {
  if (!manualFile) return;
  el.manualAnalyze.disabled = true;
  el.manualSave.disabled = true;
  el.manualResult.classList.add("hidden");
  el.manualStatus.textContent = "Analizez poza... (poate dura câteva secunde)";
  try {
    const { thumb, result } = await analyzeFile(
      manualFile,
      el.manualNotes.value,
      (t) => {
        el.manualPreview.src = t;
      }
    );
    pendingManual = { thumb, result, notes: el.manualNotes.value.trim() };
    el.manualStatus.textContent = "";
    el.manualResult.innerHTML = resultHtml(result);
    el.manualResult.classList.remove("hidden");
    el.manualSave.disabled = false;
  } catch (err) {
    el.manualStatus.textContent =
      "Eroare: " + err.message + ". Încearcă din nou.";
    el.manualAnalyze.disabled = false;
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
  if (ts > Date.now()) {
    el.manualStatus.textContent = "Nu poți alege o dată/oră din viitor.";
    return;
  }
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
    fat_g: r.fat_g,
    notes: pendingManual.notes
  });
  closeManualModal();
  goToDay(ts); // sari la ziua mesei ca să confirmi că s-a așezat corect
});

// ---------------- Adaugă din nou (refolosește exact aceleași valori) ----------------
let pendingReadd = null; // masa sursă

el.readdCancel.addEventListener("click", closeReaddModal);
el.readdModal.addEventListener("click", (e) => {
  if (e.target === el.readdModal) closeReaddModal();
});

function openReaddModal(entry) {
  pendingReadd = entry;
  const thumb = entry.thumb
    ? `<img src="${entry.thumb}" alt="${escapeHtml(entry.food_name)}" />`
    : `<div class="readd-thumb-ph">🍽</div>`;
  el.readdSummary.innerHTML = `
    ${thumb}
    <div class="info">
      <div class="name">${escapeHtml(entry.food_name)}</div>
      <div class="sub">~${entry.grams}g · ${entry.protein_g}P / ${entry.carbs_g}C / ${entry.fat_g}G</div>
      <div class="kcal">${entry.calories} kcal</div>
    </div>`;
  const now = new Date();
  el.readdDatetime.value = toDatetimeLocal(now);
  el.readdDatetime.max = toDatetimeLocal(now);
  el.readdStatus.textContent = "";
  el.readdModal.classList.remove("hidden");
}
function closeReaddModal() {
  el.readdModal.classList.add("hidden");
  pendingReadd = null;
}

el.readdSave.addEventListener("click", () => {
  if (!pendingReadd) return;
  const value = el.readdDatetime.value;
  if (!value) {
    el.readdStatus.textContent = "Alege data și ora.";
    return;
  }
  const ts = new Date(value).getTime();
  if (ts > Date.now()) {
    el.readdStatus.textContent = "Nu poți alege o dată/oră din viitor.";
    return;
  }
  const s = pendingReadd;
  addEntry({
    id: newId(),
    date: dateStrFromTs(ts),
    ts,
    thumb: s.thumb,
    food_name: s.food_name,
    grams: s.grams,
    calories: s.calories,
    protein_g: s.protein_g,
    carbs_g: s.carbs_g,
    fat_g: s.fat_g,
    notes: s.notes
  });
  closeReaddModal();
  goToDay(ts);
});

// ---------------- Profil (date personale) ----------------
function fillProfileForm() {
  const p = loadProfile();
  if (p) {
    el.profileSex.value = p.sex || "M";
    el.profileAge.value = p.age || "";
    el.profileHeight.value = p.height_cm || "";
    el.profileWeight.value = p.weight_kg || "";
  }
  renderProfileSummary();
}

function renderProfileSummary() {
  const p = loadProfile();
  if (!profileComplete(p)) {
    el.profileSummary.innerHTML = "";
    return;
  }
  const bmi = computeBmi(p.weight_kg, p.height_cm);
  el.profileSummary.innerHTML = `
    <div class="profile-metric">
      <div class="val">${bmi.toFixed(1)}</div>
      <div class="lbl">IMC · ${bmiCategory(bmi)}</div>
    </div>
    <div class="profile-metric">
      <div class="val">${bodyBurn(p)}</div>
      <div class="lbl">kcal arse de corp/zi</div>
    </div>`;
}

el.profileSave.addEventListener("click", () => {
  const sex = el.profileSex.value;
  const age = parseInt(el.profileAge.value, 10);
  const height_cm = parseFloat(el.profileHeight.value);
  const weight_kg = parseFloat(el.profileWeight.value);
  if (!age || !height_cm || !weight_kg) {
    el.profileStatus.textContent = "Completează vârsta, înălțimea și greutatea.";
    return;
  }
  saveProfile({ sex, age, height_cm, weight_kg });
  el.profileStatus.textContent = "Salvat ✓";
  renderProfileSummary();
  renderStats(); // deficitul depinde de profil
  setTimeout(() => {
    el.profileStatus.textContent = "";
  }, 2000);
});

// ---------------- Adăugare exercițiu (text -> Claude -> calorii arse) ----------------
let pendingExercise = null; // { activities, total_calories, total_duration_min, summary }

el.homeAddExercise.addEventListener("click", openExerciseModal);
el.addExerciseBtn.addEventListener("click", openExerciseModal);
el.exerciseCancel.addEventListener("click", closeExerciseModal);
el.exerciseModal.addEventListener("click", (e) => {
  if (e.target === el.exerciseModal) closeExerciseModal();
});

function openExerciseModal() {
  pendingExercise = null;
  el.exerciseText.value = "";
  el.exerciseResult.innerHTML = "";
  el.exerciseResult.classList.add("hidden");
  el.exerciseStatus.textContent = "";
  const now = new Date();
  el.exerciseDatetime.value = toDatetimeLocal(now);
  el.exerciseDatetime.max = toDatetimeLocal(now); // fără exerciții în viitor
  el.exerciseSave.disabled = true;
  el.exerciseModal.classList.remove("hidden");
}
function closeExerciseModal() {
  el.exerciseModal.classList.add("hidden");
}

// HTML-ul cu rezultatul estimării (defalcare pe activități + total).
function exerciseResultHtml(d) {
  const rows = (d.activities || [])
    .map(
      (a) =>
        `<div class="ex-row"><span>${escapeHtml(a.name)} · ${a.duration_min} min</span><span>${a.calories} kcal</span></div>`
    )
    .join("");
  return `
    <h2>${escapeHtml(d.summary)}</h2>
    <div class="kcal burned">🔥 ${d.total_calories} kcal arse</div>
    <div class="ex-breakdown">${rows}</div>
    <div class="meta">Durată totală: ~${d.total_duration_min} min</div>
  `;
}

el.exerciseEstimate.addEventListener("click", async () => {
  const text = el.exerciseText.value.trim();
  if (!text) {
    el.exerciseStatus.textContent = "Scrie ce ai făcut.";
    return;
  }
  const p = loadProfile();
  if (!profileComplete(p)) {
    el.exerciseStatus.textContent =
      "Completează întâi greutatea la Datele mele (pagina Statistici).";
    return;
  }
  el.exerciseEstimate.disabled = true;
  el.exerciseSave.disabled = true;
  el.exerciseResult.classList.add("hidden");
  el.exerciseStatus.textContent = "Estimez... (poate dura câteva secunde)";
  try {
    const res = await fetch(EXERCISE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, weight_kg: p.weight_kg })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || "HTTP " + res.status);
    }
    if (!data.activities || data.activities.length === 0) {
      el.exerciseStatus.textContent =
        "Nu am recunoscut niciun exercițiu. Reformulează, te rog.";
      el.exerciseEstimate.disabled = false;
      return;
    }
    pendingExercise = data;
    el.exerciseStatus.textContent = "";
    el.exerciseResult.innerHTML = exerciseResultHtml(data);
    el.exerciseResult.classList.remove("hidden");
    el.exerciseSave.disabled = false;
  } catch (err) {
    el.exerciseStatus.textContent =
      "Eroare: " + err.message + ". Încearcă din nou.";
  } finally {
    el.exerciseEstimate.disabled = false;
  }
});

el.exerciseSave.addEventListener("click", () => {
  if (!pendingExercise) return;
  const value = el.exerciseDatetime.value;
  if (!value) {
    el.exerciseStatus.textContent = "Alege data și ora.";
    return;
  }
  const ts = new Date(value).getTime();
  if (ts > Date.now()) {
    el.exerciseStatus.textContent = "Nu poți alege o dată/oră din viitor.";
    return;
  }
  const d = pendingExercise;
  addEntry({
    id: newId(),
    date: dateStrFromTs(ts),
    ts,
    type: "exercise",
    summary: d.summary,
    total_duration_min: d.total_duration_min,
    calories: d.total_calories,
    activities: d.activities
  });
  closeExerciseModal();
  goToDay(ts); // sari la ziua exercițiului
  switchView("stats");
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

// Blocul cu deficitul caloric: arse de corp + arse activ - mâncate.
// Pe modul "Zi" arată ziua respectivă; pe perioade mai lungi arată media zilnică.
function deficitHtml(eatenTotal, burnedActiveTotal, dayCount) {
  const p = loadProfile();
  if (!profileComplete(p)) {
    return `<div class="deficit-hint">Completează „Datele mele" mai sus ca să vezi deficitul caloric.</div>`;
  }
  const burnBody = bodyBurn(p);

  let title, eaten, burnedActive, suffix;
  if (statsMode === "day") {
    title = "Deficit caloric";
    eaten = eatenTotal;
    burnedActive = burnedActiveTotal;
    suffix = "";
  } else if (dayCount >= 1) {
    title = "Deficit mediu zilnic";
    eaten = Math.round(eatenTotal / dayCount);
    burnedActive = Math.round(burnedActiveTotal / dayCount);
    suffix = "/zi";
  } else {
    return ""; // perioadă fără date: nimic de mediat
  }

  const deficit = burnBody + burnedActive - eaten;
  const isDeficit = deficit >= 0;
  return `
    <div class="deficit-card">
      <div class="deficit-title">${title}</div>
      <div class="deficit-row"><span>🔥 Arse de corp${suffix}</span><span class="pos">+${burnBody}</span></div>
      <div class="deficit-row"><span>🏃 Arse activ${suffix}</span><span class="pos">+${burnedActive}</span></div>
      <div class="deficit-row"><span>🍽 Mâncate${suffix}</span><span class="neg">−${eaten}</span></div>
      <div class="deficit-total ${isDeficit ? "deficit-good" : "deficit-bad"}">
        ${isDeficit ? "Deficit" : "Surplus"}: ${Math.abs(deficit)} kcal
      </div>
    </div>`;
}

function renderStats() {
  const [start, end] = periodRange();
  el.periodLabel.textContent = periodLabelText(start, end);
  // Nu putem naviga în viitor: dezactivează ">" când perioada ajunge la ziua de azi.
  el.periodNext.disabled = end >= todayStr();

  const items = loadEntries()
    .filter((e) => e.date >= start && e.date <= end)
    .sort((a, b) => a.ts - b.ts);

  const meals = items.filter((e) => !isExercise(e));
  const exercises = items.filter(isExercise);

  // Total mâncat (doar mese) - caloriile arse din exerciții se numără separat.
  const sum = meals.reduce(
    (acc, e) => {
      acc.calories += e.calories;
      acc.protein_g += e.protein_g;
      acc.carbs_g += e.carbs_g;
      acc.fat_g += e.fat_g;
      return acc;
    },
    { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }
  );
  const burnedActive = exercises.reduce((a, e) => a + e.calories, 0);

  // Zile distincte în care există intrări (pentru media zilnică).
  const dayKeys = [...new Set(items.map((e) => e.date))];
  const dayCount = dayKeys.length;

  const countParts = [`${meals.length} ${meals.length === 1 ? "masă" : "mese"}`];
  if (exercises.length) {
    countParts.push(
      `${exercises.length} ${exercises.length === 1 ? "exercițiu" : "exerciții"}`
    );
  }
  const countLbl = countParts.join(" · ");
  const totalLbl =
    dayCount >= 2
      ? `Total perioadă · ${countLbl} · ${dayCount} zile`
      : `Total · ${countLbl}`;

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
    ${deficitHtml(sum.calories, burnedActive, dayCount)}
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
      const dayKcal = dayItems
        .filter((e) => !isExercise(e))
        .reduce((a, e) => a + e.calories, 0);
      const header = showDayHeaders
        ? `<div class="day-header"><span>${prettyDate(date)}</span><span>${dayKcal} kcal</span></div>`
        : "";
      return header + dayItems.map(entryHtml).join("");
    })
    .join("");
}

function entryHtml(e) {
  if (isExercise(e)) return exerciseEntryHtml(e);
  const thumb = e.thumb
    ? `<img src="${e.thumb}" class="entry-thumb" alt="${escapeHtml(e.food_name)}" />`
    : `<div class="entry-thumb placeholder">🍽</div>`;
  return `
    <div class="entry entry-meal" data-id="${e.id}" title="Vezi detalii">
      ${thumb}
      <div class="info">
        <div class="name">${escapeHtml(e.food_name)}</div>
        <div class="sub">~${e.grams}g · ${e.protein_g}P / ${e.carbs_g}C / ${e.fat_g}G · ${prettyTime(e.ts)}</div>
        <div class="kcal">${e.calories} kcal</div>
      </div>
      <div class="entry-actions">
        <button class="readd" data-id="${e.id}" title="Adaugă din nou">🔁</button>
        <button class="del" data-id="${e.id}" title="Șterge">🗑</button>
      </div>
    </div>`;
}

// Emoji-ul thumbnail-ului: se ia după activitatea cu cele mai multe calorii.
const EXERCISE_EMOJI = [
  [["inot", "innotat", "balaciala", "piscina"], "🏊"],
  [["alerg", "jogging", "sprint", "fuga"], "🏃"],
  [["biciclet", "ciclism", "spinning"], "🚴"],
  [["sala", "greutati", "fitness", "gym", "musculatura", "pumping"], "🏋️"],
  [["cardio"], "🫀"],
  [["yoga", "stretching", "pilates"], "🧘"],
  [["fotbal", "soccer"], "⚽"],
  [["tenis"], "🎾"],
  [["baschet"], "🏀"],
  [["volei"], "🏐"],
  [["dans", "zumba"], "💃"],
  [["box", "kickbox"], "🥊"],
  [["hiking", "munte", "trekking", "mers"], "🥾"],
  [["schi", "ski"], "⛷️"],
  [["karate", "judo", "arte martiale"], "🥋"],
  [["inlinere", "role"], "🛼"],
];

function exerciseEmoji(activities) {
  if (!activities || !activities.length) return "🏃";
  const top = activities.reduce((best, a) =>
    (a.calories || 0) > (best.calories || 0) ? a : best,
  );
  const name = (top.name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  for (const [keywords, emoji] of EXERCISE_EMOJI) {
    if (keywords.some((k) => name.includes(k))) return emoji;
  }
  return "🏃";
}

function exerciseEntryHtml(e) {
  const detail =
    e.activities && e.activities.length
      ? e.activities
          .map((a) => `${escapeHtml(a.name)} ${a.duration_min}min`)
          .join(" · ")
      : escapeHtml(e.summary || "Exercițiu");
  return `
    <div class="entry entry-exercise" data-id="${e.id}" title="Vezi detalii">
      <div class="entry-thumb exercise-icon">${exerciseEmoji(e.activities)}</div>
      <div class="info">
        <div class="name">${escapeHtml(e.summary || "Exercițiu")}</div>
        <div class="sub">${detail} · ${prettyTime(e.ts)}</div>
        <div class="kcal burned">−${e.calories} kcal</div>
      </div>
      <div class="entry-actions">
        <button class="del" data-id="${e.id}" title="Șterge">🗑</button>
      </div>
    </div>`;
}

// Click pe listă: ștergere / adaugă din nou / mărirea pozei (delegare).
el.entries.addEventListener("click", (e) => {
  const del = e.target.closest(".del");
  if (del) {
    deleteEntry(del.dataset.id);
    return;
  }
  const readd = e.target.closest(".readd");
  if (readd) {
    const entry = loadEntries().find((x) => x.id === readd.dataset.id);
    if (entry) openReaddModal(entry);
    return;
  }
  const img = e.target.closest("img.entry-thumb");
  if (img) {
    openLightbox(img.src);
    return;
  }
  const exEntry = e.target.closest(".entry-exercise");
  if (exEntry) {
    openExerciseDetail(exEntry.dataset.id);
    return;
  }
  const mealEntry = e.target.closest(".entry-meal");
  if (mealEntry) openMealDetail(mealEntry.dataset.id);
});

// Modal cu detaliile unei mese: macro, gramaj, ora și notițele adăugate.
function openMealDetail(id) {
  const e = loadEntries().find((x) => x.id === id);
  if (!e) return;
  el.mealDetailTitle.textContent = e.food_name || "Masă";
  const notes = (e.notes || "").trim();
  const notesHtml = notes
    ? `<div class="detail-notes"><div class="detail-notes-lbl">Notițe</div><div class="detail-notes-txt">${escapeHtml(notes)}</div></div>`
    : `<div class="detail-notes detail-notes-empty">Fără notițe la această masă.</div>`;
  const thumb = e.thumb
    ? `<img src="${e.thumb}" class="detail-photo" alt="${escapeHtml(e.food_name)}" />`
    : "";
  el.mealDetailBody.innerHTML = `
    ${thumb}
    <div class="kcal">${e.calories} kcal</div>
    <div class="macros">
      <div class="macro"><div class="val">${e.protein_g}g</div><div class="lbl">Proteine</div></div>
      <div class="macro"><div class="val">${e.carbs_g}g</div><div class="lbl">Carbo</div></div>
      <div class="macro"><div class="val">${e.fat_g}g</div><div class="lbl">Grăsimi</div></div>
    </div>
    <div class="meta">Porție estimată: ~${e.grams}g · ${prettyTime(e.ts)}</div>
    ${notesHtml}
  `;
  el.mealDetailModal.classList.remove("hidden");
}
function closeMealDetail() {
  el.mealDetailModal.classList.add("hidden");
}
el.mealDetailClose.addEventListener("click", closeMealDetail);
el.mealDetailModal.addEventListener("click", (e) => {
  if (e.target === el.mealDetailModal) closeMealDetail();
});

// Modal cu defalcarea pe activități a unui exercițiu salvat.
function openExerciseDetail(id) {
  const entry = loadEntries().find((x) => x.id === id);
  if (!entry) return;
  el.exerciseDetailTitle.textContent = entry.summary || "Exercițiu";
  // Fallback pentru intrări fără listă de activități: arată o singură linie din total.
  const acts =
    entry.activities && entry.activities.length
      ? entry.activities
      : [
          {
            name: entry.summary || "Exercițiu",
            duration_min: entry.total_duration_min || 0,
            calories: entry.calories
          }
        ];
  const totalMin =
    entry.total_duration_min ||
    acts.reduce((s, a) => s + (a.duration_min || 0), 0);
  const rows = acts
    .map(
      (a) =>
        `<div class="ex-row"><span>${escapeHtml(a.name)} · ${a.duration_min} min</span><span>${a.calories} kcal</span></div>`
    )
    .join("");
  el.exerciseDetailBody.innerHTML = `
    <div class="kcal burned">🔥 ${entry.calories} kcal arse</div>
    <div class="ex-breakdown">${rows}</div>
    <div class="meta">Durată totală: ~${totalMin} min · ${prettyTime(entry.ts)}</div>
  `;
  el.exerciseDetailModal.classList.remove("hidden");
}
function closeExerciseDetail() {
  el.exerciseDetailModal.classList.add("hidden");
}
el.exerciseDetailClose.addEventListener("click", closeExerciseDetail);
el.exerciseDetailModal.addEventListener("click", (e) => {
  if (e.target === el.exerciseDetailModal) closeExerciseDetail();
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
  localStorage.setItem(VIEW_KEY, view); // ține minte pagina la refresh
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
el.rangeStart.max = todayStr(); // calendarul nu lasă să alegi zile viitoare
el.rangeEnd.max = todayStr();
fillProfileForm();
renderStats();
// Rămâi pe pagina la care erai înainte de refresh (implicit Acasă).
switchView(localStorage.getItem(VIEW_KEY) || "home");
