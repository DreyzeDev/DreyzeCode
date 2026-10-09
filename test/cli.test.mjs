import assert from "node:assert/strict"
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import {
  clipboardTargets,
  builtInSlashTask,
  copyToClipboard,
  createSessionStore,
  beginTurnCheckpoint,
  recordCheckpointChange,
  rewindSession,
  createLiveToolOutputStream,
  apiGet,
  buildSkillPrompt,
  backgroundAgentStatus,
  completeSlashInput,
  createSkillScaffold,
  executeTool,
  fetchModelCatalog,
  formatChatMessage,
  formatChatComposer,
  isSlashCommandPalette,
  isSensitivePath,
  loadAvailableSkills,
  loadProjectInstructions,
  loadProjectSkills,
  loadUserSkills,
  parseArgs,
  parseSlashCommand,
  readStdinPrompt,
  redactSecrets,
  recoverPendingAction,
  resumeInteractiveSession,
  resolveWorkspacePath,
  runAgentTask,
  runBackgroundAgentWorker,
  stopBackgroundAgent,
  slashTabCompletion,
  slashCommandSuggestions,
  visibleSessionMessages,
  validateImagePaths,
} from "../cli.mjs"
import { connectMcpServers, listConfiguredMcpServers } from "../mcp-client.mjs"

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dreyzecode-native-"))
  const workspacePath = path.join(root, "project")
  const config = path.join(root, "config")
  await mkdir(workspacePath)
  const workspace = await realpath(workspacePath)
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, workspace, config }
}

test("parses the product command surface with global flags before and after commands", () => {
  assert.deepEqual(parseArgs(["--json", "doctor"]).command, "doctor")
  assert.deepEqual(parseArgs(["--model", "dreyze/model", "--mode", "plan", "run", "Review", "this"]).positionals, ["Review", "this"])
  assert.equal(parseArgs(["sessions", "list"]).command, "sessions")
  assert.equal(parseArgs(["agents", "start", "Inspect the workspace"]).command, "agents")
  assert.equal(parseArgs(["skills", "list"]).command, "skills")
  assert.equal(parseArgs(["--continue"]).continuing, true)
  assert.deepEqual(parseArgs(["--image", "./first.png", "--image=./second.webp", "run", "Describe photos"]).imagePaths, ["./first.png", "./second.webp"])
  assert.equal(parseArgs(["run", "Inspect the project", "--output-format", "stream-json"]).outputFormat, "stream-json")
  assert.equal(parseArgs(["--output-format=stream-json", "run", "Inspect the project"]).outputFormat, "stream-json")
  assert.equal(parseArgs(["run", "Inspect the project", "--output-format", "json"]).json, true)
  assert.equal(parseArgs(["run", "Review this diff", "--stdin"]).readStdin, true)
  assert.equal(parseArgs(["run", "-"]).readStdin, true)
  assert.throws(() => parseArgs(["--output-format", "stream-json"]), /одноразовой команды run/u)
  assert.throws(() => parseArgs(["models", "list", "--output-format", "stream-json"]), /только для одноразовой команды run/u)
  assert.throws(() => parseArgs(["--stdin"]), /только для одноразовой команды run/u)
})

test("reads bounded UTF-8 prompts from stdin, including a split multibyte character", async () => {
  const stream = new PassThrough()
  const result = readStdinPrompt(stream, 20)
  stream.write(Buffer.from([0xd0]))
  stream.end(Buffer.from([0x9f, 0x20, 0x6f, 0x6b]))
  assert.equal(await result, "П ok")

  const tooLarge = new PassThrough()
  const rejected = readStdinPrompt(tooLarge, 3)
  tooLarge.end("four")
  await assert.rejects(rejected, { code: "STDIN_TOO_LARGE" })

  const terminal = new PassThrough()
  terminal.isTTY = true
  await assert.rejects(readStdinPrompt(terminal), /перенаправьте текст/u)
})

test("parses DreyzeCode slash commands with multiword arguments and literal slash escape", () => {
  assert.deepEqual(parseSlashCommand("/MoDe plan"), { name: "mode", argument: "plan" })
  assert.deepEqual(parseSlashCommand("/проверка текст задачи"), { name: "проверка", argument: "текст задачи" })
  assert.deepEqual(parseSlashCommand('/model "Dreyze Opus 5.5"'), { name: "model", argument: '"Dreyze Opus 5.5"' })
  assert.equal(parseSlashCommand("//tmp/project"), null)
  assert.equal(parseSlashCommand("Build a storefront"), null)
})

test("keeps built-in slash tasks scoped to safe modes", () => {
  const review = builtInSlashTask("review", "the login flow")
  assert.equal(review.mode, "plan")
  assert.match(review.prompt, /Область: the login flow/u)
  assert.match(review.prompt, /не создавай, не редактируй и не удаляй файлы/u)
  const init = builtInSlashTask("init")
  assert.equal(init.mode, "build")
  assert.match(init.prompt, /\.dreyze\/instructions\.md/u)
  assert.match(init.prompt, /не перезаписывай/u)
  assert.equal(builtInSlashTask("model"), null)
})

test("opens the slash command palette when the prompt contains only a slash", () => {
  assert.equal(isSlashCommandPalette("/"), true)
  assert.equal(isSlashCommandPalette("  /  "), true)
  assert.equal(isSlashCommandPalette("/help"), false)
  assert.equal(isSlashCommandPalette("//"), false)
})

test("completes slash commands and their mode, theme, and model arguments", () => {
  const catalog = {
    models: [{ id: "dreyze/opus" }, { id: "dreyze/sonnet" }],
    skills: [{ commandName: "interface-review", name: "Interface Review" }, { commandName: "проверка", name: "Проверка" }],
  }
  assert.deepEqual(completeSlashInput("/hel"), [["/help"], "/hel"])
  assert.deepEqual(completeSlashInput("/interface", catalog), [["/interface-review"], "/interface"])
  assert.deepEqual(completeSlashInput("/пров", catalog), [["/проверка"], "/пров"])
  assert.deepEqual(completeSlashInput("/mode p"), [["/mode plan"], "/mode p"])
  assert.deepEqual(completeSlashInput("/theme b"), [["/theme blue"], "/theme b"])
  assert.deepEqual(completeSlashInput("/model dreyze/o", catalog), [["/model dreyze/opus"], "/model dreyze/o"])
  assert.deepEqual(completeSlashInput("//tmp"), [[], "//tmp"])
  assert.equal(slashTabCompletion("/hel", catalog), "p")
  assert.equal(slashTabCompletion("/theme b", catalog), "lue")
  assert.equal(slashTabCompletion("/mode ", catalog), "")
})

test("shows live slash suggestions for built-in, project, and personal skills", () => {
  const catalog = {
    skills: [
      { commandName: "interface-review", name: "Interface Review", description: "Review the interface.", path: "./.dreyze/skills/interface-review/SKILL.md" },
      { commandName: "my-check", name: "My Check", description: "Check any repository.", path: "@user/skills/my-check/SKILL.md" },
      { commandName: "проверка", name: "Проверка", description: "Проверить проект." },
    ],
  }
  assert.deepEqual(slashCommandSuggestions("/hel", catalog), [
    { name: "help", usage: "/help", description: "показать команды" },
  ])
  assert.deepEqual(slashCommandSuggestions("/interface", catalog), [
    { name: "interface-review", usage: "/interface-review", description: "Review the interface." },
  ])
  assert.deepEqual(slashCommandSuggestions("/my-check", catalog), [
    { name: "my-check", usage: "/my-check", description: "Check any repository." },
  ])
  assert.deepEqual(slashCommandSuggestions("/пров", catalog), [
    { name: "проверка", usage: "/проверка", description: "Проверить проект." },
  ])
  assert.deepEqual(slashCommandSuggestions("/his", catalog).map(({ usage }) => usage), ["/history [число]"])
  assert.deepEqual(slashCommandSuggestions("/cop", catalog).map(({ usage }) => usage), ["/copy"])
  assert.deepEqual(slashCommandSuggestions("/rev", catalog).map(({ usage }) => usage), ["/review [область]"])
  assert.deepEqual(slashCommandSuggestions("/ini", catalog).map(({ usage }) => usage), ["/init"])
  assert.deepEqual(slashCommandSuggestions("/ren", catalog).map(({ usage }) => usage), ["/rename <название>"])
  assert.deepEqual(slashCommandSuggestions("/help later", catalog), [])
  assert.deepEqual(slashCommandSuggestions("//tmp/project", catalog), [])
})

test("shows live choices for slash command arguments", () => {
  const catalog = { models: [{ id: "dreyze/opus", name: "Dreyze Opus" }, { id: "dreyze/sonnet", name: "Dreyze Sonnet" }] }
  assert.deepEqual(slashCommandSuggestions("/mode p", catalog).map(({ usage }) => usage), ["/mode plan"])
  assert.deepEqual(slashCommandSuggestions("/theme ", catalog).map(({ usage }) => usage), ["/theme purple", "/theme blue", "/theme system"])
  assert.deepEqual(slashCommandSuggestions("/model dreyze/o", catalog).map(({ usage }) => usage), ["/model dreyze/opus"])
  assert.deepEqual(slashCommandSuggestions("/agents star", catalog).map(({ usage }) => usage), ["/agents start"])
  assert.deepEqual(slashCommandSuggestions("/help later", catalog), [])
})

