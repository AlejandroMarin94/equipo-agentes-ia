import type { Agent, EventKind, Run, SiteFiles, Task } from "../types";

export interface NewTask {
  position: number;
  title: string;
  description: string;
  acceptance_criteria: string[];
}

export interface NewEvent {
  run_id: string;
  task_id?: string | null;
  agent: Agent;
  kind: EventKind;
  message: string;
  payload?: unknown;
}

export interface RunLimits {
  /** Ejecuciones de todos los usuarios juntos en la última hora. */
  maxRunsPerHour: number;
  /** Ejecuciones de cada usuario en 24 horas. */
  maxRunsPerDay: number;
  /** Reloj del repositorio en memoria; Postgres usa el suyo. */
  now: Date;
}

/** Se ha llegado a un límite de ejecuciones. `releaseAt`: cuándo queda libre el siguiente hueco por hora. */
export class RunLimitError extends Error {
  constructor(
    public readonly limit: "day" | "hour",
    public readonly releaseAt: Date | null = null,
  ) {
    super(limit === "day" ? "Límite diario de ejecuciones" : "Límite de ejecuciones por hora");
    this.name = "RunLimitError";
  }
}

export type RunPatch = Partial<Pick<Run, "status" | "summary" | "error_count" | "locked_until">>;
export type TaskPatch = Partial<Pick<Task, "status" | "attempts" | "last_feedback">>;

/**
 * Acceso a datos que necesita el motor. En producción lo implementa
 * Supabase (con la service role key); en los tests, una versión en memoria.
 */
export interface Repository {
  /**
   * Crea el run si no se supera ningún límite, de forma atómica (contar e insertar a la vez; si no,
   * varias creaciones simultáneas pasarían todas). Si se supera, RunLimitError. Devuelve el id.
   */
  createRun(userId: string, request: string, limits: RunLimits): Promise<string>;
  getRun(runId: string): Promise<Run | null>;
  /** Bloquea el run hasta `until` si no está bloqueado ni terminado. Devuelve si lo ha conseguido. */
  tryLock(runId: string, until: Date, now: Date): Promise<boolean>;
  updateRun(runId: string, patch: RunPatch): Promise<void>;
  listTasks(runId: string): Promise<Task[]>;
  insertTasks(runId: string, tasks: NewTask[]): Promise<void>;
  updateTask(taskId: string, patch: TaskPatch): Promise<void>;
  getFiles(runId: string): Promise<SiteFiles>;
  saveFiles(runId: string, upserts: SiteFiles, deletes: string[]): Promise<void>;
  addEvent(event: NewEvent): Promise<void>;
}
