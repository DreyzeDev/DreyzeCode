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
dreyzecode run "Inspect the project and fix the failing check"
dreyzecode --continue
dreyzecode --model dreyze/model-id --mode plan run "Review the authentication flow"
dreyzecode --add-dir ../shared-library run "Compare the shared library API"
dreyzecode api get /api/code/v1/models
dreyzecode sessions list
```

Build mode can read and search project files. It asks before changing files,
running commands, or creating folders. Plan mode is read-only. Run commands are
executed from the selected project directory. Secret and credential files are
blocked from reads and searches. `--yes` approves requested changes and shell
commands for unattended runs; use it only when the task and workspace are
trusted.

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
- Interactive chat, `run`, `--continue`, `--session`, `--model`, and `--mode`
- Local tools: list/read/search, create/copy/move/write/edit/delete files,
  create folders, run approved commands, and ask the user
- `api get` for read-only diagnostics

The CLI uses `/api/code/agent/turn` and `/api/code/v1/models` on the configured
Dreyze service. The agent runs locally; model requests and subscription access
continue through the existing Dreyze account and service.
