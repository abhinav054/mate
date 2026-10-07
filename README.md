# Mate

Mate opens the terminal UI by default. Launch `mate --workspace /path/to/project`
(or `npm start`). `--ui terminal` is also accepted. The default workspace is the current directory.
For server mode, use `mate --stdio --workspace /path/to/project` (or `npm run server`).
Communication uses newline-delimited JSON-RPC 2.0 on stdin/stdout; diagnostics go
to stderr. In server mode, no terminal UI or interactive prompts are started.

Client requests: `initialize`, `turn/start` with `{ "prompt": "..." }` (or an
`input` array of `{ "type": "text", "text": "..." }`), `conversation/reset`,
and `shutdown` when no turn is active. Each request carries an `id` and receives
a response with that same ID. Only one turn runs at a time.

Activity and Markdown messages retain the `codex.activity`, `codex.user.message`,
and `codex.assistant.message` notifications. Approvals arrive as server requests
named `mate/approval/request`; reply with `result: { "approved": true }` or false.
Input requests use `mate/input/request`; reply with `result: { "value": "..." }`.
These are Mate's methods, not a complete implementation of the Codex app-server protocol.

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

Mate automatically compacts long conversations before model requests when the
estimated context exceeds `AGENT_CONTEXT_MAX_TOKENS` (default `90000`). The
compactor summarizes older messages into durable working memory while preserving
the most recent messages verbatim. Tune it with `AGENT_CONTEXT_TARGET_TOKENS`
and `AGENT_CONTEXT_KEEP_RECENT_MESSAGES`.

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

Mate uses the terminal UI by default:

```bash
mate --ui terminal --workspace /path/to/workspace
```

The former separate chat UI has been removed. The terminal UI now renders typed
activity views for plan, reasoning, command, file-change, and tool events.

To emit Codex app server-compatible JSON-RPC notifications alongside terminal
output, set:

```bash
MATE_EVENT_STREAM=jsonrpc mate --workspace /path/to/workspace
```

Notifications use `codex.activity`, `codex.user.message`, and
`codex.assistant.message` methods with JSON-RPC 2.0 notification envelopes.
Set `MATE_EVENT_STREAM_FD=2` to write those notifications to stderr instead of
stdout.

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

Mate saves each conversation in the workspace-local `.mate/sessions` directory.
Each session contains `messages.jsonl` for resuming and `transcript.txt` for
plain-text reading.

List saved sessions for the current workspace:

```bash
mate session
```

Resume the latest saved conversation:

```bash
mate resume
```

Pass `--workspace /path/to/workspace` to list or resume sessions somewhere other
than the current directory.

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

Put MCP server definitions in `.mate/config.toml` or `.mate/mcp_servers.toml` as
`[servers.<name>]` sections. Mate connects enabled servers at startup, lists
their tools, and exposes them to the model as `mcp__<server>__<tool>` function
tools.

Example stdio server:

```toml
[servers.filesystem]
transport = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/workspace"]
env = { LOG_LEVEL = "info" }
```

Example remote Streamable HTTP server:

```toml
[servers.search]
transport = "http"
url = "https://mcp.example.com"
headers = { Authorization = "Bearer ${SEARCH_MCP_TOKEN}" }
```

Example legacy server-sent events server:

```toml
[servers.legacy_search]
transport = "sse"
url = "https://mcp.example.com/sse"
headers = { Authorization = "Bearer ${SEARCH_MCP_TOKEN}" }
```

Example in-process server using the SDK's in-memory transport:

```toml
[servers.local_tools]
transport = "inMemory"
module = "./local-mcp-server.js"
export = "createServer"
```

The factory module can import `InMemoryTransport` directly:

```js
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

export async function createServer() {
  // Return an MCP Server instance, a client transport, or
  // [clientTransport, serverTransport] from InMemoryTransport.createLinkedPair().
}
```

Store tokens in `.mate/keys.env` or your shell environment, not directly in
`config.toml`.

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
