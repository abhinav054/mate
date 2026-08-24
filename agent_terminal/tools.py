from __future__ import annotations

import difflib
import errno
import fcntl
import json
import os
import pty
import select
import shlex
import shutil
import signal
import subprocess
import termios
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

MAX_TOOL_OUTPUT_CHARS = 16_000
DEFAULT_RESOURCE_DIR = Path(__file__).resolve().parents[1] / "agent_resources"
WORKSPACE_SERVERS_FILE = Path(".codex") / "workspace-servers.jsonl"
TODO_ITEMS: list[dict[str, str]] = []
STEERING_PROMPTS: list[str] = []
BACKGROUND_PROCESSES: dict[str, dict[str, Any]] = {}
BACKGROUND_LOCK = threading.Lock()
APPROVAL_REQUIRED_TOOLS = {"run_command", "start_background_process"}
ACTIVE_WORKSPACE = Path.cwd().resolve()
BASH_EXECUTABLE = shutil.which("bash") or "/bin/bash"
GIT_MUTATING_COMMANDS = {
    "add",
    "am",
    "apply",
    "bisect",
    "checkout",
    "cherry-pick",
    "clean",
    "commit",
    "merge",
    "mv",
    "pull",
    "push",
    "rebase",
    "reset",
    "restore",
    "revert",
    "rm",
    "stash",
    "switch",
    "tag",
}


def _workspace() -> Path:
    return ACTIVE_WORKSPACE


def _set_workspace(path: str | os.PathLike[str]) -> Path:
    global ACTIVE_WORKSPACE
    workspace = Path(path).expanduser().resolve()
    if not workspace.exists():
        raise FileNotFoundError(f"workspace does not exist: {workspace}")
    if not workspace.is_dir():
        raise NotADirectoryError(f"workspace is not a directory: {workspace}")
    ACTIVE_WORKSPACE = workspace
    return ACTIVE_WORKSPACE


def set_workspace(path: str | os.PathLike[str]) -> Path:
    return _set_workspace(path)


def _resolve_in_workspace(path: str | None) -> Path:
    root = _workspace()
    target = root if not path else (root / path).resolve()
    if target != root and root not in target.parents:
        raise ValueError(f"path escapes workspace: {path}")
    return target


def _resource_root() -> Path:
    configured = os.getenv("AGENT_RESOURCES_DIR")
    return Path(configured).expanduser().resolve() if configured else DEFAULT_RESOURCE_DIR.resolve()


def resource_root() -> Path:
    return _resource_root()


def _mate_home() -> Path:
    configured = os.getenv("MATE_HOME")
    return Path(configured).expanduser().resolve() if configured else (Path.home() / ".mate").resolve()


def _local_skills_root() -> Path:
    return _mate_home() / "skills"


def _resolve_in_resources(path: str | None) -> Path:
    root = _resource_root()
    target = root if not path else (root / path).resolve()
    if target != root and root not in target.parents:
        raise ValueError(f"path escapes agent resources: {path}")
    return target


def _trim_output(value: str) -> str:
    if len(value) <= MAX_TOOL_OUTPUT_CHARS:
        return value
    return value[:MAX_TOOL_OUTPUT_CHARS] + "\n...[trimmed]"


def _append_background_output(process_id: str, stream: Any, stream_name: str) -> None:
    for line in iter(stream.readline, ""):
        with BACKGROUND_LOCK:
            entry = BACKGROUND_PROCESSES.get(process_id)
            if not entry:
                break
            entry["output"].append(f"[{stream_name}] {line.rstrip()}")
            entry["output"] = entry["output"][-600:]
    stream.close()


def _append_background_pty_output(process_id: str, master_fd: int) -> None:
    pending = ""
    while True:
        try:
            readable, _, _ = select.select([master_fd], [], [], 0.2)
            if not readable:
                with BACKGROUND_LOCK:
                    entry = BACKGROUND_PROCESSES.get(process_id)
                    process = entry["process"] if entry else None
                if not entry or process.poll() is not None:
                    break
                continue
            chunk = os.read(master_fd, 4096)
        except OSError as exc:
            if exc.errno in {errno.EIO, errno.EBADF}:
                break
            raise
        if not chunk:
            break
        pending += chunk.decode(errors="replace")
        lines = pending.splitlines(keepends=True)
        if lines and not lines[-1].endswith(("\n", "\r")):
            pending = lines.pop()
        else:
            pending = ""
        if not lines:
            continue
        with BACKGROUND_LOCK:
            entry = BACKGROUND_PROCESSES.get(process_id)
            if not entry:
                break
            for line in lines:
                entry["output"].append(f"[pty] {line.rstrip()}")
            entry["output"] = entry["output"][-600:]
    if pending:
        with BACKGROUND_LOCK:
            entry = BACKGROUND_PROCESSES.get(process_id)
            if entry:
                entry["output"].append(f"[pty] {pending.rstrip()}")
                entry["output"] = entry["output"][-600:]