test("runs a background research task in its own read-only session without changing the active session", { timeout: 15_000 }, async (t) => {
  const { config, workspace } = await fixture(t)
  const cookie = `__Host-dreyzeai_session=${"b".repeat(64)}`
  const requests = []
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    requests.push({ path: request.url, cookie: request.headers.cookie, body })
    if (request.url === "/api/code/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ defaultModel: "dreyze/test", data: [{ id: "dreyze/test", name: "Test", group: "test" }] }))
    } else if (request.url === "/api/code/agent/turn") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ type: "final", content: "Фоновое исследование завершено." }))
    } else response.writeHead(404).end("{}")
  })
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise))
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)))
  const address = server.address()
  const configData = JSON.stringify({ url: `http://127.0.0.1:${address.port}`, cookie })
  for (const folder of [path.join(config, "dreyze-code"), path.join(config, "DreyzeCode")]) {
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, "config.json"), configData, { mode: 0o600 })
  }

  const sessionRoot = process.platform === "win32" ? path.join(config, "DreyzeCode") : path.join(config, "dreyze-code")
  const store = createSessionStore(workspace, sessionRoot)
  const active = await store.create("dreyze/test", "build")
  await store.save(active)
  const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url))
  const environment = { ...process.env, XDG_CONFIG_HOME: config, APPDATA: config }
  const invoke = (args) => new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: workspace, env: environment, stdio: ["ignore", "pipe", "pipe"] })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 10_000)
    let stdoutText = ""
    let stderrText = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdoutText += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderrText += chunk })
    child.once("error", (error) => { clearTimeout(timer); rejectPromise(error) })
    child.once("close", (code) => { clearTimeout(timer); resolvePromise({ code, stdout: stdoutText, stderr: stderrText, timedOut }) })
  })

  const started = await invoke(["agents", "start", "Inspect the project safely", "--mode", "plan", "--json"])
  assert.equal(started.code, 0, started.stderr)
  const startResult = JSON.parse(started.stdout)
  assert.equal(startResult.ok, true)
  const id = startResult.agent.id
  const attached = await invoke(["agents", "attach", id, "--json"])
  if (attached.timedOut) {
    const state = await invoke(["agents", "show", id, "--json"])
    assert.fail(`Agent attach timed out. Current state: ${state.stdout}`)
  }
  assert.equal(attached.code, 0, attached.stderr)
  const result = JSON.parse(attached.stdout)
  assert.equal(result.ok, true)
  assert.equal(result.agent.status, "completed")
  assert.ok(result.agent.messages.some((message) => message.content === "Фоновое исследование завершено."))
  const agentRequest = requests.find((request) => request.path === "/api/code/agent/turn")
  assert.ok(agentRequest)
  assert.equal(agentRequest.cookie, cookie)
  const requestBody = JSON.parse(agentRequest.body)
  assert.equal(requestBody.mode, "plan")
  assert.equal(requestBody.model, "dreyze/test")
  assert.match(requestBody.messages.at(-1).content, /Inspect the project safely/u)
  assert.equal((await store.latest()).id, active.id)
})

test("background Build agents wait for a direct approval before modifying the project", { timeout: 15_000 }, async (t) => {
  const { config, workspace } = await fixture(t)
  const cookie = `__Host-dreyzeai_session=${"c".repeat(64)}`
  const requests = []
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    if (request.url === "/api/code/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ defaultModel: "dreyze/test", data: [{ id: "dreyze/test", name: "Test", group: "test" }] }))
      return
    }
    if (request.url === "/api/code/agent/turn") {
      const turn = JSON.parse(body)
      requests.push(turn)
      response.writeHead(200, { "content-type": "application/json" })
      const toolResults = turn.messages.filter((message) => message.content.startsWith("Tool result (write_file):"))
      const lastToolResult = toolResults.at(-1)?.content || ""
      response.end(JSON.stringify(lastToolResult.includes("Файл создан")
        ? { type: "final", content: "Файл создан после подтверждения." }
        : { type: "tool", name: "write_file", input: lastToolResult.includes("отклонено")
          ? { path: "approved.txt", content: "confirmed content" }
          : { path: "denied.txt", content: "must stay absent" } }))
      return
    }
    response.writeHead(404).end("{}")
  })
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise))
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)))
  const address = server.address()
  const configData = JSON.stringify({ url: `http://127.0.0.1:${address.port}`, cookie })
  for (const folder of [path.join(config, "dreyze-code"), path.join(config, "DreyzeCode")]) {
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, "config.json"), configData, { mode: 0o600 })
  }
  const sessionRoot = process.platform === "win32" ? path.join(config, "DreyzeCode") : path.join(config, "dreyze-code")
  const store = createSessionStore(workspace, sessionRoot)
  const active = await store.create("dreyze/test", "build")
  await store.save(active)
  const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url))
  const environment = { ...process.env, XDG_CONFIG_HOME: config, APPDATA: config }
  const invoke = (args) => new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: workspace, env: environment, stdio: ["ignore", "pipe", "pipe"] })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 10_000)
    let stdoutText = ""
    let stderrText = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdoutText += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderrText += chunk })
    child.once("error", (error) => { clearTimeout(timer); rejectPromise(error) })
    child.once("close", (code) => { clearTimeout(timer); resolvePromise({ code, stdout: stdoutText, stderr: stderrText, timedOut }) })
  })

  const started = await invoke(["agents", "start", "Create approved.txt", "--mode", "build", "--json"])
  assert.equal(started.code, 0, started.stderr)
  const id = JSON.parse(started.stdout).agent.id
  t.after(() => invoke(["agents", "stop", id]).catch(() => {}))
  let pending
  for (let attempt = 0; attempt < 60; attempt++) {
    const shown = await invoke(["agents", "show", id, "--json"])
    assert.equal(shown.code, 0, shown.stderr)
    pending = JSON.parse(shown.stdout).agent
    if (pending.status === "awaiting_approval") break
    if (["failed", "interrupted", "completed"].includes(pending.status)) break
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  assert.equal(pending.status, "awaiting_approval", pending.error || "Agent did not request approval.")
  assert.match(pending.approval.prompt, /denied\.txt/u)
  const firstApprovalId = pending.approval.id
  const denial = await invoke(["agents", "deny", id, "--json"])
  assert.equal(denial.code, 0, denial.stderr)
  assert.equal(JSON.parse(denial.stdout).decision, "denied")
  await assert.rejects(access(path.join(workspace, "denied.txt")), { code: "ENOENT" })
  for (let attempt = 0; attempt < 60; attempt++) {
    const shown = await invoke(["agents", "show", id, "--json"])
    assert.equal(shown.code, 0, shown.stderr)
    pending = JSON.parse(shown.stdout).agent
    if (pending.status === "awaiting_approval" && pending.approval?.id !== firstApprovalId) break
    if (["failed", "interrupted", "completed"].includes(pending.status)) break
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  assert.equal(pending.status, "awaiting_approval", pending.error || "Agent did not ask for a second approval after denial.")
  assert.match(pending.approval.prompt, /approved\.txt/u)
  await assert.rejects(access(path.join(workspace, "approved.txt")), { code: "ENOENT" })
  const approval = await invoke(["agents", "approve", id, "--json"])
  assert.equal(approval.code, 0, approval.stderr)
  assert.equal(JSON.parse(approval.stdout).decision, "approved")
  const attached = await invoke(["agents", "attach", id, "--json"])
  if (attached.timedOut) {
    const state = await invoke(["agents", "show", id, "--json"])
    assert.fail(`Agent attach timed out. Current state: ${state.stdout}`)
  }
  assert.equal(attached.code, 0, attached.stderr)
  assert.equal(JSON.parse(attached.stdout).agent.status, "completed")
  assert.equal(await readFile(path.join(workspace, "approved.txt"), "utf8"), "confirmed content")
  assert.ok(requests.every((turn) => turn.mode === "build"))
  assert.equal((await store.latest()).id, active.id)
})

test("background agents can pause for a question and resume with the user's answer", { timeout: 15_000 }, async (t) => {
  const { config, workspace } = await fixture(t)
  const cookie = `__Host-dreyzeai_session=${"d".repeat(64)}`
  const turns = []
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    if (request.url === "/api/code/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ defaultModel: "dreyze/test", data: [{ id: "dreyze/test", name: "Test", group: "test" }] }))
      return
    }
    if (request.url === "/api/code/agent/turn") {
      const turn = JSON.parse(body)
      turns.push(turn)
      const answered = turn.messages.some((message) => message.content.includes("Ответ на уточнение «Какой цвет сайта?»"))
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(answered
        ? { type: "final", content: "Продолжил с выбранным цветом." }
        : { type: "tool", name: "ask_user", input: { question: "Какой цвет сайта?" } }))
      return
    }
    response.writeHead(404).end("{}")
  })
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise))
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)))
  const address = server.address()
  const configData = JSON.stringify({ url: `http://127.0.0.1:${address.port}`, cookie })
  for (const folder of [path.join(config, "dreyze-code"), path.join(config, "DreyzeCode")]) {
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, "config.json"), configData, { mode: 0o600 })
  }
  const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url))
  const environment = { ...process.env, XDG_CONFIG_HOME: config, APPDATA: config }
  const invoke = (args) => new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: workspace, env: environment, stdio: ["ignore", "pipe", "pipe"] })
    let stdoutText = ""
    let stderrText = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdoutText += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderrText += chunk })
    child.once("error", rejectPromise)
    child.once("close", (code) => resolvePromise({ code, stdout: stdoutText, stderr: stderrText }))
  })

  const started = await invoke(["agents", "start", "Build a site", "--json"])
  assert.equal(started.code, 0, started.stderr)
  const id = JSON.parse(started.stdout).agent.id
  t.after(() => invoke(["agents", "stop", id]).catch(() => {}))
  let pending
  for (let attempt = 0; attempt < 60; attempt++) {
    const shown = await invoke(["agents", "show", id, "--json"])
    assert.equal(shown.code, 0, shown.stderr)
    pending = JSON.parse(shown.stdout).agent
    if (pending.status === "needs_input") break
    if (["failed", "interrupted", "completed"].includes(pending.status)) break
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  assert.equal(pending.status, "needs_input", pending.error || "Agent did not save its question.")
  assert.equal(pending.question, "Какой цвет сайта?")
  const resumed = await invoke(["agents", "answer", id, "синий", "--json"])
  assert.equal(resumed.code, 0, resumed.stderr)
  const attached = await invoke(["agents", "attach", id, "--json"])
  assert.equal(attached.code, 0, attached.stderr)
  assert.equal(JSON.parse(attached.stdout).agent.status, "completed")
  assert.ok(turns.at(-1).messages.some((message) => message.content.includes("синий")))
})

test("cancels a background agent and keeps its state out of the latest-session pointer", { timeout: 5_000 }, async (t) => {
  const { config, workspace } = await fixture(t)
  const store = createSessionStore(workspace, config)
  const active = await store.create("dreyze/test", "build")
  await store.save(active)
  const childStore = store.fork({ updateLatestPointer: false })
  const agent = await childStore.create("dreyze/test", "plan")
  agent.agentJob = { status: "starting", task: "wait until stopped", createdAt: new Date().toISOString(), pid: null }
  await childStore.save(agent, { updateLatest: false })
  assert.equal(backgroundAgentStatus({ ...agent, agentJob: { ...agent.agentJob, status: "running", pid: 2_147_483_647 } }), "interrupted")

  let markRunning
  const running = new Promise((resolvePromise) => { markRunning = resolvePromise })
  const work = runBackgroundAgentWorker({
    id: agent.id,
    workspace,
    store,
    config: { url: "https://moonfacet.example", cookie: "session" },
    catalog: { models: [], defaultModel: "dreyze/test" },
    runTask: ({ signal }) => new Promise((resolvePromise, rejectPromise) => {
      markRunning()
      const cancel = () => rejectPromise(Object.assign(new Error("stopped"), { code: "AGENT_CANCELLED" }))
      if (signal.aborted) cancel()
      else signal.addEventListener("abort", cancel, { once: true })
    }),
  })
  await running
  const stopping = await stopBackgroundAgent({ workspace, id: agent.id, store })
  assert.equal(stopping.requested, true)
  assert.equal((await stopBackgroundAgent({ workspace, id: agent.id, store })).requested, true)
  assert.equal((await work).status, "cancelled")
  assert.equal((await store.load(agent.id)).agentJob.status, "cancelled")
  assert.equal((await store.latest()).id, active.id)
})

