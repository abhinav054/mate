from __future__ import annotations

import json
import os
import random
import re
import time
from dataclasses import dataclass
from typing import Any

from openai import OpenAI, RateLimitError

from . import config as mate_config
from . import version as mate_version
from . import tools


def _preview(value: str, limit: int = 900) -> str:
    value = value.strip()
    if not value:
        return "(no output)"
    return value if len(value) <= limit else value[:limit].rstrip() + "\n...[preview trimmed]"


def _json_arguments(value: str | None) -> dict[str, Any]:
    parsed = json.loads(value or "{}")
    if not isinstance(parsed, dict):
        raise ValueError("tool arguments must be a JSON object")
    return parsed


def _response_headers(exc: Exception) -> dict[str, str]:
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if not headers:
        return {}
    return {str(key).lower(): str(value) for key, value in headers.items()}


def _parse_duration_seconds(value: str | None) -> float | None:
    if not value:
        return None
    text = value.strip().lower()
    try:
        return max(0.0, float(text))
    except ValueError:
        pass
    match = re.fullmatch(r"(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?", text)
    if not match:
        return None
    hours, minutes, seconds = (float(part) if part else 0.0 for part in match.groups())
    return max(0.0, hours * 3600 + minutes * 60 + seconds)


def _rate_limit_retry_delay(exc: RateLimitError, attempt: int) -> float:
    max_delay = max(0.0, float(os.getenv("AGENT_MODEL_RATE_LIMIT_MAX_DELAY_SECONDS", "30")))
    header_delay = _rate_limit_header_delay(exc)
    if header_delay is not None:
        return min(header_delay, max_delay)
    fallback = min(2.0**attempt, max_delay)
    return fallback + random.uniform(0.0, min(1.0, fallback * 0.1))


def _rate_limit_header_delay(exc: RateLimitError) -> float | None:
    headers = _response_headers(exc)
    for header in ("retry-after", "x-ratelimit-reset-tokens", "x-ratelimit-reset-requests"):
        parsed = _parse_duration_seconds(headers.get(header))
        if parsed is not None:
            return parsed
    return None


def _rate_limit_status(exc: RateLimitError) -> int | None:
    response = getattr(exc, "response", None)
    status_code = getattr(response, "status_code", None)
    return int(status_code) if isinstance(status_code, int) else None


def describe_tool_start(name: str, arguments: dict[str, Any]) -> str:
    path = arguments.get("path")
    cwd = arguments.get("cwd", ".")
    if name == "browse_internet":
        return f"Fetch URL: {arguments.get('url', '(missing URL)')}"
    if name == "check_system_tools":
        return "Check local command-line tools"
    if name == "list_files":
        return f"List directory: {path or '.'}"
    if name == "glob_files":
        return f"Glob files: {arguments.get('pattern', '(missing pattern)')} in {cwd if path is None else path}"
    if name == "git":
        return f"Git: git {arguments.get('command', '(missing command)')}"
    if name == "read_file":
        return f"Read file: {path or '(missing path)'}"
    if name == "touch_file":
        return f"Touch file: {path or '(missing path)'}"
    if name == "write_file":
        action = "Append file" if arguments.get("append") else "Write file"
        return f"{action}: {path or '(missing path)'}"
    if name == "edit_file":
        return f"Edit file: {path or '(missing path)'}"
    if name == "run_command":
        return f"Shell: {arguments.get('command', '(missing command)')}  cwd={cwd}"
    if name == "start_background_process":
        return f"Start background: {arguments.get('command', '(missing command)')}  cwd={cwd}"
    if name == "read_background_process":
        return f"Read background output: {arguments.get('process_id', '(missing id)')}"
    if name == "write_background_process":
        return f"Write background input: {arguments.get('process_id', '(missing id)')}"
    if name == "stop_background_process":
        return f"Stop background process: {arguments.get('process_id', '(missing id)')}"
    if name == "list_background_processes":
        return "List background processes"
    if name == "request_user_input":
        return f"Ask user: {arguments.get('prompt', '(missing prompt)')}"
    if name == "record_workspace_server":
        return f"Record workspace server: {arguments.get('command', '(missing command)')}"
    if name == "search_files":
        return f"Search files: {arguments.get('query', '(missing query)')} in {arguments.get('path', '.')}"
    if name == "list_agent_resources":
        return f"List resources: {arguments.get('kind', 'all')}"
    if name == "read_agent_resource":
        return f"Read resource: {path or '(missing path)'}"
    if name == "load_command":
        return f"Load command: /{str(arguments.get('command_name', '')).lstrip('/')}"
    if name == "load_skill":
        return f"Load skill: {arguments.get('skill_name', '(missing skill)')}"
    if name == "load_agent_prompt":
        return f"Load agent prompt: {arguments.get('agent_name', '(missing agent)')}"
    if name == "update_todos":
        return "Update task list"
    if name == "run_plugin_hook":
        return f"Run plugin hook: {arguments.get('plugin_name', '(missing plugin)')}"
    return f"Tool: {name}"


