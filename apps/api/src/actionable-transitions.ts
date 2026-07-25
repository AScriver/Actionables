import { statusSchema, type Status } from "@actionables/contracts";

const transitionMatrix: Readonly<Record<Status, readonly Status[]>> = {
  Inbox: ["Researching", "Ready", "Dismissed"],
  Researching: ["Inbox", "Ready", "Blocked", "Dismissed"],
  Ready: ["Inbox", "Researching", "In progress", "Blocked", "Dismissed"],
  "In progress": ["Ready", "Blocked", "Done", "Dismissed"],
  Blocked: ["Researching", "Ready", "In progress", "Dismissed"],
  Done: ["Ready"],
  Dismissed: ["Ready"],
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
  return `${status} items may move to ${transitionMatrix[status].join(", ")}.`;
}
