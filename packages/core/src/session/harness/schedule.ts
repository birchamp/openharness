export * as HarnessSchedule from "./schedule.js"

export type Mode = "sequential" | "parallel"

export type Stage = {
  readonly round: number
  readonly kind: "reference" | "propose" | "probe" | "compose"
  readonly lane?: "invariant" | "domain"
  readonly index: number
}

export function request(input: {
  readonly mode?: string
  readonly k?: number
}): { readonly mode: Mode; readonly k: number } | { readonly error: string } {
  const mode = input.mode ?? "sequential"
  if (mode !== "sequential" && mode !== "parallel") return { error: "Mode must be sequential or parallel." }
  const k = input.k ?? 1
  if (!Number.isInteger(k) || k < 1) return { error: "k must be an integer of at least 1." }
  if (mode === "parallel") return { mode, k }
  return { mode: "sequential", k }
}

/**
 * Parallel mode emits k invariant proposals, k domain proposals, and k compositions in one round.
 * Sequential mode repeats the k=1 round k times. The caller carries the refined harness between rounds.
 */
export function schedule(mode: Mode, k: number) {
  if (mode === "parallel") return round(1, k)
  return Array.from({ length: k }, (_, index) => round(index + 1, 1)).flat()
}

/** Child drains in the schedule, plus the final rollout on the user tree when a harness is adopted. */
export function plannedSessions(mode: Mode, k: number) {
  return schedule(mode, k).length + 1
}

export function stageLabel(stage: Stage) {
  const index = stage.index + 1
  if (stage.kind === "reference") return `reference ${stage.round}.${index}`
  if (stage.kind === "compose") return `compose ${stage.round}.${index}`
  return `${stage.kind} ${stage.lane} ${stage.round}.${index}`
}

export function budget(mode: Mode, k: number) {
  const sessions = plannedSessions(mode, k)
  if (mode === "parallel")
    return {
      sessions,
      summary: `parallel k=${k}: ${k} reference rollouts, ${k} invariant proposals, ${k} domain proposals, a probe of each, ${k} compositions, then a final rollout on your tree if one is adopted (${sessions} sessions before retries)`,
    }
  return {
    sessions,
    summary: `sequential k=${k}: ${k} round(s) of one reference rollout, one invariant proposal, one domain proposal, a probe of each, and one composition, then a final rollout on your tree if the harness is adopted (${sessions} sessions before retries)`,
  }
}

/** One invalid attempt is retried. A second invalid attempt keeps the current harness. */
export function settle<A>(attempts: readonly { readonly valid: boolean; readonly value: A }[], current: A) {
  const accepted = attempts.slice(0, 2).find((attempt) => attempt.valid)
  if (accepted) return { value: accepted.value, fallback: false as const }
  return { value: current, fallback: true as const }
}

export function carry<T>(start: T, rounds: readonly { readonly harness: T; readonly fallback: boolean }[]) {
  return rounds.reduce((current, round) => (round.fallback ? current : round.harness), start)
}

/** Parallel compositions are independent. The last valid one is the harness that can be adopted. */
export function chooseComposition<T>(start: T, compositions: readonly { readonly harness: T; readonly fallback: boolean }[]) {
  const valid = compositions.filter((item) => !item.fallback)
  const last = valid.at(-1)
  if (!last) return { harness: start, adopted: false as const }
  return { harness: last.harness, adopted: true as const }
}

function round(roundIndex: number, k: number): Stage[] {
  const indexed = (kind: Stage["kind"], lane: Stage["lane"], count: number) =>
    Array.from({ length: count }, (_, index) => ({
      round: roundIndex,
      kind,
      index,
      ...(lane ? { lane } : {}),
    }))
  return [
    ...indexed("reference", undefined, k),
    ...indexed("propose", "invariant", k),
    ...indexed("propose", "domain", k),
    ...indexed("probe", "invariant", k),
    ...indexed("probe", "domain", k),
    ...indexed("compose", undefined, k),
  ]
}
