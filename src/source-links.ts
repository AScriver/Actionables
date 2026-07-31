import type { UserSourceReference } from "@actionables/contracts";
import { safeCodexThreadUrl } from "./codex-links";

export function safeSourceUrl(
  source: Pick<UserSourceReference, "type" | "locator">,
) {
  const value = source.locator.trim();
  try {
    const parsed = new URL(value);
    if (
      (source.type === "URL" || source.type === "Commit") &&
      (parsed.protocol === "https:" || parsed.protocol === "http:")
    ) {
      return value;
    }
  } catch {
    return null;
  }
  if (source.type === "Codex thread") return safeCodexThreadUrl(value);
  return null;
}

export function safeImportedSourceUrl(locator: string) {
  return safeSourceUrl({
    type: "Codex thread",
    locator,
  });
}
