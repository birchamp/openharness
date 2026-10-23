export * as HarnessRecursion from "./recursion.js"

import path from "node:path"
import { access, readFile } from "node:fs/promises"
import { Effect } from "effect"
import { Global } from "@opencode/util/global"
import { Location } from "../../location.js"
import { AbsolutePath } from "../../schema.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../schema.js"
import { Worktree } from "../../worktree.js"
import { HarnessContrast } from "./contrast.js"
import { HarnessLibrary } from "./library.js"
import { HarnessSchedule } from "./schedule.js"
import { HarnessTree } from "./tree.js"

export interface Input {
  readonly sessionID: SessionSchema.ID
  readonly task: string
  readonly mode: HarnessSchedule.Mode
  readonly k: number
}

export interface Result {
  readonly adopted: boolean
  readonly fallback: boolean
  readonly sessions: number
  readonly summary: string
}

type Evidence = {
  readonly references: readonly HarnessContrast.Trajectory[]
  readonly probes: readonly HarnessContrast.Trajectory[]
}

type Draft = {
  readonly tree: HarnessTree.Tree
  readonly experience: HarnessLibrary.Experience
}

type State = {
  readonly tree: HarnessTree.Tree
  readonly experience?: HarnessLibrary.Experience
  readonly evidence: Evidence
  readonly changed: boolean
}

/**
 * Parent-session scheduler. Each reference, proposal, probe, and composition is its own session
 * drain in a git worktree. The user tree is written only after a composition is adopted.
 */
