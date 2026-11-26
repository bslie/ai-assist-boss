import type { ConnectorManifest } from "../types";

/** Шаблон для подключения любого MCP-сервера: инструменты приходят от самого сервера (tools/list). */
export const customMcp: ConnectorManifest = {
  id: "REMOTE_MCP",
  name: "Свой MCP-сервер",
  vendor: "Любой сервер",
  category: "Свои серверы",
  description: "Адрес вашего MCP-сервера: помощник покажет, что он умеет, а вы решите, чем разрешить пользоваться.",
  sees: ["Только то, что сервер отдаёт через свои инструменты"],
  letter: "+",
  color: "#f0b35a",
  status: "ready",
  multiple: true,
  auth: { kind: "mcp" },
  tools: [],
};
