#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { homedir } from "node:os"
import { env, platform, stdin, stdout, stderr } from "node:process"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { access, chmod, copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { connectMcpServers, listConfiguredMcpServers } from "./mcp-client.mjs"

export const VERSION = "0.5.5"
const MAX_STEPS = 80
const MAX_HISTORY = 40
const MAX_MESSAGE_CHARS = 24_000
const MAX_TOOL_OUTPUT = 12_000
const MAX_READ_BYTES = 1_000_000
const MAX_WRITE_BYTES = 500_000
const MAX_IMAGE_BYTES = 2_900_000
const MAX_IMAGE_TOTAL_BYTES = 7_000_000
const MAX_IMAGES_PER_MESSAGE = 6
const MAX_PROJECT_INSTRUCTION_FILES = 40
const MAX_PROJECT_INSTRUCTION_CHARS = 24_000
const MAX_PROJECT_INSTRUCTION_FILE_BYTES = 32_000
const MAX_PROJECT_SKILLS = 40
const MAX_PROJECT_SKILL_CHARS = 12_000
const IGNORED_SEARCH_DIRS = new Set([".git", ".next", ".turbo", ".venv", "venv", "build", "dist", "node_modules", "target", "vendor", "coverage"])
const MUTATING_TOOLS = new Set(["create_directory", "copy_file", "move_file", "write_file", "edit_file", "delete_file", "run_command", "delegate_task"])
const PLAN_TOOLS = new Set(["list_files", "read_file", "search_text", "web_search", "ask_user"])
export const SLASH_COMMANDS = Object.freeze([
  { name: "help", usage: "/help", description: "показать команды" },
  { name: "mode", usage: "/mode build|plan", description: "переключить режим работы" },
  { name: "model", usage: "/model [название]", description: "выбрать модель или показать каталог" },
  { name: "attach", usage: "/attach <путь>", description: "добавить изображение к следующему сообщению" },
  { name: "detach", usage: "/detach", description: "убрать вложения следующего сообщения" },
  { name: "theme", usage: "/theme purple|blue|system", description: "изменить оформление терминала" },
  { name: "status", usage: "/status", description: "показать текущую сессию и проект" },
  { name: "sessions", usage: "/sessions", description: "показать последние сессии проекта" },
  { name: "resume", usage: "/resume [ID]", description: "открыть сессию по ID или последнюю" },
  { name: "new", usage: "/new", description: "начать новую сессию" },
  { name: "clear", usage: "/clear", description: "очистить экран, сохранив историю" },
  { name: "exit", usage: "/exit", description: "завершить работу" },
])
const SLASH_COMMAND_NAMES = new Set([...SLASH_COMMANDS.map(({ name }) => name), "models", "quit"])
const TOOLS = new Set([
  "list_files", "read_file", "search_text", "create_directory", "copy_file", "move_file",
  "write_file", "edit_file", "delete_file", "run_command", "ask_user", "delegate_task", "web_search",
])
const packageDirectory = dirname(fileURLToPath(import.meta.url))
const configRoot = platform === "win32"
  ? join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "DreyzeCode")
  : join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "dreyze-code")
const configFile = join(configRoot, "config.json")

