import type { ActivityEvent } from "@actionables/contracts";

export type AgentSessionState =
  "Active" | "Released" | "Expired" | "Handed off";

export type ActivityTimelineGroup =
  | {
      kind: "session";
      id: string;
      agentId: string;
      startedAt: string;
      endedAt: string | null;
      state: AgentSessionState;
      events: ActivityEvent[];
    }
  | {
      kind: "other";
      id: string;
      events: ActivityEvent[];
    };

export type ActivityEventCategory =
  | "Claim"
  | "Change"
  | "Validation"
  | "Failure"
  | "Handoff"
  | "Release"
  | "Activity";

function isSessionEnd(event: ActivityEvent) {
  return (
    event.type === "agent-released" || event.type === "agent-claim-expired"
  );
}

function sessionState(event: ActivityEvent): AgentSessionState {
  if (event.type === "agent-claim-expired") return "Expired";
  if (event.context.operation === "handoff") return "Handed off";
  return "Released";
}

export function activityEventCategory(
  event: ActivityEvent,
): ActivityEventCategory {
  if (event.type === "agent-claimed") return "Claim";
  if (event.type === "agent-claim-expired") return "Failure";
  if (event.type === "agent-released") {
    return event.context.operation === "handoff" ? "Handoff" : "Release";
  }
  if (
    event.type === "validation-recorded" ||
    event.type === "validation-corrected"
  ) {
    return event.context.outcome === "Failed" ? "Failure" : "Validation";
  }
  if (
    event.type === "agent-updated" ||
    event.context.origin?.startsWith("agent:")
  ) {
    return "Change";
  }
  return "Activity";
}

export function groupActivityByAgentSession(
  events: ActivityEvent[],
): ActivityTimelineGroup[] {
  const groups: ActivityTimelineGroup[] = [];
  let currentSession: Extract<
    ActivityTimelineGroup,
    { kind: "session" }
  > | null = null;

  for (const event of events) {
    if (event.type === "agent-claimed") {
      currentSession = {
        kind: "session",
        id: `session-${event.id}`,
        agentId: event.context.agentId ?? "Unknown agent",
        startedAt: event.occurredAt,
        endedAt: null,
        state: "Active",
        events: [event],
      };
      groups.push(currentSession);
      continue;
    }

    if (currentSession) {
      currentSession.events.push(event);
      if (isSessionEnd(event)) {
        currentSession.endedAt = event.occurredAt;
        currentSession.state = sessionState(event);
        currentSession = null;
      }
      continue;
    }

    const previous = groups.at(-1);
    if (previous?.kind === "other") {
      previous.events.push(event);
    } else {
      groups.push({
        kind: "other",
        id: `activity-${event.id}`,
        events: [event],
      });
    }
  }

  return groups;
}
