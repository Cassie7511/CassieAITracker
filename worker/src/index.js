import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const MODEL = "claude-sonnet-5";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // base64 payload ceiling; the app resizes to ~1024px first

// The origins the *frontend* is served from — not this Worker's own address.
const ALLOWED_ORIGINS = [
  "https://cassie7511.github.io",
  "http://localhost:5500", // VS Code Live Server
  "http://127.0.0.1:5500",
  "http://localhost:8000", // python -m http.server
  "http://127.0.0.1:8000",
];

/* ─── output schema ──────────────────────────────────────────────────────────
   Claude is constrained to this shape, so the response never needs parsing
   out of prose and a malformed reply is impossible rather than merely rare. */

// Three numbers, nothing else. Every field here costs output tokens on every
// call, and output tokens drive both the bill and the latency.
const Analysis = z.object({
  calories: z.number(),
  protein_g: z.number(),
  carbs_g: z.number(),
});

/* ─── prompts ────────────────────────────────────────────────────────────── */

// Kept deliberately short. The system prompt is sent on every request, so every
// sentence here is a recurring input-token cost.
const SYSTEM = `You estimate nutrition for a personal food log. Given a description of food, return its total calories, protein, and carbohydrates.

- Report the numbers that would appear on a nutrition facts label for exactly what is described — nothing more.
- Add nothing the description does not mention. No cooking oil, no butter, no dressings, no sauces, no side dishes, no garnishes. If it is not named, it is not counted.
- When a weight, count, or package size is stated, use the label total for that amount as sold.
- When quantity is unstated, assume one standard labeled serving.
- Sum everything described into one total.
- When genuinely uncertain, take the lower estimate. Under-reporting is preferred to over-reporting.
- Always return numbers; never refuse because a description is vague.
- Kilocalories for energy, grams for protein and carbs, whole numbers only.`;

const KIND_PROMPTS = {
  text: "Food eaten:",

  photo:
    "This image shows a plate or portion of food. Identify what you see, estimate portions from visual cues — plate and utensil size, hands, packaging — and return the combined total.",

  label:
    "This image shows a nutrition facts label. Read the printed values rather than estimating. Check serving size against servings per container: if the whole package was eaten and the label is per-serving, multiply accordingly.",
};

/* ─── CORS ───────────────────────────────────────────────────────────────────
   The app is served from GitHub Pages and this Worker runs on workers.dev, so
   every request is cross-origin. `Vary: Origin` matters — without it a cache can
   hand one origin the header minted for another. */