function within(root, candidate) {
  const rel = relative(root, candidate)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function isSensitivePath(pathname) {
  const name = basename(pathname).toLowerCase()
  return name === ".env" || name.startsWith(".env.") ||
    /(^|[._-])(secret|credential|password|token|api[-_]?key|private[-_]?key)([._-]|$)/iu.test(name) ||
    /\.(pem|key|p12|pfx)$/iu.test(name) || ["id_rsa", "id_ed25519"].includes(name)
}

async function nearestExistingPath(pathname) {
  let current = pathname
  while (true) {
    try {
      await lstat(current)
      return await realpath(current)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

export async function resolveWorkspacePath(rawPath, roots, { mustExist = false, allowSensitive = false } = {}) {
  if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0")) {
    throw new Error("Укажите корректный путь внутри разрешённой папки.")
  }
  const candidate = resolve(isAbsolute(rawPath) ? rawPath : roots[0], rawPath)
  const lexicalRoot = roots.find((root) => within(root, candidate))
  if (!lexicalRoot) throw new Error("Путь находится вне папок, разрешённых для этой сессии.")
  let existing
  try { existing = await realpath(candidate) } catch (error) {
    if (error?.code !== "ENOENT" || mustExist) throw error
  }
  if (mustExist && !existing) throw Object.assign(new Error("Указанный файл или папка не найдены."), { code: "ENOENT" })
  const resolved = existing ?? candidate
  const verified = existing ?? await nearestExistingPath(dirname(candidate))
  if (!within(lexicalRoot, verified)) throw new Error("Путь через символьную ссылку выходит за разрешённую папку.")
  if (!within(lexicalRoot, resolved)) throw new Error("Путь находится вне папок, разрешённых для этой сессии.")
  if (!allowSensitive && (isSensitivePath(candidate) || isSensitivePath(resolved))) throw new Error("Чтение секретных файлов заблокировано.")
  return candidate
}

export function parseArgs(args) {
  const commands = new Set(["login", "logout", "doctor", "models", "sessions", "skills", "mcp", "api", "run", "chat", "help"])
  const result = { command: "interactive", positionals: [], addDirs: [], imagePaths: [], json: false, yes: false, continuing: false }
  let index = 0
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") return { ...result, command: "help" }
  if (args[0] === "--version" || args[0] === "-v") return { ...result, command: "version" }
  if (args[0] && commands.has(args[0])) {
    result.command = args[0]
    index = 1
  } else if (args[0] && !args[0].startsWith("-")) {
    result.command = "run"
  }
  for (; index < args.length; index++) {
    const arg = args[index]
    if (commands.has(arg) && result.command === "interactive" && result.positionals.length === 0) result.command = arg
    else if (arg === "--help" || arg === "-h") result.command = "help"
    else if (arg === "--json") result.json = true
    else if (arg === "--yes" || arg === "-y") result.yes = true
    else if (arg === "--continue" || arg === "-c") result.continuing = true
    else if (arg === "--model" || arg === "-m") {
      result.model = args[++index]
      if (!result.model) throw new Error(`${arg} требует значение.`)
    } else if (arg.startsWith("--model=")) result.model = arg.slice("--model=".length)
    else if (arg === "--mode") {
      result.mode = args[++index]
      if (!result.mode) throw new Error("--mode требует значение.")
    } else if (arg === "--add-dir") {
      result.addDirs.push(args[++index])
      if (!result.addDirs.at(-1)) throw new Error("--add-dir требует путь.")
    } else if (arg === "--image") {
      result.imagePaths.push(args[++index])
      if (!result.imagePaths.at(-1)) throw new Error("--image требует путь к файлу изображения.")
    } else if (arg.startsWith("--image=")) {
      const imagePath = arg.slice("--image=".length)
      if (!imagePath) throw new Error("--image требует путь к файлу изображения.")
      result.imagePaths.push(imagePath)
    } else if (arg === "--session") {
      result.sessionID = args[++index]
      if (!result.sessionID) throw new Error("--session требует ID.")
      result.continuing = true
    } else if (arg === "--url") {
      result.url = args[++index]
      if (!result.url) throw new Error("--url требует адрес.")
    } else if (arg.startsWith("-")) throw new Error(`Неизвестный параметр: ${arg}`)
    else result.positionals.push(arg)
  }
  if (result.mode && result.mode !== "build" && result.mode !== "plan") throw new Error("--mode принимает build или plan.")
  if (result.json && result.command === "interactive") throw new Error("В интерактивном режиме --json не поддерживается.")
  return result
}

export function parseSlashCommand(input) {
  if (typeof input !== "string") return null
  const trimmed = input.trim()
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/iu.exec(trimmed)
  if (!match) return null
  return { name: match[1].toLowerCase(), argument: match[2] ?? "" }
}

function safeTerminalText(value) {
  return String(value)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�")
    .replace(/\r\n?/gu, "\n")
}

export function formatChatMessage(title, content, requestedWidth = 76) {
  const width = Math.max(32, Math.min(100, Number.isInteger(requestedWidth) ? requestedWidth : 76))
  const safeTitle = safeTerminalText(title).replace(/\n/gu, " ").slice(0, width - 10) || "DreyzeCode"
  const contentWidth = width - 4
  const header = `╭─ ${safeTitle} ${"─".repeat(Math.max(2, width - safeTitle.length - 5))}╮`
  const wrapped = safeTerminalText(content).split("\n").flatMap((line) => {
    if (!line) return [""]
    const output = []
    let current = ""
    for (const word of line.split(/\s+/u)) {
      if (!current) current = word
      else if (current.length + word.length + 1 <= contentWidth) current += ` ${word}`
      else {
        output.push(current)
        current = word
      }
      while (current.length > contentWidth) {
        output.push(current.slice(0, contentWidth))
        current = current.slice(contentWidth)
      }
    }
    output.push(current)
    return output
  })
  const lines = wrapped.map((line) => `│ ${line.padEnd(contentWidth)} │`)
  return [header, ...lines, `╰${"─".repeat(width - 2)}╯`].join("\n")
}

function printHelp() {
  stdout.write(`DreyzeCode ${VERSION} — локальный агент разработки Dreyze\n\n` +
    `Использование:\n` +
    `  dreyzecode [параметры]                 интерактивная сессия\n` +
    `  dreyzecode run "задача"                 выполнить задачу\n` +
    `  dreyzecode run "опиши фото" --image ./photo.png\n` +
    `  dreyzecode --continue                  продолжить последнюю сессию\n` +
    `  dreyzecode login [--url URL] [--remote] войти через браузер\n` +
    `  dreyzecode logout                      завершить сессию CLI\n` +
    `  dreyzecode --json doctor               проверить настройку и API\n` +
    `  dreyzecode models list                 показать доступные модели\n` +
    `  dreyzecode sessions list               найти локальные сессии проекта\n` +
    `  dreyzecode sessions show <id>          вывести локальную сессию\n` +
    `  dreyzecode skills list                 показать skills проекта\n` +
    `  dreyzecode mcp list                    показать настроенные MCP серверы\n` +
    `  dreyzecode api get /api/...            безопасный GET к API Dreyze\n\n` +
    `Параметры: --model ID, --mode build|plan, --add-dir PATH, --image PATH (повторяемый), --session ID, --json, --yes\n` +
    `В Build изменения файлов и команды требуют подтверждения. Plan разрешает только чтение.\n` +
    `В интерактивном режиме: /help, /mode, /model, /attach, /detach, /theme, /status, /sessions, /resume, /new, /clear, /exit.\n`)
}

function jsonOut(value) {
  stdout.write(`${JSON.stringify(value)}\n`)
}

function reportError(error, jsonMode = false) {
  const message = error instanceof Error ? error.message : "Не удалось выполнить команду DreyzeCode."
  if (jsonMode) jsonOut({ ok: false, error: { code: error?.code || "DREYZE_CODE_ERROR", message } })
  else stderr.write(`Ошибка: ${message}\n`)
  process.exitCode = 1
}

async function readConfig() {
  try {
    const parsed = JSON.parse(await readFile(configFile, "utf8"))
    if (typeof parsed.url !== "string" || typeof parsed.cookie !== "string") return null
    const url = new URL(parsed.url)
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    if (url.origin !== parsed.url || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) return null
    if (!/^__Host-dreyzeai_session=[0-9a-f]{64}$/u.test(parsed.cookie)) return null
    return { url: url.origin, cookie: parsed.cookie }
  } catch {
    return null
  }
}

function safeError(body, fallback) {
  const message = body?.error?.message
  return typeof message === "string" && message.length <= 500 ? message : fallback
}

export async function fetchModelCatalog(config, fetchImpl = fetch) {
  const response = await fetchImpl(new URL("/api/code/v1/models", config.url), {
    headers: { Accept: "application/json", Cookie: config.cookie },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(safeError(body, `Не удалось загрузить модели (HTTP ${response.status}).`))
    error.code = body?.error?.code || (response.status === 401 ? "AUTH_REQUIRED" : "MODEL_CATALOG_UNAVAILABLE")
    error.status = response.status
    throw error
  }
  const models = Array.isArray(body.data) ? body.data.flatMap((item) => {
    if (!item || typeof item.id !== "string" || typeof item.name !== "string") return []
    return [{ id: item.id, name: item.name, description: typeof item.description === "string" ? item.description : "", group: typeof item.group === "string" ? item.group : "unknown", contextLength: Number.isFinite(item.context_length) ? item.context_length : null, supportsImages: item.supports_images === true }]
  }) : []
  if (!models.length) throw Object.assign(new Error("Каталог моделей Dreyze пуст."), { code: "EMPTY_MODEL_CATALOG" })
  return { models, defaultModel: typeof body.defaultModel === "string" ? body.defaultModel : models[0].id }
}

async function searchAgentWeb(config, query, fetchImpl = fetch) {
  if (typeof query !== "string" || !query.trim() || query.length > 800) {
    throw new Error("Запрос веб-поиска должен содержать не более 800 символов.")
  }
  const response = await fetchImpl(new URL("/api/code/agent/search", config.url), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Cookie: config.cookie },
    body: JSON.stringify({ query: query.trim() }),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(25_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw Object.assign(new Error(safeError(body, `Веб-поиск завершился с ошибкой HTTP ${response.status}.`)), {
      code: body?.error?.code || "WEB_SEARCH_FAILED",
      status: response.status,
    })
  }
  if (!Array.isArray(body.sources)) throw Object.assign(new Error("Сервис поиска вернул некорректный результат."), { code: "INVALID_WEB_SEARCH_RESPONSE" })
  const sources = body.sources.slice(0, 5).flatMap((source) => {
    if (!source || typeof source.title !== "string" || typeof source.url !== "string") return []
    return [{
      title: source.title.slice(0, 240),
      url: source.url.slice(0, 500),
      snippet: typeof source.snippet === "string" ? source.snippet.slice(0, 700) : "",
    }]
  })
  return { output: JSON.stringify({ query: query.trim(), sources }) }
}

async function doctor(config, jsonMode) {
  const result = {
    ok: false,
    version: VERSION,
    node: process.version,
    platform: `${platform}-${process.arch}`,
    workspace: await realpath(process.cwd()).catch(() => resolve(process.cwd())),
    auth: { available: Boolean(config), source: config ? "user-config" : "missing" },
    service: { url: config?.url ?? null, reachable: null, status: null },
    models: { count: 0, defaultModel: null },
    hints: [],
  }
  if (!config) {
    result.hints.push("Выполните dreyzecode login.")
    if (jsonMode) jsonOut(result)
    else stdout.write(`DreyzeCode ${VERSION}: вход не настроен. Выполните dreyzecode login.\n`)
    process.exitCode = 1
    return
  }
  try {
    const catalog = await fetchModelCatalog(config)
    result.service.reachable = true
    result.service.status = 200
    result.models = { count: catalog.models.length, defaultModel: catalog.defaultModel }
    result.ok = true
  } catch (error) {
    result.service.reachable = error?.status !== undefined
    result.service.status = error?.status ?? null
    result.auth.available = error?.status === 401 ? false : true
    result.hints.push(error instanceof Error ? error.message : "Проверьте сеть и попробуйте снова.")
    if (error?.status === 401) result.hints.push("Сессия истекла. Выполните dreyzecode login.")
  }
  if (jsonMode) jsonOut(result)
  else stdout.write(result.ok
    ? `DreyzeCode готов. API доступен, моделей: ${result.models.count}, по умолчанию: ${result.models.defaultModel}.\n`
    : `DreyzeCode не готов. ${result.hints.join(" ")}\n`)
  if (!result.ok) process.exitCode = 1
}

function projectKey(workspace) {
  return createHash("sha256").update(workspace).digest("hex").slice(0, 32)
}

export function createSessionStore(workspace, root = configRoot, { updateLatestPointer = true } = {}) {
  const directory = join(root, "sessions", projectKey(workspace))
  const fileFor = (id) => {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/iu.test(id)) throw new Error("Некорректный ID сессии.")
    return join(directory, `${id}.json`)
  }
  return {
    async create(model, mode) {
      const now = new Date().toISOString()
      return { id: randomUUID(), workspace, model, mode, createdAt: now, updatedAt: now, messages: [], pendingAction: null }
    },
    async load(id) {
      const file = fileFor(id)
      const raw = await readFile(file, "utf8")
      if (raw.length > 5_000_000) throw new Error("Файл сессии превышает допустимый размер.")
      const data = JSON.parse(raw)
      if (!data || data.id !== id || data.workspace !== workspace || !Array.isArray(data.messages)) throw new Error("Файл сессии повреждён или относится к другому проекту.")
      data.messages = data.messages
        .filter((message) => message && ["user", "assistant"].includes(message.role) && typeof message.content === "string")
        .map((message) => {
          const imagePaths = message.role === "user" && Array.isArray(message.imagePaths)
            ? message.imagePaths.filter((value) => typeof value === "string" && value.length <= 4_096).slice(0, MAX_IMAGES_PER_MESSAGE)
            : []
          return { role: message.role, content: message.content, ...(imagePaths.length ? { imagePaths } : {}) }
        })
        .slice(-MAX_HISTORY)
      return data
    },
    async latest() {
      const id = (await readFile(join(directory, "latest"), "utf8")).trim()
      return this.load(id)
    },
    async save(session, { updateLatest = updateLatestPointer } = {}) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const target = fileFor(session.id)
      session.updatedAt = new Date().toISOString()
      const temp = `${target}.${randomUUID()}.tmp`
      const handle = await open(temp, "wx", 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(session, null, 2)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temp, target)
      if (platform !== "win32") await chmod(target, 0o600).catch(() => undefined)
      if (updateLatest) {
        const latestTemp = join(directory, `latest.${randomUUID()}.tmp`)
        await writeFile(latestTemp, `${session.id}\n`, { mode: 0o600 })
        await rename(latestTemp, join(directory, "latest"))
      }
    },
    fork({ updateLatestPointer: childUpdatesLatest = false } = {}) {
      return createSessionStore(workspace, root, { updateLatestPointer: childUpdatesLatest })
    },
    async list(limit = 20) {
      const entries = await readdir(directory, { withFileTypes: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error))
      const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).slice(0, Math.max(1, Math.min(limit, 100)))
      const values = []
      for (const entry of files) {
        try {
          const parsed = JSON.parse(await readFile(join(directory, entry.name), "utf8"))
          values.push({
            id: parsed.id,
            model: parsed.model,
            mode: parsed.mode,
            title: typeof parsed.title === "string" ? parsed.title : null,
            parentSessionId: typeof parsed.parentSessionId === "string" ? parsed.parentSessionId : null,
            updatedAt: parsed.updatedAt,
            messages: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
          })
        } catch {}
      }
      return values.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    },
  }
}

function appendMessage(session, role, content, imagePaths = []) {
  const safe = String(content).slice(0, MAX_MESSAGE_CHARS)
  session.messages.push({ role, content: safe, ...(role === "user" && imagePaths.length ? { imagePaths } : {}) })
  if (session.messages.length > MAX_HISTORY) session.messages.splice(1, session.messages.length - MAX_HISTORY)
  let total = session.messages.reduce((sum, item) => sum + item.content.length, 0)
  while (total > 130_000 && session.messages.length > 2) {
    const [removed] = session.messages.splice(1, 1)
    total -= removed.content.length
  }
}

export async function recoverPendingAction(session, store) {
  const pending = session.pendingAction
  if (!pending) return false
  const name = typeof pending.name === "string" ? pending.name : "unknown tool"
  appendMessage(session, "user", `Recovery notice: the previous CLI process stopped during ${name}. Its outcome is unknown. Inspect the current project state before retrying the action.`)
  session.pendingAction = null
  await store.save(session)
  return true
}

function displayPath(pathname, roots) {
  const root = roots.find((entry) => within(entry, pathname))
  return root ? relative(root, pathname) || "." : pathname
}

async function fileDetails(pathname) {
  const info = await stat(pathname)
  if (!info.isFile()) throw new Error("Поддерживаются только обычные файлы.")
  if (info.size > MAX_READ_BYTES) throw new Error("Файл слишком большой для обработки одним шагом.")
  const content = await readFile(pathname, "utf8")
  if (content.includes("\0")) throw new Error("Бинарный файл нельзя читать или редактировать как текст.")
  return content
}

function imageMimeType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp"
  return null
}

