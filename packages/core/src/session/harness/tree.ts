export * as HarnessTree from "./tree.js"

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { ConfigMarkdown } from "../../config/markdown.js"

export const components = [
  "prompt",
  "guardrails",
  "memory",
  "tool-guidance",
  "skills",
  "subagents",
  "scripts",
  "plugins",
] as const

export type Origin = "invariant" | "domain"

export interface TextPart {
  readonly content: string
  readonly origin: Origin
}

export interface FilePart {
  readonly name: string
  readonly content: string
  readonly origin: Origin
  readonly description?: string
  readonly path?: string
}

/** Eight components the next child session can load. Absent text means that component is unset. */
export interface Tree {
  readonly prompt?: TextPart
  readonly guardrails?: TextPart
  readonly memory?: TextPart
  readonly toolGuidance?: TextPart
  readonly skills: readonly FilePart[]
  readonly subagents: readonly FilePart[]
  readonly scripts: readonly FilePart[]
  readonly plugins: readonly FilePart[]
}

export const candidateMarker = "CANDIDATE"

const originsSchema = Schema.Record(Schema.String, Schema.Literals(["invariant", "domain"]))
const decodeOrigins = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeOriginRecord = Schema.decodeUnknownOption(originsSchema)

export function empty(): Tree {
  return { skills: [], subagents: [], scripts: [], plugins: [] }
}

export function isEmpty(tree: Tree) {
  return (
    tree.prompt === undefined &&
    tree.guardrails === undefined &&
    tree.memory === undefined &&
    tree.toolGuidance === undefined &&
    tree.skills.length === 0 &&
    tree.subagents.length === 0 &&
    tree.scripts.length === 0 &&
    tree.plugins.length === 0
  )
}

/** Project components replace same-named user components. Text from the project is appended so it sits over the user layer. */
export function overlay(user: Tree, project: Tree): Tree {
  return {
    prompt: overlayText(user.prompt, project.prompt),
    guardrails: overlayText(user.guardrails, project.guardrails),
    memory: overlayText(user.memory, project.memory),
    toolGuidance: overlayText(user.toolGuidance, project.toolGuidance),
    skills: overlayFiles(user.skills, project.skills),
    subagents: overlayFiles(user.subagents, project.subagents),
    scripts: overlayFiles(user.scripts, project.scripts),
    plugins: overlayFiles(user.plugins, project.plugins),
  }
}

export function filterOrigin(tree: Tree, origin: Origin): Tree {
  const text = (part: TextPart | undefined) => (part?.origin === origin ? part : undefined)
  return {
    prompt: text(tree.prompt),
    guardrails: text(tree.guardrails),
    memory: text(tree.memory),
    toolGuidance: text(tree.toolGuidance),
    skills: tree.skills.filter((part) => part.origin === origin),
    subagents: tree.subagents.filter((part) => part.origin === origin),
    scripts: tree.scripts.filter((part) => part.origin === origin),
    plugins: tree.plugins.filter((part) => part.origin === origin),
  }
}

export function withOrigin(tree: Tree, origin: Origin): Tree {
  const text = (part: TextPart | undefined) => (part ? { content: part.content, origin } : undefined)
  const files = (parts: readonly FilePart[]) => parts.map((part) => ({ ...part, origin }))
  return {
    prompt: text(tree.prompt),
    guardrails: text(tree.guardrails),
    memory: text(tree.memory),
    toolGuidance: text(tree.toolGuidance),
    skills: files(tree.skills),
    subagents: files(tree.subagents),
    scripts: files(tree.scripts),
    plugins: files(tree.plugins),
  }
}

const banned = [
  { name: "grader verdict", pattern: /grader[\s_-]*verdict/i },
  { name: "hidden grader", pattern: /hidden\s+grader/i },
  { name: "ground truth", pattern: /ground[\s-]*truth/i },
  { name: "oracle", pattern: /\boracle\b/i },
  { name: "grader", pattern: /\bgrader\b/i },
  { name: "verdict assignment", pattern: /^\s*(grade|verdict|score)\s*[:=]/im },
]

