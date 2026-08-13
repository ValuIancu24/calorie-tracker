"use strict";

const STORAGE_KEY = "ct_entries";
const PROFILE_KEY = "ct_profile";
const VIEW_KEY = "ct_view";
const WEIGHTS_KEY = "ct_weights";
const ACTIVITY_KEY = "ct_activity";
const REPORTS_KEY = "ct_reports";
const API_URL = "/.netlify/functions/analyze";
const EXERCISE_URL = "/.netlify/functions/exercise";

// Niveluri de activitate peste metabolismul bazal (BMR): "cat arde corpul intr-o zi normala".
// Factorii clasici Mifflin-St Jeor. Exercitiile logate se adauga separat deasupra, ca sa nu
// numaram sportul de doua ori.
const ACTIVITY_LEVELS = [
  { key: "sedentar", label: "Sedentar", factor: 1.2 },
  { key: "usor", label: "Ușor activ", factor: 1.375 },
  { key: "moderat", label: "Moderat activ", factor: 1.55 },
  { key: "foarte", label: "Foarte activ", factor: 1.725 },
  { key: "extra", label: "Extra activ", factor: 1.9 }
];
// Factorul folosit pentru zilele dinaintea oricarei schimbari de nivel (pastreaza vechiul comportament).
const DEFAULT_ACTIVITY_FACTOR = 1.2;

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

// Parsează un zecimal acceptând ȘI virgula (pe mobil, tastatura RO dă „,", iar <input type=number>
// o refuză - de aceea câmpurile de greutate sunt type=text și normalizăm aici).
function parseDecimal(str) {
  return parseFloat(String(str).replace(",", "."));
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
  // Poza (dacă există) merge în IndexedDB + cache; în localStorage salvăm intrarea FĂRĂ poză.
  if (entry.thumb) {
    photoCache.set(entry.id, entry.thumb); // sincron -> se afișează imediat
    idbPut(entry.id, entry.thumb).catch((e) =>
      console.warn("Nu am putut salva poza în IndexedDB:", e)
    );
    delete entry.thumb;
  }
  const entries = loadEntries();
  entries.push(entry);
  saveEntries(entries);
}
function deleteEntry(id) {
  saveEntries(loadEntries().filter((e) => e.id !== id));
  photoCache.delete(id);
  idbDelete(id).catch((e) => console.warn("Nu am putut șterge poza din IndexedDB:", e));
  renderStats();
}
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// O intrare fara `type` (dinainte de exercitii) e considerata masa.
function isExercise(e) {
  return e.type === "exercise";
}

// ---------------- Poze în IndexedDB (localStorage e prea mic pentru base64) ----------------
// Pozele meselor (miniatura base64) NU mai stau în `ct_entries` (localStorage ~5MB, se umple în
// câteva săptămâni), ci în IndexedDB (spațiu mare). `ct_entries` ține doar datele; poza se leagă
// prin id-ul mesei. Un cache în memorie ține pozele, ca tot codul de afișare să rămână sincron.
const PHOTO_DB = "ct_photos";
const PHOTO_STORE = "photos";
const MIGRATED_KEY = "ct_idb_migrated";

const photoCache = new Map(); // id -> dataURL
function photoFor(id) {
  return photoCache.get(id) || null;
}

let photoDbPromise = null;
function openPhotoDb() {
  if (!photoDbPromise) {
    photoDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(PHOTO_DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(PHOTO_STORE)) {
          req.result.createObjectStore(PHOTO_STORE); // cheie (out-of-line) = id-ul mesei
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return photoDbPromise;
}
function idbPut(id, dataUrl) {
  return openPhotoDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, "readwrite");
        tx.objectStore(PHOTO_STORE).put(dataUrl, id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}
function idbDelete(id) {
  return openPhotoDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, "readwrite");
        tx.objectStore(PHOTO_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}
function idbGetAll() {
  return openPhotoDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, "readonly");
        const store = tx.objectStore(PHOTO_STORE);
        const keysReq = store.getAllKeys();
        const valsReq = store.getAll();
        tx.oncomplete = () => {
          const map = new Map();
          for (let i = 0; i < keysReq.result.length; i++) {
            map.set(keysReq.result[i], valsReq.result[i]);
          }
          resolve(map);
        };
        tx.onerror = () => reject(tx.error);
      })
  );
}
function idbClear() {
  return openPhotoDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, "readwrite");
        tx.objectStore(PHOTO_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

// Mută pozele inline vechi din `ct_entries` în IndexedDB. Rulează o singură dată (flag),
// e idempotentă și NU șterge date: doar mută poza și scoate `thumb` din intrare.
async function migratePhotosIfNeeded() {
  if (localStorage.getItem(MIGRATED_KEY) === "1") return;
  const entries = loadEntries();
  let changed = false;
  for (const e of entries) {
    if (e.thumb) {
      await idbPut(e.id, e.thumb);
      photoCache.set(e.id, e.thumb);
      delete e.thumb;
      changed = true;
    }
  }
  if (changed) saveEntries(entries); // ct_entries se micșorează -> eliberează localStorage
  localStorage.setItem(MIGRATED_KEY, "1");
}

// Umple cache-ul din IndexedDB (o dată, la pornire).
async function hydratePhotoCache() {
  const map = await idbGetAll();
  photoCache.clear();
  for (const [id, url] of map) photoCache.set(id, url);
}

// Pregătește stratul de poze înainte de prima randare. Dacă IndexedDB nu e disponibil,
// afișarea cade pe pozele inline (dacă mai există în ct_entries), via `photoFor(id) || e.thumb`.
async function initPhotos() {
  try {
    await migratePhotosIfNeeded();
    await hydratePhotoCache();
  } catch (err) {
    console.warn("IndexedDB indisponibil; folosesc pozele inline dacă există.", err);
  }
}

// ---------------- Cantariri (istoric greutate) ----------------
function loadWeights() {
  try {
    return JSON.parse(localStorage.getItem(WEIGHTS_KEY)) || [];
  } catch {
    return [];
  }
}
function saveWeights(ws) {
  localStorage.setItem(WEIGHTS_KEY, JSON.stringify(ws));
}
function addWeight(w) {
  const ws = loadWeights();
  ws.push(w);
  saveWeights(ws);
}
function deleteWeight(id) {
  saveWeights(loadWeights().filter((w) => w.id !== id));
}

// ---------------- Nivel de activitate (hartă per-zi, editabilă pe orice perioadă) ----------------
// Model: { "YYYY-MM-DD": levelKey }. O atribuire pe interval scrie fiecare zi din el
// (suprascrie ce era acolo). Zilele neatribuite = Sedentar (implicit).
function loadActivityMap() {
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem(ACTIVITY_KEY));
  } catch {
    raw = null;
  }
  if (!raw) return {};
  if (Array.isArray(raw)) {
    // Migrare din formatul vechi (listă de schimbări „forward") în hartă per-zi.
    const map = migrateActivityArray(raw);
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(map));
    return map;
  }
  return raw;
}
function saveActivityMap(map) {
  localStorage.setItem(ACTIVITY_KEY, JSON.stringify(map));
}

// Iterează fiecare zi (YYYY-MM-DD) din [start, end] inclusiv. Ora 12:00 evită salturi DST.
function eachDayInclusive(start, end, cb) {
  const d = new Date(start + "T12:00:00");
  const last = new Date(end + "T12:00:00");
  while (d <= last) {
    cb(dateStrFromDate(d));
    d.setDate(d.getDate() + 1);
  }
}

// Câte zile sunt în [start, end] inclusiv.
function countDaysInclusive(start, end) {
  let n = 0;
  eachDayInclusive(start, end, () => n++);
  return n;
}

// Atribuie un nivel tuturor zilelor dintr-o perioadă (suprascrie).
function setActivityForRange(start, end, levelKey) {
  const map = loadActivityMap();
  eachDayInclusive(start, end, (day) => {
    map[day] = levelKey;
  });
  saveActivityMap(map);
}

// Migrare: fiecare schimbare veche umple zilele de la data ei până înaintea următoarei (ultima până azi).
function migrateActivityArray(arr) {
  const map = {};
  const sorted = arr
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.ts - b.ts));
  const today = todayStr();
  for (let i = 0; i < sorted.length; i++) {
    const from = sorted[i].date;
    let to = today;
    if (i + 1 < sorted.length) {
      const nd = new Date(sorted[i + 1].date + "T12:00:00");
      nd.setDate(nd.getDate() - 1);
      to = dateStrFromDate(nd);
    }
    if (from <= to) eachDayInclusive(from, to, (day) => (map[day] = sorted[i].level));
  }
  return map;
}

// ---------------- Rapoarte ----------------
function loadReports() {
  try {
    return JSON.parse(localStorage.getItem(REPORTS_KEY)) || [];
  } catch {
    return [];
  }
}
function saveReports(r) {
  localStorage.setItem(REPORTS_KEY, JSON.stringify(r));
}
function deleteReport(id) {
  saveReports(loadReports().filter((r) => r.id !== id));
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
  return !!(p && p.sex && p.birthdate && p.height_cm > 0 && p.weight_kg > 0);
}

