import { describe, expect, test } from "bun:test";

import { LocalModelCatalogClient } from "./model-catalog.js";

const catalogResponse = {
  data: [
    {
      id: "gpt-6.1-sol",
      model: "gpt-6.1-sol",
      upgrade: null,
      upgradeInfo: null,
      availabilityNux: null,
      displayName: "GPT-6.1 Sol",
      description: "Agentic coding model",
      modelSpecialty: null,
      hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Deep reasoning" }],
      defaultReasoningEffort: "high",
      inputModalities: ["text", "image"],
      supportsPersonality: false,
      multiAgentVersion: "v2",
      additionalSpeedTiers: ["fast"],
      serviceTiers: [],
      defaultServiceTier: null,
      availableAccessPrograms: null,
      isDefault: true,
    },
  ],
  nextCursor: null,
};

describe("LocalModelCatalogClient", () => {
  test("loads the fixed Haron Desktop catalog route and validates app-server v2 models", async () => {
    let requestedUrl = "";
    let requestedAuthorization: string | null = null;
    const client = new LocalModelCatalogClient({
      apiOrigin: "https://api.ardor.cloud/",
      fetch: async (input, init) => {
        requestedUrl = String(input);
        requestedAuthorization = new Headers(init?.headers).get("authorization");
        return Response.json(catalogResponse);
      },
    });

    await expect(client.listModels()).resolves.toEqual(catalogResponse);
    expect(requestedUrl).toBe("https://api.ardor.cloud/haron-api/api/cerebrum/desktop/models");
    expect(requestedAuthorization).toBeNull();
  });

  test("rejects unsupported, malformed, and oversized model catalogs", async () => {
    const malformedClients = [
      new LocalModelCatalogClient({
        apiOrigin: "https://api.ardor.cloud",
        fetch: async () => Response.json({ data: [], nextCursor: "1" }),
      }),
      new LocalModelCatalogClient({
        apiOrigin: "https://api.ardor.cloud",
        fetch: async () => Response.json({ ...catalogResponse, data: [{ ...catalogResponse.data[0], hidden: true }] }),
      }),
      new LocalModelCatalogClient({
        apiOrigin: "https://api.ardor.cloud",
        fetch: async () => new Response("x".repeat(10), { status: 200 }),
        maxResponseBytes: 4,
      }),
    ];

    for (const client of malformedClients) {
      await expect(client.listModels()).rejects.toThrow();
    }
  });

  test("rejects a failed Haron response", async () => {
    const client = new LocalModelCatalogClient({
      apiOrigin: "https://api.ardor.cloud",
      fetch: async () => Response.json({ error: "unavailable" }, { status: 503 }),
    });

    await expect(client.listModels()).rejects.toThrow("Haron model catalog is unavailable");
  });
});
