/* Cassie's CalTrackerAI — Phase 3
   Describe a meal, Claude returns calories/protein/carbs, it lands in the log.
   Everything persists locally; the only network call is to your own Worker. */

const DB_NAME = "aitracker";
const DB_VERSION = 2; // v2 adds the `foods` store
const UNDO_WINDOW_MS = 60 * 60 * 1000; // an hour to take back a "New day"

const DEFAULT_API = location.hostname === "localhost" || location.hostname === "127.0.0.1"
  ? "http://127.0.0.1:8787"
  : "https://cassieaitracker.cassie11.workers.dev";

/* ── IndexedDB ────────────────────────────────────────────────────────────
   IndexedDB rather than localStorage specifically for iOS: Safari clears
   localStorage after ~7 days of non-use, while an installed PWA's IndexedDB
   with persistence granted is exempt. */

const idb = {
  db: null,

  async open() {
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("entries")) db.createObjectStore("entries", { keyPath: "id" });
        if (!db.objectStoreNames.contains("days")) db.createObjectStore("days", { keyPath: "date" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
        if (!db.objectStoreNames.contains("foods")) db.createObjectStore("foods", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  },

  _run(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.onerror = () => reject(t.error);
      t.oncomplete = () => resolve(req ? req.result : undefined);
    });
  },

  getAll(store) { return this._run(store, "readonly", (s) => s.getAll()); },
  get(store, key) { return this._run(store, "readonly", (s) => s.get(key)); },
  put(store, value) { return this._run(store, "readwrite", (s) => s.put(value)); },
  del(store, key) { return this._run(store, "readwrite", (s) => s.delete(key)); },
  clear(store) { return this._run(store, "readwrite", (s) => s.clear()); },
};

const meta = {
  async get(key, fallback = null) {
    const row = await idb.get("meta", key);
    return row && row.value !== null && row.value !== undefined ? row.value : fallback;
  },
  set(key, value) { return idb.put("meta", { key, value }); },
};

/* ── helpers ─────────────────────────────────────────────────────────────── */

// Local calendar date. Deliberately not toISOString() — that returns UTC and
// would label days wrong for anyone not on GMT.
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function prettyDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });
}

const ZERO = { calories: 0, protein_g: 0, carbs_g: 0 };

function sum(list) {
  return list.reduce((a, e) => ({
    calories: a.calories + (e.calories || 0),
    protein_g: a.protein_g + (e.protein_g || 0),
    carbs_g: a.carbs_g + (e.carbs_g || 0),
  }), { ...ZERO });
}

const int = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const $ = (id) => document.getElementById(id);

// crypto.randomUUID exists only in a secure context. localhost counts; testing
// over a LAN IP like http://192.168.x.x does not, and iOS would throw there.
function uuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ── state ───────────────────────────────────────────────────────────────── */

let entries = [];      // the open day
let days = [];         // banked days, newest first
let currentDate = null; // the date the open period started
let config = { apiBase: DEFAULT_API, appToken: "" };

/* ── rendering ───────────────────────────────────────────────────────────── */

function renderHeader() {
  const today = localDate();
  // Rollover is manual only, so the open period can span several calendar days.
  // Say so rather than mislabelling a three-day stretch as "Today".
  if (currentDate === today) {
    $("day-label").textContent = "Today";
    $("today-date").textContent = prettyDate(currentDate);
  } else {
    $("day-label").textContent = "Open since";
    $("today-date").textContent = prettyDate(currentDate);
  }
}

function renderTotals() {
  const t = sum(entries.filter((e) => e.status !== "pending" && e.status !== "error"));
  $("t-cal").textContent = t.calories;
  $("t-protein").textContent = `${t.protein_g}g`;
  $("t-carbs").textContent = `${t.carbs_g}g`;
}

function entryRow(e) {
  const li = document.createElement("li");
  li.className = "entry";
  if (e.status) li.classList.add(`is-${e.status}`);

  if (e.thumb) {
    const img = document.createElement("img");
    img.className = "entry-thumb";
    img.src = e.thumb; // a data: URL this app generated, never a remote address
    img.alt = "";
    li.append(img);
  }

  const main = document.createElement("div");
  main.className = "entry-main";

  const name = document.createElement("div");
  name.className = "entry-name";
  name.textContent = e.name || e.raw; // textContent — food names are user input
  main.append(name);

  const sub = document.createElement("div");
  sub.className = "entry-macros";

  if (e.status === "pending") {
    sub.textContent = "analyzing…";
    sub.classList.add("is-working");
  } else if (e.status === "error") {
    sub.textContent = e.error || "Could not analyze";
    sub.classList.add("is-error");
  } else {
    sub.textContent = `P ${e.protein_g}g · C ${e.carbs_g}g`;
    if (e.edited) {
      const tag = document.createElement("span");
      tag.className = "edited-tag";
      tag.textContent = " ·  edited";
      sub.append(tag);
    }
  }
  main.append(sub);

  li.append(main);

  if (e.status === "pending") {
    const spin = document.createElement("div");
    spin.className = "spinner";
    li.append(spin);
  } else if (e.status === "error") {
    const retry = document.createElement("button");
    retry.className = "entry-action";
    retry.type = "button";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => retryEntry(e.id));
    li.append(retry);
  } else {
    const cal = document.createElement("button");
    cal.className = "entry-cal";
    cal.type = "button";
    cal.textContent = e.calories;
    cal.setAttribute("aria-label", `Edit ${e.name}`);
    cal.addEventListener("click", () => openEditor(li, e));
    li.append(cal);
  }

  const del = document.createElement("button");
  del.className = "entry-del";
  del.type = "button";
  del.textContent = "×";
  del.setAttribute("aria-label", `Delete ${e.name || e.raw}`);
  del.addEventListener("click", () => removeEntry(e.id));
  li.append(del);

  return li;
}

