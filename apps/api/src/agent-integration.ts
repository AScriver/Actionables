import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import type {
  ApiRuntimeConfig,
  AgentIntegrationComponent,
  AgentIntegrationInstallResponse,
  AgentIntegrationSettings,
  InstallAgentIntegrationRequest,
} from "@actionables/contracts";
import { resolveApiRuntimeConfig } from "@actionables/contracts";

const instructionsStart = "<!-- actionables-agent-instructions:start -->";
const instructionsEnd = "<!-- actionables-agent-instructions:end -->";
const mcpBearerTokenEnvironmentVariable = "ACTIONABLES_MCP_TOKEN";
const actionablesMcpTableHeader = "[mcp_servers.actionables]";
const knownLegacySkillHashes = new Set([
  "d75e5b9094b6bb0f4c8c31059e8bbfac88178ad2b46736c570db217aea19cf42",
  "364c03defceb6662038ff34b53fd47bee28a98ee5aa126f92269171eee6d19f1",
  "617b25d69f99d60924226da438d41f2ab4a39231dc69506eb7214a87b8e29522",
  "d090896ff221b734e43c6bba21b7e79b195f62a20b47961b4a7147b6281c779d",
  "56955943f579ffaa246d6c9fb03340334387b080e059e42bc8e4044f721a9c1d",
  "495f61a7d11d93f2104c56a9c21c9cc6a0bb021badc7fbc0d3740902148c2f37",
  "c31e09f64ddd667dfed2da664701f832e86d2c135f1c30e031c9b19446bd1bc4",
  "b9e2b2cddfb3cfc40e827b64d3a200b8f303edd38341c08569e94c43eaa1c340",
  "e59710df38b6b2d4c502dcbfbfc20017529e097aeba8363b317696d9698e9fd8",
  "45d693bdf5f5e97e68d2b93d82f95c367802bade84fc2a8eec7e049928abe1a4",
]);
const repositoryRoot = resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const defaultResourcesDirectory = resolve(
  repositoryRoot,
  "resources",
  "agent-integration",
);

export function bundledActionablesWorkflowSkill() {
  return readFileSync(
    resolve(defaultResourcesDirectory, "actionables-workflow", "SKILL.md"),
    "utf8",
  );
}

export function bundledActionablesWorkflowInstructions() {
  return normalizeContent(bundledActionablesWorkflowSkill())
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .trim();
}

type InstallerOptions = {
  homeDirectory?: string;
  resourcesDirectory?: string;
  runtimeConfig?: ApiRuntimeConfig;
  mcpEnabled?: boolean;
};

type CodexMcpConfigState = "missing" | "outdated" | "installed" | "modified";

export type CodexMcpConfigReconciliation = {
  state: CodexMcpConfigState;
  content: string;
  changed: boolean;
};

type ReconcileCodexMcpConfigOptions = {
  previousEndpoint?: string;
};

type StartupReconciliationOptions = {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  runtimeConfig: ApiRuntimeConfig;
};

export type CodexMcpStartupReconciliation =
  | {
      outcome: "unchanged";
      reason: "current" | "missing" | "no-endpoint-change";
      targetPath: string;
    }
  | {
      outcome: "updated" | "manual-review";
      message: string;
      targetPath: string;
    };

function normalizeContent(value: string) {
  return value.replace(/\r\n/g, "\n").trim();
}

function contentHash(value: string) {
  return createHash("sha256").update(normalizeContent(value)).digest("hex");
}

async function readOptional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function newlineFor(value: string) {
  return value.includes("\r\n") ? "\r\n" : "\n";
}

function actionablesMcpBlock(endpoint: string, newline: string) {
  return [
    actionablesMcpTableHeader,
    `url = ${JSON.stringify(endpoint)}`,
    `bearer_token_env_var = ${JSON.stringify(mcpBearerTokenEnvironmentVariable)}`,
    "enabled = true",
    "required = false",
    "",
  ].join(newline);
}

