import { describe, expect, test } from "bun:test"
import { createCommandReviewAutoReviewer } from "../../src/agent/runner/command-review"
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

    await service.authorize(reviewRequest("sudo true"))

    expect(asks).toBe(0)
    expect(service.evaluate("bash", "bash:review:sudo:sudo true")).toBe("ask")
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
