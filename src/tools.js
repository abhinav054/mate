import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_TOOL_OUTPUT_CHARS = 16000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RESOURCE_DIR = path.resolve(__dirname, "..", "agent_resources");
const WORKSPACE_SERVERS_FILE = path.join(".codex", "workspace-servers.jsonl");
const GIT_MUTATING_COMMANDS = new Set(["add", "am", "apply", "bisect", "checkout", "cherry-pick", "clean", "commit", "merge", "mv", "pull", "push", "rebase", "reset", "restore", "revert", "rm", "stash", "switch", "tag"]);

let activeWorkspace = process.cwd();
let diffHandler = null;
let inputHandler = null;
const todos = [];
const backgroundProcesses = new Map();

export function setToolUi({ diff_handler = null, input_handler = null } = {}) {
  diffHandler = diff_handler;
  inputHandler = input_handler;
}

export function setWorkspace(workspace) {
  const resolved = path.resolve(expandHome(String(workspace)));
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`workspace is not a directory: ${resolved}`);
  activeWorkspace = resolved;
  return activeWorkspace;
}

export function resourceRoot() {
  return path.resolve(expandHome(process.env.AGENT_RESOURCES_DIR || DEFAULT_RESOURCE_DIR));
}

export function projectStructureSummary(maxEntries = 80) {
  const rows = [`Workspace: ${activeWorkspace}`];
  const markers = ["package.json", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "Makefile", "README.md", ".git"].filter((name) => fs.existsSync(path.join(activeWorkspace, name)));
  rows.push(`Markers: ${markers.length ? markers.join(", ") : "(none found)"}`, "", "Top-level entries:");
  let children;
  try {
    children = fs.readdirSync(activeWorkspace, { withFileTypes: true }).filter((item) => ![".git", "__pycache__"].includes(item.name));
  } catch (error) {
    return `Could not inspect workspace: ${error.name}: ${error.message}`;
  }
  children.sort((a, b) => Number(a.isFile()) - Number(b.isFile()) || a.name.localeCompare(b.name));
  for (const child of children.slice(0, maxEntries)) rows.push(`- ${child.name}${child.isDirectory() ? "/" : ""}`);
  if (children.length > maxEntries) rows.push(`- ... ${children.length - maxEntries} more`);
  if (fs.existsSync(path.join(activeWorkspace, ".git")) && which("git")) {
    const result = spawnSync("git", ["status", "--short"], { cwd: activeWorkspace, encoding: "utf8" });
    rows.push("", "Git status:", (result.status === 0 ? result.stdout.trim() : result.stderr.trim()) || "(clean)");
  }
  return trimOutput(rows.join("\n"));
}

export function gitRequiresApproval(command) {
  try {
    const args = gitArgs(command);
    const sub = args.find((arg) => !arg.startsWith("-")) || "";
    return GIT_MUTATING_COMMANDS.has(sub);
  } catch {
    return true;
  }
}

export function listFiles({ path: targetPath = "." } = {}) {
  const target = resolveInWorkspace(targetPath);
  if (!fs.existsSync(target)) throw new Error(`path does not exist: ${targetPath}`);
  if (fs.statSync(target).isFile()) return relative(target);
  const rows = fs.readdirSync(target, { withFileTypes: true })
    .sort((a, b) => Number(a.isFile()) - Number(b.isFile()) || a.name.localeCompare(b.name))
    .map((child) => `${relative(path.join(target, child.name))}${child.isDirectory() ? "/" : ""}`);
  return rows.join("\n") || "(empty)";
}

export function globFiles({ pattern, path: targetPath = "." }) {
  const target = resolveInWorkspace(targetPath);
  const base = fs.statSync(target).isDirectory() ? target : path.dirname(target);
  const regex = globRegex(pattern);
  const rows = walk(base).filter((file) => regex.test(path.relative(base, file)) && !file.split(path.sep).includes(".git")).map(relative).sort();
  return rows.join("\n") || "no matches";
}

export function readFile({ path: filePath }) {
  const target = resolveInWorkspace(filePath);
  if (!fs.statSync(target).isFile()) throw new Error(`file does not exist: ${filePath}`);
  return readTextFile(target);
}