async function readLocalImage(rawPath, roots) {
  const candidate = await resolveWorkspacePath(rawPath, roots, { mustExist: true })
  const pathname = await realpath(candidate)
  if (!roots.some((root) => within(root, pathname))) throw new Error("Изображение находится вне папок, разрешённых для этой сессии.")
  const info = await stat(pathname)
  if (!info.isFile()) throw new Error("Для вложения выберите обычный файл изображения.")
  if (info.size < 1 || info.size > MAX_IMAGE_BYTES) throw new Error(`Размер изображения должен быть от 1 байта до ${MAX_IMAGE_BYTES} байт.`)
  const bytes = await readFile(pathname)
  if (bytes.length !== info.size || bytes.length > MAX_IMAGE_BYTES) throw new Error("Изображение изменилось во время чтения или превышает лимит.")
  const type = imageMimeType(bytes)
  if (!type) throw new Error("Поддерживаются изображения PNG, JPEG и WebP.")
  return { path: pathname, name: basename(pathname), type, size: bytes.length, bytes }
}

export async function validateImagePaths(rawPaths, roots) {
  if (!Array.isArray(rawPaths) || rawPaths.length > MAX_IMAGES_PER_MESSAGE) {
    throw new Error(`Можно прикрепить не больше ${MAX_IMAGES_PER_MESSAGE} изображений к одному сообщению.`)
  }
  const references = []
  const seen = new Set()
  let totalBytes = 0
  for (const rawPath of rawPaths) {
    const image = await readLocalImage(rawPath, roots)
    if (seen.has(image.path)) continue
    seen.add(image.path)
    totalBytes += image.size
    if (totalBytes > MAX_IMAGE_TOTAL_BYTES) throw new Error(`Общий размер изображений не должен превышать ${MAX_IMAGE_TOTAL_BYTES} байт.`)
    references.push({ path: image.path, name: image.name, type: image.type, size: image.size })
  }
  return references
}

async function providerImage(reference, roots) {
  const image = await readLocalImage(reference.path, roots)
  return {
    id: randomUUID(),
    name: image.name,
    type: image.type,
    size: image.size,
    data: `data:${image.type};base64,${image.bytes.toString("base64")}`,
  }
}

async function resolveDesktopRoot() {
  if (platform === "win32") return join(homedir(), "Desktop")
  const userDirs = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "user-dirs.dirs")
  try {
    const config = await readFile(userDirs, "utf8")
    const match = config.match(/^XDG_DESKTOP_DIR="([^"]+)"/mu)
    if (match?.[1]) return resolve(match[1].replaceAll("$HOME", homedir()))
  } catch {}
  return join(homedir(), "Desktop")
}

async function askApproval(action, options) {
  if (options.yes) return true
  const preview = (value) => {
    const safe = String(value ?? "")
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "[ANSI control omitted]")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�")
    return safe.length <= 3_000 ? safe : `${safe.slice(0, 3_000)}\n[Preview shortened]`
  }
  const descriptions = {
    write_file: `Записать файл ${action.input.path}?\nСодержимое:\n${preview(action.input.content)}`,
    edit_file: `Изменить файл ${action.input.path}?\nЗаменить:\n${preview(action.input.oldText)}\nНа:\n${preview(action.input.newText)}`,
    delete_file: `Удалить файл ${action.input.path}?`,
    copy_file: `Скопировать ${action.input.source} в ${action.input.destination}?`,
    move_file: `Переместить ${action.input.source} в ${action.input.destination}?`,
    delegate_task: `Запустить исследовательского подагента в режиме только чтения?\nЗадача: ${preview(action.input.task)}`,
    create_directory: `Создать папку ${action.input.path}?`,
    run_command: `Выполнить команду:\n${action.input.command}`,
  }
  if (await options.approve?.()) return true
  const answer = await options.question(`${descriptions[action.name] || `Разрешить ${action.name}?`} [y/N] `)
  return typeof answer === "string" && /^(y|yes|д|да)$/iu.test(answer.trim())
}

async function assertParentAllowed(pathname, roots) {
  const allowedRoot = roots.find((root) => within(root, pathname))
  if (!allowedRoot) throw new Error("Путь находится вне папок, разрешённых для этой сессии.")
  const existing = await nearestExistingPath(dirname(pathname))
  if (!within(allowedRoot, existing)) throw new Error("Путь через символьную ссылку выходит за разрешённую папку.")
}

