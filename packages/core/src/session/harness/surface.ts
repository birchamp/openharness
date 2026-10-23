export * as HarnessSurface from "./surface.js"

import { access } from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { Agent } from "../../agent.js"
import { InstructionDiscovery } from "../../instruction-discovery.js"
import { Location } from "../../location.js"
import { AbsolutePath } from "../../schema.js"
import { Skill } from "../../skill.js"
import { HarnessLibrary } from "./library.js"
import { HarnessTree } from "./tree.js"

export interface Interface {
  /** Reads the staged or live harness and reloads instruction, skill, and agent state when it changed. */
  readonly sync: () => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/HarnessSurface") {}

type View = {
  readonly candidate?: HarnessTree.Tree
  readonly user: HarnessTree.Tree
  readonly project: HarnessTree.Tree
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const discovery = yield* InstructionDiscovery.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const skills = yield* Skill.Service
    const state: {
      view: View
      fingerprint: string
      skillIDs: string[]
      agentIDs: string[]
      paths: string[]
    } = {
      view: { user: HarnessTree.empty(), project: HarnessTree.empty() },
      fingerprint: "",
      skillIDs: [],
      agentIDs: [],
      paths: [],
    }
    state.fingerprint = JSON.stringify(state.view)

    yield* discovery.transform((editor) => {
      for (const file of state.paths) editor.remove(file)
      const files = HarnessTree.instructionFiles(state.view)
      state.paths = files.map((file) => file.path)
      for (const file of files) editor.add(new InstructionDiscovery.File(file))
    })
    yield* skills.transform((editor) => {
      for (const id of state.skillIDs) editor.remove(id)
      const parts = listed(state.view).skills.filter((part) => part.path !== undefined)
      state.skillIDs = parts.map((part) => part.name)
      for (const part of parts) {
        if (!part.path) continue
        editor.add({
          id: Skill.ID.make(part.name),
          name: Skill.Name.make(part.name),
          description: part.description ?? part.name,
          path: AbsolutePath.make(part.path),
          content: part.content,
        })
      }
    })
    yield* agents.transform((editor) => {
      for (const id of state.agentIDs) editor.remove(Agent.ID.make(id))
      const parts = listed(state.view).subagents
      state.agentIDs = parts.map((part) => part.name)
      for (const part of parts) {
        editor.update(Agent.ID.make(part.name), (agent) => {
          agent.name = Agent.Name.make(part.name)
          agent.description = part.description ?? part.name
          agent.mode = "subagent"
          agent.system = part.content
        })
      }
    })

    const sync = Effect.fn("HarnessSurface.sync")(function* () {
      const view = yield* load(location, global.config, discovery.global, discovery.project)
      const fingerprint = JSON.stringify(view)
      if (fingerprint === state.fingerprint) return
      state.view = view
      state.fingerprint = fingerprint
      yield* discovery.reload()
      yield* skills.reload()
      yield* agents.reload()
    })

    return Service.of({ sync })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Agent.node, InstructionDiscovery.node, Global.node, Location.node, Skill.node],
})

const load = Effect.fnUntraced(function* (
  location: Location.Interface,
  configDirectory: string,
  global: boolean,
  project: boolean,
) {
  const candidate = path.join(location.directory, ".opencode", "harness", "candidate")
  if (yield* exists(path.join(candidate, HarnessTree.candidateMarker))) {
    const tree = (yield* HarnessTree.read(candidate, "domain")) ?? HarnessTree.empty()
    return { candidate: tree, user: HarnessTree.empty(), project: HarnessTree.empty() }
  }
  const user = global
    ? ((yield* HarnessTree.read(HarnessLibrary.liveDirectory(HarnessLibrary.userRoot(configDirectory)), "invariant")) ??
      HarnessTree.empty())
    : HarnessTree.empty()
  const projectTree = project
    ? ((yield* HarnessTree.read(
        HarnessLibrary.liveDirectory(HarnessLibrary.projectRoot(location.project.directory)),
        "domain",
      )) ?? HarnessTree.empty())
    : HarnessTree.empty()
  return { user, project: projectTree }
})

function listed(view: View) {
  if (view.candidate) return view.candidate
  return HarnessTree.overlay(view.user, view.project)
}

const exists = (file: string) =>
  Effect.tryPromise(() => access(file)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )
