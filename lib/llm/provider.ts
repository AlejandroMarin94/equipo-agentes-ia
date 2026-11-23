import type { FileChange, SiteFiles } from "../types";
import { callChain, type AgentName, type LlmRequest, type ModelCaller } from "./chain";
import { DEVELOP_SCHEMA, PLAN_SCHEMA, REVIEW_SCHEMA, SUMMARY_SCHEMA } from "./schemas";
import type {
  AgentProvider,
  DevelopOutput,
  PlannedTask,
  PlanOutput,
  ReviewOutput,
  SummaryOutput,
  SummaryTask,
  TaskInput,
} from "./types";

const COMMON_RULES = `Trabajáis sobre una web estática pequeña (HTML, CSS y JS sin build) de un negocio ficticio.
Reglas de la web: rutas siempre relativas (nada que empiece por "/"), sin dependencias externas ni CDNs,
todas las páginas comparten cabecera, menú y pie, y todo el texto visible está en español.
La web se previsualiza en un iframe aislado: si usas localStorage, envuélvelo en try/catch.`;

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

/** Los agentes reales: cada uno con sus modelos de Claude, en orden (ver chain.ts). */
export class ClaudeProvider implements AgentProvider {
  readonly name = "claude";

  constructor(
    private readonly models: Record<AgentName, string[]>,
    private readonly caller: ModelCaller,
  ) {}

  private generate<T>(agent: AgentName, request: Pick<LlmRequest, "system" | "prompt" | "output">) {
    return callChain<T>(this.models[agent], this.caller, {
      ...request,
      system: `${request.system}\n\n${COMMON_RULES}`,
    });
  }

  async plan({ request, files }: { request: string; files: SiteFiles }): Promise<PlanOutput> {
    const { data, ...info } = await this.generate<{ tasks: PlannedTask[] }>("orchestrator", {
      system: `Eres el agente Orquestador de un equipo de tres agentes (Orquestador, Develop y Testing).
Divide la petición del usuario en entre 1 y 5 tareas de desarrollo pequeñas, ordenadas e independientes en lo posible.
Cada tarea lleva entre 1 y 4 criterios de aceptación concretos y verificables leyendo el código
(nombres de archivo, elementos, atributos o textos concretos). No incluyas tareas de pruebas ni de despliegue.
Testing revisa la web entera al terminar cada tarea (también los enlaces rotos), así que ordénalas para que
la web quede bien tras cada una: una página nueva se crea antes de enlazarla desde el menú, o en la misma tarea.`,
      prompt: `Petición del usuario: ${request}\n\nArchivos actuales de la web:\n\n${renderFiles(files)}`,
      output: PLAN_SCHEMA,
    });
    return { tasks: data.tasks, ...info };
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
    const { data, ...info } = await this.generate<{
      summary: string;
      changes: (Omit<FileChange, "content"> & { content?: string | null })[];
    }>("develop", {
      system: `Eres el agente Develop. Implementas una sola tarea sobre la web.
Devuelve solo los archivos que cambian. En create y update, "content" es el contenido COMPLETO del archivo
(no un diff ni un fragmento); en delete, "content" es null. No toques lo que no tenga que ver con la tarea,
pero la web entera debe quedar funcionando: si enlazas a un archivo que no existe, créalo en este mismo cambio.
"summary" explica en una o dos frases, en español, qué has cambiado.`,
      prompt: `Petición original: ${request}

${renderTask(task)}
${feedback ? `\nTesting rechazó el intento anterior. Corrige esto:\n${feedback}\n` : ""}
Archivos actuales de la web:

${renderFiles(files)}`,
      output: DEVELOP_SCHEMA,
    });
    const changes: FileChange[] = data.changes.map(({ content, ...change }) =>
      content == null ? change : { ...change, content },
    );
    return { summary: data.summary, changes, ...info };
  }

  async review({ request, task, files }: { request: string; task: TaskInput; files: SiteFiles }): Promise<ReviewOutput> {
    const { data, ...info } = await this.generate<ReviewOutput>("testing", {
      system: `Eres el agente Testing. Revisas si el código cumple cada criterio de aceptación de una tarea.
Evalúa cada criterio por separado leyendo los archivos; sé estricto pero no inventes requisitos nuevos.
Devuelve un resultado por criterio, en el mismo orden, con un motivo breve y concreto en español
(si falla, di exactamente qué falta y en qué archivo). "passed" es true solo si todos los criterios se cumplen.`,
      prompt: `Petición original: ${request}\n\n${renderTask(task)}\n\nArchivos de la web tras el trabajo de Develop:\n\n${renderFiles(files)}`,
      output: REVIEW_SCHEMA,
    });
    return { passed: data.passed, results: data.results, ...info };
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
    const { data, ...info } = await this.generate<{ summary: string }>("orchestrator", {
      system: `Eres el agente Orquestador. Redacta un resumen final breve (3-6 frases, en español) para el usuario:
qué se ha hecho y, si alguna tarea ha quedado bloqueada, por qué y qué haría falta para terminarla.`,
      prompt: `Petición: ${request}\n\nResultado de las tareas:\n${lines}`,
      output: SUMMARY_SCHEMA,
    });
    return { summary: data.summary, ...info };
  }
}
