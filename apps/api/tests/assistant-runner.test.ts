import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssistantRunnerError,
  buildCodexAssistantArguments,
  createCodexAssistantRunner,
  defaultCodexAssistantTimeoutMs,
} from "../src/assistant-runner.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function createPendingChild() {
  const child = Object.assign(new EventEmitter(), {
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(() => true),
  });
  vi.mocked(spawn).mockReturnValue(
    child as unknown as ReturnType<typeof spawn>,
  );
  return child;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("Codex assistant runner arguments", () => {
  it("preserves the configured model and model-default reasoning", () => {
    const args = buildCodexAssistantArguments({
      model: "environment-model",
      schemaPath: "output.schema.json",
      outputPath: "output.json",
    });

    expect(args).toContain("environment-model");
    expect(args).not.toContain("--config");
  });

  it("passes selected model and reasoning overrides to codex exec", () => {
    const args = buildCodexAssistantArguments({
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      schemaPath: "output.schema.json",
      outputPath: "output.json",
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "--model",
        "gpt-5.6-sol",
        "--config",
        'model_reasoning_effort="xhigh"',
      ]),
    );
  });
});

describe("Codex assistant runner timeout", () => {
  it("preserves the 120-second default", () => {
    expect(defaultCodexAssistantTimeoutMs).toBe(120_000);
  });

  it("applies a per-request timeout and returns only safe timeout details", async () => {
    const child = createPendingChild();
    const runner = createCodexAssistantRunner({ timeoutMs: 1_000 });

    const error = await runner
      .run({
        prompt: "sensitive prompt content",
        outputSchema: { type: "object" },
        timeoutMs: 10,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AssistantRunnerError);
    expect(error).toMatchObject({
      code: "ASSISTANT_TIMEOUT",
      message: "The local Codex assistant timed out.",
      timeoutMs: 10,
    });
    expect((error as Error).message).not.toContain("sensitive prompt content");
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
