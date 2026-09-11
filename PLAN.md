# CassieAITracker — Development Plan

A personal calorie & macro tracker. Type what you ate, Claude estimates Calories / Protein / Carbs, the day accumulates, "New Day" closes it out into a history with graphs.

**Stack decisions (locked):** installable PWA served from GitHub Pages · Cloudflare Worker API proxy · on-device storage first.

---

## 1. Architecture

```
┌──────────────────────────────────────────────────┐
│  PHONE — installed PWA                           │
│  cassie7511.github.io/CassieAITracker/                 │
│  index.html · app.js · style.css                 │
│  IndexedDB: today's entries + closed-day history │
│  localStorage: X-App-Token (pasted once)         │
│  Works offline for manual entry & history        │
└───────────────────┬──────────────────────────────┘
                    │  POST https://cassieaitracker.<you>.workers.dev/api/analyze
                    │  { kind: "text"|"photo", payload }
                    │  header: X-App-Token (shared secret)
                    │  ── cross-origin, so CORS applies ──
                    ▼
┌──────────────────────────────────────────────────┐
│  CLOUDFLARE WORKER                               │
│  • holds ANTHROPIC_API_KEY as encrypted secret   │
│  • answers the OPTIONS preflight                 │
│  • checks X-App-Token, rejects everyone else     │
│  • calls Claude, returns clean validated JSON    │
└───────────────────┬──────────────────────────────┘
                    │  @anthropic-ai/sdk → messages.parse()
                    ▼
┌──────────────────────────────────────────────────┐
│  CLAUDE API — claude-sonnet-5                    │
│  structured output → { calories, protein, carbs }│
└──────────────────────────────────────────────────┘
```

**Why the Worker is non-negotiable.** An Anthropic API key in frontend JavaScript is readable by anyone who opens DevTools or views source. It has to live server-side. The Worker is roughly 60 lines, and the free tier (100k requests/day) is far beyond personal use.

**The two halves live on different origins**, so the Worker has to send CORS headers and answer the preflight. That is the entire cost of hosting the frontend on GitHub Pages, and it is written once:

```js
const ALLOWED = "https://cassie7511.github.io";

function cors(res) {
  res.headers.set("Access-Control-Allow-Origin", ALLOWED);
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, X-App-Token");
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Access-Control-Max-Age", "86400");   // cache the preflight
  return res;
}

// first thing inside fetch():
if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
```

That `Max-Age` line matters more than it looks on a phone. Without it every POST becomes two round-trips — preflight, then the real request — which is noticeable on cell data.

**CORS is not what protects your key.** The key never leaves the Worker either way. CORS only controls which pages a browser will let read the response. The actual protection is the `X-App-Token` header plus the spend cap in the Anthropic Console.

**Deploys are independent.** `git push` ships the frontend; `wrangler deploy` ships the Worker. You can restyle the app without touching the API, and vice versa.

---

## 2. Data model

```js
// One logged food item
Entry = {
  id:          "uuid",
  ts:          1757520000000,        // epoch ms
  source:      "ai-text" | "manual" | "ai-photo" | "ai-label",
  raw:         "two eggs and a slice of toast",   // exactly what you typed
  name:        "2 large eggs — 2 large",
  calories:    220,
  protein_g:   14,
  carbs_g:     15,
  confidence:  "high" | "medium" | "low",
  assumptions: "assumed 1 tsp butter on the toast",
  edited:      false,                // true if you corrected the numbers
  status:      undefined             // "pending" | "error" while in flight
}

// One banked day
Day = {
  date:     "2026-09-10",            // the date the open period started
  entries:  [Entry, ...],
  totals:   { calories, protein_g, carbs_g },
  closedAt: 1757606400000
}
```

Three IndexedDB stores: `entries` (the open period), `days` (banked `Day` records), and `meta` (current date, undo marker, Claude connection config).

