# Mate

Mate is a terminal coding companion for local projects. It talks to an
OpenAI-compatible API, works inside a bounded workspace, and shows a friendly TUI
with concise activity updates, approval prompts, colored diffs, and elapsed-time
results.

Mate keeps its behavior configurable through a repo-local `.mate` directory and
loads reusable commands, agents, hooks, and skills from `agent_resources`.

Mate runs on Node.js. Install Node.js 20 or newer before installing Mate.

## Install

Install globally from a checked-out repo:

```bash
npm install -g .
```

Or install a published package:

```bash
npm install -g mate
```

Configure your model in `~/.mate/keys.env`, your shell environment, or a local
`.env` file:

```bash
mkdir -p ~/.mate
cat > ~/.mate/keys.env <<'EOF'
OPENAI_API_KEY='your-key'
OPENAI_BASE_URL='https://api.openai.com/v1'
OPENAI_MODEL='gpt-4.1-mini'
EOF
chmod 600 ~/.mate/keys.env
```

To build the Docker image and run Mate against the current directory:

```bash
scripts/docker_local.sh
```

To run only the install smoke test:

```bash
scripts/docker_local.sh --smoke
```

By default this installs the package from the current checkout inside the test
image. To pin a package tarball or registry spec:

```bash
PACKAGE_SPEC=mate@X.Y.Z \
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

For local development, the bundled wrapper sets repo-local config paths:

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

Mate loads configuration from `~/.mate` by default, or from another directory
when `MATE_HOME` is set. The bundled `run_agent.sh` sets `MATE_HOME` to the
repo-local `.mate` directory.

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
require_commands = ["npm install*", "git push*"]

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
✔ You approved Mate to run `npm install` this time
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
src/                     Node.js agent runtime
agent_resources/         bundled commands, agents, hooks, and skills
.mate/                   local Mate config
package.json             npm package and mate bin entry
scripts/                 release and installer scripts
run_agent.sh             local wrapper
```

## Contributing

For local development from a checked-out repo, run:

```bash
npm install
npm install -g .
```

Build and verify locally:

```bash
npm run smoke
bash -n run_agent.sh
bash -n scripts/release_github.sh
scripts/release_github.sh
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