export const run = Effect.fn("HarnessRecursion.run")(function* (input: Input) {
  const global = yield* Global.Service
  const location = yield* Location.Service
  const sessions = yield* Session.Service
  const worktrees = yield* Worktree.Service
  const parent = yield* sessions.get(input.sessionID).pipe(Effect.mapError(failed))
  const userRoot = HarnessLibrary.userRoot(global.config)
  const projectDirectory = location.project.directory
  const projectHarness = HarnessLibrary.projectRoot(projectDirectory)
  const userTree =
    (yield* HarnessTree.read(HarnessLibrary.liveDirectory(userRoot), "invariant")) ?? HarnessTree.empty()
  const projectTree =
    (yield* HarnessTree.read(HarnessLibrary.liveDirectory(projectHarness), "domain")) ?? HarnessTree.empty()
  const libraries = HarnessLibrary.librariesForProposer({
    user: yield* HarnessLibrary.readLibrary(HarnessLibrary.libraryDirectory(userRoot)),
    project: yield* HarnessLibrary.readLibrary(HarnessLibrary.libraryDirectory(projectHarness)),
  })
  const started: State = {
    tree: HarnessTree.overlay(userTree, projectTree),
    evidence: { references: [], probes: [] },
    changed: false,
  }
  const children: SessionSchema.ID[] = []
  const created: AbsolutePath[] = []
  let sessionsRun = 0
  const notes: string[] = []

  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.forEach(children, (id) => sessions.interrupt(id), { discard: true, concurrency: "unbounded" })
          yield* Effect.forEach(
            created,
            (directory) =>
              worktrees.remove({ projectID: parent.projectID, directory, force: true }).pipe(
                Effect.catch((error) => Effect.logWarning("harness worktree cleanup failed", { directory, error })),
              ),
            { discard: true, concurrency: 1 },
          )
        }),
      )

      const report = (text: string) =>
        Effect.gen(function* () {
          notes.push(text)
          yield* sessions
            .synthetic({
              sessionID: parent.id,
              text,
              description: text.length > 80 ? `${text.slice(0, 77)}...` : text,
              resume: false,
            })
            .pipe(Effect.mapError(failed))
        })

      yield* report(`Starting harness refinement. ${HarnessSchedule.budget(input.mode, input.k).summary}`)

      const finished =
        input.mode === "parallel"
          ? yield* runWidth({
              k: input.k,
              round: 1,
              state: started,
              task: input.task,
              libraries,
              parent,
              sessions,
              worktrees,
              children,
              created,
              report,
              count: () => {
                sessionsRun++
              },
            })
          : yield* Array.from({ length: input.k }, (_, index) => index + 1).reduce<Effect.Effect<State, Error>>(
              (step, round) =>
                Effect.flatMap(step, (state) =>
                  runWidth({
                    k: 1,
                    round,
                    state,
                    task: input.task,
                    libraries,
                    parent,
                    sessions,
                    worktrees,
                    children,
                    created,
                    report,
                    count: () => {
                      sessionsRun++
                    },
                  }),
                ),
              Effect.succeed(started),
            )

      const current = { user: userTree, project: projectTree }
      const adopted = finished.changed
        ? HarnessLibrary.applyAdoption(
            current,
            finished.experience ? { tree: finished.tree, experience: finished.experience } : undefined,
          )
        : current
      const userChanged = adopted.user !== current.user
      const projectChanged = adopted.project !== current.project
      if (!userChanged && !projectChanged) {
        yield* report("No harness was adopted. The user-level and project harnesses are unchanged.")
        return {
          adopted: false,
          fallback: true,
          sessions: sessionsRun,
          summary: notes.join("\n"),
        } satisfies Result
      }
      if (userChanged && finished.experience) yield* HarnessLibrary.commitLayer(userRoot, adopted.user, finished.experience)
      if (projectChanged && finished.experience) {
        yield* HarnessLibrary.commitLayer(projectHarness, adopted.project, finished.experience)
        yield* HarnessTree.mirrorDiscovery(projectDirectory, adopted.project)
      }
      const where = [
        userChanged ? "user-level harness" : undefined,
        projectChanged ? "project harness" : undefined,
      ]
        .filter((layer): layer is string => layer !== undefined)
        .join(" and ")
      yield* report(
        `Adopted the refined harness into the ${where}. Cue: ${finished.experience?.cue ?? ""}. Starting the final rollout on your tree.`,
      )
      yield* rollout({
        parent,
        task: input.task,
        sessions,
        children,
        count: () => {
          sessionsRun++
        },
      })
      yield* report("Final rollout finished. Its edits are in your tree.")
      return {
        adopted: true,
        fallback: false,
        sessions: sessionsRun,
        summary: notes.join("\n"),
      } satisfies Result
    }),
  )
})

interface WidthInput {
  readonly k: number
  readonly round: number
  readonly state: State
  readonly task: string
  readonly libraries: readonly HarnessLibrary.Entry[]
  readonly parent: SessionSchema.Info
  readonly sessions: Session.Interface
  readonly worktrees: Worktree.Interface
  readonly children: SessionSchema.ID[]
  readonly created: AbsolutePath[]
  readonly report: (text: string) => Effect.Effect<void, Error>
  readonly count: () => void
}

