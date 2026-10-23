export * as HarnessLibrary from "./library.js"

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { HarnessTree } from "./tree.js"

export const Experience = Schema.Struct({
  cue: Schema.NonEmptyString,
  lesson: Schema.NonEmptyString,
  evidence: Schema.NonEmptyString,
  subject: Schema.Literals(["harness", "repository"]),
})
export interface Experience extends Schema.Schema.Type<typeof Experience> {}

export interface Entry {
  readonly id: string
  readonly experience: Experience
  readonly tree: HarnessTree.Tree
}

export interface Layers {
  readonly user: HarnessTree.Tree
  readonly project: HarnessTree.Tree
}

const decodeExperience = Schema.decodeUnknownOption(Experience)
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export function experienceFrom(input: unknown) {
  const decoded = decodeExperience(input)
  if (Option.isNone(decoded)) return
  return decoded.value
}

export function experienceFromJson(text: string) {
  const json = decodeJson(text)
  if (Option.isNone(json)) return
  return experienceFrom(json.value)
}

export function userRoot(configDirectory: string) {
  return path.join(configDirectory, "harness")
}

export function projectRoot(projectDirectory: string) {
  return path.join(projectDirectory, ".opencode", "harness")
}

export function liveDirectory(root: string) {
  return path.join(root, "live")
}

export function libraryDirectory(root: string) {
  return path.join(root, "library")
}

/**
 * Invariant components update the user layer only when the note is about the harness.
 * Domain components stay on the project layer. A missing layer keeps the current tree object
 * so callers can see which layer an adoption replaced.
 */
export function applyAdoption(
  current: Layers,
  proposal: { readonly tree: HarnessTree.Tree; readonly experience: Experience } | undefined,
): Layers {
  if (!proposal) return current
  const split = splitLayers(proposal.tree, proposal.experience)
  return {
    user: split.user ?? current.user,
    project: split.project ?? current.project,
  }
}

export function splitLayers(tree: HarnessTree.Tree, experience: Experience) {
  const project = HarnessTree.filterOrigin(tree, "domain")
  const user = experience.subject === "harness" ? HarnessTree.filterOrigin(tree, "invariant") : undefined
  return {
    ...(user && !HarnessTree.isEmpty(user) ? { user } : {}),
    ...(!HarnessTree.isEmpty(project) ? { project } : {}),
  }
}

/** A proposer in any project receives the user library. A proposer in this project also receives the project library. */
export function librariesForProposer(input: {
  readonly user: readonly Entry[]
  readonly project: readonly Entry[] | undefined
}) {
  if (input.project === undefined) return input.user
  return [...input.user, ...input.project]
}

export const readLibrary = Effect.fn("HarnessLibrary.readLibrary")(function* (directory: string) {
  const index = yield* readIndex(directory)
  return yield* Effect.forEach(index, (item) =>
    Effect.gen(function* () {
      const root = path.join(directory, item.id)
      const note = yield* Effect.tryPromise(() => readFile(path.join(root, "experience.json"), "utf8")).pipe(
        Effect.orElseSucceed(() => undefined),
      )
      const experience = (note ? experienceFromJson(note) : undefined) ?? item
      const tree = (yield* HarnessTree.read(path.join(root, "harness"), "domain")) ?? HarnessTree.empty()
      return { id: item.id, experience, tree } satisfies Entry
    }),
  )
})

/** Record an adopted harness. A repeated cue updates that entry in place. This does not write the live harness. */
export const upsert = Effect.fn("HarnessLibrary.upsert")(function* (
  directory: string,
  tree: HarnessTree.Tree,
  experience: Experience,
) {
  const index = yield* readIndex(directory)
  const existing = index.find((item) => item.cue === experience.cue)
  const id =
    existing?.id ??
    String(index.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1)
  const entry = path.join(directory, id)
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(entry, { recursive: true })
      await writeFile(path.join(entry, "experience.json"), `${JSON.stringify(experience, null, 2)}\n`)
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
  yield* HarnessTree.write(path.join(entry, "harness"), tree)
  const next = existing
    ? index.map((item) => (item.id === id ? { id, ...experience } : item))
    : [...index, { id, ...experience }]
  yield* writeIndex(directory, next)
  return id
})

export const commitLayer = Effect.fn("HarnessLibrary.commitLayer")(function* (
  root: string,
  tree: HarnessTree.Tree,
  experience: Experience,
) {
  yield* HarnessTree.write(liveDirectory(root), tree)
  return yield* upsert(libraryDirectory(root), tree, experience)
})

const IndexEntry = Schema.Struct({
  id: Schema.String,
  cue: Schema.String,
  lesson: Schema.String,
  evidence: Schema.String,
  subject: Schema.Literals(["harness", "repository"]),
})
const IndexFile = Schema.Struct({ entries: Schema.Array(IndexEntry) })
const decodeIndex = Schema.decodeUnknownOption(IndexFile)

const readIndex = Effect.fnUntraced(function* (directory: string) {
  const text = yield* Effect.tryPromise(() => readFile(path.join(directory, "index.json"), "utf8")).pipe(
    Effect.orElseSucceed(() => undefined),
  )
  if (text === undefined) return []
  const json = decodeJson(text)
  if (Option.isNone(json)) return []
  const decoded = decodeIndex(json.value)
  if (Option.isNone(decoded)) return []
  return decoded.value.entries.flatMap((item) => {
    const experience = experienceFrom(item)
    if (!experience) return []
    return [{ id: item.id, ...experience }]
  })
})

const writeIndex = (directory: string, entries: readonly { id: string }[]) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, "index.json"), `${JSON.stringify({ entries }, null, 2)}\n`)
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
