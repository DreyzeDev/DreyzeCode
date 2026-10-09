import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { env, platform } from "node:process"
import { lstat, readFile, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"

const MAX_CONFIG_BYTES = 64_000
const MAX_HOOKS_PER_FILE = 40
const MAX_HOOKS = 80
const MAX_COMMAND_CHARS = 2_000
const MAX_HOOK_OUTPUT = 12_000
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 30_000
const ALLOWED_EVENTS = new Set(["beforeTool", "afterTool"])

function within(root, candidate) {
  const rel = relative(root, candidate)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function hookId({ sourcePath, event, tools, command, timeoutMs }) {
  return createHash("sha256")
    .update(JSON.stringify({ sourcePath, event, tools, command, timeoutMs }))
    .digest("hex")
}

async function readHookFile(pathname, { scope, root }) {
  let info
  try { info = await lstat(pathname) } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { hooks: [], issues: [] }
    return { hooks: [], issues: [`Не удалось прочитать файл hooks (${scope}).`] }
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_CONFIG_BYTES) {
    return { hooks: [], issues: [`Файл hooks (${scope}) должен быть обычным файлом размером до 64 КБ.`] }
  }
  let content
  try {
    const canonical = await realpath(pathname)
    if (root && !within(root, canonical)) return { hooks: [], issues: [`Файл hooks (${scope}) выходит за разрешённую папку.`] }
    content = await readFile(canonical, "utf8")
  } catch {
    return { hooks: [], issues: [`Не удалось прочитать файл hooks (${scope}).`] }
  }
  let parsed
  try { parsed = JSON.parse(content) } catch {
    return { hooks: [], issues: [`Файл hooks (${scope}) содержит некорректный JSON.`] }
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.hooks) || parsed.hooks.length > MAX_HOOKS_PER_FILE) {
    return { hooks: [], issues: [`Файл hooks (${scope}) должен содержать массив hooks размером до ${MAX_HOOKS_PER_FILE}.`] }
  }

  const hooks = []
  const issues = []
  const sourcePath = root ? `${relative(root, pathname).split(sep).join("/") || "hooks.json"}` : "user hooks.json"
  for (const [index, value] of parsed.hooks.entries()) {
    try {
      if (!isRecord(value)) throw new Error("запись должна быть объектом")
      if (!ALLOWED_EVENTS.has(value.event)) throw new Error("event должен быть beforeTool или afterTool")
      if (typeof value.command !== "string" || !value.command.trim() || value.command.length > MAX_COMMAND_CHARS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.command)) {
        throw new Error("укажите команду длиной до 2000 символов")
      }
      let tools = null
      if (value.tools !== undefined) {
        if (!Array.isArray(value.tools) || value.tools.length > 50 || value.tools.some((tool) => typeof tool !== "string" || !tool.trim() || tool.length > 240 || /[\u0000-\u001f\u007f]/u.test(tool))) {
          throw new Error("tools должен содержать до 50 имён инструментов")
        }
        tools = [...new Set(value.tools)]
      }
      const timeoutMs = value.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : value.timeoutMs
      if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
        throw new Error(`timeoutMs должен быть от 100 до ${MAX_TIMEOUT_MS}`)
      }
      const hook = {
        event: value.event,
        tools,
        command: value.command.trim(),
        timeoutMs,
        scope,
        sourcePath,
        cwd: root,
      }
      hook.approvalId = hookId(hook)
      hooks.push(hook)
    } catch (error) {
      issues.push(`Hook ${scope} #${index + 1} пропущен: ${error instanceof Error ? error.message : "неверная конфигурация"}.`)
    }
  }
  return { hooks, issues }
}

export async function loadConfiguredHooks({ roots, userConfigPath }) {
  const hooks = []
  const issues = []
  if (userConfigPath) {
    const result = await readHookFile(userConfigPath, { scope: "user", root: null })
    hooks.push(...result.hooks)
    issues.push(...result.issues)
  }
  for (let index = 0; index < roots.length && hooks.length < MAX_HOOKS; index++) {
    const root = roots[index]
    const pathname = join(root, ".dreyze", "hooks.json")
    const result = await readHookFile(pathname, { scope: "project", root })
    hooks.push(...result.hooks.slice(0, MAX_HOOKS - hooks.length))
    issues.push(...result.issues)
  }
  if (hooks.length >= MAX_HOOKS) issues.push(`Обрабатываются первые ${MAX_HOOKS} hooks.`)
  return { hooks, issues }
}

function safeHookText(value, redact) {
  const text = String(value ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "[ANSI control omitted]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�")
    .slice(0, MAX_HOOK_OUTPUT)
  return redact ? redact(text) : text
}

function terminateProcessTree(child) {
  if (platform === "win32") {
    if (!child.pid) return child.kill()
    try {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      })
      const fallback = () => child.kill()
      killer.once("error", fallback)
      killer.once("close", (code) => { if (code !== 0) fallback() })
    } catch {
      child.kill()
    }
    return
  }
  if (!child.pid) return child.kill("SIGTERM")
  try { process.kill(-child.pid, "SIGTERM") } catch (error) {
    if (error?.code !== "ESRCH") child.kill("SIGTERM")
  }
  const forceTimer = setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL") } catch (error) {
      if (error?.code !== "ESRCH") child.kill("SIGKILL")
    }
  }, 750)
  forceTimer.unref()
  child.once("close", () => clearTimeout(forceTimer))
}

