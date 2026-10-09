import { describe, expect, test } from "bun:test";

import {
  parseLocalAgentRpcRequest,
  parseLocalAgentRuntimeScope,
  resolveLocalProjectPath,
} from "./protocol.js";

describe("local agent IPC protocol", () => {
  test("accepts app-server methods used by the current chat renderer", () => {
    expect(parseLocalAgentRpcRequest({
      id: 12,
      method: "thread/start",
      params: { cwd: "C:\\Users\\Дарья\\Проекты\\Пример" },
    })).toEqual({
      id: 12,
      method: "thread/start",
      params: { cwd: "C:\\Users\\Дарья\\Проекты\\Пример" },
    });
  });

  test("rejects unknown RPC methods and malformed payloads", () => {
    expect(() => parseLocalAgentRpcRequest({ id: 1, method: "shell:exec", params: {} })).toThrow();
    expect(() => parseLocalAgentRpcRequest({ id: 1, method: "thread/start", params: [] })).toThrow();
    expect(() => parseLocalAgentRpcRequest({ id: {}, method: "thread/start", params: {} })).toThrow();
  });

  test("requires explicit account and Ardor workspace scope", () => {
    expect(parseLocalAgentRuntimeScope({ accountId: "auth0|user", workspaceId: "workspace-1" })).toEqual({
      accountId: "auth0|user",
      workspaceId: "workspace-1",
    });
    expect(() => parseLocalAgentRuntimeScope({ accountId: "auth0|user", workspaceId: " " })).toThrow();
  });

  test("preserves native drive paths and rejects relative project paths", () => {
    expect(resolveLocalProjectPath("C:\\Users\\Дарья\\Проекты\\Новый проект", "win32")).toBe(
      "C:\\Users\\Дарья\\Проекты\\Новый проект",
    );
    expect(resolveLocalProjectPath("C:/Users/Дарья/Проекты/Новый проект", "win32")).toBe(
      "C:\\Users\\Дарья\\Проекты\\Новый проект",
    );
    expect(() => resolveLocalProjectPath("..\\outside", "win32")).toThrow();
    expect(() => resolveLocalProjectPath("/home/user/project", "win32")).toThrow();
    expect(resolveLocalProjectPath("/Users/Дарья/Проекты/Новый проект", "darwin")).toBe(
      "/Users/Дарья/Проекты/Новый проект",
    );
  });
});
