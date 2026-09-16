import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import * as config from "./config.js";
import { version } from "./version.js";
import * as tools from "./tools.js";
import * as sessions from "./sessions.js";

function preview(value, limit = 900) {
  const text = String(value || "").trim();
  if (!text) return "(no output)";
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}\n...[preview trimmed]`;
}

function jsonArguments(value) {
  const parsed = JSON.parse(value || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("tool arguments must be a JSON object");
  return parsed;
}

function estimateTokens(messages) {
  const text = messages.map((message) => {
    const pieces = [message.role, message.content];
    if (message.tool_calls) pieces.push(JSON.stringify(message.tool_calls));
    if (message.name) pieces.push(message.name);
    if (message.tool_call_id) pieces.push(message.tool_call_id);
    return pieces.filter(Boolean).join("\n");
  }).join("\n\n");
  return Math.ceil(text.length / 4);
}

function splitContextForCompaction(messages, keepRecentMessages) {
  const systemMessages = messages.filter((message) => message.role === "system");
  const nonSystem = messages.filter((message) => message.role !== "system");
  if (nonSystem.length <= keepRecentMessages) return { systemMessages, compactable: [], recent: nonSystem };

  let recentStart = Math.max(0, nonSystem.length - keepRecentMessages);
  while (recentStart > 0 && nonSystem[recentStart].role === "tool") recentStart--;
  const previous = recentStart > 0 ? nonSystem[recentStart - 1] : null;
  if (previous && previous.tool_calls && previous.tool_calls.length) recentStart--;

  return {
    systemMessages,
    compactable: nonSystem.slice(0, recentStart),
    recent: nonSystem.slice(recentStart)
  };
}

function messageForSummary(message) {
  const label = String(message.role || "message").toUpperCase();
  const body = messageTextForContext(message);
  if (message.role === "tool") return `[TOOL ${message.tool_call_id || ""}]\n${body}`;
  if (message.tool_calls && message.tool_calls.length) return `[${label}]\n${body}\nTool calls: ${JSON.stringify(message.tool_calls)}`;
  return `[${label}]\n${body}`;
}

function messageTextForContext(message) {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.map((part) => part.text || JSON.stringify(part)).join("\n");
  return message.content == null ? "" : JSON.stringify(message.content);
}

export function describeToolStart(name, args) {
  const path = args.path;
  const cwd = args.cwd || ".";
  const labels = {
    browse_internet: `Fetch URL: ${args.url || "(missing URL)"}`,
    check_system_tools: "Check local command-line tools",
    list_files: `List directory: ${path || "."}`,
    glob_files: `Glob files: ${args.pattern || "(missing pattern)"} in ${cwd}`,
    git: `Git: git ${args.command || "(missing command)"}`,
    read_file: `Read file: ${path || "(missing path)"}`,
    touch_file: `Touch file: ${path || "(missing path)"}`,
    write_file: `${args.append ? "Append" : "Write"} file: ${path || "(missing path)"}`,
    edit_file: `Edit file: ${path || "(missing path)"}`,
    run_command: `Shell: ${args.command || "(missing command)"}  cwd=${cwd}`,
    start_background_process: `Start background: ${args.command || "(missing command)"}  cwd=${cwd}`,
    read_background_process: `Read background output: ${args.process_id || "(missing id)"}`,
    write_background_process: `Write background input: ${args.process_id || "(missing id)"}`,
    stop_background_process: `Stop background process: ${args.process_id || "(missing id)"}`,
    list_background_processes: "List background processes",
    request_user_input: `Ask user: ${args.prompt || "(missing prompt)"}`,
    record_workspace_server: `Record workspace server: ${args.command || "(missing command)"}`,
    search_files: `Search files: ${args.query || "(missing query)"} in ${path || "."}`,
    list_agent_resources: `List resources: ${args.kind || "all"}`,
    read_agent_resource: `Read resource: ${path || "(missing path)"}`,
    load_command: `Load command: /${String(args.command_name || "").replace(/^\//, "")}`,
    load_skill: `Load skill: ${args.skill_name || "(missing skill)"}`,
    load_agent_prompt: `Load agent prompt: ${args.agent_name || "(missing agent)"}`,
    update_todos: "Update task list",
    run_plugin_hook: `Run plugin hook: ${args.plugin_name || "(missing plugin)"}`
  };
  return labels[name] || `Tool: ${name}`;
}

