import {
  actionableDetailResponseSchema,
  actionablesListResponseSchema,
  archiveImpactResponseSchema,
  dashboardResponseSchema,
  problemDetailsSchema,
  scopeOptionsResponseSchema,
  importCommitResponseSchema,
  importPreviewResponseSchema,
  prepareImportCommitResponseSchema,
  type ActionableDetail,
  type ActionableQuery,
  type ActionablesListResponse,
  type ArchiveImpactResponse,
  type ArchiveTargetKind,
  type CreateDependencyRequest,
  type CreateSubtaskRequest,
  type CreateValidationRecordRequest,
  type CreateActionableRequest,
  type ProblemDetails,
  type DependencyActionRequest,
  type DetachParentRequest,
  type ScopeOptionsResponse,
  type DashboardResponse,
  type ImportCommitResponse,
  type ImportPreviewResponse,
  type PortableDocument,
  type PrepareImportCommitRequest,
  type PrepareImportCommitResponse,
  type StatusTransitionRequest,
  type SetParentRequest,
  type UpdateActionableRequest,
} from "@actionables/contracts";

export class ApiProblem extends Error {
  constructor(public readonly problem: ProblemDetails) {
    super(problem.title);
  }
}

async function requestJson(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = await response.json();

  if (!response.ok) {
    const parsed = problemDetailsSchema.safeParse(payload);
    if (parsed.success) throw new ApiProblem(parsed.data);
    throw new Error(`Request failed with ${response.status}.`);
  }

  return payload;
}

function queryString(query: Partial<Record<keyof ActionableQuery, string>>) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const text = params.toString();
  return text ? `?${text}` : "";
}

export async function fetchActionables(
  query: Partial<Record<keyof ActionableQuery, string>> = {},
): Promise<ActionablesListResponse> {
  return actionablesListResponseSchema.parse(
    await requestJson(`/api/actionables${queryString(query)}`),
  );
}

export async function fetchActionable(id: number): Promise<ActionableDetail> {
  const response = actionableDetailResponseSchema.parse(
    await requestJson(`/api/actionables/${id}`),
  );
  return response.item;
}

export async function fetchScopeOptions(): Promise<ScopeOptionsResponse> {
  return scopeOptionsResponseSchema.parse(await requestJson("/api/scopes"));
}

export async function fetchDashboard(
  query: Pick<Partial<Record<keyof ActionableQuery, string>>, "project" | "repository" | "worktree">,
): Promise<DashboardResponse> {
  return dashboardResponseSchema.parse(
    await requestJson(`/api/dashboard${queryString(query)}`),
  );
}

export async function fetchArchiveImpact(
  kind: ArchiveTargetKind,
  id: string | number,
): Promise<ArchiveImpactResponse> {
  return archiveImpactResponseSchema.parse(
    await requestJson(`/api/archive-impact/${kind}/${encodeURIComponent(String(id))}`),
  );
}

export async function setActionableArchived(
  id: number,
  version: number,
  archived: boolean,
): Promise<ActionableDetail> {
  const response = actionableDetailResponseSchema.parse(
    await requestJson(`/api/actionables/${id}/${archived ? "archive" : "restore"}`, {
      method: "POST",
      body: JSON.stringify({ version }),
    }),
  );
  return response.item;
}

export async function setScopeArchived(
  kind: Exclude<ArchiveTargetKind, "actionable">,
  id: string,
  version: number,
  archived: boolean,
): Promise<ScopeOptionsResponse> {
  return scopeOptionsResponseSchema.parse(
    await requestJson(`/api/scopes/${kind}/${encodeURIComponent(id)}/${archived ? "archive" : "restore"}`, {
      method: "POST",
      body: JSON.stringify({ version }),
    }),
  );
}

export async function createActionable(
  input: CreateActionableRequest,
): Promise<ActionableDetail> {
  const response = actionableDetailResponseSchema.parse(
    await requestJson("/api/actionables", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
  return response.item;
}

export async function updateActionable(
  id: number,
  input: UpdateActionableRequest,
): Promise<ActionableDetail> {
  const response = actionableDetailResponseSchema.parse(
    await requestJson(`/api/actionables/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
  return response.item;
}

export async function transitionActionable(
  id: number,
  input: StatusTransitionRequest,
): Promise<ActionableDetail> {
  const response = actionableDetailResponseSchema.parse(
    await requestJson(`/api/actionables/${id}/status-transitions`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
  return response.item;
}

export async function recordValidation(
  id: number,
  input: CreateValidationRecordRequest,
): Promise<ActionableDetail> {
  const response = actionableDetailResponseSchema.parse(
    await requestJson(`/api/actionables/${id}/validation-records`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
  return response.item;
}

async function relationshipRequest(path: string, method: string, input: unknown) {
  const response = actionableDetailResponseSchema.parse(
    await requestJson(path, { method, body: JSON.stringify(input) }),
  );
  return response.item;
}

export const createSubtask = (id: number, input: CreateSubtaskRequest) =>
  relationshipRequest(`/api/actionables/${id}/subtasks`, "POST", input);

export const setParent = (id: number, input: SetParentRequest) =>
  relationshipRequest(`/api/actionables/${id}/parent`, "PUT", input);

export const detachParent = (id: number, input: DetachParentRequest) =>
  relationshipRequest(`/api/actionables/${id}/parent`, "DELETE", input);

export const createDependency = (id: number, input: CreateDependencyRequest) =>
  relationshipRequest(`/api/actionables/${id}/dependencies`, "POST", input);

export const removeDependency = (
  id: number,
  relationshipId: string,
  input: DependencyActionRequest,
) => relationshipRequest(`/api/actionables/${id}/dependencies/${relationshipId}`, "DELETE", input);

export const waiveDependency = (
  id: number,
  relationshipId: string,
  input: DependencyActionRequest,
) => relationshipRequest(`/api/actionables/${id}/dependencies/${relationshipId}/waive`, "POST", input);

export const restoreDependency = (
  id: number,
  relationshipId: string,
  input: DependencyActionRequest,
) => relationshipRequest(`/api/actionables/${id}/dependencies/${relationshipId}/restore`, "POST", input);

export async function previewPortableImport(
  document: unknown,
): Promise<ImportPreviewResponse> {
  return importPreviewResponseSchema.parse(
    await requestJson("/api/data/import-previews", {
      method: "POST",
      body: JSON.stringify(document),
    }),
  );
}

export async function preparePortableImport(
  previewToken: string,
  input: PrepareImportCommitRequest,
): Promise<PrepareImportCommitResponse> {
  return prepareImportCommitResponseSchema.parse(
    await requestJson(
      `/api/data/import-previews/${encodeURIComponent(previewToken)}/selections`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  );
}

export async function commitPortableImport(
  previewToken: string,
  input: {
    contentDigest: string;
    commitToken: string;
    selectionsDigest: string;
  },
): Promise<ImportCommitResponse> {
  return importCommitResponseSchema.parse(
    await requestJson(
      `/api/data/import-previews/${encodeURIComponent(previewToken)}/commit`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  );
}

export async function downloadPortableExport(): Promise<{
  document: PortableDocument;
  filename: string;
}> {
  const response = await fetch("/api/data/export", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    const payload = await response.json();
    const parsed = problemDetailsSchema.safeParse(payload);
    if (parsed.success) throw new ApiProblem(parsed.data);
    throw new Error(`Export failed with ${response.status}.`);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename =
    disposition.match(/filename="([^"]+)"/)?.[1] ??
    "actionables-backup.json";
  return {
    document: (await response.json()) as PortableDocument,
    filename,
  };
}
