import { describe, expect, test } from "bun:test";

// NOTE(ARD-2319): Anonymous Haron stage response captured on 2026-10-11 from
// https://azure-stage.dev.ardor.cloud/haron-api/api/cerebrum/desktop/models.
// Keep the full producer payload to catch catalog compatibility regressions offline.
import haronStageCatalog from "./fixtures/haron-desktop-models.stage-2026-10-11.json";
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

  test("preserves the full Haron stage catalog and its capability metadata", async () => {
    const client = new LocalModelCatalogClient({
      apiOrigin: "https://api.ardor.cloud",
      fetch: async () => Response.json(haronStageCatalog),
    });

    await expect(client.listModels()).resolves.toEqual(haronStageCatalog);
  });

  test("preserves an empty reasoning list without inventing supported efforts", async () => {
    const response = {
      ...catalogResponse,
      data: [{ ...catalogResponse.data[0], supportedReasoningEfforts: [], defaultReasoningEffort: "low" }],
    };
    const client = new LocalModelCatalogClient({
      apiOrigin: "https://api.ardor.cloud",
      fetch: async () => Response.json(response),
    });

    await expect(client.listModels()).resolves.toEqual(response);
  });

  test.each([241, 261, 2000])("preserves a NUX message of %i UTF-16 code units", async (length) => {
    const response = {
      ...catalogResponse,
      data: [{ ...catalogResponse.data[0], availabilityNux: { message: "a".repeat(length) } }],
    };
    const client = new LocalModelCatalogClient({
      apiOrigin: "https://api.ardor.cloud",
      fetch: async () => Response.json(response),
    });

    await expect(client.listModels()).resolves.toEqual(response);
  });

  test("accepts a NUX message at 2000 UTF-16 code units including surrogate pairs", async () => {
    const response = {
      ...catalogResponse,
      data: [{ ...catalogResponse.data[0], availabilityNux: { message: "🦊".repeat(1000) } }],
    };
    const client = new LocalModelCatalogClient({
      apiOrigin: "https://api.ardor.cloud",
      fetch: async () => Response.json(response),
    });

    await expect(client.listModels()).resolves.toEqual(response);
  });

  test.each([
    { name: "2001-unit NUX", fields: { availabilityNux: { message: "a".repeat(2001) } } },
    { name: "2001-unit NUX with surrogate pairs", fields: { availabilityNux: { message: "🦊".repeat(1000) + "a" } } },
    { name: "empty NUX", fields: { availabilityNux: { message: "" } } },
    { name: "blank NUX", fields: { availabilityNux: { message: " " } } },
    { name: "non-string NUX", fields: { availabilityNux: { message: 1 } } },
    { name: "missing NUX message", fields: { availabilityNux: {} } },
    { name: "array NUX", fields: { availabilityNux: [] } },
    { name: "non-object NUX", fields: { availabilityNux: "message" } },
    { name: "null reasoning list", fields: { supportedReasoningEfforts: null } },
    { name: "non-array reasoning list", fields: { supportedReasoningEfforts: {} } },
    { name: "null reasoning entry", fields: { supportedReasoningEfforts: [null] } },
    { name: "missing reasoning effort", fields: { supportedReasoningEfforts: [{ description: "Reasoning" }] } },
    { name: "blank reasoning effort", fields: { supportedReasoningEfforts: [{ reasoningEffort: " ", description: "Reasoning" }] } },
    { name: "non-string reasoning description", fields: { supportedReasoningEfforts: [{ reasoningEffort: "high", description: 1 }] } },
    { name: "oversized reasoning list", fields: { supportedReasoningEfforts: Array.from({ length: 33 }, () => catalogResponse.data[0].supportedReasoningEfforts[0]) } },
  ])("rejects $name", async ({ fields }) => {
    const client = new LocalModelCatalogClient({
      apiOrigin: "https://api.ardor.cloud",
      fetch: async () => Response.json({ ...catalogResponse, data: [{ ...catalogResponse.data[0], ...fields }] }),
    });

    await expect(client.listModels()).rejects.toThrow("Haron model catalog contains an invalid model");
  });

  test.each([0, 2])("rejects a catalog with %i default models", async (defaultCount) => {
    const data = Array.from({ length: 2 }, (_, index) => ({
      ...catalogResponse.data[0],
      id: `model-${index}`,
      model: `model-${index}`,
      isDefault: index < defaultCount,
    }));
    const client = new LocalModelCatalogClient({
      apiOrigin: "https://api.ardor.cloud",
      fetch: async () => Response.json({ ...catalogResponse, data }),
    });

    await expect(client.listModels()).rejects.toThrow("Haron model catalog must declare exactly one default model");
  });

  test("rejects a failed Haron response", async () => {
    const client = new LocalModelCatalogClient({
      apiOrigin: "https://api.ardor.cloud",
      fetch: async () => Response.json({ error: "unavailable" }, { status: 503 }),
    });

    await expect(client.listModels()).rejects.toThrow("Haron model catalog is unavailable");
  });
});
