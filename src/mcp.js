import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { version } from "./version.js";

const TOOL_PREFIX = "mcp__";

export class McpRegistry {
  constructor({ servers = [], mateHome, workspace, ui = null } = {}) {
    this.servers = servers;
    this.mateHome = mateHome;
    this.workspace = workspace;
    this.ui = ui;
    this.clients = new Map();
    this.toolMap = new Map();
    this.toolDefinitions = [];
  }

  async connectAll() {
    for (const server of this.servers) {
      try {
        await this.connectServer(server);
      } catch (error) {
        if (this.ui && this.ui.activity) this.ui.activity("MCP server skipped", `${server.name}: ${error.name}: ${error.message}`, this.ui.YELLOW);
      }
    }
    return this.toolDefinitions;
  }

  async connectServer(server) {
    const transport = await this.createTransport(server);
    const client = new Client({ name: "mate", version: version() });
    await client.connect(transport);
    const listed = await client.listTools();
    const serverTools = Array.isArray(listed.tools) ? listed.tools : [];
    this.clients.set(server.name, { client, transport, server });
    for (const tool of serverTools) this.addTool(server.name, tool);
    if (this.ui && this.ui.activity) this.ui.activity("Connected MCP server", `${server.name}: ${serverTools.length} tool(s)`, this.ui.GREEN);
  }

  addTool(serverName, tool) {
    const openAiName = `${TOOL_PREFIX}${safeName(serverName)}__${safeName(tool.name)}`.slice(0, 64);
    if (this.toolMap.has(openAiName)) throw new Error(`duplicate MCP tool name after normalization: ${openAiName}`);
    this.toolMap.set(openAiName, { serverName, toolName: tool.name });
    this.toolDefinitions.push({
      type: "function",
      function: {
        name: openAiName,
        description: tool.description || `MCP tool ${tool.name} from ${serverName}.`,
        parameters: tool.inputSchema || { type: "object", properties: {} }
      }
    });
  }

  hasTool(name) {
    return this.toolMap.has(name);
  }

  async callTool(name, args) {
    const mapped = this.toolMap.get(name);
    if (!mapped) throw new Error(`unknown MCP tool: ${name}`);
    const entry = this.clients.get(mapped.serverName);
    if (!entry) throw new Error(`MCP server is not connected: ${mapped.serverName}`);
    const result = await entry.client.callTool({ name: mapped.toolName, arguments: args });
    return formatMcpResult(result);
  }

  async createTransport(server) {
    const type = String(server.transport || inferTransport(server)).toLowerCase();
    if (type === "stdio") {
      if (!server.command) throw new Error("stdio MCP server requires command");
      return new StdioClientTransport({
        command: String(server.command),
        args: arrayOfStrings(server.args),
        env: expandEnvObject(server.env || {}),
        cwd: server.cwd ? path.resolve(this.workspace, expandHome(String(server.cwd))) : this.workspace
      });
    }
    if (["http", "streamable_http", "streamable-http"].includes(type)) {
      return new StreamableHTTPClientTransport(new URL(expandEnv(String(server.url))), requestOptions(server));
    }
    if (["sse", "server_sent_events", "server-sent-events"].includes(type)) {
      return new SSEClientTransport(new URL(expandEnv(String(server.url))), sseOptions(server));
    }
    if (["inmemory", "in_memory", "in-memory"].includes(type)) return await this.createInMemoryTransport(server);
    throw new Error(`unsupported MCP transport: ${server.transport}`);
  }

  async createInMemoryTransport(server) {
    const factoryPath = server.module || server.path;
    if (!factoryPath) throw new Error("in-memory MCP server requires module or path");
    const moduleUrl = resolveModuleUrl(factoryPath, this.mateHome, this.workspace);
    const mod = await import(moduleUrl);
    const factoryName = server.export || "default";
    const factory = mod[factoryName] || (factoryName === "default" ? mod.createServer : null);
    if (typeof factory !== "function") throw new Error(`in-memory module does not export function ${factoryName}`);
    const created = await factory({ config: server, workspace: this.workspace, mateHome: this.mateHome, InMemoryTransport });
    if (created && created.clientTransport) return created.clientTransport;
    if (created && created.transport) return created.transport;
    if (Array.isArray(created) && created.length >= 2) return created[0];
    if (created && created.connect) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await created.connect(serverTransport);
      return clientTransport;
    }
    throw new Error("in-memory factory must return a Server, clientTransport, transport, or [clientTransport, serverTransport]");
  }
}

export function loadMcpServers(rawConfig) {
  const servers = [];
  for (const [key, value] of Object.entries(rawConfig || {})) {
    if (!key.startsWith("servers.")) continue;
    const name = key.slice("servers.".length).trim();
    if (name && value && typeof value === "object" && !Array.isArray(value) && value.enabled !== false) servers.push({ name, ...value });
  }
  return servers;
}

function inferTransport(server) {
  if (server.command) return "stdio";
  if (server.module || server.path) return "inmemory";
  if (server.url) return server.sse ? "sse" : "http";
  return "";
}

function requestOptions(server) {
  const headers = expandEnvObject(server.headers || {});
  return Object.keys(headers).length ? { requestInit: { headers } } : undefined;
}

function sseOptions(server) {
  const headers = expandEnvObject(server.headers || {});
  if (!Object.keys(headers).length) return undefined;
  return {
    eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...((init && init.headers) || {}), ...headers } }) },
    requestInit: { headers }
  };
}

function resolveModuleUrl(value, mateHome, workspace) {
  const expanded = expandHome(expandEnv(String(value)));
  if (expanded.startsWith("file:")) return expanded;
  if (/^[a-z][a-z0-9+.-]*:/i.test(expanded) && !path.isAbsolute(expanded)) return expanded;
  const base = expanded.startsWith(".") ? mateHome : workspace;
  return pathToFileURL(path.resolve(base, expanded)).href;
}

function expandEnvObject(value) {
  return Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [key, expandEnv(String(item))]));
}

function expandEnv(value) {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, key) => process.env[key] || "");
}

function expandHome(value) {
  return value === "~" || value.startsWith("~/") ? path.join(process.env.HOME || "", value.slice(2)) : value;
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function formatMcpResult(result) {
  if (!result || typeof result !== "object") return String(result == null ? "" : result);
  if (result.isError) return `ERROR: ${contentText(result) || JSON.stringify(result)}`;
  return contentText(result) || JSON.stringify(result);
}

function contentText(result) {
  const content = Array.isArray(result.content) ? result.content : [];
  return content.map((item) => {
    if (item.type === "text") return item.text;
    if (item.type === "image") return `[image ${item.mimeType || "unknown"} ${String(item.data || "").length} bytes base64]`;
    if (item.type === "audio") return `[audio ${item.mimeType || "unknown"} ${String(item.data || "").length} bytes base64]`;
    if (item.type === "resource") return JSON.stringify(item.resource || item);
    return JSON.stringify(item);
  }).filter(Boolean).join("\n");
}