export function touchFile({ path: filePath }) {
  const target = resolveInWorkspace(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.closeSync(fs.openSync(target, "a"));
  return `touched ${relative(target)}`;
}

export function writeFile({ path: filePath, content, append = false }) {
  const target = resolveInWorkspace(filePath);
  const before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { encoding: "utf8", flag: append ? "a" : "w" });
  showFileDiff(target, before, fs.readFileSync(target, "utf8"));
  return `${append ? "appended to" : "wrote"} ${relative(target)}`;
}

export function editFile({ path: filePath, old_text, new_text, replace_all = false }) {
  const target = resolveInWorkspace(filePath);
  const text = fs.readFileSync(target, "utf8");
  const count = text.split(old_text).length - 1;
  if (count === 0) throw new Error("old_text was not found");
  if (count > 1 && !replace_all) throw new Error(`old_text matched ${count} times; set replace_all=true or make it unique`);
  const updated = replace_all ? text.split(old_text).join(new_text) : text.replace(old_text, new_text);
  fs.writeFileSync(target, updated, "utf8");
  showFileDiff(target, text, updated);
  return `edited ${relative(target)}; replacements=${replace_all ? count : 1}`;
}

export function runCommand({ command, cwd = ".", max_time_seconds = 30 }) {
  const workdir = checkedWorkdir(cwd);
  let recorded = "";
  if (looksLikeServerCommand(command)) recorded = recordWorkspaceServer({ command, cwd });
  const result = spawnSync("bash", ["-lc", command], { cwd: workdir, encoding: "utf8", timeout: clamp(max_time_seconds, 1, 120) * 1000 });
  let output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const status = result.status === null || result.status === undefined ? 0 : result.status;
  if (result.error && result.error.code === "ETIMEDOUT") output = output ? `${output}\n\n[timeout_seconds=${clamp(max_time_seconds, 1, 120)}]` : `(command exceeded ${clamp(max_time_seconds, 1, 120)}s timeout)`;
  else output = output ? `${output}\n\n[exit_code=${status}]` : `(command exited ${status} with no output)`;
  if (recorded) output += `\n[workspace_server_recorded=${WORKSPACE_SERVERS_FILE}]`;
  return trimOutput(output);
}

export function git({ command, cwd = ".", max_time_seconds = 30 }) {
  if (!which("git")) throw new Error("git is not installed");
  const result = spawnSync("git", gitArgs(command), { cwd: checkedWorkdir(cwd), encoding: "utf8", timeout: clamp(max_time_seconds, 1, 120) * 1000 });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const status = result.status === null || result.status === undefined ? 0 : result.status;
  return trimOutput(output ? `${output}\n\n[exit_code=${status}]` : `(git exited ${status} with no output)`);
}

export function startBackgroundProcess({ command, cwd = ".", process_id = null }) {
  const workdir = checkedWorkdir(cwd);
  const id = (process_id || `bg-${new Date().toISOString().replace(/\D/g, "")}`).trim();
  if (backgroundProcesses.has(id)) throw new Error(`background process already exists: ${id}`);
  if (looksLikeServerCommand(command)) recordWorkspaceServer({ command, cwd });
  const child = spawn("bash", ["-lc", command], { cwd: workdir, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const entry = { command, cwd: workdir === activeWorkspace ? "." : relative(workdir), created_at: new Date().toISOString(), process: child, output: [] };
  backgroundProcesses.set(id, entry);
  const capture = (name) => (chunk) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/).filter(Boolean)) entry.output.push(`[${name}] ${line}`);
    entry.output = entry.output.slice(-600);
  };
  child.stdout.on("data", capture("stdout"));
  child.stderr.on("data", capture("stderr"));
  return `started ${id} running pid=${child.pid}\nStartup output:\n${entry.output.slice(-40).join("\n") || "(no output captured during startup wait)"}\nTo read stdout/stderr later, call read_background_process with process_id=${id}.`;
}

export function listBackgroundProcesses() {
  const rows = [];
  for (const [id, entry] of backgroundProcesses) rows.push(`${id}\t${entry.process.exitCode === null ? "running" : `exited(${entry.process.exitCode})`}\tpid=${entry.process.pid}\tcwd=${entry.cwd}\t${entry.command}`);
  return rows.join("\n") || "(empty)";
}