/** Reject a harness that carries a grader verdict or an oracle. Composition has no hidden grader. */
export function graderViolation(parts: readonly { readonly path: string; readonly text: string }[]) {
  for (const part of parts) {
    if (/(^|\/)(grader|oracle|verdict)(\.|\/|$)/i.test(part.path)) return `${part.path} is a grader or oracle file`
    const hit = banned.find((item) => item.pattern.test(part.text))
    if (hit) return `${part.path} contains ${hit.name}`
  }
  return
}

export function treeTexts(tree: Tree) {
  const texts = [
    textOf("prompt", tree.prompt),
    textOf("guardrails", tree.guardrails),
    textOf("memory", tree.memory),
    textOf("tool-guidance", tree.toolGuidance),
    ...tree.skills.map((part) => ({ path: `skills/${part.name}`, text: `${part.description ?? ""}\n${part.content}` })),
    ...tree.subagents.map((part) => ({ path: `subagents/${part.name}`, text: part.content })),
    ...tree.scripts.map((part) => ({ path: `scripts/${part.name}`, text: part.content })),
    ...tree.plugins.map((part) => ({ path: `plugins/${part.name}`, text: part.content })),
  ]
  return texts.filter((part): part is { readonly path: string; readonly text: string } => part !== undefined)
}

export function instructionFiles(input: { readonly user?: Tree; readonly project?: Tree; readonly candidate?: Tree }) {
  if (input.candidate) return componentFiles("candidate", input.candidate)
  return [...componentFiles("user", input.user), ...componentFiles("project", input.project)]
}

export function render(tree: Tree) {
  return [
    section("prompt", tree.prompt?.content),
    section("guardrails", tree.guardrails?.content),
    section("memory", tree.memory?.content),
    section("tool-guidance", tree.toolGuidance?.content),
    named("skills", tree.skills),
    named("subagents", tree.subagents),
    named("scripts", tree.scripts),
    named("plugins", tree.plugins),
  ]
    .filter((part) => part.length > 0)
    .join("\n\n")
}

