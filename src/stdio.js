import readline from "node:readline";
import { TurnInterruptedError } from "./server.js";

export async function runStdioServer({ workspace, input = process.stdin, output = process.stdout, createAgent } = {}) {
  let closed = false;
  const handlers = new Set();
  const send = (message) => { if (!closed) output.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); };
  const notify = (method, params) => send({ method, params });
  const pending = new Map();
  let nextId = 0;
  let agent;
  let active = false;
  let activeTurnRequestId = null;
  const request = (method, params) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error("Client disconnected")); return; }
    const id = `mate-${++nextId}`;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  const ui = {
    banner() {},
    panel: (title, detail) => notify("codex.activity", { type: "reasoning", title, detail }),
    activity: (title, detail, color, type = "tool") => notify("codex.activity", { type, title, detail }),
    diff: (detail) => notify("codex.activity", { type: "files", title: "File Diff", detail }),
    success: (detail) => notify("codex.activity", { type: "tool", title: "Completed", detail }),
    warning: (detail) => notify("codex.activity", { type: "tool", title: "Warning", detail }),
    prompt: async (prompt, secret = false) => {
      const result = await request("mate/input/request", { prompt, secret });
      return typeof result === "string" ? result : result?.value ?? null;
    },
    transientPrompt: async (prompt) => (await request("mate/approval/request", { prompt }))?.approved === true ? "yes" : "no",
    formatDuration: (ms) => `${(ms / 1000).toFixed(1)}s`
  };
  const lines = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  async function handle(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { send({ id: null, error: { code: -32700, message: "Parse error" } }); return; }
    if (!message || Array.isArray(message) || message.jsonrpc !== "2.0") {
      send({ id: null, error: { code: -32600, message: "Invalid Request" } }); return;
    }
    if (!message.method && Object.hasOwn(message, "id")) {
      const waiting = pending.get(message.id);
      if (waiting) {
        pending.delete(message.id);
        if (message.error) waiting.reject(new Error(message.error.message));
        else waiting.resolve(message.result);
      }
      return;
    }
    const respond = (result) => { if (Object.hasOwn(message, "id")) send({ id: message.id, result }); };
    const fail = (code, detail) => { if (Object.hasOwn(message, "id")) send({ id: message.id, error: { code, message: detail } }); };
    if (message.method === "initialize") { respond({ serverInfo: { name: "mate", version: "0.1.0" }, capabilities: { turns: true, approvals: true, userInput: true, interrupt: true }, workspace }); return; }
    if (message.method === "initialized") return;
    if (message.method === "shutdown") {
      if (active) { fail(-32000, "A turn is running"); return; }
      respond(null); lines.close(); input.pause(); return;
    }
    if (message.method === "turn/interrupt") {
      if (!active || !agent) { fail(-32000, "No turn is running"); return; }
      const reason = String(message.params?.reason || "client requested interrupt");
      const interrupted = agent.interruptCurrentTurn(reason);
      if (interrupted) notify("codex.interrupt", { reason, request_id: activeTurnRequestId });
      respond({ interrupted });
      return;
    }
    if (!["turn/start", "conversation/reset"].includes(message.method)) { fail(-32601, "Method not found"); return; }
    if (active) { fail(-32000, "A turn is running"); return; }
    const params = message.params || {};
    const prompt = params.prompt ?? (Array.isArray(params.input) ? params.input.filter((item) => item.type === "text").map((item) => item.text).join("\n") : undefined);
    if (message.method === "turn/start" && (typeof prompt !== "string" || !prompt.trim())) { fail(-32602, "A nonempty prompt or text input is required"); return; }
    active = true;
    activeTurnRequestId = Object.hasOwn(message, "id") ? message.id : null;
    try {
      if (!agent) {
        const factory = createAgent || (await import("./server.js")).AgentServer.create;
        agent = await factory(workspace, ui, { showStartup: false });
      }
      if (message.method === "conversation/reset") { agent.reset(); respond(null); return; }
      notify("codex.user.message", { markdown: prompt });
      const started = Date.now();
      const markdown = await agent.runTurn(prompt);
      notify("codex.assistant.message", { markdown, elapsed_seconds: (Date.now() - started) / 1000 });
      respond({ markdown });
    } catch (error) {
      if (error instanceof TurnInterruptedError) fail(-32800, error.message);
      else fail(-32603, error.message);
    }
    finally { active = false; activeTurnRequestId = null; }
  }
  lines.on("line", (line) => {
    if (closed) return;
    const task = handle(line).catch((error) => process.stderr.write(`${error.message}\n`));
    handlers.add(task);
    void task.finally(() => handlers.delete(task));
  });
  await new Promise((resolve) => lines.once("close", resolve));
  closed = true;
  for (const waiting of pending.values()) waiting.reject(new Error("Client disconnected"));
  pending.clear();
  await Promise.allSettled([...handlers]);
  if (agent?.mcpRegistry?.clients) {
    await Promise.allSettled([...agent.mcpRegistry.clients.values()].map(({ client }) => client.close()));
  }
}