test("provides safe platform clipboard commands and copies UTF-8 chat replies", async () => {
  assert.equal(clipboardTargets("darwin")[0].command, "pbcopy")
  assert.equal(clipboardTargets("win32")[0].encoding, "base64")
  assert.deepEqual(clipboardTargets("linux").map(({ command }) => command), ["wl-copy", "xclip", "xsel"])

  const copied = []
  const spawnImpl = (command, args) => {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stderr = new PassThrough()
    let input = ""
    child.stdin.on("data", (chunk) => { input += chunk.toString("utf8") })
    child.stdin.on("end", () => {
      copied.push({ command, args, input })
      setImmediate(() => child.emit("close", 0))
    })
    return child
  }
  const message = "Ответ на русском 👩‍💻"
  assert.equal(await copyToClipboard(message, { platformName: "linux", spawnImpl }), "wl-copy")
  assert.equal(copied[0].input, message)
  assert.equal(await copyToClipboard(message, { platformName: "win32", spawnImpl }), "powershell.exe")
  assert.equal(Buffer.from(copied[1].input.trim(), "base64").toString("utf8"), message)
  assert.match(copied[1].args.at(-1), /Set-Clipboard/u)
})

test("formats chat messages as terminal-safe panels", () => {
  const panel = formatChatMessage("DreyzeCode", "Hello\u001b[31m red\u001b[0m\nNext line", 40)
  const lines = panel.split("\n")
  assert.match(lines[0], /^╭─ DreyzeCode/u)
  assert.match(panel, /│ Hello red/u)
  assert.match(panel, /│ Next line/u)
  assert.doesNotMatch(panel, /\u001b/u)
  assert.equal(lines[0].length, 40)
  assert.ok(lines.slice(1, -1).every((line) => line.length === 40))
  assert.equal(lines.at(-1).length, 40)
})

test("formats the interactive message composer within narrow and wide terminals", () => {
  for (const width of [32, 40, 76]) {
    const composer = formatChatComposer(width)
    assert.match(composer.header, /^╭─ Новое сообщение/u)
    assert.equal(composer.header.length, width)
    assert.equal(composer.footer.length, width)
    assert.equal(composer.prompt, "│ › ")
    assert.match(composer.hint, /Enter —\s*отправить/u)
  }
  const active = formatChatComposer(52, { model: "Dreyze Opus 5.5", mode: "plan", attachments: ["screenshot.png"] })
  const activeText = active.hint.replace(/\n│ ?/gu, " ").replace(/ +│/gu, " ")
  assert.match(activeText, /Модель:\s+Dreyze Opus 5\.5/u)
  assert.match(activeText, /Режим:\s+Plan · только чтение/u)
  assert.match(activeText, /Изображения:\s+screenshot\.png/u)
})

test("renders readable session history without internal tool payloads", () => {
  const history = visibleSessionMessages({
    messages: [
      { role: "user", content: "Describe this picture.", imagePaths: [path.join("assets", "photo.jpg")] },
      { role: "assistant", content: JSON.stringify({ type: "tool", name: "read_file", input: { path: "secret.txt" } }) },
      { role: "user", content: "Tool result (read_file): private tool output" },
      { role: "assistant", content: JSON.stringify({ type: "plan", content: "I will inspect the image and answer." }) },
      { role: "user", content: "Дополнительные папки, явно разрешённые для этой сессии: /tmp/shared." },
      { role: "user", content: "Ответ на уточнение «Which format?»: JPEG" },
      { role: "assistant", content: "It is a JPEG photo." },
    ],
    pendingQuestion: "Should I also crop it?",
  }, 20)
  assert.deepEqual(history.map(({ role }) => role), ["user", "assistant", "user", "assistant", "notice"])
  assert.equal(history[0].attachments[0], "photo.jpg")
  assert.equal(history[1].content, "I will inspect the image and answer.")
  assert.equal(history[2].content, "Уточнение: Which format?\nОтвет: JPEG")
  assert.equal(history.at(-1).content, "Ожидается ответ: Should I also crop it?")
  assert.doesNotMatch(JSON.stringify(history), /private tool output|secret\.txt|shared/u)
})

test("limits rendered message size and session history count", () => {
  const history = visibleSessionMessages({
    messages: Array.from({ length: 35 }, (_, index) => ({ role: "user", content: `${index}:${"x".repeat(3_000)}` })),
  }, 100)
  assert.equal(history.length, 30)
  assert.match(history[0].content, /^5:/u)
  assert.ok(history[0].content.length < 2_600)
  assert.match(history[0].content, /сообщение сокращено/u)
})

test("wraps long chat output to the available terminal width", () => {
  const panel = formatChatMessage("Assistant", "A long sentence that should wrap across a narrow chat panel.", 40)
  const lines = panel.split("\n")
  assert.ok(lines.slice(1, -1).length > 1)
  assert.ok(lines.slice(1, -1).every((line) => line.length === 40))
  assert.match(panel, /should wrap/u)
})

test("keeps Cyrillic and emoji graphemes intact in chat panels", () => {
  const panel = formatChatMessage("Модель 🛰️", "Ответ на русском 👩‍💻 и длинное слово достоверно.", 32)
  assert.match(panel, /Модель 🛰️/u)
  assert.match(panel, /👩‍💻/u)
  assert.match(panel, /достоверно/u)
  assert.doesNotMatch(panel, /�/u)
})

test("runs authenticated web search as a read-only agent tool", async (t) => {
  const { workspace, config } = await fixture(t)
  const store = createSessionStore(workspace, config)
  const session = await store.create("dreyze/research", "plan")
  session.messages.push({ role: "user", content: "Find the current Node.js fetch documentation." })
  const requests = []
  const events = []
  const result = await runAgentTask({
    config: { url: "https://moonfacet.example", cookie: "__Host-dreyzeai_session=abc" },
    catalog: { models: [], defaultModel: "dreyze/research" },
    session,
    store,
    roots: [workspace],
    workspace,
    question: async () => "",
    onOutput: () => {},
    onEvent: (event) => events.push(event),
    fetchImpl: async (url, init) => {
      const parsedUrl = new URL(url)
      requests.push({ url: parsedUrl.pathname, init })
      if (parsedUrl.pathname === "/api/code/agent/search") {
        assert.equal(init.method, "POST")
        assert.equal(init.headers.Cookie, "__Host-dreyzeai_session=abc")
        assert.equal(init.redirect, "error")
        assert.deepEqual(JSON.parse(init.body), { query: "Node.js fetch documentation" })
        return Response.json({ query: "Node.js fetch documentation", sources: [{
          title: "Node.js fetch",
          url: "https://nodejs.org/api/globals.html#fetch",
          snippet: "A browser-compatible implementation of the Fetch API.",
        }] })
      }
      assert.equal(parsedUrl.pathname, "/api/code/agent/turn")
      const requestBody = JSON.parse(init.body)
      assert.equal(requestBody.mode, "plan")
      assert.equal(requestBody.shell, process.platform === "win32" ? "powershell" : "posix")
      if (requests.filter((request) => request.url === "/api/code/agent/turn").length === 1) {
        return Response.json({ type: "tool", name: "web_search", input: { query: "Node.js fetch documentation" } })
      }
      assert.match(requestBody.messages.at(-1).content, /Node\.js fetch/u)
      assert.match(requestBody.messages.at(-1).content, /nodejs\.org/u)
      return Response.json({ type: "final", content: "The official documentation describes a browser-compatible Fetch API." })
    },
  })
  assert.equal(requests.length, 3)
  assert.equal(result.final, "The official documentation describes a browser-compatible Fetch API.")
  assert.ok(session.messages.some((message) => message.content.startsWith("Tool result (web_search):")))
  assert.deepEqual(events.filter((event) => event.type === "tool_use").map((event) => event.name), ["web_search"])
  assert.deepEqual(events.filter((event) => event.type === "tool_result").map((event) => event.succeeded), [true])
  assert.equal(events.at(-1).type, "assistant")
  assert.equal(events.at(-1).subtype, "final")
})

test("cancels an in-flight model request and leaves the conversation resumable", async (t) => {
  const { workspace, config } = await fixture(t)
  const store = createSessionStore(workspace, config)
  const session = await store.create("dreyze/test-model", "build")
  session.messages.push({ role: "user", content: "Create a project and explain the result." })
  await store.save(session)
  const cancellation = new AbortController()
  let requestSignal
  await assert.rejects(runAgentTask({
    config: { url: "https://moonfacet.example", cookie: "session" },
    catalog: { models: [], defaultModel: "dreyze/test-model" },
    session,
    store,
    roots: [workspace],
    workspace,
    question: async () => "",
    signal: cancellation.signal,
    fetchImpl: async (_url, init) => {
      requestSignal = init.signal
      cancellation.abort()
      if (init.signal.aborted) throw init.signal.reason
      await new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }))
    },
  }), { code: "AGENT_CANCELLED" })
  assert.equal(requestSignal?.aborted, true)
  const saved = await store.load(session.id)
  assert.equal(saved.messages.at(-1).content, "Create a project and explain the result.")
  assert.equal(saved.pendingAction, null)
})

test("cancels a file change at its approval prompt before writing begins", async (t) => {
  const { workspace, config } = await fixture(t)
  const store = createSessionStore(workspace, config)
  const session = await store.create("dreyze/test-model", "build")
  session.messages.push({ role: "user", content: "Create a file." })
  const cancellation = new AbortController()
  await assert.rejects(runAgentTask({
    config: { url: "https://moonfacet.example", cookie: "session" },
    catalog: { models: [], defaultModel: "dreyze/test-model" },
    session,
    store,
    roots: [workspace],
    workspace,
    signal: cancellation.signal,
    question: async () => {
      cancellation.abort()
      return ""
    },
    fetchImpl: async () => Response.json({
      type: "tool",
      name: "write_file",
      input: { path: "cancelled.txt", content: "must not be written" },
    }),
  }), { code: "AGENT_CANCELLED" })
  await assert.rejects(readFile(path.join(workspace, "cancelled.txt"), "utf8"), { code: "ENOENT" })
  assert.equal((await store.load(session.id)).pendingAction, null)
})

