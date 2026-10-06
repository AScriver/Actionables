import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@modelcontextprotocol/ext-apps";
import {
  actionableReviewPageSchema,
  reviewContentSchema,
  reviewFieldSchema,
  type ActionableReviewPage,
  type ReviewContent,
  type ReviewItem,
} from "@actionables/contracts/chatgpt";
import { Markdown } from "./Markdown";
import { Badge } from "./Badge";
import { actionablesErrorResponseSchema } from "@actionables/contracts";
import "./chatgpt-review.css";

const bridge = new App(
  { name: "Actionable review", version: "0.1.0" },
  {},
  { autoResize: true },
);
type ReviewField = keyof ReviewContent;

/** Reassemble labeled native content; never parse task prose as JSON or HTML. */
function contentFrom(items: ReviewItem[]): Partial<ReviewContent> {
  const raw: Partial<Record<ReviewField, unknown[]>> = {};
  for (const item of items) {
    const values = (raw[item.field] ??= []);
    if (item.kind === "value") {
      values[item.index] = structuredClone(item.value);
      continue;
    }
    let existing: unknown;
    if (item.property) {
      const value = values[item.index];
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Incomplete review value.");
      existing = (value as Record<string, unknown>)[item.property];
      if (item.offset !== String(existing ?? "").length)
        throw new Error("Out-of-order review text.");
      (value as Record<string, unknown>)[item.property] =
        String(existing ?? "") + item.text;
    } else {
      existing = values[item.index];
      if (item.offset !== String(existing ?? "").length)
        throw new Error("Out-of-order review text.");
      values[item.index] = String(existing ?? "") + item.text;
    }
  }
  const content: Partial<ReviewContent> = {};
  for (const field of reviewFieldSchema.options) {
    if (raw[field] === undefined) continue;
    const result = reviewContentSchema.shape[field].safeParse(raw[field]);
    if (result.success) Object.assign(content, { [field]: result.data });
  }
  return content;
}