const runWidth = Effect.fn("HarnessRecursion.width")(function* (input: WidthInput) {
  const indexes = Array.from({ length: input.k }, (_, index) => index)
  const references = yield* Effect.forEach(
    indexes,
    (index) =>
      rolloutInWorktree({
        ...input,
        harness: input.state.tree,
        label: HarnessSchedule.stageLabel({ kind: "reference", round: input.round, index }),
        prompt: rolloutPrompt(input.task),
      }),
    { concurrency: 1 },
  )
  const referencesSoFar = [...input.state.evidence.references, ...references]
  const invariant = yield* Effect.forEach(
    indexes,
    (index) =>
      propose({
        ...input,
        lane: "invariant",
        index,
        evidence: { references: referencesSoFar, probes: input.state.evidence.probes },
      }),
    { concurrency: 1 },
  )
  const domain = yield* Effect.forEach(
    indexes,
    (index) =>
      propose({
        ...input,
        lane: "domain",
        index,
        evidence: { references: referencesSoFar, probes: input.state.evidence.probes },
      }),
    { concurrency: 1 },
  )
  const invariantProbes = yield* probeAll(input, invariant, "invariant")
  const domainProbes = yield* probeAll(input, domain, "domain")
  const probes = [...input.state.evidence.probes, ...invariantProbes, ...domainProbes]
  const evidence = { references: referencesSoFar, probes }
  const compositions = yield* Effect.forEach(
    indexes,
    (index) => compose({ ...input, index, evidence, invariant, domain }),
    { concurrency: 1 },
  )
  const chosen = HarnessSchedule.chooseComposition(
    { tree: input.state.tree, experience: input.state.experience },
    compositions.map((item) =>
      item.fallback
        ? { harness: { tree: input.state.tree, experience: input.state.experience }, fallback: true as const }
        : { harness: { tree: item.tree, experience: item.experience }, fallback: false as const },
    ),
  )
  if (!chosen.adopted || !chosen.harness.experience) {
    yield* input.report(`Round ${input.round} kept the current harness.`)
    return {
      tree: input.state.tree,
      experience: input.state.experience,
      evidence,
      changed: input.state.changed,
    } satisfies State
  }
  yield* input.report(`Round ${input.round} composed a refined harness.`)
  return {
    tree: chosen.harness.tree,
    experience: chosen.harness.experience,
    evidence,
    changed: true,
  } satisfies State
})

const probeAll = (
  input: WidthInput,
  proposals: readonly { readonly tree: HarnessTree.Tree; readonly fallback: boolean }[],
  lane: "invariant" | "domain",
) =>
  Effect.forEach(
    proposals,
    (proposal, index) => {
      const label = HarnessSchedule.stageLabel({ kind: "probe", round: input.round, index, lane })
      if (proposal.fallback) return input.report(`${label} skipped because the proposal fell back.`).pipe(Effect.as(undefined))
      return rolloutInWorktree({
        ...input,
        harness: proposal.tree,
        label,
        prompt: rolloutPrompt(input.task),
      })
    },
    { concurrency: 1 },
  ).pipe(Effect.map((items) => items.flatMap((item) => (item === undefined ? [] : [item]))))

const propose = Effect.fn("HarnessRecursion.propose")(function* (
  input: WidthInput & {
    readonly lane: "invariant" | "domain"
    readonly index: number
    readonly evidence: Evidence
  },
) {
  const label = HarnessSchedule.stageLabel({
    kind: "propose",
    round: input.round,
    index: input.index,
    lane: input.lane,
  })
  const attempts: { readonly valid: boolean; readonly value: HarnessTree.Tree | undefined; readonly reason?: string }[] =
    []
  const first = yield* proposeOnce(input, label, undefined)
  attempts.push(first)
  if (!first.valid) {
    yield* input.report(`${label} was invalid (${first.reason}). Retrying once.`)
    attempts.push(yield* proposeOnce(input, `${label} retry`, first.reason))
  }
  const settled = HarnessSchedule.settle(attempts, undefined)
  if (settled.fallback || !settled.value) {
    yield* input.report(`${label} fell back. Keeping the current harness.`)
    return { tree: input.state.tree, fallback: true as const }
  }
  return { tree: settled.value, fallback: false as const }
})

const proposeOnce = Effect.fn("HarnessRecursion.proposeOnce")(function* (
  input: WidthInput & {
    readonly lane: "invariant" | "domain"
    readonly evidence: Evidence
  },
  label: string,
  retry: string | undefined,
) {
  const ran = yield* sessionInWorktree({
    ...input,
    harness: input.state.tree,
    label,
    prompt: proposePrompt({
      lane: input.lane,
      task: input.task,
      tree: input.state.tree,
      libraries: input.libraries,
      evidence: input.evidence,
      retry,
    }),
  })
  const read = yield* HarnessTree.read(HarnessTree.proposalDirectory(ran.directory), input.lane)
  if (!read || HarnessTree.isEmpty(read)) return { valid: false as const, value: undefined, reason: "no harness tree was written" }
  const tree = HarnessTree.withOrigin(read, input.lane)
  const violation = HarnessTree.graderViolation(HarnessTree.treeTexts(tree))
  if (violation) return { valid: false as const, value: undefined, reason: violation }
  return { valid: true as const, value: tree }
})