test("reports which local tool the agent is running and clears its activity state", async (t) => {
  const { workspace, config } = await fixture(t)
  await writeFile(path.join(workspace, "notes.txt"), "Saved project notes.")
  const store = createSessionStore(workspace, config)
  const session = await store.create("dreyze/research", "plan")
  session.messages.push({ role: "user", content: "Read the project notes." })
  const activities = []
  let turns = 0
  const result = await runAgentTask({
    config: { url: "https://moonfacet.example", cookie: "__Host-dreyzeai_session=abc" },
    catalog: { models: [], defaultModel: "dreyze/research" },
    session,
    store,
    roots: [workspace],
    workspace,
    question: async () => null,
    onOutput: () => {},
    onActivity: (activity, step) => {
      activities.push({ phase: "start", activity, step })
      return () => activities.push({ phase: "stop", activity, step })
    },
    fetchImpl: async () => {
      turns++
      return turns === 1
        ? Response.json({ type: "tool", name: "read_file", input: { path: "notes.txt" } })
        : Response.json({ type: "final", content: "The notes say the project notes are saved." })
    },
  })
  assert.equal(result.final, "The notes say the project notes are saved.")
  assert.deepEqual(activities, [
    { phase: "start", activity: "читаю файл проекта", step: 0 },
    { phase: "stop", activity: "читаю файл проекта", step: 0 },
  ])
})

test("connects to a confirmed stdio MCP server and redacts its configured secrets", async (t) => {
  const { workspace } = await fixture(t)
  const secret = "mcp-fixture-private-value-7821"
  process.env.DREYZE_MCP_TEST_SECRET = secret
  t.after(() => { delete process.env.DREYZE_MCP_TEST_SECRET })
  await mkdir(path.join(workspace, ".dreyze"), { recursive: true })
  const serverScript = fileURLToPath(new URL("../fixtures/mcp-stdio-server.mjs", import.meta.url))
  await writeFile(path.join(workspace, ".dreyze", "mcp.json"), JSON.stringify({
    mcpServers: {
      local_docs: {
        command: process.execPath,
        args: [serverScript],
        cwd: ".",
        env: { MCP_ECHO_SECRET: "${DREYZE_MCP_TEST_SECRET}" },
      },
    },
  }))
  const listed = await listConfiguredMcpServers({ roots: [workspace], userConfigPath: path.join(workspace, "missing-mcp.json") })
  assert.equal(listed.servers.length, 1)
  assert.equal(listed.servers[0].type, "stdio")
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(secret, "u"))

  const registry = await connectMcpServers({
    roots: [workspace],
    userConfigPath: path.join(workspace, "missing-mcp.json"),
    approveServer: async () => true,
  })
  try {
    assert.equal(registry.tools.length, 1)
    assert.equal(registry.tools[0].name, "mcp.project_1_local_docs.echo")
    assert.equal(JSON.stringify(registry.tools).includes(secret), false)
    assert.equal(registry.tools[0].inputSchema.properties.apiKey.const, "[SECRET OMITTED]")
    const output = await registry.call(registry.tools[0].name, { query: "hello" })
    assert.match(output.output, /hello/u)
    assert.match(output.output, /\[SECRET OMITTED\]/u)
    assert.match(output.output, /Bearer \[SECRET OMITTED\]/u)
    assert.match(output.output, /cookie=\[SECRET OMITTED\]/u)
    assert.doesNotMatch(output.output, new RegExp(secret, "u"))
    assert.doesNotMatch(output.output, /mcp-fixture-bearer-token|mcp-cookie-value/u)
  } finally {
    await registry.close()
  }
})

test("rejects project MCP working directories that escape through symlinks", async (t) => {
  const { root, workspace } = await fixture(t)
  const outside = path.join(root, "outside")
  const linked = path.join(workspace, "linked")
  await mkdir(outside)
  await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir")
  await mkdir(path.join(workspace, ".dreyze"), { recursive: true })
  await writeFile(path.join(workspace, ".dreyze", "mcp.json"), JSON.stringify({
    mcpServers: {
      escaped: { command: process.execPath, args: [], cwd: "linked" },
    },
  }))

  const result = await listConfiguredMcpServers({ roots: [workspace], userConfigPath: path.join(root, "missing-mcp.json") })
  assert.equal(result.servers.length, 0)
  assert.match(result.issues.join("\n"), /внутри разрешённой папки/u)
})

test("routes agent MCP calls through server discovery and asks before invocation", async (t) => {
  const { workspace, config } = await fixture(t)
  const secret = "mcp-agent-private-value-4309"
  process.env.DREYZE_MCP_TEST_SECRET = secret
  t.after(() => { delete process.env.DREYZE_MCP_TEST_SECRET })
  await mkdir(path.join(workspace, ".dreyze"), { recursive: true })
  const serverScript = fileURLToPath(new URL("../fixtures/mcp-stdio-server.mjs", import.meta.url))
  await writeFile(path.join(workspace, ".dreyze", "mcp.json"), JSON.stringify({
    mcpServers: {
      local_docs: {
        command: process.execPath,
        args: [serverScript],
        cwd: ".",
        env: { MCP_ECHO_SECRET: "${DREYZE_MCP_TEST_SECRET}" },
      },
    },
  }))
  const store = createSessionStore(workspace, config)
  const session = await store.create("dreyze/test-model", "build")
  session.messages.push({ role: "user", content: "Look up project guidance." })
  const prompts = []
  let calls = 0
  const result = await runAgentTask({
    config: { url: "https://moonfacet.example", cookie: "session" },
    catalog: { models: [], defaultModel: "dreyze/test-model" },
    session,
    store,
    roots: [workspace],
    workspace,
    question: async (prompt) => { prompts.push(prompt); return "y" },
    onOutput: () => {},
    fetchImpl: async (_url, init) => {
      calls++
      const requestBody = JSON.parse(init.body)
      if (calls === 1) {
        assert.equal(requestBody.mcpTools[0].name, "mcp.project_1_local_docs.echo")
        return Response.json({
          type: "tool",
          name: "mcp.project_1_local_docs.echo",
          input: { query: "project setup" },
        })
      }
      const observation = requestBody.messages.at(-1).content
      assert.match(observation, /project setup/u)
      assert.match(observation, /\[SECRET OMITTED\]/u)
      assert.doesNotMatch(observation, new RegExp(secret, "u"))
      return Response.json({ type: "final", content: "The configured tool returned the project setup information." })
    },
  })
  assert.equal(result.final, "The configured tool returned the project setup information.")
  assert.equal(calls, 2)
  assert.equal(prompts.length, 2)
  assert.match(prompts[0], /Запустить MCP сервер/u)
  assert.match(prompts[1], /Вызвать внешний MCP инструмент/u)
  assert.ok(session.messages.some((message) => message.content.startsWith("Tool result (mcp.project_1_local_docs.echo):")))
})

test("validates local image signatures and keeps image bytes out of saved session messages", async (t) => {
  const { workspace, config } = await fixture(t)
  const image = path.join(workspace, "photo.png")
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
  await writeFile(image, signature)
  const references = await validateImagePaths(["photo.png"], [workspace])
  assert.deepEqual(references, [{ path: image, name: "photo.png", type: "image/png", size: signature.length }])

  const session = await createSessionStore(workspace, config).create("dreyze/test-model", "build")
  session.messages.push({ role: "user", content: "Describe this image.", imagePaths: references.map((item) => item.path) })
  const store = createSessionStore(workspace, config)
  await store.save(session)
  const loaded = await store.load(session.id)
  assert.deepEqual(loaded.messages[0].imagePaths, [image])
  assert.equal(JSON.stringify(loaded).includes(signature.toString("base64")), false)
  await assert.rejects(validateImagePaths(["../outside.png"], [workspace]), /вне папок/u)
})

test("sends an attached image to a vision model and refuses it for a text-only model", async (t) => {
  const { workspace, config } = await fixture(t)
  const imagePath = path.join(workspace, "screen.png")
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6])
  await writeFile(imagePath, bytes)
  const store = createSessionStore(workspace, config)
  const session = await store.create("dreyze/vision", "build")
  session.messages.push({ role: "user", content: "Что на изображении?", imagePaths: [imagePath] })
  let calls = 0
  const result = await runAgentTask({
    config: { url: "https://moonfacet.example", cookie: "session" },
    catalog: { models: [{ id: "dreyze/vision", supportsImages: true }], defaultModel: "dreyze/vision" },
    session,
    store,
    roots: [workspace],
    workspace,
    question: async () => "",
    fetchImpl: async (_url, init) => {
      calls++
      const request = JSON.parse(init.body)
      assert.equal(request.messages.at(-1).attachments[0].type, "image/png")
      assert.equal(request.messages.at(-1).attachments[0].size, bytes.length)
      assert.equal(request.messages.at(-1).attachments[0].data, `data:image/png;base64,${bytes.toString("base64")}`)
      return Response.json({ type: "final", content: "Вижу изображение." })
    },
  })
  assert.equal(calls, 1)
  assert.equal(result.final, "Вижу изображение.")

  session.model = "dreyze/text"
  await assert.rejects(runAgentTask({
    config: { url: "https://moonfacet.example", cookie: "session" },
    catalog: { models: [{ id: "dreyze/text", supportsImages: false }], defaultModel: "dreyze/text" },
    session,
    store,
    roots: [workspace],
    workspace,
    question: async () => "",
    fetchImpl: async () => { throw new Error("Text-only model must be rejected before fetch") },
  }), /не принимает изображения/u)
})

test("loads root and nested project guides while skipping generated and linked folders", async (t) => {
  const { workspace, root } = await fixture(t)
  await mkdir(path.join(workspace, "src"), { recursive: true })
  await mkdir(path.join(workspace, "node_modules", "fake"), { recursive: true })
  await mkdir(path.join(workspace, ".dreyze"), { recursive: true })
  await writeFile(path.join(workspace, "AGENTS.md"), "Use the existing project style.\nGITHUB_TOKEN=ghp_123456789012345678901234567890\n")
  await writeFile(path.join(workspace, "src", "AGENTS.md"), "For src, follow its local conventions.\n")
  await writeFile(path.join(workspace, ".dreyze", "instructions.md"), "Use Dreyze project tooling.\n")
  await writeFile(path.join(workspace, "node_modules", "fake", "AGENTS.md"), "Ignore this dependency guide.\n")
  const outsideGuide = path.join(root, "outside-AGENTS.md")
  await writeFile(outsideGuide, "Do not follow linked files.\n")
  try {
    await symlink(outsideGuide, path.join(workspace, "linked-AGENTS.md"), "file")
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip("Windows runner does not permit creating symlinks")
      return
    }
    throw error
  }

  const guides = await loadProjectInstructions([workspace])
  assert.deepEqual(guides.map((guide) => guide.path), ["./.dreyze/instructions.md", "./AGENTS.md", "./src/AGENTS.md"])
  assert.match(guides.find((guide) => guide.path === "./AGENTS.md").content, /existing project style/u)
  assert.doesNotMatch(guides.find((guide) => guide.path === "./AGENTS.md").content, /123456789012345678901234567890/u)
  assert.equal(guides.some((guide) => guide.content.includes("dependency guide")), false)
  assert.equal(guides.some((guide) => guide.content.includes("linked files")), false)
})

