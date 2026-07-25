import { statusSchema, type Status } from "@actionables/contracts";

const transitionMatrix: Readonly<Record<Status, readonly Status[]>> = {
  Inbox: ["Researching", "Ready"],
  Researching: ["Inbox", "Ready"],
  Ready: ["Inbox", "Researching"],
};

export function permittedTransitions(status: Status): Status[] {
  return [...transitionMatrix[status]];
}

export function canTransition(previousStatus: Status, newStatus: Status) {
  return transitionMatrix[previousStatus].includes(newStatus);
}

export function parsePersistedStatus(status: string): Status {
  return statusSchema.parse(status);
}

export function transitionExplanation(status: Status) {
  switch (status) {
    case "Inbox":
      return "Inbox items may move to Researching or Ready after triage.";
    case "Researching":
      return "Researching items may return to Inbox or move to Ready.";
    case "Ready":
      return "Ready items may return to Inbox or Researching in this milestone.";
  }
}