export function readBackgroundProcess({ process_id, max_lines = 120 }) {
  const entry = backgroundProcesses.get(process_id);
  if (!entry) throw new Error(`background process not found: ${process_id}`);
  return trimOutput(`${process_id} ${entry.process.exitCode === null ? "running" : `exited(${entry.process.exitCode})`} pid=${entry.process.pid}\n${entry.output.slice(-clamp(max_lines, 1, 600)).join("\n") || "(no output captured yet)"}`);
}

export function writeBackgroundProcess({ process_id, input_text }) {
  const entry = backgroundProcesses.get(process_id);
  if (!entry) throw new Error(`background process not found: ${process_id}`);
  if (entry.process.exitCode !== null) return `${process_id} already exited with code ${entry.process.exitCode}`;
  entry.process.stdin.write(input_text);
  return `wrote ${input_text.length} chars to ${process_id}`;
}

export function stopBackgroundProcess({ process_id, signal_name = "TERM" }) {
  const entry = backgroundProcesses.get(process_id);
  if (!entry) throw new Error(`background process not found: ${process_id}`);
  const signal = `SIG${signal_name.toUpperCase().replace(/^SIG/, "")}`;
  if (!["SIGTERM", "SIGINT", "SIGKILL"].includes(signal)) throw new Error("signal_name must be TERM, INT, or KILL");
  try { process.kill(-entry.process.pid, signal); } catch { entry.process.kill(signal); }
  return `sent ${signal} to ${process_id}`;
}

export async function requestUserInput({ prompt, secret = false, default: defaultValue = null }) {
  const value = inputHandler ? await inputHandler(prompt, secret, defaultValue) : "";
  return value || defaultValue || "(no input provided)";
}

export function browseInternet({ url, max_time_seconds = 20 }) {
  if (!String(url).startsWith("http://") && !String(url).startsWith("https://")) throw new Error("url must start with http:// or https://");
  const result = spawnSync("curl", ["--location", "--silent", "--show-error", "--max-time", String(clamp(max_time_seconds, 1, 60)), url], { encoding: "utf8" });
  return trimOutput(result.stdout || result.stderr || "");
}

export function checkSystemTools() {
  const required = ["bash", "git", "rg", "curl", "node", "npm"];
  const optional = ["gh", "jq", "npx", "perl", "sed", "awk"];
  return ["Required:", ...required.map((name) => `- ${name}: ${which(name) || "MISSING"}`), "", "Optional/plugin-specific:", ...optional.map((name) => `- ${name}: ${which(name) || "missing"}`)].join("\n");
}

export function searchFiles({ query, path: targetPath = "." }) {
  const target = resolveInWorkspace(targetPath);
  const rg = spawnSync("rg", ["--line-number", "--hidden", "--glob", "!.git", query, target], { encoding: "utf8" });
  if (!rg.error && rg.status === 0) return trimOutput(rg.stdout);
  if (!rg.error && rg.status === 1) return "no matches";
  const rows = [];
  for (const file of walk(target)) {
    try {
      fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => { if (line.includes(query)) rows.push(`${relative(file)}:${i + 1}:${line}`); });
    } catch {}
  }
  return trimOutput(rows.join("\n")) || "no matches";
}

export function listAgentResources({ kind = "all" } = {}) {
  const allowed = new Set(["all", "agents", "skills", "commands", "hooks", "plugins"]);
  if (!allowed.has(kind)) throw new Error(`kind must be one of: ${[...allowed].sort().join(", ")}`);
  const root = resourceRoot();
  if (!fs.existsSync(root)) return `No resource directory found at ${root}`;
  if (kind === "plugins") {
    const pluginsRoot = path.join(root, "mate-plugins");
    return fs.existsSync(pluginsRoot) ? fs.readdirSync(pluginsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).join("\n") || "(empty)" : "No copied plugin directory found.";
  }
  return (kind === "all" ? ["agents", "skills", "commands", "hooks"] : [kind]).map((item) => `[${item}]\n${fs.existsSync(path.join(root, "index", `${item}.txt`)) ? readTextFile(path.join(root, "index", `${item}.txt`)) : "(missing index)"}`).join("\n\n");
}

export function readAgentResource({ path: resourcePath }) {
  const target = resolveInResources(resourcePath);
  if (fs.statSync(target).isDirectory()) return fs.readdirSync(target).map((name) => path.relative(resourceRoot(), path.join(target, name))).join("\n") || "(empty)";
  return readTextFile(target);
}

