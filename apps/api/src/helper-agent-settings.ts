import type { HelperAgentSettings } from "@actionables/contracts";
import type { AppPrismaClient } from "./database.js";
import {
  defaultNoteGroomerPrompt,
  defaultRelationshipAuditorPrompt,
} from "./assistant-prompts.js";

const settingsId = "helper-agents";

function toContract(settings: {
  noteGroomerPrompt: string;
  relationshipAuditorPrompt: string;
  version: number;
  updatedAt: Date;
}): HelperAgentSettings {
  return {
    noteGroomerPrompt: settings.noteGroomerPrompt,
    relationshipAuditorPrompt: settings.relationshipAuditorPrompt,
    version: settings.version,
    updatedAt: settings.updatedAt.toISOString(),
  };
}

export class HelperAgentSettingsVersionConflictError extends Error {
  constructor(public readonly current: HelperAgentSettings) {
    super("Helper agent settings version conflict.");
  }
}

export async function getHelperAgentSettings(
  prisma: AppPrismaClient,
): Promise<HelperAgentSettings> {
  const settings = await prisma.helperAgentSettings.upsert({
    where: { id: settingsId },
    update: {},
    create: {
      id: settingsId,
      noteGroomerPrompt: defaultNoteGroomerPrompt,
      relationshipAuditorPrompt: defaultRelationshipAuditorPrompt,
    },
  });
  return toContract(settings);
}

export async function updateHelperAgentSettings(
  prisma: AppPrismaClient,
  input: {
    noteGroomerPrompt: string;
    relationshipAuditorPrompt: string;
    version: number;
  },
): Promise<HelperAgentSettings> {
  await getHelperAgentSettings(prisma);
  const updated = await prisma.helperAgentSettings.updateMany({
    where: { id: settingsId, version: input.version },
    data: {
      noteGroomerPrompt: input.noteGroomerPrompt,
      relationshipAuditorPrompt: input.relationshipAuditorPrompt,
      version: { increment: 1 },
    },
  });
  if (updated.count === 0) {
    throw new HelperAgentSettingsVersionConflictError(
      await getHelperAgentSettings(prisma),
    );
  }
  return getHelperAgentSettings(prisma);
}