**Calories, protein, and carbs only.** Fat is not stored, not displayed, and the system prompt explicitly tells Claude not to report it.

**Day rollover is manual only.** The open period runs until you tap **New day**, however many calendar days that spans — there is no midnight automation. Because of that the header says *Today* only when the open period actually started today, and switches to *Open since Mon Sep 8* otherwise, rather than mislabelling a three-day stretch.

---

## 3. The Claude call

One endpoint, one schema, used by text and photo alike.

```js
// Output schema — Claude is constrained to return exactly this shape
{ calories, protein_g, carbs_g }
```

Implemented with `client.messages.parse()` plus `output_config.format` (a Zod schema), which validates the response shape for you — no JSON-scraped-from-prose, no regex, no retry loop on malformed output.

**Design rule: report the label, do not infer the meal.**

The app returns the numbers that would appear on a nutrition facts label for exactly what you described — nothing more. It adds no cooking oil, no butter, no dressings, no sauces, no sides. If you did not name it, it is not counted. Where genuinely uncertain it takes the lower estimate, because under-reporting beats over-reporting.

This was a deliberate reversal. An earlier prompt told Claude to account for what a dish "normally contains" and to treat restaurant portions as larger. That inflated plain weighed ingredients badly — 1 lb of 85/15 ground beef came back at 1,150 kcal against a true label value of 975, because the model applied cooked-crumble density to a raw package weight. Stripping the inference out fixed it exactly.

**The system prompt covers:**

- Label values for precisely what was described, nothing added
- Stated weight or package size → the label total for that amount as sold
- Unstated quantity → one standard labeled serving
- Everything described sums into one total
- Ties break downward — prefer under to over
- Always return numbers; never refuse for vagueness
- Kcal for energy, grams for protein and carbs, whole numbers

**Model & cost — `claude-sonnet-5`** ($2 / $10 per million input/output tokens).

*Measured*, not estimated: **~400 input tokens** (the system prompt and schema dominate; your description is a rounding error) and **~26 output tokens**, because the response is three numbers. That is **$0.0016 per meal**, or **~$0.24/month** at five meals a day. Latency ~1.8s.

### Accuracy benchmark — 12 label foods with known values

| Food | Known | Sonnet 5 | Haiku 4.5 |
|---|---|---|---|
| 1 lb 85/15 ground beef | 975 | **975** | 1150 (+18%) |
| a banana | 105 | **105** | **105** |
| 6oz grilled chicken breast | 280 | **280** | **280** |
| 1 cup cooked white rice | 205 | **205** | 206 |
| two large eggs | 143 | 140 (−2%) | 155 (+8%) |
| 12oz can of coke | 140 | **140** | **140** |
| 2 tbsp peanut butter | 190 | **190** | 188 |
| 1 cup 2% milk | 122 | **122** | 139 (+14%) |
| 1 slice whole wheat bread | 80 | **80** | **80** |
| 1 medium apple | 95 | **95** | **95** |
| 8oz 93/7 ground turkey | 390 | 340 (−13%) | 200 (−49%) |
| 1 cup cooked oatmeal | 150 | **150** | **150** |
| **Mean absolute error** | | **1%** | **8%** |
| **Latency** | | 1.8s | 1.3s |
| **Cost / meal** | | $0.0016 | $0.0006 |

Sonnet is exact on 9 of 12 and far more accurate overall. Haiku is cheaper and slightly faster but carries misses large enough to matter in a food log — ground turkey at −49% is not a rounding error. At $0.24/month versus $0.09/month the saving is not worth it, so the app runs on Sonnet.

> ⚠️ **That table is one run per cell.** It ranks the models correctly — the gaps are far larger than the noise — but its precision is overstated. See *Run-to-run variance* below: at the effort level in use when it was taken, the same input could vary by ±182 kcal. Treat it as a ranking, not as "Sonnet gets ground beef exactly right."

### Run-to-run variance, and why effort is "high"