const compose = Effect.fn("HarnessRecursion.compose")(function* (
  input: WidthInput & {
    readonly index: number
    readonly evidence: Evidence
    readonly invariant: readonly { readonly tree: HarnessTree.Tree; readonly fallback: boolean }[]
    readonly domain: readonly { readonly tree: HarnessTree.Tree; readonly fallback: boolean }[]
  },
) {
  const label = HarnessSchedule.stageLabel({ kind: "compose", round: input.round, index: input.index })
  const attempts: { readonly valid: boolean; readonly value: Draft | undefined; readonly reason?: string }[] = []
  const first = yield* composeOnce(input, label, undefined)
  attempts.push(first)
  if (!first.valid) {
    yield* input.report(`${label} was invalid (${first.reason}). Retrying once.`)
    attempts.push(yield* composeOnce(input, `${label} retry`, first.reason))
  }
  const settled = HarnessSchedule.settle(attempts, undefined)
  if (settled.fallback || !settled.value) {
    yield* input.report(`${label} fell back. Keeping the current harness.`)
    return { fallback: true as const, tree: input.state.tree, experience: input.state.experience }
  }
  return { fallback: false as const, tree: settled.value.tree, experience: settled.value.experience }
})

const composeOnce = Effect.fn("HarnessRecursion.composeOnce")(function* (
  input: WidthInput & {
    readonly evidence: Evidence
    readonly invariant: readonly { readonly tree: HarnessTree.Tree; readonly fallback: boolean }[]
    readonly domain: readonly { readonly tree: HarnessTree.Tree; readonly fallback: boolean }[]
  },
  label: string,
  retry: string | undefined,
) {
  const ran = yield* sessionInWorktree({
    ...input,
    harness: input.state.tree,
    label,
    prompt: composePrompt({
      task: input.task,
      tree: input.state.tree,
      libraries: input.libraries,
      evidence: input.evidence,
      invariant: input.invariant,
      domain: input.domain,
      retry,
    }),
  })
  const directory = HarnessTree.proposalDirectory(ran.directory)
  const read = yield* HarnessTree.read(directory, "domain")
  const note = yield* Effect.tryPromise(() => readFile(path.join(directory, "experience.json"), "utf8")).pipe(
    Effect.orElseSucceed(() => undefined),
  )
  if (!read || HarnessTree.isEmpty(read))
    return { valid: false as const, value: undefined, reason: "no harness tree was written" }
  if (!(yield* exists(path.join(directory, "origins.json"))))
    return { valid: false as const, value: undefined, reason: "origins.json is missing" }
  const experience = note ? HarnessLibrary.experienceFromJson(note) : undefined
  if (!experience)
    return { valid: false as const, value: undefined, reason: "experience.json needs cue, lesson, evidence, and subject" }
  const violation = HarnessTree.graderViolation([
    ...HarnessTree.treeTexts(read),
    { path: "experience.json", text: note ?? "" },
  ])
  if (violation) return { valid: false as const, value: undefined, reason: violation }
  return { valid: true as const, value: { tree: read, experience } }
})

const rolloutInWorktree = (input: WidthInput & { readonly harness: HarnessTree.Tree; readonly label: string; readonly prompt: string }) =>
  sessionInWorktree(input).pipe(Effect.map((ran) => ran.trajectory))

