import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentIntegrationInstaller } from "../src/agent-integration.js";

const temporaryHomes: string[] = [];
const legacySkillPath = fileURLToPath(
  new URL("./fixtures/actionables-workflow-v1.md", import.meta.url),
);

async function temporaryHome() {
  const path = await mkdtemp(resolve(tmpdir(), "actionables-agent-home-"));
  temporaryHomes.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryHomes
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Actionables agent integration", () => {
  it("leaves both components uninstalled until explicitly selected", async () => {
    const installer = new AgentIntegrationInstaller({
      homeDirectory: await temporaryHome(),
    });

    await expect(installer.status()).resolves.toMatchObject({
      agentInstructions: { state: "missing", installed: false },
      skill: { state: "missing", installed: false },
    });
  });

  it("installs each component independently and is idempotent", async () => {
    const home = await temporaryHome();
    const instructionsPath = resolve(home, ".codex", "AGENTS.md");
    await mkdir(resolve(home, ".codex"), { recursive: true });
    await writeFile(instructionsPath, "# My existing instructions\n", "utf8");
    const installer = new AgentIntegrationInstaller({ homeDirectory: home });

    const instructionsResult = await installer.install({
      agentInstructions: true,
      skill: false,
    });
    expect(instructionsResult).toMatchObject({
      settings: {
        agentInstructions: { state: "installed", installed: true },
        skill: { state: "missing", installed: false },
      },
      results: [{ component: "agentInstructions", outcome: "installed" }],
    });
    const installedInstructions = await readFile(instructionsPath, "utf8");
    expect(installedInstructions).toContain("# My existing instructions");
    expect(installedInstructions).toContain("# Actionables coordination");

    const repeated = await installer.install({
      agentInstructions: true,
      skill: false,
    });
    expect(repeated.results).toEqual([
      {
        component: "agentInstructions",
        outcome: "already-installed",
        message: "Agent instructions were already installed; no file changed.",
      },
    ]);
    await expect(readFile(instructionsPath, "utf8")).resolves.toBe(
      installedInstructions,
    );

    const skillResult = await installer.install({
      agentInstructions: false,
      skill: true,
    });
    expect(skillResult.settings).toMatchObject({
      agentInstructions: { installed: true },
      skill: { state: "installed", installed: true },
    });
    await expect(
      readFile(
        resolve(home, ".agents", "skills", "actionables-workflow", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("name: actionables-workflow");
  });

  it("preflights user-modified files and writes nothing on conflict", async () => {
    const home = await temporaryHome();
    const skillPath = resolve(
      home,
      ".agents",
      "skills",
      "actionables-workflow",
      "SKILL.md",
    );
    await mkdir(resolve(skillPath, ".."), { recursive: true });
    await writeFile(skillPath, "my customized workflow\n", "utf8");
    const installer = new AgentIntegrationInstaller({ homeDirectory: home });

    await expect(
      installer.install({ agentInstructions: true, skill: true }),
    ).rejects.toMatchObject({
      code: "AGENT_INTEGRATION_CONFLICT",
      conflicts: [expect.objectContaining({ id: "skill", state: "modified" })],
    });
    await expect(readFile(skillPath, "utf8")).resolves.toBe(
      "my customized workflow\n",
    );
    await expect(
      readFile(resolve(home, ".codex", "AGENTS.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("updates a known unmodified older skill only when selected", async () => {
    const home = await temporaryHome();
    const skillPath = resolve(
      home,
      ".agents",
      "skills",
      "actionables-workflow",
      "SKILL.md",
    );
    const legacySkill = await readFile(legacySkillPath, "utf8");
    await mkdir(resolve(skillPath, ".."), { recursive: true });
    await writeFile(skillPath, legacySkill, "utf8");
    const installer = new AgentIntegrationInstaller({ homeDirectory: home });

    await expect(installer.status()).resolves.toMatchObject({
      skill: { state: "outdated", installed: false },
    });
    await expect(readFile(skillPath, "utf8")).resolves.toBe(legacySkill);

    const result = await installer.install({
      agentInstructions: false,
      skill: true,
    });

    expect(result).toMatchObject({
      settings: { skill: { state: "installed", installed: true } },
      results: [{ component: "skill", outcome: "updated" }],
    });
    await expect(readFile(skillPath, "utf8")).resolves.toContain(
      "## Lifecycle accountability",
    );
  });

  it("does not replace a customized older skill", async () => {
    const home = await temporaryHome();
    const skillPath = resolve(
      home,
      ".agents",
      "skills",
      "actionables-workflow",
      "SKILL.md",
    );
    const customized = `${await readFile(legacySkillPath, "utf8")}\n# My customization\n`;
    await mkdir(resolve(skillPath, ".."), { recursive: true });
    await writeFile(skillPath, customized, "utf8");
    const installer = new AgentIntegrationInstaller({ homeDirectory: home });

    await expect(installer.status()).resolves.toMatchObject({
      skill: { state: "modified", installed: false },
    });
    await expect(
      installer.install({ agentInstructions: false, skill: true }),
    ).rejects.toMatchObject({
      code: "AGENT_INTEGRATION_CONFLICT",
      conflicts: [expect.objectContaining({ id: "skill", state: "modified" })],
    });
    await expect(readFile(skillPath, "utf8")).resolves.toBe(customized);
  });

  it("does not replace a user-edited managed instructions section", async () => {
    const home = await temporaryHome();
    const instructionsPath = resolve(home, ".codex", "AGENTS.md");
    const customized = [
      "# Personal instructions",
      "",
      "<!-- actionables-agent-instructions:start -->",
      "# My customized Actionables workflow",
      "<!-- actionables-agent-instructions:end -->",
      "",
    ].join("\n");
    await mkdir(resolve(home, ".codex"), { recursive: true });
    await writeFile(instructionsPath, customized, "utf8");
    const installer = new AgentIntegrationInstaller({ homeDirectory: home });

    await expect(
      installer.install({ agentInstructions: true, skill: false }),
    ).rejects.toMatchObject({
      code: "AGENT_INTEGRATION_CONFLICT",
      conflicts: [
        expect.objectContaining({
          id: "agentInstructions",
          state: "modified",
        }),
      ],
    });
    await expect(readFile(instructionsPath, "utf8")).resolves.toBe(customized);
  });
});
