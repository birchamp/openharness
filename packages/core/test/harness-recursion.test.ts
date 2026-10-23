import { expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { HarnessContrast } from "@opencode/core/session/harness/contrast"
import { HarnessLibrary } from "@opencode/core/session/harness/library"
import { HarnessSchedule } from "@opencode/core/session/harness/schedule"
import { HarnessTree } from "@opencode/core/session/harness/tree"
import { tmpdir } from "./fixture/tmpdir"

const text = (content: string, origin: HarnessTree.Origin): HarnessTree.TextPart => ({ content, origin })
const file = (name: string, origin: HarnessTree.Origin, content = name): HarnessTree.FilePart => ({
  name,
  content,
  origin,
})

function tree(input: {
  readonly prompt?: HarnessTree.TextPart
  readonly guardrails?: HarnessTree.TextPart
  readonly memory?: HarnessTree.TextPart
  readonly toolGuidance?: HarnessTree.TextPart
  readonly skills?: readonly HarnessTree.FilePart[]
  readonly subagents?: readonly HarnessTree.FilePart[]
  readonly scripts?: readonly HarnessTree.FilePart[]
  readonly plugins?: readonly HarnessTree.FilePart[]
}): HarnessTree.Tree {
  return {
    prompt: input.prompt,
    guardrails: input.guardrails,
    memory: input.memory,
    toolGuidance: input.toolGuidance,
    skills: input.skills ?? [],
    subagents: input.subagents ?? [],
    scripts: input.scripts ?? [],
    plugins: input.plugins ?? [],
  }
}

const note = (subject: HarnessLibrary.Experience["subject"], cue = "when a test fails"): HarnessLibrary.Experience => ({
  cue,
  lesson: "Read the failure before editing.",
  evidence: "The reference run stopped on a red test.",
  subject,
})

test("defaults to sequential k=1 and repeats that round", () => {
  expect(HarnessSchedule.request({})).toEqual({ mode: "sequential", k: 1 })
  expect(HarnessSchedule.schedule("sequential", 1).map(HarnessSchedule.stageLabel)).toEqual([
    "reference 1.1",
    "propose invariant 1.1",
    "propose domain 1.1",
    "probe invariant 1.1",
    "probe domain 1.1",
    "compose 1.1",
  ])
  expect(HarnessSchedule.plannedSessions("sequential", 1)).toBe(7)
  expect(HarnessSchedule.schedule("sequential", 2).map((stage) => stage.round)).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2])
  const parallel = HarnessSchedule.schedule("parallel", 2)
  expect(parallel.every((stage) => stage.round === 1)).toBe(true)
  expect(parallel.filter((stage) => stage.kind === "propose" && stage.lane === "invariant")).toHaveLength(2)
  expect(parallel.filter((stage) => stage.kind === "propose" && stage.lane === "domain")).toHaveLength(2)
  expect(parallel.filter((stage) => stage.kind === "compose")).toHaveLength(2)
  const kinds = parallel.map((stage) => stage.kind)
  expect(kinds.indexOf("probe")).toBeGreaterThan(kinds.lastIndexOf("propose"))
  expect(kinds.indexOf("compose")).toBeGreaterThan(kinds.lastIndexOf("probe"))
})

test("retries an invalid proposal once, then keeps the current harness", () => {
  const current = tree({ prompt: text("current", "invariant") })
  const replacement = tree({ prompt: text("next", "invariant") })
  expect(
    HarnessSchedule.settle(
      [
        { valid: false, value: tree({ prompt: text("bad", "invariant") }) },
        { valid: true, value: replacement },
      ],
      current,
    ),
  ).toEqual({ value: replacement, fallback: false })
  expect(
    HarnessSchedule.settle(
      [
        { valid: false, value: replacement },
        { valid: false, value: replacement },
        { valid: true, value: replacement },
      ],
      current,
    ),
  ).toEqual({ value: current, fallback: true })
  const carried = HarnessSchedule.carry(current, [
    { harness: replacement, fallback: false },
    { harness: tree({ prompt: text("later", "invariant") }), fallback: true },
  ])
  expect(carried).toBe(replacement)
  expect(
    HarnessSchedule.chooseComposition(current, [
      { harness: replacement, fallback: true },
      { harness: tree({ prompt: text("second", "domain") }), fallback: false },
    ]).harness.prompt?.content,
  ).toBe("second")
})

