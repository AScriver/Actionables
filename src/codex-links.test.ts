import { describe, expect, it } from "vitest";
import {
  buildCodexNewChatUrl,
  buildCodexThreadUrl,
  codexThreadUrlFromAgentId,
  safeCodexThreadUrl,
} from "./codex-links";
import { safeImportedSourceUrl, safeSourceUrl } from "./source-links";

describe("Codex desktop links", () => {
  it("encodes prepared-chat prompt and path values", () => {
    const href = buildCodexNewChatUrl(
      "Review #12 & wait?",
      "C:\\Code\\Actionables & More",
    );
    const parsed = new URL(href);

    expect(`${parsed.protocol}//${parsed.hostname}${parsed.pathname}`).toBe(
      "codex://threads/new",
    );
    expect(parsed.searchParams.get("prompt")).toBe("Review #12 & wait?");
    expect(parsed.searchParams.get("path")).toBe(
      "C:\\Code\\Actionables & More",
    );
  });

  it("constructs canonical existing-thread links without assuming UUIDs", () => {
    expect(buildCodexThreadUrl("thread.with-symbols_123")).toBe(
      "codex://threads/thread.with-symbols_123",
    );
    expect(buildCodexThreadUrl("thread:id")).toBe(
      "codex://threads/thread%3Aid",
    );
    expect(codexThreadUrlFromAgentId("codex:thread-id")).toBe(
      "codex://threads/thread-id",
    );
    expect(codexThreadUrlFromAgentId("agent:legacy")).toBeNull();
  });

  it.each([
    "codex://threads/thread-id",
    "codex://threads/thread.with-symbols_123",
    "codex://threads/thread%3Aid",
  ])("accepts canonical existing-thread link %s", (value) => {
    expect(safeCodexThreadUrl(value)).toBe(value);
  });

  it.each([
    "codex://threads/new",
    "codex://threads/",
    "codex://threads/id/extra",
    "codex://threads/id?prompt=x",
    "codex://threads/id#fragment",
    "codex://user@threads/id",
    "codex://threads:123/id",
    "codex://threads/../../settings",
    "codex://threads/%2Fsettings",
    "codex://settings",
    "codex://plugins/example",
    "codex:internal",
    "CODEx://threads/id",
    "https://example.test/thread",
    "not a URL",
  ])("rejects non-canonical existing-thread value %s", (value) => {
    expect(safeCodexThreadUrl(value)).toBeNull();
  });

  it("uses the strict thread boundary for user and imported sources", () => {
    expect(
      safeSourceUrl({
        type: "Codex thread",
        locator: "codex://threads/thread-id",
      }),
    ).toBe("codex://threads/thread-id");
    expect(
      safeSourceUrl({
        type: "Codex thread",
        locator: "codex://settings",
      }),
    ).toBeNull();
    expect(safeImportedSourceUrl("codex://threads/new")).toBeNull();
    expect(
      safeSourceUrl({ type: "URL", locator: "https://example.test/evidence" }),
    ).toBe("https://example.test/evidence");
  });
});