LLM numeric recall is not deterministic. Asking the same question repeatedly gives a distribution, not an answer — and how the food is *worded* changes that distribution too. Benchmarked on 1 lb of 85/15 ground beef (~975 kcal), five phrasings × 3 runs:

| phrasing | effort=medium | effort=high |
|---|---|---|
| `1 pound 85/15 ground beef` | 976, 975, 960 | 960, 975, 980 |
| `1 pound ground beef 85 lean` | **1152**, 976, 976 | 976, 976, 977 |
| `85 lean 1 pound ground beef` | 975, **215**, 975 | 976, 960, 975 |
| `1 lb 85% lean ground beef` | 975, **1170**, 960 | 975, 976, 976 |
| `1 pound ground beef` | 1153, 1152, 1153 | 1150, 798, 1150 |

**High is the first level that holds regardless of wording.** Medium looked fine when tested on a single phrasing and fell apart on others — including one run that returned 215. Low was worse still (±182 on identical input). High costs ~0.8s and ~90 output tokens over medium, about $0.25/month at five meals a day.

The lesson generalises: **benchmarking one phrasing of one food told me medium was fine, and it wasn't.** Vary the input wording when testing, not just the input.

The last row is not a defect. Plain `1 pound ground beef` with no lean ratio really is ~1150 kcal — that is standard 80/20. Naming the ratio is what pins it to 975.

Two other things this ruled out, both worth not re-litigating:

- **Removing the "prefer the lower estimate" rule makes accuracy worse**, not better: +21% mean error against +7% with it. The rule stays.
- **Anchoring the prompt to USDA** instead of "the label" also made it worse (+14%). Real product labels genuinely vary by brand — 85/15 ground beef ships with anything from 852 to 975 kcal per pound printed on it — so some spread here is the world being ambiguous, not the model being wrong.

**The fix for repeat foods is remembering your corrections** — built, see below. It removes the model from the loop entirely for anything you log regularly, which is where the variance actually hurt.

**If switching to `claude-haiku-4-5` anyway:** it is an older-generation model that rejects `output_config.effort` outright and has no adaptive thinking — both lines must come out of the request. `output_config.format` works on every model, so the schema guarantee is unaffected. The comment block in [worker/src/index.js](worker/src/index.js) spells it out.

### What the schema simplification bought

Dropping the per-item breakdown, the `assumptions` text, and the confidence flags — keeping only three numbers — measured as:

| | Itemized | Three numbers |
|---|---|---|
| Input tokens | 838 | 400 |
| Output tokens | 311 | 26 |
| Latency | ~4.0s | ~1.8s |
| Cost / meal | $0.0024 | $0.0016 |

Output tokens fell **92%**, and since latency tracks output length the app got roughly twice as responsive. Cost fell less than it looks because the accuracy work moved to Sonnet at the same time.

**A caution learned the hard way:** a prompt variant with an explicit worked example ("a 1 lb package of 85/15 ground beef is its label total, not cooked-crumble density times a pound") scored **17% mean error against 3% for the plain instruction** — nearly six times worse. Over-specifying dragged the model toward the example and away from what it already knew. Keep the prompt rules general.

**Prompt caching is off the table.** The fixed prefix is ~400 tokens, well under the ~1,024 minimum cacheable prefix.

---

## 4. Build phases

Each phase ends in something that works on your phone. Nothing is a big-bang integration.

### Phase 0 — Accounts & keys
No code. Everything in sections A and B of `CHECKLIST.md`. Ends when `wrangler login` succeeds and you hold an API key with a spend cap on it.

### Phase 1 — The Worker, alone
`/api/analyze` accepting `{ kind: "text", payload: "two eggs" }` and returning the schema above, with the CORS block and the `X-App-Token` check in place from the start. Verified with `curl`, no frontend at all. **This is the part most likely to surprise us, so it goes first.** Ends when one curl command returns real macros and a curl without the token returns 401.

