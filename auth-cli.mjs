#!/usr/bin/env node
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { createHash, randomBytes } from "node:crypto"
import { env, platform } from "node:process"
import { homedir } from "node:os"
import { join } from "node:path"
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises"

const DEFAULT_URL = "https://moonfacet.com"
const configRoot = platform === "win32"
  ? join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "DreyzeCode")
  : join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "dreyze-code")
const configFile = join(configRoot, "config.json")

function normalizeUrl(raw) {
  const url = new URL(raw)
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Адрес Dreyze AI должен использовать HTTPS.")
  }
  return url.origin
}

async function saveConfig(config) {
  await mkdir(configRoot, { recursive: true, mode: 0o700 })
  await writeFile(configFile, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
  if (platform !== "win32") await chmod(configFile, 0o600).catch(() => undefined)
}

async function login(args) {
  let url = env.DREYZEAI_URL || DEFAULT_URL
  const urlIndex = args.indexOf("--url")
  if (urlIndex >= 0 && args[urlIndex + 1]) url = args[urlIndex + 1]
  url = normalizeUrl(url)

  const state = randomBytes(32).toString("hex")
  const codeVerifier = randomBytes(32).toString("base64url")
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
  const receiver = await createLoopbackReceiver(state)
  const loginUrl = new URL("/code/cli-login", url)
  loginUrl.searchParams.set("redirect_uri", receiver.redirectUri)
  loginUrl.searchParams.set("state", state)
  loginUrl.searchParams.set("code_challenge", codeChallenge)
  const remote = args.includes("--remote") || Boolean(env.SSH_CONNECTION)
  if (remote) {
    const callbackPort = new URL(receiver.redirectUri).port
    console.log("Вход запущен на удалённом сервере.")
    console.log(`На своём компьютере запустите SSH-туннель: ssh -N -L ${callbackPort}:127.0.0.1:${callbackPort} USER@YOUR_SERVER`)
    console.log("После подключения туннеля откройте эту ссылку на своём компьютере:\n" + loginUrl.toString())
  } else {
    console.log("Открываю Dreyze AI в браузере для входа через Google или почту…")
    if (!openBrowser(loginUrl.toString())) {
      console.log("Не удалось открыть браузер автоматически. Откройте эту ссылку вручную:\n" + loginUrl.toString())
    } else {
      console.log("Если браузер не открылся, скопируйте ссылку:\n" + loginUrl.toString())
    }
  }

  let code
  try {
    code = await receiver.authorizationCode
  } finally {
    receiver.close()
  }

  const response = await fetch(url + "/api/code/cli/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: url },
    body: JSON.stringify({ code, state, redirectUri: receiver.redirectUri, codeVerifier }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error?.message || "Не удалось завершить вход CLI. Запустите dreyzecode login ещё раз.")
  if (typeof body.cookie !== "string" || !/^__Host-dreyzeai_session=[0-9a-f]{64}$/.test(body.cookie)) {
    throw new Error("Сервер вернул некорректную CLI-сессию. Попробуйте войти ещё раз.")
  }
  await saveConfig({ url, cookie: body.cookie, savedAt: new Date().toISOString() })
  console.log("Вход выполнен. Сессия CLI сохранена в конфигурации пользователя.")
}

function createLoopbackReceiver(expectedState) {
  let resolveCode
  let rejectCode
  let settled = false
  let timer
  const authorizationCode = new Promise((resolvePromise, rejectPromise) => {
    resolveCode = resolvePromise
    rejectCode = rejectPromise
  })
  const server = createServer((request, response) => {
    const callback = new URL(request.url || "/", "http://127.0.0.1")
    const code = callback.searchParams.get("code") || ""
    const state = callback.searchParams.get("state") || ""
    const valid = request.method === "GET" && callback.pathname === "/callback"
      && /^[0-9a-f]{64}$/.test(code) && state === expectedState
    response.writeHead(valid ? 200 : 400, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      Connection: "close",
    })
    response.end(valid
      ? "Вход выполнен. Можно вернуться в DreyzeCode и закрыть эту вкладку."
      : "Ссылка входа недействительна. Вернитесь в терминал и запустите вход ещё раз.")
    if (valid && !settled) {
      settled = true
      clearTimeout(timer)
      resolveCode(code)
      server.close()
    }
  })

  const listening = new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise)
    server.listen(0, "127.0.0.1", resolvePromise)
  })
  return listening.then(() => {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Не удалось запустить локальный callback для входа.")
    timer = setTimeout(() => {
      if (settled) return
      settled = true
      server.close()
      rejectCode(new Error("Вход не завершён за 5 минут. Запустите dreyzecode login ещё раз."))
    }, 5 * 60 * 1000)
    timer.unref()
    return {
      redirectUri: `http://127.0.0.1:${address.port}/callback`,
      authorizationCode,
      close() {
        clearTimeout(timer)
        if (server.listening) server.close()
      },
    }
  })
}

function openBrowser(url) {
  try {
    const command = platform === "win32" ? "explorer.exe" : platform === "darwin" ? "open" : "xdg-open"
    const child = spawn(command, [url], { detached: true, stdio: "ignore" })
    child.once("error", () => undefined)
    child.unref()
    return true
  } catch {
    return false
  }
}

async function logout() {
  let revoked = false
  try {
    const stored = JSON.parse(await readFile(configFile, "utf8"))
    if (
      typeof stored.url === "string" &&
      typeof stored.cookie === "string" &&
      /^__Host-dreyzeai_session=[0-9a-f]{64}$/.test(stored.cookie)
    ) {
      const url = normalizeUrl(stored.url)
      const response = await fetch(new URL("/api/auth", url), {
        method: "DELETE",
        headers: { Origin: url, Cookie: stored.cookie },
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      })
      revoked = response.ok
    }
  } catch {
    // Always clear the local credential, even if the account service is unavailable.
  }
  await unlink(configFile).catch(() => undefined)
  console.log(
    revoked
      ? "Сессия DreyzeCode завершена на этом компьютере и сервере."
      : "Локальная сессия удалена. Серверная сессия может оставаться активной до истечения срока.",
  )
}

const [command, ...args] = process.argv.slice(2)
if (command === "login") {
  await login(args).catch((error) => {
    console.error(`Ошибка: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
} else if (command === "logout") {
  await logout()
} else {
  console.error("Использование: dreyzecode login [--url URL] [--remote] | dreyzecode logout")
  process.exitCode = 2
}