async function runShell(command, workspace) {
  if (typeof command !== "string" || !command.trim() || command.length > 4_000) throw new Error("Укажите команду длиной до 4000 символов.")
  const shell = platform === "win32" ? "powershell.exe" : "/bin/sh"
  const powershellCommand = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; $OutputEncoding = [Console]::OutputEncoding; $ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; ${command}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`
  const args = platform === "win32"
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", powershellCommand]
    : ["-lc", command]
  return await new Promise((resolvePromise, rejectPromise) => {
    const childEnv = { ...env }
    for (const key of Object.keys(childEnv)) if (/^(DREYZE|MOONFACET)_.*(COOKIE|TOKEN|SECRET|KEY)$/iu.test(key)) delete childEnv[key]
    const child = spawn(shell, args, { cwd: workspace, env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    let output = ""
    let timedOut = false
    const add = (chunk, label) => {
      if (output.length < 50_000) output += `${label}${chunk.toString("utf8")}`.slice(0, 50_000 - output.length)
    }
    child.stdout.on("data", (chunk) => add(chunk, ""))
    child.stderr.on("data", (chunk) => add(chunk, "[stderr] "))
    child.once("error", rejectPromise)
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM") }, 120_000)
    child.once("close", (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? 1, signal, timedOut, output })
    })
  })
}

export async function executeTool(action, { workspace, roots, approve, question, delegate, webSearch }) {
  const input = action.input || {}
  const getPath = (name = "path", required = true) => {
    const value = input[name]
    if (typeof value !== "string" && required) throw new Error(`Инструмент ${action.name}: поле ${name} отсутствует.`)
    return value
  }
  if (action.name === "ask_user") {
    const prompt = String(input.question || "Уточните задачу")
    const answer = await question(`${prompt}: `)
    if (answer === null) return { requiresInput: prompt, output: "Ожидается ответ пользователя в следующем запуске CLI." }
    return { output: answer || "Пользователь не указал ответ." }
  }
  if (action.name === "delegate_task") {
    const task = getPath("task")
    if (task.length > 6_000) throw new Error("Задача подагента превышает 6000 символов.")
    if (typeof delegate !== "function") throw new Error("Исследовательский подагент недоступен в этом режиме.")
    return await delegate(task)
  }
  if (action.name === "web_search") {
    const query = getPath("query")
    if (query.length > 800) throw new Error("Запрос веб-поиска превышает 800 символов.")
    if (typeof webSearch !== "function") throw new Error("Веб-поиск недоступен в этой сессии.")
    return await webSearch(query)
  }
  if (action.name === "list_files") {
    const directory = await resolveWorkspacePath(getPath("path", false) || ".", roots, { mustExist: true, allowSensitive: true })
    if (!(await stat(directory)).isDirectory()) throw new Error("Указанный путь не является папкой.")
    const entries = await readdir(directory, { withFileTypes: true })
    const lines = entries.filter((entry) => entry.name !== ".git").slice(0, 300).map((entry) => `${entry.isDirectory() ? "[dir] " : "      "}${entry.name}`)
    return { output: `${displayPath(directory, roots)}\n${lines.join("\n")}${entries.length > 300 ? "\n[Список сокращён до 300 элементов]" : ""}` }
  }
  if (action.name === "read_file") {
    const file = await resolveWorkspacePath(getPath(), roots, { mustExist: true })
    const content = await fileDetails(file)
    const lines = content.split(/\r?\n/u)
    const start = Number.isInteger(input.start_line) && input.start_line > 0 ? input.start_line : 1
    const requestedEnd = Number.isInteger(input.end_line) && input.end_line >= start ? input.end_line : start + 299
    const end = Math.min(requestedEnd, start + 399, lines.length)
    return { output: `${displayPath(file, roots)} (строки ${start}-${end} из ${lines.length})\n${lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n")}` }
  }
  if (action.name === "search_text") {
    const query = getPath("query")
    if (query.length > 300) throw new Error("Поисковый запрос превышает 300 символов.")
    const matches = []
    let visited = 0
    async function walk(directory) {
      if (matches.length >= 120 || visited >= 3_000) return
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (matches.length >= 120 || visited >= 3_000) break
        const file = join(directory, entry.name)
        if (entry.isDirectory()) {
          if (!IGNORED_SEARCH_DIRS.has(entry.name)) await walk(file)
          continue
        }
        if (!entry.isFile() || isSensitivePath(file)) continue
        visited++
        const info = await stat(file).catch(() => null)
        if (!info || info.size > 200_000) continue
        const text = await readFile(file, "utf8").catch(() => "")
        if (text.includes("\0")) continue
        const lines = text.split(/\r?\n/u)
        for (let index = 0; index < lines.length; index++) {
          if (lines[index].toLocaleLowerCase().includes(query.toLocaleLowerCase())) matches.push(`${displayPath(file, roots)}:${index + 1}: ${lines[index]}`)
          if (matches.length >= 120) break
        }
      }
    }
    for (const root of roots) await walk(root)
    return { output: `${matches.join("\n") || "Совпадений не найдено."}${visited >= 3_000 ? "\n[Поиск остановлен после 3000 файлов]" : ""}` }
  }

  if (!TOOLS.has(action.name)) throw new Error(`Неизвестный инструмент: ${action.name}.`)
  if (action.name === "create_directory") {
    const location = input.location === "desktop" ? "desktop" : "workspace"
    let target
    let allowedRoots = roots
    if (location === "desktop") {
      const name = getPath()
      if (name.includes("/") || name.includes("\\") || name === "." || name === "..") throw new Error("На рабочем столе можно создать только одну папку с простым именем.")
      const desktop = await resolveDesktopRoot()
      const realDesktop = await realpath(desktop)
      if (!(await stat(realDesktop)).isDirectory()) throw new Error("Папка рабочего стола недоступна.")
      target = resolve(realDesktop, name)
      allowedRoots = [realDesktop]
    } else target = await resolveWorkspacePath(getPath(), roots, { allowSensitive: true })
    await assertParentAllowed(target, allowedRoots)
    if (!(await askApproval(action, { approve, question }))) return { output: "Действие отклонено пользователем." }
    await mkdir(target, { recursive: true })
    return { output: `Папка создана: ${target}` }
  }
  if (action.name === "run_command") {
    if (!(await askApproval(action, { approve, question }))) return { output: "Действие отклонено пользователем." }
    const result = await runShell(getPath("command"), workspace)
    return { output: `Код завершения: ${result.code}${result.timedOut ? " (тайм-аут 120 секунд)" : ""}${result.signal ? `; сигнал ${result.signal}` : ""}\n${result.output || "(команда не вывела текст)"}` }
  }
  if (["copy_file", "move_file"].includes(action.name)) {
    const source = await resolveWorkspacePath(getPath("source"), roots, { mustExist: true })
    const destination = await resolveWorkspacePath(getPath("destination"), roots)
    const sourceInfo = await stat(source)
    if (action.name === "copy_file" && !sourceInfo.isFile()) throw new Error("Копировать можно только обычные файлы.")
    if (action.name === "move_file" && roots.includes(source)) throw new Error("Нельзя перемещать корень разрешённой папки.")
    if (action.name === "move_file" && sourceInfo.isDirectory() && within(source, destination)) {
      throw new Error("Нельзя переместить папку внутрь самой себя.")
    }
    await assertParentAllowed(destination, roots)
    if (await access(destination).then(() => true, () => false)) throw new Error("Путь назначения уже существует.")
    if (!(await askApproval(action, { approve, question }))) return { output: "Действие отклонено пользователем." }
    if (action.name === "copy_file") await copyFile(source, destination)
    else await rename(source, destination)
    return { output: `${action.name === "copy_file" ? "Скопировано" : "Перемещено"}: ${displayPath(destination, roots)}` }
  }
  const file = await resolveWorkspacePath(getPath(), roots, { allowSensitive: action.name === "delete_file" })
  if (action.name === "write_file") {
    const content = getPath("content")
    if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) throw new Error("Размер нового файла превышает 500 КБ.")
    await assertParentAllowed(file, roots)
    const exists = await access(file).then(() => true, () => false)
    if (exists && !(await stat(file)).isFile()) throw new Error("Путь уже существует и не является обычным файлом.")
    if (!(await askApproval(action, { approve, question }))) return { output: "Действие отклонено пользователем." }
    await writeFile(file, content, { encoding: "utf8", mode: 0o600 })
    return { output: `${exists ? "Файл обновлён" : "Файл создан"}: ${displayPath(file, roots)} (${Buffer.byteLength(content)} байт)` }
  }
  if (action.name === "edit_file") {
    const current = await fileDetails(await resolveWorkspacePath(getPath(), roots, { mustExist: true }))
    const oldText = getPath("oldText")
    const newText = getPath("newText")
    const first = current.indexOf(oldText)
    if (!oldText || first < 0) throw new Error("Точный фрагмент для замены не найден. Сначала прочитайте файл.")
    if (current.indexOf(oldText, first + oldText.length) >= 0) throw new Error("Фрагмент встречается несколько раз. Передайте более точный участок.")
    const updated = current.slice(0, first) + newText + current.slice(first + oldText.length)
    if (Buffer.byteLength(updated, "utf8") > MAX_WRITE_BYTES) throw new Error("Размер файла после изменения превышает 500 КБ.")
    if (!(await askApproval(action, { approve, question }))) return { output: "Действие отклонено пользователем." }
    await writeFile(file, updated, "utf8")
    return { output: `Файл изменён: ${displayPath(file, roots)}` }
  }
  if (action.name === "delete_file") {
    const existing = await resolveWorkspacePath(getPath(), roots, { mustExist: true, allowSensitive: true })
    if (!(await stat(existing)).isFile()) throw new Error("Удаление папок этим инструментом запрещено.")
    if (!(await askApproval(action, { approve, question }))) return { output: "Действие отклонено пользователем." }
    await unlink(existing)
    return { output: `Файл удалён: ${displayPath(existing, roots)}` }
  }
  throw new Error(`Инструмент ${action.name} не реализован.`)
}