export const write = Effect.fn("HarnessTree.write")(function* (directory: string, tree: Tree) {
  yield* Effect.tryPromise({
    try: () => writeFiles(directory, tree),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
})

export const read = Effect.fn("HarnessTree.read")(function* (directory: string, fallback: Origin) {
  if (!(yield* directoryExists(directory))) return
  const origins = yield* originTable(path.join(directory, "origins.json"))
  const origin = (key: string) => origins.get(key) ?? fallback
  const prompt = yield* readText(path.join(directory, "prompt.md"), origin("prompt"))
  const guardrails = yield* readText(path.join(directory, "guardrails.md"), origin("guardrails"))
  const memory = yield* readText(path.join(directory, "memory.md"), origin("memory"))
  const toolGuidance = yield* readText(path.join(directory, "tool-guidance.md"), origin("tool-guidance"))
  return {
    prompt,
    guardrails,
    memory,
    toolGuidance,
    skills: yield* readSkills(path.join(directory, "skills"), origin),
    subagents: yield* readMarkdownDir(path.join(directory, "subagents"), "subagents", origin),
    scripts: yield* readFileDir(path.join(directory, "scripts"), "scripts", origin),
    plugins: yield* readFileDir(path.join(directory, "plugins"), "plugins", origin),
  } satisfies Tree
})

/** Copy skills, subagents, and plugins into the directories discovery already scans. */
export const mirrorDiscovery = Effect.fn("HarnessTree.mirrorDiscovery")(function* (root: string, tree: Tree) {
  yield* io(() => mirror(root, tree))
})

/** Stage a candidate into a worktree so discovery and select load this tree instead of the live layers. */
export const stage = Effect.fn("HarnessTree.stage")(function* (root: string, tree: Tree) {
  const directory = path.join(root, ".opencode", "harness", "candidate")
  yield* write(directory, tree)
  yield* io(() => writeFile(path.join(directory, candidateMarker), "candidate\n"))
  yield* mirrorDiscovery(root, tree)
})

export function proposalDirectory(root: string) {
  return path.join(root, ".opencode", "harness", "proposal")
}

function overlayText(user: TextPart | undefined, project: TextPart | undefined) {
  if (user && project) return { content: `${user.content}\n\n${project.content}`, origin: project.origin }
  return project ?? user
}

function overlayFiles(user: readonly FilePart[], project: readonly FilePart[]) {
  const replaced = new Set(project.map((part) => part.name))
  return [...user.filter((part) => !replaced.has(part.name)), ...project]
}

function textOf(name: string, part: TextPart | undefined) {
  if (!part) return
  return { path: name, text: part.content }
}

function section(name: string, content: string | undefined) {
  if (!content) return ""
  return `## ${name}\n${content}`
}

function named(name: string, parts: readonly FilePart[]) {
  if (parts.length === 0) return ""
  return [`## ${name}`, ...parts.map((part) => `### ${part.name}\n${part.content}`)].join("\n\n")
}

function componentFiles(layer: string, tree: Tree | undefined) {
  if (!tree) return []
  const files = [
    instruction(layer, "prompt", tree.prompt, (content) =>
      ["Additional system prompt, applied on top of the built-in OpenCode prompt:", content].join("\n"),
    ),
    instruction(layer, "guardrails", tree.guardrails, (content) => `Guardrails:\n${content}`),
    instruction(layer, "memory", tree.memory, (content) => `Memory:\n${content}`),
    instruction(layer, "tool-guidance", tree.toolGuidance, (content) => `Tool guidance:\n${content}`),
  ].filter((file): file is { readonly path: string; readonly content: string } => file !== undefined)
  if (tree.scripts.length > 0)
    files.push({
      path: `harness://${layer}/scripts`,
      content: tree.scripts.map((part) => `Script ${part.path ?? part.name}:\n${part.content}`).join("\n\n"),
    })
  if (tree.plugins.length > 0)
    files.push({
      path: `harness://${layer}/plugins`,
      content: tree.plugins.map((part) => `Plugin ${part.path ?? part.name}:\n${part.content}`).join("\n\n"),
    })
  if (tree.subagents.length > 0)
    files.push({
      path: `harness://${layer}/subagents`,
      content: `Subagents: ${tree.subagents.map((part) => part.name).join(", ")}. Use the subagent tool to run them.`,
    })
  return files
}

function instruction(
  layer: string,
  name: string,
  part: TextPart | undefined,
  render: (content: string) => string,
) {
  if (!part) return
  return { path: `harness://${layer}/${name}`, content: render(part.content) }
}

async function writeFiles(directory: string, tree: Tree) {
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  const origins: Record<string, Origin> = {}
  await writeText(directory, "prompt.md", "prompt", tree.prompt, origins)
  await writeText(directory, "guardrails.md", "guardrails", tree.guardrails, origins)
  await writeText(directory, "memory.md", "memory", tree.memory, origins)
  await writeText(directory, "tool-guidance.md", "tool-guidance", tree.toolGuidance, origins)
  for (const skill of tree.skills) {
    const name = safeName(skill.name)
    const file = path.join(directory, "skills", name, "SKILL.md")
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(
      file,
      `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description ?? skill.name)}\n---\n${skill.content}`,
    )
    origins[`skills/${name}`] = skill.origin
  }
  for (const agent of tree.subagents) {
    const name = safeName(agent.name)
    const file = path.join(directory, "subagents", `${name}.md`)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(
      file,
      `---\ndescription: ${JSON.stringify(agent.description ?? agent.name)}\nmode: subagent\n---\n${agent.content}`,
    )
    origins[`subagents/${name}`] = agent.origin
  }
  for (const script of tree.scripts) await writeNamed(directory, "scripts", script, origins)
  for (const plugin of tree.plugins) await writeNamed(directory, "plugins", plugin, origins)
  await writeFile(path.join(directory, "origins.json"), `${JSON.stringify(origins, null, 2)}\n`)
}

async function writeText(
  directory: string,
  file: string,
  key: string,
  part: TextPart | undefined,
  origins: Record<string, Origin>,
) {
  if (!part) return
  await writeFile(path.join(directory, file), part.content)
  origins[key] = part.origin
}

async function writeNamed(directory: string, folder: string, part: FilePart, origins: Record<string, Origin>) {
  const name = safeName(part.name)
  const file = path.join(directory, folder, name)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, part.content)
  origins[`${folder}/${name}`] = part.origin
}

async function mirror(root: string, tree: Tree) {
  for (const skill of tree.skills) {
    const name = safeName(skill.name)
    const file = path.join(root, ".opencode", "skills", name, "SKILL.md")
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(
      file,
      `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description ?? skill.name)}\n---\n${skill.content}`,
    )
  }
  for (const agent of tree.subagents) {
    const name = safeName(agent.name)
    const file = path.join(root, ".opencode", "agents", `${name}.md`)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(
      file,
      `---\ndescription: ${JSON.stringify(agent.description ?? agent.name)}\nmode: subagent\n---\n${agent.content}`,
    )
  }
  for (const plugin of tree.plugins) {
    const file = path.join(root, ".opencode", "plugins", safeName(plugin.name))
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, plugin.content)
  }
}