function date(value: string) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function Review() {
  const [page, setPage] = useState<ActionableReviewPage | null>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const current = useRef<ActionableReviewPage | null>(null);
  const identity = useRef<{ id: number; includeArchived: boolean } | null>(
    null,
  );
  const generation = useRef(0);
  const pending = useRef(false);

  function receive(
    result: {
      isError?: boolean;
      structuredContent?: unknown;
      content?: Array<{ type: string; text?: string }>;
    },
    continuation = false,
  ) {
    if (result.isError) {
      let payload = result.structuredContent;
      if (!payload) {
        try {
          payload = JSON.parse(
            result.content?.find((item) => item.type === "text")?.text ?? "{}",
          );
        } catch {
          /* Protocol errors may be plain text. */
        }
      }
      const parsedError = actionablesErrorResponseSchema.safeParse(payload);
      const code = parsedError.success
        ? parsedError.data.code
        : (payload as { code?: string } | undefined)?.code;
      if (code === "VERSION_CONFLICT") {
        setError(
          "This review changed. Reload the current version before continuing.",
        );
        current.current = null;
        setPage(null);
        setItems([]);
      } else if (code === "NOT_FOUND") {
        setError("The requested Actionable was not found.");
      } else if (code === "ARCHIVE_INCLUSION_REQUIRED") {
        setError(
          "This Actionable or its root is archived. Ask ChatGPT to include archived context explicitly.",
        );
      } else {
        setError("The review could not be loaded. Retry the read.");
      }
      if (!continuation) {
        current.current = null;
        setPage(null);
        setItems([]);
      }
      return;
    }
    const parsed = actionableReviewPageSchema.safeParse(
      result.structuredContent,
    );
    if (!parsed.success) {
      setError("The host returned an unsupported review result.");
      return;
    }
    const next = parsed.data;
    const previous = current.current;
    if (
      continuation &&
      (!previous ||
        next.summary.id !== previous.summary.id ||
        next.summary.version !== previous.summary.version ||
        next.contentHash !== previous.contentHash ||
        next.offset !== previous.nextOffset)
    ) {
      receive(
        { isError: true, structuredContent: { code: "VERSION_CONFLICT" } },
        true,
      );
      return;
    }
    identity.current = {
      id: next.summary.id,
      includeArchived: next.includeArchived,
    };
    current.current = next;
    setPage(next);
    setItems((existing) =>
      continuation ? [...existing, ...next.items] : next.items,
    );
    setError("");
  }

  useEffect(() => {
    bridge.addEventListener("toolinput", ({ arguments: input }) => {
      generation.current += 1;
      pending.current = false;
      setBusy(false);
      current.current = null;
      identity.current = null;
      setPage(null);
      setItems([]);
      setError("");
      if (
        typeof input?.id === "number" &&
        Number.isSafeInteger(input.id) &&
        input.id > 0
      )
        identity.current = {
          id: input.id,
          includeArchived: input.includeArchived === true,
        };
    });
    bridge.addEventListener("toolresult", (result) => {
      generation.current += 1;
      pending.current = false;
      setBusy(false);
      receive(result);
    });
    bridge.addEventListener("toolcancelled", () =>
      setError("The review request was cancelled."),
    );
    bridge
      .connect()
      .then(() => setReady(true))
      .catch(() => setError("The review could not connect to its host."));
    // One iframe owns one bridge; no task content is persisted in browser storage.
    return () => {
      void bridge.close();
    };
  }, []);

  async function read(continuation: boolean) {
    if (!ready || pending.current || !identity.current) return;
    const previous = current.current;
    if (continuation && (previous?.nextOffset === null || !previous)) return;
    const requestGeneration = generation.current;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await bridge.callServerTool({
        name: "actionables.get_actionable",
        arguments: {
          ...identity.current,
          ...(continuation && previous
            ? {
                version: previous.summary.version,
                contentHash: previous.contentHash,
                offset: previous.nextOffset,
              }
            : {}),
        },
      });
      if (requestGeneration === generation.current)
        receive(result, continuation);
    } catch {
      if (requestGeneration === generation.current)
        setError(
          "The review read failed. Retry when the connection is available.",
        );
    } finally {
      if (requestGeneration === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  let content: Partial<ReviewContent> = {};
  try {
    content = contentFrom(items);
  } catch {
    /* Invalid partial data is withheld. */
  }
  const summary = page?.summary;
  function section(
    title: string,
    field: ReviewField,
    children: ReactNode,
    open = false,
  ) {
    const count = page?.fieldCounts[field];
    let fallback = "This section has not been loaded yet.";
    if (count === 0) fallback = "Nothing recorded.";
    return (
      <details open={open}>
        <summary>{title}</summary>
        {content[field]?.length ? (
          children
        ) : (
          <p className="muted">{fallback}</p>
        )}
      </details>
    );
  }
  const prose = (
    field: "finding" | "description" | "manualBlocker" | "resolution",
  ) => <Markdown inert>{content[field]?.[0] || "Nothing recorded."}</Markdown>;
  const references = (field: "root" | "parent" | "subtasks") => (
    <ul>
      {content[field]?.map((task) => (
        <li key={task.id}>
          #{task.id} · {task.title}{" "}
          <Badge tone={task.status}>{task.status}</Badge>
          {task.archiveState.isArchived && (
            <Badge tone="Dismissed">Archived</Badge>
          )}
        </li>
      ))}
    </ul>
  );
  const dependencies = (field: "blockedBy" | "blocks") => (
    <ul>
      {content[field]?.map((task, index) => (
        <li key={`${task.id}-${index}`}>
          #{task.id} · {task.title}{" "}
          <Badge tone={task.status}>{task.status}</Badge>{" "}
          <strong>{task.state}</strong>
          {task.waiverReason && <Markdown inert>{task.waiverReason}</Markdown>}
        </li>
      ))}
    </ul>
  );
  return (
    <main aria-label="Actionable review">
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {!summary && !error && (
        <p role="status">Waiting for the Actionable review…</p>
      )}
      {summary && (
        <>
          <header>
            <p className="eyebrow">Actionable #{summary.id} · Read-only</p>
            <h1>{content.title?.[0] ?? summary.title}</h1>
            <div className="badges">
              <Badge tone={summary.status}>{summary.status}</Badge>
              <Badge tone={summary.priority}>{summary.priority} priority</Badge>
              {summary.archiveState.isArchived && (
                <Badge tone="Dismissed">
                  Archived {summary.archiveState.inheritedFrom.join(", ")}
                </Badge>
              )}
            </div>
            <p className="muted">
              {(content.scope?.[0] ?? summary.scope).projectName} /{" "}
              {(content.scope?.[0] ?? summary.scope).repositoryName} /{" "}
              {(content.scope?.[0] ?? summary.scope).worktreeName}
            </p>
            <p className="muted">
              Version {summary.version} · Updated {date(summary.updatedAt)}
            </p>
          </header>
          {!page.complete && (
            <p role="status" className="notice">
              Partial context · {page.remainingItems} content items remain.
              Sections may be incomplete.
            </p>
          )}
          {section("Finding", "finding", prose("finding"), true)}
          {section("Description", "description", prose("description"), true)}
          <details open>
            <summary>Hierarchy</summary>
            <p>Work item #{summary.workItemId}</p>
            {section("Root", "root", references("root"))}
            {section("Parent", "parent", references("parent"))}
            {section(
              "Direct children",
              "subtasks",
              references("subtasks"),
              true,
            )}
            {summary.directTaskProgress && (
              <p>
                All descendants: {summary.directTaskProgress.total} total ·{" "}
                {summary.directTaskProgress.completed} Done ·{" "}
                {summary.directTaskProgress.dismissed} Dismissed ·{" "}
                {summary.directTaskProgress.open} open ·{" "}
                {summary.directTaskProgress.blocked} blocked ·{" "}
                {summary.directTaskProgress.validationReady} with qualifying
                validation
              </p>
            )}
          </details>
          <details open>
            <summary>Blockers and dependencies</summary>
            <p>
              Effectively blocked: {String(summary.isEffectivelyBlocked)} ·
              Dependency blocked: {String(summary.isDependencyBlocked)} ·{" "}
              {summary.unresolvedDependencyCount} unresolved prerequisites
            </p>
            {section("Manual blocker", "manualBlocker", prose("manualBlocker"))}
            {section(
              "Prerequisites",
              "blockedBy",
              dependencies("blockedBy"),
              true,
            )}
            {section("Blocks", "blocks", dependencies("blocks"))}
          </details>
          <details open>
            <summary>Validation and readiness</summary>
            <p>
              Ready requirements:{" "}
              {summary.readiness.requiredForReady.join(", ") || "None"}
            </p>
            <ul>
              {summary.readiness.blockers.map((blocker) => (
                <li key={blocker.field}>{blocker.message}</li>
              ))}
            </ul>
            <p>
              Qualifying validation:{" "}
              {summary.completionEligibility.qualifyingValidationRecordId ??
                "None"}
            </p>
            <p className="muted">{summary.completionEligibility.policy}</p>
            {section(
              "Planned validation",
              "plannedValidation",
              <ul>
                {content.plannedValidation?.map((text, index) => (
                  <li key={index}>
                    <Markdown inert>{text}</Markdown>
                  </li>
                ))}
              </ul>,
            )}
            {section(
              "Validation records",
              "validationRecords",
              <ul>
                {content.validationRecords?.map((record) => (
                  <li key={record.id}>
                    <strong>
                      {record.type} · {record.outcome}
                    </strong>{" "}
                    · {date(record.recordedAt)}
                    {record.qualifiesForCompletion && (
                      <Badge tone="Passed">Qualifies for completion</Badge>
                    )}
                    {record.supersededById && (
                      <Badge tone="Dismissed">Superseded</Badge>
                    )}
                    {record.supersedesId && (
                      <p className="muted">Corrects {record.supersedesId}</p>
                    )}
                    <Markdown inert>{record.notes}</Markdown>
                    <Markdown inert>{record.evidence}</Markdown>
                  </li>
                ))}
              </ul>,
              true,
            )}
          </details>
          {section("Resolution", "resolution", prose("resolution"))}
          {section(
            "Research",
            "research",
            <ol>
              {content.research?.map((text, index) => (
                <li key={index}>
                  <Markdown inert>{text}</Markdown>
                </li>
              ))}
            </ol>,
          )}
          {section(
            "Status history",
            "statusHistory",
            <ul>
              {content.statusHistory?.map((entry) => (
                <li key={entry.id}>
                  {entry.previousStatus ?? "Created"} → {entry.newStatus} ·{" "}
                  {date(entry.occurredAt)} · {entry.origin}
                </li>
              ))}
            </ul>,
          )}
          {section(
            "Activity",
            "activity",
            <ul>
              {content.activity?.map((event) => (
                <li key={event.id}>
                  <Markdown inert>{event.summary}</Markdown>
                  <span className="muted">
                    {event.type} · {date(event.occurredAt)}
                  </span>
                </li>
              ))}
            </ul>,
          )}
          <p className="muted privacy">
            Source paths, raw imports and ownership metadata are excluded.
            Review text can contain private information.
          </p>
        </>
      )}
      <footer>
        {page && !page.complete && (
          <button
            type="button"
            className="primary-action"
            disabled={!ready || busy}
            onClick={() => void read(true)}
          >
            {busy ? "Loading…" : "Load remaining context"}
          </button>
        )}
        {identity.current && (
          <button
            type="button"
            className="toolbar-button"
            disabled={!ready || busy}
            onClick={() => void read(false)}
          >
            Reload review
          </button>
        )}
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Review />);
