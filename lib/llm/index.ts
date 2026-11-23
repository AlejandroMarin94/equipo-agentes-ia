import { resolveModels } from "./chain";
import { createClaudeCaller, type CallInfo } from "./claude";
import { MockProvider } from "./mock";
import { ClaudeProvider } from "./provider";
import type { AgentProvider } from "./types";

type Env = Record<string, string | undefined>;

/** Elige el proveedor según LLM_PROVIDER: claude (por defecto) o mock. */
export function getProvider(env: Env = process.env, options: { onCall?: (info: CallInfo) => void } = {}): AgentProvider {
  const provider = (env.LLM_PROVIDER ?? "claude").trim().toLowerCase() || "claude";
  if (provider === "mock") return new MockProvider(Number(env.MOCK_DELAY_MS ?? 1500));
  if (provider !== "claude") throw new Error(`LLM_PROVIDER desconocido: ${provider} (usa claude o mock)`);
  return new ClaudeProvider(resolveModels(env), createClaudeCaller({ env, onCall: options.onCall }));
}
