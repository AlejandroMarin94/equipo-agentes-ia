import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  RunLimitError,
  type NewEvent,
  type NewTask,
  type Repository,
  type RunLimits,
  type RunPatch,
  type TaskPatch,
} from "../engine/repository";
import type { Run, SiteFiles, Task } from "../types";
import { createAdminClient } from "./admin";

function check<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`Error de base de datos (${what}): ${result.error.message}`);
  return result.data;
}

/** Repositorio del motor sobre Supabase. Escribe con la service role key. */
export class SupabaseRepository implements Repository {
  constructor(private readonly db: SupabaseClient = createAdminClient()) {}

  async createRun(userId: string, request: string, { maxRunsPerHour, maxRunsPerDay }: RunLimits) {
    // Función de supabase/migrations/0002_create_run_atomico.sql: cuenta e inserta en una transacción.
    const result = await this.db.rpc("create_run", {
      p_user_id: userId,
      p_request: request,
      p_max_per_hour: maxRunsPerHour,
      p_max_per_day: maxRunsPerDay,
    });
    if (result.error?.message === "run_limit_day") throw new RunLimitError("day");
    if (result.error?.message === "run_limit_hour") {
      const releaseAt = Number(result.error.details);
      throw new RunLimitError("hour", Number.isFinite(releaseAt) ? new Date(releaseAt) : null);
    }
    return (check(result, "crear run") as Run).id;
  }

  async getRun(runId: string) {
    return check(await this.db.from("runs").select("*").eq("id", runId).maybeSingle(), "leer run") as Run | null;
  }

  async tryLock(runId: string, until: Date, now: Date) {
    // Update condicional: solo una petición puede ganar el bloqueo.
    const data = check(
      await this.db
        .from("runs")
        .update({ locked_until: until.toISOString() })
        .eq("id", runId)
        .not("status", "in", "(done,failed)")
        .or(`locked_until.is.null,locked_until.lt."${now.toISOString()}"`)
        .select("id"),
      "bloquear run",
    );
    return (data ?? []).length > 0;
  }

  async updateRun(runId: string, patch: RunPatch) {
    check(await this.db.from("runs").update(patch).eq("id", runId), "actualizar run");
  }

  async listTasks(runId: string) {
    return check(
      await this.db.from("tasks").select("*").eq("run_id", runId).order("position"),
      "leer tareas",
    ) as Task[];
  }

  async insertTasks(runId: string, tasks: NewTask[]) {
    check(await this.db.from("tasks").insert(tasks.map((t) => ({ ...t, run_id: runId }))), "crear tareas");
  }

  async updateTask(taskId: string, patch: TaskPatch) {
    check(
      await this.db.from("tasks").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", taskId),
      "actualizar tarea",
    );
  }

  async getFiles(runId: string) {
    const rows = check(
      await this.db.from("run_files").select("path, content").eq("run_id", runId),
      "leer archivos",
    ) as { path: string; content: string }[];
    return Object.fromEntries(rows.map((r) => [r.path, r.content])) as SiteFiles;
  }

  async saveFiles(runId: string, upserts: SiteFiles, deletes: string[]) {
    const rows = Object.entries(upserts).map(([path, content]) => ({
      run_id: runId,
      path,
      content,
      updated_at: new Date().toISOString(),
    }));
    if (rows.length > 0) check(await this.db.from("run_files").upsert(rows), "guardar archivos");
    if (deletes.length > 0) {
      check(
        await this.db.from("run_files").delete().eq("run_id", runId).in("path", deletes),
        "borrar archivos",
      );
    }
  }

  async addEvent(event: NewEvent) {
    check(
      await this.db.from("events").insert({
        run_id: event.run_id,
        task_id: event.task_id ?? null,
        agent: event.agent,
        kind: event.kind,
        message: event.message,
        payload: event.payload ?? null,
      }),
      "registrar evento",
    );
  }
}