// Vârsta (ani împliniți) la o dată dată, calculată din data nașterii (YYYY-MM-DD).
// Fără argument, folosește ziua de azi. Așa aplicația știe mereu vârsta corectă, fără s-o edităm.
function ageFromBirthdate(birthdate, atDateStr) {
  if (!birthdate) return 0;
  const [by, bm, bd] = birthdate.split("-").map(Number);
  const at = (atDateStr || todayStr()).split("-").map(Number);
  let age = at[0] - by;
  if (at[1] < bm || (at[1] === bm && at[2] < bd)) age--;
  return age > 0 ? age : 0;
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

// Greutatea activa la o data (YYYY-MM-DD): ultima cantarire cu date <= target.
// Daca nu exista niciuna inainte, ia cea mai veche cantarire; altfel greutatea din profil.
function weightForDate(dateStr) {
  const ws = loadWeights();
  if (ws.length) {
    const sorted = ws
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.ts - b.ts));
    let chosen = null;
    for (const w of sorted) {
      if (w.date <= dateStr) chosen = w;
      else break;
    }
    return (chosen || sorted[0]).weight_kg;
  }
  const p = loadProfile();
  return p && p.weight_kg ? p.weight_kg : 0;
}

// Nivelul de activitate al unei zile: ce e atribuit în hartă; altfel Sedentar (implicit).
function activityForDate(dateStr) {
  const key = loadActivityMap()[dateStr];
  const lvl = key && ACTIVITY_LEVELS.find((l) => l.key === key);
  if (lvl) return { level: lvl.key, factor: lvl.factor };
  return { level: "sedentar", factor: DEFAULT_ACTIVITY_FACTOR };
}

// Nivelul comun al unei perioade (levelKey) sau null dacă zilele au niveluri diferite.
function periodActivityLevel(start, end) {
  const map = loadActivityMap();
  const valid = (k) => (k && ACTIVITY_LEVELS.some((l) => l.key === k) ? k : "sedentar");
  let level = null;
  let first = true;
  let mixed = false;
  eachDayInclusive(start, end, (day) => {
    if (mixed) return;
    const k = valid(map[day]);
    if (first) {
      level = k;
      first = false;
    } else if (k !== level) {
      mixed = true;
    }
  });
  return mixed ? null : level;
}

// Cea mai veche zi cu date reale (mese/exerciții/cântăriri). Sub ea nu are sens să existe
// statistici: aplicația nu era folosită atunci. Null dacă nu există încă nimic.
function firstDataDate() {
  let min = null;
  for (const e of loadEntries()) if (!min || e.date < min) min = e.date;
  for (const w of loadWeights()) if (!min || w.date < min) min = w.date;
  return min;
}
// „Podeaua" istoricului: prima zi cu date, sau azi dacă nu există date. Sub ea nu se navighează
// și nu se calculează (altfel zilele goale dinainte de folosire ar da un deficit fantomă ~BMR).
function historyFloor() {
  return firstDataDate() || todayStr();
}
// Ziua mai mare (string-uri YYYY-MM-DD se compară lexicografic corect).
function maxDateStr(a, b) {
  return a > b ? a : b;
}

// Media zilnică a caloriilor arse de corp pe zilele TRĂITE din perioadă (max(start,podea)..azi
// inclusiv, fără viitor). Fiecare zi cu greutatea/activitatea ei. Zilele viitoare nu se numără:
// ne interesează cât ai ars efectiv, nu cât „ai arde" dacă greutatea ar rămâne neschimbată.
function avgBodyBurnForPeriod(start, end) {
  if (!profileComplete(loadProfile())) return 0;
  const today = todayStr();
  const effStart = maxDateStr(start, historyFloor()); // nu numărăm zile dinainte de folosire
  const effEnd = end < today ? end : today;
  if (effStart > effEnd) return 0; // perioadă integral în viitor sau integral sub podea
  let sum = 0;
  let n = 0;
  eachDayInclusive(effStart, effEnd, (day) => {
    sum += bodyBurnForDate(day);
    n++;
  });
  return n ? Math.round(sum / n) : 0;
}

// Metabolism bazal (Mifflin-St Jeor) pentru o greutate data + inaltimea/sexul curente si varsta
// la data ceruta (derivata din data nasterii; fara dateStr = varsta de azi).
function bmrFor(weightKg, dateStr) {
  const p = loadProfile();
  if (!p) return 0;
  const age = ageFromBirthdate(p.birthdate, dateStr);
  const base = 10 * weightKg + 6.25 * p.height_cm - 5 * age;
  return p.sex === "F" ? base - 161 : base + 5;
}

// Cate calorii arde corpul intr-o zi anume: BMR(greutatea + varsta de atunci) * factorul de activitate de atunci.
function bodyBurnForDate(dateStr) {
  const p = loadProfile();
  if (!profileComplete(p)) return 0;
  const w = weightForDate(dateStr);
  const { factor } = activityForDate(dateStr);
  return Math.round(bmrFor(w, dateStr) * factor);
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
  // copie de siguranță (Acasă)
  exportBtn: document.getElementById("export-btn"),
  importBtn: document.getElementById("import-btn"),
  importInput: document.getElementById("import-input"),
  backupStatus: document.getElementById("backup-status"),
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
  addRow: document.getElementById("stats-add-row"),
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
  statsReportBtn: document.getElementById("stats-report-btn"),
  // formular date personale (Acasă)
  onboardingCard: document.getElementById("onboarding-card"),
  onbSex: document.getElementById("onb-sex"),
  onbBirthdate: document.getElementById("onb-birthdate"),
  onbHeight: document.getElementById("onb-height"),
  onbWeight: document.getElementById("onb-weight"),
  onbSave: document.getElementById("onb-save"),
  onbStatus: document.getElementById("onb-status"),
  // profil (date personale) - card read-only pe Statistici
  profileCard: document.getElementById("profile-card"),
  profileSexVal: document.getElementById("profile-sex-val"),
  profileAgeVal: document.getElementById("profile-age-val"),
  profileHeightVal: document.getElementById("profile-height-val"),
  profileWeightVal: document.getElementById("profile-weight-val"),
  profileEdit: document.getElementById("profile-edit"),
  profileActivity: document.getElementById("profile-activity"),
  profileSummary: document.getElementById("profile-summary"),
  activityStatus: document.getElementById("activity-status"),
  // cântărire
  weighInput: document.getElementById("weigh-input"),
  weighDatetime: document.getElementById("weigh-datetime"),
  weighSave: document.getElementById("weigh-save"),
  weighStatus: document.getElementById("weigh-status"),
  weighHistory: document.getElementById("weigh-history"),
  weighReportBtn: document.getElementById("weigh-report-btn"),
  weighPeriodModes: document.getElementById("weigh-period-modes"),
  weighPeriodNav: document.getElementById("weigh-period-nav"),
  weighPeriodPrev: document.getElementById("weigh-period-prev"),
  weighPeriodNext: document.getElementById("weigh-period-next"),
  weighPeriodLabel: document.getElementById("weigh-period-label"),
  weighPeriodRange: document.getElementById("weigh-period-range"),
  weighRangeStart: document.getElementById("weigh-range-start"),
  weighRangeEnd: document.getElementById("weigh-range-end"),
  // rapoarte
  reportsList: document.getElementById("reports-list"),
  reportDetail: document.getElementById("report-detail"),
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
  // selector calendar pentru perioadă
  periodPicker: document.getElementById("period-picker"),
  ppPrev: document.getElementById("pp-prev"),
  ppNext: document.getElementById("pp-next"),
  ppTitle: document.getElementById("pp-title"),
  ppBody: document.getElementById("pp-body"),
  // views
  viewHome: document.getElementById("view-home"),
  viewStats: document.getElementById("view-stats"),
  viewWeigh: document.getElementById("view-weigh"),
  viewReports: document.getElementById("view-reports")
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

// ---------------- Copie de siguranță (export / import) ----------------
// Toate cheile de DATE ale aplicației (fără cele pur UI, ex. ct_view).
const BACKUP_KEYS = [STORAGE_KEY, WEIGHTS_KEY, PROFILE_KEY, ACTIVITY_KEY, REPORTS_KEY];

// Descarcă un JSON cu tot (mese cu poze, cântăriri, profil, activitate, rapoarte).
function exportBackup() {
  const data = {};
  for (const k of BACKUP_KEYS) {
    const raw = localStorage.getItem(k);
    if (raw == null) continue;
    try {
      data[k] = JSON.parse(raw);
    } catch {
      data[k] = raw;
    }
  }
  // Pozele stau acum în IndexedDB (nu în ct_entries), deci le atașăm separat ca backup-ul
  // să rămână complet. `photoCache` e sincronizat cu IndexedDB la runtime.
  const photos = {};
  for (const [id, url] of photoCache) photos[id] = url;
  const backup = {
    app: "calorie-tracker",
    version: 2,
    exportedAt: new Date().toISOString(),
    data,
    photos
  };
  const name = `klawriz-backup-${todayStr()}.json`;
  const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  const mealCount = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY].length : 0;
  el.backupStatus.textContent = `Backup creat (${mealCount} intrări). Caută „${name}” în Descărcări.`;
}

