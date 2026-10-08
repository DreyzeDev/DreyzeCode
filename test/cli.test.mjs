import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  createSessionStore,
  apiGet,
  executeTool,
  fetchModelCatalog,
  isSensitivePath,
  loadProjectInstructions,
  loadProjectSkills,
  parseArgs,
  redactSecrets,
  recoverPendingAction,
  resumeInteractiveSession,
  resolveWorkspacePath,
  runAgentTask,
  validateImagePaths,
} from "../cli.mjs"

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
  assert.equal(parseArgs(["skills", "list"]).command, "skills")
  assert.equal(parseArgs(["--continue"]).continuing, true)
  assert.deepEqual(parseArgs(["--image", "./first.png", "--image=./second.webp", "run", "Describe photos"]).imagePaths, ["./first.png", "./second.webp"])
})

test("runs authenticated web search as a read-only agent tool", async (t) => {
  const { workspace, config } = await fixture(t)
  const store = createSessionStore(workspace, config)
  const session = await store.create("dreyze/research", "plan")
  session.messages.push({ role: "user", content: "Find the current Node.js fetch documentation." })
  const requests = []
  const result = await runAgentTask({
    config: { url: "https://moonfacet.example", cookie: "__Host-dreyzeai_session=abc" },
    catalog: { models: [], defaultModel: "dreyze/research" },
    session,
    store,
    roots: [workspace],
    workspace,
    question: async () => "",
    onOutput: () => {},
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
      path: "./.dreyze/skills/interface-review/SKILL.md",
      description: "Review layout, responsive behavior, and accessibility.",
    },
    {
      name: "Release Checklist",
      path: "./.dreyze/skills/release/SKILL.md",
      description: "Check release gates before publishing.",
    },
  ])
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
    path: "./.dreyze/skills/release/SKILL.md",
    description: "Release checklist.",
  }])
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
  assert.equal(saveCount, 1)
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
  assert.equal(child.stdout, "DreyzeCode 0.4.2\n")
})

test("help documents image input in both one-shot and interactive modes", async () => {
  const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url))
  const child = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" })
  assert.equal(child.status, 0, child.stderr)
  assert.match(child.stdout, /--image PATH/u)
  assert.match(child.stdout, /\/attach PATH/u)
  assert.match(child.stdout, /skills list/u)
})

test("the raw API escape hatch rejects paths that normalize outside /api", async () => {
  await assert.rejects(apiGet({ url: "https://moonfacet.example", cookie: "secret" }, "/api/../account", true), /API Dreyze/u)
  await assert.rejects(apiGet({ url: "https://moonfacet.example", cookie: "secret" }, "//evil.example/api/models", true), /путь \/api\//u)
})
