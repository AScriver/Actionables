import {
  Activity,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Clock3,
  Copy,
  ExternalLink,
  FileCode2,
  GitBranch,
  List,
  Menu,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  type CreateActionableRequest,
  type ActionableDetail,
  type ActionableSummary,
  type Effort,
  type EvidenceState,
  type Priority,
  type ScopeOptionsResponse,
  type Status,
  type UserSourceReferenceInput,
  type ValidationOutcome,
  type ValidationType,
} from "@actionables/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiProblem,
  createDependency,
  createActionable,
  createSubtask,
  detachParent,
  fetchActionable,
  fetchActionables,
  fetchScopeOptions,
  recordValidation,
  removeDependency,
  restoreDependency,
  setParent,
  transitionActionable,
  updateActionable,
  waiveDependency,
} from "./api";
import { Markdown } from "./Markdown";
import { safeImportedSourceUrl, safeSourceUrl } from "./source-links";

type InspectorTab = "finding" | "research" | "validation";
type PriorityFilter = "All" | Priority;

const priorityOrder: Record<Priority, number> = {
  Unset: 5,
  Critical: 0,
  High: 1,
  Medium: 2,
  Low: 3,
  Backlog: 4,
};

const priorities: Priority[] = ["Unset", "Critical", "High", "Medium", "Low", "Backlog"];
const efforts: Effort[] = ["Unknown", "XS", "S", "S–M", "M", "M–L", "L", "L–XL", "XL"];
const evidenceStates: EvidenceState[] = [
  "Unclassified",
  "Confirmed",
  "Suspected",
  "Proposed",
  "Investigation",
];

function Badge({
  children,
  tone,
  title,
  ariaLabel,
}: {
  children: React.ReactNode;
  tone: string;
  title?: string;
  ariaLabel?: string;
}) {
  return (
    <span
      className={`badge badge-${tone.toLowerCase().replace(/\s+/g, "-")}`}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </span>
  );
}

function IconButton({
  label,
  children,
  onClick,
  pressed,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
  pressed?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function WorktreeRow({
  name,
  selected,
  count,
  onClick,
}: {
  name: string;
  selected: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`worktree-row ${selected ? "is-selected" : ""}`}
      onClick={onClick}
      title={name}
      aria-label={`${name}${count === undefined ? "" : `, ${count} findings`}`}
    >
      <GitBranch aria-hidden="true" />
      <span className="worktree-name">{name}</span>
      {count !== undefined && <span className="tree-count">{count}</span>}
      <span className={`tree-status ${selected ? "is-active" : ""}`} aria-hidden="true" />
    </button>
  );
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  }
}

function SourceActions({
  locator,
  openUrl,
  onNotice,
}: {
  locator: string;
  openUrl: string | null;
  onNotice: (notice: string) => void;
}) {
  const copy = async () => {
    if (await copyText(locator)) onNotice("Source locator copied.");
    else window.prompt("Copy this source locator:", locator);
  };
  return (
    <span className="source-actions">
      {openUrl && (
        <a href={openUrl} aria-label="Open source" title="Open source">
          <ExternalLink aria-hidden="true" />
        </a>
      )}
      <button type="button" onClick={copy} aria-label="Copy source locator" title="Copy source locator">
        <Copy aria-hidden="true" />
      </button>
    </span>
  );
}

function SourceHistory({
  selected,
  onNotice,
}: {
  selected: ActionableDetail;
  onNotice: (notice: string) => void;
}) {
  const imported = selected.immutableSourceEvidence.imported;
  return (
    <section className="inspector-section">
      <h3>{imported ? "Imported source evidence" : "Source references"}</h3>
      <div className="source-history">
        <div className={`source-evidence-notice ${imported ? "is-imported" : ""}`}>
          <strong>{imported ? "Read-only imported evidence" : "No imported evidence"}</strong>
          <p>{selected.immutableSourceEvidence.note}</p>
        </div>
        {imported && selected.immutableSourceEvidence.sourceFiles.map((file) => (
          <div className="source-event" key={`${file.path}-${file.lines ?? file.symbol ?? ""}`}>
            <div className="source-event-meta">
              <span className="source-label">imported</span>
              <span>{file.lines ?? file.symbol ?? "file"}</span>
              <span>original evidence</span>
            </div>
            <p>
              <code>{file.path}</code>
              <SourceActions locator={file.path} openUrl={null} onNotice={onNotice} />
            </p>
          </div>
        ))}
        <div className="source-event">
          <div className="source-event-meta">
            <span className="source-label">{imported ? "import" : "manual"}</span>
            <span>now</span>
            <span>status provenance</span>
          </div>
          <p>
            {selected.statusProvenance.note}
            {selected.statusProvenance.kind === "neutral-import" &&
            selected.statusProvenance.suggestedStatus
              ? ` Prototype suggestion: ${selected.statusProvenance.suggestedStatus}.`
              : ""}
          </p>
        </div>
        {selected.userSources.map((source, index) => (
          <div className="source-event user-source" key={`${source.type}-${source.locator}-${index}`}>
            <div className="source-event-meta">
              <span className="source-label">user-added</span>
              <span>{source.type}</span>
              <span>{source.label || "source reference"}</span>
            </div>
            <p>
              <code>{source.locator}</code>
              <SourceActions
                locator={source.locator}
                openUrl={safeSourceUrl(source)}
                onNotice={onNotice}
              />
            </p>
            <time dateTime={source.createdAt}>
              Added {new Date(source.createdAt).toLocaleString()} · {source.provenance}
            </time>
          </div>
        ))}
        {imported && selected.sourceThread && (
          <div className="source-link">
            <span>Imported source thread</span>
            <SourceActions
              locator={selected.sourceThread}
              openUrl={safeImportedSourceUrl(selected.sourceThread)}
              onNotice={onNotice}
            />
          </div>
        )}
      </div>
    </section>
  );
}