test("discovers project skills from their safe metadata without loading skill bodies", async (t) => {
  const { workspace } = await fixture(t)
  const skillDir = path.join(workspace, ".dreyze", "skills", "interface-review")
  await mkdir(skillDir, { recursive: true })
  await writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: Interface Review",
    "description: Review layout, responsive behavior, and accessibility.",
    "---",
    "",
    "Do a focused review and include concrete file references.",
  ].join("\n"))
  const releaseDir = path.join(workspace, ".dreyze", "skills", "release")
  await mkdir(releaseDir, { recursive: true })
  await writeFile(path.join(releaseDir, "SKILL.md"), [
    "---",
    "name: Release Checklist",
    "description: >-",
    "  Check release gates",
    "  before publishing.",
    "---",
    "",
    "The complete skill body stays local until the model selects this skill.",
  ].join("\n"))

  const skills = await loadProjectSkills([workspace])
  assert.deepEqual(skills, [
    {
      name: "Interface Review",
      commandName: "interface-review",
      path: "./.dreyze/skills/interface-review/SKILL.md",
      description: "Review layout, responsive behavior, and accessibility.",
    },
    {
      name: "Release Checklist",
      commandName: "release",
      path: "./.dreyze/skills/release/SKILL.md",
      description: "Check release gates before publishing.",
    },
  ])
})

test("loads a selected skill body locally for its slash command and user task", async (t) => {
  const { workspace } = await fixture(t)
  const skillDirectory = path.join(workspace, ".dreyze", "skills", "проверка-проекта")
  await mkdir(skillDirectory, { recursive: true })
  await writeFile(path.join(skillDirectory, "SKILL.md"), [
    "---",
    "name: Project Review",
    "description: Review the project structure.",
    "---",
    "",
    "Inspect the project and report concrete findings.",
  ].join("\n"))

  const [skill] = await loadProjectSkills([workspace])
  assert.equal(skill.commandName, "проверка-проекта")
  const prompt = await buildSkillPrompt(skill, [workspace], "Найди важные проблемы")
  assert.match(prompt, /Inspect the project and report concrete findings\./u)
  assert.match(prompt, /Найди важные проблемы/u)
  assert.doesNotMatch(prompt, /description: Review the project structure/u)
})

test("discovers personal slash skills without adding the personal directory to project roots", async (t) => {
  const { workspace, config } = await fixture(t)
  const projectDir = path.join(workspace, ".dreyze", "skills", "project-check")
  await mkdir(projectDir, { recursive: true })
  await writeFile(path.join(projectDir, "SKILL.md"), "---\nname: Project Check\ndescription: Project rules.\n---\n")
  const userSkillsRoot = path.join(config, "dreyze-code", "skills")
  const skillDir = path.join(userSkillsRoot, "my-check")
  await mkdir(skillDir, { recursive: true })
  await writeFile(path.join(skillDir, "SKILL.md"), [
    "---",
    "name: My Check",
    "description: Check any repository using my own checklist.",
    "---",
    "",
    "Inspect the current repository and report concise findings.",
  ].join("\n"))
  const projectSkills = await loadProjectSkills([workspace])
  const skills = await loadAvailableSkills([workspace], { userSkillsRoot })
  const personal = await loadUserSkills({ userSkillsRoot, existingSkills: projectSkills })
  assert.deepEqual(personal, [{
    name: "My Check",
    commandName: "my-check",
    path: "@user/skills/my-check/SKILL.md",
    description: "Check any repository using my own checklist.",
  }])
  assert.deepEqual(skills, [...projectSkills, ...personal])
  assert.deepEqual(skills.map(({ path: skillPath }) => skillPath), [
    "./.dreyze/skills/project-check/SKILL.md",
    "@user/skills/my-check/SKILL.md",
  ])
  const prompt = await buildSkillPrompt(personal[0], [], "Review this project", { userSkillsRoot })
  assert.match(prompt, /личный skill «My Check»/u)
  assert.match(prompt, /Inspect the current repository/u)
  assert.match(prompt, /Review this project/u)
})

test("creates personal and project slash skill templates without overwriting files", async (t) => {
  const { workspace, config } = await fixture(t)
  const userSkillsRoot = path.join(config, "dreyze-code", "skills")
  const personal = await createSkillScaffold({ name: "my-review", scope: "personal", workspace, userSkillsRoot })
  assert.deepEqual(personal, {
    name: "my-review",
    commandName: "my-review",
    path: "@user/skills/my-review/SKILL.md",
    description: "Опишите, когда использовать эту команду.",
  })
  const personalBody = await readFile(path.join(userSkillsRoot, "my-review", "SKILL.md"), "utf8")
  assert.match(personalBody, /^---\nname: my-review\n/u)
  assert.match(personalBody, /## Инструкции/u)
  if (process.platform !== "win32") assert.equal((await stat(path.join(userSkillsRoot, "my-review", "SKILL.md"))).mode & 0o777, 0o600)
  assert.equal((await loadUserSkills({ userSkillsRoot }))[0].commandName, "my-review")
  await assert.rejects(
    createSkillScaffold({ name: "my-review", scope: "personal", workspace, userSkillsRoot }),
    /уже существует/u,
  )

  const project = await createSkillScaffold({ name: "проверка", scope: "project", workspace, userSkillsRoot })
  assert.equal(project.path, "./.dreyze/skills/проверка/SKILL.md")
  assert.equal((await loadProjectSkills([workspace]))[0].commandName, "проверка")
  if (process.platform !== "win32") {
    const projectMode = (await stat(path.join(workspace, ".dreyze", "skills", "проверка", "SKILL.md"))).mode & 0o777
    assert.equal(projectMode & 0o600, 0o600)
    assert.equal(projectMode & 0o022, 0)
  }
})

test("refuses invalid or built-in slash skill names", async (t) => {
  const { workspace, config } = await fixture(t)
  const userSkillsRoot = path.join(config, "dreyze-code", "skills")
  await assert.rejects(
    createSkillScaffold({ name: "../escape", scope: "personal", workspace, userSkillsRoot }),
    /Имя skill/u,
  )
  await assert.rejects(
    createSkillScaffold({ name: "review", scope: "personal", workspace, userSkillsRoot }),
    /уже используется встроенной командой/u,
  )
})

test("refuses to create a project skill through a linked configuration folder", async (t) => {
  const { root, workspace, config } = await fixture(t)
  const outside = path.join(root, "outside-dreyze")
  await mkdir(outside)
  try {
    await symlink(outside, path.join(workspace, ".dreyze"), process.platform === "win32" ? "junction" : "dir")
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip("Windows runner does not permit creating symlinks")
      return
    }
    throw error
  }
  await assert.rejects(
    createSkillScaffold({ name: "safe-command", scope: "project", workspace, userSkillsRoot: path.join(config, "skills") }),
    /символическую ссылку/u,
  )
  assert.deepEqual(await readdir(outside), [])
})

test("project slash skills take precedence over same-named personal skills", async (t) => {
  const { workspace, config } = await fixture(t)
  const projectSkill = path.join(workspace, ".dreyze", "skills", "release")
  const personalSkill = path.join(config, "dreyze-code", "skills", "release")
  await mkdir(projectSkill, { recursive: true })
  await mkdir(personalSkill, { recursive: true })
  await writeFile(path.join(projectSkill, "SKILL.md"), "---\nname: Project Release\n---\n")
  await writeFile(path.join(personalSkill, "SKILL.md"), "---\nname: Personal Release\n---\n")
  const skills = await loadAvailableSkills([workspace], { userSkillsRoot: path.join(config, "dreyze-code", "skills") })
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, "Project Release")
  assert.equal(skills[0].path, "./.dreyze/skills/release/SKILL.md")
})

test("does not discover or load personal skills through symlinks", async (t) => {
  const { root, config } = await fixture(t)
  const userSkillsRoot = path.join(config, "dreyze-code", "skills")
  const skillDir = path.join(userSkillsRoot, "linked")
  await mkdir(skillDir, { recursive: true })
  const outside = path.join(root, "outside-SKILL.md")
  await writeFile(outside, "Do not load instructions through links.\n")
  try {
    await symlink(outside, path.join(skillDir, "SKILL.md"), "file")
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip("Windows runner does not permit creating symlinks")
      return
    }
    throw error
  }
  assert.deepEqual(await loadUserSkills({ userSkillsRoot }), [])
  await assert.rejects(
    buildSkillPrompt({ name: "Linked", path: "@user/skills/linked/SKILL.md" }, [], "", { userSkillsRoot }),
    /символическую ссылку/u,
  )
})

test("rejects traversal paths for personal slash skills", async (t) => {
  const { config } = await fixture(t)
  const userSkillsRoot = path.join(config, "dreyze-code", "skills")
  await mkdir(userSkillsRoot, { recursive: true })
  await assert.rejects(
    buildSkillPrompt({ name: "Unsafe", path: "@user/skills/../../outside/SKILL.md" }, [], "", {
      userSkillsRoot,
    }),
    /Путь к личному skill некорректен/u,
  )
})

test("refuses a slash skill path outside the selected workspace", async (t) => {
  const { workspace } = await fixture(t)
  await assert.rejects(
    buildSkillPrompt({ name: "Unsafe", path: "./../outside/SKILL.md" }, [workspace]),
    /вне папок/u,
  )
})

test("lists workspace skills without requiring a Dreyze login", async (t) => {
  const { workspace, config } = await fixture(t)
  const skillDir = path.join(workspace, ".dreyze", "skills", "release")
  await mkdir(skillDir, { recursive: true })
  await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: Release\ndescription: Release checklist.\n---\n")
  const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url))
  const child = spawnSync(process.execPath, [cli, "--json", "skills", "list"], {
    cwd: workspace,
    env: { ...process.env, XDG_CONFIG_HOME: config },
    encoding: "utf8",
  })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout).skills, [{
    name: "Release",
    commandName: "release",
    path: "./.dreyze/skills/release/SKILL.md",
    description: "Release checklist.",
  }])
})