export function loadCommand({ command_name }) {
  return loadIndexedResource("commands", (line, normalized) => line.endsWith(`/${normalized}.md`), command_name, "command");
}

export function loadSkill({ skill_name }) {
  const local = path.join(mateHome(), "skills", skill_name.trim(), "SKILL.md");
  if (fs.existsSync(local)) return readTextFile(local);
  return loadIndexedResource("skills", (line, normalized) => line.includes(`/skills/${normalized}/SKILL.md`), skill_name, "skill");
}

export function loadAgentPrompt({ agent_name }) {
  return loadIndexedResource("agents", (line, normalized) => line.endsWith(`/${normalized.replace(/\.md$/, "")}.md`), agent_name, "agent prompt");
}

export function updateTodos({ items_json }) {
  const parsed = JSON.parse(items_json);
  if (!Array.isArray(parsed)) throw new Error("items_json must be a JSON array");
  todos.splice(0, todos.length, ...parsed.map((item) => ({ content: String(item.content || "").trim(), status: String(item.status || "pending").trim() })));
  return todos.map((item) => `- [${item.status}] ${item.content}`).join("\n") || "(empty)";
}

export function runPluginHook({ plugin_name, hook_command, input_json = "{}", max_time_seconds = 30 }) {
  const pluginRoot = resolveInResources(`mate-plugins/${plugin_name}`);
  const env = { ...process.env, MATE_PLUGIN_ROOT: pluginRoot };
  const result = spawnSync("bash", ["-lc", hook_command], { cwd: activeWorkspace, input: input_json, encoding: "utf8", timeout: clamp(max_time_seconds, 1, 180) * 1000, env });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const status = result.status === null || result.status === undefined ? 0 : result.status;
  return trimOutput(output ? `${output}\n\n[exit_code=${status}]` : `(hook exited ${status} with no output)`);
}

export const TOOLS = {
  browse_internet: browseInternet, check_system_tools: checkSystemTools, list_files: listFiles, glob_files: globFiles, git, read_file: readFile, touch_file: touchFile, write_file: writeFile, edit_file: editFile, record_workspace_server: recordWorkspaceServer, run_command: runCommand, start_background_process: startBackgroundProcess, list_background_processes: listBackgroundProcesses, read_background_process: readBackgroundProcess, write_background_process: writeBackgroundProcess, stop_background_process: stopBackgroundProcess, request_user_input: requestUserInput, search_files: searchFiles, list_agent_resources: listAgentResources, read_agent_resource: readAgentResource, load_command: loadCommand, load_skill: loadSkill, load_agent_prompt: loadAgentPrompt, update_todos: updateTodos, run_plugin_hook: runPluginHook
};

export const TOOL_DEFINITIONS = Object.keys(TOOLS).map((name) => ({ type: "function", function: { name, description: `Run Mate tool ${name}.`, parameters: toolSchema(name) } }));

function toolSchema(name) {
  const common = { type: "object", properties: {} };
  const schemas = {
    browse_internet: { url: "string", max_time_seconds: "integer" },
    list_files: { path: "string" },
    glob_files: { pattern: "string", path: "string" },
    git: { command: "string", cwd: "string", max_time_seconds: "integer" },
    read_file: { path: "string" },
    touch_file: { path: "string" },
    write_file: { path: "string", content: "string", append: "boolean" },
    edit_file: { path: "string", old_text: "string", new_text: "string", replace_all: "boolean" },
    run_command: { command: "string", cwd: "string", max_time_seconds: "integer" },
    start_background_process: { command: "string", cwd: "string", process_id: "string" },
    read_background_process: { process_id: "string", max_lines: "integer" },
    write_background_process: { process_id: "string", input_text: "string" },
    stop_background_process: { process_id: "string", signal_name: "string" },
    request_user_input: { prompt: "string", secret: "boolean", default: "string" },
    search_files: { query: "string", path: "string" },
    list_agent_resources: { kind: "string" },
    read_agent_resource: { path: "string" },
    load_command: { command_name: "string" },
    load_skill: { skill_name: "string" },
    load_agent_prompt: { agent_name: "string" },
    update_todos: { items_json: "string" },
    run_plugin_hook: { plugin_name: "string", hook_command: "string", input_json: "string", max_time_seconds: "integer" },
    record_workspace_server: { command: "string", cwd: "string", reason: "string" }
  };
  const spec = schemas[name] || {};
  return { ...common, properties: Object.fromEntries(Object.entries(spec).map(([key, type]) => [key, { type }])) };
}