def _make_controlling_terminal(slave_fd: int) -> Callable[[], None]:
    def configure_child() -> None:
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        os.tcsetpgrp(slave_fd, os.getpgrp())

    return configure_child


def _process_tty_status(pid: int) -> str:
    stat_path = Path(f"/proc/{pid}/stat")
    try:
        stat = stat_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return "tty=? tpgid=?"
    fields = stat.rsplit(") ", 1)[1].split()
    try:
        tty_nr = int(fields[4])
        tpgid = int(fields[5])
    except (IndexError, ValueError):
        return "tty=? tpgid=?"
    tty_name = "?"
    fd_path = Path(f"/proc/{pid}/fd/0")
    try:
        target = os.readlink(fd_path)
    except OSError:
        target = ""
    if target.startswith("/dev/"):
        tty_name = target.removeprefix("/dev/")
    elif tty_nr > 0:
        tty_name = str(tty_nr)
    return f"tty={tty_name} tpgid={tpgid}"


def _background_entry(process_id: str) -> dict[str, Any]:
    with BACKGROUND_LOCK:
        entry = BACKGROUND_PROCESSES.get(process_id)
    if not entry:
        raise KeyError(f"background process not found: {process_id}")
    return entry


def _looks_like_server_command(command: str) -> bool:
    """Return true for common long-running app/server launch commands."""
    lowered = f" {command.strip().lower()} "
    server_markers = [
        " npm run dev",
        " npm start",
        " npm run start",
        " npm run serve",
        " pnpm dev",
        " pnpm start",
        " pnpm serve",
        " yarn dev",
        " yarn start",
        " yarn serve",
        " bun dev",
        " bun start",
        " bun serve",
        " vite",
        " next dev",
        " next start",
        " flask run",
        " fastapi run",
        " uvicorn ",
        " gunicorn ",
        " hypercorn ",
        " python -m http.server",
        " python3 -m http.server",
        " django-admin runserver",
        " manage.py runserver",
        " rails server",
        " rails s",
        " ruby app.rb",
        " go run ",
        " cargo run",
        " dotnet run",
        " php artisan serve",
        " php -s ",
    ]
    return any(marker in lowered for marker in server_markers)


def record_workspace_server(command: str, cwd: str = ".", reason: str = "server command detected") -> str:
    """Append a workspace server launch record for an external service manager."""
    workdir = _resolve_in_workspace(cwd)
    if not workdir.is_dir():
        raise NotADirectoryError(f"cwd is not a directory: {cwd}")

    record_path = _workspace() / WORKSPACE_SERVERS_FILE
    record_path.parent.mkdir(parents=True, exist_ok=True)
    relative_cwd = "." if workdir == _workspace() else str(workdir.relative_to(_workspace()))
    record = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "workspace": str(_workspace()),
        "cwd": relative_cwd,
        "command": command,
        "reason": reason,
    }
    with record_path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(record, sort_keys=True) + "\n")
    return f"recorded {record_path.relative_to(_workspace())}"


def _preview(value: str, limit: int = 900) -> str:
    value = value.strip()
    if not value:
        return "(no output)"
    return value if len(value) <= limit else value[:limit].rstrip() + "\n...[preview trimmed]"


def _read_text_file(path: Path) -> str:
    return _trim_output(path.read_text(encoding="utf-8", errors="replace"))


def _format_file_diff(path: Path, before: str, after: str) -> str:
    relative = path.relative_to(_workspace())
    diff = difflib.unified_diff(
        before.splitlines(),
        after.splitlines(),
        fromfile=f"a/{relative}",
        tofile=f"b/{relative}",
        lineterm="",
        n=3,
    )
    text = "\n".join(diff)
    return _trim_output(text) if text else "(no textual changes)"


DIFF_HANDLER = None
INPUT_HANDLER = None


def set_tool_ui(diff_handler=None, input_handler=None) -> None:
    global DIFF_HANDLER, INPUT_HANDLER
    DIFF_HANDLER = diff_handler
    INPUT_HANDLER = input_handler


def _show_file_diff(path: Path, before: str, after: str) -> None:
    diff = _format_file_diff(path, before, after)
    if DIFF_HANDLER:
        DIFF_HANDLER(diff)


