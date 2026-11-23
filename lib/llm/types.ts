import type { CheckResult, FileChange, SiteFiles, TaskStatus } from "../types";

export interface PlannedTask {
  title: string;
  description: string;
  acceptance_criteria: string[];
}

export interface TaskInput extends PlannedTask {
  position: number;
  attempts: number;
}

/** Modelo que ha respondido; si hubo respaldo, los que fallaron antes («modelo (saturado)»). El mock no lo rellena. */
export interface ModelInfo {
  model?: string;
  fallbackFrom?: string[];
}

export interface PlanOutput extends ModelInfo {
  tasks: PlannedTask[];
}

export interface DevelopOutput extends ModelInfo {
  summary: string;
  changes: FileChange[];
}

export interface ReviewOutput extends ModelInfo {
  passed: boolean;
  results: CheckResult[];
}

export interface SummaryOutput extends ModelInfo {
  summary: string;
}

export interface SummaryTask {
  title: string;
  status: TaskStatus;
  attempts: number;
  last_feedback: string | null;
}

/**
 * Lo que necesita el motor de cada agente. Hay dos implementaciones:
 * Claude (provider.ts) y mock (determinista, para desarrollo y tests).
 */
export interface AgentProvider {
  readonly name: string;
  plan(input: { request: string; files: SiteFiles }): Promise<PlanOutput>;
  develop(input: {
    request: string;
    task: TaskInput;
    feedback: string | null;
    files: SiteFiles;
  }): Promise<DevelopOutput>;
  review(input: { request: string; task: TaskInput; files: SiteFiles }): Promise<ReviewOutput>;
  summarize(input: { request: string; tasks: SummaryTask[] }): Promise<SummaryOutput>;
}

/** Límite de uso de la suscripción o modelos saturados: el run no falla, se reintenta. */
export class RateLimitError extends Error {
  constructor(
    public readonly retryAfterSeconds: number,
    message = "Límite de uso",
    /** true si los modelos están saturados o sin tiempo, y no es solo el límite de uso. */
    public readonly overloaded = false,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

/**
 * Error cuyo mensaje se puede enseñar al usuario (registro de la ejecución). El detalle técnico
 * (salida del CLI, error de base de datos…) va aparte en `detail` y solo llega al log del servidor.
 */
export class PublicError extends Error {
  constructor(
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "PublicError";
  }
}

/** Mensaje con el detalle técnico, para el log y los scripts (nunca para la interfaz). */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error instanceof PublicError && error.detail ? `${error.message} (${error.detail})` : error.message;
}

/**
 * Fallo que no se arregla reintentando: sin sesión ni token, credencial que no es la suscripción,
 * configuración incorrecta o un prompt por encima del umbral de seguridad. El run se marca como failed en el acto, con el motivo.
 */
export class FatalLlmError extends PublicError {
  constructor(message: string, detail?: string) {
    super(message, detail);
    this.name = "FatalLlmError";
  }
}