test("lists personal slash skills without requiring a Dreyze login", async (t) => {
  const { workspace, config } = await fixture(t)
  const userConfigRoot = process.platform === "win32" ? path.join(config, "DreyzeCode") : path.join(config, "dreyze-code")
  const skillDir = path.join(userConfigRoot, "skills", "my-review")
  await mkdir(skillDir, { recursive: true })
  await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: My Review\ndescription: My personal checklist.\n---\n")
  const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url))
  const child = spawnSync(process.execPath, [cli, "--json", "skills", "list"], {
    cwd: workspace,
    env: process.platform === "win32"
      ? { ...process.env, APPDATA: config }
      : { ...process.env, XDG_CONFIG_HOME: config },
    encoding: "utf8",
  })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout).skills, [{
    name: "My Review",
    commandName: "my-review",
    path: "@user/skills/my-review/SKILL.md",
    description: "My personal checklist.",
  }])
})

test("creates a personal slash command from the CLI without a login", async (t) => {
  const { workspace, config } = await fixture(t)
  const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url))
  const env = process.platform === "win32"
    ? { ...process.env, APPDATA: config }
    : { ...process.env, XDG_CONFIG_HOME: config }
  const child = spawnSync(process.execPath, [cli, "--json", "skills", "create", "personal", "my-command"], {
    cwd: workspace,
    env,
    encoding: "utf8",
  })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), {
    ok: true,
    skill: {
      name: "my-command",
      commandName: "my-command",
      path: "@user/skills/my-command/SKILL.md",
      description: "Опишите, когда использовать эту команду.",
    },
  })
})

test("rejects traversal, symlink escapes, and sensitive reads", async (t) => {
  const { workspace, root } = await fixture(t)
  const outside = path.join(root, "outside")
  await mkdir(outside)
  await writeFile(path.join(outside, "private.txt"), "do not follow")
  await writeFile(path.join(workspace, ".env.local"), "SECRET=abcdefgh")
  await assert.rejects(resolveWorkspacePath("../outside/file.txt", [workspace]), /вне папок/u)
  await assert.rejects(resolveWorkspacePath(".env.local", [workspace]), /секретных файлов/u)
  try {
    await symlink(outside, path.join(workspace, "escape"), process.platform === "win32" ? "junction" : undefined)
    await symlink(path.join(outside, "private.txt"), path.join(workspace, "file-link"), "file")
    await symlink(path.join(workspace, ".env.local"), path.join(workspace, "ordinary-name"), "file")
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip("Windows runner does not permit creating symlinks")
      return
    }
    throw error
  }
  await assert.rejects(resolveWorkspacePath("escape/file.txt", [workspace]), /символьную ссылку/u)
  await assert.rejects(resolveWorkspacePath("file-link", [workspace]), /символьную ссылку/u)
  await assert.rejects(resolveWorkspacePath("ordinary-name", [workspace]), /секретных файлов/u)
  assert.equal(isSensitivePath("/project/id_ed25519"), true)
  assert.equal(isSensitivePath("/project/src/tokenizer.ts"), false)
})

test("runs approved commands in the platform shell", async (t) => {
  const { workspace } = await fixture(t)
  const command = process.platform === "win32"
    ? "Write-Output 'Dreyze shell execution verified'"
    : "printf 'Dreyze shell execution verified\\n'"
  const result = await executeTool({ name: "run_command", input: { command } }, {
    workspace,
    roots: [workspace],
    approve: async () => true,
    question: async () => null,
  })
  assert.match(result.output, /Код завершения: 0/u)
  assert.match(result.output, /Dreyze shell execution verified/u)
})

test("streams approved shell output before the command exits", { timeout: 5_000 }, async (t) => {
  const { workspace } = await fixture(t)
  const command = process.platform === "win32"
    ? "Write-Output 'stream-started'; Start-Sleep -Milliseconds 300; Write-Output 'stream-finished'"
    : "printf 'stream-started\\n'; sleep 0.3; printf 'stream-finished\\n'"
  let resolveFirstOutput
  const firstOutput = new Promise((resolvePromise) => { resolveFirstOutput = resolvePromise })
  let settled = false
  let flushed = false
  const chunks = []
  const execution = executeTool({ name: "run_command", input: { command } }, {
    workspace,
    roots: [workspace],
    approve: async () => true,
    question: async () => null,
    onToolOutput: (chunk, options) => {
      if (chunk) {
        chunks.push(chunk)
        if (chunk.includes("stream-started")) resolveFirstOutput()
      }
      if (options?.flush) flushed = true
    },
  }).finally(() => { settled = true })
  await firstOutput
  assert.equal(settled, false)
  const result = await execution
  assert.ok(flushed)
  assert.match(chunks.join(""), /stream-started/u)
  assert.match(result.output, /stream-finished/u)
})

test("formats live shell output safely and limits each command preview", () => {
  const lines = []
  const stream = createLiveToolOutputStream((line) => lines.push(line), 100)
  stream("sk-abcdefghijklmnop")
  stream("qrstuvwxyz123456\n\u001b[31mred\u001b[0m\n", { flush: true })
  assert.deepEqual(lines, ["[API KEY OMITTED]", "red"])

  const limited = []
  const limitedStream = createLiveToolOutputStream((line) => limited.push(line), 10)
  limitedStream("123456789012\nnext\n", { flush: true })
  assert.deepEqual(limited, ["1234567890", "[Потоковый вывод сокращён до 10 символов.]"])

  const longLine = []
  const longLineStream = createLiveToolOutputStream((line) => longLine.push(line))
  longLineStream("x".repeat(4_001) + "sk-abcdefghijklmnop")
  longLineStream("\nnext\n", { flush: true })
  assert.deepEqual(longLine, ["[Длинная строка пропущена в потоке вывода.]", "next"])

  const privateKey = []
  const privateKeyStream = createLiveToolOutputStream((line) => privateKey.push(line))
  privateKeyStream("-----BEGIN PRIVATE KEY-----\n")
  privateKeyStream("secret-key-material\n-----END PRIVATE KEY-----\npublic output\n", { flush: true })
  assert.deepEqual(privateKey, ["[PRIVATE KEY OMITTED]", "public output"])
})

test("keeps UTF-8 characters intact when shell output splits a character across chunks", async (t) => {
  const { workspace } = await fixture(t)
  const scriptPath = path.join(workspace, "split-utf8-output.cjs")
  await writeFile(scriptPath, "process.stdout.write(Buffer.from([0xd0])); setTimeout(() => process.stdout.write(Buffer.from([0x96])), 100)")
  const command = process.platform === "win32"
    ? `& "${process.execPath.replaceAll('"', '""')}" "${scriptPath.replaceAll('"', '""')}"`
    : `"${process.execPath}" "${scriptPath}"`
  const streamed = []
  const result = await executeTool({ name: "run_command", input: { command } }, {
    workspace,
    roots: [workspace],
    approve: async () => true,
    question: async () => null,
    onToolOutput: (chunk) => streamed.push(chunk),
  })
  assert.match(result.output, /Ж/u)
  assert.match(streamed.join(""), /Ж/u)
})

test("stops a running shell command when the agent task is cancelled", async (t) => {
  const { workspace } = await fixture(t)
  const controller = new AbortController()
  const startedMarker = path.join(workspace, "cancel-child-started.txt")
  const lateMarker = path.join(workspace, "cancel-child-late.txt")
  const childScriptPath = path.join(workspace, "cancel-child.js")
  await writeFile(childScriptPath, `require("fs").writeFileSync(${JSON.stringify(startedMarker)},"started"); setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(lateMarker)},"late"),1500)`)
  const command = process.platform === "win32"
    ? `& "${process.execPath.replaceAll('"', '""')}" "${childScriptPath.replaceAll('"', '""')}"`
    : "sleep 2"
  const execution = executeTool({ name: "run_command", input: { command } }, {
    workspace,
    roots: [workspace],
    approve: async () => true,
    question: async () => null,
    signal: controller.signal,
  })
  if (process.platform === "win32") {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && !(await access(startedMarker).then(() => true, () => false))) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
    }
    assert.equal(await access(startedMarker).then(() => true, () => false), true, "the PowerShell child should start before cancellation")
  } else {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  const cancellationStartedAt = Date.now()
  controller.abort()
  const result = await execution
  assert.ok(Date.now() - cancellationStartedAt < 1_500, "the shell process should stop promptly")
  assert.notEqual(result.code, 0)
  if (process.platform === "win32") {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_700))
    await assert.rejects(readFile(lateMarker, "utf8"), { code: "ENOENT" }, "cancellation should stop the spawned process tree")
  }
})

test("denies a file write unless the user approves it", async (t) => {
  const { workspace } = await fixture(t)
  const destination = path.join(workspace, "new.txt")
  const result = await executeTool({
    name: "write_file",
    input: { path: "new.txt", content: "must not be written" },
  }, {
    workspace,
    roots: [workspace],
    question: async () => "n",
  })
  assert.match(result.output, /отклонено/u)
  await assert.rejects(readFile(destination, "utf8"), { code: "ENOENT" })
})

test("shows a safe, bounded preview before asking to write a file", async (t) => {
  const { workspace } = await fixture(t)
  let prompt = ""
  const result = await executeTool({
    name: "write_file",
    input: { path: "new.txt", content: `hello\n\u001b[2Jhidden terminal control` },
  }, {
    workspace,
    roots: [workspace],
    question: async (value) => { prompt = value; return "n" },
  })
  assert.match(prompt, /hello/u)
  assert.match(prompt, /ANSI control omitted/u)
  assert.doesNotMatch(prompt, /\u001b/u)
  assert.match(result.output, /отклонено/u)
  await assert.rejects(readFile(path.join(workspace, "new.txt"), "utf8"), { code: "ENOENT" })

  let commandPrompt = ""
  const commandResult = await executeTool({
    name: "run_command",
    input: { command: `echo safe\u001b[2Jhidden ghp_${"x".repeat(30)}` },
  }, {
    workspace,
    roots: [workspace],
    question: async (value) => { commandPrompt = value; return "n" },
  })
  assert.match(commandPrompt, /ANSI control omitted/u)
  assert.doesNotMatch(commandPrompt, /\u001b|ghp_x{30}/u)
  assert.match(commandResult.output, /отклонено/u)
})