test("splits invariant harness notes from domain components and leaves a fallback in place", () => {
  const current = {
    user: tree({ prompt: text("user", "invariant") }),
    project: tree({ guardrails: text("project", "domain") }),
  }
  const mixed = tree({
    prompt: text("write a review before editing", "invariant"),
    guardrails: text("follow the repo layout", "domain"),
    skills: [file("review", "invariant", "Review the diff.")],
  })
  const adopted = HarnessLibrary.applyAdoption(current, { tree: mixed, experience: note("harness") })
  expect(adopted.user.prompt?.content).toBe("write a review before editing")
  expect(adopted.user.skills.map((skill) => skill.name)).toEqual(["review"])
  expect(adopted.user.guardrails).toBeUndefined()
  expect(adopted.project.guardrails?.content).toBe("follow the repo layout")
  expect(adopted.project.prompt).toBeUndefined()
  expect(adopted.project.skills).toEqual([])

  const repository = HarnessLibrary.applyAdoption(current, { tree: mixed, experience: note("repository") })
  expect(repository.user).toBe(current.user)
  expect(repository.project.guardrails?.content).toBe("follow the repo layout")
  expect(repository.project.prompt).toBeUndefined()

  const domainOnly = HarnessLibrary.applyAdoption(current, {
    tree: tree({ guardrails: text("new project rule", "domain") }),
    experience: note("harness"),
  })
  expect(domainOnly.user).toBe(current.user)
  expect(domainOnly.project.guardrails?.content).toBe("new project rule")
  expect(HarnessLibrary.applyAdoption(current, undefined)).toEqual(current)
})

test("rejects grader verdicts and oracles in a harness tree", () => {
  const clean = tree({
    prompt: text("Review the diff before editing.", "invariant"),
    plugins: [file("lint.ts", "domain", "export const lint = true")],
  })
  expect(HarnessTree.graderViolation(HarnessTree.treeTexts(clean))).toBeUndefined()
  expect(
    HarnessTree.graderViolation(HarnessTree.treeTexts(tree({ prompt: text("grader verdict: pass", "invariant") }))),
  ).toContain("grader verdict")
  expect(
    HarnessTree.graderViolation(HarnessTree.treeTexts(tree({ memory: text("consult the oracle", "domain") }))),
  ).toContain("oracle")
  expect(
    HarnessTree.graderViolation(
      HarnessTree.treeTexts(tree({ plugins: [file("oracle.md", "domain", "hidden answer")] })),
    ),
  ).toContain("oracle")
  expect(
    HarnessTree.graderViolation([{ path: "experience.json", text: "score: 1\nground truth is in the tests" }]),
  ).toBeDefined()
})

test("reads an adopted library back without rolling the live harness backward", async () => {
  await using dir = await tmpdir()
  const root = path.join(dir.path, "harness")
  const live = tree({ prompt: text("live prompt", "invariant"), skills: [file("review", "invariant", "Review first.")] })
  const older = tree({ prompt: text("older prompt", "invariant") })
  const newer = tree({
    prompt: text("newer prompt", "invariant"),
    skills: [file("review", "invariant", "Review the diff, then edit.")],
  })
  await Effect.runPromise(HarnessTree.write(HarnessLibrary.liveDirectory(root), live))
  await Effect.runPromise(HarnessLibrary.upsert(HarnessLibrary.libraryDirectory(root), older, note("harness", "old cue")))
  const before = await Effect.runPromise(HarnessTree.read(HarnessLibrary.liveDirectory(root), "invariant"))
  const read = await Effect.runPromise(HarnessLibrary.readLibrary(HarnessLibrary.libraryDirectory(root)))
  const after = await Effect.runPromise(HarnessTree.read(HarnessLibrary.liveDirectory(root), "invariant"))
  expect(read).toHaveLength(1)
  expect(read[0]?.experience.cue).toBe("old cue")
  expect(read[0]?.experience.lesson).toBe("Read the failure before editing.")
  expect(read[0]?.experience.evidence).toContain("red test")
  expect(read[0]?.tree.prompt?.content).toBe("older prompt")
  expect(after?.prompt?.content).toBe(before?.prompt?.content)
  expect(after?.skills[0]?.content).toContain("Review first.")

  await Effect.runPromise(HarnessLibrary.upsert(HarnessLibrary.libraryDirectory(root), newer, note("harness", "old cue")))
  const updated = await Effect.runPromise(HarnessLibrary.readLibrary(HarnessLibrary.libraryDirectory(root)))
  expect(updated).toHaveLength(1)
  expect(updated[0]?.tree.prompt?.content).toBe("newer prompt")
  expect(updated[0]?.tree.skills[0]?.content).toContain("Review the diff")
  const stillLive = await Effect.runPromise(HarnessTree.read(HarnessLibrary.liveDirectory(root), "invariant"))
  expect(stillLive?.prompt?.content).toBe("live prompt")

  await Effect.runPromise(HarnessLibrary.commitLayer(root, newer, note("harness", "fresh cue")))
  const committed = await Effect.runPromise(HarnessTree.read(HarnessLibrary.liveDirectory(root), "invariant"))
  const history = await Effect.runPromise(HarnessLibrary.readLibrary(HarnessLibrary.libraryDirectory(root)))
  expect(committed?.prompt?.content).toBe("newer prompt")
  expect(history.map((entry) => entry.experience.cue).toSorted()).toEqual(["fresh cue", "old cue"])
  const reread = await Effect.runPromise(HarnessTree.read(HarnessLibrary.liveDirectory(root), "invariant"))
  expect(reread?.prompt?.content).toBe("newer prompt")
  const index = await readFile(path.join(HarnessLibrary.libraryDirectory(root), "index.json"), "utf8")
  expect(index).toContain("fresh cue")
})

