// Exercise actual package startup without making an LLM request.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentServer } from "./server.js";

export async function checkStartup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-startup-check-"));
  const oldHome = process.env.MATE_HOME;
  const oldKey = process.env.OPENAI_API_KEY;
  try {
    process.env.MATE_HOME = path.join(root, ".mate");
    process.env.OPENAI_API_KEY = "startup-check-not-used";
    const skill = path.join(process.env.MATE_HOME, "skills", "startup-test");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: startup-test\ndescription: Verify startup skill discovery\n---\nTest instructions\n");
    const server = await AgentServer.create(root, {}, { showStartup: false });
    const system = server.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
    assert.match(system, /startup-test/);
    assert.match(system, /Verify startup skill discovery/);
    server.reset();
    console.log("Mate startup and conversation reset passed");
  } finally {
    if (oldHome === undefined) delete process.env.MATE_HOME; else process.env.MATE_HOME = oldHome;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
