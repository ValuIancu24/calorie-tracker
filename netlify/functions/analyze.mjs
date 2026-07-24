import Anthropic from "@anthropic-ai/sdk";

// Netlify AI Gateway suprascrie la runtime variabila ANTHROPIC_API_KEY cu un token rotativ
// propriu si deviaza apelul prin gateway-ul lor (platit din creditele Netlify). Ca sa folosim
// cheia TA reala si sa platim din contul TAU Anthropic, o citim din ANTHROPIC_DIRECT_KEY
// (nume pe care gateway-ul nu-l fura) si fortam adresa directa. Local (fara gateway) cade pe
// ANTHROPIC_API_KEY din .env.
const DIRECT_KEY =
  process.env.ANTHROPIC_DIRECT_KEY || process.env.ANTHROPIC_API_KEY;

const client = new Anthropic({
  apiKey: DIRECT_KEY,
  baseURL: "https://api.anthropic.com"
});

const SYSTEM = `Esti un nutritionist care estimeaza valorile nutritionale dintr-o poza cu mancare.

Analizeaza imaginea si estimeaza, pentru portia din poza:
- felul de mancare (nume scurt, in limba romana)
- portia in grame (foloseste indicii vizuale: farfurie, tacamuri, ambalaj, mana)
- caloriile totale si macro: proteine, carbohidrati, grasimi

Raspunde DOAR cu un obiect JSON, exact in formatul de mai jos, fara alt text, fara markdown, fara explicatii:
{"food_name":"Pizza pepperoni","grams":350,"calories":820,"protein_g":38,"carbs_g":72,"fat_g":40,"confidence":"medie"}

Reguli stricte:
- Toate valorile numerice sunt numere intregi realiste si strict mai mari ca 0 pentru mancare reala.
- confidence este exact unul din: "scazuta", "medie", "ridicata".
- Daca utilizatorul iti da notite (de ex. compozitia mancarii sau gramajul exact), tine cont de ele si prioritizeaza-le fata de estimarea pur vizuala. Compozitia schimba caloriile (ex. o shaorma doar cu carne si cartofi e mai calorica decat una cu multe salate si legume).
- Daca in imagine chiar nu se vede mancare, raspunde:
  {"food_name":"Nedetectat","grams":0,"calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"confidence":"scazuta"}`;

export default async (req) => {
  // DEBUG temporar: ultimele 4 caractere ale cheii folosite efectiv (DIRECT_KEY).
  // Dupa fix trebuie sa fie STABILE (cheia ta reala), nu sa se schimbe la fiecare request.
  console.log(
    "Cheie folosita (ultimele 4):",
    String(DIRECT_KEY || "").slice(-4) || "(goala)"
  );
  // DEBUG temporar: ce adresa injecteaza Netlify (AI Gateway). O ocolim prin baseURL explicit.
  console.log(
    "ANTHROPIC_BASE_URL injectat de Netlify:",
    process.env.ANTHROPIC_BASE_URL || "(niciunul)"
  );

  if (req.method !== "POST") {
    return json({ error: "Foloseste metoda POST." }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Corp invalid (nu este JSON)." }, 400);
  }

  const { image_base64, media_type, notes } = body || {};
  if (!image_base64 || !media_type) {
    return json({ error: "Lipseste image_base64 sau media_type." }, 400);
  }

  // Text pentru model: cererea de baza + eventualele notite de la utilizator.
  let userText =
    "Estimeaza valorile nutritionale pentru mancarea din poza. Raspunde doar cu JSON-ul.";
  const cleanNotes = String(notes || "").trim();
  if (cleanNotes) {
    userText +=
      "\n\nNotite de la utilizator (pot contine compozitia sau gramajul exact - foloseste-le prioritar): " +
      cleanNotes;
  }

  try {
    const message = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      // Lasam modelul sa gandeasca estimarea inainte de a raspunde.
      thinking: { type: "adaptive" },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type, data: image_base64 }
            },
            {
              type: "text",
              text: userText
            }
          ]
        }
      ]
    });

    const textBlock = message.content.find((b) => b.type === "text");
    if (!textBlock) return json({ error: "Raspuns gol de la model." }, 502);

    // Depanare: vezi exact ce a raspuns modelul in Netlify -> Logs -> Functions -> analyze.
    console.log("Raspuns model:", textBlock.text);

    const data = extractJson(textBlock.text);
    if (!data) return json({ error: "Nu am putut interpreta raspunsul modelului." }, 502);

    // Consistenta: caloriile se deduc din macro (4/4/9 kcal per gram).
    data.calories = Math.round(
      (Number(data.protein_g) || 0) * 4 +
        (Number(data.carbs_g) || 0) * 4 +
        (Number(data.fat_g) || 0) * 9
    );

    return json(data, 200);
  } catch (err) {
    console.error("Eroare la analiza:", err);
    return json({ error: "Analiza a esuat. Incearca din nou." }, 500);
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
