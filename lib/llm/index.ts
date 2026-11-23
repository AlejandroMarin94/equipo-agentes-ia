import {
  API_KEY_ENV,
  LEGACY_ENV,
  PROVIDER_IDS,
  resolveChains,
  usableLinks,
  type AgentName,
  type ChainLink,
  type LinkCaller,
  type ProviderId,
} from "./chain";
import { createGeminiCaller } from "./gemini";
import { MockProvider } from "./mock";
import { createOpenAICompatibleCaller } from "./openai-compatible";
import { ChainProvider } from "./provider";
import type { AgentProvider } from "./types";

type Env = Record<string, string | undefined>;

/** Un caller por proveedor con clave; los que no tienen clave no aparecen. */
export function createCallers(env: Env): Partial<Record<ProviderId, LinkCaller>> {
  const callers: Partial<Record<ProviderId, LinkCaller>> = {};
  for (const id of PROVIDER_IDS) {
    const key = env[API_KEY_ENV[id]]?.trim();
    if (!key) continue;
    callers[id] = id === "gemini" ? createGeminiCaller(key) : createOpenAICompatibleCaller(id, key);
  }
  return callers;
}

/**
 * Cadenas de los agentes con solo los eslabones que tienen clave, y los saltados (para registrarlos).
 * Lanza un error de configuración si algún agente se queda sin ninguno.
 */
export function resolveUsableChains(env: Env, available: (provider: ProviderId) => boolean) {
  const chains = resolveChains(env);
  const usable = {} as Record<AgentName, ChainLink[]>;
  const skipped: string[] = [];
  for (const agent of Object.keys(chains) as AgentName[]) {
    const result = usableLinks(agent, chains[agent], available);
    usable[agent] = result.links;
    skipped.push(...result.skipped.map((l) => `${agent}: ${l.label} (falta ${API_KEY_ENV[l.provider]})`));
  }
  return { chains: usable, skipped };
}

const warned = new Set<string>();
function warnOnce(message: string) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

/** Elige el proveedor según LLM_PROVIDER: real (por defecto; también «gemini», el valor antiguo) o mock. */
export function getProvider(env: Env = process.env): AgentProvider {
  const provider = (env.LLM_PROVIDER ?? "real").trim().toLowerCase();
  if (provider === "mock") {
    return new MockProvider(Number(env.MOCK_DELAY_MS ?? 1500));
  }
  if (provider !== "real" && provider !== "gemini") {
    throw new Error(`LLM_PROVIDER desconocido: ${provider} (usa real o mock)`);
  }
  const legacy = LEGACY_ENV.filter((name) => env[name] !== undefined);
  if (legacy.length) {
    warnOnce(`Variables que ya no se usan: ${legacy.join(", ")}. Los modelos se configuran con LLM_CHAIN_* (ver README).`);
  }
  const callers = createCallers(env);
  const { chains, skipped } = resolveUsableChains(env, (id) => Boolean(callers[id]));
  if (skipped.length) warnOnce(`Modelos saltados por falta de clave: ${skipped.join("; ")}`);
  return new ChainProvider(chains, callers);
}