def _project_structure_summary(max_entries: int = 80) -> str:
    root = _workspace()
    rows = [f"Workspace: {root}"]
    marker_names = {
        "pyproject.toml",
        "package.json",
        "Cargo.toml",
        "go.mod",
        "pom.xml",
        "build.gradle",
        "Makefile",
        "README.md",
        ".git",
    }
    markers = [name for name in sorted(marker_names) if (root / name).exists()]
    rows.append("Markers: " + (", ".join(markers) if markers else "(none found)"))
    rows.append("")
    rows.append("Top-level entries:")
    try:
        children = sorted(root.iterdir(), key=lambda item: (item.is_file(), item.name.lower()))
    except OSError as exc:
        return f"Could not inspect workspace: {type(exc).__name__}: {exc}"
    visible_children = [child for child in children if child.name not in {".git", "__pycache__"}]
    for child in visible_children[:max_entries]:
        suffix = "/" if child.is_dir() else ""
        rows.append(f"- {child.name}{suffix}")
    if len(visible_children) > max_entries:
        rows.append(f"- ... {len(visible_children) - max_entries} more")

    if (root / ".git").exists() and shutil.which("git"):
        result = subprocess.run(
            ["git", "status", "--short"],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        status = result.stdout.strip() if result.returncode == 0 else result.stderr.strip()
        rows.append("")
        rows.append("Git status:")
        rows.append(status or "(clean)")
    return _trim_output("\n".join(rows))


def project_structure_summary(max_entries: int = 80) -> str:
    return _project_structure_summary(max_entries=max_entries)


def _json_arguments(value: str | None) -> dict[str, Any]:
    parsed = json.loads(value or "{}")
    if not isinstance(parsed, dict):
        raise ValueError("tool arguments must be a JSON object")
    return parsed


def _git_args(command: str) -> list[str]:
    args = shlex.split(command)
    if not args:
        raise ValueError("git command is required")
    blocked = {"-C", "--git-dir", "--work-tree", "--exec-path"}
    for arg in args:
        if arg in blocked or any(arg.startswith(f"{item}=") for item in blocked):
            raise ValueError(f"git argument is not allowed: {arg}")
    return args


def _git_requires_approval(command: str) -> bool:
    try:
        args = _git_args(command)
    except Exception:
        return True
    subcommand = next((arg for arg in args if not arg.startswith("-")), "")
    return subcommand in GIT_MUTATING_COMMANDS


def git_requires_approval(command: str) -> bool:
    return _git_requires_approval(command)


def git(command: str, cwd: str = ".", max_time_seconds: int = 30) -> str:
    """Run a constrained git command inside the workspace."""
    workdir = _resolve_in_workspace(cwd)
    if not workdir.is_dir():
        raise NotADirectoryError(f"cwd is not a directory: {cwd}")
    if not shutil.which("git"):
        raise FileNotFoundError("git is not installed")

    timeout = max(1, min(int(max_time_seconds), 120))
    result = subprocess.run(
        ["git", *_git_args(command)],
        cwd=workdir,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    output = ""
    if result.stdout:
        output += result.stdout
    if result.stderr:
        output += ("\n" if output else "") + result.stderr
    if not output:
        output = f"(git exited {result.returncode} with no output)"
    else:
        output += f"\n\n[exit_code={result.returncode}]"
    return _trim_output(output)


def request_user_input(prompt: str, secret: bool = False, default: str | None = None) -> str:
    """Ask the terminal user for required information before continuing."""
    if INPUT_HANDLER:
        value = INPUT_HANDLER(prompt, secret, default)
    else:
        value = input("Enter value: ")
    if not value and default is not None:
        value = default
    if not value:
        return "(no input provided)"
    return value


def browse_internet(url: str, max_time_seconds: int = 20) -> str:
    """Fetch a URL using curl and return response text."""
    if not url.startswith(("http://", "https://")):
        raise ValueError("url must start with http:// or https://")

    timeout = max(1, min(int(max_time_seconds), 60))
    result = subprocess.run(
        [
            "curl",
            "--location",
            "--silent",
            "--show-error",
            "--max-time",
            str(timeout),
            url,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    output = result.stdout if result.stdout else result.stderr
    return _trim_output(output)


def list_files(path: str = ".") -> str:
    """List files under a workspace path."""
    target = _resolve_in_workspace(path)
    if not target.exists():
        raise FileNotFoundError(f"path does not exist: {path}")

    if target.is_file():
        return str(target.relative_to(_workspace()))

    rows: list[str] = []
    for child in sorted(target.iterdir(), key=lambda item: (item.is_file(), item.name.lower())):
        suffix = "/" if child.is_dir() else ""
        rows.append(f"{child.relative_to(_workspace())}{suffix}")
    return "\n".join(rows) if rows else "(empty)"


def glob_files(pattern: str, path: str = ".") -> str:
    """Find files under the workspace with a glob pattern."""
    target = _resolve_in_workspace(path)
    if not target.exists():
        raise FileNotFoundError(f"path does not exist: {path}")

    base = target if target.is_dir() else target.parent
    matches = sorted(
        item.relative_to(_workspace())
        for item in base.glob(pattern)
        if item.exists() and ".git" not in item.parts
    )
    return "\n".join(str(match) for match in matches) if matches else "no matches"


def read_file(path: str) -> str:
    """Read a text file inside the workspace."""
    target = _resolve_in_workspace(path)
    if not target.is_file():
        raise FileNotFoundError(f"file does not exist: {path}")
    return _read_text_file(target)


def touch_file(path: str) -> str:
    """Create a file or update its modified timestamp inside the workspace."""
    target = _resolve_in_workspace(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.touch()
    return f"touched {target.relative_to(_workspace())}"


def write_file(path: str, content: str, append: bool = False) -> str:
    """Write or append text to a file inside the workspace."""
    target = _resolve_in_workspace(path)
    before = target.read_text(encoding="utf-8", errors="replace") if target.exists() else ""
    target.parent.mkdir(parents=True, exist_ok=True)
    mode = "a" if append else "w"
    with target.open(mode, encoding="utf-8") as file:
        file.write(content)
    after = target.read_text(encoding="utf-8", errors="replace")
    _show_file_diff(target, before, after)
    action = "appended to" if append else "wrote"
    return f"{action} {target.relative_to(_workspace())}"


def edit_file(path: str, old_text: str, new_text: str, replace_all: bool = False) -> str:
    """Replace text in an existing workspace file."""
    target = _resolve_in_workspace(path)
    if not target.is_file():
        raise FileNotFoundError(f"file does not exist: {path}")
    text = target.read_text(encoding="utf-8", errors="replace")
    count = text.count(old_text)
    if count == 0:
        raise ValueError("old_text was not found")
    if count > 1 and not replace_all:
        raise ValueError(f"old_text matched {count} times; set replace_all=true or make it unique")
    updated = text.replace(old_text, new_text) if replace_all else text.replace(old_text, new_text, 1)
    target.write_text(updated, encoding="utf-8")
    _show_file_diff(target, text, updated)
    return f"edited {target.relative_to(_workspace())}; replacements={count if replace_all else 1}"


def run_command(command: str, cwd: str = ".", max_time_seconds: int = 30) -> str:
    """Run a shell command inside the workspace and return stdout/stderr."""
    workdir = _resolve_in_workspace(cwd)
    if not workdir.is_dir():
        raise NotADirectoryError(f"cwd is not a directory: {cwd}")

    timeout = max(1, min(int(max_time_seconds), 120))
    recorded: str | None = None
    is_server_command = _looks_like_server_command(command)
    if is_server_command:
        recorded = record_workspace_server(command, cwd)

    try:
        result = subprocess.run(
            command,
            cwd=workdir,
            shell=True,
            executable=BASH_EXECUTABLE,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        if is_server_command and not recorded:
            recorded = record_workspace_server(command, cwd, reason=f"command exceeded {timeout}s timeout")
        output = ""
        if exc.stdout:
            output += exc.stdout if isinstance(exc.stdout, str) else exc.stdout.decode(errors="replace")
        if exc.stderr:
            stderr = exc.stderr if isinstance(exc.stderr, str) else exc.stderr.decode(errors="replace")
            output += ("\n" if output else "") + stderr
        if output:
            output += f"\n\n[timeout_seconds={timeout}]"
        else:
            output = f"(command exceeded {timeout}s timeout)"
        if recorded:
            output += f"\n[workspace_server_recorded={WORKSPACE_SERVERS_FILE}]"
        return _trim_output(output)
    output = ""
    if result.stdout:
        output += result.stdout
    if result.stderr:
        output += ("\n" if output else "") + result.stderr
    if not output:
        output = f"(command exited {result.returncode} with no output)"
    else:
        output += f"\n\n[exit_code={result.returncode}]"
    if recorded:
        output += f"\n[workspace_server_recorded={WORKSPACE_SERVERS_FILE}]"
    return _trim_output(output)


def start_background_process(command: str, cwd: str = ".", process_id: str | None = None) -> str:
    """Start a long-running shell command inside the workspace."""
    workdir = _resolve_in_workspace(cwd)
    if not workdir.is_dir():
        raise NotADirectoryError(f"cwd is not a directory: {cwd}")

    normalized_id = (process_id or "").strip()
    if not normalized_id:
        normalized_id = f"bg-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}"
    with BACKGROUND_LOCK:
        if normalized_id in BACKGROUND_PROCESSES:
            raise ValueError(f"background process already exists: {normalized_id}")

    if _looks_like_server_command(command):
        record_workspace_server(command, cwd)

    master_fd, slave_fd = pty.openpty()
    try:
        process = subprocess.Popen(
            command,
            cwd=workdir,
            shell=True,
            executable=BASH_EXECUTABLE,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            text=False,
            preexec_fn=_make_controlling_terminal(slave_fd),
            close_fds=True,
            bufsize=0,
        )
        try:
            os.tcsetpgrp(master_fd, process.pid)
        except OSError:
            pass
    finally:
        os.close(slave_fd)
    entry = {
        "command": command,
        "cwd": "." if workdir == _workspace() else str(workdir.relative_to(_workspace())),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "process": process,
        "pty_master_fd": master_fd,
        "output": [],
    }
    with BACKGROUND_LOCK:
        BACKGROUND_PROCESSES[normalized_id] = entry

    threading.Thread(
        target=_append_background_pty_output,
        args=(normalized_id, master_fd),
        daemon=True,
    ).start()
    return (
        f"started {normalized_id} pid={process.pid}\n"
        f"To read stdout/stderr, call read_background_process with process_id={normalized_id}."
    )


def list_background_processes() -> str:
    """List background processes started by this agent session."""
    rows: list[str] = []
    with BACKGROUND_LOCK:
        items = list(BACKGROUND_PROCESSES.items())
    for process_id, entry in items:
        process = entry["process"]
        return_code = process.poll()
        status = "running" if return_code is None else f"exited({return_code})"
        tty_status = _process_tty_status(process.pid)
        rows.append(
            f"{process_id}\t{status}\tpid={process.pid}\t{tty_status}\tcwd={entry['cwd']}\t{entry['command']}"
        )
    return "\n".join(rows) if rows else "(empty)"


def read_background_process(process_id: str, max_lines: int = 120) -> str:
    """Read recent output for a background process."""
    entry = _background_entry(process_id)
    process = entry["process"]
    line_limit = max(1, min(int(max_lines), 600))
    with BACKGROUND_LOCK:
        output = list(entry["output"][-line_limit:])
    status = "running" if process.poll() is None else f"exited({process.returncode})"
    header = f"{process_id} {status} pid={process.pid}"
    body = "\n".join(output) if output else "(no output captured yet)"
    return _trim_output(f"{header}\n{body}")


def write_background_process(process_id: str, input_text: str) -> str:
    """Write text to a background process PTY."""
    entry = _background_entry(process_id)
    process = entry["process"]
    if process.poll() is not None:
        return f"{process_id} already exited with code {process.returncode}"
    master_fd = entry.get("pty_master_fd")
    if master_fd is None:
        raise ValueError(f"background process does not have a writable pty: {process_id}")
    os.write(master_fd, input_text.encode())
    return f"wrote {len(input_text)} chars to {process_id}"


def stop_background_process(process_id: str, signal_name: str = "TERM") -> str:
    """Stop a background process by process id."""
    entry = _background_entry(process_id)
    process = entry["process"]
    if process.poll() is not None:
        return f"{process_id} already exited with code {process.returncode}"

    normalized = signal_name.upper().removeprefix("SIG")
    if normalized not in {"TERM", "INT", "KILL"}:
        raise ValueError("signal_name must be TERM, INT, or KILL")
    sig = {"TERM": signal.SIGTERM, "INT": signal.SIGINT, "KILL": signal.SIGKILL}[normalized]
    os.killpg(process.pid, sig)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        return f"sent SIG{normalized} to {process_id}; process is still running"
    master_fd = entry.get("pty_master_fd")
    if master_fd is not None:
        try:
            os.close(master_fd)
        except OSError:
            pass
    return f"sent SIG{normalized} to {process_id}; exited with code {process.returncode}"


def check_system_tools() -> str:
    """Report availability of external CLIs used by copied agent resources."""
    required = ["bash", "python3", "git", "rg", "curl"]
    optional = ["gh", "jq", "node", "npm", "npx", "perl", "sed", "awk"]
    rows = ["Required:"]
    for name in required:
        found = shutil.which(name)
        rows.append(f"- {name}: {found or 'MISSING'}")
    rows.append("")
    rows.append("Optional/plugin-specific:")
    for name in optional:
        found = shutil.which(name)
        rows.append(f"- {name}: {found or 'missing'}")
    rows.append("")
    rows.append("Notes:")
    rows.append("- GitHub PR/commit plugins need gh authenticated with GitHub.")
    rows.append("- Ralph Wiggum hooks need jq for transcript parsing.")
    rows.append("- Agent SDK plugin workflows may need node/npm/npx or pip, depending on language.")
    rows.append("- Security hooks may install their Python SDK into a user venv when run.")
    return "\n".join(rows)


def search_files(query: str, path: str = ".") -> str:
    """Search file names and text content inside the workspace."""
    target = _resolve_in_workspace(path)
    if not target.exists():
        raise FileNotFoundError(f"path does not exist: {path}")

    command = ["rg", "--line-number", "--hidden", "--glob", "!.git", query, str(target)]
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
    except FileNotFoundError:
        return _search_files_without_rg(query, target)
    if result.returncode == 0:
        return _trim_output(result.stdout)
    if result.returncode == 1:
        return "no matches"

    fallback = _search_files_without_rg(query, target)
    return fallback if fallback else _trim_output(result.stderr)


def _search_files_without_rg(query: str, target: Path) -> str:
    matches: list[str] = []
    files = [target] if target.is_file() else [item for item in target.rglob("*") if item.is_file()]
    for file_path in files:
        if ".git" in file_path.parts:
            continue
        try:
            text = file_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for line_number, line in enumerate(text.splitlines(), start=1):
            if query in line:
                relative = file_path.relative_to(_workspace())
                matches.append(f"{relative}:{line_number}:{line}")
    return _trim_output("\n".join(matches)) if matches else "no matches"


def list_agent_resources(kind: str = "all") -> str:
    """List copied agent agents, skills, commands, hooks, or plugins."""
    allowed = {"all", "agents", "skills", "commands", "hooks", "plugins"}
    if kind not in allowed:
        raise ValueError(f"kind must be one of: {', '.join(sorted(allowed))}")

    root = _resource_root()
    if not root.exists():
        return f"No resource directory found at {root}"

    if kind == "plugins":
        plugins_root = root / "mate-plugins"
        if not plugins_root.exists():
            return "No copied plugin directory found."
        rows = [path.name for path in sorted(plugins_root.iterdir()) if path.is_dir()]
        return "\n".join(rows) if rows else "(empty)"

    kinds = ["agents", "skills", "commands", "hooks"] if kind == "all" else [kind]
    sections: list[str] = []
    for item in kinds:
        index_path = root / "index" / f"{item}.txt"
        if index_path.exists():
            content = _read_text_file(index_path)
        else:
            content = "(missing index)"
        if item == "skills":
            local_skills = [
                str(path.relative_to(_local_skills_root()))
                for path in sorted(_local_skills_root().glob("*/SKILL.md"))
            ]
            if local_skills:
                content = content + "\n\n[local .mate/skills]\n" + "\n".join(local_skills)
        sections.append(f"[{item}]\n{content}")
    return "\n\n".join(sections)


def read_agent_resource(path: str) -> str:
    """Read a copied agent resource by relative path."""
    target = _resolve_in_resources(path)
    if target.is_dir():
        rows = [str(child.relative_to(_resource_root())) for child in sorted(target.iterdir())]
        return "\n".join(rows) if rows else "(empty)"
    if not target.is_file():
        raise FileNotFoundError(f"resource does not exist: {path}")
    return _read_text_file(target)


def load_command(command_name: str) -> str:
    """Load a copied slash-command prompt by command name, with or without a slash."""
    normalized = command_name.strip().lstrip("/")
    if not normalized:
        raise ValueError("command_name is required")
    index_path = _resource_root() / "index" / "commands.txt"
    if not index_path.exists():
        raise FileNotFoundError("commands index is missing")
    matches = [
        line.strip()
        for line in index_path.read_text(encoding="utf-8", errors="replace").splitlines()
        if line.strip().endswith(f"/{normalized}.md")
    ]
    if not matches:
        raise FileNotFoundError(f"command not found: {command_name}")
    if len(matches) > 1:
        return "Multiple commands matched:\n" + "\n".join(matches)
    return read_agent_resource(f"mate-plugins/{matches[0]}")


def load_skill(skill_name: str) -> str:
    """Load a local or copied SKILL.md by skill directory name."""
    normalized = skill_name.strip()
    if not normalized:
        raise ValueError("skill_name is required")
    local_skill = _local_skills_root() / normalized / "SKILL.md"
    if local_skill.is_file():
        return _read_text_file(local_skill)
    index_path = _resource_root() / "index" / "skills.txt"
    if not index_path.exists():
        raise FileNotFoundError("skills index is missing")
    matches = [
        line.strip()
        for line in index_path.read_text(encoding="utf-8", errors="replace").splitlines()
        if f"/skills/{normalized}/SKILL.md" in line.strip()
    ]
    if not matches:
        raise FileNotFoundError(f"skill not found: {skill_name}")
    if len(matches) > 1:
        return "Multiple skills matched:\n" + "\n".join(matches)
    return read_agent_resource(f"mate-plugins/{matches[0]}")


def load_agent_prompt(agent_name: str) -> str:
    """Load a copied sub-agent prompt by file name."""
    normalized = agent_name.strip().removesuffix(".md")
    if not normalized:
        raise ValueError("agent_name is required")
    index_path = _resource_root() / "index" / "agents.txt"
    if not index_path.exists():
        raise FileNotFoundError("agents index is missing")
    matches = [
        line.strip()
        for line in index_path.read_text(encoding="utf-8", errors="replace").splitlines()
        if line.strip().endswith(f"/{normalized}.md")
    ]
    if not matches:
        raise FileNotFoundError(f"agent prompt not found: {agent_name}")
    if len(matches) > 1:
        return "Multiple agent prompts matched:\n" + "\n".join(matches)
    return read_agent_resource(f"mate-plugins/{matches[0]}")


def update_todos(items_json: str) -> str:
    """Replace the in-session todo list with JSON items containing content and status."""
    parsed = json.loads(items_json)
    if not isinstance(parsed, list):
        raise ValueError("items_json must be a JSON array")
    items: list[dict[str, str]] = []
    for item in parsed:
        if not isinstance(item, dict):
            raise ValueError("each todo item must be an object")
        content = str(item.get("content", "")).strip()
        status = str(item.get("status", "pending")).strip()
        if not content:
            raise ValueError("todo content is required")
        if status not in {"pending", "in_progress", "completed"}:
            raise ValueError("todo status must be pending, in_progress, or completed")
        items.append({"content": content, "status": status})
    TODO_ITEMS[:] = items
    rows = [f"- [{item['status']}] {item['content']}" for item in TODO_ITEMS]
    return "\n".join(rows) if rows else "(empty)"


def run_plugin_hook(plugin_name: str, hook_command: str, input_json: str = "{}", max_time_seconds: int = 30) -> str:
    """Run a copied plugin hook command with MATE_PLUGIN_ROOT set."""
    plugin_root = _resolve_in_resources(f"mate-plugins/{plugin_name}")
    if not plugin_root.is_dir():
        raise FileNotFoundError(f"plugin not found: {plugin_name}")

    timeout = max(1, min(int(max_time_seconds), 180))
    env = os.environ.copy()
    env["MATE_PLUGIN_ROOT"] = str(plugin_root)
    env["PYTHONPATH"] = f"{plugin_root.parent}:{plugin_root}:{env.get('PYTHONPATH', '')}"
    result = subprocess.run(
        hook_command,
        cwd=_workspace(),
        shell=True,
        executable=BASH_EXECUTABLE,
        input=input_json,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        env=env,
    )
    output = ""
    if result.stdout:
        output += result.stdout
    if result.stderr:
        output += ("\n" if output else "") + result.stderr
    if not output:
        output = f"(hook exited {result.returncode} with no output)"
    else:
        output += f"\n\n[exit_code={result.returncode}]"
    return _trim_output(output)


TOOLS: dict[str, Callable[..., str]] = {
    "browse_internet": browse_internet,
    "check_system_tools": check_system_tools,
    "list_files": list_files,
    "glob_files": glob_files,
    "git": git,
    "read_file": read_file,
    "touch_file": touch_file,
    "write_file": write_file,
    "edit_file": edit_file,
    "record_workspace_server": record_workspace_server,
    "run_command": run_command,
    "start_background_process": start_background_process,
    "list_background_processes": list_background_processes,
    "read_background_process": read_background_process,
    "write_background_process": write_background_process,
    "stop_background_process": stop_background_process,
    "request_user_input": request_user_input,
    "search_files": search_files,
    "list_agent_resources": list_agent_resources,
    "read_agent_resource": read_agent_resource,
    "load_command": load_command,
    "load_skill": load_skill,
    "load_agent_prompt": load_agent_prompt,
    "update_todos": update_todos,
    "run_plugin_hook": run_plugin_hook,
}


TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "browse_internet",
            "description": "Browse the internet by fetching a URL with curl.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "HTTP or HTTPS URL to fetch."},
                    "max_time_seconds": {
                        "type": "integer",
                        "description": "Curl timeout between 1 and 60 seconds.",
                        "default": 20,
                    },
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_system_tools",
            "description": "Check whether external CLIs used by copied agent plugins are installed.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "List files in a folder under the current workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path to list.", "default": "."}
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "glob_files",
            "description": "Find files under the workspace with a glob pattern.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Glob pattern, for example '**/*.py'."},
                    "path": {"type": "string", "description": "Relative base path.", "default": "."},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "git",
            "description": (
                "Run a constrained git command inside the current workspace. Use for status, diff, log, "
                "branch, show, add, commit, restore, and other git operations. Mutating git commands "
                "require terminal user approval."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "Git arguments without the leading 'git', for example 'status --short' or 'diff -- README.md'.",
                    },
                    "cwd": {"type": "string", "description": "Relative working directory.", "default": "."},
                    "max_time_seconds": {
                        "type": "integer",
                        "description": "Timeout between 1 and 120 seconds.",
                        "default": 30,
                    },
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a text file under the current workspace.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Relative file path."}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "Replace text in an existing workspace file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative file path."},
                    "old_text": {"type": "string", "description": "Text to replace."},
                    "new_text": {"type": "string", "description": "Replacement text."},
                    "replace_all": {
                        "type": "boolean",
                        "description": "Replace all occurrences instead of requiring a unique match.",
                        "default": False,
                    },
                },
                "required": ["path", "old_text", "new_text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "touch_file",
            "description": "Create a file or update its modified timestamp.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Relative file path."}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write or append text to a file in the current workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative file path."},
                    "content": {"type": "string", "description": "Text content to write."},
                    "append": {
                        "type": "boolean",
                        "description": "Append instead of overwriting when true.",
                        "default": False,
                    },
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_todos",
            "description": "Set the in-session todo list, similar to agent TodoWrite.",
            "parameters": {
                "type": "object",
                "properties": {
                    "items_json": {
                        "type": "string",
                        "description": "JSON array of objects with content and status fields.",
                    }
                },
                "required": ["items_json"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": "Run a shell command inside the current workspace. Requires terminal user approval.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command to run."},
                    "cwd": {"type": "string", "description": "Relative working directory.", "default": "."},
                    "max_time_seconds": {
                        "type": "integer",
                        "description": "Timeout between 1 and 120 seconds.",
                        "default": 30,
                    },
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "start_background_process",
            "description": (
                "Start a long-running shell command inside the current workspace and capture its output. "
                "Requires terminal user approval. Use for dev servers, watchers, and other processes "
                "that should keep running while the agent continues."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command to start."},
                    "cwd": {"type": "string", "description": "Relative working directory.", "default": "."},
                    "process_id": {
                        "type": "string",
                        "description": "Optional stable id for this process, for example dev-server.",
                    },
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_background_processes",
            "description": "List background processes started during this agent session.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_background_process",
            "description": "Read recent captured output from a background process.",
            "parameters": {
                "type": "object",
                "properties": {
                    "process_id": {"type": "string", "description": "Background process id."},
                    "max_lines": {
                        "type": "integer",
                        "description": "Recent output lines to return, between 1 and 600.",
                        "default": 120,
                    },
                },
                "required": ["process_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_background_process",
            "description": "Write text to a running background process PTY.",
            "parameters": {
                "type": "object",
                "properties": {
                    "process_id": {"type": "string", "description": "Background process id."},
                    "input_text": {
                        "type": "string",
                        "description": "Text to send to the process. Include a newline when submitting a command.",
                    },
                },
                "required": ["process_id", "input_text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "stop_background_process",
            "description": "Stop a background process started during this agent session.",
            "parameters": {
                "type": "object",
                "properties": {
                    "process_id": {"type": "string", "description": "Background process id."},
                    "signal_name": {
                        "type": "string",
                        "enum": ["TERM", "INT", "KILL"],
                        "description": "Signal to send.",
                        "default": "TERM",
                    },
                },
                "required": ["process_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "request_user_input",
            "description": (
                "Ask the terminal user for information needed to continue, such as database URLs, "
                "API keys, credentials, deployment choices, or missing requirements. Use secret=true "
                "for sensitive values so the terminal does not echo them."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "Clear question or instruction for the user."},
                    "secret": {
                        "type": "boolean",
                        "description": "Hide typed input for secrets like passwords, tokens, keys, and credentials.",
                        "default": False,
                    },
                    "default": {
                        "type": "string",
                        "description": "Optional default to use when the user presses Enter.",
                    },
                },
                "required": ["prompt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "record_workspace_server",
            "description": (
                "Record a workspace server launch command in .codex/workspace-servers.jsonl "
                "so an external service manager can create a service for it."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command that starts the server."},
                    "cwd": {"type": "string", "description": "Relative working directory.", "default": "."},
                    "reason": {
                        "type": "string",
                        "description": "Why this command should be treated as a workspace server.",
                        "default": "server command detected",
                    },
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "load_command",
            "description": "Load a copied agent slash-command prompt by name.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command_name": {
                        "type": "string",
                        "description": "Command name with or without slash, for example feature-dev.",
                    }
                },
                "required": ["command_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "load_skill",
            "description": "Load a copied agent SKILL.md by skill name.",
            "parameters": {
                "type": "object",
                "properties": {"skill_name": {"type": "string", "description": "Skill directory name."}},
                "required": ["skill_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "load_agent_prompt",
            "description": "Load a copied agent sub-agent prompt by agent file name.",
            "parameters": {
                "type": "object",
                "properties": {"agent_name": {"type": "string", "description": "Agent name, for example code-reviewer."}},
                "required": ["agent_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_plugin_hook",
            "description": "Run a copied plugin hook command with MATE_PLUGIN_ROOT and PYTHONPATH configured.",
            "parameters": {
                "type": "object",
                "properties": {
                    "plugin_name": {"type": "string", "description": "Copied plugin directory name."},
                    "hook_command": {"type": "string", "description": "Hook shell command to run."},
                    "input_json": {"type": "string", "description": "JSON payload to pass on stdin.", "default": "{}"},
                    "max_time_seconds": {
                        "type": "integer",
                        "description": "Timeout between 1 and 180 seconds.",
                        "default": 30,
                    },
                },
                "required": ["plugin_name", "hook_command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_files",
            "description": "Search file contents with ripgrep, falling back to Python search.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Text or regex query to search for."},
                    "path": {"type": "string", "description": "Relative path to search.", "default": "."},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_agent_resources",
            "description": "List copied agent resources available to the coding agent.",
            "parameters": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["all", "agents", "skills", "commands", "hooks", "plugins"],
                        "description": "Resource kind to list.",
                        "default": "all",
                    }
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_agent_resource",
            "description": "Read a copied agent resource from AGENT_RESOURCES_DIR.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative resource path under AGENT_RESOURCES_DIR.",
                    }
                },
                "required": ["path"],
            },
        },
    },
]
