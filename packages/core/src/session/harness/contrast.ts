export * as HarnessContrast from "./contrast.js"

const TEST_COMMAND =
  /\b(bun test|npm test|pnpm test|yarn test|pytest|go test|cargo test|vitest|jest|rspec|ctest|mix test|phpunit|dotnet test)\b/

const SECTION_LIMIT = 12_000

export interface Trajectory {
  readonly label: string
  readonly diff: string
  readonly tests: readonly string[]
  readonly review: string
  readonly stuck: string
}

/** Composition sees diffs, tests the agent ran, review notes, and where a run stuck. */
export function contrast(items: readonly Trajectory[]) {
  return items.map(render).join("\n\n")
}

export function trajectoryFrom(input: { readonly label: string; readonly diff: string; readonly messages: readonly unknown[] }) {
  const tests: string[] = []
  const reviews: string[] = []
  const stuck: string[] = []
  for (const message of input.messages) {
    const type = stringField(message, "type")
    if (type === "assistant") {
      const error = stringField(recordField(message, "error"), "message")
      if (error) stuck.push(error)
      const content = recordField(message, "content")
      if (!Array.isArray(content)) continue
      for (const part of content) collectAssistant(part, tests, reviews, stuck)
    }
    if (type === "shell") collectCommand(stringField(message, "command"), numberField(message, "exit"), tests, stuck)
  }
  return {
    label: input.label,
    diff: clip(input.diff),
    tests,
    review: clip(reviews.join("\n\n")),
    stuck: clip(stuck.join("\n")),
  } satisfies Trajectory
}

function render(item: Trajectory) {
  return [
    `## ${item.label}`,
    "### Diff",
    item.diff.length > 0 ? item.diff : "(no diff)",
    "### Tests the agent ran",
    item.tests.length > 0 ? item.tests.map((test) => `- ${test}`).join("\n") : "(none)",
    "### Review notes",
    item.review.length > 0 ? item.review : "(none)",
    "### Where the run stuck",
    item.stuck.length > 0 ? item.stuck : "(none)",
  ].join("\n")
}

function collectAssistant(part: unknown, tests: string[], reviews: string[], stuck: string[]) {
  const type = stringField(part, "type")
  if (type === "text") {
    const text = stringField(part, "text")
    if (text) reviews.push(text)
    return
  }
  if (type !== "tool") return
  const name = stringField(part, "name")
  const state = recordField(part, "state")
  const status = stringField(state, "status")
  const command = stringField(recordField(state, "input"), "command")
  if (name === "shell" || name === "bash") collectCommand(command, undefined, tests, stuck)
  if (status !== "error") return
  const message = stringField(recordField(state, "error"), "message")
  stuck.push(message ? `${name ?? "tool"}: ${message}` : `${name ?? "tool"} failed`)
}

function collectCommand(command: string | undefined, exit: number | undefined, tests: string[], stuck: string[]) {
  if (!command) return
  if (TEST_COMMAND.test(command)) {
    tests.push(exit === undefined ? command : `${command} (exit ${exit})`)
    if (exit !== undefined && exit !== 0) stuck.push(`${command} exited ${exit}`)
    return
  }
  if (exit !== undefined && exit !== 0) stuck.push(`${command} exited ${exit}`)
}

function clip(text: string) {
  if (text.length <= SECTION_LIMIT) return text
  return `${text.slice(0, SECTION_LIMIT)}\n…`
}

function recordField(value: unknown, key: string) {
  if (typeof value !== "object" || value === null) return
  const found = Object.entries(value).find((entry) => entry[0] === key)
  if (!found) return
  return found[1]
}

function stringField(value: unknown, key: string) {
  const field = recordField(value, key)
  if (typeof field !== "string") return
  return field
}

function numberField(value: unknown, key: string) {
  const field = recordField(value, key)
  if (typeof field !== "number") return
  return field
}