export function describeToolDone(name, result, failed) {
  if (["read_file", "read_agent_resource", "load_command", "load_skill", "load_agent_prompt"].includes(name)) return `loaded ${String(result).split(/\r?\n/).length} line(s)`;
  if (["list_files", "glob_files", "search_files", "list_agent_resources", "list_background_processes"].includes(name)) return `found ${["", "no matches", "(empty)"].includes(String(result)) ? 0 : String(result).split(/\r?\n/).length} item(s)`;
  if (name === "request_user_input") return "user input received";
  return failed ? preview(result, 240) : "completed";
}

export function toolActionName(name) {
  const labels = {
    browse_internet: "Fetched URL", check_system_tools: "Checked tools", list_files: "Listed files", glob_files: "Matched files", git: "Ran git", read_file: "Read file", touch_file: "Touched file", write_file: "Wrote file", edit_file: "Edited file", run_command: "Ran shell command", start_background_process: "Started background process", read_background_process: "Read background output", write_background_process: "Wrote background input", stop_background_process: "Stopped background process", list_background_processes: "Listed background processes", request_user_input: "Asked for input", record_workspace_server: "Recorded workspace server", search_files: "Searched files", list_agent_resources: "Listed resources", read_agent_resource: "Read resource", load_command: "Loaded command", load_skill: "Loaded skill", load_agent_prompt: "Loaded agent prompt", update_todos: "Updated task list", run_plugin_hook: "Ran plugin hook"
  };
  return labels[name] || `Ran ${name}`;
}

export function approvalCommandSummary(name, args) {
  if (args.command) return String(args.command).trim();
  if (name === "git") return args.command ? `git ${args.command}` : "git";
  return toolActionName(name).toLowerCase();
}

export class AgentServer {
  constructor({ client, model, ui, messages, mateConfig, session }) {
    this.client = client;
    this.model = model;
    this.ui = ui;
    this.messages = messages;
    this.config = mateConfig;
    this.session = session;
    this.savedMessageCount = messages.length;
  }

