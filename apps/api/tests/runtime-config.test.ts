import { describe, expect, it } from "vitest";
import {
  defaultApiPort,
  loopbackApiHost,
  resolveApiRuntimeConfig,
} from "@actionables/contracts";

describe("API runtime configuration", () => {
  it("derives the default loopback API and MCP endpoints", () => {
    expect(resolveApiRuntimeConfig(undefined)).toEqual({
      apiHost: loopbackApiHost,
      apiPort: defaultApiPort,
      apiOrigin: "http://127.0.0.1:4174",
      mcpEndpoint: "http://127.0.0.1:4174/mcp",
    });
  });

  it("derives the endpoints from a trimmed custom API port", () => {
    expect(resolveApiRuntimeConfig(" 4274 ")).toEqual({
      apiHost: "127.0.0.1",
      apiPort: 4274,
      apiOrigin: "http://127.0.0.1:4274",
      mcpEndpoint: "http://127.0.0.1:4274/mcp",
    });
  });

  it.each(["", " ", "0", "-1", "+1", "1e3", "4174.5", "abc", "65536"])(
    "rejects invalid API_PORT value %j clearly",
    (value) => {
      expect(() => resolveApiRuntimeConfig(value)).toThrow(
        "API_PORT must be a whole number from 1 through 65535.",
      );
    },
  );
});
