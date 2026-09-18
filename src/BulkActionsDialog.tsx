import { useEffect, useRef, useState } from "react";
import {
  prioritySchema,
  effortSchema,
  updateActionableRequestSchema,
  type ActionableDetail,
  type ArchiveImpactResponse,
  type UpdateActionableRequest,
} from "@actionables/contracts";
import {
  ApiProblem,
  fetchActionable,
  fetchArchiveImpact,
  setActionableArchived,
  transitionActionable,
  updateActionable,
} from "./api";

export type BulkAction = "dismiss" | "archive" | "restore" | "edit";
type MetadataField = "priority" | "effort" | "add-tags" | "remove-tags";

type Target = { id: number; title: string };
type Entry = Target & {
  item?: ActionableDetail;
  impact?: ArchiveImpactResponse;
  input?: UpdateActionableRequest;
  change?: string;
  exclusion?: string;
  result?: "Succeeded" | "Skipped" | "Failed" | "Uncertain";
  message?: string;
};

function prepareEdit(
  item: ActionableDetail,
  field: MetadataField,
  value: string,
): Pick<Entry, "input" | "exclusion" | "change"> {
  if (!value.trim())
    return { exclusion: "Choose a value or enter nonblank tags." };
  let tags = item.tags;
  let change = "";
  if (field === "add-tags" || field === "remove-tags") {
    const requested = value.split(",").map((tag) => tag.trim());
    const invalidTags = requested
      .map((tag) => updateActionableRequestSchema.shape.tags.safeParse([tag]))
      .find((result) => !result.success);
    if (invalidTags && !invalidTags.success)
      return {
        exclusion: "Tags must be nonblank and at most 60 characters each.",
      };
    // Match the list's case-insensitive tag filter while retaining existing spelling.
    const keys = new Set(requested.map((tag) => tag.toLocaleLowerCase()));
    if (field === "remove-tags") {
      tags = item.tags.filter((tag) => !keys.has(tag.toLocaleLowerCase()));
    } else {
      const present = new Set(item.tags.map((tag) => tag.toLocaleLowerCase()));
      tags = [...item.tags];
      for (const tag of requested) {
        const key = tag.toLocaleLowerCase();
        if (!present.has(key)) tags.push(tag);
        present.add(key);
      }
    }
    change = `Tags: ${item.tags.join(", ") || "none"} → ${tags.join(", ") || "none"}`;
  }
  const parsed = updateActionableRequestSchema.safeParse({
    version: item.version,
    title: item.title,
    status: item.status,
    priority: field === "priority" ? value : item.priority,
    effort: field === "effort" ? value : item.effort,
    evidenceState: item.evidenceState,
    projectId: item.scope.projectId,
    repositoryId: item.scope.repositoryId,
    worktreeId: item.scope.worktreeId,
    finding: item.finding,
    description: item.description,
    resolution: item.resolution,
    research: item.research,
    validation: item.validation,
    tags,
    userSources: item.userSources.map(({ type, locator, label }) => ({
      type,
      locator,
      label,
    })),
  });
  if (!parsed.success) {
    if (
      parsed.error.issues.some(
        (issue) =>
          issue.path[0] === "tags" &&
          issue.code === "too_big" &&
          issue.origin === "array",
      )
    ) {
      return { exclusion: "This change would exceed 30 tags." };
    }
    return {
      exclusion: parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(" "),
    };
  }
  const input = parsed.data;
  if (
    input.priority === item.priority &&
    input.effort === item.effort &&
    JSON.stringify(input.tags) === JSON.stringify(item.tags)
  ) {
    return { exclusion: "No change needed." };
  }
  if (field === "priority")
    change = `Priority: ${item.priority} → ${input.priority}`;
  if (field === "effort") change = `Effort: ${item.effort} → ${input.effort}`;
  return { input, change };
}