// Tap the calorie number to correct any of the three values in place.
function openEditor(li, e) {
  li.replaceChildren();
  li.classList.add("is-editing");

  const form = document.createElement("form");
  form.className = "edit-form";

  const grid = document.createElement("div");
  grid.className = "f-grid";
  const fields = {};
  for (const [key, label, value] of [
    ["calories", "kcal", e.calories],
    ["protein_g", "protein", e.protein_g],
    ["carbs_g", "carbs", e.carbs_g],
  ]) {
    const wrap = document.createElement("label");
    wrap.className = "f-field";
    const span = document.createElement("span");
    span.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.inputMode = "numeric";
    input.min = "0";
    input.value = value;
    fields[key] = input;
    wrap.append(span, input);
    grid.append(wrap);
  }

  const row = document.createElement("div");
  row.className = "edit-actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "btn-secondary";
  save.textContent = "Save";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "linkish";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", renderEntries);
  row.append(save, cancel);

  form.append(grid, row);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const updated = {
      ...e,
      calories: int(fields.calories.value),
      protein_g: int(fields.protein_g.value),
      carbs_g: int(fields.carbs_g.value),
      edited: true,
    };
    entries = entries.map((x) => (x.id === e.id ? updated : x));
    await idb.put("entries", updated);
    renderEntries();
    renderTotals();

    // A correction is the most reliable signal there is about what a food
    // actually contains — remember it so this is the last time you fix it.
    // Not for photos: the numbers belong to that picture, and the row's name
    // ("Food photo", or a note like "ate half") is no key for a future meal.
    const isPhoto = updated.source === "ai-photo" || updated.source === "ai-label";
    const label = (updated.raw || updated.name || "").trim();
    if (label && !isPhoto) {
      await saveFood({ label, ...updated });
      toast("Remembered — next time this logs instantly.");
    }
  });

  li.append(form);
  fields.calories.focus();
  fields.calories.select();
}

function renderEntries() {
  const list = $("entry-list");
  list.replaceChildren();
  // Newest first — what you just logged is what you want to see.
  for (const e of [...entries].reverse()) list.append(entryRow(e));
  $("entries-empty").hidden = entries.length > 0;
}

function renderToday() {
  renderHeader();
  renderTotals();
  renderEntries();
}

/* ── sample data ──────────────────────────────────────────────────────────
   Seven plausible days so the charts have something to show before you have
   banked a real week. Every row is tagged `sample: true`, which is what the
   remove button keys off — real days can never be caught in the cleanup. */

const SAMPLE_MEALS = [
  ["Breakfast", 0.22],
  ["Lunch", 0.32],
  ["Dinner", 0.34],
  ["Evening snack", 0.12],
];

const jitter = (centre, spread) =>
  Math.round(centre + (Math.random() * 2 - 1) * spread);

function shiftDate(iso, deltaDays) {
  const [y, m, d] = iso.split("-").map(Number);
  return localDate(new Date(y, m - 1, d + deltaDays)); // local ctor, no UTC drift
}

function sampleDay(date) {
  const totals = {
    calories: jitter(2300, 200),
    protein_g: jitter(170, 18),
    carbs_g: jitter(220, 30),
  };

  // Split the day across meals by weight, with the last absorbing the rounding
  // remainder so the entries always add up to the totals exactly.
  const entries = [];
  const running = { calories: 0, protein_g: 0, carbs_g: 0 };

  SAMPLE_MEALS.forEach(([name, weight], i) => {
    const last = i === SAMPLE_MEALS.length - 1;
    const part = {};
    for (const key of ["calories", "protein_g", "carbs_g"]) {
      part[key] = last
        ? totals[key] - running[key]
        : Math.round(totals[key] * weight);
      running[key] += part[key];
    }
    entries.push({
      id: uuid(),
      ts: new Date(`${date}T12:00:00`).getTime() + i * 60000,
      source: "sample",
      raw: name,
      name,
      ...part,
      edited: false,
    });
  });

  return { date, entries, totals, closedAt: Date.now(), sample: true };
}

const hasSamples = () => days.some((d) => d.sample);

async function addSampleWeek() {
  const existing = new Set(days.map((d) => d.date));
  const made = [];

  // Walk back from the open day, skipping any date already banked.
  for (let back = 1; made.length < 7 && back < 40; back++) {
    const date = shiftDate(currentDate, -back);
    if (existing.has(date)) continue;
    made.push(sampleDay(date));
  }

  for (const d of made) await idb.put("days", d);
  days = [...days, ...made].sort((a, b) => b.date.localeCompare(a.date));

  renderHistory();
  toast(`Added ${made.length} sample days`, "Remove", removeSampleWeek);
}

async function removeSampleWeek() {
  const doomed = days.filter((d) => d.sample);
  for (const d of doomed) await idb.del("days", d.date);
  days = days.filter((d) => !d.sample);
  renderHistory();
  toast(`Removed ${doomed.length} sample days`);
}

/* ── charts ───────────────────────────────────────────────────────────────
   Hand-rolled SVG, no dependencies, matching how the rest of the site is built.

   Two charts rather than one because calories are kcal and macros are grams.
   Putting them together would need two y-scales on one plot, which makes the
   lines' relative heights meaningless.

   Series colours are NOT the site's UI pink. That pink is a text accent — too
   light and too desaturated to work as a data mark on this background. These
   three were checked with a CVD validator: rose/blue/amber separate under
   deuteranopia and protanopia; the green and violet I tried first did not. */

