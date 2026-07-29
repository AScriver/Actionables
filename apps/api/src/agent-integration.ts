import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentIntegrationComponent,
  AgentIntegrationInstallResponse,
  AgentIntegrationSettings,
  InstallAgentIntegrationRequest,
} from "@actionables/contracts";

const instructionsStart = "<!-- actionables-agent-instructions:start -->";
const instructionsEnd = "<!-- actionables-agent-instructions:end -->";
const knownLegacySkillHashes = new Set([
  "d75e5b9094b6bb0f4c8c31059e8bbfac88178ad2b46736c570db217aea19cf42",
]);
const repositoryRoot = resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const defaultResourcesDirectory = resolve(
  repositoryRoot,
  "resources",
  "agent-integration",
);

type InstallerOptions = {
  homeDirectory?: string;
  resourcesDirectory?: string;
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

export class AgentIntegrationConflictError extends Error {
  readonly code = "AGENT_INTEGRATION_CONFLICT";

  constructor(public readonly conflicts: AgentIntegrationComponent[]) {
    super(
      "One or more selected files already contain user-managed changes. Actionables did not overwrite them.",
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

  constructor(options: InstallerOptions = {}) {
    this.homeDirectory = resolve(options.homeDirectory ?? homedir());
    this.resourcesDirectory = resolve(
      options.resourcesDirectory ?? defaultResourcesDirectory,
    );
    this.instructionsPath = resolve(this.homeDirectory, ".codex", "AGENTS.md");
    this.skillPath = resolve(
      this.homeDirectory,
      ".agents",
      "skills",
      "actionables-workflow",
      "SKILL.md",
    );
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
    const [{ instructions, skill }, currentInstructions, currentSkill] =
      await Promise.all([
        this.sources(),
        readOptional(this.instructionsPath),
        readOptional(this.skillPath),
      ]);

    return {
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
