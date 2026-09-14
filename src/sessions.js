import fs from "node:fs";
import path from "node:path";

const SESSION_DIR = "sessions";

function slugTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function ensureMateDir(workspace) {
  const mateDir = path.join(workspace, ".mate");
  fs.mkdirSync(mateDir, { recursive: true });
  return mateDir;
}

function ensureSessionDir(workspace) {
  const sessionDir = path.join(ensureMateDir(workspace), SESSION_DIR);
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

function sessionPaths(workspace, id) {
  const dir = path.join(ensureSessionDir(workspace), id);
  return {
    dir,
    jsonl: path.join(dir, "messages.jsonl"),
    transcript: path.join(dir, "transcript.txt"),
    meta: path.join(dir, "meta.json")
  };
}

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.map((part) => part.text || JSON.stringify(part)).join("\n");
  return message.content == null ? "" : JSON.stringify(message.content);
}

function transcriptBlock(message) {
  const role = String(message.role || "message").toUpperCase();
  if (message.role === "tool") return `[TOOL ${message.tool_call_id || ""}]\n${messageText(message)}`.trim();
  if (message.tool_calls && message.tool_calls.length) return `[${role}]\n${messageText(message)}\n\nTool calls: ${JSON.stringify(message.tool_calls, null, 2)}`;
  return `[${role}]\n${messageText(message)}`;
}

export function createSession(workspace) {
  const id = slugTimestamp();
  const paths = sessionPaths(workspace, id);
  fs.mkdirSync(paths.dir, { recursive: true });
  const meta = { id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), turns: 0 };
  fs.writeFileSync(paths.meta, `${JSON.stringify(meta, null, 2)}\n`);
  fs.writeFileSync(paths.jsonl, "");
  fs.writeFileSync(paths.transcript, `Mate session ${id}\nWorkspace: ${workspace}\n\n`);
  return { id, ...paths };
}

export function appendMessages(session, messages) {
  if (!session || !messages.length) return;
  fs.mkdirSync(session.dir, { recursive: true });
  const serializable = messages.map((message) => ({ ...message, saved_at: new Date().toISOString() }));
  fs.appendFileSync(session.jsonl, serializable.map((message) => JSON.stringify(message)).join("\n") + "\n");
  fs.appendFileSync(session.transcript, serializable.map(transcriptBlock).join("\n\n") + "\n\n");
  updateSessionMeta(session);
}

function updateSessionMeta(session) {
  let meta = { id: path.basename(session.dir), created_at: new Date().toISOString(), turns: 0 };
  try {
    meta = JSON.parse(fs.readFileSync(session.meta, "utf8"));
  } catch {}
  const messages = readSessionMessages(session);
  meta.updated_at = new Date().toISOString();
  meta.turns = messages.filter((message) => message.role === "user").length;
  const lastUserMessage = messages.slice().reverse().find((message) => message.role === "user");
  meta.last_user_message = lastUserMessage ? lastUserMessage.content : "";
  fs.writeFileSync(session.meta, `${JSON.stringify(meta, null, 2)}\n`);
}

export function listSessions(workspace) {
  const dir = ensureSessionDir(workspace);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const paths = sessionPaths(workspace, entry.name);
      let meta = { id: entry.name, created_at: "", updated_at: "", turns: 0 };
      try {
        meta = { ...meta, ...JSON.parse(fs.readFileSync(paths.meta, "utf8")) };
      } catch {}
      return { ...meta, ...paths };
    })
    .sort((a, b) => String(b.updated_at || b.id).localeCompare(String(a.updated_at || a.id)));
}

export function latestSession(workspace) {
  return listSessions(workspace)[0] || null;
}

export function readSessionMessages(session) {
  if (!session || !fs.existsSync(session.jsonl)) return [];
  return fs.readFileSync(session.jsonl, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map(({ saved_at, ...message }) => message);
}

export function formatSessionList(workspace) {
  const sessions = listSessions(workspace);
  if (!sessions.length) return `No saved sessions in ${path.join(workspace, ".mate", SESSION_DIR)}.`;
  return sessions.map((session, index) => {
    const last = String(session.last_user_message || "").replace(/\s+/g, " ").slice(0, 80);
    return `${index + 1}. ${session.id}  turns=${session.turns || 0}  updated=${session.updated_at || "unknown"}${last ? `\n   ${last}` : ""}`;
  }).join("\n");
}
