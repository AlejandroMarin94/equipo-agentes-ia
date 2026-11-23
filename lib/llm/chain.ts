import { shapeError, type OutputSchema } from "./schemas";
import { RateLimitError, type ModelInfo } from "./types";

/**
 * Cadena de modelos de cada agente: se prueba el primero y, si falla por algo pasajero o propio
 * de ese modelo (saturación, cuota, plan, tamaño, JSON inválido…), el siguiente, en la misma llamada.
 */

export const PROVIDER_IDS = ["groq", "mistral", "gemini"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Variable con la clave de cada proveedor. */
export const API_KEY_ENV: Record<ProviderId, string> = {
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export type AgentName = "orchestrator" | "develop" | "testing";

export interface ChainLink {
  provider: ProviderId;
  model: string;
  /** Opciones extra del modelo (`?reasoning_effort=low`). `format` es reservada (json_schema | json_object). */
  options: Record<string, string>;
  /** «proveedor/modelo», lo que se ve en el registro. */
  label: string;
}

export interface LlmRequest {
  system: string;
  prompt: string;
  output: OutputSchema;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

/** Llama a un modelo y devuelve el texto (JSON) de la respuesta. */
export type LinkCaller = (link: ChainLink, request: LlmRequest) => Promise<string>;

/**
 * Fallo de un modelo que hace pasar al siguiente de la cadena.
 * overloaded y timeout son pasajeros (se reintenta pronto); quota espera lo que diga la API;
 * el resto (unavailable, too_large, invalid_output, auth) son propios del modelo o de la petición.
 */
export type FailureKind = "overloaded" | "timeout" | "quota" | "unavailable" | "too_large" | "invalid_output" | "auth";

export class LinkError extends Error {
  constructor(
    public readonly kind: FailureKind,
    message: string,
    public readonly status?: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "LinkError";
  }
}

const UNAVAILABLE_PATTERN = /subscription tier|not available|no longer available|does not exist|model_not_found|invalid model|unknown model/i;

/**
 * Traduce un código HTTP a un fallo de la cadena, o null si es un error que no se arregla con otro
 * modelo (p. ej. un 400 por una petición mal formada), que se lanza tal cual.
 */
export function errorFromStatus(status: number, message: string, retryAfterSeconds?: number): LinkError | null {
  if (status === 429) return new LinkError("quota", message, status, retryAfterSeconds);
  if (status === 503 || status === 502 || status === 500) return new LinkError("overloaded", message, status);
  if (status === 504) return new LinkError("timeout", message, status);
  if (status === 413) return new LinkError("too_large", message, status);
  if (status === 404) return new LinkError("unavailable", message, status);
  // «not available in your subscription tier» (Mistral) puede llegar como 400, 401 o 403.
  if (UNAVAILABLE_PATTERN.test(message)) return new LinkError("unavailable", message, status);
  // Clave rechazada: el resto de proveedores tienen la suya.
  if (status === 401 || status === 403) return new LinkError("auth", message, status);
  return null;
}

const FAILURE_LABEL: Record<FailureKind, (e: LinkError) => string> = {
  overloaded: (e) => String(e.status ?? "saturado"),
  timeout: (e) => (e.status ? String(e.status) : "tiempo agotado"),
  quota: (e) => String(e.status ?? 429),
  unavailable: (e) => `${e.status ? `${e.status}, ` : ""}no disponible`,
  too_large: (e) => String(e.status ?? "petición demasiado grande"),
  invalid_output: () => "JSON no válido",
  auth: (e) => `${e.status}, clave rechazada`,
};

// ---------------------------------------------------------------------------------------------
// Configuración: LLM_CHAIN_ORCHESTRATOR / _DEVELOP / _TESTING

/**
 * Por defecto (todo en plan gratuito, sin tarjeta). Groq es el más rápido pero con ~8 K tokens/min por
 * petición; Mistral aguanta peticiones grandes (Develop devuelve archivos completos); Gemini, al final
 * porque su plan gratuito está casi siempre saturado.
 */
export const DEFAULT_CHAINS: Record<AgentName, string> = {
  orchestrator:
    "groq/openai/gpt-oss-120b?reasoning_effort=low,groq/qwen/qwen3.8-27b,mistral/mistral-small-2603,gemini/gemini-3.5-flash",
  develop:
    "mistral/mistral-large-4,mistral/mistral-small-2603,groq/openai/gpt-oss-120b,gemini/gemini-3.5-flash-lite",
  testing:
    "groq/openai/gpt-oss-120b,groq/qwen/qwen3.8-27b,groq/openai/gpt-oss-20b,mistral/mistral-small-2603,gemini/gemini-3.5-flash-lite",
};

export const CHAIN_ENV: Record<AgentName, string> = {
  orchestrator: "LLM_CHAIN_ORCHESTRATOR",
  develop: "LLM_CHAIN_DEVELOP",
  testing: "LLM_CHAIN_TESTING",
};

/** Variables de la configuración anterior (solo Gemini), que ya no se leen. */
export const LEGACY_ENV = [
  "GEMINI_MODEL",
  "GEMINI_MODEL_ORCHESTRATOR",
  "GEMINI_MODEL_DEVELOP",
  "GEMINI_MODEL_TESTING",
  "GEMINI_FALLBACK_MODELS",
];

/**
 * «proveedor/modelo[?opcion=valor&…]» separados por comas. El modelo puede llevar barras
 * (groq/openai/gpt-oss-120b): el proveedor es lo que va antes de la primera.
 */
export function parseChain(text: string): ChainLink[] {
  const links: ChainLink[] = [];
  for (const raw of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [spec, query = ""] = raw.split("?", 2);
    const slash = spec.indexOf("/");
    const provider = spec.slice(0, slash).trim().toLowerCase();
    const model = spec.slice(slash + 1).trim();
    if (slash <= 0 || !model) throw new Error(`Eslabón «${raw}» no válido: el formato es proveedor/modelo`);
    if (!(PROVIDER_IDS as readonly string[]).includes(provider)) {
      throw new Error(`Proveedor desconocido en «${raw}»: usa ${PROVIDER_IDS.join(", ")}`);
    }
    const options = Object.fromEntries(
      query
        .split("&")
        .filter(Boolean)
        .map((pair) => {
          const [key, value = ""] = pair.split("=", 2);
          return [key.trim(), value.trim()];
        }),
    );
    const label = `${provider}/${model}`;
    if (links.some((l) => l.label === label)) continue;
    links.push({ provider: provider as ProviderId, model, options, label });
  }
  return links;
}

/** La cadena de cada agente: su variable si tiene algo y, si no, la de por defecto. */
export function resolveChains(env: Record<string, string | undefined>): Record<AgentName, ChainLink[]> {
  const pick = (agent: AgentName) => parseChain(env[CHAIN_ENV[agent]]?.trim() || DEFAULT_CHAINS[agent]);
  return { orchestrator: pick("orchestrator"), develop: pick("develop"), testing: pick("testing") };
}

/**
 * Quita los eslabones cuyo proveedor no tiene clave. Devuelve los que quedan y los saltados,
 * para registrarlos. Sin ninguno disponible, error de configuración.
 */
export function usableLinks(
  agent: AgentName,
  links: ChainLink[],
  available: (provider: ProviderId) => boolean,
): { links: ChainLink[]; skipped: ChainLink[] } {
  const usable = links.filter((l) => available(l.provider));
  const skipped = links.filter((l) => !available(l.provider));
  if (usable.length === 0) {
    const missing = [...new Set(links.map((l) => API_KEY_ENV[l.provider]))].join(" o ");
    throw new Error(
      `Ningún modelo de la cadena de ${agent} tiene clave: falta ${missing} (o usa LLM_PROVIDER=mock)`,
    );
  }
  return { links: usable, skipped };
}

// ---------------------------------------------------------------------------------------------
// Bucle de respaldo

// Tiempo total de una llamada, respaldos incluidos. Por debajo de maxDuration (300 s)
// para que el paso tenga margen de guardar el error.
export const REQUEST_TIMEOUT_MS = 240_000;
// Tiempo máximo de cada modelo. Con el plan gratuito de Gemini saturado, un modelo puede tardar ~220 s
// en dar un 503: sin este tope se comería todo el paso y no quedaría tiempo para el respaldo.
export const ATTEMPT_TIMEOUT_MS = 120_000;
// Sin al menos este margen no se prueba el siguiente modelo de la cadena.
const MIN_ATTEMPT_MS = 20_000;
export const DEFAULT_RETRY_SECONDS = 30;
const OVERLOADED_RETRY_SECONDS = 15;

/** Corte del lado del cliente por el tope de tiempo (si el servidor no llegó a responder 504). */
const isClientTimeout = (error: unknown) =>
  error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

/** Algunos modelos de razonamiento envuelven la respuesta en <think>…</think> o en un bloque ```json. */
function extractJson(text: string): string {
  const withoutThink = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fenced = withoutThink.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : withoutThink;
}

/** JSON con la forma del esquema, o LinkError("invalid_output"). */
export function parseOutput<T>(text: string, output: OutputSchema): T {
  let data: unknown;
  try {
    data = JSON.parse(extractJson(text));
  } catch {
    throw new LinkError("invalid_output", `JSON no válido: ${text.slice(0, 200)}`);
  }
  const problem = shapeError(data, output.schema);
  if (problem) throw new LinkError("invalid_output", `JSON con forma incorrecta: ${problem}`);
  return data as T;
}

/**
 * Prueba los modelos de la cadena en orden hasta que uno responda con JSON válido.
 * Si todos fallan por saturación o tiempo, RateLimitError a los 15 s (no cuenta como error del run);
 * si solo hubo cuota agotada (429), la menor espera que haya pedido la API; si no, el run registra
 * el error con la lista de lo que ha fallado.
 */
export async function callChain<T>(
  links: ChainLink[],
  callers: Partial<Record<ProviderId, LinkCaller>>,
  request: Omit<LlmRequest, "timeoutMs">,
): Promise<{ data: T } & Required<ModelInfo>> {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  const failed: string[] = [];
  let transient = false;
  let quotaRetrySeconds: number | null = null;
  let lastError: unknown = null;

  for (const link of links) {
    const caller = callers[link.provider];
    if (!caller) continue;
    const remaining = deadline - Date.now();
    if (failed.length > 0 && remaining < MIN_ATTEMPT_MS) break;
    try {
      const text = await caller(link, { ...request, timeoutMs: Math.min(remaining, ATTEMPT_TIMEOUT_MS) });
      const data = parseOutput<T>(text, request.output);
      return { data, model: link.label, fallbackFrom: failed };
    } catch (error) {
      lastError = error;
      if (isClientTimeout(error)) {
        failed.push(`${link.label} (tiempo agotado)`);
        transient = true;
        continue;
      }
      if (!(error instanceof LinkError)) throw error;
      failed.push(`${link.label} (${FAILURE_LABEL[error.kind](error)})`);
      if (error.kind === "overloaded" || error.kind === "timeout") transient = true;
      if (error.kind === "quota") {
        const delay = error.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS;
        quotaRetrySeconds = Math.min(quotaRetrySeconds ?? delay, delay);
      }
    }
  }

  if (transient) throw new RateLimitError(OVERLOADED_RETRY_SECONDS, failed.join(", "), true);
  if (quotaRetrySeconds !== null) throw new RateLimitError(quotaRetrySeconds, failed.join(", "));
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Ningún modelo de la cadena ha respondido (${failed.join(", ")}). Último error: ${detail}`);
}
