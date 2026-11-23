import type { Run, RunEvent, SiteFiles, Task } from "../types";
import type { NewEvent, NewTask, Repository, RunPatch, TaskPatch } from "./repository";

/** Repositorio en memoria para los tests del motor. */
export class MemoryRepository implements Repository {
  runs = new Map<string, Run>();
  tasks: Task[] = [];
  files = new Map<string, SiteFiles>();
  events: RunEvent[] = [];
  private seq = 0;

  private id(prefix: string) {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  async createRun(userId: string, request: string) {
    const id = this.id("run");
    this.runs.set(id, {
      id,
      user_id: userId,
      request,
      status: "planning",
      summary: null,
      error_count: 0,
      locked_until: null,
      created_at: new Date().toISOString(),
    });
    this.files.set(id, {});
    return id;
  }

  async countRunsSince(userId: string, since: Date) {
    return [...this.runs.values()].filter((r) => r.user_id === userId && new Date(r.created_at) >= since).length;
  }

  async getRun(runId: string) {
    const run = this.runs.get(runId);
    return run ? { ...run } : null;
  }

  async tryLock(runId: string, until: Date, now: Date) {
    const run = this.runs.get(runId);
    if (!run || run.status === "done" || run.status === "failed") return false;
    if (run.locked_until && new Date(run.locked_until) > now) return false;
    run.locked_until = until.toISOString();
    return true;
  }

  async updateRun(runId: string, patch: RunPatch) {
    const run = this.runs.get(runId);
    if (run) Object.assign(run, patch);
  }

  async listTasks(runId: string) {
    return this.tasks
      .filter((t) => t.run_id === runId)
      .sort((a, b) => a.position - b.position)
      .map((t) => ({ ...t, acceptance_criteria: [...t.acceptance_criteria] }));
  }

  async insertTasks(runId: string, tasks: NewTask[]) {
    for (const t of tasks) {
      this.tasks.push({
        ...t,
        id: this.id("task"),
        run_id: runId,
        status: "pending",
        attempts: 0,
        last_feedback: null,
        updated_at: new Date().toISOString(),
      });
    }
  }

  async updateTask(taskId: string, patch: TaskPatch) {
    const task = this.tasks.find((t) => t.id === taskId);
    if (task) Object.assign(task, patch, { updated_at: new Date().toISOString() });
  }

  async getFiles(runId: string) {
    return { ...(this.files.get(runId) ?? {}) };
  }

  async saveFiles(runId: string, upserts: SiteFiles, deletes: string[]) {
    const files = { ...(this.files.get(runId) ?? {}), ...upserts };
    for (const path of deletes) delete files[path];
    this.files.set(runId, files);
  }

  async addEvent(event: NewEvent) {
    this.events.push({
      ...event,
      id: this.events.length + 1,
      task_id: event.task_id ?? null,
      payload: event.payload ?? null,
      created_at: new Date().toISOString(),
    });
  }
}
