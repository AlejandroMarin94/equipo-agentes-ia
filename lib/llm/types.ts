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

export interface DevelopOutput {
  summary: string;
  changes: FileChange[];
}

export interface ReviewOutput {
  passed: boolean;
  results: CheckResult[];
}

export interface SummaryTask {
  title: string;
  status: TaskStatus;
  attempts: number;
  last_feedback: string | null;
}

/**
 * Lo que necesita el motor de cada agente. Hay dos implementaciones:
 * Gemini (real) y mock (determinista, para desarrollo y tests).
 */
export interface AgentProvider {
  readonly name: string;
  plan(input: { request: string; files: SiteFiles }): Promise<PlannedTask[]>;
  develop(input: {
    request: string;
    task: TaskInput;
    feedback: string | null;
    files: SiteFiles;
  }): Promise<DevelopOutput>;
  review(input: { request: string; task: TaskInput; files: SiteFiles }): Promise<ReviewOutput>;
  summarize(input: { request: string; tasks: SummaryTask[] }): Promise<string>;
}

/** Límite de peticiones o cuota del proveedor: el run no falla, se reintenta. */
export class RateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number, message = "Límite de la API") {
    super(message);
    this.name = "RateLimitError";
  }
}
