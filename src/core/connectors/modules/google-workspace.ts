import type { ConnectorManifest } from "../types";

export const googleWorkspace: ConnectorManifest = {
  id: "BUILTIN_GOOGLE",
  name: "Google Workspace",
  vendor: "Google",
  category: "Почта",
  description: "Gmail и Google Календарь.",
  sees: [],
  letter: "G",
  color: "#34a853",
  status: "soon",
  auth: { kind: "none" },
  tools: [],
};