function corsHeaders(origin) {
  const headers = new Headers({
    "Access-Control-Allow-Headers": "Content-Type, X-App-Token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400", // cache the preflight; saves a round-trip per request on cell data
    Vary: "Origin",
  });
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

function json(body, status, origin) {
  const headers = corsHeaders(origin);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

/* ─── handler ────────────────────────────────────────────────────────────── */

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/api/analyze" && url.pathname !== "/api/ping") {
      return json({ error: "Not found" }, 404, origin);
    }
    if (request.method !== "POST") {
      return json({ error: "Use POST" }, 405, origin);
    }

    // Fail loudly on a half-configured Worker rather than surfacing it as a 401.
    if (!env.ANTHROPIC_API_KEY || !env.APP_TOKEN) {
      console.error("Missing secret: set ANTHROPIC_API_KEY and APP_TOKEN via `wrangler secret put`");
      return json({ error: "Server is not configured" }, 500, origin);
    }

    if (request.headers.get("X-App-Token") !== env.APP_TOKEN) {
      return json({ error: "Unauthorized" }, 401, origin);
    }

    // Credential check for the login screen — same auth path as a real request,
    // but no Claude call, so signing in costs nothing and returns instantly.
    if (url.pathname === "/api/ping") {
      return json({ ok: true, model: MODEL }, 200, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Body must be JSON" }, 400, origin);
    }

    const kind = body.kind ?? "text";
    if (!KIND_PROMPTS[kind]) {
      return json({ error: `Unknown kind "${kind}". Use text, photo, or label.` }, 400, origin);
    }

    let content;

    if (kind === "text") {
      const payload = typeof body.payload === "string" ? body.payload.trim() : "";
      if (!payload) {
        return json({ error: "Tell me what you ate" }, 400, origin);
      }
      if (payload.length > 2000) {
        return json({ error: "That description is too long" }, 400, origin);
      }
      content = `${KIND_PROMPTS.text}\n\n${payload}`;
    } else {
      // photo | label — payload is raw base64, no data: URI prefix
      const { payload, media_type } = body;
      if (typeof payload !== "string" || !payload) {
        return json({ error: "Missing image data" }, 400, origin);
      }
      if (!/^image\/(jpeg|png|webp|gif)$/.test(media_type ?? "")) {
        return json({ error: "media_type must be image/jpeg, png, webp, or gif" }, 400, origin);
      }
      if (payload.length > MAX_IMAGE_BYTES) {
        return json({ error: "Image too large — resize before sending" }, 413, origin);
      }
      content = [
        { type: "image", source: { type: "base64", media_type, data: payload } },
        { type: "text", text: KIND_PROMPTS[kind] },
      ];
    }

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

    try {
      const message = await client.messages.parse({
        model: MODEL,
        max_tokens: 8000,
        system: SYSTEM,
        messages: [{ role: "user", content }],
        // Adaptive is the only on-mode for Sonnet 5.
        //
        // Effort is "high" for a measured reason, not by default. Benchmarked on
        // 1 lb of 85/15 ground beef (~975 kcal) across five phrasings, 3 runs each:
        //
        //   low     908-1090 on identical input          (±182)
        //   medium  mostly right, but outliers at 1152, 1170, and once 215
        //   high    960-980 on every phrasing tried      (±20)
        //
        // Medium looked fine when tested on one phrasing and fell apart on others;
        // high is the first level that holds regardless of how the food is worded.
        // It costs ~0.8s and ~90 output tokens over medium — about $0.25/month at
        // five meals a day. Do not lower this to save money; it buys noise.
        //
        // Note if switching to claude-haiku-4-5: it rejects `output_config.effort`
        // outright and has no adaptive thinking — both must be removed.
        thinking: { type: "adaptive" },
        output_config: {
          effort: "high",
          format: zodOutputFormat(Analysis),
        },
      });

      if (message.stop_reason === "refusal") {
        console.error("Refusal:", message.stop_details);
        return json({ error: "Could not analyze that one — try rewording it" }, 422, origin);
      }

      // parsed_output is null if validation failed, so guard rather than assert.
      if (!message.parsed_output) {
        console.error("No parsed output. stop_reason:", message.stop_reason);
        return json({ error: "Got an unreadable response — try again" }, 502, origin);
      }

      return json(
        {
          ...message.parsed_output,
          model: MODEL,
          usage: {
            input_tokens: message.usage.input_tokens,
            output_tokens: message.usage.output_tokens,
          },
        },
        200,
        origin,
      );
    } catch (error) {
      // Most specific first — a single catch-all would throw away the retryable
      // vs. non-retryable distinction the SDK went to the trouble of encoding.
      if (error instanceof Anthropic.AuthenticationError) {
        console.error("Bad ANTHROPIC_API_KEY:", error.message);
        return json({ error: "Server credentials rejected" }, 500, origin);
      }
      if (error instanceof Anthropic.RateLimitError) {
        return json({ error: "Rate limited — wait a moment and retry" }, 429, origin);
      }
      if (error instanceof Anthropic.BadRequestError) {
        console.error("Bad request to Claude:", error.message);
        return json({ error: "That request was malformed" }, 400, origin);
      }
      if (error instanceof Anthropic.APIError) {
        console.error(`Claude API error ${error.status}:`, error.message);
        return json({ error: "Claude is having trouble — try again shortly" }, 502, origin);
      }
      console.error("Unexpected:", error);
      return json({ error: "Something went wrong" }, 500, origin);
    }
  },
};
