# Calorie Tracker

Aplicație web care estimează caloriile și macro-urile (proteine, carbohidrați, grăsimi)
dintr-o **poză cu mâncare**, cu jurnal zilnic. Datele se țin local, pe telefon.

## Cum funcționează

```
Telefon (poză)  ->  Pagina web (index.html)  ->  Funcție Netlify (analyze.mjs)  ->  Claude (vision)
                          ^                                                              |
                          |______________________ răspuns JSON (calorii + macro) ________|
```

- **Frontend static**: `index.html`, `styles.css`, `app.js` — două ecrane (Acasă / Statistici) cu bară de jos.
- **Funcție serverless**: `netlify/functions/analyze.mjs` — ține cheia API ascunsă și trimite poza la Claude.
- **Stocare**: `localStorage` în browserul telefonului (fără bază de date). Mesele sunt grupate pe zi (`YYYY-MM-DD`).

## Ce trebuie configurat

1. **Cheie API Anthropic** — în Netlify: *Site settings → Environment variables* →
   adaugă `ANTHROPIC_API_KEY` cu cheia ta. **Nu** o pune niciodată în cod.
2. **Deploy** — conectează repo-ul în Netlify (Import from Git). Fiecare push redeployează.

## Rulare locală (opțional)

```bash
npm install
npx netlify dev
```

Creează un fișier `.env` (ignorat de git) cu:

```
ANTHROPIC_API_KEY=cheia-ta
```

Apoi deschide adresa afișată de `netlify dev`.

## De reținut

Estimarea porției dintr-o poză este aproximativă (±20–30%). Un obiect de referință
în cadru (furculiță, mână) crește precizia. Pentru produse ambalate, eticheta e mai exactă.
