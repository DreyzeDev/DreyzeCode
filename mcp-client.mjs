import { Client, SSEClientTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { lstat, readFile, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const MAX_CONFIG_BYTES = 64_000
const MAX_SERVERS = 16
const MAX_TOOLS = 80
const MAX_SCHEMA_CHARS = 12_000
const MAX_TOOL_CONTEXT_CHARS = 250_000
const MAX_TOOL_DESCRIPTION = 1_500
const MAX_MCP_MESSAGE_BYTES = 2_000_000
const MCP_TOOL_TIMEOUT_MS = 120_000

function within(root, candidate) {
  const rel = relative(root, candidate)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function sanitizeSchema(value, secrets, depth = 0) {
  if (depth > 32) return undefined
  if (typeof value === "string") return safeText(value, secrets)
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => sanitizeSchema(item, secrets, depth + 1))
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).slice(0, 1_000).map(([key, item]) => [
    key,
    /(?:authorization|cookie|token|secret|password|api[_-]?key)/iu.test(key) && typeof item === "string"
      ? "[REDACTED]"
      : sanitizeSchema(item, secrets, depth + 1),
  ]))
}

function expandEnvironment(value, source, secretValues) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, key) => {
    const replacement = process.env[key]
    if (typeof replacement !== "string") throw new Error(`Не задана переменная окружения ${key}.`)
    if (replacement.length >= 4) secretValues.push(replacement)
    return replacement
  })
}

function validateLabel(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/u.test(value)
}

function validateHeaderName(value) {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/u.test(value)
}

function safeRemoteUrl(raw) {
  let url
  try { url = new URL(raw) } catch { throw new Error("URL MCP сервера некорректен.") }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase())
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.hash) {
    throw new Error("Для удалённого MCP нужен HTTPS URL без логина, пароля и fragment.")
  }
  return url
}