const SERIES = {
  calories: "#d4627f", // rose
  protein: "#4b96c4",  // blue
  carbs: "#b5872f",    // amber
};

const CHART = { w: 340, h: 150, padL: 34, padR: 10, padT: 12, padB: 22 };

const svgEl = (name, attrs) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

// Rounded at the free end only — the baseline end stays square so bars sit flat.
function barPath(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} `
       + `L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

function niceMax(v) {
  if (v <= 0) return 100;
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / mag) * mag;
}

function drawFrame(svg, max, count) {
  svg.replaceChildren();
  const { w, h, padL, padR, padT, padB } = CHART;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  // Recessive grid: three lines, thin, well behind the data.
  for (let i = 0; i <= 2; i++) {
    const value = (max / 2) * i;
    const y = padT + innerH - (value / max) * innerH;
    // Themed colours go on classes, not presentation attributes — var() in an
    // SVG attribute does not reliably resolve.
    svg.append(svgEl("line", {
      x1: padL, x2: w - padR, y1: y, y2: y, class: "grid-line",
    }));
    const label = svgEl("text", {
      x: padL - 6, y: y + 3.5, "text-anchor": "end", class: "axis-text",
    });
    label.textContent = Math.round(value);
    svg.append(label);
  }

  return { innerW, innerH, band: innerW / Math.max(count, 1) };
}

function xLabels(svg, days) {
  const { w, h, padL, padR, padB } = CHART;
  const innerW = w - padL - padR;
  const band = innerW / days.length;
  // Only ever the ends, and only when they cannot collide.
  const picks = days.length === 1 ? [0] : [0, days.length - 1];
  for (const i of picks) {
    const [, m, d] = days[i].date.split("-");
    const t = svgEl("text", {
      x: padL + band * (i + 0.5),
      y: h - padB + 13,
      "text-anchor": i === 0 ? "start" : "end",
      class: "axis-text",
    });
    t.textContent = `${Number(m)}/${Number(d)}`;
    svg.append(t);
  }
}

function drawCalories(days) {
  const svg = $("chart-cal");
  const max = niceMax(Math.max(...days.map((d) => d.totals.calories), 1));
  const { innerH, band } = drawFrame(svg, max, days.length);
  const { padL, padT } = CHART;

  days.forEach((d, i) => {
    const val = d.totals.calories;
    const bh = (val / max) * innerH;
    // 2px of surface between neighbours so bars never merge into a block.
    const bw = Math.max(2, Math.min(band - 2, 26));
    const x = padL + band * (i + 0.5) - bw / 2;
    svg.append(svgEl("path", {
      d: barPath(x, padT + innerH - bh, bw, bh, 4),
      fill: SERIES.calories,
    }));
  });

  xLabels(svg, days);
  return { svg, band };
}

function drawMacros(days) {
  const svg = $("chart-macro");
  const max = niceMax(Math.max(
    ...days.map((d) => Math.max(d.totals.protein_g, d.totals.carbs_g)), 1,
  ));
  const { innerH, band } = drawFrame(svg, max, days.length);
  const { padL, padT } = CHART;

  const pt = (i, v) => [padL + band * (i + 0.5), padT + innerH - (v / max) * innerH];

  for (const [key, colour] of [["protein_g", SERIES.protein], ["carbs_g", SERIES.carbs]]) {
    const points = days.map((d, i) => pt(i, d.totals[key]));

    if (points.length > 1) {
      svg.append(svgEl("polyline", {
        points: points.map((p) => p.join(",")).join(" "),
        fill: "none", stroke: colour, "stroke-width": 2,
        "stroke-linejoin": "round", "stroke-linecap": "round",
      }));
    }

    // Markers only when they will not collide into a solid rule.
    if (points.length <= 30) {
      for (const [x, y] of points) {
        // .marker carries the 2px surface ring, so the series stay readable
        // where they cross. Class, not attribute — see drawFrame.
        svg.append(svgEl("circle", { cx: x, cy: y, r: 4, fill: colour, class: "marker" }));
      }
    }
  }

  xLabels(svg, days);
  return { svg, band };
}

/* Tap or drag across a chart to read a day. Touch-first: the hit target is the
   whole band, far wider than the mark. */
function attachTip(svg, tip, days, band, format) {
  const show = (ev) => {
    const rect = svg.getBoundingClientRect();
    const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
    const scale = CHART.w / rect.width;
    const i = Math.floor((x * scale - CHART.padL) / band);
    const day = days[Math.max(0, Math.min(days.length - 1, i))];
    if (!day) return;

    tip.replaceChildren();
    const date = document.createElement("strong");
    date.textContent = prettyDate(day.date);
    const body = document.createElement("span");
    body.textContent = format(day);
    tip.append(date, body);
    tip.hidden = false;

    const left = Math.max(4, Math.min(rect.width - 110, x - 55));
    tip.style.left = `${left}px`;
  };

  const hide = () => { tip.hidden = true; };

  svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointermove", (ev) => { if (ev.buttons || ev.pointerType === "mouse") show(ev); });
  svg.addEventListener("pointerup", hide);
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("touchmove", show, { passive: true });
  svg.addEventListener("touchend", hide);
}

let historyRange = 7;

