export type RunStatus =
  | "planning"
  | "developing"
  | "testing"
  | "summarizing"
  | "done"
  | "failed";

export type TaskStatus =
  | "pending"
  | "developing"
  | "testing"
  | "failed"
  | "done"
  | "blocked";

export type Agent = "orchestrator" | "develop" | "testing" | "system";

export type EventKind =
  | "thinking"
  | "plan"
  | "change"
  | "test_pass"
  | "test_fail"
  | "rate_limit"
  | "summary"
  | "error"
  | "info";

export interface Run {
  id: string;
  user_id: string;
  request: string;
  status: RunStatus;
  summary: string | null;
  error_count: number;
  locked_until: string | null;
  created_at: string;
}

export interface Task {
  id: string;
  run_id: string;
  position: number;
  title: string;
  description: string;
  acceptance_criteria: string[];
  status: TaskStatus;
  attempts: number;
  last_feedback: string | null;
  updated_at: string;
}

export interface RunEvent {
  id: number;
  run_id: string;
  task_id: string | null;
  agent: Agent;
  kind: EventKind;
  message: string;
  payload: unknown;
  created_at: string;
}

export interface RunFile {
  run_id: string;
  path: string;
  content: string;
  updated_at: string;
}

/** Archivos de la web: ruta → contenido. */
export type SiteFiles = Record<string, string>;

export interface FileChange {
  path: string;
  action: "create" | "update" | "delete";
  content?: string;
}

export interface CheckResult {
  criterion: string;
  ok: boolean;
  reason: string;
}

export const TERMINAL_STATUSES: RunStatus[] = ["done", "failed"];
