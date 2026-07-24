import Anthropic from "@anthropic-ai/sdk";

// Aceeasi strategie ca la analyze.mjs: folosim cheia TA reala (ANTHROPIC_DIRECT_KEY),
// nu tokenul rotativ pe care Netlify AI Gateway il pune in ANTHROPIC_API_KEY.
const DIRECT_KEY =
  process.env.ANTHROPIC_DIRECT_KEY || process.env.ANTHROPIC_API_KEY;

const client = new Anthropic({
  apiKey: DIRECT_KEY,
  baseURL: "https://api.anthropic.com"
});

const SYSTEM = `Esti un antrenor care estimeaza caloriile arse la exercitii fizice.

Primesti un text in limba romana in care utilizatorul descrie ce activitati a facut si cat timp, plus greutatea lui in kg. Textul poate contine mai multe activitati intr-o singura fraza.

Pentru fiecare activitate:
- estimeaza durata in minute (daca nu e precizata clar, foloseste o valoare rezonabila)
- foloseste o valoare MET realista pentru activitatea respectiva
- calorii arse = MET * greutate_kg * (minute / 60), rotunjit la intreg

Raspunde DOAR cu un obiect JSON, exact in formatul de mai jos, fara alt text, fara markdown, fara explicatii:
{"activities":[{"name":"Inot","duration_min":15,"calories":130},{"name":"Cardio la sala","duration_min":60,"calories":500}],"total_calories":630,"total_duration_min":75,"summary":"Inot, cardio la sala"}

Reguli stricte:
- name este un nume scurt, in limba romana, pentru fiecare activitate.
- Toate valorile numerice sunt numere intregi mai mari sau egale cu 0.
- total_calories este suma caloriilor din activities. total_duration_min este suma minutelor.
- summary este lista scurta a activitatilor, separate prin virgula (ex: "Inot, cardio la sala").
- Daca textul nu descrie niciun exercitiu fizic, raspunde:
  {"activities":[],"total_calories":0,"total_duration_min":0,"summary":"Nedetectat"}`;

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
    `Estimeaza caloriile arse. Raspunde doar cu JSON-ul.`;

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

    // Normalizare + consistenta: totalurile se deduc din activities.
    const activities = Array.isArray(data.activities) ? data.activities : [];
    const clean = activities.map((a) => ({
      name: String(a.name || "Exercitiu"),
      duration_min: Math.max(0, Math.round(Number(a.duration_min) || 0)),
      calories: Math.max(0, Math.round(Number(a.calories) || 0))
    }));

    const result = {
      activities: clean,
      total_calories: clean.reduce((s, a) => s + a.calories, 0),
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