function renderCharts() {
  const wrap = $("history-charts");
  if (!days.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  // days is newest-first; charts read left to right, oldest to newest.
  const range = historyRange > 0 ? days.slice(0, historyRange) : days;
  const ordered = [...range].reverse();

  const avg = (key) =>
    Math.round(ordered.reduce((a, d) => a + d.totals[key], 0) / ordered.length);

  $("avg-cal").textContent = avg("calories");
  $("avg-protein").textContent = `${avg("protein_g")}g`;
  $("avg-carbs").textContent = `${avg("carbs_g")}g`;

  const cal = drawCalories(ordered);
  const mac = drawMacros(ordered);

  attachTip($("chart-cal"), $("tip-cal"), ordered, cal.band,
    (d) => `${d.totals.calories} kcal`);
  attachTip($("chart-macro"), $("tip-macro"), ordered, mac.band,
    (d) => `P ${d.totals.protein_g}g · C ${d.totals.carbs_g}g`);
}

/* Hold a banked day to remove it. Pointer events cover touch and mouse alike;
   moving more than a few pixels means you are scrolling, so the hold is off.
   A touch scroll also fires pointercancel, which cancels it too. Right-click
   (and Android's own long-press menu) arrive as contextmenu. */
const HOLD_MS = 500;

function onHold(el, fn) {
  let timer = null;
  let x = 0;
  let y = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    el.classList.remove("is-holding");
  };
  el.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    x = ev.clientX;
    y = ev.clientY;
    el.classList.add("is-holding");
    timer = setTimeout(() => {
      cancel();
      navigator.vibrate?.(10);
      fn();
    }, HOLD_MS);
  });
  el.addEventListener("pointermove", (ev) => {
    if (timer && Math.hypot(ev.clientX - x, ev.clientY - y) > 10) cancel();
  });
  el.addEventListener("pointerup", cancel);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("pointerleave", cancel);
  el.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    cancel();
    fn();
  });
}

function openDayConfirm(li, d) {
  if (li.classList.contains("is-confirming")) return; // hold + contextmenu can both fire

  // One confirmation at a time — put any other open one back to normal.
  for (const other of document.querySelectorAll(".day.is-confirming")) {
    const od = days.find((x) => x.date === other.dataset.date);
    if (od) other.replaceWith(dayRow(od));
  }

  li.replaceChildren();
  li.classList.add("is-confirming");

  const text = document.createElement("div");
  text.className = "day-confirm-text";
  text.textContent = `Remove ${prettyDate(d.date)}?`;

  const sub = document.createElement("div");
  sub.className = "day-confirm-sub";
  sub.textContent = `${d.totals.calories} kcal · ${d.entries.length} item${d.entries.length === 1 ? "" : "s"}`;

  const actions = document.createElement("div");
  actions.className = "day-confirm-actions";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn-remove";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => removeDay(d.date));
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "linkish";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => li.replaceWith(dayRow(d)));
  actions.append(remove, cancel);

  li.append(text, sub, actions);
  remove.focus();
}

async function removeDay(date) {
  const gone = days.find((d) => d.date === date);
  if (!gone) return;
  await idb.del("days", date);
  days = days.filter((d) => d.date !== date);
  renderHistory();
  toast(`Removed ${prettyDate(date)}`, "Undo", () => restoreDay(gone));
}

async function restoreDay(day) {
  // A new day banked under the same date since then wins; never overwrite it.
  if (days.some((d) => d.date === day.date)) {
    toast("A day with that date exists now — not restored.");
    return;
  }
  await idb.put("days", day);
  days = [...days, day].sort((a, b) => b.date.localeCompare(a.date));
  renderHistory();
}

function dayRow(d) {
  const li = document.createElement("li");
  li.className = "day";
  li.dataset.date = d.date;
  onHold(li, () => openDayConfirm(li, d));

  const head = document.createElement("div");
  head.className = "day-head";
  const date = document.createElement("span");
  date.className = "day-date";
  date.textContent = prettyDate(d.date);
  if (d.sample) {
    // Labelled so seeded days are never mistaken for something you logged.
    const tag = document.createElement("span");
    tag.className = "sample-tag";
    tag.textContent = "sample";
    date.append(" ", tag);
  }
  const cal = document.createElement("span");
  cal.className = "day-cal";
  cal.textContent = `${d.totals.calories} kcal`;
  head.append(date, cal);

  const macros = document.createElement("div");
  macros.className = "day-macros";
  for (const text of [
    `protein ${d.totals.protein_g}g`,
    `carbs ${d.totals.carbs_g}g`,
    `${d.entries.length} item${d.entries.length === 1 ? "" : "s"}`,
  ]) {
    const span = document.createElement("span");
    span.textContent = text;
    macros.append(span);
  }

  li.append(head, macros);
  return li;
}

function renderHistory() {
  const list = $("day-list");
  list.replaceChildren();
  for (const d of days) list.append(dayRow(d));

  $("history-empty").hidden = days.length > 0;
  $("days-label").hidden = days.length === 0;
  $("sample-toggle").textContent = hasSamples() ? "Remove sample week" : "Add sample week";
  renderCharts();
}

function foodRow(f) {
  const li = document.createElement("li");
  li.className = "entry";

  const main = document.createElement("div");
  main.className = "entry-main";

  const name = document.createElement("div");
  name.className = "entry-name";
  name.textContent = f.label;

  const sub = document.createElement("div");
  sub.className = "entry-macros";
  sub.textContent = `P ${f.protein_g}g · C ${f.carbs_g}g`;
  if (f.uses) {
    const used = document.createElement("span");
    used.className = "edited-tag";
    used.textContent = ` ·  used ${f.uses}×`;
    sub.append(used);
  }

  main.append(name, sub);

  const cal = document.createElement("button");
  cal.className = "entry-cal";
  cal.type = "button";
  cal.textContent = f.calories;
  cal.setAttribute("aria-label", `Edit ${f.label}`);
  cal.addEventListener("click", () => openFoodEditor(li, f));

  const del = document.createElement("button");
  del.className = "entry-del";
  del.type = "button";
  del.textContent = "×";
  del.setAttribute("aria-label", `Forget ${f.label}`);
  del.addEventListener("click", () => deleteFood(f.key));

  li.append(main, cal, del);
  return li;
}

