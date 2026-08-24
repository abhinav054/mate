# Mate

Mate is a terminal coding companion for local projects. It talks to an
OpenAI-compatible API, works inside a bounded workspace, and shows a friendly TUI
with concise activity updates, approval prompts, colored diffs, and elapsed-time
results.

Mate keeps its behavior configurable through a repo-local `.mate` directory and
loads reusable commands, agents, hooks, and skills from `agent_resources`.

## Install

Download the installer and run it:

```bash
curl -fsSL https://raw.githubusercontent.com/abhinav054/mate/main/scripts/install_mate.sh | bash -s -- \
  --api-key your-key \
  --base-url https://api.openai.com/v1 \
  --model gpt-4.1-mini
```

From a checked-out repo, run the installer directly:

```bash
./scripts/install_mate.sh \
  --api-key your-key \
  --base-url https://api.openai.com/v1 \
  --model gpt-4.1-mini
```

To build the Docker image and run Mate against the current directory:

```bash
scripts/docker_local.sh
```

To run only the install smoke test:

```bash
scripts/docker_local.sh --smoke
```

By default this resolves the latest release bundle tarball. To pin a specific
release tarball:

```bash
RELEASE_URL=https://github.com/abhinav054/mate/releases/download/vX.Y.Z/mate-X.Y.Z-bundle.tar.gz \
  scripts/docker_local.sh
```

To pass a custom command to Docker:

```bash
scripts/docker_local.sh bash
```

To use Docker with another local project, run the command from that project
directory or set `WORKSPACE_DIR` to an absolute path.

The helper reads `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL` from
the root `.env` file, then `.mate/keys.env`, and passes them into the container.
Environment variables already set in your shell take precedence. Set `ENV_FILE`
or `MATE_KEYS_FILE` to read another file.

The installer saves model settings to Mate home. Any missing value is read from
the matching environment variable first, then prompted interactively.

Environment fallback names are `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and
`OPENAI_MODEL`.

## Run

Use a specific workspace:

```bash
mate /path/to/workspace
```

or:

```bash
mate --workspace /path/to/workspace
```

If you omit the workspace, Mate creates a fresh temporary workspace under `/tmp`.

The bundled wrapper sets the repo-local config paths for you:

```bash
./run_agent.sh /path/to/workspace
./run_agent.sh
```

Inside Mate:

```text
/help
/steer Prefer small, focused patches and always run tests before final answers.
/steer show
/steer clear
/resources all
/resources skills
/backgrounds
/reset
```

## Configuration

Mate loads configuration from `.mate` through `MATE_HOME`. The bundled
`run_agent.sh` sets `MATE_HOME` to the repo-local `.mate` directory.

```text
.mate/
  config.toml
  prompt.md
  mcp_servers.toml
  skills/
  keys.env.example
```

`.mate/config.toml` controls approval behavior and model environment variable
names:

```toml
[approval]
auto_approve = false
require_tools = ["run_command", "start_background_process"]
allow_tools = ["list_files", "glob_files", "read_file", "search_files"]
allow_commands = ["pwd", "ls", "ls *", "rg *", "git status*", "git diff*"]
require_commands = ["pip install *", "npm install*", "git push*"]

[model]
api_key_env = "OPENAI_API_KEY"
base_url_env = "OPENAI_BASE_URL"
model_env = "OPENAI_MODEL"
```

`.mate/prompt.md` is loaded as an extra system prompt at startup. Use it for
local behavior, conventions, and project preferences.

`.mate/keys.env` is for local secrets. It is ignored by git and loaded only when
the matching environment variable is not already set.

## Approvals

Mate asks before running tools or commands that match the approval config. The
approval prompt is transient, so after you answer the terminal keeps only a short
confirmation line:

```text
✔ You approved Mate to run `python -m pip install xgboost` this time
```

Read-only commands such as `ls`, `rg`, `git status`, and `git diff` can be
allowed in `.mate/config.toml`. Installs, servers, and mutating git commands
should usually remain approval-gated.

## MCP Servers

Put MCP server definitions in `.mate/mcp_servers.toml`. The file is currently the
canonical config location for Mate integrations and is shaped so a launcher can
start servers later without mixing connection details into prompts.

Example stdio server:

```toml
[servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/workspace"]
env = { LOG_LEVEL = "info" }
```

Example local service:

```toml
[servers.docs]
command = "python"
args = ["-m", "my_docs_mcp"]
cwd = "/path/to/docs-server"
env = { DOCS_ROOT = "/path/to/docs" }
```

Example remote HTTP server:

```toml
[servers.search]
url = "https://mcp.example.com"
headers = { Authorization = "Bearer ${SEARCH_MCP_TOKEN}" }
```

Store tokens in `.mate/keys.env` or your shell environment, not directly in
`mcp_servers.toml`.

## Skills

Put local skills in `.mate/skills`. Mate checks this folder before bundled
resources, so local skills can be added without editing `agent_resources`.

A skill is a directory containing a `SKILL.md` file:

```text
.mate/skills/my-skill/
  SKILL.md
  references/
  scripts/
```

Minimal local skill:

```markdown
# My Skill

Use this skill when Mate needs to handle a specific workflow.

1. Inspect the relevant files.
2. Apply the project convention.
3. Verify the result before answering.
```

Then restart Mate and ask it to use the skill by folder name, or list available
skills:

```text
/resources skills
```

Keep `SKILL.md` focused: describe when to use the skill, the workflow Mate should
follow, and which reference files matter. Put long examples, scripts, and
supporting docs in nearby `references/`, `examples/`, or `scripts/` folders.

Bundled skills still live under `agent_resources/mate-plugins` and are indexed in
`agent_resources/index/skills.txt`. Use that path for skills that should ship
with Mate releases.

## Project Layout

```text
agent_terminal/          Python package
agent_resources/         bundled commands, agents, hooks, and skills
.mate/                   local Mate config
scripts/                 release and installer scripts
run_agent.sh             local wrapper
install_agent.sh         local editable installer
```

## Contributing

For local development from a checked-out repo, run:

```bash
./install_agent.sh \
  --api-key your-key \
  --base-url https://api.openai.com/v1 \
  --model gpt-4.1-mini
```

The local installer creates `.venv`, installs Mate in editable mode, and saves
model settings to `.mate/keys.env`.

Build and verify locally:

```bash
python -m compileall agent_terminal
bash -n run_agent.sh
bash -n install_agent.sh
bash -n scripts/release_github.sh
bash -n scripts/install_mate.sh
scripts/release_github.sh
```

For local testing, install from a checked-out source folder:

```bash
./scripts/install_mate.sh --source-dir /path/to/mate --api-key your-key --base-url https://api.openai.com/v1
```

## Merge Requests

Changes should land through merge requests. Create a branch from `main`, make a
focused change, run the local verification commands above, then open a merge
request against `main`.

Good merge requests include:

- a short description of the user-facing change
- the commands you ran to verify it
- screenshots or terminal output when the change affects the TUI
- notes about config, installer, or release behavior changes

After review, accepted merge requests are merged into `main`. Maintainers use
the merged state of `main` to build and publish release artifacts, so changes are
included in releases only after they have been reviewed and merged.
