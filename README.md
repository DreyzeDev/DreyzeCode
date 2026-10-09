# DreyzeCode

An independent Dreyze terminal agent. It authenticates with your Dreyze account,
gets models from the Dreyze catalog, and performs approved file and command work
on the computer where the CLI runs.

## Install and sign in

Requires Node.js 20 or newer.

```sh
npm install -g git+https://github.com/DreyzeDev/DreyzeCode.git
dreyzecode login
cd path/to/project
dreyzecode
```

For an SSH server, run `dreyzecode login` on the server and follow its printed
SSH tunnel instructions. The CLI uses the existing Dreyze browser sign-in and
stores a separate session in the user configuration directory. It never asks
for the account password in the terminal.

## Commands

```sh
dreyzecode --json doctor
dreyzecode models list
dreyzecode skills list
dreyzecode mcp list
dreyzecode run "Inspect the project and fix the failing check"
dreyzecode run "Describe the UI and suggest improvements" --image ./screenshot.png
dreyzecode --continue
dreyzecode --model dreyze/model-id --mode plan run "Review the authentication flow"
dreyzecode --add-dir ../shared-library run "Compare the shared library API"
dreyzecode api get /api/code/v1/models
dreyzecode sessions list
```

Build mode can read and search project files. It asks before changing files,
running commands, or creating folders. Plan mode is read-only. Run commands are
executed from the selected project directory: PowerShell on Windows and POSIX
`/bin/sh` on Linux and macOS. The model receives the active shell type so it can
choose matching command syntax. Secret and credential files are
blocked from reads and searches. Build can ask permission to start an isolated,
read-only research subagent; its findings appear in the parent session and its
own session remains available in the session list. Moving a folder renames it
inside the approved project; moving the project root or moving a folder into
itself is blocked. `--yes` approves requested changes, shell commands, and
subagent work for unattended runs; use it only when the task and workspace are
trusted. Identical consecutive tool calls are skipped; if the model keeps
repeating the same call, DreyzeCode stops the run and saves the session.

Attach PNG, JPEG, or WebP images with one or more `--image PATH` options. In an
interactive session, use `/attach PATH` before sending the next prompt. The
selected model must advertise image support. A session stores validated local
paths, not image bytes; images are checked against the allowed project folders
each time they are sent. Each image is limited to 2.9 MB and a message to 7 MB
total.

Interactive mode has a framed message composer, separate panels for your
messages and model replies, and a live status while the model or a local tool
is working. Slash command suggestions appear as you type, including choices
for modes, themes, and models. Enter `/` to open the full command palette or
press Tab to complete a command. `/help` lists the built-in commands and
project commands. Use `/skill-name task` to run a project command with a task,
or `/skills` to list project commands. Use `/history [number]` to view recent
user and assistant messages in the current session; tool payloads stay hidden.
Prefix a message with `//` when it should start with a literal `/`.

The agent follows project guidance from `AGENTS.md` files and
`.dreyze/instructions.md`. Nested `AGENTS.md` files are supplied with their
relative paths so the agent can apply the closest relevant rules. Discovery
skips generated and dependency folders, symbolic links, oversized files, and
secret values; the total project-guidance context is capped at 24,000
characters.

Project skills live at `.dreyze/skills/<name>/SKILL.md`. Add YAML frontmatter
with `name` and `description`; DreyzeCode sends that small index with each
agent turn. The folder name becomes the slash command (for example,
`.dreyze/skills/interface-review/SKILL.md` is `/interface-review`). Running a
skill command reads its instructions from the workspace and combines them with
your task. `dreyzecode skills list` displays aliases without requiring login.
Additional approved project folders can contain their own `.dreyze/skills`
directory.

## MCP servers

DreyzeCode can connect to MCP servers over `stdio`, Streamable HTTP, or legacy
SSE. Configure project servers in `.dreyze/mcp.json` or user-wide servers in
`%APPDATA%/DreyzeCode/mcp.json` on Windows and
`$XDG_CONFIG_HOME/dreyze-code/mcp.json` (default `~/.config/dreyze-code/mcp.json`)
on Linux and macOS. Check the visible server names with `dreyzecode mcp list`.

Example project configuration:

```json
{
  "mcpServers": {
    "docs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./docs"],
      "cwd": "."
    },
    "remote-tools": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_ACCESS_TOKEN}" }
    }
  }
}
```

Set environment variables before starting DreyzeCode; `${NAME}` references in
`env`, `args`, and HTTP headers are expanded locally. Values are not sent to the
model. Build asks before starting each configured server and before every MCP
tool call. Tool descriptions, schemas, and results are treated as untrusted
data. `--yes` approves server launches and MCP calls for unattended work.
Plan mode does not expose MCP tools.

Sessions are stored under the user's DreyzeCode configuration directory, keyed
by the canonical project path. An interrupted write or command is recorded
before it starts. On restart the CLI reports an unknown outcome and asks the
model to inspect the current state before attempting the action again. When a
session grows beyond 130,000 characters, the oldest conversation entries are
trimmed while keeping the original request and the most recent context.

## Machine-readable output

`--json` prints one JSON object to stdout; progress and approvals use stderr.
Successful commands return `{ "ok": true, ... }`. Errors return
`{ "ok": false, "error": { "code": "...", "message": "..." } }` and use a
nonzero exit code. Tokens and cookies are never printed. `api get` is a
read-only same-origin escape hatch restricted to `/api/` paths.

## Current command contract

- `login`, `logout`, `doctor`, `models list`, `sessions list`, `sessions show`
- `skills list` for project-local capabilities
- `mcp list` for configured local and remote MCP servers
- Interactive chat, `run`, `--continue`, `--session`, `--model`, and `--mode`
- Local tools: list/read/search, image input, create/copy/move/write/edit/delete
  files, create folders, run approved commands, search the web using the
  account's monthly search allowance, ask the user, and start a read-only
  research subagent in Build mode. Web search is read-only and available in
  both Build and Plan modes. MCP tools are available in Build mode after
  server and per-call approval.
- `api get` for read-only diagnostics

The CLI uses `/api/code/agent/turn` and `/api/code/v1/models` on the configured
Dreyze service. The agent runs locally; model requests and subscription access
continue through the existing Dreyze account and service.
