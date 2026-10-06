import type { ReactNode } from "react";

export function Badge({
  children,
  tone,
  title,
  ariaLabel,
}: {
  children: ReactNode;
  tone: string;
  title?: string;
  ariaLabel?: string;
}) {
  return (
    <span
      className={`badge badge-${tone.toLowerCase().replaceAll(/\s+/g, "-")}`}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </span>
  );
}
