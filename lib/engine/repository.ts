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

export type RunPatch = Partial<Pick<Run, "status" | "summary" | "error_count" | "locked_until">>;
export type TaskPatch = Partial<Pick<Task, "status" | "attempts" | "last_feedback">>;

/**
 * Acceso a datos que necesita el motor. En producción lo implementa
 * Supabase (con la service role key); en los tests, una versión en memoria.
 */
export interface Repository {
  createRun(userId: string, request: string): Promise<string>;
  countRunsSince(userId: string, since: Date): Promise<number>;
  /** Fechas de creación de los runs de TODOS los usuarios desde `since`, de la más antigua a la más reciente. */
  listRunCreationsSince(since: Date): Promise<Date[]>;
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