function recordWorkspaceServer({ command, cwd = ".", reason = "server command detected" }) {
  const workdir = checkedWorkdir(cwd);
  const recordPath = path.join(activeWorkspace, WORKSPACE_SERVERS_FILE);
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.appendFileSync(recordPath, JSON.stringify({ created_at: new Date().toISOString(), workspace: activeWorkspace, cwd: workdir === activeWorkspace ? "." : relative(workdir), command, reason }) + "\n");
  return `recorded ${WORKSPACE_SERVERS_FILE}`;
}

function loadIndexedResource(kind, matcher, name, label) {
  const normalized = String(name || "").trim().replace(/^\//, "");
  const index = path.join(resourceRoot(), "index", `${kind}.txt`);
  if (!fs.existsSync(index)) throw new Error(`${kind} index is missing`);
  const matches = fs.readFileSync(index, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => matcher(line, normalized));
  if (!matches.length) throw new Error(`${label} not found: ${name}`);
  if (matches.length > 1) return `Multiple ${kind} matched:\n${matches.join("\n")}`;
  return readAgentResource({ path: `mate-plugins/${matches[0]}` });
}

function mateHome() {
  return path.resolve(expandHome(process.env.MATE_HOME || path.join(os.homedir(), ".mate")));
}

function resolveInWorkspace(value = ".") {
  const target = path.resolve(activeWorkspace, value || ".");
  if (target !== activeWorkspace && !target.startsWith(activeWorkspace + path.sep)) throw new Error(`path escapes workspace: ${value}`);
  return target;
}

function resolveInResources(value = ".") {
  const root = resourceRoot();
  const target = path.resolve(root, value || ".");
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`path escapes agent resources: ${value}`);
  return target;
}

function checkedWorkdir(cwd) {
  const workdir = resolveInWorkspace(cwd);
  if (!fs.statSync(workdir).isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
  return workdir;
}

function readTextFile(filePath) {
  return trimOutput(fs.readFileSync(filePath, "utf8"));
}

function trimOutput(value) {
  return value.length <= MAX_TOOL_OUTPUT_CHARS ? value : `${value.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n...[trimmed]`;
}

function relative(filePath) {
  return path.relative(activeWorkspace, filePath) || ".";
}

function expandHome(value) {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(Number.parseInt(value, 10) || min, max));
}

function which(name) {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function walk(root) {
  if (fs.statSync(root).isFile()) return [root];
  const out = [];
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, item.name);
    if (item.name === ".git") continue;
    if (item.isDirectory()) out.push(...walk(full));
    else if (item.isFile()) out.push(full);
  }
  return out;
}

function globRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\0/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function showFileDiff(filePath, before, after) {
  if (!diffHandler || before === after) return;
  const rel = relative(filePath);
  diffHandler(`--- a/${rel}\n+++ b/${rel}\n@@ file changed @@\n${after.split(/\r?\n/).map((line) => `+${line}`).join("\n")}`);
}

function gitArgs(command) {
  const args = shellSplit(command);
  if (!args.length) throw new Error("git command is required");
  for (const arg of args) {
    if (["-C", "--git-dir", "--work-tree", "--exec-path"].includes(arg) || ["-C=", "--git-dir=", "--work-tree=", "--exec-path="].some((prefix) => arg.startsWith(prefix))) throw new Error(`git argument is not allowed: ${arg}`);
  }
  return args;
}

function shellSplit(command) {
  const matches = String(command).match(/(?:[^\s"'\\]+|"(?:\\.|[^"])*"|'[^']*')+/g) || [];
  return matches.map((item) => item.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"));
}

function looksLikeServerCommand(command) {
  const lowered = ` ${String(command).trim().toLowerCase()} `;
  return [" npm run dev", " npm start", " pnpm dev", " yarn dev", " bun dev", " vite", " next dev", " cargo run"].some((marker) => lowered.includes(marker));
}
