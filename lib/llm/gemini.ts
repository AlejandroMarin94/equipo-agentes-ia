import { ApiError, GoogleGenAI, Type, type Schema } from "@google/genai";
import type { FileChange, SiteFiles } from "../types";
import {
  RateLimitError,
  type AgentProvider,
  type DevelopOutput,
  type ModelInfo,
  type PlannedTask,
  type PlanOutput,
  type ReviewOutput,
  type SummaryOutput,
  type SummaryTask,
  type TaskInput,
} from "./types";

// Tiempo total de una llamada, respaldos incluidos. Por debajo de maxDuration (300 s)
// para que el paso tenga margen de guardar el error.
const REQUEST_TIMEOUT_MS = 240_000;
// Tiempo máximo de cada modelo de la cadena. El SDK se lo pasa al servidor (X-Server-Timeout), que
// responde 504 al agotarlo. Con el plan gratuito saturado, un modelo puede tardar ~220 s en dar un 503:
// sin este tope se comería todo el paso y no quedaría tiempo para el respaldo.
const ATTEMPT_TIMEOUT_MS = 120_000;
// Sin al menos este margen no se prueba el siguiente modelo de la cadena.
const MIN_ATTEMPT_MS = 20_000;
const DEFAULT_RETRY_SECONDS = 30;
const OVERLOADED_RETRY_SECONDS = 15;

// 503 (saturado) y 504 (DEADLINE_EXCEEDED) son pasajeros; 404 es un modelo que ya no está disponible para la clave.
const TRANSIENT_STATUSES = [503, 504];
const FALLBACK_STATUSES = [...TRANSIENT_STATUSES, 404];

/** Corte del lado del cliente por el tope de tiempo (si el servidor no llegó a responder 504). */
const isClientTimeout = (error: unknown) =>
  error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

const COMMON_RULES = `Trabajáis sobre una web estática pequeña (HTML, CSS y JS sin build) de un negocio ficticio.
Reglas de la web: rutas siempre relativas (nada que empiece por "/"), sin dependencias externas ni CDNs,
todas las páginas comparten cabecera, menú y pie, y todo el texto visible está en español.
La web se previsualiza en un iframe aislado: si usas localStorage, envuélvelo en try/catch.`;

const planSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    tasks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          description: { type: Type.STRING },
          acceptance_criteria: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ["title", "description", "acceptance_criteria"],
      },
    },
  },
  required: ["tasks"],
};

const developSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    changes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          path: { type: Type.STRING },
          action: { type: Type.STRING, enum: ["create", "update", "delete"] },
          content: { type: Type.STRING },
        },
        required: ["path", "action"],
      },
    },
  },
  required: ["summary", "changes"],
};

const reviewSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    passed: { type: Type.BOOLEAN },
    results: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          criterion: { type: Type.STRING },
          ok: { type: Type.BOOLEAN },
          reason: { type: Type.STRING },
        },
        required: ["criterion", "ok", "reason"],
      },
    },
  },
  required: ["passed", "results"],
};

const summarySchema: Schema = {
  type: Type.OBJECT,
  properties: { summary: { type: Type.STRING } },
  required: ["summary"],
};

function renderFiles(files: SiteFiles): string {
  return Object.keys(files)
    .sort()
    .map((path) => `=== ${path} ===\n${files[path]}`)
    .join("\n\n");
}

function renderTask(task: TaskInput): string {
  return `Tarea: ${task.title}
Descripción: ${task.description}
Criterios de aceptación:
${task.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`;
}

/** Extrae el retraso sugerido por la API ("retryDelay": "37s") o usa uno por defecto. */
export function parseRetryDelay(message: string): number {
  const match = message.match(/retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s/);
  return match ? Math.ceil(Number(match[1])) : DEFAULT_RETRY_SECONDS;
}

/** Modelo de cada agente: el Orquestador hace pocas llamadas; Develop y Testing, muchas. */
export interface GeminiModels {
  orchestrator: string;
  develop: string;
  testing: string;
}

/**
 * Por defecto: Flash para el Orquestador y Flash-Lite (más cuota gratuita) para Develop y Testing.
 * Comprobados con una clave del plan gratuito el 23/11/2026: gemini-3.8-flash y gemini-3.7-flash
 * daban 503 de forma repetida y gemini-3.6-flash, 503/504 tras esperas de 90-220 s; gemini-3.5-flash
 * y los Flash-Lite respondían con JSON estructurado (los Flash-Lite, con 503 rápidos a ratos).
 */
