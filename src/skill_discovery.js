import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Mate's native load_skill reads its home skills folder, while its built-in
// resource index lists bundled skills only. Include imported names in that list.
export function installSkillDiscovery(agent, home = process.env.MATE_HOME || join(homedir(), ".mate")) {
  const original = agent.toolMessage.bind(agent);
  agent.toolMessage = async function(call) {
    const result = await original(call);
    if (call.function?.name !== "list_agent_resources") return result;
    let args;
    try { args = JSON.parse(call.function.arguments || "{}"); } catch { return result; }
    if (args.kind && !["all", "skills"].includes(args.kind)) return result;
    const rows = [];
    try {
      for (const folder of readdirSync(join(home, "skills"), { withFileTypes: true })) {
        if (!folder.isDirectory()) continue;
        try {
          const skill = JSON.parse(readFileSync(join(home, "skills", folder.name, ".deploymate-version.json"), "utf8"));
          rows.push(`- ${skill.name} (${skill.version}): ${skill.description || ""}`);
        } catch { /* User and bundled skills do not have imported ZIP metadata. */ }
      }
    } catch { return result; }
    if (rows.length && typeof result.content === "string") {
      return { ...result, content: result.content + "\n\n[imported skills]\n" + rows.sort().join("\n") + "\nUse load_skill with the skill name to read its instructions." };
    }
    return result;
  };
  return agent;
}