// Citește un fișier de backup și, după confirmare, ÎNLOCUIEȘTE datele curente cu cele din el.
function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch {
      el.backupStatus.textContent = "Fișier invalid (nu e un JSON valid).";
      return;
    }
    if (!parsed || parsed.app !== "calorie-tracker" || !parsed.data) {
      el.backupStatus.textContent = "Fișierul nu pare un backup al acestei aplicații.";
      return;
    }
    const keys = BACKUP_KEYS.filter((k) => k in parsed.data);
    if (keys.length === 0) {
      el.backupStatus.textContent = "Backup-ul nu conține date de restaurat.";
      return;
    }
    const n = Array.isArray(parsed.data[STORAGE_KEY]) ? parsed.data[STORAGE_KEY].length : 0;
    if (!confirm(`Importul ÎNLOCUIEȘTE toate datele curente cu cele din fișier (${n} intrări). Continui?`)) {
      return;
    }
    try {
      for (const k of keys) {
        localStorage.setItem(k, JSON.stringify(parsed.data[k]));
      }
    } catch (e) {
      el.backupStatus.textContent = "Nu am putut scrie datele (memorie plină?). Import anulat.";
      return;
    }
    // Un restore înlocuiește TOTUL, deci golim întâi pozele vechi din IndexedDB (evită orfane).
    // Format nou (`parsed.photos`) -> scriem pozele în IDB. Format vechi (poze inline în
    // ct_entries, fără `parsed.photos`) -> golim flag-ul ca migrarea de la reload să le mute în IDB.
    localStorage.removeItem(MIGRATED_KEY);
    const photos =
      parsed.photos && typeof parsed.photos === "object" ? parsed.photos : null;
    const writePhotos = idbClear()
      .catch(() => {})
      .then(() =>
        photos
          ? Promise.all(
              Object.entries(photos).map(([id, url]) =>
                idbPut(id, url).catch((err) => console.warn("Poză neimportată:", id, err))
              )
            )
          : Promise.resolve()
      );
    el.backupStatus.textContent = "Import reușit. Reîncarc aplicația...";
    writePhotos.finally(() => setTimeout(() => location.reload(), 500));
  };
  reader.onerror = () => {
    el.backupStatus.textContent = "Nu am putut citi fișierul.";
  };
  reader.readAsText(file);
}

el.exportBtn.addEventListener("click", exportBackup);
el.importBtn.addEventListener("click", () => el.importInput.click());
el.importInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) importBackup(file);
  el.importInput.value = ""; // permite reimportarea aceluiași fișier
});

// ---------------- Adăugare manuală (poză + notițe + dată/oră alese) ----------------
let manualFile = null;
let pendingManual = null; // { thumb, result }

el.addManualBtn.addEventListener("click", openManualModal);
el.manualCancel.addEventListener("click", closeManualModal);
el.manualModal.addEventListener("click", (e) => {
  if (e.target === el.manualModal) closeManualModal(); // click pe fundal = închide
});

// Data/ora implicită pentru o intrare nouă adăugată din Statistici: ziua selectată (mod „Zi")
// combinată cu ora curentă. Dacă ziua selectată e chiar azi (sau nu suntem pe mod „Zi"), e „acum".
// Valoarea rămâne editabilă în modal; doar punctul de pornire se schimbă, pentru comoditate.
function defaultEntryDatetime() {
  const now = new Date();
  if (statsPeriod.mode === "day") {
    const [day] = periodRangeFor(statsPeriod); // YYYY-MM-DD
    if (day < todayStr()) {
      const [y, m, d] = day.split("-").map(Number);
      return toDatetimeLocal(new Date(y, m - 1, d, now.getHours(), now.getMinutes()));
    }
  }
  return toDatetimeLocal(now);
}

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
  el.manualDatetime.value = defaultEntryDatetime(); // ziua selectată pe Statistici + ora curentă
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
  const src = photoFor(entry.id) || entry.thumb;
  const thumb = src
    ? `<img src="${src}" alt="${escapeHtml(entry.food_name)}" />`
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
    thumb: photoFor(s.id) || s.thumb,
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
// Cardul „Datele mele" de pe Statistici e doar afișare. Toate valorile sunt preluate automat:
// greutatea + vârsta la data cerută (implicit azi), plus sexul și înălțimea din profil.
function fillProfileCard(atDate) {
  const p = loadProfile();
  const date = atDate || todayStr();
  if (p && profileComplete(p)) {
    el.profileSexVal.textContent = p.sex === "F" ? "Femeie" : "Bărbat";
    el.profileAgeVal.textContent = `${ageFromBirthdate(p.birthdate, date)} ani`;
    el.profileHeightVal.textContent = `${p.height_cm} cm`;
    const w = weightForDate(date);
    el.profileWeightVal.textContent = w ? `${w} kg` : "–";
  } else {
    el.profileSexVal.textContent = "–";
    el.profileAgeVal.textContent = "–";
    el.profileHeightVal.textContent = "–";
    el.profileWeightVal.textContent = "–";
  }
  renderProfileSummary();
  syncActivityControl();
}

// IMC + kcal arse/zi pentru perioada selectată pe Statistici (cardul e dinamic pe perioadă).
function renderProfileSummary() {
  const p = loadProfile();
  if (!profileComplete(p)) {
    el.profileSummary.innerHTML = "";
    return;
  }
  const [start, end] = periodRangeFor(statsPeriod);
  const w = weightForDate(end); // greutatea la sfârșitul perioadei
  const bmi = computeBmi(w, p.height_cm);
  const burn = avgBodyBurnForPeriod(start, end);
  const burnLbl =
    statsPeriod.mode === "day" ? "kcal arse de corp/zi" : "kcal arse de corp/zi (medie)";
  el.profileSummary.innerHTML = `
    <div class="profile-metric">
      <div class="val">${bmi.toFixed(1)}</div>
      <div class="lbl">IMC · ${bmiCategory(bmi)}</div>
    </div>
    <div class="profile-metric">
      <div class="val">${burn}</div>
      <div class="lbl">${burnLbl}</div>
    </div>`;
}

// Pune în dropdown nivelul perioadei selectate (sau placeholder-ul „mixt" dacă zilele diferă).
function syncActivityControl() {
  const [start, end] = periodRangeFor(statsPeriod);
  el.profileActivity.value = periodActivityLevel(start, end) || "";
}

// Alegerea unui nivel îl aplică pe TOATĂ perioada selectată (suprascrie) și recalculează.
el.profileActivity.addEventListener("change", () => {
  const level = el.profileActivity.value;
  if (!level) return; // placeholder-ul „mixt", nu se poate alege efectiv
  const [start, end] = periodRangeFor(statsPeriod);
  setActivityForRange(start, end, level);
  renderStats(); // recalculează cardul + deficitul + lista
  const label = start === end ? prettyDate(start) : `${prettyDate(start)} - ${prettyDate(end)}`;
  el.activityStatus.textContent = `Nivel aplicat pe ${label} ✓`;
  setTimeout(() => {
    el.activityStatus.textContent = "";
  }, 2000);
});

// Butonul „Modifică datele" de pe Statistici deschide formularul de pe Acasă, precompletat,
// chiar dacă profilul e deja complet (altfel n-ai ce edita).
el.profileEdit.addEventListener("click", () => {
  switchView("home");
  el.onboardingCard.classList.remove("hidden");
  prefillOnboarding();
  el.onboardingCard.scrollIntoView({ behavior: "smooth", block: "start" });
});

// ---------------- Formular date personale (Acasă) ----------------
// Prefill: pentru userii care au deja date (sau schema veche), completăm ce știm deja,
// ca migrarea să fie „completează data nașterii și salvează".
function prefillOnboarding() {
  const p = loadProfile();
  if (p) {
    if (p.sex) el.onbSex.value = p.sex;
    if (p.birthdate) el.onbBirthdate.value = p.birthdate;
    if (p.height_cm) el.onbHeight.value = p.height_cm;
  }
  const w = weightForDate(todayStr());
  el.onbWeight.value = w || "";
  // Nu poți alege o dată a nașterii din viitor.
  el.onbBirthdate.max = todayStr();
}

// Formularul apare cât timp profilul e incomplet în schema nouă (lipsă sex/dată naștere/înălțime,
// sau nicio greutate). Prinde automat și userii vechi: ei au `age`, dar nu `birthdate`.
function showOnboardingIfNeeded() {
  const need = !profileComplete(loadProfile());
  el.onboardingCard.classList.toggle("hidden", !need);
  if (need) prefillOnboarding();
}

el.onbSave.addEventListener("click", () => {
  const sex = el.onbSex.value;
  const birthdate = el.onbBirthdate.value; // YYYY-MM-DD
  const height_cm = parseFloat(el.onbHeight.value);
  const weight_kg = parseDecimal(el.onbWeight.value);

  if (!sex || !birthdate || !height_cm || !weight_kg) {
    el.onbStatus.textContent = "Completează toate câmpurile.";
    return;
  }
  if (birthdate > todayStr()) {
    el.onbStatus.textContent = "Data nașterii nu poate fi în viitor.";
    return;
  }
  const age = ageFromBirthdate(birthdate);
  if (age < 1 || age > 120) {
    el.onbStatus.textContent = "Verifică data nașterii.";
    return;
  }
  if (height_cm < 50 || height_cm > 250) {
    el.onbStatus.textContent = "Introdu o înălțime validă (50 - 250 cm).";
    return;
  }
  if (weight_kg < 20 || weight_kg > 400) {
    el.onbStatus.textContent = "Introdu o greutate validă (20 - 400 kg).";
    return;
  }

  // Greutatea trece prin sistemul de cântăriri (unica sursă de adevăr), doar dacă diferă de
  // ultima cântărire de azi - ca să nu creăm dubluri la userii care se cântăresc deja.
  if (weightForDate(todayStr()) !== weight_kg) {
    addWeight({ id: newId(), ts: Date.now(), date: todayStr(), weight_kg });
  }
  saveProfile({ sex, birthdate, height_cm, weight_kg });

  el.onbStatus.textContent = "Salvat ✓";
  showOnboardingIfNeeded(); // profilul e complet acum -> formularul se ascunde
  fillProfileCard(todayStr());
  renderStats(); // cardul + deficitul depind de profil
  renderWeigh();
  setTimeout(() => {
    el.onbStatus.textContent = "";
  }, 2000);
});