  static create(workspace, ui, options = {}) {
    const workspacePath = tools.setWorkspace(workspace);
    const workspaceMateHome = path.join(workspacePath, ".mate");
    const configHome = process.env.MATE_HOME ? null : (fs.existsSync(workspaceMateHome) ? workspaceMateHome : null);
    const mateConfig = config.loadConfig(configHome);
    tools.setToolUi({
      diff_handler: (body) => ui.diff(body),
      input_handler: async (prompt, secret, defaultValue) => {
        const rows = [String(prompt || "").trim() || "Input required"];
        if (defaultValue !== null && !secret) rows.push(`Default: ${defaultValue}`);
        ui.panel("Input Required", rows.join("\n"), ui.YELLOW);
        const answer = await ui.prompt("Enter value: ", secret);
        if (answer === null) throw new Error("user cancelled input");
        return answer;
      }
    });

    const modelConfig = typeof mateConfig.raw.model === "object" ? mateConfig.raw.model : {};
    const apiKeyEnv = String(modelConfig.api_key_env || "OPENAI_API_KEY");
    const baseUrlEnv = String(modelConfig.base_url_env || "OPENAI_BASE_URL");
    const modelEnv = String(modelConfig.model_env || "OPENAI_MODEL");
    const apiKey = process.env[apiKeyEnv] || "";
    const baseURL = process.env[baseUrlEnv] || "https://api.openai.com/v1";
    const model = process.env[modelEnv] || "gpt-4.1-mini";
    if (!apiKey) throw new Error(`${apiKeyEnv} is required`);

    const resourceRoot = tools.resourceRoot();
    const baseSystemMessage = {
      role: "system",
      content: `You are Mate, a coding companion running in a terminal. Your workspace is ${workspacePath}. Mate config is loaded from ${mateConfig.mate_home}. Agent resources are available at ${resourceRoot}. Use tools to inspect, search, create, and edit files. Do not write outside the workspace. At the start of every session, first understand the project structure from the supplied project structure context and inspect any additional files needed before planning changes. When browsing, use the browse_internet tool. Use list_agent_resources and read_agent_resource to discover and apply copied agents, skills, commands, hooks, and plugin guidance when relevant. Tool name mappings: LS=list_files, Glob=glob_files, Grep=search_files, Read=read_file, Write=write_file, Edit/MultiEdit=edit_file, Bash=run_command, TodoWrite=update_todos, Skill=load_skill, Task=load_agent_prompt, and slash commands=load_command. Use the git tool for Git status, diff, log, branch, show, add, commit, restore, and related operations instead of run_command. Use run_command for tests, formatting, and project inspection. After writing code, summarize the changed files and the verification you performed.`
    };
    const projectContext = tools.projectStructureSummary();
    const promptMessages = mateConfig.prompt_override ? [{ role: "system", content: mateConfig.prompt_override }] : [];
    const projectMessage = { role: "system", content: `Project structure context captured at startup. Use this to orient yourself before answering the first user request:\n${projectContext}` };
    const session = options.session || sessions.createSession(workspacePath);
    const restoredMessages = Array.isArray(options.resumeMessages) ? options.resumeMessages : [];
    ui.banner(`Mate ${version()}`, `Workspace: ${workspacePath}\nConfig: ${mateConfig.mate_home}\nResources: ${resourceRoot}\nBase URL: ${baseURL}\nModel: ${model}\nSession: ${session.id}${restoredMessages.length ? " (resumed)" : ""}\n\nType a request, /help for commands, or exit/quit to close.`);
    ui.panel("Project Structure", projectContext, ui.CYAN);
    return new AgentServer({ client: new OpenAI({ apiKey, baseURL }), model, ui, messages: [baseSystemMessage, ...promptMessages, projectMessage, ...restoredMessages], mateConfig, session });
  }

  reset(steeringMessage = null) {
    const promptMessages = this.config.prompt_override ? [{ role: "system", content: this.config.prompt_override }] : [];
    const project = { role: "system", content: `Project structure context captured at reset. Use this to orient yourself before answering the next user request:\n${tools.projectStructureSummary()}` };
    this.messages = [this.messages[0], ...promptMessages, project, ...(steeringMessage ? [steeringMessage] : [])];
    this.savedMessageCount = this.messages.length;
  }

  async runTurn(userGoal) {
    this.messages.push({ role: "user", content: userGoal });
    try {
      return await this.runAgentTurn(userGoal);
    } finally {
      this.saveNewMessages();
    }
  }

  saveNewMessages() {
    const newMessages = this.messages.slice(this.savedMessageCount).filter((message) => message.role !== "system");
    sessions.appendMessages(this.session, newMessages);
    this.savedMessageCount = this.messages.length;
  }

