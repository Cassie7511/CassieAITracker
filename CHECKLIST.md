# AITracker — Pre-Development Checklist

Everything that needs to be true before, and while, we build. Sections A and B block Phase 1. Section C are decisions only you can make. D and E can happen any time before Phase 5.

---

## A. Accounts & billing — *blocks everything*

- [ ] **Read this first: your Claude Pro/Max subscription does not include API access.** They are separate products with separate billing. Nothing you have already paid for covers this app. You need a Console account with its own payment method.
- [ ] Create an account at **console.anthropic.com** (same email is fine)
- [ ] Add a payment method and **purchase starter credits** — $5 is months of use at the volumes in the plan
- [ ] Create an API key: Console → API Keys → Create Key. Name it `aitracker`
- [ ] **Copy the key immediately and store it in a password manager.** It is shown exactly once, and it is never displayed again
- [ ] Set a monthly **spend limit** (Console → Settings → Limits). Suggest $10/month. This is your real protection against a leaked URL or a runaway loop
- [ ] Turn on usage **email alerts** at ~50% of that limit
- [ ] Create a free **Cloudflare account** at dash.cloudflare.com
  - Used for the Worker only — the frontend is on GitHub Pages. No credit card needed for the Workers free tier (100k requests/day).

**Do not** paste the API key into a file in this repo, a chat, or the frontend. It goes into one place only: `wrangler secret put`.

---

## B. Local tooling — *blocks Phase 1*

- [ ] Install **Node.js LTS** (v20 or v22) — verify with `node --version`
- [ ] Verify npm works — `npm --version`
- [ ] Install Wrangler — `npm install -g wrangler` (or we use `npx wrangler` per-project)
- [ ] Run `wrangler login` — opens a browser, authorizes the CLI against your Cloudflare account
- [ ] Confirm **git** is installed — `git --version`
- [ ] Create a **public** GitHub repo named `AITracker`
  - Public is correct here: the repo holds only code. Your food log lives on the phone, and both secrets live in Cloudflare. Pages from a private repo also requires a paid GitHub plan.
- [ ] Enable GitHub Pages: repo → Settings → Pages → Source: **Deploy from a branch** → `main` / `/ (root)`
- [ ] Confirm the site is live at `https://cassie7511.github.io/AITracker/` over HTTPS
  - HTTPS is not optional — service workers and Add to Home Screen refuse to work without it. `*.github.io` gives it to you automatically.
- [ ] Confirm this folder is where you want the project to live, or tell me where to move it

---

## C. Decisions only you can make

- [x] ~~**Model tier.**~~ **Decided: `claude-sonnet-5`** — measured at ~$0.0016/meal, **~$0.24/month** at 5 meals/day, ~1.8s. Benchmarked against Haiku 4.5 on 12 label foods with known values: **1% mean absolute error vs 8%**, exact on 9 of 12. Haiku is ~3× cheaper but missed ground turkey by −49% and ground beef by +18%; not worth 8× the error to save $0.15/month.
- [x] ~~**Daily targets.**~~ **Decided: none.** No goal lines, no progress bars — Today shows plain running totals. Easy to add later without a data migration, since nothing about the stored shape depends on it.
- [x] ~~**Track fat?**~~ **Decided: no.** Not stored, not displayed, and the system prompt tells Claude explicitly not to report it. Calories, protein, and carbs only.
- [x] ~~**Day boundary.**~~ **Decided: manual only.** No midnight rollover, no cutoff time — the open period runs until you tap **New day**. The header reads *Open since &lt;date&gt;* when that spans more than one calendar day.
- [ ] **Portion input style.** Do you think in ounces, grams, cups, or "a plate of"? This shapes the prompt wording and the manual-entry form.
- [ ] **Chart approach.** Chart.js via CDN (fast to build, ~60KB) or hand-rolled SVG (zero dependencies, matches the way your site is built). I lean hand-rolled SVG for consistency, but Chart.js is quicker to get right.
- [x] ~~**Which phone?**~~ **Decided: iPhone.** Drives the safe-area insets, the 16px minimum input font (below that iOS zooms on focus), the share-sheet export path, and makes the storage-persistence work in Phase 5 load-bearing rather than optional.

---

## D. Assets to produce

- [ ] **App icon**, 192×192 and 512×512 PNG, plus a 180×180 for iOS. Pink-on-black to match the site. I can generate these if you do not have something in mind
- [ ] **App name** as it appears under the home-screen icon. Keep it under ~12 characters or iOS truncates it. "AITracker" fits
- [ ] **Theme color** for the phone status bar — `#0d0d0f` to match the background is the obvious pick

---

## E. Before the app lands on your phone

- [ ] Note the Worker URL that `wrangler deploy` prints — `https://aitracker.<you>.workers.dev`
- [ ] Confirm the Worker's CORS `ALLOWED` origin is exactly `https://cassie7511.github.io`
  - No trailing slash, no path. A mismatch here fails as a confusing browser console error, not a server error.
- [ ] Generate the shared secret (`X-App-Token`) and store it as a second Worker secret
- [ ] Paste that same token into the app on first launch, on each device you use
  - It cannot be committed — a Pages site is publicly served regardless of repo visibility.
- [ ] Install to Home Screen and confirm it opens full-screen with no browser chrome
- [ ] Grant persistent storage when prompted
- [ ] Log one real meal end to end, then close the day, and confirm it shows up in history
- [ ] Export a JSON backup and confirm you can read the file

---

## What I need from you to start Phase 1

Only three things are truly blocking:

1. The API key exists and has a spend cap (section A)
2. `wrangler login` has succeeded (section B)
3. Your answer on **model tier** and **daily targets** (section C)

Everything else can be decided while we build.