// ---------------- Adăugare exercițiu (text -> Claude -> calorii arse) ----------------
let pendingExercise = null; // { activities, total_calories, total_duration_min, summary }
let exerciseEstimateDate = null; // ziua pentru care s-a calculat estimarea curentă (greutatea ei)

// Ziua (YYYY-MM-DD) aleasă în câmpul de dată al exercițiului (implicit azi).
function exerciseDateFromField() {
  return el.exerciseDatetime.value
    ? dateStrFromTs(new Date(el.exerciseDatetime.value).getTime())
    : todayStr();
}

el.homeAddExercise.addEventListener("click", () => openExerciseModal(false)); // Acasă: mereu „acum"
el.addExerciseBtn.addEventListener("click", () => openExerciseModal(true)); // Statistici: ziua selectată
el.exerciseCancel.addEventListener("click", closeExerciseModal);
el.exerciseModal.addEventListener("click", (e) => {
  if (e.target === el.exerciseModal) closeExerciseModal();
});

function openExerciseModal(useSelectedDay) {
  pendingExercise = null;
  exerciseEstimateDate = null;
  el.exerciseText.value = "";
  el.exerciseResult.innerHTML = "";
  el.exerciseResult.classList.add("hidden");
  el.exerciseStatus.textContent = "";
  const now = new Date();
  // De pe Statistici: ziua selectată + ora curentă. De pe Acasă („Astăzi"): mereu acum.
  el.exerciseDatetime.value = useSelectedDay ? defaultEntryDatetime() : toDatetimeLocal(now);
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
      "Completează întâi profilul (Datele mele) și loghează o greutate (pagina Cântărire).";
    return;
  }
  // Greutatea folosită la estimare = cea a zilei alese pentru exercițiu (nu cea de azi),
  // ca să pot loga corect și exerciții pentru zile din trecut.
  const exDate = exerciseDateFromField();
  const exWeight = weightForDate(exDate);
  el.exerciseEstimate.disabled = true;
  el.exerciseSave.disabled = true;
  el.exerciseResult.classList.add("hidden");
  el.exerciseStatus.textContent = "Estimez... (poate dura câteva secunde)";
  try {
    const res = await fetch(EXERCISE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, weight_kg: exWeight })
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
    pendingExercise.weight_kg = exWeight; // reținem greutatea folosită la calcul
    exerciseEstimateDate = exDate; // și ziua pentru care s-a calculat
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

// Dacă schimbi ZIUA după ce ai estimat, greutatea acelei zile poate diferi -> estimarea nu mai e
// validă. O invalidăm și ceri o nouă estimare (schimbarea doar a orei, în aceeași zi, nu contează).
el.exerciseDatetime.addEventListener("change", () => {
  if (!pendingExercise) return;
  if (exerciseDateFromField() === exerciseEstimateDate) return;
  pendingExercise = null;
  exerciseEstimateDate = null;
  el.exerciseResult.innerHTML = "";
  el.exerciseResult.classList.add("hidden");
  el.exerciseSave.disabled = true;
  el.exerciseStatus.textContent =
    "Ai schimbat ziua. Apasă din nou „Estimează” (se folosește greutatea din ziua aleasă).";
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
    activities: d.activities,
    weight_kg: d.weight_kg // greutatea folosită la calcul (ziua aleasă)
  });
  closeExerciseModal();
  goToDay(ts); // sari la ziua exercițiului
  switchView("stats");
});

// ---------------- Selector de perioadă (reutilizat: Statistici + Cântărire) ----------------
function makePeriodState() {
  return {
    mode: "day", // day | week | month | year | custom
    anchor: new Date(), // referință pentru zi/săpt/lună/an
    customStart: todayStr(),
    customEnd: todayStr()
  };
}
const statsPeriod = makePeriodState();
const weighPeriod = makePeriodState();
let statsCfg = null; // configurările de wiring, completate la init
let weighCfg = null;

// Intervalul [start, end] (YYYY-MM-DD, inclusiv la ambele capete) pentru o stare de perioadă.
function periodRangeFor(st) {
  if (st.mode === "custom") {
    return st.customStart <= st.customEnd
      ? [st.customStart, st.customEnd]
      : [st.customEnd, st.customStart];
  }
  const d = new Date(st.anchor);
  if (st.mode === "day") {
    const s = dateStrFromDate(d);
    return [s, s];
  }
  if (st.mode === "week") {
    const offset = (d.getDay() + 6) % 7; // 0 = luni
    const start = new Date(d);
    start.setDate(d.getDate() - offset);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return [dateStrFromDate(start), dateStrFromDate(end)];
  }
  if (st.mode === "month") {
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return [dateStrFromDate(start), dateStrFromDate(end)];
  }
  // year
  const start = new Date(d.getFullYear(), 0, 1);
  const end = new Date(d.getFullYear(), 11, 31);
  return [dateStrFromDate(start), dateStrFromDate(end)];
}

function periodLabelTextFor(st, start, end) {
  if (st.mode === "day") return prettyDate(start);
  if (st.mode === "year") return start.slice(0, 4);
  if (st.mode === "month") {
    const label = new Date(st.anchor).toLocaleDateString("ro-RO", {
      month: "long",
      year: "numeric"
    });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  // week + custom: interval
  return `${prettyDate(start)} - ${prettyDate(end)}`;
}

// Sincronizează butoanele + ce se vede (navigare vs interval) cu modul curent.
function syncPeriodUI(cfg) {
  cfg.modes.querySelectorAll(".period-mode").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === cfg.state.mode);
  });
  cfg.nav.classList.toggle("hidden", cfg.state.mode === "custom");
  cfg.range.classList.toggle("hidden", cfg.state.mode !== "custom");
}

// Limitele câmpurilor de „Interval": între prima zi cu date (podea) și azi.
function applyRangeBounds(cfg) {
  cfg.rangeStart.min = cfg.rangeEnd.min = historyFloor();
  cfg.rangeStart.max = cfg.rangeEnd.max = todayStr();
}

function setPeriodMode(cfg, mode) {
  cfg.state.mode = mode;
  if (mode === "custom") {
    cfg.state.customStart = todayStr();
    cfg.state.customEnd = todayStr();
    cfg.rangeStart.value = cfg.state.customStart;
    cfg.rangeEnd.value = cfg.state.customEnd;
    applyRangeBounds(cfg); // podeaua se poate extinde dacă între timp ai backfill-uit date
  } else {
    cfg.state.anchor = new Date();
  }
  syncPeriodUI(cfg);
  cfg.render();
}

function shiftPeriod(cfg, dir) {
  const st = cfg.state;
  const d = new Date(st.anchor);
  if (st.mode === "day") d.setDate(d.getDate() + dir);
  else if (st.mode === "week") d.setDate(d.getDate() + dir * 7);
  else if (st.mode === "month") d.setMonth(d.getMonth() + dir);
  else if (st.mode === "year") d.setFullYear(d.getFullYear() + dir);
  st.anchor = d;
  cfg.render();
}

// Leagă evenimentele pentru un selector de perioadă (elementele DOM + stare + callback render).
function setupPeriodSelector(cfg) {
  cfg.modes.addEventListener("click", (e) => {
    const btn = e.target.closest(".period-mode");
    if (btn) setPeriodMode(cfg, btn.dataset.mode);
  });
  cfg.prev.addEventListener("click", () => shiftPeriod(cfg, -1));
  cfg.next.addEventListener("click", () => shiftPeriod(cfg, 1));
  cfg.rangeStart.addEventListener("change", () => {
    cfg.state.customStart = cfg.rangeStart.value || todayStr();
    cfg.render();
  });
  cfg.rangeEnd.addEventListener("change", () => {
    cfg.state.customEnd = cfg.rangeEnd.value || todayStr();
    cfg.render();
  });
  cfg.rangeStart.value = cfg.state.customStart;
  cfg.rangeEnd.value = cfg.state.customEnd;
  applyRangeBounds(cfg); // min = prima zi cu date, max = azi (fără viitor, fără dinainte de folosire)
  // Click pe etichetă => deschide calendarul (salt direct la zi/săpt./lună/an).
  cfg.label.classList.add("pp-clickable");
  cfg.label.addEventListener("click", () => openPeriodPicker(cfg));
}

// Sari la vederea pe o zi anume pe Statistici (folosit după ce adaugi o masă/exercițiu).
function goToDay(ts) {
  statsPeriod.mode = "day";
  statsPeriod.anchor = new Date(ts);
  if (statsCfg) syncPeriodUI(statsCfg);
  renderStats();
}

// ---------------- Selector prin calendar (click pe eticheta perioadei) ----------------
// Deschide un calendar peste selector ca să sari direct la o zi/săptămână/lună/an, fără zeci de
// click-uri pe săgeți. Modul curent (Zi/Săpt./Lună/An) decide ce alegi. „Interval" nu are calendar
// aici: are deja câmpurile lui de dată.
const MONTHS_RO = [
  "Ianuarie", "Februarie", "Martie", "Aprilie", "Mai", "Iunie",
  "Iulie", "August", "Septembrie", "Octombrie", "Noiembrie", "Decembrie"
];
const MONTHS_RO_SHORT = [
  "Ian", "Feb", "Mar", "Apr", "Mai", "Iun",
  "Iul", "Aug", "Sep", "Oct", "Nov", "Dec"
];
const WEEKDAYS_RO = ["Lu", "Ma", "Mi", "Jo", "Vi", "Sâ", "Du"];