### Phase 2 — The shell, no AI ✅ *built*
Running totals, the entry list, and a manual entry form. Full site styling. Persists to IndexedDB. A complete, usable tracker on its own.

Since targets were declined, totals render as plain running numbers rather than progress bars: a large calorie figure with protein and carbs beneath. Nothing about the stored shape assumes targets, so adding goal lines later needs no migration.

Also in: newest-first entry list with delete-and-undo, History tab listing banked days, JSON export (via the iOS share sheet where available, download link elsewhere), and a "New day" undo window of one hour. `navigator.storage.persist()` was pulled forward from Phase 5 so data logged while testing survives iOS eviction.

### Phase 3 — Wire up text input ✅ *built*
The text box is now the primary input; manual number entry is demoted behind an *Enter numbers myself* toggle for the cases Claude cannot help with.

**Optimistic UI.** The row appears the instant you submit, showing your raw text with a spinner and *analyzing…*, then fills in when the numbers land. The 3–6 second round trip happens behind an interface that already responded. A request interrupted by closing the app comes back as a retryable error rather than a row spinning forever.

**One request can produce several rows.** "Chicken caesar salad and a diet coke" returns six items — lettuce, chicken, parmesan, dressing, croutons, the drink — each its own row, so you can correct or delete them independently. Assumptions attach to the first row only, so they do not repeat down the list.

**Tap the calorie figure to edit** any of the three values in place; corrected rows are marked `edited`. Confidence below "high" surfaces as a quiet *approx* or *rough* next to the macros.

**The one-time connection screen** asks for the Worker URL and `X-App-Token` on first launch and keeps them in IndexedDB. The token cannot be baked into the JavaScript — a Pages site is publicly served whether or not the repo is private. Reachable later via *Claude connection* at the bottom of History.

### Phase 3.5 — Saved foods ✅ *built*

Logging now tries three routes in order, and only the third costs anything:

1. **You stated all three numbers** — `500 cal 18g protein 20g carbs` is parsed locally and logged verbatim. Calories are the trigger; without a calorie keyword nothing is assumed, so `1 pound ground beef 85 15` is full of digits but still goes to Claude.
2. **You have saved that food** — your own numbers, instantly, identical every time.
3. **Otherwise** — ask Claude.

**Partial figures are held as overrides.** State only some of the numbers and the lookup still runs, but anything you gave survives it. `310 cals of rice` keeps your 310 and asks Claude for protein and carbs *at that amount* — returning 6g and 68g, not the macros of some other portion.

This needed the parser to distinguish "not stated" from "stated as zero": `0g carbs` is the correct answer for ground beef and must not look like silence. Missing fields parse as `null`, and the merge uses `??` rather than `||` so a real zero is kept rather than falling through to Claude's guess.

**Foods save themselves.** Correcting a logged entry stores it under the exact text you typed, so the phrase you naturally use becomes the trigger. Typing a food *with* numbers saves it too. The **Foods** tab lists everything saved, sorted by how often you use it, and takes new entries directly for foods whose label you already have.

**Matching is on a normalised token set**, so casing, punctuation, word order and unit spellings do not have to match:

```
"1 pound ground beef 85 15"  ┐
"1 lb 85/15 ground beef"     ├─ all key to "1 15 85 beef ground lb"
"ground beef 1 POUND 85/15"  ┘
```

Normalisation folds unit words (`pounds`→`lb`), number words (`two`→`2`), glued units (`6oz`→`6 oz`), possessives (`Joe's`→`joe`), and plurals. Quantities stay *in* the key, so `1 lb chicken` and `2 lb chicken` remain separate foods — as they must.

The label you save is the phrase that triggers it. That is deliberate: exact-set matching is predictable and debuggable, where fuzzy matching would silently attach the wrong macros to the wrong food. Covered by 10 matching cases and 13 parser cases.

**This is also the cost floor.** Once your regular foods are saved, most days should make no API calls at all.

### Phase 4 — Graphs ✅ *built*

