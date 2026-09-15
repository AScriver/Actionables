import { z } from "zod";

/** Literal substitutions supported by the two Codex start-prompt templates. */
export const codexPromptVariables = {
  workItemId: "Governing top-level work item ID",
  taskId: "Selected task ID",
  taskTitle: "Selected task title, inserted as literal text",
  phaseAction: "Begin, resume, or continue wording for the recorded phase",
  splitInstructions: "Research splitting guidance beneath the selected task",
  implementationInstructions:
    "Ready checks and implementation or coordination-task finalization guidance",
} as const;

const variablePattern = /\{\{([^{}]*)\}\}/g;

/** Validate literal variables before a template can be saved or rendered. */
export const codexPromptTemplateSchema = z
  .string()
  .trim()
  .min(1)
  .max(20_000)
  .superRefine((template, context) => {
    const variables = [...template.matchAll(variablePattern)].map(
      (match) => match[1]!,
    );
    const remainder = template.replace(variablePattern, "");
    if (/\{\{\{|\}\}\}/.test(template) || /\{\{|\}\}/.test(remainder)) {
      context.addIssue({
        code: "custom",
        message:
          "Malformed template variable. Use {{variableName}} with a listed name.",
      });
    }
    for (const variable of new Set(variables)) {
      if (!Object.hasOwn(codexPromptVariables, variable)) {
        context.addIssue({
          code: "custom",
          message: `Unknown template variable: {{${variable}}}. Use a listed variable.`,
        });
      }
    }
    for (const required of ["workItemId", "taskId"]) {
      if (!variables.includes(required)) {
        context.addIssue({
          code: "custom",
          message: `Include {{${required}}} so the prompt identifies the correct work.`,
        });
      }
    }
  });

const truncationInstructions =
  "Before treating the bounded detail as complete, inspect `task.truncation.reconciliationGuidance`. If it is present, reconcile every supported implementation-critical field it names with `actionables.get_task_detail`: use the compact task version and claim token at offset 0, then pass `contentHash` with each `nextOffset` until null, concatenate `json` in order, and JSON-parse the complete value. On `VERSION_CONFLICT`, discard partial pages and restart from the current compact detail. Do not move the task forward or edit files until every named supported field has been reconciled; if guidance is absent, continue normally because any reported loss is noncritical to scope and planned validation.";
const composedToolInstructions =
  "After every Actionables MCP call in a composed sequence, inspect `isError`; if it is true, stop before reading success fields or issuing dependent mutations, preserve the structured error, and follow its recovery guidance.";
const readinessInstructions =
  "Before requesting Ready or moving Ready to In progress, inspect `readiness.requiredForReady` and `permittedTransitions` on the latest result. Supply every named missing finding, description, Research, or planned-validation field, and do not make the transition until the list is empty and the target is permitted.";
const splitRecordingInstructions =
  "Each implementation task must be a narrow, complete, independently verifiable vertical slice; do not split by technical layer, create adjacent cleanup, or duplicate scope. Record the split rationale, dependency notes, and validation boundary in the current task and every created task, and leave created tasks unclaimed in Inbox. Unless a dedicated relationship tool is available, record dependencies only as task notes and do not claim that dependency relationships were created.";

/** Default research wording; runtime variables preserve phase and hierarchy rules. */
export const defaultCodexResearchPrompt = `Use Actionables work item #{{workItemId}}. Claim task #{{taskId}} and {{phaseAction}} the Researching phase. Treat the task detail returned by the Actionables MCP as the authoritative task record for the description, finding, existing research, sources, file references, relationships, and planned validation. ${truncationInstructions} ${composedToolInstructions} Research this task before implementation, staying within its stated outcome and boundaries. Follow its named files and symbols, use targeted repository searches, inspect the directly relevant implementation path and only the callers, dependencies, conventions, and tests needed to understand it, and run focused read-only commands or reproductions to verify current behavior. Consult authoritative documentation only for technologies or contracts implicated by the task. {{splitInstructions}} ${splitRecordingInstructions} Record concrete requirements, current behavior or root cause, relevant file and symbol references, verified assumptions, remaining questions, risks, and a focused validation plan in the Actionable. Do not investigate or propose adjacent cleanup. Keep the task Researching until the evidence is sufficient to implement its stated scope confidently. ${readinessInstructions} Only move it to In progress before editing.`;

/** Default implementation wording, including validation, completion and handoff. */
export const defaultCodexImplementationPrompt = `Use Actionables work item #{{workItemId}}. Claim task #{{taskId}} and {{phaseAction}}. Use the task detail returned by the Actionables MCP as the authoritative source for the recorded finding, existing research, sources, file references, relationships, and planned validation. ${truncationInstructions} ${composedToolInstructions} {{implementationInstructions}}, preserve existing user modifications, run the planned validation, populate Resolution with the completed changes and important implementation decisions, record qualifying validation evidence, and only then move #{{taskId}} to Done; otherwise hand off with the blocker. If implementation uncovers a need for more investigation, return In progress directly to Researching with a meaningful reason.`;

/** Render a validated template once; inserted task text is never interpreted. */
export function renderCodexStartPrompt(
  task: {
    id: number;
    workItemId: number;
    title: string;
    parentId?: number;
    status: string;
    relationships: { subtasks: readonly unknown[] };
  },
  templates: { codexResearchPrompt: string; codexImplementationPrompt: string },
): string | null {
  const research = task.status === "Inbox" || task.status === "Researching";
  if (!research && task.status !== "Ready" && task.status !== "In progress")
    return null;
  const workItemId = task.workItemId;
  let implementation: string;
  if (task.relationships.subtasks.length > 0) {
    implementation =
      "Confirm this task remains the coordination record for its subtree; do not implement or duplicate any child task's scope. Use the child inventory to confirm every required descendant is terminal, and hand off with the coordination blocker if any remain nonterminal. ";
    if (task.status === "Ready")
      implementation +=
        "Otherwise move this task to In progress before finalizing it";
    else implementation += "Otherwise finalize this task";
  } else if (task.status === "Ready") {
    implementation =
      "Confirm the scope, then move the task to In progress before editing. Implement the stated outcome";
  } else {
    implementation =
      "Confirm the scope, continue implementing the stated outcome";
  }
  let phaseAction = "resume implementation from In progress";
  if (task.status === "Inbox") phaseAction = "begin";
  else if (task.status === "Researching") phaseAction = "resume";
  else if (task.status === "Ready") phaseAction = "continue from Ready";
  const values: Record<keyof typeof codexPromptVariables, string> = {
    workItemId: String(workItemId),
    taskId: String(task.id),
    taskTitle: task.title,
    phaseAction,
    splitInstructions: `If research establishes multiple independently implementable outcomes, keep this task as the coordination record and create the minimum necessary child task for every implementation slice beneath it; use #${workItemId} as \`workItemId\` and #${task.id} as \`parentId\` for each created task. Do not narrow the coordination task to an implementation slice. If the task has one outcome, do not split it.`,
    implementationInstructions: `${task.status === "Ready" ? `${readinessInstructions} ` : ""}${implementation}`,
  };
  const template = codexPromptTemplateSchema.parse(
    research
      ? templates.codexResearchPrompt
      : templates.codexImplementationPrompt,
  );
  return template.replace(
    variablePattern,
    (_, variable: keyof typeof values) => values[variable],
  );
}
