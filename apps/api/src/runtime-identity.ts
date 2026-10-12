import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  actionablesRuntimeIdentitySchema,
  type ActionablesRuntimeIdentity,
} from "@actionables/contracts";
import { sha256 } from "./portable-format.js";

/** Use Local Apps' release evidence; a checkout has no claimed release identity. */
export function createRuntimeIdentity(
  tools: unknown,
  workflow: string,
  directory = fileURLToPath(new URL("../../..", import.meta.url)),
): ActionablesRuntimeIdentity {
  let build: ActionablesRuntimeIdentity["build"] = null;
  try {
    const release = JSON.parse(
      readFileSync(resolve(directory, "release.json"), "utf8"),
    );
    const parsed = actionablesRuntimeIdentitySchema.shape.build.safeParse({
      releaseId: basename(directory),
      sourceCommit: release.commit,
    });
    if (parsed.success) build = parsed.data;
  } catch {
    // Missing or unreadable release evidence must not pretend to identify a build.
  }
  const contractHash = sha256(tools);
  const workflowHash = createHash("sha256")
    .update(workflow.replace(/\r\n/g, "\n").trim())
    .digest("hex");
  return actionablesRuntimeIdentitySchema.parse({
    build,
    contractHash,
    workflowHash,
    serverVersion: `0.1.0+${build?.releaseId ?? "unpackaged"}.${contractHash.slice(0, 12)}.${workflowHash.slice(0, 12)}`,
  });
}
