export * as ModelSwitchPlugin from "./model-switch.js"

import { Message } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import type { SessionMessage } from "@opencode/schema/session-message"
import { Effect, Option, Schema } from "effect"

const key = "opencode.model-switch"
const decodeAnnounced = Schema.decodeUnknownOption(Schema.Struct({ removed: Schema.Array(Schema.String) }))

/** Editing tools that stand in for each other across the models that offer them. */
const replacements: Readonly<Record<string, ReadonlyArray<string>>> = {
  patch: ["edit", "write"],
  edit: ["patch"],
  write: ["patch"],
}

const list = (names: ReadonlyArray<string>) => names.map((name) => `\`${name}\``).join(" and ")

/**
 * When a request offers a different model a history whose tool calls name
 * tools this request does not offer, remind the model once which of those
 * tools it lacks. The reminder is persisted so later requests, and later
 * switches to models with the same tools, do not repeat it.
 */
export const Plugin = define({
  id: key,
  effect: Effect.fn(function* (ctx) {
    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const offered = new Set(Object.keys(event.tools))
        const missing = event.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content.some((part) => part.type === "tool-call" && !offered.has(part.name)),
        )
        if (!missing) return
        const history = yield* ctx.session
          .context({ sessionID: event.sessionID })
          .pipe(Effect.orElseSucceed((): ReadonlyArray<SessionMessage.Info> => []))
        // Only calls another model made count; a tool this model used and then lost is not a switch.
        const removed = [
          ...new Set(
            history.flatMap((message) =>
              message.type === "assistant" &&
              (message.model.providerID !== event.model.providerID || message.model.id !== event.model.id)
                ? message.content.flatMap((part) =>
                    part.type === "tool" && !offered.has(part.name) ? [part.name] : [],
                  )
                : [],
            ),
          ),
        ]
        if (removed.length === 0) return
        const last = history.findLast(
          (message) => message.type === "synthetic" && message.metadata?.[key] !== undefined,
        )
        const announced =
          last?.type === "synthetic" ? Option.getOrUndefined(decodeAnnounced(last.metadata?.[key])) : undefined
        if (announced && removed.every((name) => announced.removed.includes(name))) return
        const added = [...new Set(removed.flatMap((name) => replacements[name] ?? []))].filter((name) =>
          offered.has(name),
        )
        const text = `<system-reminder>
You are continuing a conversation started by a different model. Some tools it used are not available to you. ${list(removed)} ${removed.length === 1 ? "is" : "are"} no longer available and must not be called${added.length > 0 ? `; use ${list(added)} instead` : ""}.
</system-reminder>`
        // Before the user's prompt, matching where agent-switch reminders land.
        const at = event.messages.at(-1)?.role === "user" ? event.messages.length - 1 : event.messages.length
        event.messages.splice(at, 0, Message.user(text))
        yield* ctx.session
          .synthetic({ sessionID: event.sessionID, text, metadata: { [key]: { removed } }, resume: false })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to persist model switch reminder", { sessionID: event.sessionID, cause }),
            ),
          )
      }),
    )
  }),
})
