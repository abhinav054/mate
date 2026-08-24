from __future__ import annotations

import argparse
import tempfile
import time
from pathlib import Path

from openai import APIConnectionError, APIError, AuthenticationError, BadRequestError, RateLimitError

from . import tools
from .server import AgentServer
from .ui import TerminalUI as UI

STEERING_PROMPTS: list[str] = []


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Mate against a workspace directory.")
    parser.add_argument(
        "workspace_arg",
        nargs="?",
        help="Workspace directory Mate may read, write, and run commands inside.",
    )
    parser.add_argument(
        "--workspace",
        dest="workspace_option",
        help="Workspace directory Mate may read, write, and run commands inside.",
    )
    return parser.parse_args()


def _resolve_workspace(args: argparse.Namespace) -> str | Path:
    workspace = args.workspace_option or args.workspace_arg
    if workspace:
        return workspace
    return Path(tempfile.mkdtemp(prefix="mate-"))


def _friendly_error(exc: BaseException) -> str:
    if isinstance(exc, AuthenticationError):
        return "The model provider rejected OPENAI_API_KEY. Check that the key matches OPENAI_BASE_URL and is still active."
    if isinstance(exc, RateLimitError):
        return "The model provider rate-limited the request. Wait a moment and try again."
    if isinstance(exc, APIConnectionError):
        return "Could not connect to the model provider. Check your network and OPENAI_BASE_URL."
    if isinstance(exc, BadRequestError):
        return f"The model provider rejected the request: {exc}"
    if isinstance(exc, APIError):
        return f"The model provider returned an error: {exc}"
    return f"{type(exc).__name__}: {exc}"


def _print_help() -> None:
    UI.panel(
        "Help",
        "Commands:\n"
        "- /help: show this help\n"
        "- /steer <guidance>: add persistent steering for future turns\n"
        "- /steer show: show active steering\n"
        "- /steer clear: clear active steering\n"
        "- /reset: clear conversation history except the base system prompt and steering\n"
        "- /resources [kind]: list copied resources; kind can be all, agents, skills, commands, hooks, plugins\n"
        "- /backgrounds: list background processes started in this session\n"
        "- /<command> [args]: run a copied slash command, for example /commit or /feature-dev auth flow\n"
        "- exit or quit: close Mate\n"
        "\nShell commands and mutating Git commands require approval before they run.\n",
    )


def _steering_message() -> dict[str, str] | None:
    if not STEERING_PROMPTS:
        return None
    guidance = "\n".join(f"- {item}" for item in STEERING_PROMPTS)
    return {
        "role": "system",
        "content": (
            "Persistent user steering for this session. Follow this guidance when it does not conflict "
            f"with safety or the latest user request:\n{guidance}"
        ),
    }


def _handle_runtime_command(server: AgentServer, user_input: str) -> bool:
    if user_input == "/help":
        _print_help()
        return True
    if user_input == "/reset":
        server.reset(_steering_message())
        suffix = " Active steering was preserved." if STEERING_PROMPTS else ""
        UI.panel("Reset", f"Conversation reset.{suffix}", UI.CYAN)
        return True
    if user_input.startswith("/resources"):
        parts = user_input.split(maxsplit=1)
        kind = parts[1].strip() if len(parts) > 1 else "all"
        try:
            UI.panel("Resources", tools.list_agent_resources(kind), UI.CYAN)
        except Exception as exc:
            UI.panel("Resources", f"Could not list resources: {type(exc).__name__}: {exc}", UI.RED)
        return True
    if user_input == "/backgrounds":
        UI.panel("Background Processes", tools.list_background_processes(), UI.CYAN)
        return True
    if user_input == "/steer show":
        if not STEERING_PROMPTS:
            UI.panel("Steering", "No active steering prompts.", UI.CYAN)
        else:
            rows = [f"{index}. {prompt}" for index, prompt in enumerate(STEERING_PROMPTS, start=1)]
            UI.panel("Steering", "\n".join(rows), UI.CYAN)
        return True
    if user_input == "/steer clear":
        STEERING_PROMPTS.clear()
        UI.panel("Steering", "Cleared active steering prompts.", UI.CYAN)
        return True
    if user_input.startswith("/steer "):
        guidance = user_input.removeprefix("/steer ").strip()
        if not guidance:
            UI.panel("Steering", "Usage: /steer <guidance>", UI.YELLOW)
            return True
        STEERING_PROMPTS.append(guidance)
        server.messages.append(_steering_message())
        UI.panel("Steering", "Steering added for future turns.", UI.CYAN)
        return True
    return False


def _expand_slash_command(user_input: str) -> str | None:
    if not user_input.startswith("/") or user_input == "/":
        return None
    command_with_args = user_input[1:].strip()
    if not command_with_args:
        return None
    command_name, _, arguments = command_with_args.partition(" ")
    try:
        command_prompt = tools.load_command(command_name)
    except FileNotFoundError:
        return None
    if command_prompt.startswith("Multiple commands matched:"):
        UI.panel("Command", command_prompt, UI.YELLOW)
        return ""
    if arguments.strip():
        return f"{command_prompt}\n\nUser supplied slash-command arguments:\n{arguments.strip()}"
    return command_prompt


def main() -> None:
    args = _parse_args()
    workspace = _resolve_workspace(args)
    try:
        server = AgentServer.create(workspace, UI)
    except Exception as exc:
        UI.panel("Error", _friendly_error(exc), UI.RED)
        return

    while True:
        try:
            user_input = input(UI.prompt_label()).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if user_input.lower() in {"exit", "quit"}:
            break
        if not user_input:
            continue
        if _handle_runtime_command(server, user_input):
            continue
        expanded_command = _expand_slash_command(user_input)
        if expanded_command == "":
            continue
        if expanded_command is not None:
            user_input = expanded_command

        started = time.monotonic()
        try:
            answer = server.run_turn(user_input)
        except KeyboardInterrupt:
            print()
            UI.panel("Interrupted", "Request cancelled.", UI.YELLOW)
            continue
        except Exception as exc:
            UI.panel("Error", _friendly_error(exc), UI.RED)
            continue
        UI.answer(answer, time.monotonic() - started)


if __name__ == "__main__":
    main()
