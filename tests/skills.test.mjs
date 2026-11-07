import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentServer } from "../src/server.js";
import { listAgentResources, loadSkill, localSkillSummary, readAgentResource } from "../src/tools.js";

test("session-installed skills are discoverable, loadable, and take precedence over bundled skills", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-skills-"));
  const previousHome = process.env.MATE_HOME;
  const previousResources = process.env.AGENT_RESOURCES_DIR;
  try {
    process.env.MATE_HOME = path.join(root, "mate");
    process.env.AGENT_RESOURCES_DIR = path.join(root, "missing-bundle");
    const skill = path.join(process.env.MATE_HOME, "skills", "deploymate");
    fs.mkdirSync(path.join(skill, "references"), { recursive: true });
    const instructions = "---\nname: deploymate\ndescription: Prepare service environments\n---\nUse session services; Docker is prohibited.\n";
    fs.writeFileSync(path.join(skill, "SKILL.md"), instructions);
    fs.writeFileSync(path.join(skill, "references", "setup.md"), "Setup reference");
    for (const listing of [localSkillSummary(), listAgentResources({ kind: "skills" }), listAgentResources()]) {
      assert.match(listing, /deploymate/);
      assert.match(listing, /Prepare service environments/);
      assert.match(listing, /load_skill/);
    }
    assert.equal(loadSkill({ skill_name: "deploymate" }), instructions);
    assert.equal(readAgentResource({ path: "skills/deploymate/references/setup.md" }), "Setup reference");
    assert.match(readAgentResource({ path: "skills/deploymate/references" }), /skills\/deploymate\/references\/setup.md/);
    const bundled = process.env.AGENT_RESOURCES_DIR;
    fs.mkdirSync(path.join(bundled, "index"), { recursive: true });
    fs.mkdirSync(path.join(bundled, "mate-plugins", "test", "skills", "deploymate"), { recursive: true });
    fs.writeFileSync(path.join(bundled, "index", "skills.txt"), "test/skills/deploymate/SKILL.md\n");
    fs.writeFileSync(path.join(bundled, "mate-plugins", "test", "skills", "deploymate", "SKILL.md"), "Bundled fallback");
    assert.equal(loadSkill({ skill_name: "deploymate" }), instructions);
    fs.rmSync(skill, { recursive: true });
    assert.equal(loadSkill({ skill_name: "deploymate" }), "Bundled fallback");
    assert.match(localSkillSummary(), /no attached skills/);
    assert.throws(() => loadSkill({ skill_name: "../outside" }), /folder name/);
    fs.writeFileSync(path.join(process.env.MATE_HOME, "outside.md"), "not a skill");
    assert.throws(() => readAgentResource({ path: "skills/../outside.md" }), /escapes local skills/);
  } finally {
    if (previousHome === undefined) delete process.env.MATE_HOME; else process.env.MATE_HOME = previousHome;
    if (previousResources === undefined) delete process.env.AGENT_RESOURCES_DIR; else process.env.AGENT_RESOURCES_DIR = previousResources;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("Mate startup exposes configured skills before the first setup turn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-startup-skills-"));
  const previousHome = process.env.MATE_HOME;
  const previousKey = process.env.OPENAI_API_KEY;
  try {
    process.env.MATE_HOME = path.join(root, ".mate");
    process.env.OPENAI_API_KEY = "test-only-not-used";
    const skill = path.join(process.env.MATE_HOME, "skills", "deploymate");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: deploymate\ndescription: Configure session service environments\n---\nSetup instructions\n");
    const server = await AgentServer.create(root, {}, { showStartup: false });
    const initial = server.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
    assert.match(initial, /deploymate/);
    assert.match(initial, /Configure session service environments/);
    assert.match(initial, /load_skill/);
    assert.match(initial, /before planning|Before planning/);
  } finally {
    if (previousHome === undefined) delete process.env.MATE_HOME; else process.env.MATE_HOME = previousHome;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("successful skill use announces the skill alongside tool chat messages", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-skill-message-"));
  const previousHome = process.env.MATE_HOME;
  try {
    process.env.MATE_HOME = root;
    fs.mkdirSync(path.join(root, "skills", "deploymate"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "deploymate", "SKILL.md"), "Deployment instructions");
    const messages = [];
    const server = new AgentServer({ messages: [], mateConfig: { approval: { auto_approve: true } }, ui: { activity() {}, message: text => messages.push(text) } });
    const call = (name, args) => server.toolMessage({ id: "test-call", function: { name, arguments: JSON.stringify(args) } });
    await call("list_agent_resources", { kind: "skills" });
    assert.deepEqual(messages, ["Running tool: list_agent_resources"]);
    assert.equal((await call("load_skill", { skill_name: "deploymate" })).content, "Deployment instructions");
    assert.deepEqual(messages.filter(text => text.startsWith("Using skill:")), ["Using skill: deploymate"]);
    await call("load_skill", { skill_name: "missing-test-skill" });
    assert.equal(messages.filter(text => text.startsWith("Using skill:")).length, 1);
    await call("read_agent_resource", { path: "skills/deploymate/SKILL.md" });
    assert.deepEqual(messages.filter(text => text.startsWith("Using skill:")), ["Using skill: deploymate", "Using skill: deploymate"]);
  } finally {
    if (previousHome === undefined) delete process.env.MATE_HOME; else process.env.MATE_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
