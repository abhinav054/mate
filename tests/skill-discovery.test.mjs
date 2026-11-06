import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installSkillDiscovery } from "../src/skill_discovery.js";
import { installPermissions } from "../src/permissions.js";

test("imported skills are discoverable without bypassing read permissions", async () => {
  const home = mkdtempSync(join(tmpdir(), "mate-skill-test-"));
  try {
    mkdirSync(join(home, "skills", "example"), { recursive: true });
    writeFileSync(join(home, "skills", "example", ".deploymate-version.json"), JSON.stringify({name:"example",version:"1.2.3",description:"Example"}));
    const agent = {toolMessage: async () => ({role:"tool",content:"bundled skills"})};
    installSkillDiscovery(agent, home);
    const call = {id:"test",function:{name:"list_agent_resources",arguments:'{"kind":"skills"}'}};
    assert.match((await agent.toolMessage(call)).content, /example \(1.2.3\)/);
    assert.doesNotMatch((await agent.toolMessage({...call,function:{...call.function,arguments:'{"kind":"hooks"}'}})).content, /example/);
    installPermissions(agent, {permissions:{read:"deny"}}, {setup:()=>false,approve:async()=>false});
    assert.match((await agent.toolMessage(call)).content,/denied/);
    assert.doesNotMatch((await agent.toolMessage(call)).content,/1.2.3/);
  } finally { rmSync(home,{recursive:true,force:true}); }
});