  async toolMessage(toolCall) {
    const name = toolCall.function.name;
    let failed = false;
    let result = "";
    let args = {};
    try {
      args = jsonArguments(toolCall.function.arguments);
      this.ui.activity("Working", describeToolStart(name, args), this.ui.MAGENTA);
      const command = String(args.command || "");
      let requiresApproval = config.toolRequiresApproval(this.config, name, command);
      if (name === "git" && tools.gitRequiresApproval(command)) requiresApproval = !config.toolAllowedWithoutApproval(this.config, name, `git ${command}`);
      if (requiresApproval && !(await this.confirmToolExecution(name, args))) throw new Error("user denied command approval");
      const fn = tools.TOOLS[name];
      if (!fn) throw new Error(`unknown tool: ${name}`);
      result = await fn(args);
    } catch (error) {
      failed = true;
      result = `ERROR: ${error.name}: ${error.message}`;
    }
    this.ui.activity(failed ? `Failed ${toolActionName(name).toLowerCase()}` : toolActionName(name), describeToolDone(name, result, failed), failed ? this.ui.RED : this.ui.GREEN);
    return { role: "tool", tool_call_id: toolCall.id, content: String(result) };
  }

  async confirmToolExecution(name, args) {
    const summary = approvalCommandSummary(name, args);
    if (["1", "true", "yes"].includes(String(process.env.AGENT_AUTO_APPROVE_COMMANDS || "").toLowerCase())) {
      this.ui.success(`You approved Mate to run \`${summary}\` automatically`);
      return true;
    }
    while (true) {
      const rawAnswer = await this.ui.transientPrompt(`Allow Mate to run \`${summary}\`? [y/N] `);
      if (rawAnswer === null) {
        this.ui.warning(`Cancelled approval for \`${summary}\``);
        return false;
      }
      const answer = rawAnswer.trim().toLowerCase();
      if (["y", "yes"].includes(answer)) {
        this.ui.success(`You approved Mate to run \`${summary}\` this time`);
        return true;
      }
      if (["", "n", "no"].includes(answer)) {
        this.ui.warning(`You denied Mate permission to run \`${summary}\``);
        return false;
      }
    }
  }

  async runAgentUntilAnswer() {
    while (true) {
      await this.compactContextIfNeeded();
      const response = await this.createChatCompletionWithRetry({ label: "model request", model: this.model, messages: this.messages, tools: tools.TOOL_DEFINITIONS, tool_choice: "auto" });
      const message = response.choices[0].message;
      this.messages.push(message);
      if (!message.tool_calls || !message.tool_calls.length) return message.content || "";
      for (const toolCall of message.tool_calls) this.messages.push(await this.toolMessage(toolCall));
    }
  }

  async runAgentTurn(userGoal) {
    const maxChecks = Math.max(0, Number.parseInt(process.env.AGENT_HARNESS_MAX_RETRIES || "2", 10));
    for (let i = 0; i <= maxChecks; i++) {
      const answer = await this.runAgentUntilAnswer();
      if (i >= maxChecks) return answer;
      try {
        const assessment = await this.assessAnswer(userGoal, answer);
        if (assessment.aligned) return answer;
        if (!assessment.can_improve_with_tools || !assessment.follow_up_prompt) return answer;
        this.ui.activity("Worked on result", `taking another pass. ${assessment.reason || ""}`.trim(), this.ui.YELLOW);
        this.messages.push({ role: "user", content: `Result check feedback: your previous answer may not fully satisfy the user. Use any relevant tools and improve the answer. Reason: ${assessment.reason || ""}\nFollow-up instruction: ${assessment.follow_up_prompt}` });
      } catch (error) {
        this.ui.activity("Worked on result", `check skipped (${error.name}: ${error.message})`, this.ui.YELLOW);
        return answer;
      }
    }
    return "";
  }