def describe_tool_done(name: str, result: str, failed: bool) -> str:
    if name in {"read_file", "read_agent_resource", "load_command", "load_skill", "load_agent_prompt"}:
        return f"loaded {len(result.splitlines())} line(s)"
    if name in {"list_files", "glob_files", "search_files", "list_agent_resources", "list_background_processes"}:
        count = 0 if result in {"", "no matches", "(empty)"} else len(result.splitlines())
        return f"found {count} item(s)"
    if name == "request_user_input":
        return "user input received"
    if failed:
        return _preview(result, 240)
    return "completed"


def tool_action_name(name: str) -> str:
    labels = {
        "browse_internet": "Fetched URL",
        "check_system_tools": "Checked tools",
        "list_files": "Listed files",
        "glob_files": "Matched files",
        "git": "Ran git",
        "read_file": "Read file",
        "touch_file": "Touched file",
        "write_file": "Wrote file",
        "edit_file": "Edited file",
        "run_command": "Ran shell command",
        "start_background_process": "Started background process",
        "read_background_process": "Read background output",
        "write_background_process": "Wrote background input",
        "stop_background_process": "Stopped background process",
        "list_background_processes": "Listed background processes",
        "request_user_input": "Asked for input",
        "record_workspace_server": "Recorded workspace server",
        "search_files": "Searched files",
        "list_agent_resources": "Listed resources",
        "read_agent_resource": "Read resource",
        "load_command": "Loaded command",
        "load_skill": "Loaded skill",
        "load_agent_prompt": "Loaded agent prompt",
        "update_todos": "Updated task list",
        "run_plugin_hook": "Ran plugin hook",
    }
    return labels.get(name, f"Ran {name}")


def tool_failed_action_name(name: str) -> str:
    action = tool_action_name(name)
    if action.startswith("Ran "):
        return "Failed " + action.removeprefix("Ran ")
    if action.endswith("ed"):
        return "Failed to " + action[:-2].lower()
    return "Failed " + action.lower()


def approval_command_summary(name: str, arguments: dict[str, Any]) -> str:
    command = str(arguments.get("command", "")).strip()
    if command:
        return command
    if name == "git":
        git_command = str(arguments.get("command", "")).strip()
        return f"git {git_command}" if git_command else "git"
    return tool_action_name(name).lower()


