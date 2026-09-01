import {
  actionableReadinessSchema,
  statusSchema,
  type ActionableReadiness,
  type Status,
} from "@actionables/contracts";

type ReadyContent = {
  finding: string;
  description: string;
  research: string[];
  plannedValidation: string[];
};

const transitionMatrix: Readonly<Record<Status, readonly Status[]>> = {
  Inbox: ["Researching", "Dismissed"],
  Researching: ["Inbox", "Ready", "Blocked", "Dismissed"],
  Ready: ["Inbox", "Researching", "In progress", "Blocked", "Dismissed"],
  "In progress": ["Researching", "Ready", "Blocked", "Done", "Dismissed"],
  Blocked: ["Researching", "Ready", "Dismissed"],
  Done: ["Ready"],
  Dismissed: ["Ready"],
};

export function lifecycleReadiness(
  status: Status,
  content: ReadyContent,
): ActionableReadiness {
  if (status === "Done" || status === "Dismissed") {
    return { requiredForReady: [], blockers: [] };
  }

  const blockers: ActionableReadiness["blockers"] = [];
  if (status === "Inbox") {
    blockers.push({
      field: "researchPhase",
      message: "Move the Actionable to Researching before Ready.",
    });
  }
  if (!content.finding.trim()) {
    blockers.push({
      field: "finding",
      message: "Add a non-empty finding before Ready.",
    });
  }
  if (!content.description.trim()) {
    blockers.push({
      field: "description",
      message: "Add a non-empty intended result before Ready.",
    });
  }
  if (!content.research.some((note) => note.trim())) {
    blockers.push({
      field: "research",
      message: "Add at least one non-empty Research note before Ready.",
    });
  }
  if (!content.plannedValidation.some((note) => note.trim())) {
    blockers.push({
      field: "plannedValidation",
      message: "Add at least one planned validation step before Ready.",
    });
  }
  return actionableReadinessSchema.parse({
    requiredForReady: blockers.map((blocker) => blocker.field),
    blockers,
  });
}

export function permittedTransitions(
  status: Status,
  readiness?: ActionableReadiness,
): Status[] {
  const hasReadyBlockers = Boolean(readiness?.requiredForReady.length);
  return transitionMatrix[status].filter((target) => {
    if (target === "Ready" && hasReadyBlockers) return false;
    if (status === "Ready" && target === "In progress" && hasReadyBlockers)
      return false;
    return true;
  });
}

export function canTransition(previousStatus: Status, newStatus: Status) {
  return transitionMatrix[previousStatus].includes(newStatus);
}

export function parsePersistedStatus(status: string): Status {
  return statusSchema.parse(status);
}

export function transitionExplanation(status: Status) {
  return `${status} items may move to ${transitionMatrix[status].join(", ")}.`;
}