export function redactSecrets(value) {
  return value
    .replace(/(__Host-dreyzeai_session=)[^\s"'`,;]+/giu, "$1[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "[PRIVATE KEY OMITTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|GOCSPX-[A-Za-z0-9_-]{12,}|re_[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/gu, "[API KEY OMITTED]")
    .replace(/(["']?(?:api[_-]?key|secret|password|token|client[_-]?secret)["']?\s*[=:]\s*["']?)([^\s"'`,;]{8,})/giu, "$1[SECRET OMITTED]")
    .replace(/((?:https?|ssh):\/\/)[^/@:\s]+:[^/@\s]+@/giu, "$1[REDACTED]@")
    .replace(/(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/-]{12,}/giu, "$1[SECRET OMITTED]")
}

function redactPayload(value) {
  if (Array.isArray(value)) return value.map(redactPayload)
  if (!value || typeof value !== "object") return typeof value === "string" ? redactSecrets(value) : value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /(?:authorization|cookie|token|secret|password|api[_-]?key|private[_-]?key)/iu.test(key)
      ? "[REDACTED]"
      : redactPayload(item),
  ]))
}

function truncateOutput(value) {
  const raw = typeof value === "string" ? value : JSON.stringify(value)
  const text = redactSecrets(raw)
  return text.length <= MAX_TOOL_OUTPUT ? text : `${text.slice(0, MAX_TOOL_OUTPUT)}\n[Вывод сокращён]`
}

async function agentMessages(session, roots, catalog) {
  const messages = session.messages.slice(-MAX_HISTORY)
  const latestImageIndex = messages.findLastIndex((message) => message.role === "user" && Array.isArray(message.imagePaths) && message.imagePaths.length > 0)
  const imagePaths = latestImageIndex >= 0 ? messages[latestImageIndex].imagePaths : []
  if (imagePaths.length && imagePaths.length > MAX_IMAGES_PER_MESSAGE) throw new Error("В сохранённой сессии слишком много изображений.")
  const selectedModel = catalog.models.find((model) => model.id === session.model)
  if (imagePaths.length && !selectedModel?.supportsImages) {
    throw Object.assign(new Error("Выбранная модель не принимает изображения. Выберите модель с поддержкой images командой /model или параметром --model."), { code: "MODEL_DOES_NOT_SUPPORT_IMAGES" })
  }
  const attachments = []
  let totalBytes = 0
  for (const path of imagePaths) {
    const attachment = await providerImage({ path }, roots)
    totalBytes += attachment.size
    if (totalBytes > MAX_IMAGE_TOTAL_BYTES) throw new Error(`Общий размер изображений не должен превышать ${MAX_IMAGE_TOTAL_BYTES} байт.`)
    attachments.push(attachment)
  }
  return Promise.all(messages.map(async (message, index) => {
    if (message.role !== "user" || !Array.isArray(message.imagePaths) || !message.imagePaths.length) return { role: message.role, content: message.content }
    if (index !== latestImageIndex) {
      return { role: message.role, content: `${message.content}\n[Ранее приложенное изображение опущено из контекста. При необходимости попроси прикрепить его повторно.]` }
    }
    return { role: message.role, content: message.content, attachments }
  }))
}

async function callAgent(config, session, fetchImpl = fetch, projectInstructions = [], projectSkills = [], roots = [], catalog = { models: [] }, mcpTools = []) {
  const messages = await agentMessages(session, roots, catalog)
  const shell = platform === "win32" ? "powershell" : "posix"
  const response = await fetchImpl(new URL("/api/code/agent/turn", config.url), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Cookie: config.cookie },
    body: JSON.stringify({ model: session.model, mode: session.mode, shell, messages, projectInstructions, projectSkills, mcpTools }),
    redirect: "error",
    signal: AbortSignal.timeout(160_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(safeError(body, `Агент Dreyze ответил с ошибкой HTTP ${response.status}.`)), { code: body?.error?.code || "AGENT_FAILED", status: response.status })
  if (!body || !["plan", "tool", "final", "blocked"].includes(body.type)) throw Object.assign(new Error("Сервер вернул действие вне протокола агента."), { code: "INVALID_AGENT_ACTION" })
  return body
}

function startWaitIndicator(step) {
  if (!stderr.isTTY) return () => {}
  let frame = 0
  const render = () => {
    stderr.write(`\rDreyzeCode · модель отвечает · шаг ${step + 1}${".".repeat((frame++ % 3) + 1)}   `)
  }
  render()
  const timer = setInterval(render, 900)
  timer.unref()
  return () => {
    clearInterval(timer)
    stderr.write("\r\u001b[2K")
  }
}

function actionJSON(action) {
  return JSON.stringify(action)
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function actionFingerprint(action) {
  return createHash("sha256").update(`${action.name}\n${canonicalJSON(action.input)}`).digest("hex")
}

function redactMcpServerCommand(server) {
  let value = server.type === "stdio"
    ? `${server.command} (${server.args.length} arguments)`
    : `${server.url.origin}${server.url.pathname}`
  for (const secret of server.secretValues ?? []) {
    if (secret.length >= 4) value = value.split(secret).join("[SECRET OMITTED]")
  }
  return redactSecrets(value)
}

async function approveMcpServer(server, { yes, question }) {
  if (yes) return true
  const location = server.cwd ? `\nРабочая папка: ${server.cwd}` : ""
  const configured = server.envKeys?.length
    ? `\nНастроены переменные/заголовки: ${server.envKeys.join(", ")} (значения скрыты)`
    : ""
  const answer = await question(
    `Запустить MCP сервер ${server.label}?\nТип: ${server.type}\nКоманда или адрес: ${redactMcpServerCommand(server)}${location}${configured}\n[y/N] `,
  )
  return typeof answer === "string" && /^(y|yes|д|да)$/iu.test(answer.trim())
}

async function approveMcpTool(action, mcp, { yes, question }) {
  if (yes) return true
  const tool = mcp.describe(action.name)
  const input = mcp.redact(JSON.stringify(action.input)).slice(0, 2_500)
  const answer = await question(
    `Вызвать внешний MCP инструмент ${tool?.serverName ?? "сервер"} · ${tool?.toolName ?? action.name}?\nОписание: ${redactSecrets(tool?.description ?? "").slice(0, 500)}\nАргументы: ${input}${input.length >= 2_500 ? "\n[Аргументы сокращены]" : ""}\n[y/N] `,
  )
  return typeof answer === "string" && /^(y|yes|д|да)$/iu.test(answer.trim())
}

export async function runAgentTask({ config, catalog, session, store, roots, workspace, question, yes = false, fetchImpl = fetch, onOutput = () => {} }) {
  await recoverPendingAction(session, store)
  const [projectInstructions, projectSkills] = await Promise.all([
    loadProjectInstructions(roots),
    loadProjectSkills(roots),
  ])
  const mcp = session.mode === "build"
    ? await connectMcpServers({
      roots,
      userConfigPath: join(configRoot, "mcp.json"),
      approveServer: (server) => approveMcpServer(server, { yes, question }),
      onIssue: (issue) => stderr.write(`MCP: ${redactSecrets(issue)}\n`),
    })
    : { tools: [], has: () => false, describe: () => null, redact: (value) => redactSecrets(value), call: async () => { throw new Error("MCP инструменты недоступны.") }, close: async () => {} }
  let previousActionFingerprint = ""
  let repeatedActionCount = 0
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
    const stopWaiting = startWaitIndicator(step)
    let action
    try {
      action = await callAgent(config, session, fetchImpl, projectInstructions, projectSkills, roots, catalog, mcp.tools)
    } finally {
      stopWaiting()
    }
    if (action.type === "blocked") throw Object.assign(new Error("Режим Plan запретил действие, меняющее проект."), { code: "PLAN_MODE_READ_ONLY" })
    if (action.type === "final") {
      appendMessage(session, "assistant", action.content)
      await store.save(session)
      onOutput(action.content)
      return { final: action.content, steps: step + 1 }
    }
    if (action.type === "plan") {
      previousActionFingerprint = ""
      repeatedActionCount = 0
      appendMessage(session, "assistant", actionJSON(action))
      await store.save(session)
      onOutput(action.content)
      if (session.mode === "plan") return { final: action.content, steps: step + 1 }
      continue
    }
    const mcpAction = mcp.has(action.name)
    if ((!TOOLS.has(action.name) && !mcpAction) || !action.input || typeof action.input !== "object" || Array.isArray(action.input)) {
      throw Object.assign(new Error("Модель запросила неизвестный инструмент."), { code: "INVALID_TOOL_ACTION" })
    }
    if (session.mode === "plan" && !PLAN_TOOLS.has(action.name)) throw Object.assign(new Error("Plan разрешает только чтение файлов и поиск."), { code: "PLAN_MODE_READ_ONLY" })
    const fingerprint = actionFingerprint(action)
    if (fingerprint === previousActionFingerprint) repeatedActionCount++
    else {
      previousActionFingerprint = fingerprint
      repeatedActionCount = 1
    }
    appendMessage(session, "assistant", actionJSON(action))
    await store.save(session)
    if (repeatedActionCount >= 2) {
      const stopped = repeatedActionCount >= 3
      const message = stopped
        ? "Агент остановлен: он повторил один и тот же вызов инструмента три раза подряд. Предыдущий результат сохранён; измените запрос или продолжите с другой моделью."
        : "Этот идентичный вызов уже был выполнен или отклонён непосредственно перед этим. Повторно он не запускался. Используй предыдущий результат или выбери другое действие."
      appendMessage(session, "user", `Tool result (${action.name}): ${message}`)
      await store.save(session)
      if (stopped) throw Object.assign(new Error("Модель трижды повторила один и тот же вызов инструмента; цикл остановлен."), { code: "REPEATED_TOOL_ACTION" })
      continue
    }
    if (MUTATING_TOOLS.has(action.name) || mcpAction) {
      const approved = mcpAction
        ? await approveMcpTool(action, mcp, { yes, question })
        : await askApproval(action, { yes, question })
      if (!approved) {
        appendMessage(session, "user", `Tool result (${action.name}): действие отклонено пользователем.`)
        await store.save(session)
        continue
      }
      session.pendingAction = { id: randomUUID(), name: action.name, startedAt: new Date().toISOString() }
      await store.save(session)
    }
    let result
    try {
      result = mcpAction ? await mcp.call(action.name, action.input) : await executeTool(action, {
        workspace,
        roots,
        approve: async () => true,
        question,
        yes: true,
        delegate: async (task) => {
          if (typeof store.fork !== "function") throw new Error("Не удалось создать отдельную сессию подагента.")
          const subagentStore = store.fork()
          const subagent = await subagentStore.create(session.model, "plan")
          subagent.parentSessionId = session.id
          subagent.title = task.slice(0, 100)
          appendMessage(subagent, "user", `Проведи отдельное исследование проекта по задаче:\n${task}\n\nТолько читай и ищи файлы. Не изменяй проект и не запускай команды. Верни конкретные наблюдения, пути и выводы для основного агента.`)
          await subagentStore.save(subagent)
          const result = await runAgentTask({
            config, catalog, session: subagent, store: subagentStore, roots, workspace,
            question: async () => null,
            yes: false,
            fetchImpl,
            onOutput: () => {},
          })
          if (result.final) return { output: `Результат исследовательского подагента (только чтение):\n${result.final}` }
          if (result.requiresInput) return { output: `Подагенту требуется уточнение, которое нужно задать пользователю: ${result.requiresInput}` }
          return { output: "Подагент завершил исследование без итогового ответа." }
        },
        webSearch: (query) => searchAgentWeb(config, query, fetchImpl),
      })
    } catch (error) {
      result = { output: `Инструмент завершился ошибкой: ${error instanceof Error ? error.message : "неизвестная ошибка"}` }
    }
    session.pendingAction = null
    if (result?.requiresInput) {
      session.pendingQuestion = result.requiresInput
      await store.save(session)
      onOutput(result.requiresInput)
      return { requiresInput: result.requiresInput, steps: step + 1 }
    }
    appendMessage(session, "user", `Tool result (${action.name}):\n${truncateOutput(result?.output ?? "Готово.")}`)
    await store.save(session)
  }
  throw Object.assign(new Error(`Агент достиг лимита ${MAX_STEPS} шагов и сохранил сессию. Продолжите через --continue.`), { code: "STEP_LIMIT" })
  } finally {
    await mcp.close()
  }
}

export async function loadProjectInstructions(roots) {
  const files = []
  const seen = new Set()
  let visitedDirectories = 0
  let remaining = MAX_PROJECT_INSTRUCTION_CHARS
  let truncated = false

  async function walk(root, directory) {
    if (files.length >= MAX_PROJECT_INSTRUCTION_FILES || visitedDirectories >= 3_000 || remaining <= 0) {
      truncated = true
      return
    }
    visitedDirectories++
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (files.length >= MAX_PROJECT_INSTRUCTION_FILES || visitedDirectories >= 3_000 || remaining <= 0) {
        truncated = true
        return
      }
      const pathname = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_SEARCH_DIRS.has(entry.name)) await walk(root, pathname)
        continue
      }
      const isRootGuide = entry.isFile() && entry.name.toLocaleLowerCase() === "agents.md"
      const isDreyzeGuide = entry.isFile() && entry.name.toLocaleLowerCase() === "instructions.md" && basename(directory).toLocaleLowerCase() === ".dreyze"
      if (!isRootGuide && !isDreyzeGuide) continue
      if (isSensitivePath(pathname)) continue
      const info = await lstat(pathname).catch(() => null)
      if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_PROJECT_INSTRUCTION_FILE_BYTES) continue
      const canonicalPath = await realpath(pathname).catch(() => null)
      if (!canonicalPath || !within(root, canonicalPath) || seen.has(canonicalPath)) continue
      seen.add(canonicalPath)
      const available = Math.min(remaining, MAX_PROJECT_INSTRUCTION_FILE_BYTES)
      const content = (await readFile(canonicalPath, "utf8").catch(() => "")).replace(/^\uFEFF/u, "")
      if (!content.trim()) continue
      const clipped = content.length > available
      const clipMarker = "\n[Инструкции сокращены по лимиту контекста]"
      const body = clipped && available > clipMarker.length
        ? `${content.slice(0, available - clipMarker.length)}${clipMarker}`
        : clipped ? content.slice(0, available) : content
      const rootLabel = roots.indexOf(root) === 0 ? "." : `--add-dir ${roots.indexOf(root) + 1}`
      const relativePath = relative(root, canonicalPath).split(sep).join("/") || entry.name
      const safeBody = redactSecrets(body)
      files.push({ path: `${rootLabel}/${relativePath}`, content: safeBody })
      remaining -= safeBody.length
      if (clipped) truncated = true
    }
  }

  for (const root of roots) await walk(root, root)
  if (truncated && files.length) {
    const marker = "\n[Остальные файлы инструкций не переданы из-за ограничения контекста.]"
    const last = files.at(-1)
    const used = files.reduce((total, item) => total + item.content.length, 0)
    const available = MAX_PROJECT_INSTRUCTION_CHARS - used
    const shortenBy = Math.max(0, marker.length - available)
    last.content = `${last.content.slice(0, Math.max(0, last.content.length - shortenBy))}${marker}`
  }
  return files
}