test("gives every proposer the user library and this project's proposer the project library too", () => {
  const user = [{ id: "1", experience: note("harness"), tree: tree({ prompt: text("user", "invariant") }) }]
  const project = [{ id: "2", experience: note("repository"), tree: tree({ guardrails: text("project", "domain") }) }]
  expect(HarnessLibrary.librariesForProposer({ user, project: undefined }).map((entry) => entry.id)).toEqual(["1"])
  expect(HarnessLibrary.librariesForProposer({ user, project }).map((entry) => entry.id)).toEqual(["1", "2"])
})

test("composes from diffs, tests, review notes, and where a run stuck", () => {
  const trajectory = HarnessContrast.trajectoryFrom({
    label: "probe invariant 1.1",
    diff: "diff -- src/a.ts\n+added",
    messages: [
      {
        type: "assistant",
        content: [
          { type: "text", text: "The review found a missing check." },
          { type: "tool", name: "shell", state: { status: "completed", input: { command: "bun test" } } },
        ],
      },
      { type: "shell", command: "bun test", exit: 1 },
      {
        type: "assistant",
        content: [
          {
            type: "tool",
            name: "shell",
            state: { status: "error", input: { command: "bun test" }, error: { message: "tests failed" } },
          },
        ],
      },
    ],
  })
  const rendered = HarnessContrast.contrast([trajectory])
  expect(rendered).toContain("diff -- src/a.ts")
  expect(rendered).toContain("bun test")
  expect(rendered).toContain("The review found a missing check.")
  expect(rendered).toContain("tests failed")
  expect(rendered).not.toContain("verdict")
  expect(rendered).not.toContain("oracle")
})

test("loads the user harness before the project harness, under the built-in prompt", () => {
  const files = HarnessTree.instructionFiles({
    user: tree({ prompt: text("user overlay", "invariant") }),
    project: tree({ prompt: text("project overlay", "domain"), guardrails: text("project rules", "domain") }),
  })
  expect(files.map((file) => file.path)).toEqual([
    "harness://user/prompt",
    "harness://project/prompt",
    "harness://project/guardrails",
  ])
  expect(files[0]?.content).toContain("built-in OpenCode prompt")
  expect(files[0]?.content).toContain("user overlay")
  expect(files[1]?.content).toContain("project overlay")
  const merged = HarnessTree.overlay(
    tree({ prompt: text("user overlay", "invariant"), skills: [file("review", "invariant")] }),
    tree({ prompt: text("project overlay", "domain"), skills: [file("review", "domain", "project review")] }),
  )
  expect(merged.prompt?.content).toBe("user overlay\n\nproject overlay")
  expect(merged.skills.map((skill) => skill.content)).toEqual(["project review"])
  const candidate = HarnessTree.instructionFiles({
    candidate: tree({ prompt: text("candidate", "invariant") }),
    user: tree({ prompt: text("user overlay", "invariant") }),
    project: tree({ prompt: text("project overlay", "domain") }),
  })
  expect(candidate.map((file) => file.path)).toEqual(["harness://candidate/prompt"])
})