export const DEFAULT_GEMINI_MODELS: GeminiModels = {
  orchestrator: "gemini-3.5-flash",
  develop: "gemini-3.5-flash-lite",
  testing: "gemini-3.5-flash-lite",
};

/** Modelos que se prueban, en orden, si el del agente está saturado o no disponible. */
export const DEFAULT_FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3.6-flash"];

/** GEMINI_MODEL_<AGENTE>, si no GEMINI_MODEL y si no el valor por defecto de cada agente. */
export function resolveGeminiModels(env: Record<string, string | undefined>): GeminiModels {
  const pick = (specific: string | undefined, fallback: string) =>
    specific?.trim() || env.GEMINI_MODEL?.trim() || fallback;
  return {
    orchestrator: pick(env.GEMINI_MODEL_ORCHESTRATOR, DEFAULT_GEMINI_MODELS.orchestrator),
    develop: pick(env.GEMINI_MODEL_DEVELOP, DEFAULT_GEMINI_MODELS.develop),
    testing: pick(env.GEMINI_MODEL_TESTING, DEFAULT_GEMINI_MODELS.testing),
  };
}

/** GEMINI_FALLBACK_MODELS separados por comas; vacía = sin respaldo; sin definir = los de por defecto. */
export function resolveFallbackModels(env: Record<string, string | undefined>): string[] {
  if (env.GEMINI_FALLBACK_MODELS === undefined) return DEFAULT_FALLBACK_MODELS;
  return env.GEMINI_FALLBACK_MODELS.split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

const isLite = (model: string) => model.includes("lite");

/**
 * Modelos que se prueban para un agente: el suyo y luego los de respaldo, primero los de su
 * misma gama (Flash-Lite con Flash-Lite, Flash con Flash) para no gastar la cuota de la otra.
 */
export function modelChain(primary: string, fallbacks: string[]): string[] {
  const rest = [...new Set(fallbacks)].filter((m) => m !== primary);
  const sameTier = rest.filter((m) => isLite(m) === isLite(primary));
  const otherTier = rest.filter((m) => isLite(m) !== isLite(primary));
  return [primary, ...sameTier, ...otherTier];
}

export class GeminiProvider implements AgentProvider {
  readonly name = "gemini";
  private readonly client: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly models: GeminiModels,
    private readonly fallbacks: string[] = DEFAULT_FALLBACK_MODELS,
  ) {
    this.client = new GoogleGenAI({ apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS } });
  }

  /**
   * Llama al modelo del agente y, si está saturado (503), agota su tiempo (504 o corte del cliente)
   * o ya no está disponible (404), prueba el siguiente de la cadena. Si todos fallan por
   * saturación o tiempo, RateLimitError: el paso se reintenta más tarde sin contar como error.
   */
  private async generate<T>(
    model: string,
    system: string,
    prompt: string,
    schema: Schema,
  ): Promise<{ data: T } & Required<ModelInfo>> {
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    const failed: string[] = [];
    let transient = false;
    let lastError: unknown = null;

    for (const candidate of modelChain(model, this.fallbacks)) {
      const remaining = deadline - Date.now();
      if (failed.length > 0 && remaining < MIN_ATTEMPT_MS) break;
      try {
        const response = await this.client.models.generateContent({
          model: candidate,
          contents: prompt,
          config: {
            systemInstruction: `${system}\n\n${COMMON_RULES}`,
            responseMimeType: "application/json",
            responseSchema: schema,
            temperature: 0.3,
            httpOptions: { timeout: Math.min(remaining, ATTEMPT_TIMEOUT_MS) },
          },
        });
        const text = response.text;
        if (!text) throw new Error(`El modelo ${candidate} no ha devuelto contenido`);
        return { data: JSON.parse(text) as T, model: candidate, fallbackFrom: failed };
      } catch (error) {
        if (error instanceof ApiError && error.status === 429) {
          throw new RateLimitError(parseRetryDelay(error.message), error.message);
        }
        if (error instanceof ApiError && FALLBACK_STATUSES.includes(error.status)) {
          failed.push(`${candidate} (${error.status})`);
          transient ||= TRANSIENT_STATUSES.includes(error.status);
          lastError = error;
          continue;
        }
        if (isClientTimeout(error)) {
          failed.push(`${candidate} (tiempo agotado)`);
          transient = true;
          lastError = error;
          continue;
        }
        throw error;
      }
    }

    // Frecuente en el plan gratuito y pasajero: no debe contar como error del run.
    if (transient) {
      throw new RateLimitError(OVERLOADED_RETRY_SECONDS, failed.join(", "), true);
    }
    throw lastError;
  }

  async plan({ request, files }: { request: string; files: SiteFiles }): Promise<PlanOutput> {
    const { data, ...info } = await this.generate<{ tasks: PlannedTask[] }>(
      this.models.orchestrator,
      `Eres el agente Orquestador de un equipo de tres agentes (Orquestador, Develop y Testing).
Divide la petición del usuario en entre 1 y 5 tareas de desarrollo pequeñas, ordenadas e independientes en lo posible.
Cada tarea lleva entre 1 y 4 criterios de aceptación concretos y verificables leyendo el código
(nombres de archivo, elementos, atributos o textos concretos). No incluyas tareas de pruebas ni de despliegue.`,
      `Petición del usuario: ${request}\n\nArchivos actuales de la web:\n\n${renderFiles(files)}`,
      planSchema,
    );
    return { tasks: data.tasks ?? [], ...info };
  }

  async develop({
    request,
    task,
    feedback,
    files,
  }: {
    request: string;
    task: TaskInput;
    feedback: string | null;
    files: SiteFiles;
  }): Promise<DevelopOutput> {
    const { data, ...info } = await this.generate<{ summary: string; changes: FileChange[] }>(
      this.models.develop,
      `Eres el agente Develop. Implementas una sola tarea sobre la web.
Devuelve solo los archivos que cambian. En create y update, "content" es el contenido COMPLETO del archivo
(no un diff ni un fragmento). No toques lo que no tenga que ver con la tarea.
"summary" explica en una o dos frases, en español, qué has cambiado.`,
      `Petición original: ${request}

${renderTask(task)}
${feedback ? `\nTesting rechazó el intento anterior. Corrige esto:\n${feedback}\n` : ""}
Archivos actuales de la web:

${renderFiles(files)}`,
      developSchema,
    );
    return { summary: data.summary ?? "", changes: data.changes ?? [], ...info };
  }

  async review({ request, task, files }: { request: string; task: TaskInput; files: SiteFiles }): Promise<ReviewOutput> {
    const { data, ...info } = await this.generate<ReviewOutput>(
      this.models.testing,
      `Eres el agente Testing. Revisas si el código cumple cada criterio de aceptación de una tarea.
Evalúa cada criterio por separado leyendo los archivos; sé estricto pero no inventes requisitos nuevos.
Devuelve un resultado por criterio, en el mismo orden, con un motivo breve y concreto en español
(si falla, di exactamente qué falta y en qué archivo). "passed" es true solo si todos los criterios se cumplen.`,
      `Petición original: ${request}\n\n${renderTask(task)}\n\nArchivos de la web tras el trabajo de Develop:\n\n${renderFiles(files)}`,
      reviewSchema,
    );
    return { passed: Boolean(data.passed), results: data.results ?? [], ...info };
  }

  async summarize({ request, tasks }: { request: string; tasks: SummaryTask[] }): Promise<SummaryOutput> {
    const lines = tasks
      .map(
        (t) =>
          `- ${t.title}: ${t.status === "done" ? "hecha" : "bloqueada"} (fallos de Testing: ${t.attempts})${
            t.status === "blocked" && t.last_feedback ? `. Último fallo: ${t.last_feedback}` : ""
          }`,
      )
      .join("\n");
    const { data, ...info } = await this.generate<{ summary: string }>(
      this.models.orchestrator,
      `Eres el agente Orquestador. Redacta un resumen final breve (3-6 frases, en español) para el usuario:
qué se ha hecho y, si alguna tarea ha quedado bloqueada, por qué y qué haría falta para terminarla.`,
      `Petición: ${request}\n\nResultado de las tareas:\n${lines}`,
      summarySchema,
    );
    return { summary: data.summary ?? "", ...info };
  }
}