test("renames a project folder and refuses to move a folder into itself", async (t) => {
  const { workspace } = await fixture(t)
  await mkdir(path.join(workspace, "old-name"))
  const moved = await executeTool({
    name: "move_file",
    input: { source: "old-name", destination: "new-name" },
  }, {
    workspace,
    roots: [workspace],
    question: async () => "yes",
  })
  assert.match(moved.output, /Перемещено/u)
  assert.equal(await realpath(path.join(workspace, "new-name")), path.join(workspace, "new-name"))
  await assert.rejects(realpath(path.join(workspace, "old-name")), { code: "ENOENT" })
  await assert.rejects(executeTool({
    name: "move_file",
    input: { source: "new-name", destination: "new-name/child" },
  }, {
    workspace,
    roots: [workspace],
    question: async () => "yes",
  }), /внутрь самой себя/u)
})

test("rewinds direct file changes and removes the selected turn from the conversation", async (t) => {
  const { workspace, config } = await fixture(t)
  const store = createSessionStore(workspace, config)
  const session = await store.create("dreyze/test-model", "build")
  const checkpoint = await beginTurnCheckpoint(session, store, "Update the file")
  session.messages.push({ role: "user", content: "Update the file", checkpointId: checkpoint.id })
  await store.save(session)
  const target = path.join(workspace, "existing.txt")
  await writeFile(target, "before")
  const onCheckpoint = (change) => recordCheckpointChange(session, store, checkpoint.id, change)
  await executeTool({ name: "write_file", input: { path: "existing.txt", content: "after" } }, {
    workspace, roots: [workspace], question: async () => "yes", onCheckpoint,
  })
  assert.equal(await readFile(target, "utf8"), "after")
  const resumed = await store.load(session.id)
  const result = await rewindSession(resumed, store, { roots: [workspace] })
  assert.equal(await readFile(target, "utf8"), "before")
  assert.equal(result.reverted, 1)
  assert.equal(resumed.messages.length, 0)
  assert.equal(resumed.checkpoints[0].status, "rewound")
})

test("rewinds created folders, files, and moved files in reverse order", async (t) => {
  const { workspace, config } = await fixture(t)
  const store = createSessionStore(workspace, config)
  const session = await store.create("dreyze/test-model", "build")
  const checkpoint = await beginTurnCheckpoint(session, store, "Create and move files")
  session.messages.push({ role: "user", content: "Create and move files", checkpointId: checkpoint.id })
  await store.save(session)
  await writeFile(path.join(workspace, "source.txt"), "move me")
  const onCheckpoint = (change) => recordCheckpointChange(session, store, checkpoint.id, change)
  await executeTool({ name: "create_directory", input: { path: "new/nested" } }, {
    workspace, roots: [workspace], question: async () => "yes", onCheckpoint,
  })
  await executeTool({ name: "write_file", input: { path: "new/nested/created.txt", content: "created" } }, {
    workspace, roots: [workspace], question: async () => "yes", onCheckpoint,
  })
  await executeTool({ name: "move_file", input: { source: "source.txt", destination: "new/nested/moved.txt" } }, {
    workspace, roots: [workspace], question: async () => "yes", onCheckpoint,
  })
  const result = await rewindSession(session, store, { roots: [workspace] })
  assert.equal(result.reverted, 4)
  assert.equal(await readFile(path.join(workspace, "source.txt"), "utf8"), "move me")
  await assert.rejects(readFile(path.join(workspace, "new", "nested", "created.txt"), "utf8"), { code: "ENOENT" })
  await assert.rejects(stat(path.join(workspace, "new")), { code: "ENOENT" })
})

test("refuses to rewind a file that changed after the agent turn", async (t) => {
  const { workspace, config } = await fixture(t)
  const store = createSessionStore(workspace, config)
  const session = await store.create("dreyze/test-model", "build")
  const checkpoint = await beginTurnCheckpoint(session, store, "Create a file")
  session.messages.push({ role: "user", content: "Create a file", checkpointId: checkpoint.id })
  await store.save(session)
  const target = path.join(workspace, "created.txt")
  const onCheckpoint = (change) => recordCheckpointChange(session, store, checkpoint.id, change)
  await executeTool({ name: "write_file", input: { path: "created.txt", content: "agent version" } }, {
    workspace, roots: [workspace], question: async () => "yes", onCheckpoint,
  })
  await writeFile(target, "user version")
  await assert.rejects(rewindSession(session, store, { roots: [workspace] }), /изменён после хода/u)
  assert.equal(await readFile(target, "utf8"), "user version")
  assert.equal(session.messages.length, 1)
})

test("redacts credentials embedded in JSON output, common tokens, and authenticated URLs", () => {
  const raw = JSON.stringify({
    GITHUB_TOKEN: "ghp_123456789012345678901234567890",
    secret: "a-very-long-secret-value",
    remote: "https://build-user:build-password@example.test/repo.git",
    jwt: "eyJabcdefghijk.abcdefghijk.abcdefghijk",
  })
  const safe = redactSecrets(raw)
  assert.doesNotMatch(safe, /123456789012345678901234567890|a-very-long-secret-value|build-user|build-password|eyJabcdefghijk/u)
  assert.match(safe, /SECRET OMITTED/u)
  assert.match(safe, /\[REDACTED\]@example.test/u)
})

test("requires a terminal response for ask_user actions", async (t) => {
  const { workspace } = await fixture(t)
  const result = await executeTool({ name: "ask_user", input: { question: "Which project name?" } }, {
    workspace,
    roots: [workspace],
    question: async () => null,
  })
  assert.equal(result.requiresInput, "Which project name?")
})

test("keeps a task's project guide and skill snapshot stable across tool turns", async (t) => {
  const { workspace, config } = await fixture(t)
  const store = createSessionStore(workspace, config)
  const session = await store.create("dreyze/test-model", "build")
  session.messages.push({ role: "user", content: "Create the requested file." })
  await store.save(session)
  await writeFile(path.join(workspace, "AGENTS.md"), "Use semicolons in new TypeScript files.")
  const skillDirectory = path.join(workspace, ".dreyze", "skills", "code")
  await mkdir(skillDirectory, { recursive: true })
  await writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: Code\ndescription: Follow project coding patterns.\n---\nRead before editing.")
  const save = store.save.bind(store)
  let pendingSaved = false
  store.save = async (value) => {
    if (value.pendingAction) pendingSaved = true
    return save(value)
  }
  const target = path.join(workspace, "created.txt")
  let calls = 0
  const result = await runAgentTask({
    config: { url: "https://moonfacet.example", cookie: "session" },
    catalog: { models: [], defaultModel: "dreyze/test-model" },
    session,
    store,
    roots: [workspace],
    workspace,
    yes: true,
    question: async () => "",
    onOutput: () => {},
    fetchImpl: async (_url, init) => {
      calls++
      const request = JSON.parse(init.body)
      assert.equal(init.redirect, "error")
      assert.equal(request.messages.length > 0, true)
      assert.deepEqual(request.projectInstructions, [{ path: "./AGENTS.md", content: "Use semicolons in new TypeScript files." }])
      assert.deepEqual(request.projectSkills, [{
        name: "Code",
        path: "./.dreyze/skills/code/SKILL.md",
        description: "Follow project coding patterns.",
      }])
      if (calls === 1) {
        await writeFile(path.join(workspace, "AGENTS.md"), "Changed after the task began.")
        await writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: Changed\ndescription: Changed after the task began.\n---\n")
        return Response.json({ type: "tool", name: "write_file", input: { path: "created.txt", content: "hello" } })
      }
      return Response.json({ type: "final", content: "File created." })
    },
  })
  assert.equal(await readFile(target, "utf8"), "hello")
  assert.equal(result.final, "File created.")
  assert.equal(calls, 2)
  assert.equal(pendingSaved, true)
  assert.equal(session.pendingAction, null)
  assert.ok(session.messages.some((message) => message.content.includes("File created")))
})

