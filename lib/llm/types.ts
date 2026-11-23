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

/** Modelo que ha respondido; si hubo respaldo, los que fallaron antes («modelo (503)»). El mock no lo rellena. */
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
 * la cadena de modelos reales (provider.ts) y mock (determinista, para desarrollo y tests).
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

/** Límite de peticiones, cuota o modelos saturados: el run no falla, se reintenta. */
export class RateLimitError extends Error {
  constructor(
    public readonly retryAfterSeconds: number,
    message = "Límite de la API",
    /** true si los modelos están saturados o sin tiempo (503/504) y no es solo cuota (429). */
    public readonly overloaded = false,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}
