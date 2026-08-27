import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_CONFIG = "config.toml";
const DEFAULT_PROMPT = "prompt.md";
const DEFAULT_KEYS = "keys.env";
const DEFAULT_DOTENV = ".env";

function expandHome(value) {
  if (!value) return value;
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

export function mateHome() {
  return path.resolve(expandHome(process.env.MATE_HOME || path.join(os.homedir(), ".mate")));
}

export function ensureMateHome(root = mateHome()) {
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function loadConfig(root = null) {
  const mate_home = ensureMateHome(root || mateHome());
  const raw = loadToml(path.join(mate_home, DEFAULT_CONFIG));
  loadKeys(path.join(path.dirname(mate_home), DEFAULT_DOTENV));
  loadKeys(path.join(mate_home, DEFAULT_KEYS));
  return {
    mate_home,
    raw,
    approval: loadApproval(raw.approval || {}),
    prompt_override: loadText(path.join(mate_home, DEFAULT_PROMPT)).trim()
  };
}

export function toolRequiresApproval(config, toolName, command = "") {
  if (toolAllowedWithoutApproval(config, toolName, command)) return false;
  if (config.approval.require_tools.has(toolName)) return true;
  return Boolean(command && matchesAny(command, config.approval.require_commands));
}

export function toolAllowedWithoutApproval(config, toolName, command = "") {
  const approval = config.approval;
  return approval.auto_approve || approval.allow_tools.has(toolName) || Boolean(command && matchesAny(command, approval.allow_commands));
}

function loadApproval(value) {
  return {
    require_tools: new Set(stringList(value.require_tools, ["run_command", "start_background_process"])),
    allow_tools: new Set(stringList(value.allow_tools, [])),
    require_commands: stringList(value.require_commands, []),
    allow_commands: stringList(value.allow_commands, []),
    auto_approve: Boolean(value.auto_approve)
  };
}

function loadText(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function loadKeys(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim().replace(/^export\s+/, "");
    let value = line.slice(index + 1).trim();
    value = value.replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function loadToml(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const data = {};
  let section = data;
  let pendingKey = "";
  let pendingItems = [];
  for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.split("#", 1)[0].trim();
    if (!line) continue;
    if (pendingKey) {
      if (line === "]") {
        section[pendingKey] = pendingItems;
        pendingKey = "";
        pendingItems = [];
      } else {
        pendingItems.push(unquote(line.replace(/,$/, "").trim()));
      }
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1).trim();
      if (!data[name]) data[name] = {};
      section = data[name];
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (value === "[") {
      pendingKey = key;
      pendingItems = [];
    } else if (["true", "false"].includes(value.toLowerCase())) {
      section[key] = value.toLowerCase() === "true";
    } else if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      section[key] = inner ? inner.split(",").map((item) => unquote(item.trim())) : [];
    } else {
      section[key] = unquote(value);
    }
  }
  return data;
}

function unquote(value) {
  return value.replace(/^["']|["']$/g, "");
}

function stringList(value, fallback) {
  if (value === undefined || value === null) value = fallback;
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.map(String).filter((item) => item.trim()) : [...fallback];
}

function matchesAny(command, patterns) {
  return patterns.some((pattern) => wildcard(pattern).test(command));
}

function wildcard(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}
