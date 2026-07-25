import {
  actionableDetailResponseSchema,
  actionablesListResponseSchema,
  problemDetailsSchema,
  scopeOptionsResponseSchema,
  type ActionableDetail,
  type ActionablesListResponse,
  type CreateDependencyRequest,
  type CreateSubtaskRequest,
  type CreateValidationRecordRequest,
  type CreateActionableRequest,
  type ProblemDetails,
  type DependencyActionRequest,
  type DetachParentRequest,
  type ScopeOptionsResponse,
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

export async function fetchActionables(): Promise<ActionablesListResponse> {
  return actionablesListResponseSchema.parse(await requestJson("/api/actionables"));
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
