import type { ActivityEvent } from "@actionables/contracts";
import { describe, expect, it } from "vitest";
import {
  activityEventCategory,
  groupActivityByAgentSession,
} from "./activity-timeline";

function event(
  id: string,
  type: ActivityEvent["type"],
  context: Record<string, string> = {},
): ActivityEvent {
  return {
    id,
    type,
    summary: id,
    context,
    occurredAt: `2026-07-27T12:0${id}.000Z`,
  };
}

describe("groupActivityByAgentSession", () => {
  it("groups claims, changes, failed validations, and handoffs into one session", () => {
    const groups = groupActivityByAgentSession([
      event("0", "status-transition"),
      event("1", "agent-claimed", { agentId: "codex:session" }),
      event("2", "agent-updated", { origin: "agent:codex:session" }),
      event("3", "validation-recorded", {
        origin: "agent:codex:session",
        outcome: "Failed",
      }),
      event("4", "agent-released", {
        agentId: "codex:session",
        operation: "handoff",
      }),
      event("5", "archived"),
    ]);

    expect(groups).toMatchObject([
      { kind: "other", events: [{ id: "0" }] },
      {
        kind: "session",
        agentId: "codex:session",
        state: "Handed off",
        startedAt: "2026-07-27T12:01.000Z",
        endedAt: "2026-07-27T12:04.000Z",
        events: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }],
      },
      { kind: "other", events: [{ id: "5" }] },
    ]);
    expect(activityEventCategory(groups[1]!.events[2]!)).toBe("Failure");
    expect(activityEventCategory(groups[1]!.events[3]!)).toBe("Handoff");
  });

  it("marks expired and still-open sessions distinctly", () => {
    const groups = groupActivityByAgentSession([
      event("1", "agent-claimed", { agentId: "codex:expired" }),
      event("2", "agent-claim-expired", { agentId: "codex:expired" }),
      event("3", "agent-claimed", { agentId: "codex:active" }),
      event("4", "validation-recorded", {
        origin: "agent:codex:active",
        outcome: "Passed",
      }),
    ]);

    expect(groups).toMatchObject([
      { kind: "session", state: "Expired", endedAt: expect.any(String) },
      { kind: "session", state: "Active", endedAt: null },
    ]);
    expect(activityEventCategory(groups[0]!.events[1]!)).toBe("Failure");
    expect(activityEventCategory(groups[1]!.events[1]!)).toBe("Validation");
  });
});