let pickerCfg = null;  // selectorul editat (statsCfg / weighCfg)
let pickerView = null; // luna/anul afișat în calendar (diferit de selecția efectivă)

function openPeriodPicker(cfg) {
  if (cfg.state.mode === "custom") return; // intervalul are deja câmpurile lui
  pickerCfg = cfg;
  pickerView = new Date(cfg.state.anchor);
  renderPeriodPicker();
  el.periodPicker.classList.remove("hidden");
}
function closePeriodPicker() {
  el.periodPicker.classList.add("hidden");
  pickerCfg = null;
}

function renderPeriodPicker() {
  const mode = pickerCfg.state.mode;
  if (mode === "day") renderPickerDays();
  else if (mode === "week") renderPickerWeeks();
  else if (mode === "month") renderPickerMonths();
  else renderPickerYears();
}

// Prima zi (luni) a gridului de 6 săptămâni pentru luna afișată în calendar.
function pickerGridStart() {
  const y = pickerView.getFullYear();
  const m = pickerView.getMonth();
  const first = new Date(y, m, 1);
  const offset = (first.getDay() + 6) % 7; // luni = 0
  return new Date(y, m, 1 - offset);
}

// Săgeata „›" nu duce în luna/anul viitor (nu putem alege perioade din viitor).
function pickerNextDisabledForMonth() {
  const now = new Date();
  const y = pickerView.getFullYear();
  const m = pickerView.getMonth();
  return y > now.getFullYear() || (y === now.getFullYear() && m >= now.getMonth());
}

// Săgeata „‹" nu duce înainte de luna primei zile cu date (podeaua). Luna care conține podeaua
// rămâne accesibilă (poate avea zile utile), dar lunile integral dinainte, nu.
function pickerPrevDisabledForMonth() {
  const floor = historyFloor();
  const fy = Number(floor.slice(0, 4));
  const fm = Number(floor.slice(5, 7)) - 1;
  const y = pickerView.getFullYear();
  const m = pickerView.getMonth();
  return y < fy || (y === fy && m <= fm);
}

function renderPickerDays() {
  const m = pickerView.getMonth();
  el.ppTitle.textContent = `${MONTHS_RO[m]} ${pickerView.getFullYear()}`;
  el.ppPrev.disabled = pickerPrevDisabledForMonth();
  el.ppNext.disabled = pickerNextDisabledForMonth();

  const today = todayStr();
  const floor = historyFloor();
  const [selStart, selEnd] = periodRangeFor(pickerCfg.state);
  const gridStart = pickerGridStart();
  let cells = "";
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    const ds = dateStrFromDate(d);
    const cls = [
      "pp-day",
      d.getMonth() === m ? "" : "pp-out",
      ds >= selStart && ds <= selEnd ? "pp-selected" : "",
      ds === today ? "pp-today" : ""
    ].filter(Boolean).join(" ");
    cells += `<button type="button" class="${cls}" data-date="${ds}" ${ds > today || ds < floor ? "disabled" : ""}>${d.getDate()}</button>`;
  }
  el.ppBody.innerHTML =
    `<div class="pp-weekdays">${WEEKDAYS_RO.map((w) => `<span>${w}</span>`).join("")}</div>` +
    `<div class="pp-grid">${cells}</div>`;
}

function renderPickerWeeks() {
  const m = pickerView.getMonth();
  el.ppTitle.textContent = `${MONTHS_RO[m]} ${pickerView.getFullYear()}`;
  el.ppPrev.disabled = pickerPrevDisabledForMonth();
  el.ppNext.disabled = pickerNextDisabledForMonth();

  const today = todayStr();
  const floor = historyFloor();
  const [selStart] = periodRangeFor(pickerCfg.state); // lunea săptămânii selectate
  const gridStart = pickerGridStart();
  let rows = "";
  for (let r = 0; r < 6; r++) {
    const rowStart = new Date(gridStart);
    rowStart.setDate(gridStart.getDate() + r * 7);
    const rowStartStr = dateStrFromDate(rowStart); // e mereu o zi de luni
    const rowEnd = new Date(rowStart);
    rowEnd.setDate(rowStart.getDate() + 6);
    const rowEndStr = dateStrFromDate(rowEnd); // duminica săptămânii
    let days = "";
    for (let c = 0; c < 7; c++) {
      const d = new Date(rowStart);
      d.setDate(rowStart.getDate() + c);
      const dcls = [
        "pp-wd",
        d.getMonth() === m ? "" : "pp-out",
        dateStrFromDate(d) === today ? "pp-today" : ""
      ].filter(Boolean).join(" ");
      days += `<span class="${dcls}">${d.getDate()}</span>`;
    }
    const selected = rowStartStr === selStart ? "pp-selected" : "";
    // Săptămâna e blocată dacă începe în viitor sau se termină integral înainte de podea.
    const disabled = rowStartStr > today || rowEndStr < floor;
    rows += `<button type="button" class="pp-week-row ${selected}" data-date="${rowStartStr}" ${disabled ? "disabled" : ""}>${days}</button>`;
  }
  el.ppBody.innerHTML =
    `<div class="pp-weekdays">${WEEKDAYS_RO.map((w) => `<span>${w}</span>`).join("")}</div>` +
    `<div class="pp-weeks">${rows}</div>`;
}

function renderPickerMonths() {
  const y = pickerView.getFullYear();
  const now = new Date();
  const floor = historyFloor();
  const fy = Number(floor.slice(0, 4));
  const fm = Number(floor.slice(5, 7)) - 1;
  el.ppTitle.textContent = String(y);
  el.ppPrev.disabled = y <= fy; // anul de sub podea nu are luni utile
  el.ppNext.disabled = y >= now.getFullYear();

  const [selStart] = periodRangeFor(pickerCfg.state);
  const selY = Number(selStart.slice(0, 4));
  const selM = Number(selStart.slice(5, 7)) - 1;
  let cells = "";
  for (let mo = 0; mo < 12; mo++) {
    const future = y > now.getFullYear() || (y === now.getFullYear() && mo > now.getMonth());
    const belowFloor = y < fy || (y === fy && mo < fm); // luna integral dinainte de prima folosire
    const disabled = future || belowFloor;
    const selected = y === selY && mo === selM ? "pp-selected" : "";
    cells += `<button type="button" class="pp-month ${selected}" data-month="${mo}" ${disabled ? "disabled" : ""}>${MONTHS_RO_SHORT[mo]}</button>`;
  }
  el.ppBody.innerHTML = `<div class="pp-months">${cells}</div>`;
}

function renderPickerYears() {
  const now = new Date();
  const fy = Number(historyFloor().slice(0, 4));
  const base = Math.floor(pickerView.getFullYear() / 12) * 12;
  el.ppTitle.textContent = `${base} - ${base + 11}`;
  el.ppPrev.disabled = base <= fy; // blocul dinainte e integral sub podea
  el.ppNext.disabled = base + 12 > now.getFullYear();

  const [selStart] = periodRangeFor(pickerCfg.state);
  const selY = Number(selStart.slice(0, 4));
  let cells = "";
  for (let i = 0; i < 12; i++) {
    const yr = base + i;
    const selected = yr === selY ? "pp-selected" : "";
    const disabled = yr > now.getFullYear() || yr < fy;
    cells += `<button type="button" class="pp-year ${selected}" data-year="${yr}" ${disabled ? "disabled" : ""}>${yr}</button>`;
  }
  el.ppBody.innerHTML = `<div class="pp-years">${cells}</div>`;
}

// Săgețile calendarului schimbă doar ce se vede, nu selecția.
function shiftPicker(dir) {
  const mode = pickerCfg.state.mode;
  if (mode === "day" || mode === "week") pickerView.setMonth(pickerView.getMonth() + dir);
  else if (mode === "month") pickerView.setFullYear(pickerView.getFullYear() + dir);
  else pickerView.setFullYear(pickerView.getFullYear() + dir * 12);
  renderPeriodPicker();
}
el.ppPrev.addEventListener("click", () => shiftPicker(-1));
el.ppNext.addEventListener("click", () => shiftPicker(1));

// Alegerea unei celule aplică selecția pe selectorul curent și re-randează pagina.
el.ppBody.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn || btn.disabled || !pickerCfg) return;
  const cfg = pickerCfg;
  const st = cfg.state;
  if (btn.dataset.date !== undefined) {
    st.anchor = new Date(btn.dataset.date + "T12:00:00"); // zi sau lunea săptămânii
  } else if (btn.dataset.month !== undefined) {
    st.anchor = new Date(pickerView.getFullYear(), Number(btn.dataset.month), 1, 12);
  } else if (btn.dataset.year !== undefined) {
    st.anchor = new Date(Number(btn.dataset.year), 0, 1, 12);
  } else {
    return;
  }
  closePeriodPicker();
  cfg.render();
});

// Închidere la click pe fundal.
el.periodPicker.addEventListener("click", (e) => {
  if (e.target === el.periodPicker) closePeriodPicker();
});

