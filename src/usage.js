import fs from "node:fs";

const usageFile = process.env.AGENT_USAGE_FILE || process.env.CM_AGENT_USAGE_FILE;
const originalFetch = globalThis.fetch;
const totals = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
let cachedTotal = 0;
let reasoningTotal = 0;
let cachedReported = false;
let reasoningReported = false;
let latestContext = null;
const trackedFetches = new WeakSet();

function trackFetch(fetch) {
  if (!usageFile || typeof fetch !== "function" || trackedFetches.has(fetch)) return fetch;
  const tracked = async function (...args) {
    const response = await fetch.apply(this, args);
    const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || String(args[0]);
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json") || !/\/(chat\/completions|responses)(?:\?|$)/.test(requestUrl)) return response;
    try {
      const body = await response.clone().json();
      const usage = body.usage;
      const input = usage?.prompt_tokens ?? usage?.input_tokens;
      const output = usage?.completion_tokens ?? usage?.output_tokens;
      if (!Number.isInteger(input) || input < 0 || !Number.isInteger(output) || output < 0) return response;
      totals.input_tokens += input;
      totals.output_tokens += output;
      totals.total_tokens += input + output;
      let request;
      try { request = JSON.parse(args[1]?.body || "{}"); } catch {}
      // Mate's main conversation includes tools; critique and compaction calls do not.
      if (Array.isArray(request?.tools)) latestContext = input + output;
      const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens;
      const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens;
      if (Number.isInteger(cached) && cached >= 0) { cachedTotal += cached; cachedReported = true; }
      if (Number.isInteger(reasoning) && reasoning >= 0) { reasoningTotal += reasoning; reasoningReported = true; }
      fs.writeFileSync(usageFile, JSON.stringify({
        ...totals,
        status: "available",
        source: "Mate model provider",
        model: body.model || null,
        updated_at: new Date().toISOString(),
        context_tokens: latestContext,
        context_window: null,
        cached_input_tokens: cachedReported ? cachedTotal : null,
        reasoning_output_tokens: reasoningReported ? reasoningTotal : null,
      }));
    } catch {
      // Telemetry must never interrupt model requests or streaming responses.
    }
    return response;
  };
  trackedFetches.add(tracked);
  return tracked;
}

// The OpenAI Node SDK may use node-fetch instead of globalThis.fetch.
export function installMateUsage(client) {
  if (client) client.fetch = trackFetch(client.fetch);
  return client;
}

if (originalFetch) globalThis.fetch = trackFetch(originalFetch);