function openFoodEditor(li, f) {
  li.replaceChildren();
  li.classList.add("is-editing");

  const form = document.createElement("form");
  form.className = "edit-form";

  const grid = document.createElement("div");
  grid.className = "f-grid";
  const fields = {};
  for (const [key, label, value] of [
    ["calories", "kcal", f.calories],
    ["protein_g", "protein", f.protein_g],
    ["carbs_g", "carbs", f.carbs_g],
  ]) {
    const wrap = document.createElement("label");
    wrap.className = "f-field";
    const span = document.createElement("span");
    span.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.inputMode = "numeric";
    input.min = "0";
    input.value = value;
    fields[key] = input;
    wrap.append(span, input);
    grid.append(wrap);
  }

  const row = document.createElement("div");
  row.className = "edit-actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "btn-secondary";
  save.textContent = "Save";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "linkish";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", renderFoods);
  row.append(save, cancel);

  form.append(grid, row);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    await saveFood({
      label: f.label,
      calories: fields.calories.value,
      protein_g: fields.protein_g.value,
      carbs_g: fields.carbs_g.value,
    });
  });

  li.append(form);
  fields.calories.focus();
  fields.calories.select();
}

function renderFoods() {
  const list = $("food-list");
  list.replaceChildren();

  const sorted = [...foods.values()].sort(
    (a, b) => (b.uses ?? 0) - (a.uses ?? 0) || a.label.localeCompare(b.label),
  );
  for (const f of sorted) list.append(foodRow(f));

  $("foods-empty").hidden = sorted.length > 0;
  $("foods-count").textContent = sorted.length
    ? `${sorted.length} saved`
    : "Library";
}

/* ── toast ───────────────────────────────────────────────────────────────── */

let toastTimer = null;

function toast(message, actionLabel, onAction) {
  const el = $("toast");
  el.replaceChildren();

  const text = document.createElement("span");
  text.textContent = message;
  el.append(text);

  if (actionLabel) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = actionLabel;
    btn.addEventListener("click", () => { hideToast(); onAction(); });
    el.append(btn);
  }

  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, actionLabel ? 8000 : 2600);
}

function hideToast() {
  clearTimeout(toastTimer);
  $("toast").hidden = true;
}

/* ── saved foods ──────────────────────────────────────────────────────────
   A food you have saved is logged from your own numbers: instant, free, and
   identical every time. That matters because the model genuinely wobbles on
   quantities like protein — the same query can come back 78g, 80g, or 82g.
   Your number does not.

   Matching is on a normalised token set, so word order, punctuation, casing
   and unit spellings do not have to match. "1 pound ground beef 85 15" and
   "1 lb 85/15 ground beef" resolve to the same key. Quantities stay in the
   key, so "1 lb chicken" and "2 lb chicken" remain different foods. */

const UNIT_ALIASES = {
  pound: "lb", pounds: "lb", lbs: "lb",
  ounce: "oz", ounces: "oz", ozs: "oz",
  gram: "g", grams: "g", gs: "g",
  tablespoon: "tbsp", tablespoons: "tbsp",
  teaspoon: "tsp", teaspoons: "tsp",
  cups: "cup", slices: "slice", pieces: "piece", eggs: "egg",
};

const STOPWORDS = new Set(["a", "an", "the", "of", "with", "and", "some", "my"]);

const NUMBER_WORDS = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
  half: "0.5", dozen: "12",
};

function foodKey(text) {
  const tokens = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")           // "85/15" -> "85 15", "joe's" -> "joe s"
    .replace(/(\d)([a-z])/g, "$1 $2")       // "6oz" -> "6 oz"
    .replace(/([a-z])(\d)/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => NUMBER_WORDS[t] || t)       // "two eggs" == "2 eggs"
    .map((t) => UNIT_ALIASES[t] || t)       // "pounds" == "lb"
    // Crude plural strip so "joes" == "joe s" == "joe". It only has to be
    // consistent, never correct — this string is a key, never displayed.
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t))
    .filter((t) => !STOPWORDS.has(t))
    .filter((t) => t.length > 1 || /^\d$/.test(t)); // drop stray letters, keep digits

  // Set + sort so word order and repetition cannot change the key.
  return [...new Set(tokens)].sort().join(" ");
}

let foods = new Map(); // key -> Food

async function loadFoods() {
  const rows = await idb.getAll("foods");
  foods = new Map(rows.map((f) => [f.key, f]));
}

function findFood(text) {
  const key = foodKey(text);
  return key ? foods.get(key) : undefined;
}

async function saveFood({ label, calories, protein_g, carbs_g }) {
  const key = foodKey(label);
  if (!key) return null;
  const existing = foods.get(key);
  const food = {
    key,
    label: label.trim(),
    calories: int(calories),
    protein_g: int(protein_g),
    carbs_g: int(carbs_g),
    uses: existing?.uses ?? 0,
    updatedAt: Date.now(),
  };
  foods.set(key, food);
  await idb.put("foods", food);
  renderFoods();
  return food;
}

async function deleteFood(key) {
  const gone = foods.get(key);
  foods.delete(key);
  await idb.del("foods", key);
  renderFoods();
  if (gone) toast(`Forgot ${gone.label}`, "Undo", () => saveFood({ ...gone, label: gone.label }));
}

