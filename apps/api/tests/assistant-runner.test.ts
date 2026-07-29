import { describe, expect, it } from "vitest";
import { buildCodexAssistantArguments } from "../src/assistant-runner.js";

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