async function readConfigFile(pathname, label, scopedRoot) {
  let info
  try { info = await lstat(pathname) } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { servers: [], issues: [] }
    return { servers: [], issues: [`Не удалось прочитать конфигурацию MCP (${label}).`] }
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_CONFIG_BYTES) {
    return { servers: [], issues: [`Конфигурация MCP (${label}) должна быть обычным файлом размером до 64 КБ.`] }
  }
  let content
  try {
    const resolved = await realpath(pathname)
    if (scopedRoot && !within(scopedRoot, resolved)) {
      return { servers: [], issues: [`Конфигурация MCP (${label}) выходит за разрешённую папку.`] }
    }
    const current = await stat(resolved)
    if (!current.isFile() || current.size > MAX_CONFIG_BYTES) {
      return { servers: [], issues: [`Конфигурация MCP (${label}) превышает 64 КБ.`] }
    }
    content = await readFile(resolved, "utf8")
  } catch {
    return { servers: [], issues: [`Не удалось прочитать конфигурацию MCP (${label}).`] }
  }

  let parsed
  try { parsed = JSON.parse(content) } catch {
    return { servers: [], issues: [`Файл MCP (${label}) содержит некорректный JSON.`] }
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    return { servers: [], issues: [`Файл MCP (${label}) должен содержать объект mcpServers.`] }
  }

  const servers = []
  const issues = []
  for (const [name, raw] of Object.entries(parsed.mcpServers).slice(0, MAX_SERVERS)) {
    try {
      if (!validateLabel(name) || !isRecord(raw)) throw new Error("Некорректная запись сервера.")
      const type = raw.type ?? "stdio"
      if (!["stdio", "http", "sse"].includes(type)) throw new Error("Поддерживаются типы stdio, http и sse.")
      const secretValues = []
      if (type === "stdio") {
        if (typeof raw.command !== "string" || !raw.command.trim() || raw.command.length > 500 || /[\u0000-\u001f\u007f]/u.test(raw.command)) {
          throw new Error("Укажите команду stdio сервера.")
        }
        if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.length > 50 || raw.args.some((arg) => typeof arg !== "string" || arg.length > 2_000 || /[\u0000]/u.test(arg)))) {
          throw new Error("Список аргументов stdio сервера некорректен.")
        }
        const command = expandEnvironment(raw.command, name, secretValues)
        const args = (raw.args ?? []).map((arg) => expandEnvironment(arg, name, secretValues))
        const serverEnv = {}
        if (raw.env !== undefined && !isRecord(raw.env)) throw new Error("Поле env должно быть объектом.")
        for (const [key, value] of Object.entries(raw.env ?? {})) {
          if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/u.test(key) || typeof value !== "string" || value.length > 8_000 || /[\u0000]/u.test(value)) {
            throw new Error("Переменные окружения stdio сервера некорректны.")
          }
          serverEnv[key] = expandEnvironment(value, name, secretValues)
          if (serverEnv[key].length >= 4) secretValues.push(serverEnv[key])
        }
        const baseDirectory = scopedRoot ?? dirname(pathname)
        if (raw.cwd !== undefined && (typeof raw.cwd !== "string" || raw.cwd.length > 1_000 || /[\u0000]/u.test(raw.cwd))) {
          throw new Error("Папка запуска MCP сервера некорректна.")
        }
        const cwd = raw.cwd === undefined ? baseDirectory : resolve(baseDirectory, raw.cwd)
        if (scopedRoot && !within(scopedRoot, cwd)) throw new Error("Рабочая папка MCP сервера должна находиться внутри разрешённой папки.")
        let resolvedCwd
        try { resolvedCwd = await realpath(cwd) } catch {
          throw new Error("Рабочая папка MCP сервера не существует или недоступна.")
        }
        if (!(await stat(resolvedCwd)).isDirectory()) throw new Error("Рабочая папка MCP сервера должна быть папкой.")
        if (scopedRoot) {
          let resolvedRoot
          try { resolvedRoot = await realpath(scopedRoot) } catch {
            throw new Error("Разрешённая папка проекта недоступна.")
          }
          if (!within(resolvedRoot, resolvedCwd)) {
            throw new Error("Рабочая папка MCP сервера должна находиться внутри разрешённой папки.")
          }
        }
        servers.push({
          name,
          label: `${label}/${name}`,
          alias: `${label.replace(/[^A-Za-z0-9_-]/gu, "_")}_${name}`,
          type,
          command,
          args,
          env: serverEnv,
          envKeys: Object.keys(serverEnv),
          cwd: resolvedCwd,
          secretValues,
        })
      } else {
        if (typeof raw.url !== "string" || raw.url.length > 2_000) throw new Error("Укажите URL удалённого MCP сервера.")
        const url = safeRemoteUrl(expandEnvironment(raw.url, name, secretValues))
        for (const [key, value] of url.searchParams) {
          if (/(?:authorization|auth|cookie|token|secret|password|api[_-]?key)/iu.test(key) && value.length >= 4) {
            secretValues.push(value)
          }
        }
        if (raw.headers !== undefined && !isRecord(raw.headers)) throw new Error("Поле headers должно быть объектом.")
        const headers = {}
        for (const [key, value] of Object.entries(raw.headers ?? {})) {
          if (!validateHeaderName(key) || typeof value !== "string" || value.length > 8_000 || /[\r\n\u0000]/u.test(value)) {
            throw new Error("Заголовки MCP сервера некорректны.")
          }
          headers[key] = expandEnvironment(value, name, secretValues)
          if (headers[key].length >= 4) secretValues.push(headers[key])
        }
        servers.push({
          name,
          label: `${label}/${name}`,
          alias: `${label.replace(/[^A-Za-z0-9_-]/gu, "_")}_${name}`,
          type,
          url,
          headers,
          envKeys: Object.keys(raw.headers ?? {}),
          cwd: null,
          secretValues,
        })
      }
    } catch (error) {
      issues.push(`Сервер MCP ${label}/${name} пропущен: ${error instanceof Error ? error.message : "некорректная конфигурация"}`)
    }
  }
  if (Object.keys(parsed.mcpServers).length > MAX_SERVERS) issues.push(`В конфигурации MCP (${label}) обрабатываются первые ${MAX_SERVERS} серверов.`)
  return { servers, issues }
}

