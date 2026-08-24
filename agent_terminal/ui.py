from __future__ import annotations

import os
import re
import shutil
import sys
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator


class TerminalUI:
    BLACK = "\033[30m"
    BLUE = "\033[34m"
    CYAN = "\033[36m"
    GREEN = "\033[32m"
    MAGENTA = "\033[35m"
    RED = "\033[31m"
    WHITE = "\033[37m"
    YELLOW = "\033[33m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    ITALIC = "\033[3m"
    RESET = "\033[0m"
    BG_BLUE = "\033[44m"
    BG_BLACK = "\033[40m"

    THEME = {
        "accent": CYAN,
        "command": GREEN,
        "diff": MAGENTA,
        "error": RED,
        "path": BLUE,
        "success": GREEN,
        "warning": YELLOW,
    }

    @staticmethod
    def enabled() -> bool:
        return os.getenv("NO_COLOR") is None

    @classmethod
    def style(cls, value: str, *codes: str) -> str:
        if not cls.enabled():
            return value
        return "".join(codes) + value + cls.RESET

    @classmethod
    def highlight(cls, value: str) -> str:
        if not cls.enabled():
            return value

        urls: list[str] = []

        def protect_url(match: re.Match[str]) -> str:
            urls.append(match.group(0))
            return f"\0URL{len(urls) - 1}\0"

        def command(match: re.Match[str]) -> str:
            return cls.style(match.group(0), cls.THEME["command"], cls.BOLD)

        def path(match: re.Match[str]) -> str:
            return cls.style(match.group(0), cls.THEME["path"])

        value = re.sub(r"https?://[^\s)>\]}\"']+", protect_url, value)
        value = re.sub(r"`[^`]+`", command, value)
        path_pattern = r"(?<![\w`:])(?:\.{1,2}/|/|~\/)[\w./@%+=:,-]+|\b[\w.-]+/[\w./@%+=:,-]+"
        value = re.sub(path_pattern, path, value)
        for index, url in enumerate(urls):
            value = value.replace(f"\0URL{index}\0", url)
        return value

    @classmethod
    def rule(cls, title: str = "") -> None:
        width = min(shutil.get_terminal_size((88, 20)).columns, 100)
        if title:
            label = f" {title} "
            right = max(2, width - len(label) - 2)
            print(cls.style("─ " + label + "─" * right, cls.DIM))
        else:
            print(cls.style("─" * width, cls.DIM))

    @classmethod
    def panel(cls, title: str, body: str, color: str = CYAN) -> None:
        cls.rule(cls.style(title, cls.BOLD, color))
        cls.body(body)
        cls.rule()
        print()

    @classmethod
    def banner(cls, title: str, body: str = "") -> None:
        width = min(shutil.get_terminal_size((88, 20)).columns, 100)
        text = f" {title} "
        if cls.enabled():
            print(cls.style(text.ljust(width), cls.BOLD, cls.WHITE, cls.BG_BLUE))
        else:
            print(text.strip())
        if body:
            cls.body(body)
        print()

    @classmethod
    def answer(cls, body: str, elapsed_seconds: float | None = None) -> None:
        title = "Result" if elapsed_seconds is None else f"Worked for {cls.format_duration(elapsed_seconds)}"
        cls.rule(cls.style(title, cls.BOLD, cls.GREEN))
        cls.body(body)
        cls.rule()
        print()

    @staticmethod
    def format_duration(seconds: float) -> str:
        total = max(0, int(round(seconds)))
        minutes, remaining = divmod(total, 60)
        hours, minutes = divmod(minutes, 60)
        parts = []
        if hours:
            parts.append(f"{hours}h")
        if minutes:
            parts.append(f"{minutes}m")
        parts.append(f"{remaining}s")
        return " ".join(parts)

    @classmethod
    def prompt_label(cls) -> str:
        return cls.style("mate", cls.BOLD, cls.CYAN) + cls.style(" ❯ ", cls.BOLD, cls.GREEN)

    @classmethod
    def status(cls, label: str, body: str = "", color: str = CYAN) -> None:
        prefix = cls.style(f"{label}:", cls.BOLD, color)
        print(f"\n{prefix} {cls.highlight(body)}".rstrip())

    @classmethod
    def activity(cls, action: str, detail: str = "", color: str = CYAN) -> None:
        marker = cls.style("◆", color, cls.BOLD)
        action_text = cls.style(action, cls.BOLD, color)
        suffix = f" {cls.highlight(detail)}" if detail else ""
        print(f"{marker} {action_text}{suffix}")

    @classmethod
    def success(cls, body: str) -> None:
        print(f"{cls.style('✔', cls.GREEN, cls.BOLD)} {cls.highlight(body)}")

    @classmethod
    def warning(cls, body: str) -> None:
        print(f"{cls.style('!', cls.YELLOW, cls.BOLD)} {cls.highlight(body)}")

    @classmethod
    @contextmanager
    def working(cls, label: str = "Agent is working") -> Iterator[None]:
        indicator = WorkingIndicator(cls, label)
        indicator.start()
        try:
            yield
        finally:
            indicator.stop()

    @classmethod
    def diff(cls, body: str) -> None:
        cls.rule(cls.style("File Diff", cls.BOLD, cls.MAGENTA))
        for line in body.splitlines():
            if line.startswith("+") and not line.startswith("+++"):
                print(cls.style(line, cls.GREEN))
            elif line.startswith("-") and not line.startswith("---"):
                print(cls.style(line, cls.RED))
            elif line.startswith("@@"):
                print(cls.style(line, cls.CYAN, cls.BOLD))
            elif line.startswith(("---", "+++")):
                print(cls.style(line, cls.YELLOW))
            else:
                print(line)
        cls.rule()
        print()

    @classmethod
    def prompt(cls, label: str, secret: bool = False) -> str:
        if secret:
            import getpass

            return getpass.getpass(cls.style(label, cls.BOLD, cls.YELLOW))
        return input(cls.style(label, cls.BOLD, cls.YELLOW))

    @classmethod
    def transient_prompt(cls, label: str) -> str:
        answer = input(cls.style(label, cls.BOLD, cls.YELLOW))
        if sys.stdout.isatty():
            width = shutil.get_terminal_size((88, 20)).columns
            sys.stdout.write("\033[A\r" + " " * max(1, width - 1) + "\r")
            sys.stdout.flush()
        return answer

    @classmethod
    def body(cls, body: str) -> None:
        if not body.strip():
            print(cls.style("(no output)", cls.DIM))
            return
        in_code = False
        language = ""
        for line in body.rstrip().splitlines():
            stripped = line.strip()
            if stripped.startswith("```"):
                in_code = not in_code
                language = stripped.removeprefix("```").strip().lower() if in_code else ""
                label = f" code:{language or 'text'} " if in_code else " end "
                print(cls.style(label, cls.DIM))
                continue
            if in_code:
                print(cls.highlight_code(line, language))
            else:
                print(cls.highlight(line))

    @classmethod
    def highlight_code(cls, line: str, language: str = "") -> str:
        if not cls.enabled():
            return line
        if line.startswith("+") and not line.startswith("+++"):
            return cls.style(line, cls.GREEN)
        if line.startswith("-") and not line.startswith("---"):
            return cls.style(line, cls.RED)
        if line.startswith("@@"):
            return cls.style(line, cls.CYAN, cls.BOLD)

        patterns = [
            (r"(?<!\w)(def|class|return|if|else|elif|for|while|try|except|with|import|from|as|async|await)(?!\w)", cls.MAGENTA),
            (r"(?<!\w)(const|let|var|function|return|if|else|for|while|import|export|from|async|await|type|interface)(?!\w)", cls.MAGENTA),
            (r"(?<!\w)(cd|exec|source|export|if|then|fi|elif|else|while|do|done)(?!\w)", cls.MAGENTA),
            (r"\"[^\"]*\"|'[^']*'", cls.YELLOW),
            (r"(?<!\w)(True|False|None|null|undefined|true|false)(?!\w)", cls.CYAN),
        ]
        colored = line
        for pattern, color in patterns:
            colored = re.sub(pattern, lambda match, c=color: cls.style(match.group(0), c), colored)
        return cls.highlight(colored)


@dataclass
class WorkingIndicator:
    ui: type[TerminalUI]
    label: str
    interval: float = 0.12

    def __post_init__(self) -> None:
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._started = time.monotonic()

    def start(self) -> None:
        if sys.stdout.isatty() and self.ui.enabled():
            self._thread.start()
        else:
            self.ui.activity(self.label, "started", self.ui.CYAN)

    def stop(self) -> None:
        if self._thread.is_alive():
            self._stop.set()
            self._thread.join()
            self._clear_line()

    def _run(self) -> None:
        frames = ("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏")
        index = 0
        while not self._stop.is_set():
            elapsed = int(time.monotonic() - self._started)
            text = f"{frames[index % len(frames)]} {self.label} · {elapsed}s"
            sys.stdout.write("\r" + self.ui.style(text, self.ui.BOLD, self.ui.CYAN))
            sys.stdout.flush()
            index += 1
            self._stop.wait(self.interval)

    def _clear_line(self) -> None:
        width = shutil.get_terminal_size((88, 20)).columns
        sys.stdout.write("\r" + " " * max(1, width - 1) + "\r")
        sys.stdout.flush()