async function noteFoodUse(food) {
  const updated = { ...food, uses: (food.uses ?? 0) + 1 };
  foods.set(food.key, updated);
  await idb.put("foods", updated);
}

/* ── pure macro entries ───────────────────────────────────────────────────
   "200 cals 10g protein" states everything there is to know, so it is logged
   exactly as typed — anything you did not name stays 0, never invented.

   This fires ONLY when the input is macro declarations and nothing else. If a
   single food word survives the strip it is a description, and Claude gets it.
   That is the guard the earlier version lacked: in "ground beef and 610 cals of
   rice" the 610 covers only the rice, and nothing local can know that. */

const CAL_RE = /(\d+(?:\.\d+)?)\s*(?:kcals?|cals?|calories)\b/i;
const PROTEIN_RE = /(\d+(?:\.\d+)?)\s*g?\s*(?:protein|prot)\b/i;
const PROTEIN_RE_ALT = /\bprotein\s*[:=]?\s*(\d+(?:\.\d+)?)\s*g?/i;
const CARB_RE = /(\d+(?:\.\d+)?)\s*g?\s*(?:carb(?:ohydrate)?s?)\b/i;
const CARB_RE_ALT = /\bcarb(?:ohydrate)?s?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*g?/i;

function parseMacroOnly(text) {
  let rest = text;

  // Consume each match so one "30g" cannot be read as both protein and carbs.
  const take = (...patterns) => {
    for (const re of patterns) {
      const m = rest.match(re);
      if (m) {
        rest = rest.replace(m[0], " ");
        const n = Math.round(Number(m[1]));
        return Number.isFinite(n) && n >= 0 ? n : null;
      }
    }
    return null;
  };

  const calories = take(CAL_RE);
  if (!calories) return null;

  // Number-first ("10g protein") before label-first ("protein 10g"); the other
  // order lets "18g protein 20g carbs" read the 20 as protein.
  const protein = take(PROTEIN_RE, PROTEIN_RE_ALT);
  const carbs = take(CARB_RE, CARB_RE_ALT);

  // Anything left beyond filler means a food was named — not our case.
  const leftover = rest
    .replace(/\b(?:and|with|of|plus|a|an|the)\b/gi, " ")
    .replace(/[^a-z0-9]/gi, "");
  if (leftover) return null;

  return { calories, protein_g: protein ?? 0, carbs_g: carbs ?? 0 };
}

/* ── the Claude call ─────────────────────────────────────────────────────── */

