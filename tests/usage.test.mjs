import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("Mate captures provider usage without consuming the response", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mate-usage-test-"));
  const usageFile = path.join(directory, "usage.json");
  const originalFetch = globalThis.fetch;
  const oldUsageFile = process.env.CM_AGENT_USAGE_FILE;
  process.env.CM_AGENT_USAGE_FILE = usageFile;
  const body = { model: "test-model", usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } };
  globalThis.fetch = async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  try {
    const { installMateUsage } = await import("../src/usage.js");
    const response = await fetch("https://provider.test/v1/chat/completions", { body: JSON.stringify({ tools: [] }) });
    assert.deepEqual(await response.json(), body);
    let usage = JSON.parse(fs.readFileSync(usageFile, "utf8"));
    assert.equal(usage.input_tokens, 100);
    assert.equal(usage.output_tokens, 20);
    assert.equal(usage.context_tokens, 120);
    assert.equal(usage.cached_input_tokens, 40);
    assert.equal(usage.context_window, null);
    await fetch("https://provider.test/v1/chat/completions");
    usage = JSON.parse(fs.readFileSync(usageFile, "utf8"));
    assert.equal(usage.total_tokens, 240);
    assert.equal(usage.context_tokens, 120);
    await fetch("https://provider.test/unrelated");
    assert.equal(JSON.parse(fs.readFileSync(usageFile, "utf8")).total_tokens, 240);
    // Simulate the SDK's private node-fetch implementation, bypassing global fetch.
    const client = { fetch: async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }) };
    installMateUsage(client);
    installMateUsage(client);
    const sdkResponse = await client.fetch("https://provider.test/v1/chat/completions", { body: JSON.stringify({ tools: [] }) });
    assert.deepEqual(await sdkResponse.json(), body);
    assert.equal(JSON.parse(fs.readFileSync(usageFile, "utf8")).total_tokens, 360);
    // A client already using the tracked global fetch must not double count.
    const globalClient = installMateUsage({ fetch: globalThis.fetch });
    await globalClient.fetch("https://provider.test/v1/chat/completions");
    assert.equal(JSON.parse(fs.readFileSync(usageFile, "utf8")).total_tokens, 480);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldUsageFile === undefined) delete process.env.CM_AGENT_USAGE_FILE;
    else process.env.CM_AGENT_USAGE_FILE = oldUsageFile;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
