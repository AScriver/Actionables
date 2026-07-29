import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultLocalCodexTimeoutSeconds,
  type AssistantReasoningEffort,
} from "@actionables/contracts";

export type AssistantRequest = {
  prompt: string;
  outputSchema: unknown;
  model?: string;
  reasoningEffort?: AssistantReasoningEffort;
  timeoutMs?: number;
};

export type AssistantResult = {
  model: string;
  output: unknown;
};

export interface AssistantRunner {
  readonly defaultModel: string;
  run(request: AssistantRequest): Promise<AssistantResult>;
}

export class AssistantRunnerError extends Error {
  constructor(
    public readonly code:
      | "ASSISTANT_UNAVAILABLE"
      | "ASSISTANT_TIMEOUT"
      | "ASSISTANT_FAILED"
      | "ASSISTANT_INVALID_OUTPUT",
    message: string,
    public readonly timeoutMs?: number,
  ) {
    super(message);
  }
}

export class AssistantContextTooLargeError extends Error {
  constructor(public readonly guidance: string) {
    super("The assistant context is too large for one request.");
  }
}

type CodexAssistantRunnerOptions = {
  executable?: string;
  model?: string;
  timeoutMs?: number;
};

const outputLimit = 20_000;
export const defaultCodexAssistantModel = "gpt-5.6-terra";
export const defaultCodexAssistantTimeoutMs =
  defaultLocalCodexTimeoutSeconds * 1_000;

export function buildCodexAssistantArguments({
  model,
  reasoningEffort,
  schemaPath,
  outputPath,
}: {
  model: string;
  reasoningEffort?: AssistantReasoningEffort;
  schemaPath: string;
  outputPath: string;
}) {
  return [
    "exec",
    "--model",
    model,
    ...(reasoningEffort
      ? [
          "--config",
          `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
        ]
      : []),
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "--color",
    "never",
    "-",
  ];
}

export function createCodexAssistantRunner({
  executable = "codex",
  model = defaultCodexAssistantModel,
  timeoutMs = defaultCodexAssistantTimeoutMs,
}: CodexAssistantRunnerOptions = {}): AssistantRunner {
  return {
    defaultModel: model,
    async run({
      prompt,
      outputSchema,
      model: requestModel,
      reasoningEffort,
      timeoutMs: requestTimeoutMs,
    }) {
      const directory = await mkdtemp(join(tmpdir(), "actionables-assistant-"));
      const schemaPath = join(directory, "output.schema.json");
      const outputPath = join(directory, "output.json");
      const effectiveModel = requestModel ?? model;
      const effectiveTimeoutMs = requestTimeoutMs ?? timeoutMs;

      try {
        await writeFile(schemaPath, JSON.stringify(outputSchema), "utf8");
        const stderr: Buffer[] = [];
        const child = spawn(
          executable,
          buildCodexAssistantArguments({
            model: effectiveModel,
            reasoningEffort,
            schemaPath,
            outputPath,
          }),
          {
            cwd: directory,
            env: process.env,
            stdio: ["pipe", "ignore", "pipe"],
            windowsHide: true,
          },
        );

        child.stderr.on("data", (chunk: Buffer) => {
          const currentSize = stderr.reduce(
            (total, item) => total + item.length,
            0,
          );
          if (currentSize < outputLimit) stderr.push(chunk);
        });
        child.stdin.on("error", () => {
          // The process-level error or exit handler reports startup failures.
        });

        child.stdin.end(prompt);

        const exitCode = await new Promise<number | null>((resolve, reject) => {
          const timeout = setTimeout(() => {
            child.kill();
            reject(
              new AssistantRunnerError(
                "ASSISTANT_TIMEOUT",
                "The local Codex assistant timed out.",
                effectiveTimeoutMs,
              ),
            );
          }, effectiveTimeoutMs);
          timeout.unref();
          child.once("error", (error) => {
            clearTimeout(timeout);
            reject(
              new AssistantRunnerError(
                "ASSISTANT_UNAVAILABLE",
                `The local Codex assistant could not start: ${error.message}`,
              ),
            );
          });
          child.once("exit", (code) => {
            clearTimeout(timeout);
            resolve(code);
          });
        });

        if (exitCode !== 0) {
          const detail = Buffer.concat(stderr)
            .toString("utf8")
            .trim()
            .slice(-2_000);
          throw new AssistantRunnerError(
            "ASSISTANT_FAILED",
            detail
              ? `The local Codex assistant failed: ${detail}`
              : "The local Codex assistant failed.",
          );
        }

        let raw: string;
        try {
          raw = await readFile(outputPath, "utf8");
        } catch {
          throw new AssistantRunnerError(
            "ASSISTANT_INVALID_OUTPUT",
            "The local Codex assistant did not return structured output.",
          );
        }
        try {
          return { model: effectiveModel, output: JSON.parse(raw) };
        } catch {
          throw new AssistantRunnerError(
            "ASSISTANT_INVALID_OUTPUT",
            "The local Codex assistant returned invalid JSON.",
          );
        }
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