// ---------------- Calcul agregat pe o perioadă (folosit de Statistici ȘI Rapoarte) ----------------
function computePeriodStats(start, end) {
  const items = loadEntries()
    .filter((e) => e.date >= start && e.date <= end)
    .sort((a, b) => a.ts - b.ts);
  const meals = items.filter((e) => !isExercise(e));
  const exercises = items.filter(isExercise);
  // Total mâncat (doar mese) - caloriile arse din exerciții se numără separat.
  const eaten = meals.reduce(
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
  // Zile distincte cu intrări (informativ: câte zile chiar ai logat ceva).
  const dayKeys = [...new Set(items.map((e) => e.date))].sort();

  // Mediem pe zilele TRĂITE din perioadă: de la max(început, podea) până azi inclusiv, fără viitor.
  // Toate aceste zile contează la medii (chiar și cele fără nimic logat), fiindcă le-ai trăit efectiv.
  // „Podeaua" exclude zilele dinainte de prima folosire (ex: o săptămână care calcă pe prima zi
  // numără doar de la prima zi încolo, nu și zilele goale dinainte).
  const today = todayStr();
  const effStart = maxDateStr(start, historyFloor());
  const effEnd = end < today ? end : today;
  const hasPast = effStart <= effEnd;
  const effectiveDayCount = hasPast ? countDaysInclusive(effStart, effEnd) : 0;

  // Arse de corp: suma pe fiecare zi trăită din perioadă (cu greutatea/activitatea din ziua ei).
  let bodyBurnTotal = 0;
  if (profileComplete(loadProfile()) && hasPast) {
    eachDayInclusive(effStart, effEnd, (d) => {
      bodyBurnTotal += bodyBurnForDate(d);
    });
  }

  const weights = loadWeights()
    .filter((w) => w.date >= start && w.date <= end)
    .sort((a, b) => a.ts - b.ts);
  return {
    items,
    meals,
    exercises,
    eaten,
    burnedActive,
    dayKeys,
    dayCount: dayKeys.length,
    effectiveDayCount,
    bodyBurnTotal,
    weights
  };
}

// Blocul cu deficitul caloric: arse de corp + arse activ - mâncate.
// Pe modul "Zi" arată ziua respectivă; pe perioade mai lungi arată media zilnică.
function deficitHtml(eatenTotal, burnedActiveTotal, bodyBurnTotal, effectiveDayCount, mode) {
  const p = loadProfile();
  if (!profileComplete(p)) {
    return `<div class="deficit-hint">Completează „Datele mele" (pe modul Zi) ca să vezi deficitul caloric.</div>`;
  }

  let baseTitle, eaten, burnedActive, burnBody, suffix;
  if (mode === "day") {
    baseTitle = "caloric";
    eaten = eatenTotal;
    burnedActive = burnedActiveTotal;
    burnBody = bodyBurnTotal;
    suffix = "";
  } else if (effectiveDayCount >= 1) {
    baseTitle = "mediu zilnic";
    eaten = Math.round(eatenTotal / effectiveDayCount);
    burnedActive = Math.round(burnedActiveTotal / effectiveDayCount);
    burnBody = Math.round(bodyBurnTotal / effectiveDayCount);
    suffix = "/zi";
  } else {
    return ""; // perioadă fără date: nimic de mediat
  }

  const deficit = burnBody + burnedActive - eaten;
  const isDeficit = deficit >= 0;
  // Titlul urmează semnul: „Deficit …" sau „Surplus …", consistent cu valoarea de dedesubt.
  const title = `${isDeficit ? "Deficit" : "Surplus"} ${baseTitle}`;
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
  const [start, end] = periodRangeFor(statsPeriod);
  el.periodLabel.textContent = periodLabelTextFor(statsPeriod, start, end);
  // Nu putem naviga în viitor: dezactivează ">" când perioada ajunge la ziua de azi.
  el.periodNext.disabled = end >= todayStr();
  // Nici înainte de prima zi cu date: dezactivează "<" când perioada atinge/coboară sub podea.
  el.periodPrev.disabled = start <= historyFloor();

  // Butoanele „Adaugă o masă / exercițiu" au sens doar pe o zi anume (ziua devine data
  // implicită a intrării). Pe perioade mai lungi (săpt./lună/an/interval) le ascundem.
  el.addRow.classList.toggle("hidden", statsPeriod.mode !== "day");

  // Cardul „Datele mele" (IMC, kcal, date personale) are sens doar pe o zi anume — un singur IMC
  // pentru o perioadă mai mare ar fi înșelător. Nivelul de activitate stă separat, mereu vizibil.
  el.profileCard.classList.toggle("hidden", statsPeriod.mode !== "day");

  // Cardul „Datele mele" e dinamic pe perioada selectată: greutatea și vârsta = cele de la
  // sfârșitul perioadei (pentru „Zi", cele din acea zi). fillProfileCard face și summary + activitate.
  fillProfileCard(end);

  const s = computePeriodStats(start, end);
  const { items, meals, exercises, eaten: sum, burnedActive, effectiveDayCount } = s;

  const countParts = [`${meals.length} ${meals.length === 1 ? "masă" : "mese"}`];
  if (exercises.length) {
    countParts.push(
      `${exercises.length} ${exercises.length === 1 ? "exercițiu" : "exerciții"}`
    );
  }
  const countLbl = countParts.join(" · ");
  const totalLbl =
    effectiveDayCount >= 2
      ? `Total perioadă · ${countLbl} · ${effectiveDayCount} zile`
      : `Total · ${countLbl}`;

  // Media zilnică apare când perioada acoperă cel puțin 2 zile trăite (pe o zi ar fi redundantă).
  let avgHtml = "";
  if (effectiveDayCount >= 2) {
    avgHtml = `
      <div class="total-avg">
        Media zilnică: <b>${Math.round(sum.calories / effectiveDayCount)} kcal</b>
        · ${Math.round(sum.protein_g / effectiveDayCount)}P
        / ${Math.round(sum.carbs_g / effectiveDayCount)}C
        / ${Math.round(sum.fat_g / effectiveDayCount)}G
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
    ${deficitHtml(sum.calories, burnedActive, s.bodyBurnTotal, effectiveDayCount, statsPeriod.mode)}
  `;

  if (items.length === 0) {
    el.entries.innerHTML = `<div class="empty">Nicio masă în perioada aleasă.</div>`;
    return;
  }

  // Împărțim pe categorii: mesele primele, exercițiile dedesubt. În fiecare categorie grupăm pe
  // zile (antet doar când perioada acoperă mai multe zile), cu cea mai recentă zi sus și, în
  // fiecare zi, cele mai recente intrări sus (descrescător cronologic).
  const showDayHeaders = new Set(items.map((e) => e.date)).size > 1;

  const categoryHtml = (list, title) => {
    if (!list.length) return "";
    const byDay = new Map();
    for (const e of list) {
      if (!byDay.has(e.date)) byDay.set(e.date, []);
      byDay.get(e.date).push(e);
    }
    const days = [...byDay.keys()].sort().reverse(); // cea mai recentă zi sus
    const body = days
      .map((date) => {
        const dayItems = byDay.get(date).slice().sort((a, b) => b.ts - a.ts); // recent sus
        const dayKcal = dayItems.reduce((a, e) => a + e.calories, 0);
        const header = showDayHeaders
          ? `<div class="day-header"><span>${prettyDate(date)}</span><span>${dayKcal} kcal</span></div>`
          : "";
        return header + dayItems.map(entryHtml).join("");
      })
      .join("");
    return `<div class="entry-category"><div class="entry-category-title">${title}</div>${body}</div>`;
  };

  el.entries.innerHTML =
    categoryHtml(items.filter((e) => !isExercise(e)), "🍽 Mese") +
    categoryHtml(items.filter(isExercise), "🏃 Exerciții");
}

function entryHtml(e) {
  if (isExercise(e)) return exerciseEntryHtml(e);
  const src = photoFor(e.id) || e.thumb;
  const thumb = src
    ? `<img src="${src}" class="entry-thumb" alt="${escapeHtml(e.food_name)}" />`
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
  const src = photoFor(e.id) || e.thumb;
  const thumb = src
    ? `<img src="${src}" class="detail-photo" alt="${escapeHtml(e.food_name)}" />`
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
const VIEW_CONFIG = {
  home: { section: "viewHome", title: "Astăzi" },
  stats: { section: "viewStats", title: "Statistici" },
  weigh: { section: "viewWeigh", title: "Cântărire" },
  reports: { section: "viewReports", title: "Rapoarte" }
};
let currentView = null;

function switchView(view) {
  if (!VIEW_CONFIG[view]) view = "home";
  // Când intri pe Rapoarte dintr-o altă pagină, pornești mereu de la listă.
  if (view === "reports" && currentView !== "reports") openReportId = null;
  localStorage.setItem(VIEW_KEY, view); // ține minte pagina la refresh
  Object.entries(VIEW_CONFIG).forEach(([v, cfg]) => {
    el[cfg.section].classList.toggle("active", v === view);
  });
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.view === view);
  });
  el.headerTitle.textContent = VIEW_CONFIG[view].title;
  currentView = view;
  if (view === "home") showOnboardingIfNeeded();
  else if (view === "stats") renderStats();
  else if (view === "weigh") {
    // La intrarea pe pagină, pornește formularul de la „acum".
    const now = toDatetimeLocal(new Date());
    el.weighDatetime.value = now;
    el.weighDatetime.max = now;
    renderWeigh();
  } else if (view === "reports") renderReports();
}
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
});

