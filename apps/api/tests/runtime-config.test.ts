import { describe, expect, it } from "vitest";
import {
  defaultApiPort,
  defaultWebPort,
  loopbackApiHost,
  resolveApiRuntimeConfig,
  resolveRuntimeConfig,
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

describe("effective runtime configuration", () => {
  it("derives the default loopback web, API, health, and MCP endpoints", () => {
    expect(resolveRuntimeConfig()).toEqual({
      webHost: loopbackApiHost,
      webPort: defaultWebPort,
      webOrigin: "http://127.0.0.1:4173",
      healthEndpoint: "http://127.0.0.1:4173/api/health",
      apiHost: loopbackApiHost,
      apiPort: defaultApiPort,
      apiOrigin: "http://127.0.0.1:4174",
      mcpEndpoint: "http://127.0.0.1:4174/mcp",
    });
  });

  it("uses an explicit trimmed web port with the default API port", () => {
    expect(resolveRuntimeConfig({ webPort: " 4273 " })).toMatchObject({
      webPort: 4273,
      webOrigin: "http://127.0.0.1:4273",
      healthEndpoint: "http://127.0.0.1:4273/api/health",
      apiPort: defaultApiPort,
    });
  });

  it("uses an explicit trimmed API port with the default web port", () => {
    expect(resolveRuntimeConfig({ apiPort: " 4274 " })).toMatchObject({
      webPort: defaultWebPort,
      apiPort: 4274,
      apiOrigin: "http://127.0.0.1:4274",
      mcpEndpoint: "http://127.0.0.1:4274/mcp",
    });
  });

  it("uses one explicit normalized web and API port pair", () => {
    expect(
      resolveRuntimeConfig({
        webPort: " 4273 ",
        apiPort: " 4274 ",
      }),
    ).toEqual({
      webHost: "127.0.0.1",
      webPort: 4273,
      webOrigin: "http://127.0.0.1:4273",
      healthEndpoint: "http://127.0.0.1:4273/api/health",
      apiHost: "127.0.0.1",
      apiPort: 4274,
      apiOrigin: "http://127.0.0.1:4274",
      mcpEndpoint: "http://127.0.0.1:4274/mcp",
    });
  });

  it.each(["", " ", "0", "-1", "+1", "1e3", "4173.5", "abc", "65536"])(
    "rejects invalid WEB_PORT value %j clearly",
    (value) => {
      expect(() => resolveRuntimeConfig({ webPort: value })).toThrow(
        "WEB_PORT must be a whole number from 1 through 65535.",
      );
    },
  );

  it("preserves the API_PORT-specific diagnostic through the pair contract", () => {
    expect(() => resolveRuntimeConfig({ apiPort: "invalid" })).toThrow(
      "API_PORT must be a whole number from 1 through 65535.",
    );
  });
});
