import { shapeError, type JsonSchema } from "./schemas";
import { PublicError, RateLimitError, type ModelInfo } from "./types";

/**
 * Modelos de cada agente con respaldo, en orden: se prueba el primero y, si está saturado, sin tiempo,
 * en su límite de uso o no responde con JSON válido, el siguiente, en la misma llamada.
 */

export type AgentName = "orchestrator" | "develop" | "testing";

/** Opus como arquitecto (pocas llamadas, las que más pesan); Sonnet para el volumen de Develop y Testing. */
export const DEFAULT_MODELS: Record<AgentName, string> = {
  orchestrator: "claude-opus-5-5,claude-sonnet-5-5",
  develop: "claude-sonnet-5-5",
  testing: "claude-sonnet-5-5",
};

const MODELS_ENV: Record<AgentName, string> = {
  orchestrator: "CLAUDE_MODELS_ORCHESTRATOR",
  develop: "CLAUDE_MODELS_DEVELOP",
  testing: "CLAUDE_MODELS_TESTING",
};

/** Modelos separados por comas, sin repetir. */
export function parseModels(text: string): string[] {
  return [...new Set(text.split(",").map((s) => s.trim()).filter(Boolean))];
}

/** Los modelos de cada agente: su variable si tiene algo y, si no, los de por defecto. */
export function resolveModels(env: Record<string, string | undefined>): Record<AgentName, string[]> {
  const pick = (agent: AgentName) => parseModels(env[MODELS_ENV[agent]]?.trim() || DEFAULT_MODELS[agent]);
  return { orchestrator: pick("orchestrator"), develop: pick("develop"), testing: pick("testing") };
}

export interface LlmRequest {
  system: string;
  prompt: string;
  output: JsonSchema;
  timeoutMs: number;
}

/** Llama a un modelo concreto y devuelve el texto (JSON) de la respuesta; callWithFallback decide a cuál. */
export type ModelCaller = (model: string, request: LlmRequest) => Promise<string>;

/**
 * Fallo de un modelo que hace pasar al siguiente. overloaded y timeout son pasajeros (se reintenta
 * pronto); quota espera a que se renueve el límite de uso; unavailable e invalid_output son propios
 * del modelo. Lo que no tiene arreglo (sin sesión, credencial de pago) es FatalLlmError y no pasa por aquí.
 */
type FailureKind = "overloaded" | "timeout" | "quota" | "unavailable" | "invalid_output";

export class ModelError extends Error {
  constructor(
    public readonly kind: FailureKind,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

const FAILURE_LABEL: Record<FailureKind, string> = {
  overloaded: "saturado",
  timeout: "tiempo agotado",
  quota: "límite de uso",
  unavailable: "no disponible",
  invalid_output: "JSON no válido",
};

// Tiempo total de una llamada, respaldos incluidos. Por debajo de maxDuration (300 s)
// para que el paso tenga margen de guardar el error.
const REQUEST_TIMEOUT_MS = 240_000;
// Tiempo máximo de cada intento: Develop devuelve archivos completos y puede tardar más de un minuto.
const ATTEMPT_TIMEOUT_MS = 180_000;
// Sin al menos este margen no se prueba el siguiente intento.
const MIN_ATTEMPT_MS = 30_000;
export const DEFAULT_RETRY_SECONDS = 60;
const OVERLOADED_RETRY_SECONDS = 15;

/** Por si el modelo envuelve el JSON en un bloque ```json. */
function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}

/** JSON con la forma del esquema, o ModelError("invalid_output"). */
export function parseOutput<T>(text: string, output: JsonSchema): T {
  let data: unknown;
  try {
    data = JSON.parse(extractJson(text));
  } catch {
    throw new ModelError("invalid_output", `JSON no válido: ${text.slice(0, 200)}`);
  }
  const problem = shapeError(data, output);
  if (problem) throw new ModelError("invalid_output", `JSON con forma incorrecta: ${problem}`);
  return data as T;
}

/** El prompt del segundo intento cuando la respuesta no era JSON válido. */
function correctionPrompt(prompt: string, problem: string): string {
  return `${prompt}\n\nTu respuesta anterior no era válida (${problem}). Responde de nuevo SOLO con el objeto JSON que sigue el esquema, sin texto alrededor.`;
}

/**
 * Prueba los modelos en orden hasta que uno responda con JSON válido. Si un modelo responde con JSON
 * no válido, se le pide otra vez con el error y, si vuelve a fallar, se pasa al siguiente.
 * Un error que no es ModelError (sin sesión, credencial de pago, fallo de programación) se lanza sin
 * probar el resto. Si todos fallan y alguno fue por saturación o tiempo, RateLimitError a los 15 s
 * (no cuenta como error del run); si solo hubo límite de uso, la menor espera; si no, error con la lista.
 */
export async function callWithFallback<T>(
  models: string[],
  caller: ModelCaller,
  request: Omit<LlmRequest, "timeoutMs">,
): Promise<{ data: T } & Required<ModelInfo>> {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  const failed: string[] = [];
  let transient = false;
  let quotaRetrySeconds: number | null = null;
  let lastError: ModelError | null = null;

  for (const model of models) {
    let prompt = request.prompt;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const remaining = deadline - Date.now();
      if ((failed.length > 0 || attempt > 1) && remaining < MIN_ATTEMPT_MS) break;
      try {
        const text = await caller(model, { ...request, prompt, timeoutMs: Math.min(remaining, ATTEMPT_TIMEOUT_MS) });
        const data = parseOutput<T>(text, request.output);
        return { data, model, fallbackFrom: failed };
      } catch (error) {
        if (!(error instanceof ModelError)) throw error;
        lastError = error;
        if (error.kind === "invalid_output" && attempt === 1) {
          prompt = correctionPrompt(request.prompt, error.message);
          continue;
        }
        failed.push(`${model} (${FAILURE_LABEL[error.kind]})`);
        if (error.kind === "overloaded" || error.kind === "timeout") transient = true;
        if (error.kind === "quota") {
          const delay = error.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS;
          quotaRetrySeconds = Math.min(quotaRetrySeconds ?? delay, delay);
        }
        break;
      }
    }
  }

  if (transient) throw new RateLimitError(OVERLOADED_RETRY_SECONDS, failed.join(", "), true);
  if (quotaRetrySeconds !== null) throw new RateLimitError(quotaRetrySeconds, failed.join(", "));
  throw new PublicError(`Ningún modelo ha respondido (${failed.join(", ") || "sin tiempo"}).`, lastError?.message);
}
