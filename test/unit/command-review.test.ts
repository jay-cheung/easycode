import { describe, expect, test } from "bun:test"
import { createCommandReviewAutoReviewer } from "../../src/agent/runner/command-review"
import type { LogEvent } from "../../src/logger"
import { PermissionService } from "../../src/permission"
import type { Provider, ProviderEvent } from "../../src/provider"

function reviewerProvider(text: string): Provider {
  return {
    name: "review-test",
    async *stream(): AsyncIterable<ProviderEvent> {
      yield { type: "text_delta", text }
      yield { type: "done" }
    },
  }
}

function reviewRequest(command: string) {
  return {
    permission: "bash",
    patterns: [`bash:review:sudo:${command}`],
    always: [`bash:review:sudo:${command}`],
    metadata: {
      tool: "bash",
      command,
      bashSafetyAction: "review",
      bashSafetyRiskTags: ["sudo"],
      bashSafetyReason: "high risk bash command: sudo",
      rememberOnApprove: false,
    },
  }
}

describe("command review", () => {
  test("allow_once executes without manual ask and is not remembered", async () => {
    let asks = 0
    const service = new PermissionService(
      [{ permission: "bash", pattern: "bash:review:*", action: "ask" }],
      () => {
        asks += 1
        return "reject"
      },
      createCommandReviewAutoReviewer(reviewerProvider('{"decision":"allow_once","reason":"bounded"}')),
    )

    const authorization = await service.authorize(reviewRequest("sudo true"))

    expect(authorization).toEqual(expect.objectContaining({
      source: "auto_review",
      reply: "once",
      autoReviewSource: "command_review",
      reason: "bounded",
    }))
    expect(asks).toBe(0)
    expect(service.evaluate("bash", "bash:review:sudo:sudo true")).toBe("ask")
  })

  test("writes command review turns through the shared subagent logger context", async () => {
    const events: LogEvent[] = []
    const service = new PermissionService(
      [{ permission: "bash", pattern: "bash:review:*", action: "ask" }],
      () => "reject",
      createCommandReviewAutoReviewer(reviewerProvider('{"decision":"allow_once","reason":"bounded"}'), (event) => events.push(event)),
    )

    await service.authorize(reviewRequest("sudo true"))

    expect(events.some((event) => event.type === "state" && event.name === "subagent.request" && event.detail?.role === "permission_reviewer")).toBe(true)
    expect(events.some((event) => event.type === "state" && event.name === "subagent.start" && event.detail?.role === "permission_reviewer")).toBe(true)
    expect(events.some((event) => event.type === "state" && event.name === "subagent.result" && event.detail?.role === "permission_reviewer" && event.detail?.status === "allow_once")).toBe(true)
    expect(events.some((event) => event.type === "provider" && event.name === "provider.transcript" && event.detail?.subagentRole === "permission_reviewer" && String(event.detail?.subagentTask).includes("sudo true"))).toBe(true)
    expect(events.some((event) => event.type === "state" && event.name === "permission_review.decision" && event.detail?.decision === "allow_once")).toBe(true)
  })

  test("reject blocks without manual ask", async () => {
    let asks = 0
    const service = new PermissionService(
      [{ permission: "bash", pattern: "bash:review:*", action: "ask" }],
      () => {
        asks += 1
        return "once"
      },
      createCommandReviewAutoReviewer(reviewerProvider('{"decision":"reject","reason":"unsafe"}')),
    )

    await expect(service.authorize(reviewRequest("sudo true"))).rejects.toThrow("Permission rejected")

    expect(asks).toBe(0)
  })

  test("ask_user falls through to manual ask", async () => {
    const requested: string[] = []
    const service = new PermissionService(
      [{ permission: "bash", pattern: "bash:review:*", action: "ask" }],
      (request) => {
        requested.push(request.patterns.join(","))
        return "once"
      },
      createCommandReviewAutoReviewer(reviewerProvider('{"decision":"ask_user","reason":"ambiguous"}')),
    )

    await service.authorize(reviewRequest("sudo true"))

    expect(requested).toEqual(["bash:review:sudo:sudo true"])
  })

  test("non-bash ask requests are reviewed internally before manual ask", async () => {
    let asks = 0
    const service = new PermissionService(
      [{ permission: "write", pattern: "*", action: "ask" }],
      () => {
        asks += 1
        return "reject"
      },
      createCommandReviewAutoReviewer(reviewerProvider('{"decision":"allow_once","reason":"project-local write"}')),
    )

    await service.authorize({
      permission: "write",
      patterns: ["src/generated.ts"],
      always: ["src/generated.ts"],
      metadata: { tool: "write", rememberOnApprove: false },
    })

    expect(asks).toBe(0)
  })

  test("bash exact ask requests are reviewed internally before manual ask", async () => {
    let asks = 0
    const service = new PermissionService(
      [{ permission: "bash", pattern: "bash:exact:*", action: "ask" }],
      () => {
        asks += 1
        return "reject"
      },
      createCommandReviewAutoReviewer(reviewerProvider('{"decision":"allow_once","reason":"bounded exact command"}')),
    )

    await service.authorize({
      permission: "bash",
      patterns: ["bash:exact:python3 << 'PYEOF'\nprint('ok')\nPYEOF"],
      always: ["bash:exact:python3 << 'PYEOF'\nprint('ok')\nPYEOF"],
      metadata: {
        tool: "bash",
        command: "python3 << 'PYEOF'\nprint('ok')\nPYEOF",
        rememberOnApprove: false,
      },
    })

    expect(asks).toBe(0)
  })

  test("hard deny skips internal review", async () => {
    let reviewerCalls = 0
    const service = new PermissionService(
      [{ permission: "bash", pattern: "rm*", action: "deny" }],
      () => "once",
      createCommandReviewAutoReviewer({
        name: "review-test",
        async *stream(): AsyncIterable<ProviderEvent> {
          reviewerCalls += 1
          yield { type: "text_delta", text: '{"decision":"allow_once"}' }
          yield { type: "done" }
        },
      }),
    )

    await expect(service.authorize({
      permission: "bash",
      patterns: ["rm -rf tmp"],
      always: ["rm -rf tmp"],
      metadata: { tool: "bash", command: "rm -rf tmp" },
    })).rejects.toThrow("Permission denied")

    expect(reviewerCalls).toBe(0)
  })
})