function errorMessage(error: unknown) {
  if (error instanceof ApiProblem) {
    return (
      Object.values(error.problem.errors ?? {})
        .flat()
        .join(" ") || error.message
    );
  }
  return "Could not reach the API.";
}

function actionConfirmed(
  before: ActionableDetail,
  current: ActionableDetail,
  action: BulkAction,
  reason: string,
  input?: UpdateActionableRequest,
) {
  if (action === "edit") {
    if (!input || current.version <= before.version) return false;
    if (input.priority !== before.priority)
      return current.priority === input.priority;
    if (input.effort !== before.effort) return current.effort === input.effort;
    return JSON.stringify(current.tags) === JSON.stringify(input.tags);
  }
  if (action !== "dismiss") {
    const eventType = action === "archive" ? "archived" : "restored";
    return (
      current.archiveState.directlyArchived === (action === "archive") &&
      current.activity.some(
        (event) =>
          event.type === eventType &&
          !before.activity.some((previous) => previous.id === event.id),
      )
    );
  }
  return (
    current.status === "Dismissed" &&
    current.activity.some(
      (event) =>
        event.type === "dismissed" &&
        event.context.reason === reason.trim() &&
        !before.activity.some((previous) => previous.id === event.id),
    )
  );
}

/** Review explicit targets and reuse versioned human actions without replaying successes. */
export function BulkActionsDialog({
  action,
  targets,
  onApplied,
  onClose,
}: {
  action: BulkAction;
  targets: Target[];
  onApplied: (succeededIds: number[]) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const reviewSequence = useRef(0);
  const [entries, setEntries] = useState<Entry[]>(targets);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [finished, setFinished] = useState(false);
  const [reason, setReason] = useState("");
  const [field, setField] = useState<MetadataField>("priority");
  const [value, setValue] = useState("");
  const editLocked =
    saving || finished || entries.some((entry) => entry.result === "Succeeded");
  const actionLabel = {
    dismiss: "Dismiss",
    archive: "Archive",
    restore: "Restore",
    edit: "Edit",
  }[action];
  const completedLabel = {
    dismiss: "Dismissed",
    archive: "Archived",
    restore: "Restored",
    edit: "Updated",
  }[action];
  const verificationLabel = action === "dismiss" ? "Dismissal" : actionLabel;

  const review = async (current: Entry[]) => {
    const sequence = ++reviewSequence.current;
    setLoading(true);
    const reviewed = await Promise.all(
      current.map(async (entry): Promise<Entry> => {
        if (entry.result === "Succeeded") return entry;
        try {
          const item = await fetchActionable(entry.id);
          if (
            entry.result &&
            entry.item &&
            actionConfirmed(entry.item, item, action, reason, entry.input)
          ) {
            return {
              ...entry,
              exclusion: undefined,
              result: "Succeeded",
              message: `${verificationLabel} verified from current history.`,
            };
          }
          let exclusion = "";
          let impact: ArchiveImpactResponse | undefined;
          if (action === "dismiss") {
            if (item.archiveState.isArchived)
              exclusion = "Restore this archived item first.";
            else if (!item.permittedTransitions.includes("Dismissed"))
              exclusion = `${item.status} cannot be dismissed.`;
          } else if (action !== "edit") {
            if (action === "archive" && item.archiveState.isArchived)
              exclusion = "Already archived.";
            if (action === "restore") {
              if (item.archiveState.inheritedFrom.length)
                exclusion = `Restore the archived ${item.archiveState.inheritedFrom.join(", ")} first.`;
              else if (!item.archiveState.directlyArchived)
                exclusion = "Not directly archived.";
            }
            if (!exclusion) {
              impact = await fetchArchiveImpact("actionable", item.id);
              if (impact.target.version !== item.version)
                exclusion = "Changed while checking impact. Review again.";
            }
          }
          return { id: item.id, title: item.title, item, impact, exclusion };
        } catch (error) {
          return {
            ...entry,
            exclusion: errorMessage(error),
          };
        }
      }),
    );
    if (sequence !== reviewSequence.current) return;
    setEntries(reviewed);
    setFinished(false);
    setLoading(false);
    if (reviewed.some((entry) => entry.result === "Succeeded")) {
      await onApplied(
        reviewed
          .filter((entry) => entry.result === "Succeeded")
          .map((entry) => entry.id),
      );
    }
  };

  useEffect(() => {
    dialog.current?.showModal();
    void review(targets);
    return () => {
      reviewSequence.current++;
    };
  }, [targets, action]);

  const preparedEntries = entries.map((entry) => {
    if (action !== "edit" || !entry.item || entry.result || entry.exclusion)
      return entry;
    return { ...entry, ...prepareEdit(entry.item, field, value) };
  });
  const eligible = preparedEntries.filter(
    (entry) => entry.item && !entry.exclusion && entry.result !== "Succeeded",
  );
  const apply = async () => {
    if (
      submitting.current ||
      loading ||
      finished ||
      (action === "dismiss" && !reason.trim()) ||
      !eligible.length
    )
      return;
    submitting.current = true;
    reviewSequence.current++;
    setSaving(true);
    const results: Entry[] = [];
    for (const entry of preparedEntries) {
      if (entry.result === "Succeeded") {
        results.push(entry);
        continue;
      }
      if (!entry.item || entry.exclusion) {
        results.push({ ...entry, result: "Skipped", message: entry.exclusion });
        continue;
      }
      try {
        if (action === "dismiss") {
          await transitionActionable(entry.id, {
            version: entry.item.version,
            status: "Dismissed",
            reason: reason.trim(),
            origin: "user",
          });
        } else if (action === "edit") {
          await updateActionable(entry.id, entry.input!);
        } else {
          await setActionableArchived(
            entry.id,
            entry.item.version,
            action === "archive",
          );
        }
        results.push({
          ...entry,
          result: "Succeeded",
          message: `${completedLabel}.`,
        });
      } catch (error) {
        // A lost response is not a failed write. Read back before offering retry.
        try {
          const current = await fetchActionable(entry.id);
          const confirmed = actionConfirmed(
            entry.item,
            current,
            action,
            reason,
            entry.input,
          );
          if (confirmed) {
            results.push({
              ...entry,
              result: "Succeeded",
              message: `${verificationLabel} verified after the response was interrupted.`,
            });
          } else {
            results.push({
              ...entry,
              result: error instanceof ApiProblem ? "Failed" : "Uncertain",
              message: `${errorMessage(error)} Current state: ${current.status}. Review again before retrying.`,
            });
          }
        } catch {
          results.push({
            ...entry,
            result: "Uncertain",
            message:
              "Outcome could not be verified. Review again to load current state before retrying.",
          });
        }
      }
      setEntries([...results, ...preparedEntries.slice(results.length)]);
    }
    setEntries(results);
    setFinished(true);
    try {
      await onApplied(
        results
          .filter((entry) => entry.result === "Succeeded")
          .map((entry) => entry.id),
      );
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="archive-dialog bulk-dialog"
      role="dialog"
      aria-labelledby="bulk-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
    >
      <div className="bulk-content">
        <h2 id="bulk-title">{actionLabel} selected Actionables</h2>
        {action === "dismiss" && (
          <p>
            Only selected eligible items will be dismissed. Unselected subtasks
            stay unchanged. Dismissal is not completion.
          </p>
        )}
        {(action === "archive" || action === "restore") && (
          <p>
            Only selected eligible items will be {completedLabel.toLowerCase()}.
            Workflow status, content and relationships stay unchanged. Archived
            projects, repositories and worktrees must be restored separately.
          </p>
        )}
        {action === "edit" && (
          <>
            <p>
              Change one field on each eligible item. Other content, workflow
              status, scope, claims and relationships stay unchanged.
            </p>
            <label className="bulk-field form-field">
              <span>Field to change</span>
              <select
                value={field}
                disabled={editLocked}
                onChange={(event) => {
                  setField(event.target.value as MetadataField);
                  setValue("");
                }}
              >
                <option value="priority">Priority</option>
                <option value="effort">Effort</option>
                <option value="add-tags">Add tags</option>
                <option value="remove-tags">Remove tags</option>
              </select>
            </label>
            <label className="bulk-field form-field">
              <span>New value</span>
              {(field === "priority" || field === "effort") && (
                <select
                  value={value}
                  disabled={editLocked}
                  onChange={(event) => setValue(event.target.value)}
                >
                  <option value="">Choose a value</option>
                  {(field === "priority"
                    ? prioritySchema.options
                    : effortSchema.options
                  ).map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </select>
              )}
              {(field === "add-tags" || field === "remove-tags") && (
                <input
                  value={value}
                  disabled={editLocked}
                  aria-describedby="bulk-tag-help"
                  onChange={(event) => setValue(event.target.value)}
                />
              )}
            </label>
            {(field === "add-tags" || field === "remove-tags") && (
              <p id="bulk-tag-help">
                Separate tags with commas. Maximum 60 characters per tag and 30
                resulting tags per item. Matching ignores case.
              </p>
            )}
          </>
        )}
        <p role="status">
          {loading
            ? "Checking selected items…"
            : `${eligible.length} eligible · ${preparedEntries.filter((entry) => entry.exclusion).length} excluded · ${preparedEntries.filter((entry) => entry.result === "Succeeded").length} succeeded`}
        </p>
        <ul
          className="bulk-items"
          aria-label="Selected items and results"
          aria-live="polite"
        >
          {preparedEntries.map((entry) => {
            let label =
              entry.result ?? (entry.exclusion ? "Excluded" : "Eligible");
            if (loading) label = "Checking…";
            return (
              <li key={entry.id}>
                <strong>
                  #{entry.id} · {entry.title}
                </strong>
                <p>
                  {label}
                  {entry.message || entry.exclusion
                    ? ` — ${entry.message || entry.exclusion}`
                    : ""}
                </p>
                {entry.change && <p>{entry.change}</p>}
                {entry.item && !entry.result && action === "dismiss" && (
                  <p>
                    {entry.item.childCompletion?.total ?? 0} descendants; only
                    selected descendants change. {entry.item.blocksCount}{" "}
                    dependent relationships remain. Dismissal does not satisfy
                    prerequisites.
                    {entry.item.agentClaim &&
                      " An agent claim exists; this human action leaves the claim unchanged."}
                  </p>
                )}
                {action === "archive" && entry.impact && !entry.result && (
                  <ul aria-label={`Archive impact for #${entry.id}`}>
                    {entry.impact.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        {action === "dismiss" && (
          <label className="bulk-field form-field">
            <span>Dismissal reason</span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={10000}
              rows={3}
              disabled={saving || finished}
              required
            />
          </label>
        )}
      </div>
      <footer>
        <button type="button" onClick={onClose} disabled={saving}>
          {finished ? "Close" : "Cancel"}
        </button>
        {(finished || preparedEntries.some((entry) => entry.exclusion)) && (
          <button
            type="button"
            disabled={
              loading ||
              saving ||
              entries.every((entry) => entry.result === "Succeeded")
            }
            onClick={() => void review(entries)}
          >
            Review remaining
          </button>
        )}
        {!finished && (
          <button
            type="button"
            className="primary-action"
            disabled={
              loading ||
              saving ||
              (action === "dismiss" && !reason.trim()) ||
              !eligible.length
            }
            onClick={() => void apply()}
          >
            {saving ? "Applying…" : `Confirm ${action} ${eligible.length}`}
          </button>
        )}
      </footer>
    </dialog>
  );
}