// ---------------- Cântărire (log greutate + istoric) ----------------
// Ține profilul sincronizat cu ultima cântărire (greutatea din „Datele mele" e read-only).
function syncProfileWeight() {
  const p = loadProfile();
  if (!p) return;
  const w = weightForDate(todayStr());
  if (w) {
    p.weight_kg = w;
    saveProfile(p);
  }
}

el.weighSave.addEventListener("click", () => {
  const val = parseDecimal(el.weighInput.value);
  if (!val || val < 20 || val > 400) {
    el.weighStatus.textContent = "Introdu o greutate validă (20 - 400 kg).";
    return;
  }
  const dtVal = el.weighDatetime.value;
  if (!dtVal) {
    el.weighStatus.textContent = "Alege data și ora.";
    return;
  }
  const ts = new Date(dtVal).getTime();
  if (ts > Date.now()) {
    el.weighStatus.textContent = "Nu poți alege o dată/oră din viitor.";
    return;
  }
  addWeight({ id: newId(), ts, date: dateStrFromTs(ts), weight_kg: val });
  syncProfileWeight();
  el.weighInput.value = "";
  el.weighStatus.textContent = "Salvat ✓";
  setTimeout(() => {
    el.weighStatus.textContent = "";
  }, 2000);
  renderWeigh();
  fillProfileCard(); // reîmprospătează greutatea + IMC/arse din „Datele mele"
  showOnboardingIfNeeded(); // dacă lipseau doar datele, actualizează formularul de pe Acasă
});

function renderWeigh() {
  const [start, end] = periodRangeFor(weighPeriod);
  el.weighPeriodLabel.textContent = periodLabelTextFor(weighPeriod, start, end);
  el.weighPeriodNext.disabled = end >= todayStr();
  el.weighPeriodPrev.disabled = start <= historyFloor();

  const ws = loadWeights()
    .filter((w) => w.date >= start && w.date <= end)
    .sort((a, b) => b.ts - a.ts);
  if (ws.length === 0) {
    el.weighHistory.innerHTML = `<div class="empty">Nicio cântărire în perioada aleasă.</div>`;
    return;
  }
  el.weighHistory.innerHTML = ws.map(weighRowHtml).join("");
}

function weighRowHtml(w) {
  return `
    <div class="weigh-row" data-id="${w.id}">
      <div class="weigh-info">
        <div class="weigh-kg">${w.weight_kg} kg</div>
        <div class="weigh-when">${prettyDate(w.date)} · ${prettyTime(w.ts)}</div>
      </div>
      <button class="del" data-id="${w.id}" title="Șterge">🗑</button>
    </div>`;
}

el.weighHistory.addEventListener("click", (e) => {
  const del = e.target.closest(".del");
  if (!del) return;
  deleteWeight(del.dataset.id);
  syncProfileWeight();
  renderWeigh();
  fillProfileCard();
  showOnboardingIfNeeded();
});

// ---------------- Rapoarte ----------------
let openReportId = null; // id-ul raportului deschis (null = lista)

// Creează un raport pentru perioada selectată pe o pagină și navighează la Rapoarte.
function createReport(period) {
  const [start, end] = periodRangeFor(period);
  const title =
    start === end
      ? `Raport ${prettyDate(start)}`
      : `Raport ${prettyDate(start)} - ${prettyDate(end)}`;
  const reps = loadReports();
  reps.push({ id: newId(), createdTs: Date.now(), mode: period.mode, start, end, title });
  saveReports(reps);
  openReportId = null; // aterizezi pe listă, cu raportul nou sus
  switchView("reports");
}

function renderReports() {
  if (openReportId) {
    renderOpenReport();
    return;
  }
  el.reportDetail.classList.add("hidden");
  el.reportDetail.innerHTML = "";
  el.reportsList.classList.remove("hidden");
  const reps = loadReports().sort((a, b) => b.createdTs - a.createdTs);
  if (reps.length === 0) {
    el.reportsList.innerHTML = `<div class="empty">Niciun raport încă. Apasă „Creează Raport" pe Statistici sau Cântărire.</div>`;
    return;
  }
  el.reportsList.innerHTML = reps.map(reportSheetHtml).join("");
}

function reportSheetHtml(r) {
  return `
    <div class="report-sheet" data-id="${r.id}">
      <div class="report-sheet-info">
        <div class="report-sheet-title">📄 ${escapeHtml(r.title)}</div>
        <div class="report-sheet-sub">creat ${prettyDate(dateStrFromTs(r.createdTs))}</div>
      </div>
      <button class="del" data-id="${r.id}" title="Șterge">🗑</button>
    </div>`;
}

function renderOpenReport() {
  const r = loadReports().find((x) => x.id === openReportId);
  if (!r) {
    openReportId = null;
    renderReports();
    return;
  }
  el.reportsList.classList.add("hidden");
  el.reportDetail.classList.remove("hidden");
  el.reportDetail.innerHTML = reportDetailHtml(r);
}

// Conținutul complet al unui raport (recalculat mereu din datele curente).
function reportDetailHtml(r) {
  const s = computePeriodStats(r.start, r.end);
  const isDay = r.start === r.end;
  const profileOk = profileComplete(loadProfile());
  const burnedTotal = s.bodyBurnTotal + s.burnedActive;

  const toolbar = `
    <div class="report-toolbar no-print">
      <button id="report-back" class="ghost-btn">← Înapoi</button>
      <button id="report-print" class="primary-btn">🖨 Printează PDF</button>
    </div>`;

  const macrosHtml = `
    <div class="macros">
      <div class="macro"><div class="val">${s.eaten.protein_g}g</div><div class="lbl">Proteine</div></div>
      <div class="macro"><div class="val">${s.eaten.carbs_g}g</div><div class="lbl">Carbo</div></div>
      <div class="macro"><div class="val">${s.eaten.fat_g}g</div><div class="lbl">Grăsimi</div></div>
    </div>`;

  let body;
  if (isDay) {
    const w = weightForDate(r.start);
    body = `
      <h2>${escapeHtml(r.title)}</h2>
      <div class="report-weight">⚖️ ${w ? w + " kg" : "—"}</div>
      <div class="report-grid">
        <div class="report-stat"><div class="val">${s.eaten.calories}</div><div class="lbl">kcal mâncate</div></div>
        <div class="report-stat"><div class="val">${burnedTotal}</div><div class="lbl">kcal arse (corp + activ)</div></div>
      </div>
      <div class="report-grid">
        <div class="report-stat"><div class="val">${s.bodyBurnTotal}</div><div class="lbl">arse (doar corp)</div></div>
        <div class="report-stat"><div class="val">${s.burnedActive}</div><div class="lbl">arse (doar activ)</div></div>
      </div>
      ${macrosHtml}
      ${reportDeficitHtml(s, isDay, profileOk)}
    `;
  } else {
    const dc = s.effectiveDayCount || 1;
    const row = (lbl, total, unit) =>
      `<tr><td>${lbl}</td><td>${total}${unit}</td><td>${Math.round(total / dc)}${unit}</td></tr>`;
    body = `
      <h2>${escapeHtml(r.title)}</h2>
      <div class="report-sub">${s.effectiveDayCount} ${s.effectiveDayCount === 1 ? "zi" : "zile"} · ${s.dayCount} cu date · ${prettyDate(r.start)} - ${prettyDate(r.end)}</div>
      ${weightChartSvg(s.weights)}
      ${weightChangeHtml(s.weights)}
      <table class="report-table">
        <tr><th></th><th>Total</th><th>Medie/zi</th></tr>
        ${row("🍽 Mâncate", s.eaten.calories, " kcal")}
        ${row("🔥 Arse (corp + activ)", burnedTotal, " kcal")}
        ${row("🔆 Arse (doar corp)", s.bodyBurnTotal, " kcal")}
        ${row("🏃 Arse (doar activ)", s.burnedActive, " kcal")}
        ${row("Proteine", s.eaten.protein_g, " g")}
        ${row("Carbo", s.eaten.carbs_g, " g")}
        ${row("Grăsimi", s.eaten.fat_g, " g")}
      </table>
      ${reportDeficitHtml(s, isDay, profileOk)}
    `;
  }

  return toolbar + `<div class="report-print">${body}</div>`;
}

// Blocul de deficit/surplus dintr-un raport.
function reportDeficitHtml(s, isDay, profileOk) {
  if (!profileOk) {
    return `<div class="deficit-hint">Completează „Datele mele" ca să vezi deficitul caloric.</div>`;
  }
  const burnedTotal = s.bodyBurnTotal + s.burnedActive;
  const deficitTotal = burnedTotal - s.eaten.calories;
  if (isDay) {
    const good = deficitTotal >= 0;
    return `
      <div class="deficit-total ${good ? "deficit-good" : "deficit-bad"}">
        ${good ? "Deficit" : "Surplus"}: ${Math.abs(deficitTotal)} kcal
      </div>`;
  }
  const dc = s.effectiveDayCount || 1;
  const avg = Math.round(deficitTotal / dc);
  const good = deficitTotal >= 0;
  return `
    <div class="report-deficit">
      <div class="deficit-row"><span>${good ? "Deficit total" : "Surplus total"}</span><span>${Math.abs(deficitTotal)} kcal</span></div>
      <div class="deficit-total ${good ? "deficit-good" : "deficit-bad"}">
        ${good ? "Deficit" : "Surplus"} mediu: ${Math.abs(avg)} kcal/zi
      </div>
    </div>`;
}

