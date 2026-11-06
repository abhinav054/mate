const readTools = new Set(["read_file", "list_files", "glob_files", "search_files", "check_system_tools", "read_background_process", "monitor_background_process", "list_background_processes", "list_agent_resources", "read_agent_resource", "load_command", "load_skill", "load_agent_prompt"]);
const writeTools = new Set(["touch_file", "write_file", "edit_file", "record_workspace_server", "update_todos"]);
const commandTools = new Set(["run_command", "start_background_process", "write_background_process", "stop_background_process", "git", "run_plugin_hook"]);

export function toolPermission(agent, policy, name) {
  const mapped = agent.mcpRegistry?.toolMap?.get(name);
  if (mapped) return policy.mcp?.[mapped.serverName] || "ask";
  if (name.startsWith("mcp__")) return "deny";
  if (name === "request_user_input") return "allow";
  const category = readTools.has(name) ? "read" : writeTools.has(name) ? "write" : commandTools.has(name) ? "commands" : name === "browse_internet" ? "network" : null;
  return category ? policy.permissions?.[category] || "ask" : "deny";
}

export function installPermissions(agent, policy, { setup, approve }) {
  const original = agent.toolMessage.bind(agent);
  // Native require_tools/require_commands checks can override auto_approve.
  // Only the server-owned setup turn may skip that second approval layer.
  if (typeof agent.confirmToolExecution === "function") {
    const confirm = agent.confirmToolExecution.bind(agent);
    agent.confirmToolExecution = async function(...args) {
      if (setup()) return true;
      return confirm(...args);
    };
  }
  // Our gate handles every tool, including MCP; suppress duplicate native prompts.
  if (agent.config?.approval) agent.config.approval.auto_approve = true;
  agent.toolMessage = async function(call) {
    if (setup()) return original(call);
    const name = call.function.name;
    const mode = toolPermission(agent, policy, name);
    if (mode === "allow" || (mode === "ask" && await approve(name))) return original(call);
    return { role: "tool", tool_call_id: call.id, content: `ERROR: Agent permissions denied tool: ${name}` };
  };
  return agent;
}