async function loadServers(roots, userConfigPath) {
  const configs = []
  const issues = []
  if (userConfigPath) configs.push({ path: userConfigPath, label: "user", root: null })
  for (let index = 0; index < roots.length; index++) {
    configs.push({
      path: join(roots[index], ".dreyze", "mcp.json"),
      label: `project_${index + 1}`,
      root: roots[index],
    })
  }
  const servers = []
  for (const config of configs) {
    const result = await readConfigFile(config.path, config.label, config.root)
    servers.push(...result.servers)
    issues.push(...result.issues)
    if (servers.length >= MAX_SERVERS) break
  }
  if (servers.length > MAX_SERVERS) servers.length = MAX_SERVERS
  return { servers, issues }
}

function withTimeout(promise, milliseconds, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: истекло время ожидания.`)), milliseconds)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

function safeText(value, secretValues) {
  let result = String(value)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|GOCSPX-[A-Za-z0-9_-]{12,}|re_[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu, "[SECRET OMITTED]")
    .replace(/(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/-]{12,}/giu, "$1[SECRET OMITTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/giu, "Bearer [SECRET OMITTED]")
    .replace(/((?:\bauthorization|\bauth\b|\bcookie\b|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|secret|password|token)\s*[=:]\s*["']?)[^\s"'`,;]{8,}/giu, "$1[SECRET OMITTED]")
  for (const secret of secretValues) {
    if (secret.length >= 4) result = result.split(secret).join("[SECRET OMITTED]")
  }
  return result
}

function toolOutput(result, secretValues) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  const content = blocks.map((block) => {
    if (block?.type === "text" && typeof block.text === "string") return safeText(block.text, secretValues)
    if (block?.type === "image") return "[Результат MCP содержит изображение; бинарное содержимое не передано модели.]"
    if (block?.type === "audio") return "[Результат MCP содержит аудио; бинарное содержимое не передано модели.]"
    if (block?.type === "resource_link" && typeof block.name === "string") return `[Ссылка на ресурс MCP: ${safeText(block.name, secretValues)}]`
    if (block?.type === "resource" && block.resource && typeof block.resource.text === "string") return safeText(block.resource.text, secretValues)
    return "[Неподдерживаемый блок результата MCP опущен.]"
  })
  if (isRecord(result?.structuredContent)) content.push(safeText(JSON.stringify(result.structuredContent), secretValues))
  const prefix = result?.isError ? "Сервер MCP сообщил об ошибке. " : ""
  return { output: prefix + (content.join("\n") || "Сервер MCP вернул пустой результат.") }
}

