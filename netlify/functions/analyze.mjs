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

const SYSTEM = `Esti un nutritionist care estimeaza valorile nutritionale ale unei portii de mancare, folosind notitele utilizatorului si poza.

ORDINEA DE PRIORITATE (foarte important):
Increderea merge asa: NOTITELE utilizatorului (calorii / gramaj / eticheta) > estimarea vizuala din poza.
- Notitele au INTOTDEAUNA prioritate fata de poza, chiar si cand exista o poza. Uneori poza atasata e irelevanta sau pusa doar ca sa existe una - in acel caz ignor-o si bazeaza-te pe notite.
- Foloseste poza doar ca sa completezi ce nu spun notitele (sau cand nu exista notite). Compozitia din notite schimba caloriile (ex. o shaorma doar cu carne si cartofi e mai calorica decat una cu multe legume).

CALORIILE (respecta valorile explicite - NU le rotunji si NU le "corecta"):
- Daca utilizatorul da EXPLICIT numarul de calorii in notite (ex. "20 calorii", "are 350 kcal"), pune EXACT acea valoare in "calories" si "calorie_source":"user". Alege proteine/carbohidrati/grasimi astfel incat proteine*4 + carbohidrati*4 + grasimi*9 sa dea cat mai aproape de acea valoare (ca sa fie consistente).
- Daca in poza se vede clar o ETICHETA NUTRITIONALA, citeste valorile EXACT de pe eticheta (calorii + macro, pentru portia relevanta) si pune "calorie_source":"label". Da fix ce scrie pe eticheta, fara sa recalculezi.
- Altfel (estimare pur vizuala), pune "calorie_source":"estimat" si asigura-te ca "calories" ≈ proteine*4 + carbohidrati*4 + grasimi*9.
- Daca utilizatorul da explicit gramajul, foloseste-l ca atare.

Estimeaza, pentru portia relevanta:
- felul de mancare (nume scurt, in limba romana)
- portia in grame (foloseste indicii vizuale daca nu e dat: farfurie, tacamuri, ambalaj, mana)
- caloriile totale si macro: proteine, carbohidrati, grasimi
- calorie_source (conform regulilor de mai sus)

Raspunde DOAR cu un obiect JSON, exact in formatul de mai jos, fara alt text, fara markdown, fara explicatii:
{"food_name":"Pizza pepperoni","grams":350,"calories":820,"protein_g":38,"carbs_g":72,"fat_g":40,"calorie_source":"estimat","confidence":"medie"}

Reguli stricte:
- Toate valorile numerice sunt numere realiste; pentru mancare reala "calories" si "grams" sunt strict mai mari ca 0.
- calorie_source este exact unul din: "user", "label", "estimat".
- confidence este exact unul din: "scazuta", "medie", "ridicata".
- Daca in imagine chiar nu se vede mancare SI notitele nu descriu mancare, raspunde:
  {"food_name":"Nedetectat","grams":0,"calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"calorie_source":"estimat","confidence":"scazuta"}`;

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

  const { image_base64, media_type, notes } = body || {};
  if (!image_base64 || !media_type) {
    return json({ error: "Lipseste image_base64 sau media_type." }, 400);
  }

  // Text pentru model: notitele (prioritare) + cererea de raspuns. Poza poate fi irelevanta.
  const cleanNotes = String(notes || "").trim();
  let userText;
  if (cleanNotes) {
    userText =
      "Notitele utilizatorului (au PRIORITATE fata de poza; daca poza pare irelevanta, ignor-o si bazeaza-te pe notite):\n" +
      cleanNotes +
      "\n\nRaspunde doar cu JSON-ul, respectand ordinea de prioritate si regulile despre calorii (calorii/gramaj/eticheta explicite se respecta exact).";
  } else {
    userText =
      "Nu exista notite. Estimeaza valorile nutritionale pentru mancarea din poza. Raspunde doar cu JSON-ul.";
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

    // Caloriile din macro (4/4/9 kcal per gram) - folosite doar la estimarea vizuala.
    const macroCalories = Math.round(
      (Number(data.protein_g) || 0) * 4 +
        (Number(data.carbs_g) || 0) * 4 +
        (Number(data.fat_g) || 0) * 9
    );

    // Cand utilizatorul a dat calorii explicite sau exista eticheta nutritionala, respectam EXACT
    // valoarea intoarsa de model (nu o rescriem din macro - altfel "20 calorii" ar deveni 33, iar
    // eticheta ar capata 5-10% eroare). Doar la estimarea pur vizuala derivam caloriile din macro.
    const stated = Number(data.calories);
    const explicit =
      data.calorie_source === "user" || data.calorie_source === "label";
    data.calories =
      explicit && Number.isFinite(stated) && stated > 0
        ? Math.round(stated)
        : macroCalories;

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