export async function executeHookCommand(hook, payload, { signal, redact } = {}) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Hook cancelled.", "AbortError")
  const shell = platform === "win32" ? "powershell.exe" : "/bin/sh"
  const args = platform === "win32"
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", hook.command]
    : ["-lc", hook.command]
  const childEnv = { ...env }
  for (const key of Object.keys(childEnv)) {
    if (/^(?:DREYZE|DREYZEAI|MOONFACET)_.*(COOKIE|TOKEN|SECRET|KEY)$/iu.test(key)) delete childEnv[key]
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(shell, args, {
      cwd: hook.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: platform !== "win32",
    })
    let stdoutText = ""
    let stderrText = ""
    let timedOut = false
    let aborted = false
    let stopRequested = false
    const collect = (target, chunk) => {
      if (target.value.length < MAX_HOOK_OUTPUT) target.value += chunk.toString("utf8").slice(0, MAX_HOOK_OUTPUT - target.value.length)
    }
    const out = { value: stdoutText }
    const err = { value: stderrText }
    child.stdout.on("data", (chunk) => collect(out, chunk))
    child.stderr.on("data", (chunk) => collect(err, chunk))
    const stop = (timedOutValue = false, abortedValue = false) => {
      if (stopRequested) return
      stopRequested = true
      timedOut = timedOutValue
      aborted = abortedValue
      terminateProcessTree(child)
    }
    const timer = setTimeout(() => stop(true), hook.timeoutMs)
    const onAbort = () => stop(false, true)
    signal?.addEventListener("abort", onAbort, { once: true })
    child.stdin.on("error", () => {})
    child.once("error", (error) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      rejectPromise(error)
    })
    child.once("close", (code, closeSignal) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      stdoutText = safeHookText(out.value, redact)
      stderrText = safeHookText(err.value, redact)
      resolvePromise({ code: code ?? 1, signal: closeSignal, stdout: stdoutText, stderr: stderrText, timedOut, aborted })
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

export async function runHookEvent(event, {
  hooks,
  tool,
  workspace,
  signal,
  approvedProjectHooks = new Set(),
  approveProjectHook = async () => false,
  redact,
} = {}) {
  const outputs = []
  const warnings = []
  for (const hook of hooks ?? []) {
    if (hook.event !== event || (hook.tools && !hook.tools.includes(tool.name))) continue
    if (signal?.aborted) throw signal.reason ?? new DOMException("Hook cancelled.", "AbortError")
    if (hook.scope === "project" && !approvedProjectHooks.has(hook.approvalId)) {
      let approved = false
      try { approved = await approveProjectHook(hook) } catch {}
      if (!approved) {
        warnings.push(`Пропущен hook проекта ${hook.sourcePath}: не подтверждён запуск команды.`)
        continue
      }
      approvedProjectHooks.add(hook.approvalId)
    }
    let result
    try {
      result = await executeHookCommand(hook, {
        event,
        workspace,
        tool: {
          name: tool.name,
          input: tool.input ?? {},
          ...(tool.output !== undefined ? { output: tool.output } : {}),
          ...(tool.succeeded !== undefined ? { succeeded: tool.succeeded } : {}),
        },
      }, { signal, redact })
    } catch (error) {
      if (signal?.aborted) throw error
      warnings.push(`Hook ${hook.scope} ${hook.sourcePath} не запущен: ${error instanceof Error ? error.message : "ошибка запуска"}.`)
      continue
    }
    if (result.aborted || signal?.aborted) throw signal?.reason ?? new DOMException("Hook cancelled.", "AbortError")
    const output = [result.stdout, result.stderr ? `[stderr] ${result.stderr}` : ""].filter(Boolean).join("\n").trim()
    if (result.timedOut) {
      warnings.push(`Время hook ${hook.scope} ${hook.sourcePath} истекло через ${hook.timeoutMs} мс.`)
      continue
    }
    if (event === "beforeTool" && result.code === 2) {
      return { blocked: true, reason: output || `Hook ${hook.sourcePath} отклонил действие.`, outputs, warnings }
    }
    if (result.code !== 0) {
      warnings.push(`Hook ${hook.scope} ${hook.sourcePath} завершился с кодом ${result.code}${output ? `: ${output}` : "."}`)
      continue
    }
    if (output) outputs.push({ sourcePath: hook.sourcePath, text: output })
  }
  return { blocked: false, outputs, warnings }
}

export function describeHooks(hooks, redact = (value) => value) {
  return (hooks ?? []).map((hook) => ({
    event: hook.event,
    tools: hook.tools,
    command: redact(hook.command),
    timeoutMs: hook.timeoutMs,
    scope: hook.scope,
    sourcePath: hook.sourcePath,
  }))
}