Hand-rolled inline SVG, no dependencies, matching how the rest of the site is built. Range toggle is **7 / 30 / All** rather than 7/30/90 — with manual rollover a "day" is a banked period, not a calendar day, so counting banked days is the honest unit.

**Two charts, not one.** Calories are kcal and macros are grams; combining them would need two y-scales on one plot, which makes the lines' relative heights meaningless. So: calories as bars (one discrete magnitude per day), protein and carbs as two lines sharing a single gram axis. Above them, three stat tiles carry the range averages.

**Series colours are not the site's UI pink.** That pink (`#f6b3c5`) is a text accent — at OKLCH L 0.83 and chroma 0.098 it is too light and too washed out to work as a data mark on a dark surface. The chart palette was validated rather than eyeballed:

| role | colour | |
|---|---|---|
| calories | `#d4627f` | rose |
| protein | `#4b96c4` | blue |
| carbs | `#b5872f` | amber |

All three pass the lightness band (L 0.48–0.67 on dark), the chroma floor (≥ 0.10), CVD separation under deuteranopia and protanopia, the normal-vision floor (ΔE ≥ 15), and 3:1 contrast against `--surface`.

**Worth recording: my first two picks failed.** Pairing the site's `--pink-dim` with the lavender from `tokens.css` scored ΔE 9.4 for *normal* vision — below the 15 floor, so hard to tell apart even with full colour vision. A rose/green pair scored ΔE 4.8 under deuteranopia, and rose/violet 2.3. All three looked fine to me on screen. Run the validator; do not trust the eye.

Other details from the visualisation pass: bars are rounded 4px at the free end only and sit flat on the baseline, with a 2px surface gap so neighbours never merge; line markers carry a 2px surface ring so the series stay readable where they cross, and are dropped entirely above 30 points where they would fuse into a solid rule; the grid is three recessive lines; only the end dates are labelled, so x-labels cannot collide. A legend is always present for the two-series chart, and the tooltip names each value — identity is never colour alone. The banked-days list below the charts serves as the table view.

Themed colours are applied via CSS classes, never SVG presentation attributes — `stroke="var(--border)"` does not reliably resolve.

Geometry is covered by a test over five datasets including one day, all-zero, a single spike, and 90 days: no NaN, nothing outside the viewBox, no inverted bars.

Rollover stays **manual only** — no midnight automation, by decision. The undo window on an accidental "New day" is already in.

### Phase 5 — Make it a real app
`manifest.json`, icons, service worker, `navigator.storage.persist()`, offline shell. Add to Home Screen. Ends when it opens full-screen with its own icon and no browser chrome.

**The subpath trap lives here.** GitHub Pages serves this at `/CassieAITracker/`, not a root domain, so every path has to be relative — `start_url: "./"`, `scope: "./"`, a service worker registered with `{ scope: "./" }`, and relative icon paths in the manifest. Get one of these wrong and the install fails quietly: the app opens to the wrong URL, or the service worker refuses to control the page and offline never works. It is a one-time papercut, but it is the single most likely thing to eat an hour.

### Phase 6 — Photos *(the secondary feature)*
Two genuinely different jobs sharing one endpoint:

- **Nutrition-label photo** → transcription. High accuracy, easy win. Build this one first.
- **Plate-of-food photo** → portion estimation from pixels. Much less accurate; lean hard on `confidence: "low"` and always surface assumptions so you can correct them.

Client-side resize to ~1024px before upload — keeps image tokens (and cost) down and makes uploads fast on cell data.

---

## 5. Styling — pulled from cassie7511.github.io

Exact tokens from your live `style.css`, ready to reuse (also saved as `tokens.css` in this folder):

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0d0d0f` | page background |
| `--surface` | `#17171a` | cards, entry rows |
| `--border` | `#2a2a2f` | card borders |
| `--text` | `#c9c9cf` | body text |
| `--muted` | `#8a8a92` | secondary / assumptions text |
| `--pink` | `#f6b3c5` | accents, active state, primary chart line |
| `--pink-dim` | `#d98ba1` | hovers, secondary chart line |