  async compactContextIfNeeded() {
    const maxTokens = Math.max(1000, Number.parseInt(process.env.AGENT_CONTEXT_MAX_TOKENS || "90000", 10));
    const targetTokens = Math.max(1000, Number.parseInt(process.env.AGENT_CONTEXT_TARGET_TOKENS || String(Math.floor(maxTokens * 0.65)), 10));
    const keepRecentMessages = Math.max(8, Number.parseInt(process.env.AGENT_CONTEXT_KEEP_RECENT_MESSAGES || "24", 10));
    const currentTokens = estimateTokens(this.messages);
    if (currentTokens <= maxTokens) return;

    const { systemMessages, compactable, recent } = splitContextForCompaction(this.messages, keepRecentMessages);
    if (!compactable.length) return;

    this.saveNewMessages();
    this.ui.panel("Compacting Context", `Estimated context is ${currentTokens} tokens. Summarizing older turns and preserving recent work verbatim.`, this.ui.YELLOW);
    this.ui.activity("Compacting context", `estimated ${currentTokens} tokens; preserving recent work verbatim`, this.ui.YELLOW);
    const existingSummary = systemMessages.find((message) => message.name === "context_compaction_summary");
    const summaryInput = [
      existingSummary ? `Previous compacted context:\n${existingSummary.content}` : "",
      "Older conversation to compact:",
      compactable.map(messageForSummary).join("\n\n")
    ].filter(Boolean).join("\n\n");

    const response = await this.createChatCompletionWithRetry({
      label: "context compaction",
      model: this.model,
      messages: [
        {
          role: "system",
          content: "You compact an agent conversation so work can continue with minimal context loss. Keep durable facts, user goals, constraints, decisions, files changed or inspected, commands run, test results, tool outputs that matter, unresolved tasks, and any active assumptions. Omit chatter, duplicate output, and irrelevant logs. Write concise bullet points."
        },
        { role: "user", content: summaryInput }
      ]
    });

    const summary = response.choices[0].message.content || "Context was compacted, but the summarizer returned no details.";
    const summaryMessage = {
      role: "system",
      name: "context_compaction_summary",
      content: `Compacted conversation context. Use this as durable memory for prior turns while treating newer messages as authoritative:\n${summary}`
    };
    const preservedSystemMessages = systemMessages.filter((message) => message.name !== "context_compaction_summary");
    this.messages = [...preservedSystemMessages, summaryMessage, ...recent];
    this.savedMessageCount = this.messages.length;

    const compactedTokens = estimateTokens(this.messages);
    if (compactedTokens > targetTokens && recent.length > 12) {
      this.ui.activity("Compacted context", `now estimated ${compactedTokens} tokens; still above target because recent messages were preserved`, this.ui.YELLOW);
    } else {
      this.ui.activity("Compacted context", `now estimated ${compactedTokens} tokens`, this.ui.GREEN);
    }
  }

  async assessAnswer(userGoal, answer) {
    const response = await this.createChatCompletionWithRetry({
      label: "result check",
      model: this.model,
      messages: [
        { role: "system", content: "You are a strict production result checker for Mate. Return only JSON with keys: aligned, can_improve_with_tools, reason, follow_up_prompt." },
        { role: "user", content: `User prompt:\n${userGoal}\n\nCandidate response:\n${answer}\n\nAssess whether the response is complete, directly responsive, and honest about verification.` }
      ],
      response_format: { type: "json_object" }
    });
    return extractJsonObject(response.choices[0].message.content || "{}");
  }

  async createChatCompletionWithRetry({ label, ...kwargs }) {
    const maxRetries = Math.max(0, Number.parseInt(process.env.AGENT_MODEL_RATE_LIMIT_RETRIES || "2", 10));
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.client.chat.completions.create(kwargs);
      } catch (error) {
        if (error.status !== 429 || attempt >= maxRetries) throw error;
        const delay = Math.min(2 ** attempt, Number.parseFloat(process.env.AGENT_MODEL_RATE_LIMIT_MAX_DELAY_SECONDS || "30"));
        this.ui.activity("Rate limited", `${label}; retrying in ${this.ui.formatDuration(delay)}`, this.ui.YELLOW);
        await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      }
    }
    throw new Error("unreachable rate-limit retry state");
  }
}

function extractJsonObject(value) {
  let text = value.trim();
  if (text.startsWith("```")) text = text.split(/\r?\n/).filter((line) => !line.trim().startsWith("```")).join("\n").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("no JSON object found");
  return JSON.parse(text.slice(start, end + 1));
}