function appendActionablesMcpBlock(current: string, endpoint: string) {
  const newline = newlineFor(current);
  const block = actionablesMcpBlock(endpoint, newline);
  if (current.length === 0) return block;
  const separator =
    current.endsWith("\n") || current.endsWith("\r")
      ? current.endsWith(`${newline}${newline}`)
        ? ""
        : newline
      : `${newline}${newline}`;
  return `${current}${separator}${block}`;
}

function isSafeActionablesMcpConfig(
  value: unknown,
  endpoint: string,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const supportedKeys = new Set([
    "url",
    "bearer_token_env_var",
    "enabled",
    "required",
  ]);
  if (Object.keys(value).some((key) => !supportedKeys.has(key))) return false;
  return (
    value.url === endpoint &&
    value.bearer_token_env_var === mcpBearerTokenEnvironmentVariable &&
    (value.enabled === undefined || value.enabled === true) &&
    (value.required === undefined || value.required === false)
  );
}

function replaceManagedActionablesMcpUrl(
  current: string,
  previousEndpoint: string,
  endpoint: string,
) {
  const headerPattern =
    /^[ \t]*\[mcp_servers\.actionables\][ \t]*(?:#[^\r\n]*)?$/gm;
  const headers = [...current.matchAll(headerPattern)];
  if (headers.length !== 1 || headers[0].index === undefined) return null;

  const header = headers[0];
  const headerEnd = header.index + header[0].length;
  const remainder = current.slice(headerEnd);
  const nextTable = remainder.match(
    /(?:\r\n|\n|\r)[ \t]*\[\[?[^\r\n]+\]?\][ \t]*(?:#[^\r\n]*)?/,
  );
  const sectionEnd =
    nextTable?.index === undefined
      ? current.length
      : headerEnd + nextTable.index;
  const section = current.slice(headerEnd, sectionEnd);
  const expectedUrl = JSON.stringify(previousEndpoint).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const urlPattern = new RegExp(
    `(^|\\r\\n|\\n|\\r)([ \\t]*url[ \\t]*=[ \\t]*)${expectedUrl}([ \\t]*(?:#[^\\r\\n]*)?)(?=\\r\\n|\\n|\\r|$)`,
    "g",
  );
  const matches = [...section.matchAll(urlPattern)];
  if (matches.length !== 1 || matches[0].index === undefined) return null;

  const match = matches[0];
  const valueStart =
    headerEnd + match.index + match[1].length + match[2].length;
  return `${current.slice(0, valueStart)}${JSON.stringify(endpoint)}${current.slice(valueStart + JSON.stringify(previousEndpoint).length)}`;
}

export function reconcileCodexMcpConfig(
  current: string | null,
  endpoint: string,
  options: ReconcileCodexMcpConfigOptions = {},
): CodexMcpConfigReconciliation {
  if (current === null) {
    return {
      state: "missing",
      content: actionablesMcpBlock(endpoint, "\n"),
      changed: true,
    };
  }

  let document: Record<string, unknown>;
  try {
    document = parse(current);
  } catch {
    return { state: "modified", content: current, changed: false };
  }

  const mcpServers = document.mcp_servers;
  if (mcpServers === undefined) {
    return {
      state: "missing",
      content: appendActionablesMcpBlock(current, endpoint),
      changed: true,
    };
  }
  if (!isRecord(mcpServers)) {
    return { state: "modified", content: current, changed: false };
  }

  const actionables = mcpServers.actionables;
  if (actionables === undefined) {
    return {
      state: "missing",
      content: appendActionablesMcpBlock(current, endpoint),
      changed: true,
    };
  }
  if (isSafeActionablesMcpConfig(actionables, endpoint)) {
    return { state: "installed", content: current, changed: false };
  }

  if (
    options.previousEndpoint &&
    isSafeActionablesMcpConfig(actionables, options.previousEndpoint)
  ) {
    const updated = replaceManagedActionablesMcpUrl(
      current,
      options.previousEndpoint,
      endpoint,
    );
    if (updated !== null) {
      return { state: "outdated", content: updated, changed: true };
    }
  }

  return { state: "modified", content: current, changed: false };
}

export async function reconcileCodexMcpConfigAtStartup({
  environment = process.env,
  homeDirectory = homedir(),
  runtimeConfig,
}: StartupReconciliationOptions): Promise<CodexMcpStartupReconciliation> {
  const targetPath = resolve(homeDirectory, ".codex", "config.toml");
  const previousApiPort = environment.ACTIONABLES_PREVIOUS_API_PORT;
  if (previousApiPort === undefined) {
    return {
      outcome: "unchanged",
      reason: "no-endpoint-change",
      targetPath,
    };
  }

  let previousEndpoint: string;
  try {
    previousEndpoint = resolveApiRuntimeConfig(previousApiPort).mcpEndpoint;
  } catch {
    return {
      outcome: "manual-review",
      targetPath,
      message: `Actionables could not verify the previous MCP endpoint recorded for startup. Review the Actionables entry in ${targetPath}, set its URL to ${runtimeConfig.mcpEndpoint}, and restart Codex.`,
    };
  }

  let current: string | null;
  try {
    current = await readOptional(targetPath);
  } catch {
    return {
      outcome: "manual-review",
      targetPath,
      message: `Actionables could not read the Codex configuration at ${targetPath}. Review its Actionables entry, set the URL to ${runtimeConfig.mcpEndpoint}, and restart Codex.`,
    };
  }

  const reconciliation = reconcileCodexMcpConfig(
    current,
    runtimeConfig.mcpEndpoint,
    { previousEndpoint },
  );
  if (reconciliation.state === "missing") {
    return { outcome: "unchanged", reason: "missing", targetPath };
  }
  if (reconciliation.state === "installed") {
    return { outcome: "unchanged", reason: "current", targetPath };
  }
  if (reconciliation.state === "modified") {
    return {
      outcome: "manual-review",
      targetPath,
      message: `Actionables did not overwrite the ambiguous or user-managed Codex configuration at ${targetPath}. Review its Actionables entry, replace the stale URL ${previousEndpoint} with ${runtimeConfig.mcpEndpoint} when appropriate, and restart Codex.`,
    };
  }

  try {
    await writeFile(targetPath, reconciliation.content, "utf8");
  } catch {
    return {
      outcome: "manual-review",
      targetPath,
      message: `Actionables could not update the managed Codex configuration at ${targetPath}. Replace the stale URL ${previousEndpoint} with ${runtimeConfig.mcpEndpoint} manually, and restart Codex.`,
    };
  }

  return {
    outcome: "updated",
    targetPath,
    message: `Actionables updated the managed Codex MCP endpoint in ${targetPath} from ${previousEndpoint} to ${runtimeConfig.mcpEndpoint}. Restart Codex to load the configuration.`,
  };
}

function instructionsComponent(
  targetPath: string,
  current: string | null,
  source: string,
): AgentIntegrationComponent {
  const normalizedCurrent = current === null ? "" : normalizeContent(current);
  const normalizedSource = normalizeContent(source);
  const managedBlock = `${instructionsStart}\n${normalizedSource}\n${instructionsEnd}`;
  const hasManagedMarkers =
    normalizedCurrent.includes(instructionsStart) ||
    normalizedCurrent.includes(instructionsEnd);
  const state =
    current === null
      ? "missing"
      : hasManagedMarkers
        ? normalizedCurrent.includes(normalizeContent(managedBlock))
          ? "installed"
          : "modified"
        : normalizedCurrent.includes(normalizedSource)
          ? "installed"
          : "missing";

  return {
    id: "agentInstructions",
    label: "Actionables agent instructions",
    description:
      "Adds Actionables task-coordination guidance to the current user's Codex instructions.",
    targetPath,
    state,
    installed: state === "installed",
  };
}

function skillComponent(
  targetPath: string,
  current: string | null,
  source: string,
): AgentIntegrationComponent {
  const state =
    current === null
      ? "missing"
      : normalizeContent(current) === normalizeContent(source)
        ? "installed"
        : knownLegacySkillHashes.has(contentHash(current))
          ? "outdated"
          : "modified";

  return {
    id: "skill",
    label: "Actionables workflow skill",
    description:
      "Installs the Actionables claim, lifecycle, handoff, and validation workflow for Codex.",
    targetPath,
    state,
    installed: state === "installed",
  };
}

function mcpServerComponent(
  targetPath: string,
  reconciliation: CodexMcpConfigReconciliation,
): AgentIntegrationComponent {
  return {
    id: "mcpServer",
    label: "Actionables MCP server",
    description:
      "Registers the effective Actionables MCP endpoint in the current user's shared Codex configuration.",
    targetPath,
    state: reconciliation.state,
    installed: reconciliation.state === "installed",
  };
}

export class AgentIntegrationConflictError extends Error {
  readonly code = "AGENT_INTEGRATION_CONFLICT";

  constructor(public readonly conflicts: AgentIntegrationComponent[]) {
    super(
      "One or more selected integration components contain user-managed or ambiguous configuration. Actionables did not overwrite them.",
    );
  }
}

export class AgentIntegrationInstallError extends Error {
  readonly code = "AGENT_INTEGRATION_INSTALL_FAILED";

  constructor(
    public readonly targetPath: string,
    cause: unknown,
  ) {
    super(
      `Could not install the Actionables integration at ${targetPath}. ${cause instanceof Error ? cause.message : "Check access to the target directory and try again."}`,
    );
  }
}

export class AgentIntegrationInstaller {
  readonly homeDirectory: string;
  readonly resourcesDirectory: string;
  readonly instructionsPath: string;
  readonly skillPath: string;
  readonly codexConfigPath: string;
  readonly runtimeConfig: ApiRuntimeConfig;
  readonly mcpEnabled: boolean;

  constructor(options: InstallerOptions = {}) {
    this.homeDirectory = resolve(options.homeDirectory ?? homedir());
    this.resourcesDirectory = resolve(
      options.resourcesDirectory ?? defaultResourcesDirectory,
    );
    this.instructionsPath = resolve(this.homeDirectory, ".codex", "AGENTS.md");
    this.codexConfigPath = resolve(this.homeDirectory, ".codex", "config.toml");
    this.skillPath = resolve(
      this.homeDirectory,
      ".agents",
      "skills",
      "actionables-workflow",
      "SKILL.md",
    );
    this.runtimeConfig =
      options.runtimeConfig ?? resolveApiRuntimeConfig(undefined);
    this.mcpEnabled = options.mcpEnabled ?? false;
  }

  private async sources() {
    const [instructions, skill] = await Promise.all([
      readFile(resolve(this.resourcesDirectory, "AGENTS.fragment.md"), "utf8"),
      readFile(
        resolve(this.resourcesDirectory, "actionables-workflow", "SKILL.md"),
        "utf8",
      ),
    ]);
    return { instructions, skill };
  }

  async status(): Promise<AgentIntegrationSettings> {
    const [
      { instructions, skill },
      currentInstructions,
      currentSkill,
      currentCodexConfig,
    ] = await Promise.all([
      this.sources(),
      readOptional(this.instructionsPath),
      readOptional(this.skillPath),
      readOptional(this.codexConfigPath),
    ]);
    const mcpReconciliation = reconcileCodexMcpConfig(
      currentCodexConfig,
      this.runtimeConfig.mcpEndpoint,
    );

    return {
      mcp: {
        apiOrigin: this.runtimeConfig.apiOrigin,
        endpoint: this.runtimeConfig.mcpEndpoint,
        enabled: this.mcpEnabled,
        bearerTokenEnvironmentVariable: mcpBearerTokenEnvironmentVariable,
      },
      mcpServer: mcpServerComponent(this.codexConfigPath, mcpReconciliation),
      agentInstructions: instructionsComponent(
        this.instructionsPath,
        currentInstructions,
        instructions,
      ),
      skill: skillComponent(this.skillPath, currentSkill, skill),
    };
  }

  async install(
    input: InstallAgentIntegrationRequest,
  ): Promise<AgentIntegrationInstallResponse> {
    const before = await this.status();
    const selected = [
      ...(input.mcpServer ? [before.mcpServer] : []),
      ...(input.agentInstructions ? [before.agentInstructions] : []),
      ...(input.skill ? [before.skill] : []),
    ];
    const conflicts = selected.filter(
      (component) => component.state === "modified",
    );
    if (conflicts.length > 0) {
      throw new AgentIntegrationConflictError(conflicts);
    }

    const { instructions, skill } = await this.sources();
    const results: AgentIntegrationInstallResponse["results"] = [];

    if (input.mcpServer) {
      const current = await readOptional(this.codexConfigPath);
      const reconciliation = reconcileCodexMcpConfig(
        current,
        this.runtimeConfig.mcpEndpoint,
      );
      if (reconciliation.state === "modified") {
        throw new AgentIntegrationConflictError([
          mcpServerComponent(this.codexConfigPath, reconciliation),
        ]);
      }
      if (!reconciliation.changed) {
        results.push({
          component: "mcpServer",
          outcome: "already-installed",
          message:
            "The Actionables MCP server was already registered; no configuration changed.",
        });
      } else {
        try {
          await mkdir(dirname(this.codexConfigPath), { recursive: true });
          await writeFile(this.codexConfigPath, reconciliation.content, {
            encoding: "utf8",
            ...(current === null ? { flag: "wx" } : {}),
          });
          results.push({
            component: "mcpServer",
            outcome: "installed",
            message:
              "The Actionables MCP server was registered. Restart Codex to load the configuration.",
          });
        } catch (error) {
          throw new AgentIntegrationInstallError(this.codexConfigPath, error);
        }
      }
    }

    if (input.agentInstructions) {
      if (before.agentInstructions.installed) {
        results.push({
          component: "agentInstructions",
          outcome: "already-installed",
          message:
            "Agent instructions were already installed; no file changed.",
        });
      } else {
        try {
          const current = await readOptional(this.instructionsPath);
          const newline = current?.includes("\r\n") ? "\r\n" : "\n";
          const block = [
            instructionsStart,
            normalizeContent(instructions),
            instructionsEnd,
            "",
          ].join(newline);
          await mkdir(dirname(this.instructionsPath), { recursive: true });
          if (current === null) {
            await writeFile(this.instructionsPath, block, {
              encoding: "utf8",
              flag: "wx",
            });
          } else {
            const separator = current.endsWith("\n")
              ? current.endsWith(`${newline}${newline}`)
                ? ""
                : newline
              : `${newline}${newline}`;
            await appendFile(this.instructionsPath, `${separator}${block}`, {
              encoding: "utf8",
            });
          }
          results.push({
            component: "agentInstructions",
            outcome: "installed",
            message:
              "Agent instructions were appended without replacing existing instructions.",
          });
        } catch (error) {
          throw new AgentIntegrationInstallError(this.instructionsPath, error);
        }
      }
    }

    if (input.skill) {
      const current = await readOptional(this.skillPath);
      const currentComponent = skillComponent(this.skillPath, current, skill);
      if (currentComponent.state === "modified") {
        throw new AgentIntegrationConflictError([currentComponent]);
      }
      if (currentComponent.installed) {
        results.push({
          component: "skill",
          outcome: "already-installed",
          message: "The workflow skill was already installed; no file changed.",
        });
      } else {
        try {
          await mkdir(dirname(this.skillPath), { recursive: true });
          await writeFile(this.skillPath, `${normalizeContent(skill)}\n`, {
            encoding: "utf8",
            ...(currentComponent.state === "missing" ? { flag: "wx" } : {}),
          });
          results.push({
            component: "skill",
            outcome:
              currentComponent.state === "outdated" ? "updated" : "installed",
            message:
              currentComponent.state === "outdated"
                ? "The unmodified Actionables workflow skill was updated."
                : "The Actionables workflow skill was installed.",
          });
        } catch (error) {
          throw new AgentIntegrationInstallError(this.skillPath, error);
        }
      }
    }

    return {
      settings: await this.status(),
      results,
    };
  }
}
