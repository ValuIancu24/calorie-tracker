import Anthropic from "@anthropic-ai/sdk";

// Clientul citeste automat cheia din variabila de mediu ANTHROPIC_API_KEY
// (setata in Netlify -> Site settings -> Environment variables).
const client = new Anthropic();

// Schema pe care modelul TREBUIE sa o respecte => raspunsul e mereu JSON valid,
// gata de folosit, fara sa ghicim formatul.
const SCHEMA = {
  type: "object",
  properties: {
    food_name: { type: "string" },
    grams: { type: "integer" },
    calories: { type: "integer" },
    protein_g: { type: "integer" },
    carbs_g: { type: "integer" },
    fat_g: { type: "integer" },
    confidence: { type: "string", enum: ["scazuta", "medie", "ridicata"] }
  },
  required: [
    "food_name",
    "grams",
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "confidence"
  ],
  additionalProperties: false
};

const SYSTEM = `Esti un nutritionist care estimeaza valorile nutritionale dintr-o poza cu mancare.
Reguli:
- Identifica felul de mancare principal din imagine.
- Estimeaza portia in grame pe baza indiciilor vizuale (farfurie, tacamuri, ambalaj, mana).
- Calculeaza caloriile si macro (proteine, carbohidrati, grasimi) pentru portia estimata.
- food_name se scrie in limba romana, scurt (ex: "Piept de pui la gratar cu orez").
- confidence reflecta cat de sigur esti de estimarea portiei in grame.
- Daca in imagine nu se vede mancare, pune food_name = "Nedetectat" si toate valorile numerice 0.`;

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

  const { image_base64, media_type } = body || {};
  if (!image_base64 || !media_type) {
    return json({ error: "Lipseste image_base64 sau media_type." }, 400);
  }

  try {
    const message = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
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
              text: "Estimeaza valorile nutritionale pentru mancarea din aceasta poza."
            }
          ]
        }
      ],
      // Constrange raspunsul la schema de mai sus.
      output_config: { format: { type: "json_schema", schema: SCHEMA } }
    });

    // Cu output_config.format, primul bloc de text e garantat JSON valid.
    const textBlock = message.content.find((b) => b.type === "text");
    if (!textBlock) return json({ error: "Raspuns gol de la model." }, 502);

    const data = JSON.parse(textBlock.text);
    return json(data, 200);
  } catch (err) {
    console.error("Eroare la analiza:", err);
    return json({ error: "Analiza a esuat. Incearca din nou." }, 500);
  }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