const sessionInWorktree = Effect.fn("HarnessRecursion.session")(function* (
  input: WidthInput & { readonly harness: HarnessTree.Tree; readonly label: string; readonly prompt: string },
) {
  yield* input.report(`Running ${input.label}.`)
  const created = yield* input.worktrees
    .create({ projectID: input.parent.projectID, name: input.label.replaceAll(" ", "-") })
    .pipe(Effect.mapError(failed))
  input.created.push(created.directory)
  yield* HarnessTree.stage(created.directory, input.harness)
  const session = yield* input.sessions
    .create({
      location: Location.Ref.make({ directory: created.directory }),
      title: input.label,
      ...(input.parent.agent ? { agent: input.parent.agent } : {}),
      ...(input.parent.model ? { model: input.parent.model } : {}),
      metadata: { harness: input.label, harnessParent: input.parent.id },
    })
    .pipe(Effect.mapError(failed))
  input.children.push(session.id)
  input.count()
  yield* input.sessions
    .prompt({ sessionID: session.id, text: input.prompt, delivery: "steer" })
    .pipe(Effect.mapError(failed))
  yield* input.sessions.wait(session.id).pipe(Effect.mapError(failed))
  const diff = yield* input.sessions.diff({ sessionID: session.id, context: 3 }).pipe(
    Effect.map((files) => files.map((file) => `diff -- ${file.file}\n${file.patch}`).join("\n")),
    Effect.orElseSucceed(() => ""),
  )
  const messages = yield* input.sessions
    .messages({ sessionID: session.id, limit: 200, order: "asc" })
    .pipe(Effect.mapError(failed))
  return {
    directory: created.directory,
    trajectory: HarnessContrast.trajectoryFrom({ label: input.label, diff, messages }),
  }
})

const rollout = Effect.fn("HarnessRecursion.rollout")(function* (input: {
  readonly parent: SessionSchema.Info
  readonly task: string
  readonly sessions: Session.Interface
  readonly children: SessionSchema.ID[]
  readonly count: () => void
}) {
  const session = yield* input.sessions
    .create({
      parentID: input.parent.id,
      title: "Harness rollout",
      ...(input.parent.agent ? { agent: input.parent.agent } : {}),
      ...(input.parent.model ? { model: input.parent.model } : {}),
      metadata: { harness: "rollout" },
    })
    .pipe(Effect.mapError(failed))
  input.children.push(session.id)
  input.count()
  yield* input.sessions
    .prompt({ sessionID: session.id, text: rolloutPrompt(input.task), delivery: "steer" })
    .pipe(Effect.mapError(failed))
  yield* input.sessions.wait(session.id).pipe(Effect.mapError(failed))
})

