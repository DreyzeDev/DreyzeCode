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
executed from the selected project directory. Secret and credential files are
blocked from reads and searches. Build can ask permission to start an isolated,
read-only research subagent; its findings appear in the parent session and its
own session remains available in the session list. Moving a folder renames it
inside the approved project; moving the project root or moving a folder into
itself is blocked. `--yes` approves requested changes, shell commands, and
subagent work for unattended runs; use it only when the task and workspace are
trusted.

Attach PNG, JPEG, or WebP images with one or more `--image PATH` options. In an
interactive session, use `/attach PATH` before sending the next prompt. The
selected model must advertise image support. A session stores validated local
paths, not image bytes; images are checked against the allowed project folders
each time they are sent. Each image is limited to 2.9 MB and a message to 7 MB
total.

The agent follows project guidance from `AGENTS.md` files and
`.dreyze/instructions.md`. Nested `AGENTS.md` files are supplied with their
relative paths so the agent can apply the closest relevant rules. Discovery
skips generated and dependency folders, symbolic links, oversized files, and
secret values; the total project-guidance context is capped at 24,000
characters.

Project skills live at `.dreyze/skills/<name>/SKILL.md`. Add YAML frontmatter
with `name` and `description`; DreyzeCode sends that small index with each
agent turn, then the model reads a matching skill file before using it.
`dreyzecode skills list` displays skills without requiring login. Additional
approved project folders can contain their own `.dreyze/skills` directory.

Sessions are stored under the user's DreyzeCode configuration directory, keyed
by the canonical project path. An interrupted write or command is recorded
before it starts. On restart the CLI reports an unknown outcome and asks the
model to inspect the current state before attempting the action again.

## Machine-readable output

`--json` prints one JSON object to stdout; progress and approvals use stderr.
Successful commands return `{ "ok": true, ... }`. Errors return
`{ "ok": false, "error": { "code": "...", "message": "..." } }` and use a
nonzero exit code. Tokens and cookies are never printed. `api get` is a
read-only same-origin escape hatch restricted to `/api/` paths.

## Current command contract

- `login`, `logout`, `doctor`, `models list`, `sessions list`, `sessions show`
- `skills list` for project-local capabilities
- Interactive chat, `run`, `--continue`, `--session`, `--model`, and `--mode`
- Local tools: list/read/search, image input, create/copy/move/write/edit/delete
  files, create folders, run approved commands, search the web using the
  account's monthly search allowance, ask the user, and start a read-only
  research subagent in Build mode. Web search is read-only and available in
  both Build and Plan modes.
- `api get` for read-only diagnostics

The CLI uses `/api/code/agent/turn` and `/api/code/v1/models` on the configured
Dreyze service. The agent runs locally; model requests and subscription access
continue through the existing Dreyze account and service.
