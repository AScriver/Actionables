import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { createRuntimeIdentity } from "../src/runtime-identity.js";

it("identifies changed contracts at the same endpoint and reuses only public release evidence", async () => {
  const directory = resolve(
    await mkdtemp(resolve(tmpdir(), "actionables-identity-")),
    "20261012-120840",
  );
  await mkdir(directory);
  const catalog = [
    {
      name: "read",
      inputSchema: { id: "number" },
      outputSchema: { value: "string" },
    },
  ];
  const original = createRuntimeIdentity(catalog, "workflow\r\n", directory);
  expect(original.build).toBeNull();
  expect(createRuntimeIdentity(catalog, "workflow\n", directory)).toEqual(
    original,
  );
  const changedInput = createRuntimeIdentity(
    [{ ...catalog[0], inputSchema: { id: "number", fields: "array" } }],
    "workflow",
    directory,
  );
  const changedOutput = createRuntimeIdentity(
    [{ ...catalog[0], outputSchema: { value: "number" } }],
    "workflow",
    directory,
  );
  for (const changed of [changedInput, changedOutput]) {
    expect(changed.contractHash).not.toBe(original.contractHash);
    expect(changed.serverVersion).not.toBe(original.serverVersion);
  }
  const changedWorkflow = createRuntimeIdentity(
    catalog,
    "revised workflow",
    directory,
  );
  expect(changedWorkflow.workflowHash).not.toBe(original.workflowHash);
  expect(changedWorkflow.contractHash).toBe(original.contractHash);
  expect(changedWorkflow.serverVersion).not.toBe(original.serverVersion);
  await writeFile(
    resolve(directory, "release.json"),
    JSON.stringify({
      commit: "a".repeat(40),
      source: "private-path",
      database: "private-database",
      token: "private-token",
    }),
  );
  const packaged = createRuntimeIdentity(catalog, "workflow", directory);
  expect(packaged.build).toEqual({
    releaseId: "20261012-120840",
    sourceCommit: "a".repeat(40),
  });
  expect(JSON.stringify(packaged)).not.toContain("private-");
  await writeFile(resolve(directory, "release.json"), "broken metadata");
  expect(
    createRuntimeIdentity(catalog, "workflow", directory).build,
  ).toBeNull();
});
