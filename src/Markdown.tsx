import { lazy, Suspense } from "react";

const MarkdownRenderer = lazy(() => import("./MarkdownRenderer"));

const markdownProtocols = new Set(["http:", "https:", "mailto:"]);

export function safeMarkdownUrl(url: string) {
  const value = url.trim();
  if (
    value.startsWith("#") ||
    /^\/(?!\/)/.test(value) ||
    /^\.\.?\/(?!\/)/.test(value)
  ) {
    return value;
  }
  try {
    const parsed = new URL(value);
    return markdownProtocols.has(parsed.protocol) ? value : "";
  } catch {
    return "";
  }
}

export function Markdown({
  children,
  inline = false,
}: {
  children: string;
  inline?: boolean;
}) {
  if (!children.trim()) return null;
  return (
    <div className={`markdown ${inline ? "markdown-inline" : ""}`}>
      <Suspense fallback={<span className="markdown-loading">Loading formatted text…</span>}>
        <MarkdownRenderer value={children} transformUrl={safeMarkdownUrl} />
      </Suspense>
    </div>
  );
}