export async function loadProjectSkills(roots) {
  const skills = []
  let remaining = MAX_PROJECT_SKILL_CHARS
  const seen = new Set()
  for (const root of roots) {
    if (skills.length >= MAX_PROJECT_SKILLS || remaining <= 0) break
    const candidateRoot = join(root, ".dreyze", "skills")
    const rootInfo = await lstat(candidateRoot).catch(() => null)
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) continue
    const skillsRoot = await realpath(candidateRoot).catch(() => null)
    if (!skillsRoot || !within(root, skillsRoot)) continue
    const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => [])
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (skills.length >= MAX_PROJECT_SKILLS || remaining <= 0) break
      if (!entry.isDirectory() || !entry.name.trim() || entry.name.length > 80 || /[\u0000-\u001f\u007f]/u.test(entry.name)) continue
      const directory = join(skillsRoot, entry.name)
      const dirInfo = await lstat(directory).catch(() => null)
      if (!dirInfo?.isDirectory() || dirInfo.isSymbolicLink()) continue
      const skillFile = join(directory, "SKILL.md")
      const fileInfo = await lstat(skillFile).catch(() => null)
      if (!fileInfo?.isFile() || fileInfo.isSymbolicLink() || fileInfo.size < 1 || fileInfo.size > MAX_PROJECT_INSTRUCTION_FILE_BYTES) continue
      const canonicalFile = await realpath(skillFile).catch(() => null)
      if (!canonicalFile || !within(root, canonicalFile) || seen.has(canonicalFile)) continue
      const content = (await readFile(canonicalFile, "utf8").catch(() => "")).replace(/^\uFEFF/u, "")
      const frontMatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1] ?? ""
      const scalar = (key) => {
        const lines = frontMatter.split(/\r?\n/u)
        const index = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*:`, "iu").test(line))
        if (index < 0) return ""
        const value = lines[index].replace(new RegExp(`^\\s*${key}\\s*:\\s*`, "iu"), "").trim()
        if (!value) return ""
        if (/^[>|][+-]?$/u.test(value)) {
          const block = []
          for (let lineIndex = index + 1; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex]
            if (line.trim() && !/^\s/u.test(line)) break
            if (line.trim()) block.push(line.trim())
          }
          return block.join(" ")
        }
        if (value.startsWith('"') && value.endsWith('"')) {
          try { return JSON.parse(value) } catch { return value.slice(1, -1) }
        }
        if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/gu, "'")
        return value
      }
      const name = redactSecrets(scalar("name") || entry.name).slice(0, 80)
      const description = redactSecrets(scalar("description")).slice(0, 800)
      const rootLabel = roots.indexOf(root) === 0 ? "." : `--add-dir ${roots.indexOf(root) + 1}`
      const path = relative(root, canonicalFile).split(sep).join("/")
      const skill = { name, path: `${rootLabel}/${path}`, description }
      const size = skill.name.length + skill.path.length + skill.description.length
      if (size > remaining) {
        const shortenedDescription = skill.description.slice(0, Math.max(0, remaining - skill.name.length - skill.path.length))
        skill.description = shortenedDescription
      }
      const finalSize = skill.name.length + skill.path.length + skill.description.length
      if (!finalSize || finalSize > remaining) continue
      seen.add(canonicalFile)
      skills.push(skill)
      remaining -= finalSize
    }
  }
  return skills
}

function promptInterface(jsonMode = false) {
  const output = jsonMode ? stderr : stdout
  const rl = createInterface({ input: stdin, output, terminal: Boolean(stdin.isTTY) })
  return {
    ask: (prompt) => new Promise((resolvePromise) => {
      if (!stdin.isTTY) return resolvePromise(null)
      rl.question(prompt, resolvePromise)
    }),
    close: () => rl.close(),
  }
}

async function canonicalRoots(workspace, addDirs) {
  const roots = [await realpath(workspace)]
  for (const raw of addDirs) {
    const resolved = await realpath(resolve(workspace, raw))
    if (!(await stat(resolved)).isDirectory()) throw new Error(`Дополнительный путь не является папкой: ${raw}`)
    if (!roots.includes(resolved)) roots.push(resolved)
  }
  return roots
}

async function sessionFor(options, store, catalog) {
  if (options.sessionID) return store.load(options.sessionID)
  if (options.continuing) {
    try { return await store.latest() } catch (error) {
      if (error?.code !== "ENOENT") throw error
      throw new Error("В этом проекте нет сохранённой сессии. Запустите dreyzecode run \"задача\".")
    }
  }
  return store.create(options.model || catalog.defaultModel, options.mode || "build")
}

async function readTheme() {
  try {
    const value = JSON.parse(await readFile(join(configRoot, "theme.json"), "utf8")).preset
    return ["system", "purple", "blue"].includes(value) ? value : "system"
  } catch {
    return "system"
  }
}

function accent(value) {
  if (env.NO_COLOR !== undefined || !stdout.isTTY) return (text) => text
  const color = value === "purple" ? "\u001b[95m" : value === "blue" ? "\u001b[94m" : ""
  return (text) => color ? `${color}${text}\u001b[0m` : text
}

function writeChatMessage(title, content, color = (text) => text) {
  const panel = formatChatMessage(title, content, stdout.columns || 76).split("\n")
  stdout.write(`\n${color(panel[0])}\n${panel.slice(1, -1).join("\n")}\n${color(panel.at(-1))}\n`)
}

function printSlashHelp(color) {
  const rows = SLASH_COMMANDS.map(({ usage, description }) => `${usage.padEnd(25)} ${description}`)
  rows.push(`${"//текст".padEnd(25)} отправить модели текст, начинающийся с /`)
  writeChatMessage("Команды DreyzeCode", rows.join("\n"), color)
}

function printHumanModels(catalog) {
  for (const model of catalog.models) stdout.write(`${model.id === catalog.defaultModel ? "* " : "  "}${model.id}\t${model.name}\t${model.group}${model.supportsImages ? "\timages" : ""}\n`)
}

export async function apiGet(config, pathname, jsonMode) {
  if (typeof pathname !== "string" || !pathname.startsWith("/api/") || pathname.includes("\\")) throw new Error("api get принимает только путь /api/ на сервере Dreyze.")
  const url = new URL(pathname, config.url)
  if (url.origin !== config.url || !url.pathname.startsWith("/api/")) throw new Error("Запрос за пределы API Dreyze запрещён.")
  const response = await fetch(url, { headers: { Accept: "application/json", Cookie: config.cookie }, redirect: "error", signal: AbortSignal.timeout(15_000) })
  const text = (await response.text()).slice(0, 100_000)
    .replace(/(__Host-dreyzeai_session=)[^\s"'`,;]+/giu, "$1[REDACTED]")
    .replace(/(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/-]{12,}/giu, "$1[REDACTED]")
  let body
  try { body = redactPayload(JSON.parse(text)) } catch { body = redactSecrets(text) }
  if (jsonMode) jsonOut({ ok: response.ok, status: response.status, path: pathname, data: body })
  else stdout.write(`${typeof body === "string" ? body : JSON.stringify(body, null, 2)}\n`)
  if (!response.ok) process.exitCode = 1
}

