#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentServer } from "./server.js";
import { TerminalUI as UI } from "./ui.js";
import * as tools from "./tools.js";

const steeringPrompts = [];

function parseArgs(argv) {
  const args = { workspace_arg: null, workspace_option: null };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === "--workspace") args.workspace_option = argv[++i];
    else if (!args.workspace_arg) args.workspace_arg = item;
  }
  return args;
}

function resolveWorkspace(args) {
  const workspace = args.workspace_option || args.workspace_arg;
  if (workspace) return workspace;
  return fs.mkdtempSync(path.join(os.tmpdir(), "mate-"));
}

function friendlyError(error) {
  if (error.status === 401) return "The model provider rejected OPENAI_API_KEY. Check that the key matches OPENAI_BASE_URL and is still active.";
  if (error.status === 429) return "The model provider rate-limited the request. Wait a moment and try again.";
  if (error.status >= 400) return `The model provider returned an error: ${error.message}`;
  return `${error.name}: ${error.message}`;
}

function printHelp() {
  UI.panel("Help", "Commands:\n- /help: show this help\n- /steer <guidance>: add persistent steering for future turns\n- /steer show: show active steering\n- /steer clear: clear active steering\n- /reset: clear conversation history except the base system prompt and steering\n- /resources [kind]: list copied resources; kind can be all, agents, skills, commands, hooks, plugins\n- /backgrounds: list background processes started in this session\n- /<command> [args]: run a copied slash command, for example /commit or /feature-dev auth flow\n- exit or quit: close Mate\n\nShell commands and mutating Git commands require approval before they run.\n");
}

function steeringMessage() {
  if (!steeringPrompts.length) return null;
  return { role: "system", content: `Persistent user steering for this session. Follow this guidance when it does not conflict with safety or the latest user request:\n${steeringPrompts.map((item) => `- ${item}`).join("\n")}` };
}

async function handleRuntimeCommand(server, userInput) {
  if (userInput === "/help") {
    printHelp();
    return true;
  }
  if (userInput === "/reset") {
    server.reset(steeringMessage());
    UI.panel("Reset", `Conversation reset.${steeringPrompts.length ? " Active steering was preserved." : ""}`, UI.CYAN);
    return true;
  }
  if (userInput.startsWith("/resources")) {
    const [, kind = "all"] = userInput.split(/\s+/, 2);
    try { UI.panel("Resources", tools.listAgentResources({ kind }), UI.CYAN); }
    catch (error) { UI.panel("Resources", `Could not list resources: ${error.name}: ${error.message}`, UI.RED); }
    return true;
  }
  if (userInput === "/backgrounds") {
    UI.panel("Background Processes", tools.listBackgroundProcesses(), UI.CYAN);
    return true;
  }
  if (userInput === "/steer show") {
    UI.panel("Steering", steeringPrompts.length ? steeringPrompts.map((prompt, i) => `${i + 1}. ${prompt}`).join("\n") : "No active steering prompts.", UI.CYAN);
    return true;
  }
  if (userInput === "/steer clear") {
    steeringPrompts.splice(0, steeringPrompts.length);
    UI.panel("Steering", "Cleared active steering prompts.", UI.CYAN);
    return true;
  }
  if (userInput.startsWith("/steer ")) {
    const guidance = userInput.slice("/steer ".length).trim();
    if (!guidance) UI.panel("Steering", "Usage: /steer <guidance>", UI.YELLOW);
    else {
      steeringPrompts.push(guidance);
      server.messages.push(steeringMessage());
      UI.panel("Steering", "Steering added for future turns.", UI.CYAN);
    }
    return true;
  }
  return false;
}

function expandSlashCommand(userInput) {
  if (!userInput.startsWith("/") || userInput === "/") return null;
  const [commandName, ...rest] = userInput.slice(1).trim().split(/\s+/);
  try {
    const commandPrompt = tools.loadCommand({ command_name: commandName });
    if (commandPrompt.startsWith("Multiple commands matched:")) {
      UI.panel("Command", commandPrompt, UI.YELLOW);
      return "";
    }
    const args = rest.join(" ").trim();
    return args ? `${commandPrompt}\n\nUser supplied slash-command arguments:\n${args}` : commandPrompt;
  } catch {
    return null;
  }
}

async function main() {
  const workspace = resolveWorkspace(parseArgs(process.argv.slice(2)));
  let server;
  try {
    server = AgentServer.create(workspace, UI);
  } catch (error) {
    UI.panel("Error", friendlyError(error), UI.RED);
    return;
  }

  while (true) {
    const promptAnswer = await UI.prompt(UI.promptLabel());
    if (promptAnswer === null) {
      UI.success("Closed Mate.");
      break;
    }
    let userInput = promptAnswer.trim();
    if (["exit", "quit"].includes(userInput.toLowerCase())) break;
    if (!userInput) continue;
    if (await handleRuntimeCommand(server, userInput)) continue;
    const expanded = expandSlashCommand(userInput);
    if (expanded === "") continue;
    if (expanded !== null) userInput = expanded;
    const started = Date.now();
    try {
      const answer = await server.runTurn(userInput);
      UI.answer(answer, (Date.now() - started) / 1000);
    } catch (error) {
      UI.panel("Error", friendlyError(error), UI.RED);
    }
  }
}

main();