Carried over from the site: the `"Segoe UI", system-ui` stack, 8px card radius, 1px borders that shift to pink on interaction, light-weight (300) large headings, and white `#fff` headings against gray body text.

**Mobile-specific additions needed** — your site is a 720px-max desktop layout, so these are new:

- Full-bleed layout with safe-area insets for the iPhone notch and home indicator
- Bottom tab bar (Today / History), thumb-reachable, pink active state
- Minimum 44px tap targets
- 16px+ font on the text input, or iOS auto-zooms the page on focus
- Chart colors: `--pink` primary, `--pink-dim` secondary, `--muted` for goal lines and grid

---

## 6. Risks & open questions

**1. Claude Pro/Max does not include API credits.** These are two separate products with separate billing. The app needs a Console account with its own payment method and prepaid credits. This is the single most common surprise, so it is item one in the checklist.

**2. Estimates will sometimes be wrong.** "A bowl of pasta" covers a ±300 calorie range. The mitigations are designed in, not bolted on: show `assumptions` on every entry, make every number tap-to-edit, and surface `confidence` visually. Treat it as a fast logger you correct, not an oracle.

**3. iOS evicts web storage after ~7 days of non-use** — but *installed* PWAs using IndexedDB with `navigator.storage.persist()` granted are exempt. Hence IndexedDB over localStorage, and hence Phase 5 matters more than it looks. Export-to-JSON is the backstop.

**4. Your Worker URL is public.** Anyone who finds it could spend your credits. Two layers: the `X-App-Token` header the app stores after first launch, and a hard monthly spend cap in the Anthropic Console. The cap is the one that actually saves you — a token pasted into a browser is a speed bump, not a vault.

**5. Offline behavior.** Manual entry and history work offline. AI entries need network — queue them and analyze on reconnect rather than failing the input outright.

**6. The repo can be public; the data is not in it.** Your food log lives in IndexedDB on the phone and never touches the repo, and both secrets (`ANTHROPIC_API_KEY`, `X-App-Token`) live in Cloudflare. So the repo holds nothing sensitive — which is convenient, because GitHub Pages from a *private* repo requires a paid GitHub plan. Public repo, private data.

**7. The Worker source is served by Pages too.** With the site served from the repo root, `worker/src/index.js` is fetchable at `cassie7511.github.io/CassieAITracker/worker/src/index.js`. That is harmless — there are no secrets in the source, only references to `env.ANTHROPIC_API_KEY` — but worth knowing so it does not look alarming later.

---

## 7. Repo layout

A separate `CassieAITracker` repo, with **GitHub Pages serving from the root of `main`**. That is the least-friction setup — no `/docs` folder convention, no Actions workflow, just push and it is live at `cassie7511.github.io/CassieAITracker/`.

```
CassieAITracker/             ← repo root IS the served site
├── index.html         ← the PWA (Phase 2+)
├── app.js
├── style.css
├── manifest.json
├── sw.js
├── icons/
├── .nojekyll          ← tells Pages to skip Jekyll processing
├── PLAN.md            ← this file
├── CHECKLIST.md       ← what you need to do before and during the build
├── tokens.css         ← palette extracted from your site
└── worker/            ← deployed by wrangler, not by Pages
    ├── src/index.js
    ├── wrangler.toml
    └── package.json
```

**The alternative** is dropping it into your existing `cassie7511.github.io` repo as `Projects/cassieaitracker/`, matching the convention already there (`Projects/warehouse/`, `Projects/adstream/`…). That puts it on the portfolio page alongside your other work. A separate repo keeps a personal calorie tracker off that list and gives it its own deploy — which is why the plan defaults to it. Either way it is a subpath, so the relative-paths rule in Phase 5 applies the same.