@dataclass
class AgentServer:
    client: OpenAI
    model: str
    ui: Any
    messages: list[dict[str, Any]]
    config: mate_config.MateConfig

    @classmethod
    def create(cls, workspace: str | os.PathLike[str], ui: Any) -> "AgentServer":
        workspace_path = tools.set_workspace(workspace)
        workspace_mate_home = workspace_path / ".mate"
        config_home = None if os.getenv("MATE_HOME") else workspace_mate_home if workspace_mate_home.exists() else None
        config = mate_config.load_config(config_home)
        tools.set_tool_ui(
            diff_handler=ui.diff,
            input_handler=lambda prompt, secret, default: _input_with_ui(ui, prompt, secret, default),
        )

        model_config = config.raw.get("model", {}) if isinstance(config.raw.get("model"), dict) else {}
        api_key_env = str(model_config.get("api_key_env", "OPENAI_API_KEY"))
        base_url_env = str(model_config.get("base_url_env", "OPENAI_BASE_URL"))
        model_env = str(model_config.get("model_env", "OPENAI_MODEL"))
        api_key = os.getenv(api_key_env, "")
        base_url = os.getenv(base_url_env, "https://api.openai.com/v1")
        model = os.getenv(model_env, "gpt-4.1-mini")
        if not api_key:
            raise RuntimeError(f"{api_key_env} is required")

        client = OpenAI(api_key=api_key, base_url=base_url)
        resource_root = tools.resource_root()
        base_system_message = {
            "role": "system",
            "content": (
                "You are Mate, a coding companion running in a terminal. "
                f"Your workspace is {workspace_path}. "
                f"Mate config is loaded from {config.mate_home}. "
                f"Agent resources are available at {resource_root}. "
                "Use tools to inspect, search, create, and edit files. "
                "Do not write outside the workspace. "
                "At the start of every session, first understand the project structure from the supplied project structure context and inspect any additional files needed before planning changes. "
                "When browsing, use the browse_internet tool. "
                "Use list_agent_resources and read_agent_resource to discover and apply copied agents, skills, commands, hooks, and plugin guidance when relevant. "
                "Tool name mappings: LS=list_files, Glob=glob_files, Grep=search_files, Read=read_file, Write=write_file, Edit/MultiEdit=edit_file, Bash=run_command, TodoWrite=update_todos, Skill=load_skill, Task=load_agent_prompt, and slash commands=load_command. "
                "Use the git tool for Git status, diff, log, branch, show, add, commit, restore, and related operations instead of run_command. "
                "Use check_system_tools when a copied plugin depends on external CLIs. "
                "When you start or identify a workspace server, record it with record_workspace_server; run_command also records common server commands automatically in .codex/workspace-servers.jsonl. "
                "Use start_background_process for long-running servers or watchers, then list_background_processes, read_background_process, write_background_process, and stop_background_process to manage them. "
                "Whenever required information is missing from the user, such as database URLs, API keys, credentials, tokens, deployment settings, or important product choices, use request_user_input to ask for it in the terminal UI, then proceed with the answer or implementation. Use secret=true for sensitive values. "
                "Before changing files, inspect relevant files when they exist. "
                "Use run_command for tests, formatting, and project inspection. "
                "After writing code, summarize the changed files and the verification you performed."
            ),
        }
        project_context = tools.project_structure_summary()
        prompt_messages = []
        if config.prompt_override:
            prompt_messages.append({"role": "system", "content": config.prompt_override})
        project_message = {
            "role": "system",
            "content": (
                "Project structure context captured at startup. Use this to orient yourself before "
                f"answering the first user request:\n{project_context}"
            ),
        }
        ui.banner(
            f"Mate {mate_version()}",
            f"Workspace: {workspace_path}\nConfig: {config.mate_home}\nResources: {resource_root}\nBase URL: {base_url}\nModel: {model}\n\n"
            "Type a request, /help for commands, or exit/quit to close.",
        )
        ui.panel("Project Structure", project_context, ui.CYAN)
        return cls(
            client=client,
            model=model,
            ui=ui,
            messages=[base_system_message] + prompt_messages + [project_message],
            config=config,
        )

    def reset(self, steering_message: dict[str, str] | None = None) -> None:
        base = self.messages[0]
        project_context = tools.project_structure_summary()
        project = {
            "role": "system",
            "content": (
                "Project structure context captured at reset. Use this to orient yourself before "
                f"answering the next user request:\n{project_context}"
            ),
        }
        prompt_messages = []
        if self.config.prompt_override:
            prompt_messages.append({"role": "system", "content": self.config.prompt_override})
        self.messages = [base] + prompt_messages + [project] + ([steering_message] if steering_message else [])

    def run_turn(self, user_goal: str) -> str:
        self.messages.append({"role": "user", "content": user_goal})
        return self._run_agent_turn(user_goal)

    def _tool_message(self, tool_call: Any) -> dict[str, Any]:
        name = tool_call.function.name
        failed = False
        arguments: dict[str, Any] = {}
        try:
            arguments = _json_arguments(tool_call.function.arguments)
            self.ui.activity("Working", describe_tool_start(name, arguments), self.ui.MAGENTA)
            command = str(arguments.get("command", ""))
            requires_approval = mate_config.tool_requires_approval(self.config, name, command)
            if name == "git" and tools.git_requires_approval(command):
                requires_approval = not mate_config.tool_allowed_without_approval(self.config, name, f"git {command}")
            if requires_approval and not self._confirm_tool_execution(name, arguments):
                raise PermissionError("user denied command approval")
            with self.ui.working(describe_tool_start(name, arguments)):
                result = tools.TOOLS[name](**arguments)
        except Exception as exc:
            failed = True
            result = f"ERROR: {type(exc).__name__}: {exc}"
        detail = describe_tool_done(name, str(result), failed)
        color = self.ui.RED if failed else self.ui.GREEN
        action = tool_failed_action_name(name) if failed else tool_action_name(name)
        self.ui.activity(action, detail, color)
        return {"role": "tool", "tool_call_id": tool_call.id, "content": str(result)}

    def _confirm_tool_execution(self, name: str, arguments: dict[str, Any]) -> bool:
        if os.getenv("AGENT_AUTO_APPROVE_COMMANDS", "").lower() in {"1", "true", "yes"}:
            self.ui.success(f"You approved Mate to run `{approval_command_summary(name, arguments)}` automatically")
            return True
        summary = approval_command_summary(name, arguments)
        while True:
            answer = self.ui.transient_prompt(f"Allow Mate to run `{summary}`? [y/N] ").strip().lower()
            if answer in {"y", "yes"}:
                self.ui.success(f"You approved Mate to run `{summary}` this time")
                return True
            if answer in {"", "n", "no"}:
                self.ui.warning(f"You denied Mate permission to run `{summary}`")
                return False

    def _run_agent_until_answer(self) -> str:
        while True:
            with self.ui.working("Mate is thinking"):
                response = self._create_chat_completion_with_retry(
                    label="model request",
                    model=self.model,
                    messages=self.messages,
                    tools=tools.TOOL_DEFINITIONS,
                    tool_choice="auto",
                )
            message = response.choices[0].message
            self.messages.append(message.model_dump(exclude_none=True))

            if not message.tool_calls:
                return message.content or ""

            for tool_call in message.tool_calls:
                self.messages.append(self._tool_message(tool_call))

    def _run_agent_turn(self, user_goal: str) -> str:
        max_checks = max(0, int(os.getenv("AGENT_HARNESS_MAX_RETRIES", "2")))
        for check_number in range(max_checks + 1):
            answer = self._run_agent_until_answer()
            if check_number >= max_checks:
                return answer

            try:
                with self.ui.working("Checking result"):
                    assessment = self._assess_answer(user_goal, answer)
            except Exception as exc:
                self.ui.activity("Worked on result", f"check skipped ({type(exc).__name__}: {exc})", self.ui.YELLOW)
                return answer

            aligned = bool(assessment.get("aligned"))
            can_improve = bool(assessment.get("can_improve_with_tools"))
            reason = str(assessment.get("reason", "")).strip()
            follow_up = str(assessment.get("follow_up_prompt", "")).strip()
            if aligned:
                if reason:
                    self.ui.activity("Worked on result", reason, self.ui.CYAN)
                return answer
            if not can_improve or not follow_up:
                if reason:
                    self.ui.activity("Worked on result", reason, self.ui.YELLOW)
                return answer

            self.ui.activity("Worked on result", f"taking another pass. {reason}".strip(), self.ui.YELLOW)
            self.messages.append(
                {
                    "role": "user",
                    "content": (
                        "Result check feedback: your previous answer may not fully satisfy the user. "
                        "Use any relevant tools and improve the answer. "
                        f"Reason: {reason}\nFollow-up instruction: {follow_up}"
                    ),
                }
            )

        return answer

    def _assess_answer(self, user_goal: str, answer: str) -> dict[str, Any]:
        response = self._create_chat_completion_with_retry(
            label="result check",
            model=self.model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a strict production result checker for Mate, a terminal coding companion. "
                        "Decide whether the assistant's response satisfies the user's latest prompt. "
                        "If it falls short and tools or more inspection could help, request another pass. "
                        "Return only JSON with keys: aligned (boolean), can_improve_with_tools (boolean), "
                        "reason (short string), follow_up_prompt (string)."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"User prompt:\n{user_goal}\n\n"
                        f"Candidate response:\n{answer}\n\n"
                        "Assess whether the response is complete, directly responsive, and honest about verification."
                    ),
                },
            ],
            response_format={"type": "json_object"},
        )
        return _extract_json_object(response.choices[0].message.content or "{}")

    def _create_chat_completion_with_retry(self, label: str, **kwargs: Any) -> Any:
        max_retries = max(0, int(os.getenv("AGENT_MODEL_RATE_LIMIT_RETRIES", "2")))
        max_wait_seconds = max(0.0, float(os.getenv("AGENT_MODEL_RATE_LIMIT_MAX_WAIT_SECONDS", "60")))
        retry_long_after = os.getenv("AGENT_MODEL_RATE_LIMIT_RETRY_LONG_AFTER", "").lower() in {"1", "true", "yes"}
        retry_started = time.monotonic()
        for attempt in range(max_retries + 1):
            try:
                return self.client.chat.completions.create(**kwargs)
            except RateLimitError as exc:
                headers = _response_headers(exc)
                status_code = _rate_limit_status(exc)
                if status_code is None and not headers:
                    self.ui.activity(
                        "Rate limited",
                        f"{label}; no HTTP response details, not retrying",
                        self.ui.YELLOW,
                    )
                    raise
                if attempt >= max_retries:
                    raise
                header_delay = _rate_limit_header_delay(exc)
                delay = _rate_limit_retry_delay(exc, attempt)
                elapsed = time.monotonic() - retry_started
                remaining_budget = max(0.0, max_wait_seconds - elapsed)
                budget_delay = header_delay if header_delay is not None else delay
                if elapsed + budget_delay > max_wait_seconds and not retry_long_after:
                    self.ui.activity(
                        "Rate limited",
                        (
                            f"{label}; retry-after exceeds local budget "
                            f"({self.ui.format_duration(budget_delay)} > {self.ui.format_duration(remaining_budget)})"
                        ),
                        self.ui.YELLOW,
                    )
                    raise
                self.ui.activity(
                    "Rate limited",
                    f"{label}; retrying in {self.ui.format_duration(delay)}",
                    self.ui.YELLOW,
                )
                time.sleep(delay)
        raise RuntimeError("unreachable rate-limit retry state")


def _extract_json_object(value: str) -> dict[str, Any]:
    text = value.strip()
    if text.startswith("```"):
        lines = [line for line in text.splitlines() if not line.strip().startswith("```")]
        text = "\n".join(lines).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError("no JSON object found")
    parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("assessment was not a JSON object")
    return parsed


def _input_with_ui(ui: Any, prompt: str, secret: bool, default: str | None) -> str:
    rows = [prompt.strip() or "Input required"]
    if default is not None and not secret:
        rows.append(f"Default: {default}")
    ui.panel("Input Required", "\n".join(rows), ui.YELLOW)
    return ui.prompt("Enter value: ", secret=secret)