const exists = (file: string) =>
  Effect.tryPromise(() => access(file)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

function failed(error: unknown) {
  if (error instanceof Error && error.message.length > 0) return error
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return new Error(error.message)
  return new Error("Harness refinement failed")
}

function rolloutPrompt(task: string) {
  return [
    "You are running one rollout of the coding task under the harness already staged for this session.",
    "The built-in OpenCode prompt still applies. The staged harness is additional guidance loaded on top of it.",
    "Writing, reviewing, and fixing the code is what this rollout does.",
    "Do the task. Do not propose a new harness, do not describe a search over harnesses, and do not write a grader verdict or an oracle.",
    "",
    "Task:",
    task,
  ].join("\n")
}

function proposePrompt(input: {
  readonly lane: "invariant" | "domain"
  readonly task: string
  readonly tree: HarnessTree.Tree
  readonly libraries: readonly HarnessLibrary.Entry[]
  readonly evidence: Evidence
  readonly retry: string | undefined
}) {
  const lane =
    input.lane === "invariant"
      ? "This proposal is invariant: it is about the harness itself, how it writes, reviews, and fixes code on later tasks, including in other projects. Every component you write must be about the harness, not this repository."
      : "This proposal is domain-specific: it fits this repository. Every component you write must be about this repository."
  return [
    "You are proposing one harness candidate. Do not implement the coding task.",
    "Writing, reviewing, and fixing code are what a rollout does. They are not a substitute for this proposal.",
    lane,
    "Write a complete harness tree to .opencode/harness/proposal/.",
    "Components: prompt.md, guardrails.md, memory.md, tool-guidance.md, skills/<name>/SKILL.md, subagents/<name>.md, scripts/<name>, plugins/<name>.",
    "Omit a file only when that component should stay empty.",
    "Do not write a grader, a grader verdict, a score, ground truth, or an oracle into any file.",
    retryLine(input.retry),
    "",
    "Task the harness will be probed on:",
    input.task,
    "",
    "Current harness:",
    HarnessTree.render(input.tree) || "(empty)",
    "",
    "Libraries (full adopted harnesses, not summaries):",
    renderLibraries(input.libraries),
    "",
    "Trajectory contrasts so far:",
    HarnessContrast.contrast(input.evidence.references) || "(no reference rollouts yet)",
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}

function composePrompt(input: {
  readonly task: string
  readonly tree: HarnessTree.Tree
  readonly libraries: readonly HarnessLibrary.Entry[]
  readonly evidence: Evidence
  readonly invariant: readonly { readonly tree: HarnessTree.Tree; readonly fallback: boolean }[]
  readonly domain: readonly { readonly tree: HarnessTree.Tree; readonly fallback: boolean }[]
  readonly retry: string | undefined
}) {
  return [
    "You are composing one refined harness from trajectory contrasts. Do not implement the coding task.",
    "Judge behavior only: diffs, tests the agent actually ran, review notes, and where a run got stuck.",
    "Do not invent a grader, a verdict, a score, ground truth, or an oracle. Do not write any of those into the harness.",
    "Write the refined tree to .opencode/harness/proposal/ with the same component files as a proposal.",
    "Write origins.json mapping each component key (prompt, guardrails, memory, tool-guidance, skills/<name>, subagents/<name>, scripts/<name>, plugins/<name>) to \"invariant\" or \"domain\".",
    "An invariant component is about the harness itself. A domain component fits this repository.",
    "Write experience.json with cue, lesson, evidence, and subject. subject is \"harness\" when the note is about the harness, or \"repository\" when it is about this repository.",
    "Invariant components are promoted only when subject is \"harness\".",
    retryLine(input.retry),
    "",
    "Task:",
    input.task,
    "",
    "Current harness:",
    HarnessTree.render(input.tree) || "(empty)",
    "",
    "Invariant candidates:",
    renderCandidates(input.invariant),
    "",
    "Domain candidates:",
    renderCandidates(input.domain),
    "",
    "Libraries:",
    renderLibraries(input.libraries),
    "",
    "Contrasts:",
    HarnessContrast.contrast([...input.evidence.references, ...input.evidence.probes]) || "(none)",
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}

function retryLine(reason: string | undefined) {
  if (!reason) return
  return `The previous attempt was rejected: ${reason}. Write a corrected harness. Do not repeat the rejected text.`
}

function renderLibraries(entries: readonly HarnessLibrary.Entry[]) {
  if (entries.length === 0) return "No adopted harnesses are in this library."
  return entries
    .map((entry) =>
      [
        `### ${entry.id} (${entry.experience.subject})`,
        `Cue: ${entry.experience.cue}`,
        `Lesson: ${entry.experience.lesson}`,
        `Evidence: ${entry.experience.evidence}`,
        HarnessTree.render(entry.tree),
      ].join("\n"),
    )
    .join("\n\n")
}

function renderCandidates(candidates: readonly { readonly tree: HarnessTree.Tree; readonly fallback: boolean }[]) {
  if (candidates.length === 0) return "(none)"
  return candidates
    .map((candidate, index) =>
      candidate.fallback ? `### ${index + 1}\nFell back to the current harness.` : `### ${index + 1}\n${HarnessTree.render(candidate.tree)}`,
    )
    .join("\n\n")
}
