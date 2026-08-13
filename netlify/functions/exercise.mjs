import Anthropic from "@anthropic-ai/sdk";

// Aceeasi strategie ca la analyze.mjs: folosim cheia TA reala (ANTHROPIC_DIRECT_KEY),
// nu tokenul rotativ pe care Netlify AI Gateway il pune in ANTHROPIC_API_KEY.
const DIRECT_KEY =
  process.env.ANTHROPIC_DIRECT_KEY || process.env.ANTHROPIC_API_KEY;

const client = new Anthropic({
  apiKey: DIRECT_KEY,
  baseURL: "https://api.anthropic.com"
});

const SYSTEM = `Esti un antrenor care estimeaza caloriile arse la exercitii fizice, pe baza descrierii utilizatorului.

Primesti un text in limba romana in care utilizatorul descrie ce activitati a facut si cat timp, plus greutatea lui in kg. Textul poate contine mai multe activitati intr-o singura fraza.

PRIORITATE (foarte important):
Descrierea utilizatorului are prioritate fata de estimarea ta.
- Daca utilizatorul spune EXPLICIT cate calorii a ars (pentru o activitate sau in total, ex. "am mers o ora si am ars 100 de calorii"), foloseste EXACT acea valoare - NU o recalcula din formula MET. Pune "calorie_source":"user".
  - Daca valoarea explicita e un TOTAL pentru mai multe activitati, imparte caloriile intre activitati astfel incat suma lor sa dea EXACT acel total.
  - Daca e pentru o singura activitate, pune-o exact la acea activitate.
  - Daca da calorii explicite doar pentru unele activitati, respecta-le pe acelea si estimeaza-le doar pe cele fara valoare.
- Altfel (nu se dau calorii explicite), estimeaza singur si pune "calorie_source":"estimat":
  - estimeaza durata in minute (daca nu e precizata clar, foloseste o valoare rezonabila)
  - foloseste o valoare MET realista pentru activitatea respectiva
  - calorii arse = MET * greutate_kg * (minute / 60), rotunjit la intreg

Durata (minute) o estimezi mereu ca de obicei, chiar si cand caloriile sunt date explicit.

Raspunde DOAR cu un obiect JSON, exact in formatul de mai jos, fara alt text, fara markdown, fara explicatii:
{"activities":[{"name":"Inot","duration_min":15,"calories":130},{"name":"Cardio la sala","duration_min":60,"calories":500}],"total_calories":630,"total_duration_min":75,"summary":"Inot, cardio la sala","calorie_source":"estimat"}

Reguli stricte:
- name este un nume scurt, in limba romana, pentru fiecare activitate.
- Toate valorile numerice sunt numere intregi mai mari sau egale cu 0.
- total_calories este suma caloriilor din activities. total_duration_min este suma minutelor.
- calorie_source este exact unul din: "user", "estimat".
- summary este lista scurta a activitatilor, separate prin virgula (ex: "Inot, cardio la sala").
- Daca textul nu descrie niciun exercitiu fizic, raspunde:
  {"activities":[],"total_calories":0,"total_duration_min":0,"summary":"Nedetectat","calorie_source":"estimat"}`;

export default async (req) => {
  if (req.method !== "POST") {
    return json({ error: "Foloseste metoda POST." }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Corp invalid (nu este JSON)." }, 400);
  }

  const { text, weight_kg } = body || {};
  const cleanText = String(text || "").trim();
  const weight = Number(weight_kg);
  if (!cleanText) {
    return json({ error: "Lipseste descrierea exercitiului." }, 400);
  }
  if (!weight || weight <= 0) {
    return json({ error: "Lipseste greutatea (weight_kg)." }, 400);
  }

  const userText =
    `Greutatea utilizatorului: ${Math.round(weight)} kg.\n\n` +
    `Ce a facut utilizatorul: ${cleanText}\n\n` +
    `Estimeaza caloriile arse. Daca in text sunt date calorii explicite, respecta-le exact (nu recalcula din MET). Raspunde doar cu JSON-ul.`;

  try {
    const message = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      // Lasam modelul sa gandeasca estimarea (parseaza activitatile, alege MET) inainte de raspuns.
      thinking: { type: "adaptive" },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: userText }]
        }
      ]
    });

    const textBlock = message.content.find((b) => b.type === "text");
    if (!textBlock) return json({ error: "Raspuns gol de la model." }, 502);

    // Depanare: vezi exact ce a raspuns modelul in Netlify -> Logs -> Functions -> exercise.
    console.log("Raspuns model (exercise):", textBlock.text);

    const data = extractJson(textBlock.text);
    if (!data) return json({ error: "Nu am putut interpreta raspunsul modelului." }, 502);

    // Normalizare: durata + defalcarea pe activitati.
    const activities = Array.isArray(data.activities) ? data.activities : [];
    const clean = activities.map((a) => ({
      name: String(a.name || "Exercitiu"),
      duration_min: Math.max(0, Math.round(Number(a.duration_min) || 0)),
      calories: Math.max(0, Math.round(Number(a.calories) || 0))
    }));

    // Total calorii: cand utilizatorul a dat calorii explicite, respectam totalul intors de model
    // (nu-l suprascriem din suma - ca "am ars 100" sa ramana 100). Altfel il derivam din activitati.
    const sumCal = clean.reduce((s, a) => s + a.calories, 0);
    const statedTotal = Number(data.total_calories);
    const explicit = data.calorie_source === "user";
    const totalCalories =
      explicit && Number.isFinite(statedTotal) && statedTotal >= 0
        ? Math.round(statedTotal)
        : sumCal;

    const result = {
      activities: clean,
      total_calories: totalCalories,
      total_duration_min: clean.reduce((s, a) => s + a.duration_min, 0),
      summary: String(data.summary || clean.map((a) => a.name).join(", ") || "Exercitiu")
    };

    return json(result, 200);
  } catch (err) {
    console.error("Eroare la estimarea exercitiului:", err);
    return json({ error: "Estimarea a esuat. Incearca din nou." }, 500);
  }
};

// Extrage un obiect JSON din textul modelului, chiar daca are text in jur.
function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