async function listSessions(options, workspace) {
  const store = createSessionStore(workspace)
  const sessions = await store.list(100)
  if (options.json) jsonOut({ ok: true, sessions })
  else for (const session of sessions) {
    const kind = session.parentSessionId ? `subagent${session.title ? ` · ${session.title}` : ""}` : "session"
    stdout.write(`${session.id}\t${kind}\t${session.mode}\t${session.model}\t${session.updatedAt}\t${session.messages} messages\n`)
  }
}

async function showSession(options, workspace) {
  const store = createSessionStore(workspace)
  const id = options.positionals[1]
  if (!id) throw new Error("sessions show требует ID сессии.")
  const session = await store.load(id)
  const output = {
    id: session.id,
    model: session.model,
    mode: session.mode,
    title: session.title ?? null,
    parentSessionId: session.parentSessionId ?? null,
    updatedAt: session.updatedAt,
    messages: session.messages,
  }
  if (options.json) jsonOut({ ok: true, session: output })
  else for (const message of output.messages) stdout.write(`\n${message.role.toUpperCase()}\n${message.content}\n`)
}

async function runPrompt(prompt, options, config, catalog, session, store, roots, workspace, questioner) {
  if (!prompt.trim()) throw new Error("Введите задачу после команды run.")
  if (options.model && !catalog.models.some((model) => model.id === options.model)) throw new Error(`Модель «${options.model}» отсутствует в каталоге Dreyze.`)
  await recoverPendingAction(session, store)
  session.model = options.model || session.model || catalog.defaultModel
  session.mode = options.mode || session.mode || "build"
  const imagePaths = await validateImagePaths(options.imagePaths ?? [], roots)
  if (imagePaths.length && !catalog.models.find((model) => model.id === session.model)?.supportsImages) {
    throw Object.assign(new Error("Выбранная модель не принимает изображения. Выберите модель с поддержкой images командой /model или параметром --model."), { code: "MODEL_DOES_NOT_SUPPORT_IMAGES" })
  }
  const pendingQuestion = session.pendingQuestion
  session.pendingQuestion = null
  if (options.addDirs.length) appendMessage(session, "user", `Дополнительные папки, явно разрешённые для этой сессии: ${roots.slice(1).join(", ")}. Используй абсолютные пути внутри них, если это необходимо.`)
  if (pendingQuestion) appendMessage(session, "user", `Ответ на уточнение «${pendingQuestion}»: ${prompt}`, imagePaths)
  else appendMessage(session, "user", prompt, imagePaths)
  await store.save(session)
  const result = await runAgentTask({
    config, catalog, session, store, roots, workspace, yes: options.yes,
    question: questioner.ask,
    onOutput: (text) => {
      if (options.json) return
      if (typeof options.chatColor === "function") writeChatMessage(`DreyzeCode · ${session.model} · ${session.mode}`, text, options.chatColor)
      else stdout.write(`${text}\n`)
    },
  })
  if (options.json) jsonOut({ ok: true, session: { id: session.id, model: session.model, mode: session.mode }, ...result })
  return result
}

export async function resumeInteractiveSession({
  options,
  config,
  catalog,
  session,
  store,
  roots,
  workspace,
  questioner,
  recovered,
  runTask = runAgentTask,
  onOutput = (text) => stdout.write(`${text}\n`),
}) {
  if (!options.continuing) return false
  if (session.pendingQuestion) {
    const pendingQuestion = session.pendingQuestion
    const answer = await questioner.ask(`${pendingQuestion}: `)
    if (answer === null) {
      onOutput(pendingQuestion)
      return false
    }
    session.pendingQuestion = null
    appendMessage(session, "user", `Ответ на уточнение «${pendingQuestion}»: ${answer}`)
    await store.save(session)
  }

  const last = session.messages.at(-1)
  if (!recovered && last?.role !== "user") return false
  await runTask({
    config,
    catalog,
    session,
    store,
    roots,
    workspace,
    question: questioner.ask,
    yes: options.yes,
    onOutput,
  })
  return true
}

