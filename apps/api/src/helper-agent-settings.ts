import {
  defaultLocalCodexTimeoutSeconds,
  helperAgentSettingsSchema,
  type HelperAgentSettings,
  type UpdateHelperAgentSettingsRequest,
} from "@actionables/contracts";
import type { AppPrismaClient } from "./database.js";
import type { Prisma } from "./generated/prisma/client.js";
import {
  defaultNoteGroomerPrompt,
  defaultRelationshipAuditorPrompt,
} from "./assistant-prompts.js";

const settingsId = "helper-agents";
type SettingsClient = AppPrismaClient | Prisma.TransactionClient;

function toContract(
  settings: {
    agentClaimLeaseMinutes: number;
    agentClaimExpiryWarningMinutes: number;
    localCodexTimeoutSeconds: number | null;
    noteGroomerEnabled: boolean;
    noteGroomerModel: string | null;
    noteGroomerReasoningEffort: string | null;
    noteGroomerPrompt: string;
    relationshipAuditorEnabled: boolean;
    relationshipAuditorModel: string | null;
    relationshipAuditorReasoningEffort: string | null;
    relationshipAuditorPrompt: string;
    version: number;
    updatedAt: Date;
  },
  defaultModel: string,
): HelperAgentSettings {
  return helperAgentSettingsSchema.parse({
    agentClaimLeaseMinutes: settings.agentClaimLeaseMinutes,
    agentClaimExpiryWarningMinutes: settings.agentClaimExpiryWarningMinutes,
    localCodexTimeoutSeconds: settings.localCodexTimeoutSeconds,
    localCodexEffectiveTimeoutSeconds:
      settings.localCodexTimeoutSeconds ?? defaultLocalCodexTimeoutSeconds,
    noteGroomerEnabled: settings.noteGroomerEnabled,
    noteGroomerModel: settings.noteGroomerModel,
    noteGroomerReasoningEffort: settings.noteGroomerReasoningEffort,
    noteGroomerEffectiveModel: settings.noteGroomerModel ?? defaultModel,
    noteGroomerPrompt: settings.noteGroomerPrompt,
    relationshipAuditorEnabled: settings.relationshipAuditorEnabled,
    relationshipAuditorModel: settings.relationshipAuditorModel,
    relationshipAuditorReasoningEffort:
      settings.relationshipAuditorReasoningEffort,
    relationshipAuditorEffectiveModel:
      settings.relationshipAuditorModel ?? defaultModel,
    relationshipAuditorPrompt: settings.relationshipAuditorPrompt,
    version: settings.version,
    updatedAt: settings.updatedAt.toISOString(),
  });
}

export class HelperAgentSettingsVersionConflictError extends Error {
  constructor(public readonly current: HelperAgentSettings) {
    super("Helper agent settings version conflict.");
  }
}

function getHelperAgentSettingsRow(prisma: SettingsClient) {
  return prisma.helperAgentSettings.upsert({
    where: { id: settingsId },
    update: {},
    create: {
      id: settingsId,
      noteGroomerPrompt: defaultNoteGroomerPrompt,
      relationshipAuditorPrompt: defaultRelationshipAuditorPrompt,
    },
  });
}

export async function getAgentCoordinationSettings(prisma: SettingsClient) {
  const settings = await getHelperAgentSettingsRow(prisma);
  return {
    agentClaimLeaseMinutes: settings.agentClaimLeaseMinutes,
    agentClaimExpiryWarningMinutes: settings.agentClaimExpiryWarningMinutes,
  };
}

export async function getHelperAgentSettings(
  prisma: AppPrismaClient,
  defaultModel: string,
): Promise<HelperAgentSettings> {
  const settings = await getHelperAgentSettingsRow(prisma);
  return toContract(settings, defaultModel);
}

export async function updateHelperAgentSettings(
  prisma: AppPrismaClient,
  input: UpdateHelperAgentSettingsRequest,
  defaultModel: string,
): Promise<HelperAgentSettings> {
  await getHelperAgentSettings(prisma, defaultModel);
  const updated = await prisma.helperAgentSettings.updateMany({
    where: { id: settingsId, version: input.version },
    data: {
      agentClaimLeaseMinutes: input.agentClaimLeaseMinutes,
      agentClaimExpiryWarningMinutes: input.agentClaimExpiryWarningMinutes,
      localCodexTimeoutSeconds: input.localCodexTimeoutSeconds,
      noteGroomerEnabled: input.noteGroomerEnabled,
      noteGroomerModel: input.noteGroomerModel,
      noteGroomerReasoningEffort: input.noteGroomerReasoningEffort,
      noteGroomerPrompt: input.noteGroomerPrompt,
      relationshipAuditorEnabled: input.relationshipAuditorEnabled,
      relationshipAuditorModel: input.relationshipAuditorModel,
      relationshipAuditorReasoningEffort:
        input.relationshipAuditorReasoningEffort,
      relationshipAuditorPrompt: input.relationshipAuditorPrompt,
      version: { increment: 1 },
    },
  });
  if (updated.count === 0) {
    throw new HelperAgentSettingsVersionConflictError(
      await getHelperAgentSettings(prisma, defaultModel),
    );
  }
  return getHelperAgentSettings(prisma, defaultModel);
}
