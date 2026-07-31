const codexThreadsUrl = "codex://threads/";

export const codexSkillsUrl = "codex://skills";

function safeWorkspacePath(value?: string | null) {
  const path = value?.trim();
  return path && /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(path) ? path : null;
}

function canonicalThreadId(value: string) {
  const threadId = value.trim();
  if (
    !threadId ||
    threadId === "new" ||
    threadId === "." ||
    threadId === ".." ||
    /[/?#\\]/.test(threadId)
  ) {
    return null;
  }
  return threadId;
}

export function buildCodexNewChatUrl(prompt: string, path?: string | null) {
  const url = new URL(`${codexThreadsUrl}new`);
  url.searchParams.set("prompt", prompt);
  const workspacePath = safeWorkspacePath(path);
  if (workspacePath) url.searchParams.set("path", workspacePath);
  return url.href;
}

export function buildCodexThreadUrl(threadId: string) {
  const canonical = canonicalThreadId(threadId);
  return canonical
    ? `${codexThreadsUrl}${encodeURIComponent(canonical)}`
    : null;
}

export function codexThreadUrlFromAgentId(agentId: string) {
  return agentId.startsWith("codex:")
    ? buildCodexThreadUrl(agentId.slice("codex:".length))
    : null;
}

export function safeCodexThreadUrl(value: string) {
  const trimmed = value.trim();
  const match = /^codex:\/\/threads\/([^/?#]+)$/.exec(trimmed);
  if (!match) return null;

  try {
    const canonical = buildCodexThreadUrl(decodeURIComponent(match[1]!));
    return canonical === trimmed ? canonical : null;
  } catch {
    return null;
  }
}