async function analyze(payload, kind = "text", extra = {}) {
  const res = await fetch(`${config.apiBase}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Token": config.appToken },
    body: JSON.stringify({ kind, payload, ...extra }),
  });

  const data = await res.json().catch(() => ({}));

  // A token that stopped working mid-session belongs at the gate, not buried in
  // a row that says "Unauthorized".
  if (res.status === 401) {
    showGate(true, "Your token stopped working. Re-enter it to carry on.");
    throw new Error("Unauthorized");
  }

  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* Optimistic: the row appears the instant you submit, so the 3–6 seconds of
   round trip happen behind an interface that already responded. */
async function logByText(text) {
  // 1. Nothing but macros? Log exactly that. Unstated fields stay 0.
  const macros = parseMacroOnly(text);
  if (macros) {
    await addEntry({
      id: uuid(),
      ts: Date.now(),
      source: "manual",
      raw: text,
      name: "Manual entry",
      ...macros,
      edited: false,
    });
    return;
  }

  // 2. Saved before? Use your own numbers — instant, free, identical every time.
  const known = findFood(text);
  if (known) {
    await addEntry({
      id: uuid(),
      ts: Date.now(),
      source: "saved",
      raw: text,
      name: known.label,
      calories: known.calories,
      protein_g: known.protein_g,
      carbs_g: known.carbs_g,
      edited: false,
    });
    await noteFoodUse(known);
    return;
  }

  // 3. Otherwise ask Claude. It sees the whole description, so a multi-part
  //    meal is summed correctly — which local number-parsing could not do:
  //    in "ground beef and 610 cals of rice" the 610 belongs to the rice
  //    alone, and nothing in the text says so.
  const pending = {
    id: uuid(),
    ts: Date.now(),
    source: "ai-text",
    raw: text,
    name: text,          // your own words are the clearest label for the row
    calories: 0, protein_g: 0, carbs_g: 0,
    edited: false,
    status: "pending",
  };

  entries.push(pending);
  await idb.put("entries", pending);
  renderEntries();

  try {
    const result = await analyze(text);
    await resolvePending(pending.id, result);
  } catch (err) {
    await failPending(pending.id, err.message);
  }
}

/* ── photos ──────────────────────────────────────────────────────────────────
   One camera button. The picture may be a plate of food (portion estimate) or a
   nutrition facts label (transcription); the Worker's photo prompt handles both.
   Images are shrunk on the phone first — a 12 MP camera shot would be slow on
   cell data and cost several times more in image tokens for no gain. 1568px is
   the size at which label small print stays legible. ("label" remains only so
   entries created by the old label button can still be retried.) */

const PHOTO_MAX_EDGE = { photo: 1568, label: 1568 };
const THUMB_EDGE = 96;

function drawScaled(img, w, h, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  // JPEG has no alpha; without a fill, a transparent PNG comes out black.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

// Decoded through <img> rather than createImageBitmap: <img> honours the EXIF
// rotation on every current browser, so an upright phone photo stays upright.
async function prepareImage(file, kind) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const full = drawScaled(img, w, h, PHOTO_MAX_EDGE[kind], 0.85);
    return {
      data: full.slice(full.indexOf(",") + 1), // the Worker wants bare base64
      thumb: drawScaled(img, w, h, THUMB_EDGE, 0.7),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function photoRequest(e) {
  return analyze(e.image, e.kind, {
    media_type: "image/jpeg",
    ...(e.note ? { note: e.note } : {}),
  });
}

async function logByPhoto(file, kind) {
  let prepared;
  try {
    prepared = await prepareImage(file, kind);
  } catch {
    // Most often a HEIC file on a desktop browser that cannot decode it.
    toast("Couldn't read that image — try a JPEG or PNG.");
    return;
  }

  // Whatever is in the text box travels with the photo as a note.
  const note = $("f-text").value.trim();
  $("f-text").value = "";

  const pending = {
    id: uuid(),
    ts: Date.now(),
    source: kind === "label" ? "ai-label" : "ai-photo",
    kind,
    raw: note,
    note,
    name: note || (kind === "label" ? "Nutrition label" : "Food photo"),
    thumb: prepared.thumb,
    image: prepared.data, // kept only until the result lands, so Retry still works
    calories: 0, protein_g: 0, carbs_g: 0,
    edited: false,
    status: "pending",
  };

  entries.push(pending);
  await idb.put("entries", pending);
  renderEntries();

  try {
    const result = await photoRequest(pending);
    await resolvePending(pending.id, result);
  } catch (err) {
    await failPending(pending.id, err.message);
  }
}

async function resolvePending(id, result) {
  const pending = entries.find((e) => e.id === id);
  if (!pending) return; // deleted while in flight

  // The full-size image was only needed for the request. Dropping it keeps
  // banked days and exports small; the thumbnail stays.
  const { image, ...kept } = pending;

  // One submission, one row. Claude returns the combined total for whatever was
  // described, so "salad and a coke" is a single line rather than six.
  const done = {
    ...kept,
    calories: int(result.calories),
    protein_g: int(result.protein_g),
    carbs_g: int(result.carbs_g),
    status: undefined,
    error: undefined,
  };

  entries = entries.map((e) => (e.id === id ? done : e));
  await idb.put("entries", done);

  renderEntries();
  renderTotals();
}

async function failPending(id, message) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  const failed = { ...e, status: "error", error: message };
  entries = entries.map((x) => (x.id === id ? failed : x));
  await idb.put("entries", failed);
  renderEntries();
}

async function retryEntry(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  const again = { ...e, status: "pending", error: undefined };
  entries = entries.map((x) => (x.id === id ? again : x));
  await idb.put("entries", again);
  renderEntries();

  try {
    const result = again.image ? await photoRequest(again) : await analyze(again.raw);
    await resolvePending(id, result);
  } catch (err) {
    await failPending(id, err.message);
  }
}

/* ── actions ─────────────────────────────────────────────────────────────── */

async function addEntry(entry) {
  entries.push(entry);
  await idb.put("entries", entry);
  renderEntries();
  renderTotals();
}

async function removeEntry(id) {
  const gone = entries.find((e) => e.id === id);
  entries = entries.filter((e) => e.id !== id);
  await idb.del("entries", id);
  renderEntries();
  renderTotals();
  if (gone) toast(`Removed ${gone.name || gone.raw}`, "Undo", () => addEntry(gone));
}

async function closeDay() {
  if (!entries.length) {
    toast("Nothing logged yet — nothing to bank.");
    return;
  }
  if (entries.some((e) => e.status === "pending")) {
    toast("Still analyzing something — give it a second.");
    return;
  }

  const banked = entries.filter((e) => e.status !== "error");
  if (!banked.length) {
    toast("Only failed entries here — retry or delete them first.");
    return;
  }

  const day = {
    date: currentDate,
    entries: banked,
    totals: sum(banked),
    closedAt: Date.now(),
  };

  await idb.put("days", day);
  await idb.clear("entries");

  entries = [];
  currentDate = localDate();
  await meta.set("currentDate", currentDate);
  await meta.set("lastClosed", { date: day.date, at: Date.now() });

  days = [day, ...days.filter((d) => d.date !== day.date)]
    .sort((a, b) => b.date.localeCompare(a.date));

  renderToday();
  renderHistory();
  toast(`${prettyDate(day.date)} banked — ${day.totals.calories} kcal`, "Undo", () => reopenDay(day.date));
}

async function reopenDay(date) {
  const day = await idb.get("days", date);
  if (!day) return;

  const last = await meta.get("lastClosed");
  if (!last || last.date !== date || Date.now() - last.at > UNDO_WINDOW_MS) {
    toast("That day is past the undo window.");
    return;
  }

  for (const e of day.entries) await idb.put("entries", e);
  await idb.del("days", date);
  await meta.set("currentDate", date);
  await meta.set("lastClosed", null);

  entries = day.entries;
  currentDate = date;
  days = days.filter((d) => d.date !== date);

  renderToday();
  renderHistory();
  toast("Day reopened.");
}

async function exportJSON() {
  const payload = { exportedAt: new Date().toISOString(), currentDate, open: entries, history: days };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const filename = `caltrackerai-${localDate()}.json`;

  // On iOS the share sheet gives a real "Save to Files"; a plain download link
  // is unreliable there. Fall back to the link everywhere else.
  const file = new File([blob], filename, { type: "application/json" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Cassie's CalTrackerAI export" });
      return;
    } catch (err) {
      if (err.name === "AbortError") return; // dismissed the sheet
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ── setup panel ─────────────────────────────────────────────────────────── */

const isConnected = () => Boolean(config.appToken && config.apiBase);

function showGate(show, message = "") {
  $("gate").hidden = !show;
  $("app").hidden = show;
  const err = $("gate-error");
  err.textContent = message;
  err.hidden = !message;
  if (show) {
    $("s-url").value = config.apiBase || DEFAULT_API;
    $("s-token").value = config.appToken || "";
  }
}

function gateBusy(busy) {
  const btn = $("s-save");
  btn.disabled = busy;
  btn.textContent = busy ? "Checking…" : "Connect";
}

/* Verify the credentials against /api/ping before letting anyone in. The check
   costs nothing — it never reaches Claude — and turns a mystery "Unauthorized"
   at log time into a clear message at sign-in. */
async function tryConnect(apiBase, appToken) {
  const res = await fetch(`${apiBase}/api/ping`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Token": appToken },
    body: "{}",
  });

  if (res.status === 401) throw new Error("That token was rejected. Check it matches the Worker's APP_TOKEN.");
  if (res.status === 404) throw new Error("Reached the server, but it has no /api/ping — redeploy the Worker.");
  if (res.status === 500) throw new Error("The Worker is missing its secrets. Run: wrangler secret put ANTHROPIC_API_KEY");
  if (!res.ok) throw new Error(`Server returned ${res.status}.`);
  return res.json().catch(() => ({}));
}

async function handleGateSubmit(ev) {
  ev.preventDefault();
  const apiBase = $("s-url").value.trim().replace(/\/+$/, "");
  const appToken = $("s-token").value.trim();
  if (!apiBase || !appToken) return;

  gateBusy(true);
  $("gate-error").hidden = true;

  try {
    await tryConnect(apiBase, appToken);
    config = { apiBase, appToken };
    await meta.set("config", config).catch(() => {});
    showGate(false);
    $("f-text").focus();
  } catch (err) {
    // A fetch that rejects outright never reached the server at all.
    const msg = err instanceof TypeError
      ? "Could not reach that URL. Check it is running and spelled correctly."
      : err.message;
    showGate(true, msg);
  } finally {
    gateBusy(false);
  }
}

/* ── views ───────────────────────────────────────────────────────────────── */

function setView(name) {
  for (const view of ["today", "history", "foods"]) {
    $(`view-${view}`).hidden = view !== name;
  }
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("is-active", tab.dataset.view === name);
  }
  window.scrollTo(0, 0);
}

/* ── boot ────────────────────────────────────────────────────────────────── */

async function init() {
  await idb.open();

  entries = await idb.getAll("entries");
  days = (await idb.getAll("days")).sort((a, b) => b.date.localeCompare(a.date));
  currentDate = await meta.get("currentDate", localDate());
  config = await meta.get("config", { apiBase: DEFAULT_API, appToken: "" });
  await loadFoods();

  // A request in flight when the app closed can never resolve — surface it as
  // retryable rather than leaving a row spinning forever.
  for (const e of entries) {
    if (e.status === "pending") {
      e.status = "error";
      e.error = "Interrupted";
      await idb.put("entries", e);
    }
  }

  // No automatic rollover. The open period runs until you tap "New day",
  // however many calendar days that spans.
  await meta.set("currentDate", currentDate);

  renderToday();
  renderHistory();
  renderFoods();

  if (isConnected()) {
    // Enter optimistically so history and saved foods stay usable offline,
    // then re-verify in the background. Only a genuine rejection sends you
    // back to the gate — a network failure just means you are offline.
    showGate(false);
    tryConnect(config.apiBase, config.appToken).catch((err) => {
      if (!(err instanceof TypeError)) showGate(true, err.message);
    });
  } else {
    showGate(true);
  }

  $("ai-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const text = $("f-text").value.trim();
    if (!text) return;
    $("f-text").value = "";
    $("f-text").blur(); // drop the iOS keyboard so the new row is visible
    await logByText(text);
  });

  $("f-photo").addEventListener("change", async () => {
    const input = $("f-photo");
    const file = input.files?.[0];
    input.value = ""; // so picking the same photo again still fires "change"
    if (!file) return;
    $("f-text").blur();
    await logByPhoto(file, "photo");
  });

  $("food-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const label = $("fd-name").value.trim();
    if (!label) return;
    const saved = await saveFood({
      label,
      calories: $("fd-cal").value,
      protein_g: $("fd-protein").value,
      carbs_g: $("fd-carbs").value,
    });
    ev.target.reset();
    $("fd-name").blur();
    if (saved) toast(`Saved ${saved.label}`);
  });

  $("new-day").addEventListener("click", closeDay);
  $("export").addEventListener("click", exportJSON);
  $("gate-form").addEventListener("submit", handleGateSubmit);
  $("edit-connection").addEventListener("click", () => showGate(true));
  $("sample-toggle").addEventListener("click", () =>
    (hasSamples() ? removeSampleWeek() : addSampleWeek()));

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => setView(tab.dataset.view));
  }

  for (const btn of document.querySelectorAll(".range")) {
    btn.addEventListener("click", () => {
      historyRange = Number(btn.dataset.range);
      for (const b of document.querySelectorAll(".range")) {
        b.classList.toggle("is-active", b === btn);
      }
      renderCharts();
    });
  }

  // iOS clears web storage after ~7 days of non-use; an installed PWA with
  // persistence granted is exempt. This is what keeps your log alive.
  navigator.storage?.persist?.().catch(() => {});

  // Relative "sw.js" resolves against this page, which is what makes the
  // subpath deployment work. Registration failing is not fatal — the app
  // simply loses offline support.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js", { scope: "./" }).catch((err) => {
      console.warn("Service worker not registered:", err.message);
    });
  }
}

init().catch((err) => {
  console.error(err);
  document.body.textContent = "Could not open local storage. If this is a private browsing window, try a normal one.";
});
