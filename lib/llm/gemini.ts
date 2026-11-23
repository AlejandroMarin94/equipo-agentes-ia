import { ApiError, GoogleGenAI, Type, type Schema } from "@google/genai";
import type { FileChange, SiteFiles } from "../types";
import {
  RateLimitError,
  type AgentProvider,
  type DevelopOutput,
  type PlannedTask,
  type ReviewOutput,
  type SummaryTask,
  type TaskInput,
} from "./types";

const REQUEST_TIMEOUT_MS = 50_000;
const DEFAULT_RETRY_SECONDS = 30;

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

export class GeminiProvider implements AgentProvider {
  readonly name = "gemini";
  private readonly client: GoogleGenAI;

  constructor(apiKey: string, private readonly model: string) {
    this.client = new GoogleGenAI({ apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS } });
  }

  private async generate<T>(system: string, prompt: string, schema: Schema): Promise<T> {
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: prompt,
        config: {
          systemInstruction: `${system}\n\n${COMMON_RULES}`,
          responseMimeType: "application/json",
          responseSchema: schema,
          temperature: 0.3,
        },
      });
      const text = response.text;
      if (!text) throw new Error("El modelo no ha devuelto contenido");
      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        throw new RateLimitError(parseRetryDelay(error.message), error.message);
      }
      throw error;
    }
  }

  async plan({ request, files }: { request: string; files: SiteFiles }): Promise<PlannedTask[]> {
    const out = await this.generate<{ tasks: PlannedTask[] }>(
      `Eres el agente Orquestador de un equipo de tres agentes (Orquestador, Develop y Testing).
Divide la petición del usuario en entre 1 y 5 tareas de desarrollo pequeñas, ordenadas e independientes en lo posible.
Cada tarea lleva entre 1 y 4 criterios de aceptación concretos y verificables leyendo el código
(nombres de archivo, elementos, atributos o textos concretos). No incluyas tareas de pruebas ni de despliegue.`,
      `Petición del usuario: ${request}\n\nArchivos actuales de la web:\n\n${renderFiles(files)}`,
      planSchema,
    );
    return out.tasks ?? [];
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
    const out = await this.generate<{ summary: string; changes: FileChange[] }>(
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
    return { summary: out.summary ?? "", changes: out.changes ?? [] };
  }

  async review({ request, task, files }: { request: string; task: TaskInput; files: SiteFiles }): Promise<ReviewOutput> {
    const out = await this.generate<ReviewOutput>(
      `Eres el agente Testing. Revisas si el código cumple cada criterio de aceptación de una tarea.
Evalúa cada criterio por separado leyendo los archivos; sé estricto pero no inventes requisitos nuevos.
Devuelve un resultado por criterio, en el mismo orden, con un motivo breve y concreto en español
(si falla, di exactamente qué falta y en qué archivo). "passed" es true solo si todos los criterios se cumplen.`,
      `Petición original: ${request}\n\n${renderTask(task)}\n\nArchivos de la web tras el trabajo de Develop:\n\n${renderFiles(files)}`,
      reviewSchema,
    );
    return { passed: Boolean(out.passed), results: out.results ?? [] };
  }

  async summarize({ request, tasks }: { request: string; tasks: SummaryTask[] }): Promise<string> {
    const lines = tasks
      .map(
        (t) =>
          `- ${t.title}: ${t.status === "done" ? "hecha" : "bloqueada"} (fallos de Testing: ${t.attempts})${
            t.status === "blocked" && t.last_feedback ? `. Último fallo: ${t.last_feedback}` : ""
          }`,
      )
      .join("\n");
    const out = await this.generate<{ summary: string }>(
      `Eres el agente Orquestador. Redacta un resumen final breve (3-6 frases, en español) para el usuario:
qué se ha hecho y, si alguna tarea ha quedado bloqueada, por qué y qué haría falta para terminarla.`,
      `Petición: ${request}\n\nResultado de las tareas:\n${lines}`,
      summarySchema,
    );
    return out.summary ?? "";
  }
}