export async function connectMcpServers({ roots, userConfigPath, approveServer, onIssue = () => {} }) {
  const loaded = await loadServers(roots, userConfigPath)
  for (const issue of loaded.issues) onIssue(issue)
  const entries = new Map()
  const transports = []
  let totalToolChars = 0

  for (const server of loaded.servers) {
    let approved = false
    try { approved = await approveServer(server) } catch {}
    if (!approved) continue

    let client
    let transport
    let stderrTail = ""
    try {
      client = new Client({ name: "dreyzecode", version: "0.5.13" })
      if (server.type === "stdio") {
        transport = new StdioClientTransport({
          command: server.command,
          args: server.args,
          env: server.env,
          cwd: server.cwd,
          stderr: "pipe",
          maxBufferSize: MAX_MCP_MESSAGE_BYTES,
        })
        transport.stderr?.on("data", (chunk) => {
          stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2_000)
        })
      } else if (server.type === "http") {
        transport = new StreamableHTTPClientTransport(server.url, {
          requestInit: { headers: server.headers, redirect: "error" },
          redirectPolicy: "same-origin",
        })
      } else {
        transport = new SSEClientTransport(server.url, {
          requestInit: { headers: server.headers, redirect: "error" },
          redirectPolicy: "same-origin",
        })
      }
      transports.push(transport)
      await withTimeout(client.connect(transport), 20_000, `Подключение к ${server.label}`)
      const result = await withTimeout(client.listTools(), 20_000, `Получение списка инструментов ${server.label}`)
      const tools = Array.isArray(result.tools) ? result.tools.slice(0, MAX_TOOLS) : []
      for (const tool of tools) {
        if (!tool || typeof tool.name !== "string" || !tool.name.trim() || tool.name.length > 160 || /[\u0000-\u001f\u007f]/u.test(tool.name)) continue
        const inputSchema = isRecord(tool.inputSchema) ? sanitizeSchema(tool.inputSchema, server.secretValues) : { type: "object", properties: {} }
        let schemaText
        try { schemaText = JSON.stringify(inputSchema) } catch { continue }
        if (schemaText.length > MAX_SCHEMA_CHARS) continue
        const name = `mcp.${server.alias}.${tool.name}`
        if (entries.has(name)) continue
        const description = typeof tool.description === "string"
          ? safeText(tool.description.slice(0, MAX_TOOL_DESCRIPTION), server.secretValues)
          : "Инструмент из подключённого MCP сервера."
        const toolChars = name.length + description.length + schemaText.length
        if (totalToolChars + toolChars > MAX_TOOL_CONTEXT_CHARS) continue
        entries.set(name, {
          name,
          serverName: server.label,
          toolName: tool.name,
          description,
          inputSchema,
          client,
          secretValues: server.secretValues,
        })
        totalToolChars += toolChars
        if (entries.size >= MAX_TOOLS) break
      }
    } catch (error) {
      try { await transport?.close() } catch {}
      const detail = stderrTail ? ` ${safeText(stderrTail, server.secretValues).slice(-600)}` : ""
      onIssue(`Не удалось подключить MCP сервер ${server.label}: ${safeText(error instanceof Error ? error.message : "ошибка соединения", server.secretValues)}.${detail}`)
    }
    if (entries.size >= MAX_TOOLS) break
  }

  return {
    tools: [...entries.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    has: (name) => entries.has(name),
    describe: (name) => {
      const entry = entries.get(name)
      return entry ? { serverName: entry.serverName, toolName: entry.toolName, description: entry.description } : null
    },
    redact(value) {
      return safeText(value, loaded.servers.flatMap((server) => server.secretValues))
    },
    async call(name, args) {
      const entry = entries.get(name)
      if (!entry) throw new Error("MCP инструмент больше не подключён.")
      if (!isRecord(args) || JSON.stringify(args).length > 100_000) throw new Error("Аргументы MCP инструмента некорректны или слишком велики.")
      const result = await withTimeout(
        entry.client.callTool({ name: entry.toolName, arguments: args }),
        MCP_TOOL_TIMEOUT_MS,
        `Вызов MCP инструмента ${name}`,
      )
      return toolOutput(result, entry.secretValues)
    },
    async close() {
      await Promise.allSettled(transports.map((transport) => transport.close()))
    },
  }
}

export async function listConfiguredMcpServers({ roots, userConfigPath }) {
  const loaded = await loadServers(roots, userConfigPath)
  return {
    servers: loaded.servers.map(({ label, type, command, args, url, cwd, envKeys, secretValues }) => ({
      name: label,
      type,
      ...(type === "stdio"
        ? { command: safeText(command, secretValues), argumentCount: args.length, cwd }
        : { url: `${url.origin}${url.pathname}` }),
      configuredKeys: envKeys,
    })),
    issues: loaded.issues,
  }
}