async function interactive(options, config, catalog, initialSession, store, roots, workspace, questioner) {
  let session = initialSession
  let theme = await readTheme()
  let color = accent(theme)
  let pendingImagePaths = [...(options.imagePaths ?? [])]
  const printSessionHeader = () => {
    const mode = session.mode === "plan" ? "Plan · только чтение" : "Build · изменения с подтверждением"
    writeChatMessage("DreyzeCode", `Проект: ${workspace}\nМодель: ${session.model}\nРежим: ${mode}`, color)
    stdout.write("Напишите задачу или введите /help.\n")
  }
  const printModels = () => {
    const rows = catalog.models.map((model) => `${model.id === session.model ? "●" : "○"} ${model.name} · ${model.id}${model.supportsImages ? " · images" : ""}`)
    writeChatMessage("Модели Dreyze", rows.join("\n") || "Каталог моделей пуст.", color)
  }
  printSessionHeader()
  const recovered = await recoverPendingAction(session, store)
  const resumed = await resumeInteractiveSession({
    options,
    config,
    catalog,
    session,
    store,
    roots,
    workspace,
    questioner,
    recovered,
    onOutput: (text) => writeChatMessage(`DreyzeCode · ${session.model} · ${session.mode}`, text, color),
  })
  if (options.continuing && session.pendingQuestion && !resumed) return
  while (true) {
    const input = await questioner.ask(`\n${color("❯")} `)
    if (!input) { if (!stdin.isTTY) break; continue }
    const parsedCommand = parseSlashCommand(input)
    if (parsedCommand) {
      const { name, argument } = parsedCommand
      const value = argument.trim()
      if (!SLASH_COMMAND_NAMES.has(name)) {
        writeChatMessage("Неизвестная команда", `/${name} не найдена. Введите /help, чтобы посмотреть команды DreyzeCode.`, color)
        continue
      }
      if (name === "exit" || name === "quit") break
      if (name === "help") {
        printSlashHelp(color)
        continue
      }
      if (name === "mode") {
        if (!value) writeChatMessage("Режим", `Сейчас: ${session.mode}. Используйте /mode build или /mode plan.`, color)
        else if (!["build", "plan"].includes(value.toLowerCase())) writeChatMessage("Режим", "Выберите build или plan.", color)
        else {
          session.mode = value.toLowerCase()
          await store.save(session)
          writeChatMessage("Режим обновлён", session.mode === "plan" ? "Plan · только чтение" : "Build · изменения с подтверждением", color)
        }
        continue
      }
      if (name === "model" || name === "models") {
        if (!value) {
          printModels()
          continue
        }
        const requested = value.replace(/^("|')(.*)\1$/su, "$2")
        const selected = catalog.models.find((model) => model.id.toLowerCase() === requested.toLowerCase() || model.name.toLowerCase() === requested.toLowerCase())
        if (!selected) writeChatMessage("Модель не найдена", `Не нашёл «${requested}». Введите /model, чтобы открыть каталог.`, color)
        else {
          session.model = selected.id
          await store.save(session)
          writeChatMessage("Модель обновлена", `${selected.name} · ${selected.id}`, color)
        }
        continue
      }
      if (name === "attach") {
        const imagePath = value.replace(/^("|')(.*)\1$/su, "$2")
        if (!imagePath) writeChatMessage("Вложение", "Использование: /attach ./путь/к/изображению.png", color)
        else if (pendingImagePaths.length >= MAX_IMAGES_PER_MESSAGE) writeChatMessage("Вложение", `К сообщению можно добавить не больше ${MAX_IMAGES_PER_MESSAGE} изображений.`, color)
        else {
          pendingImagePaths.push(imagePath)
          writeChatMessage("Вложение добавлено", `${basename(imagePath)} будет отправлено со следующим сообщением.`, color)
        }
        continue
      }
      if (name === "detach") {
        const count = pendingImagePaths.length
        pendingImagePaths = []
        writeChatMessage("Вложения очищены", count ? `Убрано файлов: ${count}.` : "Нет вложений для следующего сообщения.", color)
        continue
      }
      if (name === "theme") {
        if (!value) {
          writeChatMessage("Тема", `Сейчас: ${theme}. Варианты: purple, blue, system.`, color)
          continue
        }
        const requestedTheme = value.toLowerCase()
        if (!["purple", "blue", "system"].includes(requestedTheme)) {
          writeChatMessage("Тема", "Выберите purple, blue или system.", color)
          continue
        }
        theme = requestedTheme
        await mkdir(configRoot, { recursive: true, mode: 0o700 })
        await writeFile(join(configRoot, "theme.json"), `${JSON.stringify({ preset: theme })}\n`, { mode: 0o600 })
        color = accent(theme)
        writeChatMessage("Тема сохранена", theme, color)
        continue
      }
      if (name === "status") {
        const attachments = pendingImagePaths.length ? pendingImagePaths.map(basename).join(", ") : "нет"
        writeChatMessage("Состояние сессии", `ID: ${session.id}\nМодель: ${session.model}\nРежим: ${session.mode}\nПроект: ${workspace}\nВложения: ${attachments}`, color)
        continue
      }
      if (name === "sessions") {
        const sessions = await store.list(10)
        if (!sessions.some((item) => item.id === session.id)) {
          sessions.unshift({ id: session.id, model: session.model, mode: session.mode, title: session.title ?? null, parentSessionId: session.parentSessionId ?? null, updatedAt: session.updatedAt, messages: session.messages.length })
        }
        const rows = sessions.slice(0, 10).map((item) => `${item.id === session.id ? "● текущая" : "○ сессия"} · ${item.id}\n  ${item.title || item.model} · ${item.mode} · ${item.messages} сообщений`)
        writeChatMessage("Последние сессии", rows.join("\n") || "Сессий пока нет.", color)
        continue
      }
      if (name === "resume") {
        try {
          session = value ? await store.load(value) : await store.latest()
          pendingImagePaths = []
          writeChatMessage("Сессия открыта", `${session.id}\n${session.model} · ${session.mode}`, color)
        } catch {
          writeChatMessage("Сессия не найдена", value ? `Не удалось открыть ${value}.` : "В этом проекте ещё нет сохранённых сессий.", color)
        }
        continue
      }
      if (name === "new") {
        session = await store.create(session.model || catalog.defaultModel, session.mode || "build")
        pendingImagePaths = []
        await store.save(session)
        writeChatMessage("Новая сессия", `${session.id}\n${session.model} · ${session.mode}`, color)
        continue
      }
      if (name === "clear") {
        if (stdout.isTTY) stdout.write("\u001b[2J\u001b[H")
        printSessionHeader()
        writeChatMessage("История сохранена", "Экран очищен. Сессия и её история не изменились.", color)
        continue
      }
    }
    const prompt = input.startsWith("//") ? input.slice(1) : input
    const attachmentNote = pendingImagePaths.length ? `\n\nВложения: ${pendingImagePaths.map(basename).join(", ")}` : ""
    writeChatMessage("Вы", `${prompt}${attachmentNote}`, color)
    try {
      await runPrompt(prompt, { ...options, imagePaths: pendingImagePaths, chatColor: color }, config, catalog, session, store, roots, workspace, questioner)
      pendingImagePaths = []
    }
    catch (error) { writeChatMessage("Ошибка", error instanceof Error ? error.message : "Не удалось выполнить задачу.", color) }
  }
}

async function launchAuth(args) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join(packageDirectory, "auth-cli.mjs"), ...args], { stdio: "inherit", windowsHide: false })
    child.once("error", rejectPromise)
    child.once("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal)
      resolvePromise(code ?? 1)
    })
  })
}

export async function runCli(args = process.argv.slice(2)) {
  let options
  try { options = parseArgs(args) } catch (error) { reportError(error, args.includes("--json")); return }
  if (options.command === "help") return printHelp()
  if (options.command === "version") return stdout.write(`DreyzeCode ${VERSION}\n`)
  if (options.command === "login" || options.command === "logout") {
    const authArgs = args.filter((arg) => !["--json", "--yes"].includes(arg))
    process.exitCode = await launchAuth(authArgs)
    return
  }
  const config = await readConfig()
  if (options.command === "doctor") return doctor(config, options.json)
  const workspace = await realpath(process.cwd())
  if (options.command === "sessions") {
    const subcommand = options.positionals[0]
    if (subcommand === "list") return listSessions(options, workspace)
    if (subcommand === "show") return showSession(options, workspace)
    throw new Error("Использование: dreyzecode sessions list|show ID")
  }
  if (options.command === "skills") {
    const subcommand = options.positionals[0]
    if (subcommand && subcommand !== "list") throw new Error("Использование: dreyzecode skills list")
    const skills = await loadProjectSkills(await canonicalRoots(workspace, options.addDirs))
    if (options.json) jsonOut({ ok: true, skills })
    else if (!skills.length) stdout.write("В разрешённых папках проекта skills не найдены.\n")
    else for (const skill of skills) stdout.write(`${skill.name}\t${skill.path}\t${skill.description}\n`)
    return
  }
  if (options.command === "mcp") {
    const subcommand = options.positionals[0]
    if (subcommand && subcommand !== "list") throw new Error("Использование: dreyzecode mcp list")
    const roots = await canonicalRoots(workspace, options.addDirs)
    const result = await listConfiguredMcpServers({ roots, userConfigPath: join(configRoot, "mcp.json") })
    if (options.json) jsonOut({ ok: true, ...result })
    else {
      if (!result.servers.length) stdout.write("MCP серверы не настроены. См. раздел MCP в README.\n")
      else for (const server of result.servers) {
        const target = server.type === "stdio" ? server.command : server.url
        stdout.write(`${server.name}\t${server.type}\t${target}\n`)
      }
      for (const issue of result.issues) stderr.write(`MCP: ${redactSecrets(issue)}\n`)
    }
    return
  }
  if (!config) throw Object.assign(new Error("Сначала войдите: dreyzecode login."), { code: "AUTH_REQUIRED" })
  if (options.command === "api") {
    if (options.positionals[0] !== "get" || !options.positionals[1]) throw new Error("Использование: dreyzecode api get /api/...")
    return apiGet(config, options.positionals[1], options.json)
  }
  const catalog = await fetchModelCatalog(config)
  if (options.command === "models") {
    if (options.positionals[0] && options.positionals[0] !== "list") throw new Error("Использование: dreyzecode models list")
    if (options.json) jsonOut({ ok: true, defaultModel: catalog.defaultModel, models: catalog.models })
    else printHumanModels(catalog)
    return
  }
  const roots = await canonicalRoots(workspace, options.addDirs)
  const store = createSessionStore(workspace)
  const session = await sessionFor(options, store, catalog)
  if (options.model && !catalog.models.some((model) => model.id === options.model || model.name.toLowerCase() === options.model.toLowerCase())) {
    throw new Error(`Модель «${options.model}» отсутствует в каталоге Dreyze.`)
  }
  if (options.model) session.model = catalog.models.find((model) => model.id === options.model || model.name.toLowerCase() === options.model.toLowerCase()).id
  if (options.mode) session.mode = options.mode
  const questioner = promptInterface(options.json)
  try {
    if (options.command === "run" || options.positionals.length > 0) {
      return await runPrompt(options.positionals.join(" "), options, config, catalog, session, store, roots, workspace, questioner)
    }
    return await interactive(options, config, catalog, session, store, roots, workspace, questioner)
  } finally {
    questioner.close()
  }
}

const invokedPath = process.argv[1]
  ? await realpath(process.argv[1]).catch(() => resolve(process.argv[1]))
  : null
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => reportError(error, process.argv.includes("--json")))
}