test("trims only the oldest session messages needed to stay within the history budget", async (t) => {
  const { workspace, config } = await fixture(t)
  const store = createSessionStore(workspace, config)
  const session = await store.create("dreyze/test-model", "build")
  session.messages = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index} ${"x".repeat(20_000)}`,
  }))
  const result = await runAgentTask({
    config: { url: "https://moonfacet.example", cookie: "session" },
    catalog: { models: [], defaultModel: "dreyze/test-model" },
    session,
    store,
    roots: [workspace],
    workspace,
    question: async () => "",
    onOutput: () => {},
    fetchImpl: async () => Response.json({ type: "final", content: "Done." }),
  })

  assert.equal(result.final, "Done.")
  assert.equal(session.messages[0].content.slice(0, 8), "message-")
  assert.equal(session.messages.at(-1).content, "Done.")
  assert.ok(session.messages.length > 2)
  assert.ok(session.messages.reduce((sum, message) => sum + message.content.length, 0) <= 130_000)
  assert.equal(session.messages.some((message) => message.content.startsWith("message-9 ")), true)
})

test("does not execute a duplicate tool action and lets the model recover", async (t) => {
  const { workspace, config } = await fixture(t)
  const store = createSessionStore(workspace, config)
  const session = await store.create("dreyze/test-model", "build")
  session.messages.push({ role: "user", content: "Create a project folder." })
  let calls = 0
  let approvals = 0
  const result = await runAgentTask({
    config: { url: "https://moonfacet.example", cookie: "session" },
    catalog: { models: [], defaultModel: "dreyze/test-model" },
    session,
    store,
    roots: [workspace],
    workspace,
    question: async () => { approvals++; return "y" },
    onOutput: () => {},
    fetchImpl: async (_url, init) => {
      calls++
      const request = JSON.parse(init.body)
      if (calls <= 2) {
        const input = calls === 1
          ? { path: "site", location: "workspace" }
          : { location: "workspace", path: "site" }
        return Response.json({ type: "tool", name: "create_directory", input })
      }
      assert.match(request.messages.at(-1).content, /Повторно он не запускался/u)
      return Response.json({ type: "final", content: "Папка проекта уже создана." })
    },
  })

  assert.equal(result.final, "Папка проекта уже создана.")
  assert.equal(calls, 3)
  assert.equal(approvals, 1)
  assert.equal((await stat(path.join(workspace, "site"))).isDirectory(), true)
})

test("stops the agent after three identical consecutive tool calls", async (t) => {
  const { workspace, config } = await fixture(t)
  const store = createSessionStore(workspace, config)
  const session = await store.create("dreyze/test-model", "build")
  session.messages.push({ role: "user", content: "Create a project folder." })
  let calls = 0
  await assert.rejects(runAgentTask({
    config: { url: "https://moonfacet.example", cookie: "session" },
    catalog: { models: [], defaultModel: "dreyze/test-model" },
    session,
    store,
    roots: [workspace],
    workspace,
    yes: true,
    question: async () => "",
    onOutput: () => {},
    fetchImpl: async () => {
      calls++
      return Response.json({ type: "tool", name: "create_directory", input: { path: "site", location: "workspace" } })
    },
  }), (error) => error.code === "REPEATED_TOOL_ACTION")

  assert.equal(calls, 3)
  assert.equal((await stat(path.join(workspace, "site"))).isDirectory(), true)
  assert.match(session.messages.at(-1).content, /Агент остановлен/u)
})

test("runs an isolated read-only subagent without changing the project's latest session", async (t) => {
  const { workspace, config } = await fixture(t)
  const store = createSessionStore(workspace, config)
  const session = await store.create("dreyze/test-model", "build")
  session.messages.push({ role: "user", content: "Inspect the project and report findings." })
  await store.save(session)
  let calls = 0
  const result = await runAgentTask({
    config: { url: "https://moonfacet.example", cookie: "session" },
    catalog: { models: [], defaultModel: "dreyze/test-model" },
    session,
    store,
    roots: [workspace],
    workspace,
    yes: true,
    question: async () => "",
    onOutput: () => {},
    fetchImpl: async (_url, init) => {
      calls++
      const request = JSON.parse(init.body)
      if (request.mode === "plan") {
        assert.match(request.messages.at(-1).content, /Не изменяй проект/u)
        return Response.json({ type: "final", content: "The project uses a single entry point." })
      }
      if (calls === 1) {
        return Response.json({ type: "tool", name: "delegate_task", input: { task: "Find the project entry point." } })
      }
      return Response.json({ type: "final", content: "The entry point is documented." })
    },
  })
  assert.equal(result.final, "The entry point is documented.")
  assert.equal(calls, 3)
  assert.ok(session.messages.some((message) => message.content.includes("single entry point")))
  const latest = await store.latest()
  assert.equal(latest.id, session.id)
  const sessions = await store.list()
  const child = sessions.find((item) => item.parentSessionId === session.id)
  assert.equal(child?.mode, "plan")
  assert.equal(child?.title, "Find the project entry point.")
})

test("converts an interrupted mutating action into an unknown-outcome notice without replay", async (t) => {
  const { workspace, config } = await fixture(t)
  const store = createSessionStore(workspace, config)
  const session = await store.create("dreyze/test-model", "build")
  session.pendingAction = { id: "write-1", name: "write_file", startedAt: new Date().toISOString() }
  await store.save(session)
  const recovered = await store.load(session.id)
  assert.equal(await recoverPendingAction(recovered, store), true)
  assert.equal(await recoverPendingAction(recovered, store), false)
  assert.equal(recovered.pendingAction, null)
  assert.equal(recovered.messages.length, 1)
  assert.match(recovered.messages[0].content, /outcome is unknown/u)
  await assert.rejects(readFile(path.join(workspace, "should-not-exist.txt"), "utf8"), { code: "ENOENT" })
})

test("resumes an interactive clarification once and prints its final response once", async () => {
  const session = {
    pendingQuestion: "Which name should I use?",
    messages: [{ role: "assistant", content: "{\"type\":\"tool\",\"name\":\"ask_user\"}" }],
  }
  let saveCount = 0
  let runCount = 0
  const output = []
  const resumed = await resumeInteractiveSession({
    options: { continuing: true, yes: false },
    config: {}, catalog: {}, session,
    store: { save: async () => { saveCount++ } },
    roots: [], workspace: "/project", recovered: false,
    questioner: { ask: async () => "Storefront" },
    runTask: async (args) => {
      runCount++
      assert.equal(args.session.pendingQuestion, null)
      assert.equal(args.session.messages.at(-1).role, "user")
      args.onOutput("Created Storefront.")
      return { final: "Created Storefront." }
    },
    onOutput: (text) => output.push(text),
  })
  assert.equal(resumed, true)
  assert.equal(runCount, 1)
  assert.equal(saveCount, 3)
  assert.deepEqual(output, ["Created Storefront."])
})

test("does not restart a recovered interactive session twice", async () => {
  const session = { messages: [{ role: "user", content: "Continue the project" }] }
  let runCount = 0
  const resumed = await resumeInteractiveSession({
    options: { continuing: true, yes: false },
    config: {}, catalog: {}, session,
    store: {}, roots: [], workspace: "/project", recovered: true,
    questioner: { ask: async () => null },
    runTask: async () => {
      runCount++
      session.messages.push({ role: "user", content: "Tool result" })
    },
  })
  assert.equal(resumed, true)
  assert.equal(runCount, 1)
})

test("saves a cancelled --continue task and reports how to resume it", async () => {
  const session = { id: "session-1", pendingAction: null, messages: [{ role: "user", content: "Continue this work" }] }
  let interruptHandler
  let saveCount = 0
  const output = []
  const resumed = await resumeInteractiveSession({
    options: { continuing: true, yes: false },
    config: {}, catalog: {}, session,
    store: { save: async () => { saveCount++ } },
    roots: [], workspace: "/project", recovered: false,
    questioner: { ask: async () => "", setInterruptHandler: (handler) => { interruptHandler = handler } },
    runTask: async ({ signal }) => {
      interruptHandler()
      assert.equal(signal.aborted, true)
      throw new Error("request aborted")
    },
    onOutput: (text) => output.push(text),
  })
  assert.equal(resumed, true)
  assert.equal(saveCount, 4)
  assert.match(output[0], /Задача остановлена/u)
  assert.match(output[0], /--continue/u)
  assert.equal(interruptHandler, null)
})

test("lists only the validated Dreyze model catalog fields", async () => {
  const catalog = await fetchModelCatalog({ url: "https://moonfacet.example", cookie: "private-cookie" }, async (url, init) => {
    assert.equal(new URL(url).pathname, "/api/code/v1/models")
    assert.equal(init.headers.Cookie, "private-cookie")
    assert.equal(init.redirect, "error")
    return Response.json({
      defaultModel: "dreyze/test",
      data: [{ id: "dreyze/test", name: "Dreyze Test", description: "Model", group: "notion", context_length: 100_000, supports_images: true, api_key: "must be ignored" }],
    })
  })
  assert.deepEqual(catalog, {
    defaultModel: "dreyze/test",
    models: [{ id: "dreyze/test", name: "Dreyze Test", description: "Model", group: "notion", contextLength: 100_000, supportsImages: true }],
  })
})

test("doctor reports missing login as JSON without making a network request", async (t) => {
  const { config } = await fixture(t)
  const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url))
  const child = spawnSync(process.execPath, [cli, "--json", "doctor"], {
    env: { ...process.env, XDG_CONFIG_HOME: config },
    encoding: "utf8",
  })
  assert.equal(child.status, 1)
  const result = JSON.parse(child.stdout)
  assert.equal(result.auth.available, false)
  assert.equal(result.auth.source, "missing")
  assert.deepEqual(result.hints, ["Выполните dreyzecode login."])
  assert.equal(child.stderr, "")
})

test("streams one-shot run events as ordered JSON lines", { timeout: 10_000 }, async (t) => {
  const { config, workspace } = await fixture(t)
  const cookie = `__Host-dreyzeai_session=${"a".repeat(64)}`
  const requests = []
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    requests.push({ path: request.url, cookie: request.headers.cookie, body })
    if (request.url === "/api/code/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ defaultModel: "dreyze/test", data: [{ id: "dreyze/test", name: "Test", group: "test" }] }))
    } else if (request.url === "/api/code/agent/turn") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ type: "final", content: "Задача завершена." }))
    } else {
      response.writeHead(404).end("{}")
    }
  })
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise))
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)))
  const address = server.address()
  const configData = JSON.stringify({ url: `http://127.0.0.1:${address.port}`, cookie })
  for (const folder of [path.join(config, "dreyze-code"), path.join(config, "DreyzeCode")]) {
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, "config.json"), configData, { mode: 0o600 })
  }
  const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url))
  const child = spawn(process.execPath, [cli, "run", "Say hello", "--stdin", "--output-format", "stream-json"], {
    cwd: workspace,
    env: { ...process.env, XDG_CONFIG_HOME: config, APPDATA: config },
    stdio: ["pipe", "pipe", "pipe"],
  })
  child.stdin.end("Task details from stdin.")
  let stdoutText = ""
  let stderrText = ""
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdoutText += chunk })
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderrText += chunk })
  const exit = await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise)
    child.once("close", (code, signal) => resolvePromise({ code, signal }))
  })
  assert.equal(exit.code, 0, stderrText)
  assert.equal(stderrText, "")
  assert.equal(requests.length, 2)
  assert.ok(requests.every((request) => request.cookie === cookie))
  assert.equal(JSON.parse(requests[1].body).messages.at(-1).content, "Say hello\n\nTask details from stdin.")
  const events = stdoutText.trim().split("\n").map((line) => JSON.parse(line))
  assert.deepEqual(events.map((event) => event.type), ["system", "status", "status", "assistant", "result"])
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5])
  assert.ok(events.every((event) => event.run_id === events[0].run_id))
  assert.equal(events[0].session_id, events.at(-1).session.id)
  assert.equal(events.find((event) => event.type === "assistant").content, "Задача завершена.")
  assert.equal(events.at(-1).ok, true)
})

test("runs the CLI when invoked through the symlink npm creates for its binary", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows symlink creation depends on runner privileges")
    return
  }
  const { root } = await fixture(t)
  const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url))
  const command = path.join(root, "dreyzecode")
  await symlink(cli, command, "file")
  const child = spawnSync(command, ["--version"], { encoding: "utf8" })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout, "DreyzeCode 0.5.27\n")
})

test("help documents image input in both one-shot and interactive modes", async () => {
  const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url))
  const child = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" })
  assert.equal(child.status, 0, child.stderr)
  assert.match(child.stdout, /--image PATH/u)
  assert.match(child.stdout, /\/help.*\/attach/u)
  assert.match(child.stdout, /\/copy.*\/rename/u)
  assert.match(child.stdout, /\/skills/u)
  assert.match(child.stdout, /\/review.*\/init/u)
  assert.match(child.stdout, /<имя-папки>/u)
  assert.match(child.stdout, /подсказки появляются при вводе/u)
  assert.match(child.stdout, /Ctrl\+C останавливает текущую задачу/u)
  assert.match(child.stdout, /skills list/u)
})

test("the raw API escape hatch rejects paths that normalize outside /api", async () => {
  await assert.rejects(apiGet({ url: "https://moonfacet.example", cookie: "secret" }, "/api/../account", true), /API Dreyze/u)
  await assert.rejects(apiGet({ url: "https://moonfacet.example", cookie: "secret" }, "//evil.example/api/models", true), /путь \/api\//u)
})