function RelationshipSection({
  selected,
  actionables,
  onNavigate,
  onMutated,
}: {
  selected: ActionableDetail;
  actionables: ActionableSummary[];
  onNavigate: (id: number) => void;
  onMutated: (saved: ActionableDetail, notice: string) => void;
}) {
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [childId, setChildId] = useState("");
  const [prerequisiteId, setPrerequisiteId] = useState("");
  const [dependentId, setDependentId] = useState("");
  const [parentId, setParentId] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const hierarchyCandidates = actionables.filter(
    (item) =>
      item.id !== selected.id &&
      item.scope.projectId === selected.scope.projectId &&
      item.scope.repositoryId === selected.scope.repositoryId &&
      item.scope.worktreeId === selected.scope.worktreeId,
  );
  const options = (items: ActionableSummary[]) =>
    items.map((item) => (
      <option key={item.id} value={item.id}>
        {item.id} · {item.title} — {item.scope.projectName}/{item.scope.worktreeName}
      </option>
    ));
  const run = async (work: () => Promise<ActionableDetail>, notice: string) => {
    setSaving(true);
    setError("");
    try {
      onMutated(await work(), notice);
    } catch (caught) {
      if (caught instanceof ApiProblem) {
        setError(Object.values(caught.problem.errors ?? {}).flat().join(" ") || caught.problem.title);
        if (caught.problem.current) onMutated(caught.problem.current, "The saved version changed; relationship action was not applied.");
      } else setError("The relationship change could not be completed.");
    } finally {
      setSaving(false);
    }
  };
  const selectedParent = selected.relationships.parent?.parent;

  return (
    <section className="inspector-section relationships" aria-label="Relationships">
      {selectedParent && (
        <div className="relationship-parent">
          <span>Parent</span>
          <button type="button" onClick={() => onNavigate(selectedParent.id)}>
            {selectedParent.id} · {selectedParent.title}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void run(
              () => detachParent(selected.id, {
                version: selected.version,
                parentVersion: selectedParent.version,
              }),
              "Subtask detached; the relationship remains in activity history.",
            )}
          >
            Detach
          </button>
        </div>
      )}
      <div className="relationship-group">
        <h3>Subtasks <span>{selected.relationships.subtasks.length}</span></h3>
        {selected.relationships.subtasks.map((relationship) => (
          <div className="relationship-row" key={relationship.id}>
            <button type="button" onClick={() => onNavigate(relationship.child.id)}>
              {relationship.child.id} · {relationship.child.title}
            </button>
            <span>{relationship.child.status}</span>
          </div>
        ))}
        <form
          className="relationship-add"
          onSubmit={(event) => {
            event.preventDefault();
            if (!subtaskTitle.trim()) return;
            void run(
              () => createSubtask(selected.id, { version: selected.version, title: subtaskTitle }),
              "Subtask created and attached.",
            ).then(() => setSubtaskTitle(""));
          }}
        >
          <input value={subtaskTitle} onChange={(event) => setSubtaskTitle(event.target.value)} placeholder="New subtask name" aria-label="New subtask name" />
          <button disabled={saving || !subtaskTitle.trim()} type="submit">Create</button>
        </form>
        {!selected.parentId && (
          <div className="relationship-add">
            <select value={childId} onChange={(event) => setChildId(event.target.value)} aria-label="Existing subtask">
              <option value="">Link existing subtask…</option>
              {options(hierarchyCandidates.filter((item) => !item.childIds?.length && item.id !== selected.id))}
            </select>
            <button
              type="button"
              disabled={saving || !childId}
              onClick={() => {
                const child = actionables.find((item) => item.id === Number(childId));
                const oldParent = child?.parentId ? actionables.find((item) => item.id === child.parentId) : undefined;
                if (!child) return;
                void run(
                  () => setParent(child.id, {
                    version: child.version,
                    parentId: selected.id,
                    parentVersion: selected.version,
                    currentParentVersion: oldParent?.version,
                  }),
                  oldParent ? "Subtask reassigned with both relationship changes recorded." : "Existing actionable attached as a subtask.",
                ).then(() => setChildId(""));
              }}
            >
              Link
            </button>
          </div>
        )}
        {selectedParent && (
          <div className="relationship-add">
            <select value={parentId} onChange={(event) => setParentId(event.target.value)} aria-label="Replacement parent">
              <option value="">Change parent…</option>
              {options(hierarchyCandidates.filter((item) => !item.parentId && !item.childIds?.length))}
            </select>
            <button
              type="button"
              disabled={saving || !parentId}
              onClick={() => {
                const parent = actionables.find((item) => item.id === Number(parentId));
                if (!parent) return;
                void run(
                  () => setParent(selected.id, {
                    version: selected.version,
                    parentId: parent.id,
                    parentVersion: parent.version,
                    currentParentVersion: selectedParent.version,
                  }),
                  "Subtask reassigned and detach/attach history recorded.",
                ).then(() => setParentId(""));
              }}
            >
              Move
            </button>
          </div>
        )}
      </div>
      <div className="relationship-group">
        <h3>Blocked by <span>{selected.relationships.blockedBy.length}</span></h3>
        {selected.relationships.blockedBy.map((relationship) => (
          <div className="relationship-row dependency-row" key={relationship.id}>
            <button type="button" onClick={() => onNavigate(relationship.prerequisite.id)}>
              {relationship.prerequisite.id} · {relationship.prerequisite.title}
            </button>
            <span className={`dependency-state is-${relationship.state}`}>{relationship.state}</span>
            {relationship.state === "waived" ? (
              <button
                type="button"
                disabled={saving}
                onClick={() => void run(
                  () => restoreDependency(selected.id, relationship.id, {
                    version: selected.version,
                    prerequisiteVersion: relationship.prerequisite.version,
                  }),
                  "Dependency restored; derived blocking recalculated.",
                )}
              >
                Restore
              </button>
            ) : (
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  const reason = window.prompt("Why is this dependency being waived?");
                  if (reason?.trim()) void run(
                    () => waiveDependency(selected.id, relationship.id, {
                      version: selected.version,
                      prerequisiteVersion: relationship.prerequisite.version,
                      reason,
                    }),
                    "Dependency waived with its reason recorded.",
                  );
                }}
              >
                Waive
              </button>
            )}
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                const reason = window.prompt("Why is this dependency being removed?");
                if (reason?.trim()) void run(
                  () => removeDependency(selected.id, relationship.id, {
                    version: selected.version,
                    prerequisiteVersion: relationship.prerequisite.version,
                    reason,
                  }),
                  "Dependency removed; the relationship remains auditable.",
                );
              }}
            >
              Remove
            </button>
          </div>
        ))}
        <div className="relationship-add">
          <select value={prerequisiteId} onChange={(event) => setPrerequisiteId(event.target.value)} aria-label="Prerequisite actionable">
            <option value="">Add prerequisite…</option>
            {options(actionables.filter((item) => item.id !== selected.id))}
          </select>
          <button
            type="button"
            disabled={saving || !prerequisiteId}
            onClick={() => {
              const prerequisite = actionables.find((item) => item.id === Number(prerequisiteId));
              if (!prerequisite) return;
              void run(
                () => createDependency(selected.id, {
                  version: selected.version,
                  prerequisiteId: prerequisite.id,
                  prerequisiteVersion: prerequisite.version,
                }),
                "Dependency added; derived blocking recalculated.",
              ).then(() => setPrerequisiteId(""));
            }}
          >
            Add
          </button>
        </div>
      </div>
      <div className="relationship-group">
        <h3>Blocks <span>{selected.relationships.blocks.length}</span></h3>
        {selected.relationships.blocks.map((relationship) => (
          <div className="relationship-row" key={relationship.id}>
            <button type="button" onClick={() => onNavigate(relationship.dependent.id)}>
              {relationship.dependent.id} · {relationship.dependent.title}
            </button>
            <span className={`dependency-state is-${relationship.state}`}>{relationship.state}</span>
          </div>
        ))}
        <div className="relationship-add">
          <select value={dependentId} onChange={(event) => setDependentId(event.target.value)} aria-label="Dependent actionable">
            <option value="">Link dependent…</option>
            {options(actionables.filter((item) => item.id !== selected.id))}
          </select>
          <button
            type="button"
            disabled={saving || !dependentId}
            onClick={() => {
              const dependent = actionables.find((item) => item.id === Number(dependentId));
              if (!dependent) return;
              void run(
                () => createDependency(dependent.id, {
                  version: dependent.version,
                  prerequisiteId: selected.id,
                  prerequisiteVersion: selected.version,
                }),
                "Dependent linked; derived blocking recalculated.",
              ).then(() => setDependentId(""));
            }}
          >
            Link
          </button>
        </div>
      </div>
      {error && <p className="relationship-error" role="alert">{error}</p>}
    </section>
  );
}

