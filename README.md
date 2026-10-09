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
dreyzecode skills create personal my-review
dreyzecode skills create project release-check
dreyzecode mcp list
dreyzecode run "Inspect the project and fix the failing check"
dreyzecode run "Inspect the project" --output-format stream-json
git diff | dreyzecode run "Review these changes" --stdin --mode plan
dreyzecode run "Describe the UI and suggest improvements" --image ./screenshot.png
dreyzecode --continue
dreyzecode --model dreyze/model-id --mode plan run "Review the authentication flow"
dreyzecode --add-dir ../shared-library run "Compare the shared library API"
dreyzecode api get /api/code/v1/models
dreyzecode sessions list
dreyzecode agents start "Review the image upload flow"
dreyzecode agents list
dreyzecode agents attach <agent-id>
dreyzecode agents approve <agent-id>
dreyzecode agents answer <agent-id> "Use the current brand colors"
```

Build mode can read and search project files. It asks before changing files,
running commands, or creating folders. Plan mode is read-only. Run commands are
executed from the selected project directory: PowerShell on Windows and POSIX
`/bin/sh` on Linux and macOS. The model receives the active shell type so it can
choose matching command syntax. In an interactive terminal, command output
streams as it arrives; control sequences are stripped, credential patterns are
redacted, and the live preview is capped per command. Secret and credential files are
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

Interactive mode has a framed chat composer, separate panels for your messages
and model replies, and a live status while the model or a local tool is
working. The composer shows the selected model, mode, and queued image files.
Slash command suggestions appear as you type, including choices for modes,
themes, and models. Use ↑/↓ to move through suggestions and Tab to insert the
selected command. Enter `/` to open the full command list. `/help` lists built-in DreyzeCode commands and personal or
project commands. `/review [scope]` inspects the project in read-only Plan mode and
reports confirmed findings without changing files. `/init` asks the agent to
create `.dreyze/instructions.md` with project guidance after normal write
approval. Use `/skill-name task` to run a personal or project command with a
task, or `/skills` to list available commands. `/copy` puts the latest model reply on the
system clipboard, and `/rename NAME` gives the current conversation a
recognizable title in the session list. Use `/history [number]` to view recent
user and assistant messages in the current session; tool payloads stay hidden.
Use `/rewind` to inspect recent turns, then `/rewind 1` to restore the latest
turn's direct file edits and remove its messages from the session after an
explicit confirmation. DreyzeCode verifies file contents before restoring so
later edits are preserved. It tracks direct file and folder tools only; shell
commands, MCP tools, hooks, desktop folders, and oversized snapshots may not be
reversible. Checkpoints are local to the saved session and are not a substitute
for Git.
Prefix a message with `//` when it should start with a literal `/`.
Press Ctrl+C during a task to stop the current model request or running command;
the session is saved so you can continue with `dreyzecode --continue`. If a
write or command had already started, its outcome is marked unknown and the
agent inspects the project before retrying it.

Background agents run in a separate saved session and leave the current chat
and its resume pointer unchanged. Start one with `dreyzecode agents start
"task"` or `/agents start task`; the default is Build mode. File changes,
commands, hooks, and MCP calls wait for your approval. Use `agents show ID` to
inspect a pending action, then `agents approve ID` or `agents deny ID`; answer
agent questions with `agents answer ID "your answer"`. Use `agents attach ID` to
wait for the next result or approval request, and `agents stop ID` to cancel.
Choose `--mode plan` or `/agents start --mode plan task` for read-only research.
The original chat remains available while the agent works.

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
directory. Personal skills work in every project and live at
`~/.config/dreyze-code/skills/<name>/SKILL.md` on Linux and macOS, or
`%APPDATA%\DreyzeCode\skills\<name>\SKILL.md` on Windows. When
`XDG_CONFIG_HOME` is set, Linux and macOS use
`$XDG_CONFIG_HOME/dreyze-code/skills/`. Create a personal command with
`dreyzecode skills create personal <name>` or a project command with
`dreyzecode skills create project <name>`. The CLI writes a starter `SKILL.md`
and refuses to overwrite an existing command. A project skill with the same
command name takes precedence while you are in that project. Personal skill
folders are never added to the agent's project filesystem roots; DreyzeCode
reads the selected instruction file locally when you invoke its slash command.

Local lifecycle hooks can be listed with `/hooks` or `dreyzecode hooks list`.
Project hooks live in `.dreyze/hooks.json`; user-wide hooks live in
`hooks.json` beside the DreyzeCode user configuration. Hooks may run before or
after a tool. Project hook commands require confirmation for each task before
they run; `--yes` approves them along with other requested actions. A
`beforeTool` hook can block an action by exiting with code 2. Plan mode does
not run hooks. Hook commands run locally with Dreyze credential variables
removed and have a bounded timeout.

Example project configuration:

```json
{
  "hooks": [
    {
      "event": "beforeTool",
      "tools": ["run_command"],
      "command": "npm test",
      "timeoutMs": 30000
    }
  ]
}
```

The hook receives a JSON event on stdin with the workspace and tool name,
arguments, and (for `afterTool`) result. Successful output is passed back to
the model as untrusted context; a failing hook is reported to the model.

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

`--json` (or `--output-format json`) prints one JSON object to stdout; progress
and approvals use stderr. `dreyzecode run "..." --output-format stream-json`
prints a JSON object per line with a shared `run_id` and increasing `sequence`:
initial session metadata, model turns, tool calls and results, permission
decisions, and the final result. Assistant content appears after each complete
server response; the current agent API does not stream model tokens. Errors
also use a JSON line and return a nonzero exit code. Successful commands return
`{ "ok": true, ... }`. Errors in single-object JSON mode return
`{ "ok": false, "error": { "code": "...", "message": "..." } }` and use a
nonzero exit code. Tokens and cookies are never printed. `api get` is a
read-only same-origin escape hatch restricted to `/api/` paths.

Pass piped or redirected text to a one-shot task with `--stdin` or `-`:
`git diff | dreyzecode run "Review these changes" --stdin --mode plan`.
The CLI joins that text with the prompt and rejects input above 24,000
characters. Use `--yes` when running unattended tasks that need approval.

## Current command contract

- `login`, `logout`, `doctor`, `models list`, `sessions list`, `sessions show`
- `agents list|start|show|attach|approve|deny|answer|stop` and the matching `/agents` chat command
- `skills list` for personal and project-local capabilities
- `mcp list` for configured local and remote MCP servers
- Interactive chat, `run`, `--continue`, `--session`, `--model`, and `--mode`
- Slash commands for review, project setup, hooks, chat history, copying
  replies, safe turn rewind, naming and resuming sessions, themes, models, and personal or
  project skills
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
