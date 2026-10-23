export * as HarnessTool from "./harness.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Global } from "@opencode/util/global"
import { Effect, Schema } from "effect"
import { Location } from "../../location.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { HarnessRecursion } from "../../session/harness/recursion.js"
import { HarnessSchedule } from "../../session/harness/schedule.js"
import { Worktree } from "../../worktree.js"

export const name = "harness"

export const Input = Schema.Struct({
  task: Schema.String.annotate({
    description: "The coding task to refine a harness against. The same task is used for every rollout and probe.",
  }),
  mode: Schema.optionalKey(Schema.Literals(["sequential", "parallel"])).annotate({
    description:
      'Search mode. Defaults to "sequential". Sequential repeats one proposal round k times, carrying the refined harness. Parallel makes k invariant proposals, k domain proposals, and k compositions in one round.',
  }),
  k: Schema.optionalKey(Schema.Number).annotate({
    description: "How many rounds (sequential) or candidates (parallel). Defaults to 1. Must be an integer of at least 1.",
  }),
})

export const Output = Schema.Struct({
  adopted: Schema.Boolean,
  fallback: Schema.Boolean,
  sessions: Schema.Number,
  summary: Schema.String,
})

export const description = [
  "Refine the harness for a coding task by proposing, probing, and composing.",
  "The default is sequential with k=1: one reference rollout of the current harness, one invariant proposal, one domain proposal, a probe of each, and one composition.",
  "This asks permission first. That default already runs several full coding sessions, and a higher k multiplies them.",
  "Each proposal and each probe is its own session. Writing, reviewing, and fixing code happen inside a rollout. They do not replace propose, probe, and compose.",
  "Call this only when the user asks to refine or search the harness.",
].join("\n")

export const Plugin = {
  id: "opencode.tool.harness",
  effect: Effect.fn("HarnessTool.Plugin")(function* (ctx: Context) {
    const permission = yield* Permission.Service
    const sessions = yield* Session.Service
    const worktrees = yield* Worktree.Service
    const global = yield* Global.Service
    const location = yield* Location.Service

    yield* ctx.tool.transform((editor) =>
      editor.add({
        name,
        options: { codemode: false },
        description,
        input: Input,
        output: Output,
        execute: (input, context) =>
          Effect.gen(function* () {
            const requested = HarnessSchedule.request({ mode: input.mode, k: input.k })
            if ("error" in requested) return yield* new ToolFailure({ message: requested.error })
            const plan = HarnessSchedule.budget(requested.mode, requested.k)
            yield* permission
              .assert({
                action: name,
                resources: ["refine"],
                sessionID: context.sessionID,
                agent: context.agent,
                metadata: {
                  mode: requested.mode,
                  k: requested.k,
                  sessions: plan.sessions,
                  summary: plan.summary,
                },
                source: {
                  type: "tool",
                  messageID: context.messageID,
                  id: context.id,
                },
              })
              .pipe(
                Effect.mapError(
                  (error) => new ToolFailure({ message: `Harness refinement denied: ${error.message}`, error }),
                ),
              )
            const output = yield* HarnessRecursion.run({
              sessionID: context.sessionID,
              task: input.task,
              mode: requested.mode,
              k: requested.k,
            }).pipe(
              Effect.provideService(Session.Service, sessions),
              Effect.provideService(Worktree.Service, worktrees),
              Effect.provideService(Global.Service, global),
              Effect.provideService(Location.Service, location),
              Effect.mapError(
                (error) =>
                  new ToolFailure({
                    message: error instanceof Error ? error.message : "Harness refinement failed",
                    error,
                  }),
              ),
            )
            return { output }
          }),
      }),
    )
  }),
}