function LifecycleControls({
  selected,
  onMutated,
}: {
  selected: ActionableDetail;
  onMutated: (saved: ActionableDetail, notice: string) => void;
}) {
  const [target, setTarget] = useState<Status | null>(null);
  const [reason, setReason] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const needsReason =
    target === "Blocked" ||
    target === "Dismissed" ||
    (target === "Ready" &&
      (selected.status === "Done" || selected.status === "Dismissed"));

  const submit = async () => {
    if (!target) return;
    setSaving(true);
    setError("");
    try {
      const saved = await transitionActionable(selected.id, {
        version: selected.version,
        status: target,
        reason: needsReason ? reason : undefined,
        completionOverrideReason:
          target === "Done" && overrideReason.trim() ? overrideReason : undefined,
        origin: "user",
      });
      const notice =
        target === "Done" && overrideReason.trim()
          ? "Completion override recorded distinctly from validated completion."
          : `Actionable moved to ${target}.`;
      setTarget(null);
      setReason("");
      setOverrideReason("");
      onMutated(saved, notice);
    } catch (caught) {
      if (caught instanceof ApiProblem) {
        setError(
          Object.values(caught.problem.errors ?? {}).flat().join(" ") ||
            caught.problem.title,
        );
        if (caught.problem.code === "VERSION_CONFLICT" && caught.problem.current) {
          onMutated(
            caught.problem.current,
            "This lifecycle action was stale and was not applied. The current version is loaded; your reason remains available.",
          );
        }
      } else {
        setError("The lifecycle action could not be completed.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="lifecycle-strip" aria-label="Lifecycle actions">
      <div className="lifecycle-heading">
        <strong>Lifecycle</strong>
        <span>Server-permitted actions</span>
      </div>
      {selected.manualBlocker && (
        <div className="manual-blocker">
          <strong>Blocked — manual</strong>
          <Markdown>{selected.manualBlocker}</Markdown>
        </div>
      )}
      <div className="lifecycle-actions">
        {selected.permittedTransitions.map((status) => (
          <button
            type="button"
            key={status}
            className={status === "Done" ? "lifecycle-done" : ""}
            onClick={() => {
              setTarget(status);
              setReason("");
              setOverrideReason("");
              setError("");
            }}
          >
            {status}
          </button>
        ))}
      </div>
      {target && (
        <div className="lifecycle-confirm" role="group" aria-label={`Move to ${target}`}>
          <div>
            <strong>{selected.status} → {target}</strong>
            {target === "Done" && (
              <p>
                {selected.completionEligibility.qualifyingValidationRecordId
                  ? "A current Passed validation qualifies. Leave override blank for validated completion."
                  : "No current validation qualifies. An override is exceptional and remains visibly distinct from validation."}
              </p>
            )}
            {target === "Dismissed" && (
              <p>Dismissal means no longer intended; it is not completion.</p>
            )}
            {target === "Ready" &&
              (selected.status === "Done" || selected.status === "Dismissed") &&
              selected.relationships.parent?.parent.status === "Done" && (
                <p>
                  Reopening this subtask will also reopen its Done parent to Ready in the same transaction.
                </p>
              )}
          </div>
          {needsReason && (
            <label>
              <span>
                {target === "Blocked"
                  ? "Blocker note"
                  : target === "Dismissed"
                    ? "Dismissal reason"
                    : "Reopening reason"}
              </span>
              <textarea
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          )}
          {target === "Done" && (
            <label className="override-field">
              <span>
                Completion override reason
                {selected.completionEligibility.qualifyingValidationRecordId
                  ? " (optional and exceptional)"
                  : " (required without qualifying validation)"}
              </span>
              <textarea
                rows={2}
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
              />
            </label>
          )}
          {error && <p className="inline-error" role="alert">{error}</p>}
          <div className="lifecycle-confirm-actions">
            <button type="button" onClick={() => setTarget(null)} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="primary-action" onClick={submit} disabled={saving}>
              {saving
                ? "Saving…"
                : target === "Done" && overrideReason.trim()
                  ? "Complete with override"
                  : `Confirm ${target}`}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function ValidationRecords({
  selected,
  onMutated,
}: {
  selected: ActionableDetail;
  onMutated: (saved: ActionableDetail, notice: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<ValidationType>("Automated test");
  const [outcome, setOutcome] = useState<ValidationOutcome>("Passed");
  const [notes, setNotes] = useState("");
  const [evidence, setEvidence] = useState("");
  const [supersedesId, setSupersedesId] = useState<string | undefined>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setOpen(false);
    setType("Automated test");
    setOutcome("Passed");
    setNotes("");
    setEvidence("");
    setSupersedesId(undefined);
    setError("");
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const saved = await recordValidation(selected.id, {
        version: selected.version,
        type,
        outcome,
        notes,
        evidence,
        origin: "user",
        supersedesId,
      });
      reset();
      onMutated(
        saved,
        supersedesId
          ? "Validation correction appended; the earlier record remains in history."
          : "Validation result appended.",
      );
    } catch (caught) {
      if (caught instanceof ApiProblem) {
        setError(
          Object.values(caught.problem.errors ?? {}).flat().join(" ") ||
            caught.problem.title,
        );
        if (caught.problem.code === "VERSION_CONFLICT" && caught.problem.current) {
          onMutated(
            caught.problem.current,
            "This validation save was stale and was not applied. The current version is loaded; your evidence remains in the form.",
          );
        }
      } else {
        setError("The validation result could not be saved.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="inspector-section validation-records">
      <div className="section-title-row">
        <div>
          <h3>Validation records</h3>
          <p className="section-help">{selected.completionEligibility.policy}</p>
        </div>
        <button
          type="button"
          className="secondary-action"
          onClick={() => {
            setOpen(true);
            setSupersedesId(undefined);
          }}
        >
          Record result
        </button>
      </div>
      {selected.validationRecords.map((record) => (
        <article
          className={`validation-record ${record.supersededById ? "is-superseded" : ""}`}
          key={record.id}
        >
          <header>
            <Badge tone={record.outcome}>{record.outcome}</Badge>
            <strong>{record.type}</strong>
            {record.qualifiesForCompletion && (
              <span className="qualifying-label"><CheckCircle2 aria-hidden="true" /> Qualifying</span>
            )}
            {record.supersededById && <span>Superseded</span>}
          </header>
          {record.notes && <Markdown>{record.notes}</Markdown>}
          {record.evidence && (
            <div className="validation-evidence">
              <span>Evidence</span>
              <Markdown>{record.evidence}</Markdown>
            </div>
          )}
          <footer>
            <time dateTime={record.recordedAt}>
              {new Date(record.recordedAt).toLocaleString()}
            </time>
            <span>{record.origin}</span>
            {!record.supersededById && (
              <button
                type="button"
                onClick={() => {
                  setOpen(true);
                  setSupersedesId(record.id);
                  setType(record.type);
                  setOutcome(record.outcome);
                  setNotes(record.notes);
                  setEvidence(record.evidence);
                }}
              >
                <RotateCcw aria-hidden="true" /> Correct
              </button>
            )}
          </footer>
        </article>
      ))}
      {selected.validationRecords.length === 0 && (
        <p className="section-help">No validation results have been recorded.</p>
      )}
      {open && (
        <form className="validation-form" onSubmit={submit}>
          <strong>{supersedesId ? "Append validation correction" : "Record validation result"}</strong>
          {supersedesId && (
            <p>The prior record remains unchanged and this record will point to it.</p>
          )}
          <div className="validation-form-grid">
            <label>
              <span>Type</span>
              <select value={type} onChange={(event) => setType(event.target.value as ValidationType)}>
                {["Automated test", "Manual test", "Command", "Review", "Document"].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Outcome</span>
              <select value={outcome} onChange={(event) => setOutcome(event.target.value as ValidationOutcome)}>
                {["Passed", "Failed", "Partial"].map((value) => <option key={value}>{value}</option>)}
              </select>
            </label>
          </div>
          <label>
            <span>Notes</span>
            <textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
          <label>
            <span>Evidence</span>
            <textarea rows={3} value={evidence} onChange={(event) => setEvidence(event.target.value)} />
          </label>
          {error && <p className="inline-error" role="alert">{error}</p>}
          <div className="lifecycle-confirm-actions">
            <button type="button" onClick={reset} disabled={saving}>Cancel</button>
            <button type="submit" className="primary-action" disabled={saving}>
              {saving ? "Saving…" : supersedesId ? "Append correction" : "Record result"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function ActivityTimeline({ selected }: { selected: ActionableDetail }) {
  return (
    <section className="inspector-section activity-timeline">
      <h3>Activity</h3>
      {selected.activity.map((event) => (
        <article
          key={event.id}
          className={event.type === "completion-overridden" ? "is-override" : ""}
        >
          <Activity aria-hidden="true" />
          <div>
            <strong>{event.summary}</strong>
            {event.context.reason && <Markdown>{event.context.reason}</Markdown>}
            <time dateTime={event.occurredAt}>
              {new Date(event.occurredAt).toLocaleString()}
            </time>
          </div>
        </article>
      ))}
    </section>
  );
}

function Inspector({
  selected,
  actionables,
  activeTab,
  setActiveTab,
  onCloseMobile,
  validationChecks,
  toggleValidation,
  onEdit,
  onMutated,
  onNavigate,
  onNotice,
}: {
  selected: ActionableDetail;
  actionables: ActionableSummary[];
  activeTab: InspectorTab;
  setActiveTab: (tab: InspectorTab) => void;
  onCloseMobile: () => void;
  validationChecks: Set<string>;
  toggleValidation: (key: string) => void;
  onEdit: () => void;
  onMutated: (saved: ActionableDetail, notice: string) => void;
  onNavigate: (id: number) => void;
  onNotice: (notice: string) => void;
}) {
  return (
    <>
      <header className="inspector-header">
        <div className="inspector-title-row">
          <button type="button" className="mobile-back" onClick={onCloseMobile}>
            <ChevronRight aria-hidden="true" /> Findings
          </button>
          <h2>{selected.title}</h2>
          <div className="inspector-actions">
            <IconButton label="Edit actionable" onClick={onEdit}><Pencil /></IconButton>
            <IconButton label="More actionable actions"><MoreVertical /></IconButton>
          </div>
        </div>
        <div className="metadata-row">
          <Badge tone={selected.priority}>{selected.priority}</Badge>
          <Badge
            tone={selected.status}
            title={selected.statusProvenance.note}
            ariaLabel={`${selected.status}. ${selected.statusProvenance.note}`}
          >
            {selected.status}
          </Badge>
          <span className="metadata-divider" />
          <span className="mono metadata-item"><GitBranch aria-hidden="true" />{selected.worktree}</span>
          <span className="metadata-divider" />
          <span className="metadata-item"><span className="effort-mark">{selected.effort}</span></span>
          <span className="metadata-divider" />
          <span className="metadata-item"><Clock3 aria-hidden="true" />{selected.updated}</span>
        </div>
      </header>

      <LifecycleControls key={`lifecycle-${selected.id}`} selected={selected} onMutated={onMutated} />

      <nav className="inspector-tabs" aria-label="Actionable detail">
        {(["finding", "research", "validation"] as InspectorTab[]).map((tab) => (
          <button
            type="button"
            key={tab}
            className={activeTab === tab ? "is-active" : ""}
            aria-selected={activeTab === tab}
            role="tab"
            onClick={() => setActiveTab(tab)}
          >
            {tab === "finding" ? "Finding" : tab === "research" ? "Research notes" : "Validation"}
          </button>
        ))}
      </nav>

      <div className="inspector-content">
        {activeTab === "finding" && (
          <>
            <section className="inspector-section">
              <h3>Finding</h3>
              {selected.finding
                ? <Markdown>{selected.finding}</Markdown>
                : <p>No finding has been written yet.</p>}
            </section>
            <section className="inspector-section">
              <h3>Description</h3>
              {selected.description
                ? <Markdown>{selected.description}</Markdown>
                : <p>No intended result has been written yet.</p>}
            </section>

            <section className="inspector-section">
              <h3>Files and symbols</h3>
              <div className="file-list">
                {selected.files.map((file) => (
                  <div className="file-row" key={`${file.path}-${file.lines ?? file.symbol ?? ""}`}>
                    <FileCode2 aria-hidden="true" />
                    <code>{file.path}</code>
                    <span>{file.symbol ?? file.lines ?? "reference"}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="inspector-section">
              <h3>Research notes</h3>
              {selected.research.length > 0
                ? <div className="research-list">{selected.research.map((note) => <Markdown key={note}>{note}</Markdown>)}</div>
                : <p>No research notes yet.</p>}
            </section>

            <section className="inspector-section">
              <h3>Validation</h3>
              {selected.validation.length > 0 ? <div className="validation-list">
                {selected.validation.map((step, index) => {
                  const key = `${selected.id}-${index}`;
                  return (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={validationChecks.has(key)}
                        onChange={() => toggleValidation(key)}
                      />
                      <Markdown inline>{step}</Markdown>
                    </label>
                  );
                })}
              </div> : <p>No validation plan yet.</p>}
            </section>
            <RelationshipSection selected={selected} actionables={actionables} onNavigate={onNavigate} onMutated={onMutated} />
            <SourceHistory selected={selected} onNotice={onNotice} />
          </>
        )}

        {activeTab === "research" && (
          <>
            <section className="inspector-section tab-lead">
              <h3>Research notes</h3>
              <div className="finding-callout"><Markdown>{selected.finding}</Markdown></div>
              <div className="research-list expanded">
                {selected.research.map((note) => <Markdown key={note}>{note}</Markdown>)}
              </div>
            </section>
            <RelationshipSection selected={selected} actionables={actionables} onNavigate={onNavigate} onMutated={onMutated} />
            <SourceHistory selected={selected} onNotice={onNotice} />
          </>
        )}

        {activeTab === "validation" && (
          <>
            <section className="inspector-section tab-lead">
              <h3>Validation procedure</h3>
              <p className="section-help">This is the editable plan. Completion uses the append-only records below, not these local reading checkmarks.</p>
              <div className="validation-list validation-large">
                {selected.validation.map((step, index) => {
                  const key = `${selected.id}-${index}`;
                  return (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={validationChecks.has(key)}
                        onChange={() => toggleValidation(key)}
                      />
                      <Markdown inline>{step}</Markdown>
                    </label>
                  );
                })}
              </div>
            </section>
            <ValidationRecords key={`validation-${selected.id}`} selected={selected} onMutated={onMutated} />
            <ActivityTimeline selected={selected} />
          </>
        )}
      </div>
    </>
  );
}

type ActionableDraft = {
  title: string;
  priority: Priority;
  status: Status;
  effort: Effort;
  evidenceState: EvidenceState;
  projectId: string;
  repositoryId: string;
  worktreeId: string;
  finding: string;
  description: string;
  researchText: string;
  validationText: string;
  tagsText: string;
  userSources: UserSourceReferenceInput[];
  version: number;
};

function lines(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function draftFromItem(item: ActionableDetail): ActionableDraft {
  return {
    title: item.title,
    priority: item.priority,
    status: item.status,
    effort: item.effort,
    evidenceState: item.evidenceState,
    projectId: item.scope.projectId,
    repositoryId: item.scope.repositoryId,
    worktreeId: item.scope.worktreeId,
    finding: item.finding,
    description: item.description,
    researchText: item.research.join("\n"),
    validationText: item.validation.join("\n"),
    tagsText: item.tags.join(", "),
    userSources: item.userSources.map(({ type, locator, label }) => ({
      type,
      locator,
      label,
    })),
    version: item.version,
  };
}

function emptyDraft(scopes: ScopeOptionsResponse): ActionableDraft {
  const project = scopes.projects[0];
  const repository = project?.repositories[0];
  const worktree = repository?.worktrees[0];
  return {
    title: "",
    priority: "Unset",
    status: "Inbox",
    effort: "Unknown",
    evidenceState: "Unclassified",
    projectId: project?.id ?? "",
    repositoryId: repository?.id ?? "",
    worktreeId: worktree?.id ?? "",
    finding: "",
    description: "",
    researchText: "",
    validationText: "",
    tagsText: "",
    userSources: [],
    version: 1,
  };
}

function fieldError(errors: Record<string, string[]>, field: string) {
  const messages = errors[field];
  return messages ? <span className="field-error" id={`${field}-error`}>{messages.join(" ")}</span> : null;
}

function ActionableForm({
  item,
  scopes,
  onClose,
  onSaved,
}: {
  item?: ActionableDetail;
  scopes: ScopeOptionsResponse;
  onClose: () => void;
  onSaved: (saved: ActionableDetail, created: boolean) => void;
}) {
  const initialDraft = useMemo(
    () => (item ? draftFromItem(item) : emptyDraft(scopes)),
    [item, scopes],
  );
  const [draft, setDraft] = useState(initialDraft);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<ActionableDetail | null>(null);
  const [reviewCurrent, setReviewCurrent] = useState(false);
  const [formNotice, setFormNotice] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const initialSnapshot = useMemo(() => JSON.stringify(initialDraft), [initialDraft]);
  const dirty = JSON.stringify(draft) !== initialSnapshot;

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    const backdrop = dialogRef.current?.parentElement;
    const shell = backdrop?.parentElement;
    if (!backdrop || !shell) return;
    const siblings = [...shell.children].filter((element) => element !== backdrop) as HTMLElement[];
    const previous = siblings.map((element) => ({
      element,
      ariaHidden: element.getAttribute("aria-hidden"),
      inert: element.inert,
    }));
    for (const sibling of siblings) {
      sibling.inert = true;
      sibling.setAttribute("aria-hidden", "true");
    }
    return () => {
      for (const state of previous) {
        state.element.inert = state.inert;
        if (state.ariaHidden === null) state.element.removeAttribute("aria-hidden");
        else state.element.setAttribute("aria-hidden", state.ariaHidden);
      }
    };
  }, []);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  const project = scopes.projects.find((candidate) => candidate.id === draft.projectId);
  const repositories = project?.repositories ?? [];
  const repository = repositories.find((candidate) => candidate.id === draft.repositoryId);
  const worktrees = repository?.worktrees ?? [];

  const update = <K extends keyof ActionableDraft>(key: K, value: ActionableDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      const matchingKeys = Object.keys(current).filter(
        (errorKey) => errorKey === key || errorKey.startsWith(`${String(key)}.`),
      );
      if (matchingKeys.length === 0) return current;
      const next = { ...current };
      for (const errorKey of matchingKeys) delete next[errorKey];
      return next;
    });
  };

  const requestClose = () => {
    if (dirty && !window.confirm("Discard your unsaved actionable changes?")) return;
    onClose();
  };

  const addSource = () => {
    update("userSources", [
      ...draft.userSources,
      { type: "File", locator: "", label: "" },
    ]);
  };

  const updateSource = (
    index: number,
    key: keyof UserSourceReferenceInput,
    value: string,
  ) => {
    const next = draft.userSources.map((source, sourceIndex) =>
      sourceIndex === index ? { ...source, [key]: value } : source,
    );
    update("userSources", next);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setErrors({});
    setConflict(null);
    setFormNotice(item ? "Saving changes…" : "Creating actionable…");

    const base: CreateActionableRequest = {
      title: draft.title,
      priority: draft.priority,
      effort: draft.effort,
      evidenceState: draft.evidenceState,
      projectId: draft.projectId,
      repositoryId: draft.repositoryId,
      worktreeId: draft.worktreeId,
      finding: draft.finding,
      description: draft.description,
      research: lines(draft.researchText),
      validation: lines(draft.validationText),
      tags: draft.tagsText.split(",").map((tag) => tag.trim()).filter(Boolean),
      userSources: draft.userSources,
    };

    try {
      const saved = item
        ? await updateActionable(item.id, {
            ...base,
            status: draft.status,
            version: draft.version,
          })
        : await createActionable(base);
      setFormNotice(item ? "Changes saved." : "Actionable created.");
      onSaved(saved, !item);
    } catch (error) {
      if (error instanceof ApiProblem) {
        setErrors(error.problem.errors ?? {});
        if (error.problem.code === "VERSION_CONFLICT" && error.problem.current) {
          setConflict(error.problem.current);
          setFormNotice("A newer saved version was found. Your draft is still here.");
        } else {
          setFormNotice(`${error.problem.title} Request ${error.problem.requestId}.`);
        }
      } else {
        setFormNotice("The actionable could not be saved. Your draft is still here.");
      }
    } finally {
      setSaving(false);
    }
  };

  const errorEntries = Object.entries(errors);
  return (
    <div
      className="form-backdrop"
      role="presentation"
      onKeyDown={(event) => {
        if (event.key === "Escape") requestClose();
      }}
    >
      <section
        ref={dialogRef}
        className="actionable-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="actionable-form-title"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          )].filter((element) => element.offsetParent !== null);
          const first = controls[0];
          const last = controls.at(-1);
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className="dialog-header">
          <div>
            <span className="dialog-eyebrow">{item ? `Version ${draft.version}` : "Neutral status: Inbox"}</span>
            <h2 id="actionable-form-title">{item ? "Edit actionable" : "New actionable"}</h2>
          </div>
          <IconButton label="Close actionable form" onClick={requestClose}><X /></IconButton>
        </header>

        <form onSubmit={submit} noValidate>
          <div className="dialog-content">
            {errorEntries.length > 0 && (
              <div className="error-summary" role="alert" aria-labelledby="error-summary-title">
                <strong id="error-summary-title">Check the highlighted fields.</strong>
                <ul>
                  {errorEntries.map(([field, messages]) => (
                    <li key={field}><a href={`#${field}`}>{messages.join(" ")}</a></li>
                  ))}
                </ul>
              </div>
            )}

            {conflict && (
              <div className="conflict-panel" role="alert">
                <strong>Someone saved version {conflict.version} while you were editing version {draft.version}.</strong>
                <p>Your unsaved draft has not been changed or discarded.</p>
                <div className="conflict-actions">
                  <button type="button" onClick={() => setReviewCurrent((value) => !value)}>
                    {reviewCurrent ? "Hide current saved version" : "Review current saved version"}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await navigator.clipboard.writeText(JSON.stringify(draft, null, 2));
                      setFormNotice("Draft copied to the clipboard.");
                    }}
                  >
                    Copy my draft
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft((current) => ({ ...current, version: conflict.version }));
                      setConflict(null);
                      setReviewCurrent(false);
                      setFormNotice("Current version loaded. Your field values remain ready to reapply.");
                    }}
                  >
                    Reload version and reapply draft
                  </button>
                </div>
                {reviewCurrent && (
                  <dl className="current-version">
                    <div><dt>Title</dt><dd>{conflict.title}</dd></div>
                    <div><dt>Status</dt><dd>{conflict.status}</dd></div>
                    <div><dt>Updated</dt><dd>{conflict.updated}</dd></div>
                  </dl>
                )}
              </div>
            )}

            <div className="form-grid">
              <label className="form-field form-field-wide" htmlFor="title">
                <span>Title <b aria-hidden="true">*</b></span>
                <small>A concise outcome or next action. This is the only content required for Inbox capture.</small>
                <input
                  ref={titleRef}
                  id="title"
                  value={draft.title}
                  onChange={(event) => update("title", event.target.value)}
                  aria-invalid={Boolean(errors.title)}
                  aria-describedby={errors.title ? "title-help title-error" : "title-help"}
                />
                <span id="title-help" className="sr-only">Required at capture time.</span>
                {fieldError(errors, "title")}
              </label>

              <label className="form-field" htmlFor="priority">
                <span>Priority</span>
                <small>Leave Unset when it has not been established.</small>
                <select id="priority" value={draft.priority} onChange={(event) => update("priority", event.target.value as Priority)}>
                  {priorities.map((value) => <option key={value}>{value}</option>)}
                </select>
              </label>

              <label className="form-field" htmlFor="status">
                <span>Workflow status</span>
                <small>
                  {item
                    ? "Use the server-permitted lifecycle actions in the inspector so guarded transitions collect their evidence."
                    : "New manual items start in Inbox; triage after creation."}
                </small>
                <select
                  id="status"
                  value={draft.status}
                  disabled
                  onChange={() => undefined}
                >
                  <option>{draft.status}</option>
                </select>
                {fieldError(errors, "status")}
              </label>

              <label className="form-field" htmlFor="effort">
                <span>Likely effort</span>
                <small>Use Unknown instead of guessing.</small>
                <select id="effort" value={draft.effort} onChange={(event) => update("effort", event.target.value as Effort)}>
                  {efforts.map((value) => <option key={value}>{value}</option>)}
                </select>
              </label>

              <label className="form-field" htmlFor="evidenceState">
                <span>Evidence state</span>
                <small>Describe how established the finding is.</small>
                <select id="evidenceState" value={draft.evidenceState} onChange={(event) => update("evidenceState", event.target.value as EvidenceState)}>
                  {evidenceStates.map((value) => <option key={value}>{value}</option>)}
                </select>
              </label>

              <label className="form-field" htmlFor="projectId">
                <span>Project</span>
                <select
                  id="projectId"
                  value={draft.projectId}
                  onChange={(event) => {
                    const nextProject = scopes.projects.find((candidate) => candidate.id === event.target.value);
                    const nextRepository = nextProject?.repositories[0];
                    setDraft((current) => ({
                      ...current,
                      projectId: event.target.value,
                      repositoryId: nextRepository?.id ?? "",
                      worktreeId: nextRepository?.worktrees[0]?.id ?? "",
                    }));
                  }}
                >
                  {scopes.projects.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}
                </select>
                {fieldError(errors, "projectId")}
              </label>

              <label className="form-field" htmlFor="repositoryId">
                <span>Repository</span>
                <select
                  id="repositoryId"
                  value={draft.repositoryId}
                  onChange={(event) => {
                    const nextRepository = repositories.find((candidate) => candidate.id === event.target.value);
                    setDraft((current) => ({
                      ...current,
                      repositoryId: event.target.value,
                      worktreeId: nextRepository?.worktrees[0]?.id ?? "",
                    }));
                  }}
                >
                  {repositories.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}
                </select>
                {fieldError(errors, "repositoryId")}
              </label>

              <label className="form-field" htmlFor="worktreeId">
                <span>Worktree</span>
                <select id="worktreeId" value={draft.worktreeId} onChange={(event) => update("worktreeId", event.target.value)}>
                  {worktrees.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}
                </select>
                {fieldError(errors, "worktreeId")}
              </label>

              <label className="form-field form-field-wide" htmlFor="finding">
                <span>Finding</span>
                <small>User-authored statement of what is known. Required only before Ready.</small>
                <textarea id="finding" rows={3} value={draft.finding} onChange={(event) => update("finding", event.target.value)} />
                {fieldError(errors, "finding")}
              </label>

              <label className="form-field form-field-wide" htmlFor="description">
                <span>Description</span>
                <small>Intended result or bounded next investigation. Required only before Ready.</small>
                <textarea id="description" rows={5} value={draft.description} onChange={(event) => update("description", event.target.value)} />
                {fieldError(errors, "description")}
              </label>

              <label className="form-field form-field-wide" htmlFor="research">
                <span>Research notes</span>
                <small>One Markdown note per line. Leave blank rather than inventing research.</small>
                <textarea id="research" rows={5} value={draft.researchText} onChange={(event) => update("researchText", event.target.value)} />
                {fieldError(errors, "research")}
              </label>

              <label className="form-field form-field-wide" htmlFor="validation">
                <span>Validation plan</span>
                <small>One check per line. At least one check is required before Ready.</small>
                <textarea id="validation" rows={5} value={draft.validationText} onChange={(event) => update("validationText", event.target.value)} />
                {fieldError(errors, "validation")}
              </label>

              <label className="form-field form-field-wide" htmlFor="tags">
                <span>Tags</span>
                <small>Comma-separated user-authored labels.</small>
                <input id="tags" value={draft.tagsText} onChange={(event) => update("tagsText", event.target.value)} />
                {fieldError(errors, "tags")}
              </label>

              <fieldset className="source-editor form-field-wide">
                <legend>User-added source references</legend>
                <p>Add only references you know. Imported evidence remains read-only outside this form.</p>
                {draft.userSources.map((source, index) => (
                  <div className="source-edit-row" key={index}>
                    <label>
                      <span>Type</span>
                      <select value={source.type} onChange={(event) => updateSource(index, "type", event.target.value)}>
                        {["File", "URL", "Command", "Commit", "Codex thread", "Text"].map((value) => <option key={value}>{value}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>Locator</span>
                      <input
                        id={`userSources.${index}.locator`}
                        value={source.locator}
                        onChange={(event) => updateSource(index, "locator", event.target.value)}
                        aria-label={`Source ${index + 1} locator`}
                        aria-invalid={Boolean(errors[`userSources.${index}.locator`])}
                      />
                      {fieldError(errors, `userSources.${index}.locator`)}
                    </label>
                    <label>
                      <span>Label</span>
                      <input
                        value={source.label ?? ""}
                        onChange={(event) => updateSource(index, "label", event.target.value)}
                        aria-label={`Source ${index + 1} label`}
                      />
                    </label>
                    <button
                      type="button"
                      className="remove-source"
                      onClick={() => update("userSources", draft.userSources.filter((_, sourceIndex) => sourceIndex !== index))}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {fieldError(errors, "userSources")}
                <button type="button" className="secondary-action" onClick={addSource}>Add source reference</button>
              </fieldset>

              {item?.immutableSourceEvidence.imported && (
                <div className="immutable-reminder form-field-wide">
                  <strong>Imported evidence is protected.</strong>
                  <p>
                    The original thread, file references, source ordinal, import key, hash, and raw source
                    are not editable here and are not included in this save request.
                  </p>
                </div>
              )}
            </div>
          </div>

          <footer className="dialog-footer">
            <span className="save-status" role="status" aria-live="polite">{formNotice}</span>
            <button type="button" className="secondary-action" onClick={requestClose} disabled={saving}>Cancel</button>
            <button type="submit" className="primary-action" disabled={saving}>
              {saving ? "Saving…" : item ? "Save changes" : "Create actionable"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export default function App() {
  const queryClient = useQueryClient();
  const listQuery = useQuery({
    queryKey: ["actionables"],
    queryFn: fetchActionables,
  });
  const scopesQuery = useQuery({
    queryKey: ["scopes"],
    queryFn: fetchScopeOptions,
  });
  const actionables = listQuery.data?.items ?? [];
  const totalFindings = listQuery.data?.counts.total ?? 0;
  const projectName = listQuery.data?.project.name ?? "MyStotz2023";
  const worktreeName = listQuery.data?.worktree.name ?? "CurrentSprint";

  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const match = window.location.pathname.match(/^\/actionables\/(\d+)\/?$/);
    return match ? Number(match[1]) : null;
  });
  const [search, setSearch] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("All");
  const [activeTab, setActiveTab] = useState<InspectorTab>("finding");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inspectorHidden, setInspectorHidden] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [expandedParents, setExpandedParents] = useState<Set<number>>(() => {
    try {
      return new Set<number>(JSON.parse(sessionStorage.getItem("expanded-actionable-parents") ?? "[]"));
    } catch {
      return new Set<number>();
    }
  });
  const [mobileDetailOpen, setMobileDetailOpen] = useState(
    () =>
      /^\/actionables\/\d+\/?$/.test(window.location.pathname) &&
      window.matchMedia("(max-width: 760px)").matches,
  );
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);

  useEffect(() => {
    const mobileViewport = window.matchMedia("(max-width: 900px)");
    const collapseSidebar = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) {
        setSidebarCollapsed(true);
      }
    };

    collapseSidebar(mobileViewport);
    mobileViewport.addEventListener("change", collapseSidebar);

    return () => mobileViewport.removeEventListener("change", collapseSidebar);
  }, []);
  useEffect(() => {
    sessionStorage.setItem("expanded-actionable-parents", JSON.stringify([...expandedParents]));
  }, [expandedParents]);
  useEffect(() => {
    const syncSelectionFromUrl = () => {
      const match = window.location.pathname.match(/^\/actionables\/(\d+)\/?$/);
      setSelectedId(match ? Number(match[1]) : actionables[0]?.id ?? null);
      setMobileDetailOpen(Boolean(match) && window.matchMedia("(max-width: 760px)").matches);
    };
    window.addEventListener("popstate", syncSelectionFromUrl);
    return () => window.removeEventListener("popstate", syncSelectionFromUrl);
  }, [actionables]);
  const [validationChecks, setValidationChecks] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (selectedId === null && actionables[0]) {
      setSelectedId(actionables[0].id);
    }
  }, [actionables, selectedId]);

  const detailQuery = useQuery({
    queryKey: ["actionable", selectedId],
    queryFn: () => fetchActionable(selectedId!),
    enabled: selectedId !== null,
  });
  const selected = detailQuery.data;

  const visibleRows = useMemo(() => {
    const matches = (item: ActionableSummary) => {
      const query = search.trim().toLowerCase();
      const matchesQuery = !query || `${item.title} ${item.finding} ${item.tags.join(" ")}`.toLowerCase().includes(query);
      const matchesPriority = priorityFilter === "All" || item.priority === priorityFilter;
      return matchesQuery && matchesPriority;
    };

    if (search.trim()) {
      return actionables
        .filter(matches)
        .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority] || a.id - b.id);
    }

    return actionables
      .filter((item) => !item.parentId && matches(item))
      .sort((a, b) => a.id - b.id)
      .flatMap((item) => {
        if (!item.childIds || !expandedParents.has(item.id)) return [item];
        const children = item.childIds
          .map((id) => actionables.find((candidate) => candidate.id === id))
          .filter((candidate): candidate is ActionableSummary => Boolean(candidate))
          .filter(matches);
        return [item, ...children];
      });
  }, [actionables, expandedParents, priorityFilter, search]);

  const selectRow = (item: ActionableSummary) => {
    setSelectedId(item.id);
    window.history.pushState({}, "", `/actionables/${item.id}`);
    setActiveTab("finding");
    setInspectorHidden(false);
    if (window.matchMedia("(max-width: 760px)").matches) setMobileDetailOpen(true);
  };

  const handleSaved = (saved: ActionableDetail, created: boolean) => {
    queryClient.setQueryData(["actionable", saved.id], saved);
    void queryClient.invalidateQueries({ queryKey: ["actionables"] });
    setSelectedId(saved.id);
    window.history.pushState({}, "", `/actionables/${saved.id}`);
    setActiveTab("finding");
    setInspectorHidden(false);
    setFormMode(null);
    setNotice(created ? "Actionable created and opened." : "Actionable changes saved.");
  };

  const handleMutated = (saved: ActionableDetail, mutationNotice: string) => {
    queryClient.setQueryData(["actionable", saved.id], saved);
    void queryClient.invalidateQueries({ queryKey: ["actionables"] });
    void queryClient.invalidateQueries({ queryKey: ["actionable"] });
    setNotice(mutationNotice);
  };

  const toggleParent = (id: number) => {
    setExpandedParents((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleValidation = (key: string) => {
    setValidationChecks((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const shellClasses = [
    "app-shell",
    sidebarCollapsed ? "sidebar-collapsed" : "",
    inspectorHidden ? "inspector-hidden" : "",
    mobileDetailOpen ? "mobile-detail-open" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={shellClasses}>
      <aside className="sidebar" aria-label="Projects and worktrees">
        <div className="product-bar">
          <span>Actionables</span>
          <IconButton label="Close project navigation" onClick={() => setSidebarCollapsed(true)}>
            <PanelLeftClose />
          </IconButton>
        </div>

        <div className="project-tree">
          <div className="tree-label">Projects</div>
          <div className="project-group">
            <button type="button" className="project-row">
              <ChevronDown aria-hidden="true" />
              <span>{projectName}</span>
              <Circle className="project-status" aria-hidden="true" />
            </button>
            <WorktreeRow
              name={worktreeName}
              count={totalFindings}
              selected
              onClick={() => setNotice(`Showing ${worktreeName} findings`)}
            />
          </div>

          <div className="tree-label secondary-label">Review focus</div>
          <button type="button" className="scope-row" onClick={() => setPriorityFilter("Critical")}>
            <span className="scope-dot critical" />
            Critical findings
            <span>{actionables.filter((item) => item.priority === "Critical").length}</span>
          </button>
          <button type="button" className="scope-row" onClick={() => setPriorityFilter("High")}>
            <span className="scope-dot high" />
            High priority
            <span>{actionables.filter((item) => item.priority === "High").length}</span>
          </button>
          <button type="button" className="scope-row" onClick={() => setPriorityFilter("All")}>
            <span className="scope-dot all" />
            All findings
            <span>{totalFindings}</span>
          </button>

          <button type="button" className="add-project" onClick={() => setNotice("Project creation is deferred until persistence work")}>
            <Plus aria-hidden="true" /> Add project
          </button>
        </div>

        <div className="sidebar-status">
          <span><CircleDot aria-hidden="true" /> Source loaded 2m ago</span>
          <ChevronDown aria-hidden="true" />
        </div>
      </aside>

      <header className="topbar">
        <div className="scope-selectors">
          <IconButton
            label={sidebarCollapsed ? "Open project navigation" : "Close project navigation"}
            onClick={() => setSidebarCollapsed((value) => !value)}
            pressed={!sidebarCollapsed}
            className="nav-toggle"
          >
            {sidebarCollapsed ? <PanelLeftOpen /> : <Menu />}
          </IconButton>
          <button type="button" className="selector-button">{projectName} <ChevronDown aria-hidden="true" /></button>
          <span className="topbar-divider" />
          <button type="button" className="selector-button mono" title={worktreeName}>
            <GitBranch aria-hidden="true" />{worktreeName} <ChevronDown aria-hidden="true" />
          </button>
        </div>

        <label className="global-search">
          <Search aria-hidden="true" />
          <span className="shortcut">⌘K</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search actionables..."
            aria-label="Search actionables"
          />
          {search && (
            <button type="button" aria-label="Clear search" onClick={() => setSearch("")}>
              <X aria-hidden="true" />
            </button>
          )}
        </label>

        <div className="topbar-actions">
          <button
            type="button"
            className="primary-action"
            onClick={() => {
              if (scopesQuery.data) setFormMode("create");
              else setNotice("Scope options are still loading.");
            }}
          >
            <Plus aria-hidden="true" /> New actionable
          </button>
          <div className="filter-wrap">
            <button type="button" className={`toolbar-button ${filterOpen ? "is-active" : ""}`} onClick={() => setFilterOpen((value) => !value)}>
              <SlidersHorizontal aria-hidden="true" /> Filters
              {priorityFilter !== "All" && <span className="filter-count">1</span>}
            </button>
            {filterOpen && (
              <div className="filter-popover">
                <span className="popover-label">Priority</span>
                {(["All", "Critical", "High", "Medium", "Low"] as PriorityFilter[]).map((priority) => (
                  <button
                    type="button"
                    className={priorityFilter === priority ? "is-selected" : ""}
                    key={priority}
                    onClick={() => {
                      setPriorityFilter(priority);
                      setFilterOpen(false);
                    }}
                  >
                    {priority}
                    {priorityFilter === priority && <CircleDot aria-hidden="true" />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <IconButton label="List view" pressed><List /></IconButton>
          <IconButton
            label={inspectorHidden ? "Show inspector" : "Hide inspector"}
            onClick={() => setInspectorHidden((value) => !value)}
            pressed={!inspectorHidden}
          >
            {inspectorHidden ? <PanelRightOpen /> : <PanelRightClose />}
          </IconButton>
          <IconButton label="Settings" onClick={() => setNotice("Settings are not part of this design checkpoint")}><Settings /></IconButton>
        </div>
      </header>

      <main className="findings-panel">
        <div className="findings-heading">
          <h1>Findings <span>{search || priorityFilter !== "All" ? visibleRows.length : totalFindings}</span></h1>
          {priorityFilter !== "All" && (
            <button type="button" className="active-filter" onClick={() => setPriorityFilter("All")}>
              {priorityFilter} <X aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="findings-table" role="table" aria-label="Actionable findings">
          <div className="table-header table-grid" role="row">
            <div role="columnheader">Finding</div>
            <button type="button" role="columnheader">Priority <ChevronDown aria-hidden="true" /></button>
            <button type="button" role="columnheader">Status <ChevronDown aria-hidden="true" /></button>
            <button type="button" role="columnheader">Worktree <ChevronDown aria-hidden="true" /></button>
            <button type="button" role="columnheader">Effort <ChevronDown aria-hidden="true" /></button>
            <button type="button" role="columnheader">Updated <ChevronDown aria-hidden="true" /></button>
          </div>

          <div className="table-body" role="rowgroup">
            {visibleRows.map((item) => {
              const selectedRow = item.id === selectedId;
              const isChild = Boolean(item.parentId);
              const expanded = expandedParents.has(item.id);
              const dependencyCount = item.unresolvedDependencyCount;

              return (
                <div
                  className={`finding-row table-grid ${selectedRow ? "is-selected" : ""} ${isChild ? "is-child" : ""}`}
                  role="row"
                  aria-selected={selectedRow}
                  tabIndex={0}
                  key={item.id}
                  onClick={() => selectRow(item)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") selectRow(item);
                  }}
                >
                  <div className="finding-cell" role="cell">
                    {item.childIds ? (
                      <button
                        type="button"
                        className="row-expander"
                        aria-label={`${expanded ? "Collapse" : "Expand"} subtasks for ${item.title}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleParent(item.id);
                        }}
                      >
                        {expanded ? <ChevronDown /> : <ChevronRight />}
                      </button>
                    ) : isChild ? <span className="child-guide" /> : <span className="row-spacer" />}
                    <span
                      className="finding-title truncate-reveal"
                      title={item.title}
                      data-full-text={item.title}
                      tabIndex={0}
                    >
                      {item.title}
                    </span>
                    {item.childCompletion && <span className="child-count">{item.childCompletion.terminal}/{item.childCompletion.total}</span>}
                    {dependencyCount > 0 && <span className="blocked-indicator" title={`Derived block: ${dependencyCount} unresolved prerequisite${dependencyCount > 1 ? "s" : ""}`}>Blocked by {dependencyCount}</span>}
                    {item.blocksCount > 0 && <span className="blocks-indicator">Blocks {item.blocksCount}</span>}
                  </div>
                  <div role="cell"><Badge tone={item.priority}>{item.priority}</Badge></div>
                  <div role="cell">
                    <Badge
                      tone={item.status}
                      title={item.statusProvenance.note}
                      ariaLabel={`${item.status}. ${item.statusProvenance.note}`}
                    >
                      {item.status}
                    </Badge>
                  </div>
                  <div
                    role="cell"
                    className="mono worktree-cell truncate-reveal"
                    title={item.worktree}
                    data-full-text={item.worktree}
                    tabIndex={0}
                  >
                    {item.worktree}
                  </div>
                  <div role="cell" className="effort-cell">{item.effort}</div>
                  <div role="cell" className="updated-cell">{item.updated}</div>
                </div>
              );
            })}
            {visibleRows.length === 0 && (
              <div className="empty-state">
                <Search aria-hidden="true" />
                <strong>
                  {listQuery.isPending
                    ? "Loading findings"
                    : listQuery.isError
                      ? "Could not load findings"
                      : "No matching findings"}
                </strong>
                <span>
                  {listQuery.isPending
                    ? "Reading the local Actionables database."
                    : listQuery.isError
                      ? "Confirm the local API is running."
                      : "Clear the search or priority filter."}
                </span>
              </div>
            )}
          </div>
        </div>

        <footer className="table-footer">
          <span>
            {selectedId !== null && visibleRows.some((item) => item.id === selectedId) ? "1" : "0"} selected
            {" · "}{visibleRows.length} visible {visibleRows.length === 1 ? "row" : "rows"}
          </span>
          <span>{search ? `Filtered from ${totalFindings}` : `${totalFindings} total findings`}</span>
        </footer>
      </main>

      <aside className="inspector" aria-label="Selected actionable">
        {selected ? (
          <Inspector
            selected={selected}
            actionables={actionables}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            onCloseMobile={() => {
              setMobileDetailOpen(false);
              window.history.pushState({}, "", "/");
            }}
            validationChecks={validationChecks}
            toggleValidation={toggleValidation}
            onEdit={() => setFormMode("edit")}
            onMutated={handleMutated}
            onNavigate={(id) => {
              const item = actionables.find((candidate) => candidate.id === id);
              if (item) selectRow(item);
            }}
            onNotice={setNotice}
          />
        ) : (
          <div className="inspector-loading" role="status">
            {detailQuery.isError ? "Could not load actionable details." : "Loading actionable details…"}
          </div>
        )}
      </aside>

      {sidebarCollapsed && (
        <button type="button" className="collapsed-brand" onClick={() => setSidebarCollapsed(false)} aria-label="Open project navigation">
          A
        </button>
      )}

      <div className="sr-only" aria-live="polite">{notice}</div>
      {formMode && scopesQuery.data && (formMode === "create" || selected) && (
        <ActionableForm
          key={formMode === "edit" && selected ? `edit-${selected.id}-${selected.version}` : "create"}
          item={formMode === "edit" ? selected : undefined}
          scopes={scopesQuery.data}
          onClose={() => setFormMode(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
