import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentIntegrationInstaller,
  reconcileCodexMcpConfig,
  reconcileCodexMcpConfigAtStartup,
} from "../src/agent-integration.js";

const temporaryHomes: string[] = [];
const legacySkillPaths = [
  "./fixtures/actionables-workflow-v1.md",
  "./fixtures/actionables-workflow-v2.md",
  "./fixtures/actionables-workflow-v3.md",
  "./fixtures/actionables-workflow-v4.md",
  "./fixtures/actionables-workflow-v5.md",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));
const latestLegacySkillPath = legacySkillPaths[legacySkillPaths.length - 1]!;

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
  it("leaves all components uninstalled until explicitly selected", async () => {
    const installer = new AgentIntegrationInstaller({
      homeDirectory: await temporaryHome(),
    });

    await expect(installer.status()).resolves.toMatchObject({
      mcp: {
        apiOrigin: "http://127.0.0.1:4174",
        endpoint: "http://127.0.0.1:4174/mcp",
        enabled: false,
        bearerTokenEnvironmentVariable: "ACTIONABLES_MCP_TOKEN",
      },
      mcpServer: {
        state: "missing",
        installed: false,
        targetPath: expect.stringContaining(".codex"),
      },
      agentInstructions: { state: "missing", installed: false },
      skill: { state: "missing", installed: false },
    });
  });

  it("reports a custom effective endpoint without exposing the token", async () => {
    const installer = new AgentIntegrationInstaller({
      homeDirectory: await temporaryHome(),
      runtimeConfig: {
        apiHost: "127.0.0.1",
        apiPort: 4274,
        apiOrigin: "http://127.0.0.1:4274",
        mcpEndpoint: "http://127.0.0.1:4274/mcp",
      },
      mcpEnabled: true,
    });

    const settings = await installer.status();

    expect(settings.mcp).toEqual({
      apiOrigin: "http://127.0.0.1:4274",
      endpoint: "http://127.0.0.1:4274/mcp",
      enabled: true,
      bearerTokenEnvironmentVariable: "ACTIONABLES_MCP_TOKEN",
    });
    expect(JSON.stringify(settings)).not.toContain("Bearer ");
  });

  it("registers a fresh MCP server and is byte-idempotent", async () => {
    const home = await temporaryHome();
    const configPath = resolve(home, ".codex", "config.toml");
    const installer = new AgentIntegrationInstaller({
      homeDirectory: home,
      runtimeConfig: {
        apiHost: "127.0.0.1",
        apiPort: 4274,
        apiOrigin: "http://127.0.0.1:4274",
        mcpEndpoint: "http://127.0.0.1:4274/mcp",
      },
    });

    const installed = await installer.install({
      mcpServer: true,
      agentInstructions: false,
      skill: false,
    });
    expect(installed).toMatchObject({
      settings: {
        mcpServer: { state: "installed", installed: true },
        agentInstructions: { installed: false },
        skill: { installed: false },
      },
      results: [{ component: "mcpServer", outcome: "installed" }],
    });
    const first = await readFile(configPath, "utf8");
    expect(first).toBe(
      [
        "[mcp_servers.actionables]",
        'url = "http://127.0.0.1:4274/mcp"',
        'bearer_token_env_var = "ACTIONABLES_MCP_TOKEN"',
        "enabled = true",
        "required = false",
        "",
      ].join("\n"),
    );

    const repeated = await installer.install({
      mcpServer: true,
      agentInstructions: false,
      skill: false,
    });
    expect(repeated.results).toEqual([
      {
        component: "mcpServer",
        outcome: "already-installed",
        message:
          "The Actionables MCP server was already registered; no configuration changed.",
      },
    ]);
    await expect(readFile(configPath, "utf8")).resolves.toBe(first);
  });

  it("preserves unrelated Codex TOML bytes when registering the MCP server", async () => {
    const home = await temporaryHome();
    const configPath = resolve(home, ".codex", "config.toml");
    const unrelated = [
      "# Personal Codex settings",
      'model = "gpt-5.6-terra"',
      "",
      "[features]",
      "web_search = true",
      "",
      "[mcp_servers.docs]",
      'url = "https://developers.openai.com/mcp"',
      "",
    ].join("\r\n");
    await mkdir(resolve(home, ".codex"), { recursive: true });
    await writeFile(configPath, unrelated, "utf8");
    const installer = new AgentIntegrationInstaller({ homeDirectory: home });

    await installer.install({
      mcpServer: true,
      agentInstructions: false,
      skill: false,
    });

    const installed = await readFile(configPath, "utf8");
    expect(installed.slice(0, unrelated.length)).toBe(unrelated);
    expect(installed).toContain(
      [
        "[mcp_servers.actionables]",
        'url = "http://127.0.0.1:4174/mcp"',
        'bearer_token_env_var = "ACTIONABLES_MCP_TOKEN"',
      ].join("\r\n"),
    );
  });

  it("accepts a safe matching MCP entry without normalizing user formatting", async () => {
    const home = await temporaryHome();
    const configPath = resolve(home, ".codex", "config.toml");
    const matching = [
      '[mcp_servers."actionables"] # keep this comment',
      'url="http://127.0.0.1:4174/mcp"',
      'bearer_token_env_var="ACTIONABLES_MCP_TOKEN"',
      "",
    ].join("\n");
    await mkdir(resolve(home, ".codex"), { recursive: true });
    await writeFile(configPath, matching, "utf8");
    const installer = new AgentIntegrationInstaller({ homeDirectory: home });

    await expect(installer.status()).resolves.toMatchObject({
      mcpServer: { state: "installed", installed: true },
    });
    await installer.install({
      mcpServer: true,
      agentInstructions: false,
      skill: false,
    });
    await expect(readFile(configPath, "utf8")).resolves.toBe(matching);
  });

  it("refuses conflicting or malformed MCP configuration before any write", async () => {
    const cases = [
      [
        "[mcp_servers.actionables]",
        'url = "http://127.0.0.1:9999/mcp"',
        'bearer_token_env_var = "ACTIONABLES_MCP_TOKEN"',
        "",
      ].join("\n"),
      [
        "[mcp_servers.actionables",
        'url = "http://127.0.0.1:4174/mcp"',
        "",
      ].join("\n"),
    ];

    for (const existing of cases) {
      const home = await temporaryHome();
      const configPath = resolve(home, ".codex", "config.toml");
      await mkdir(resolve(home, ".codex"), { recursive: true });
      await writeFile(configPath, existing, "utf8");
      const installer = new AgentIntegrationInstaller({ homeDirectory: home });

      await expect(installer.status()).resolves.toMatchObject({
        mcpServer: { state: "modified", installed: false },
      });
      await expect(
        installer.install({
          mcpServer: true,
          agentInstructions: true,
          skill: false,
        }),
      ).rejects.toMatchObject({
        code: "AGENT_INTEGRATION_CONFLICT",
        conflicts: [
          expect.objectContaining({ id: "mcpServer", state: "modified" }),
        ],
      });
      await expect(readFile(configPath, "utf8")).resolves.toBe(existing);
      await expect(
        readFile(resolve(home, ".codex", "AGENTS.md"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("can narrowly reconcile a previously managed endpoint for later startup changes", () => {
    const previous = [
      "# Keep me",
      "[mcp_servers.actionables]",
      'url = "http://127.0.0.1:4174/mcp" # managed URL',
      'bearer_token_env_var = "ACTIONABLES_MCP_TOKEN"',
      "enabled = true",
      "required = false",
      "",
      "[features]",
      "web_search = true",
      "",
    ].join("\n");

    const result = reconcileCodexMcpConfig(
      previous,
      "http://127.0.0.1:4274/mcp",
      { previousEndpoint: "http://127.0.0.1:4174/mcp" },
    );

    expect(result).toMatchObject({ state: "outdated", changed: true });
    expect(result.content).toBe(
      previous.replace(
        '"http://127.0.0.1:4174/mcp"',
        '"http://127.0.0.1:4274/mcp"',
      ),
    );
  });

  it("updates a managed endpoint at startup and is byte-idempotent once current", async () => {
    const home = await temporaryHome();
    const configPath = resolve(home, ".codex", "config.toml");
    const previous = [
      "# Keep every unrelated byte",
      "[mcp_servers.actionables]",
      'url = "http://127.0.0.1:4174/mcp" # managed URL',
      'bearer_token_env_var = "ACTIONABLES_MCP_TOKEN"',
      "enabled = true",
      "required = false",
      "",
      "[features]",
      "web_search = true",
      "",
    ].join("\r\n");
    await mkdir(resolve(home, ".codex"), { recursive: true });
    await writeFile(configPath, previous, "utf8");
    const options = {
      environment: { ACTIONABLES_PREVIOUS_API_PORT: "4174" },
      homeDirectory: home,
      runtimeConfig: {
        apiHost: "127.0.0.1" as const,
        apiPort: 4274,
        apiOrigin: "http://127.0.0.1:4274",
        mcpEndpoint: "http://127.0.0.1:4274/mcp",
      },
    };

    const updated = await reconcileCodexMcpConfigAtStartup(options);

    expect(updated).toMatchObject({
      outcome: "updated",
      message: expect.stringContaining("Restart Codex"),
    });
    const expected = previous.replace(
      '"http://127.0.0.1:4174/mcp"',
      '"http://127.0.0.1:4274/mcp"',
    );
    await expect(readFile(configPath, "utf8")).resolves.toBe(expected);

    const repeated = await reconcileCodexMcpConfigAtStartup(options);

    expect(repeated).toMatchObject({
      outcome: "unchanged",
      reason: "current",
    });
    await expect(readFile(configPath, "utf8")).resolves.toBe(expected);
  });

  it("does not install an unconfigured endpoint during startup reconciliation", async () => {
    const home = await temporaryHome();
    const configPath = resolve(home, ".codex", "config.toml");

    await expect(
      reconcileCodexMcpConfigAtStartup({
        environment: { ACTIONABLES_PREVIOUS_API_PORT: "4174" },
        homeDirectory: home,
        runtimeConfig: {
          apiHost: "127.0.0.1",
          apiPort: 4274,
          apiOrigin: "http://127.0.0.1:4274",
          mcpEndpoint: "http://127.0.0.1:4274/mcp",
        },
      }),
    ).resolves.toMatchObject({
      outcome: "unchanged",
      reason: "missing",
    });
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("leaves malformed, ambiguous, and user-managed startup entries for manual review", async () => {
    const sensitiveValue = ["fixture", "credential", "value"].join("-");
    const cases = [
      [
        "[mcp_servers.actionables",
        'url = "http://127.0.0.1:4174/mcp"',
        "",
      ].join("\n"),
      [
        '[mcp_servers."actionables"]',
        'url = "http://127.0.0.1:4174/mcp"',
        'bearer_token_env_var = "ACTIONABLES_MCP_TOKEN"',
        "",
      ].join("\n"),
      [
        "[mcp_servers.actionables]",
        'url = "http://127.0.0.1:4174/mcp"',
        'bearer_token_env_var = "ACTIONABLES_MCP_TOKEN"',
        "",
        "[mcp_servers.actionables]",
        'url = "http://127.0.0.1:4174/mcp"',
        "",
      ].join("\n"),
      [
        "[mcp_servers.actionables]",
        'url = "http://127.0.0.1:4174/mcp"',
        `bearer_token = ${JSON.stringify(sensitiveValue)}`,
        "",
      ].join("\n"),
    ];

    for (const existing of cases) {
      const home = await temporaryHome();
      const configPath = resolve(home, ".codex", "config.toml");
      await mkdir(resolve(home, ".codex"), { recursive: true });
      await writeFile(configPath, existing, "utf8");

      const result = await reconcileCodexMcpConfigAtStartup({
        environment: { ACTIONABLES_PREVIOUS_API_PORT: "4174" },
        homeDirectory: home,
        runtimeConfig: {
          apiHost: "127.0.0.1",
          apiPort: 4274,
          apiOrigin: "http://127.0.0.1:4274",
          mcpEndpoint: "http://127.0.0.1:4274/mcp",
        },
      });

      expect(result).toMatchObject({
        outcome: "manual-review",
        message: expect.stringMatching(
          /(?:did not overwrite|could not verify).*restart Codex/,
        ),
      });
      expect(JSON.stringify(result)).not.toContain(sensitiveValue);
      await expect(readFile(configPath, "utf8")).resolves.toBe(existing);
    }
  });

  it("installs each component independently and is idempotent", async () => {
    const home = await temporaryHome();
    const instructionsPath = resolve(home, ".codex", "AGENTS.md");
    await mkdir(resolve(home, ".codex"), { recursive: true });
    await writeFile(instructionsPath, "# My existing instructions\n", "utf8");
    const installer = new AgentIntegrationInstaller({ homeDirectory: home });

    const instructionsResult = await installer.install({
      mcpServer: false,
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
      mcpServer: false,
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
      mcpServer: false,
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
      installer.install({
        mcpServer: false,
        agentInstructions: true,
        skill: true,
      }),
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

  it.each(legacySkillPaths)(
    "updates a known unmodified older skill only when selected (%s)",
    async (legacySkillPath) => {
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
        mcpServer: false,
        agentInstructions: false,
        skill: true,
      });

      expect(result).toMatchObject({
        settings: { skill: { state: "installed", installed: true } },
        results: [{ component: "skill", outcome: "updated" }],
      });
      await expect(readFile(skillPath, "utf8")).resolves.toContain(
        "## Split researched work",
      );
      await expect(readFile(skillPath, "utf8")).resolves.toContain(
        "actionables.get_task_detail",
      );
    },
  );

  it("does not replace a customized older skill", async () => {
    const home = await temporaryHome();
    const skillPath = resolve(
      home,
      ".agents",
      "skills",
      "actionables-workflow",
      "SKILL.md",
    );
    const customized = `${await readFile(latestLegacySkillPath, "utf8")}\n# My customization\n`;
    await mkdir(resolve(skillPath, ".."), { recursive: true });
    await writeFile(skillPath, customized, "utf8");
    const installer = new AgentIntegrationInstaller({ homeDirectory: home });

    await expect(installer.status()).resolves.toMatchObject({
      skill: { state: "modified", installed: false },
    });
    await expect(
      installer.install({
        mcpServer: false,
        agentInstructions: false,
        skill: true,
      }),
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
      installer.install({
        mcpServer: false,
        agentInstructions: true,
        skill: false,
      }),
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