// Grafic SVG de evoluție a greutății (fără librării externe).
function weightChartSvg(weights) {
  const ws = weights.slice().sort((a, b) => a.ts - b.ts);
  if (ws.length < 2) {
    const txt =
      ws.length === 1
        ? `O singură cântărire în perioadă: ${ws[0].weight_kg} kg.`
        : "Nicio cântărire în perioadă pentru grafic.";
    return `<div class="report-chart-empty">${txt}</div>`;
  }
  const W = 520;
  const H = 200;
  const padL = 40;
  const padR = 14;
  const padT = 16;
  const padB = 30;
  const vals = ws.map((w) => w.weight_kg);
  // Scala = exact min..max al datelor (fără padding de valoare, care ar induce în eroare).
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min;
  // Margine DOAR în pixeli: punctele extreme (min/max) nu se lipesc de marginea zonei de desen
  // și nu sunt tăiate. Nu afectează valorile afișate pe axă.
  const dotInset = 6;
  const plotTop = padT + dotInset;
  const plotBottom = H - padB - dotInset;
  const x = (i) => padL + (i / (ws.length - 1)) * (W - padL - padR);
  // Când toate greutățile sunt egale (range 0), desenăm linia orizontal pe mijloc.
  const y = (v) =>
    range === 0
      ? (plotTop + plotBottom) / 2
      : plotTop + (1 - (v - min) / range) * (plotBottom - plotTop);
  const pts = ws.map((w, i) => `${x(i).toFixed(1)},${y(w.weight_kg).toFixed(1)}`).join(" ");
  const dots = ws
    .map((w, i) => `<circle class="chart-dot" data-i="${i}" cx="${x(i).toFixed(1)}" cy="${y(w.weight_kg).toFixed(1)}" r="3" fill="#16a34a" />`)
    .join("");
  // Cercuri transparente mai mari peste fiecare punct: măresc zona de atins/hover și poartă atât
  // tooltip-ul nativ (<title>, pe desktop la hover) cât și datele pentru caption (pe telefon la tap).
  const hits = ws
    .map(
      (w, i) =>
        `<circle class="chart-pt" data-i="${i}" data-kg="${w.weight_kg}" data-date="${w.date}" cx="${x(i).toFixed(1)}" cy="${y(w.weight_kg).toFixed(1)}" r="12" fill="transparent"><title>${w.weight_kg} kg · ${prettyDate(w.date)}</title></circle>`
    )
    .join("");
  // Etichetele din stânga: greutatea din PRIMA zi, ULTIMA zi, MAXIMĂ și MINIMĂ. Afișăm valorile
  // distincte (dacă unele coincid, apare o singură dată). Fiecare stă la înălțimea ei reală; le
  // depărtăm ușor pe verticală doar cât să nu se suprapună textul.
  const first = ws[0].weight_kg;
  const last = ws[ws.length - 1].weight_kg;
  const seen = new Set();
  const labels = [];
  for (const v of [max, first, last, min]) {
    const key = v.toFixed(1);
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push({ v, y: y(v) });
  }
  labels.sort((a, b) => a.y - b.y); // de sus (max) în jos (min)
  const minGap = 13;
  for (let i = 1; i < labels.length; i++) {
    if (labels[i].y - labels[i - 1].y < minGap) labels[i].y = labels[i - 1].y + minGap;
  }
  // dacă gruparea a ieșit sub podeaua graficului, o mutăm în sus cât trebuie
  if (labels.length) {
    const overflow = labels[labels.length - 1].y - (H - padB - 2);
    if (overflow > 0) for (const l of labels) l.y -= overflow;
  }
  const axisLabels = labels
    .map(
      (l) =>
        `<text x="${padL - 6}" y="${(l.y + 4).toFixed(1)}" text-anchor="end" fill="#6b7280" font-size="11">${l.v.toFixed(1)}</text>`
    )
    .join("");
  return `
    <div class="weight-chart-wrap">
      <svg class="weight-chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Evoluția greutății">
        <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="#d1d5db" stroke-width="1" />
        <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#d1d5db" stroke-width="1" />
        ${axisLabels}
        <polyline points="${pts}" fill="none" stroke="#16a34a" stroke-width="2" />
        ${dots}
        ${hits}
        <text x="${padL}" y="${H - 8}" text-anchor="start" fill="#6b7280" font-size="11">${prettyDate(ws[0].date)}</text>
        <text x="${W - padR}" y="${H - 8}" text-anchor="end" fill="#6b7280" font-size="11">${prettyDate(ws[ws.length - 1].date)}</text>
      </svg>
      <div class="chart-caption no-print">👆 Atinge un punct pentru greutate + dată</div>
    </div>`;
}

// Diferența de greutate pe perioadă = ultima − prima cantarire din interval (consistent cu graficul).
// Pe rapoartele de minim 2 zile apare mereu: dacă sunt sub 2 cântăriri, arătăm „Greutate constantă".
function weightChangeHtml(weights) {
  const ws = weights.slice().sort((a, b) => a.ts - b.ts);
  let cls = "wc-flat";
  let label = "➖ Greutate constantă";
  if (ws.length >= 2) {
    const delta = ws[ws.length - 1].weight_kg - ws[0].weight_kg;
    const kg = fmtKg(Math.abs(delta));
    if (delta < 0) {
      cls = "wc-down";
      label = `📉 Slăbit: ${kg} kg`;
    } else if (delta > 0) {
      cls = "wc-up";
      label = `📈 Îngrășat: ${kg} kg`;
    }
  }
  return `<div class="report-weight-change ${cls}">${label}</div>`;
}

// Formatează un delta de greutate: max 2 zecimale, fără zerouri de coadă (ex. 0.7, 1.25, 2).
function fmtKg(n) {
  return String(Math.round(n * 100) / 100);
}

// Click în lista de rapoarte: deschide o foaie / șterge.
el.reportsList.addEventListener("click", (e) => {
  const del = e.target.closest(".del");
  if (del) {
    deleteReport(del.dataset.id);
    if (openReportId === del.dataset.id) openReportId = null;
    renderReports();
    return;
  }
  const sheet = e.target.closest(".report-sheet");
  if (sheet) {
    openReportId = sheet.dataset.id;
    renderReports();
  }
});

// Click în raportul deschis: înapoi la listă / printează / tap pe un punct din grafic.
el.reportDetail.addEventListener("click", (e) => {
  if (e.target.closest("#report-back")) {
    openReportId = null;
    renderReports();
    return;
  }
  if (e.target.closest("#report-print")) {
    window.print();
    return;
  }
  // Pe telefon nu există hover: la tap pe un punct arătăm greutatea + data în caption și evidențiem punctul.
  const pt = e.target.closest(".chart-pt");
  if (pt) {
    const wrap = pt.closest(".weight-chart-wrap");
    const cap = wrap && wrap.querySelector(".chart-caption");
    if (cap) cap.textContent = `⚖️ ${pt.dataset.kg} kg · ${prettyDate(pt.dataset.date)}`;
    const svg = pt.closest("svg");
    if (svg) {
      svg.querySelectorAll(".chart-dot-active").forEach((d) => d.classList.remove("chart-dot-active"));
      const dot = svg.querySelector(`.chart-dot[data-i="${pt.dataset.i}"]`);
      if (dot) dot.classList.add("chart-dot-active");
    }
  }
});

// Butoanele „Creează Raport" de pe Statistici și Cântărire.
el.statsReportBtn.addEventListener("click", () => createReport(statsPeriod));
el.weighReportBtn.addEventListener("click", () => createReport(weighPeriod));

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

// (Fără cântărire-sămânță: greutatea read-only cade oricum pe cea din profil când nu există
//  încă nicio cântărire. O sămânță ar crea o intrare fantomă care poate „bate" cântăririle
//  reale din aceeași zi, fiindcă are ts cu secunde/ms, iar formularul folosește minute.)

// Selectoarele de perioadă (Statistici + Cântărire), pe aceleași funcții.
statsCfg = {
  state: statsPeriod,
  modes: el.periodModes,
  nav: el.periodNav,
  prev: el.periodPrev,
  next: el.periodNext,
  range: el.periodRange,
  rangeStart: el.rangeStart,
  rangeEnd: el.rangeEnd,
  label: el.periodLabel,
  render: renderStats
};
weighCfg = {
  state: weighPeriod,
  modes: el.weighPeriodModes,
  nav: el.weighPeriodNav,
  prev: el.weighPeriodPrev,
  next: el.weighPeriodNext,
  range: el.weighPeriodRange,
  rangeStart: el.weighRangeStart,
  rangeEnd: el.weighRangeEnd,
  label: el.weighPeriodLabel,
  render: renderWeigh
};
setupPeriodSelector(statsCfg);
setupPeriodSelector(weighCfg);

// Pregătește pozele (IndexedDB: migrare la prima rulare + umplere cache) ÎNAINTE de prima
// randare, ca lista de mese să apară direct cu poze, nu cu placeholdere.
(async () => {
  await initPhotos();
  fillProfileCard();
  showOnboardingIfNeeded(); // la prima folosire (sau date lipsă) arată formularul pe Acasă
  renderStats();
  // Rămâi pe pagina la care erai înainte de refresh (implicit Acasă).
  switchView(localStorage.getItem(VIEW_KEY) || "home");
})();