function io(run: () => Promise<void>) {
  return Effect.tryPromise({
    try: () => run(),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

function safeName(name: string) {
  const cleaned = name.replace(/[\\/]/g, "-").trim()
  if (cleaned.length === 0) return "unnamed"
  return cleaned
}

const directoryExists = (directory: string) =>
  Effect.tryPromise(() => readdir(directory)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

const readOptional = (file: string) =>
  Effect.tryPromise(() => readFile(file, "utf8")).pipe(Effect.orElseSucceed(() => undefined))

const originTable = Effect.fnUntraced(function* (file: string) {
  const text = yield* readOptional(file)
  const table = new Map<string, Origin>()
  if (text === undefined) return table
  const json = decodeOrigins(text)
  if (json._tag === "None") return table
  const record = decodeOriginRecord(json.value)
  if (record._tag === "None") return table
  for (const [key, origin] of Object.entries(record.value)) table.set(key, origin)
  return table
})

const readText = Effect.fnUntraced(function* (file: string, origin: Origin) {
  const content = yield* readOptional(file)
  if (content === undefined) return
  return { content, origin }
})

const readSkills = Effect.fnUntraced(function* (
  directory: string,
  origin: (key: string) => Origin,
) {
  if (!(yield* directoryExists(directory))) return []
  const entries = yield* Effect.tryPromise(() => readdir(directory, { withFileTypes: true }))
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
  return yield* Effect.forEach(names, (name) =>
    Effect.gen(function* () {
      const file = path.join(directory, name, "SKILL.md")
      const content = yield* readOptional(file)
      if (content === undefined) return
      const markdown = ConfigMarkdown.parseOption(content)
      const description = markdown && typeof markdown.data.description === "string" ? markdown.data.description : name
      return {
        name,
        description,
        content: markdown?.content ?? content,
        origin: origin(`skills/${name}`),
        path: file,
      } satisfies FilePart
    }),
  ).pipe(Effect.map(present))
})

const readMarkdownDir = Effect.fnUntraced(function* (
  directory: string,
  folder: string,
  origin: (key: string) => Origin,
) {
  const files = yield* filesIn(directory)
  return yield* Effect.forEach(files, (file) =>
    Effect.gen(function* () {
      if (!file.endsWith(".md")) return
      const content = yield* readOptional(path.join(directory, file))
      if (content === undefined) return
      const name = file.slice(0, -3)
      const markdown = ConfigMarkdown.parseOption(content)
      const description = markdown && typeof markdown.data.description === "string" ? markdown.data.description : name
      return {
        name,
        description,
        content: markdown?.content.trim() ?? content,
        origin: origin(`${folder}/${name}`),
        path: path.join(directory, file),
      } satisfies FilePart
    }),
  ).pipe(Effect.map(present))
})

const readFileDir = Effect.fnUntraced(function* (
  directory: string,
  folder: string,
  origin: (key: string) => Origin,
) {
  const files = yield* filesIn(directory)
  return yield* Effect.forEach(files, (file) =>
    Effect.gen(function* () {
      const content = yield* readOptional(path.join(directory, file))
      if (content === undefined) return
      return {
        name: file,
        content,
        origin: origin(`${folder}/${file}`),
        path: path.join(directory, file),
      } satisfies FilePart
    }),
  ).pipe(Effect.map(present))
})

function present<A>(parts: readonly (A | undefined)[]) {
  return parts.flatMap((part) => (part === undefined ? [] : [part]))
}

const filesIn = (directory: string) =>
  Effect.gen(function* () {
    if (!(yield* directoryExists(directory))) return []
    const entries = yield* Effect.tryPromise(() => readdir(directory, { withFileTypes: true }))
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .toSorted()
  })
