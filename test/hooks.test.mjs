import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { loadConfiguredHooks, runHookEvent } from "../hooks.mjs"

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dreyze-hooks-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspacePath = path.join(root, "project")
  const user = path.join(root, "user")
  await mkdir(path.join(workspacePath, ".dreyze"), { recursive: true })
  await mkdir(user, { recursive: true })
  const workspace = await realpath(workspacePath)
  return { root, workspace, user, userConfigPath: path.join(user, "hooks.json") }
}

function nodeCommand(scriptPath) {
  const executable = process.execPath.replaceAll('"', '""')
  const script = scriptPath.replaceAll('"', '""')
  return process.platform === "win32"
    ? `& "${executable}" "${script}"`
    : `"${executable.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" "${script.replaceAll('"', '\\"')}"`
}

test("loads bounded user and project hook configs with explicit scope", async (t) => {
  const { workspace, userConfigPath } = await fixture(t)
  await writeFile(userConfigPath, JSON.stringify({ hooks: [{ event: "afterTool", command: "node formatter.js", tools: ["write_file"] }] }))
  await writeFile(path.join(workspace, ".dreyze", "hooks.json"), JSON.stringify({ hooks: [{ event: "beforeTool", command: "node policy.js", tools: ["run_command"], timeoutMs: 400 }] }))
  const result = await loadConfiguredHooks({ roots: [workspace], userConfigPath })
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.hooks.map(({ scope, event, tools, timeoutMs }) => ({ scope, event, tools, timeoutMs })), [
    { scope: "user", event: "afterTool", tools: ["write_file"], timeoutMs: 10_000 },
    { scope: "project", event: "beforeTool", tools: ["run_command"], timeoutMs: 400 },
  ])
})

test("rejects invalid events and malformed hook entries without loading them", async (t) => {
  const { workspace } = await fixture(t)
  await writeFile(path.join(workspace, ".dreyze", "hooks.json"), JSON.stringify({ hooks: [
    { event: "SessionStart", command: "echo unsafe" },
    { event: "beforeTool", command: "echo no", tools: "run_command" },
    { event: "afterTool", command: "echo yes", tools: ["write_file"] },
  ] }))
  const result = await loadConfiguredHooks({ roots: [workspace] })
  assert.equal(result.hooks.length, 1)
  assert.equal(result.hooks[0].event, "afterTool")
  assert.equal(result.issues.length, 2)
})

test("requires a per-session approval before running project hooks and remembers approval", async (t) => {
  const { workspace } = await fixture(t)
  const marker = path.join(workspace, "hook-ran.txt")
  const script = path.join(workspace, "project-hook.js")
  await writeFile(script, `require("fs").appendFileSync(${JSON.stringify(marker)}, "ran")`)
  await writeFile(path.join(workspace, ".dreyze", "hooks.json"), JSON.stringify({ hooks: [{ event: "beforeTool", command: nodeCommand(script) }] }))
  const { hooks } = await loadConfiguredHooks({ roots: [workspace] })
  const approved = new Set()
  let prompts = 0
  const run = () => runHookEvent("beforeTool", {
    hooks,
    tool: { name: "read_file", input: { path: "src/app.ts" } },
    workspace,
    approvedProjectHooks: approved,
    approveProjectHook: async () => { prompts++; return true },
  })
  await run()
  await run()
  assert.equal(prompts, 1)
  assert.equal(await readFile(marker, "utf8"), "ranran")
})

test("beforeTool exit code 2 blocks a tool and returns a safe reason", async (t) => {
  const { workspace } = await fixture(t)
  const script = path.join(workspace, "block-hook.js")
  await writeFile(script, "process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('Protected command'); process.exit(2) })")
  await writeFile(path.join(workspace, ".dreyze", "hooks.json"), JSON.stringify({ hooks: [{ event: "beforeTool", command: nodeCommand(script), tools: ["run_command"] }] }))
  const { hooks } = await loadConfiguredHooks({ roots: [workspace] })
  const result = await runHookEvent("beforeTool", {
    hooks,
    tool: { name: "run_command", input: { command: "node test.js" } },
    workspace,
    approveProjectHook: async () => true,
  })
  assert.equal(result.blocked, true)
  assert.match(result.reason, /Protected command/u)
})

test("afterTool output reaches the next model step as data", async (t) => {
  const { workspace } = await fixture(t)
  const script = path.join(workspace, "post-hook.js")
  await writeFile(script, "let data=''; process.stdin.on('data', chunk => data += chunk); process.stdin.on('end', () => { const event=JSON.parse(data); process.stdout.write('formatted '+event.tool.output) })")
  await writeFile(path.join(workspace, ".dreyze", "hooks.json"), JSON.stringify({ hooks: [{ event: "afterTool", command: nodeCommand(script) }] }))
  const { hooks } = await loadConfiguredHooks({ roots: [workspace] })
  const result = await runHookEvent("afterTool", {
    hooks,
    tool: { name: "write_file", input: { path: "a.js" }, output: "File written", succeeded: true },
    workspace,
    approveProjectHook: async () => true,
  })
  assert.equal(result.blocked, false)
  assert.match(result.outputs[0].text, /formatted File written/u)
})

test("user hook command does not inherit Dreyze credential variables", async (t) => {
  const { workspace, userConfigPath } = await fixture(t)
  const script = path.join(workspace, "check-env.js")
  await writeFile(script, "process.stdout.write(process.env.DREYZEAI_SECRET_KEY || 'missing')")
  await writeFile(userConfigPath, JSON.stringify({ hooks: [{ event: "beforeTool", command: nodeCommand(script) }] }))
  const { hooks } = await loadConfiguredHooks({ roots: [workspace], userConfigPath })
  const old = process.env.DREYZEAI_SECRET_KEY
  process.env.DREYZEAI_SECRET_KEY = "sensitive-test-value"
  try {
    const result = await runHookEvent("beforeTool", {
      hooks,
      tool: { name: "read_file", input: { path: "README.md" } },
      workspace,
    })
    assert.equal(result.outputs[0].text, "missing")
  } finally {
    if (old === undefined) delete process.env.DREYZEAI_SECRET_KEY
    else process.env.DREYZEAI_SECRET_KEY = old
  }
})

test("ignores hook config files that are symlinks", async (t) => {
  const { root, workspace } = await fixture(t)
  const outside = path.join(root, "outside.json")
  await writeFile(outside, JSON.stringify({ hooks: [{ event: "beforeTool", command: "echo unsafe" }] }))
  try {
    await symlink(outside, path.join(workspace, ".dreyze", "hooks.json"), "file")
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip("Windows runner does not permit creating symlinks")
      return
    }
    throw error
  }
  const result = await loadConfiguredHooks({ roots: [workspace] })
  assert.equal(result.hooks.length, 0)
  assert.match(result.issues[0], /обычным файлом/u)
})
