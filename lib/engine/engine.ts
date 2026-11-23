import { TEMPLATE_FILES } from "../template";
import { RateLimitError, type AgentProvider, type TaskInput } from "../llm/types";
import type { Agent, CheckResult, Run, RunStatus, SiteFiles, Task } from "../types";
import { TERMINAL_STATUSES } from "../types";
import { runDeterministicChecks } from "./checks";
import { applyChanges } from "./files";
import type { Repository } from "./repository";

export const LIMITS = {
  maxTasks: 5,
  maxAttempts: 3,
  maxConsecutiveErrors: 3,
  maxCriteria: 6,
  /** Algo más que maxDuration (60 s) para que un paso colgado no deje el run bloqueado para siempre. */
  lockMs: 70_000,
  errorRetrySeconds: 3,
  busyRetrySeconds: 2,
  requestMinLength: 5,
  requestMaxLength: 500,
};

export interface StepResult {
  status: RunStatus;
  done: boolean;
  /** El paso no se ha ejecutado porque otro paso del mismo run está en curso. */
  busy?: boolean;
  /** Segundos que el cliente debe esperar antes de volver a llamar. */
  retryAfter?: number;
}

export class RunNotFoundError extends Error {}

const AGENT_BY_STATUS: Record<RunStatus, Agent> = {
  planning: "orchestrator",
  developing: "develop",
  testing: "testing",
  summarizing: "orchestrator",
  done: "system",
  failed: "system",
};

const isTerminal = (status: RunStatus) => TERMINAL_STATUSES.includes(status);

function toTaskInput(task: Task): TaskInput {
  return {
    position: task.position,
    title: task.title,
    description: task.description,
    acceptance_criteria: task.acceptance_criteria,
    attempts: task.attempts,
  };
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

/** Crea un run nuevo con su copia de la web de partida. */
export async function startRun(
  repo: Repository,
  userId: string,
  rawRequest: string,
  options: { maxRunsPerDay: number; now?: Date },
): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const request = rawRequest.trim();
  if (request.length < LIMITS.requestMinLength || request.length > LIMITS.requestMaxLength) {
    return {
      ok: false,
      error: `La petición debe tener entre ${LIMITS.requestMinLength} y ${LIMITS.requestMaxLength} caracteres.`,
    };
  }
  const now = options.now ?? new Date();
  const recent = await repo.countRunsSince(userId, new Date(now.getTime() - 24 * 3600 * 1000));
  if (recent >= options.maxRunsPerDay) {
    return {
      ok: false,
      error: `Has alcanzado el límite de ${options.maxRunsPerDay} ejecuciones en 24 horas (protege la cuota gratuita de la API).`,
    };
  }

  const runId = await repo.createRun(userId, request);
  await repo.saveFiles(runId, TEMPLATE_FILES, []);
  await repo.addEvent({
    run_id: runId,
    agent: "system",
    kind: "info",
    message: `Ejecución creada con la web de partida (${Object.keys(TEMPLATE_FILES).length} archivos).`,
  });
  return { ok: true, runId };
}

/**
 * Avanza el run UN paso (como mucho una llamada al LLM), para que cada
 * petición HTTP quepa en el límite de 60 s de Vercel Hobby.
 */
export async function step(
  repo: Repository,
  provider: AgentProvider,
  runId: string,
  now: () => Date = () => new Date(),
): Promise<StepResult> {
  const run = await repo.getRun(runId);
  if (!run) throw new RunNotFoundError(`No existe el run ${runId}`);
  if (isTerminal(run.status)) return { status: run.status, done: true };

  const locked = await repo.tryLock(runId, new Date(now().getTime() + LIMITS.lockMs), now());
  if (!locked) {
    return { status: run.status, done: false, busy: true, retryAfter: LIMITS.busyRetrySeconds };
  }

  let lockUntil: Date | null = null;
  let retryAfter: number | undefined;
  try {
    await advance(repo, provider, run);
    if (run.error_count > 0) await repo.updateRun(runId, { error_count: 0 });
  } catch (error) {
    const agent = AGENT_BY_STATUS[run.status];
    if (error instanceof RateLimitError) {
      retryAfter = error.retryAfterSeconds;
      // El propio bloqueo evita que otra pestaña lo intente antes de tiempo.
      lockUntil = new Date(now().getTime() + retryAfter * 1000);
      await repo.addEvent({
        run_id: runId,
        agent,
        kind: "rate_limit",
        message: `Límite de la API alcanzado; reintento en ${retryAfter} s.`,
      });
    } else {
      const errors = run.error_count + 1;
      await repo.addEvent({ run_id: runId, agent, kind: "error", message: `Error: ${errorMessage(error)}` });
      if (errors >= LIMITS.maxConsecutiveErrors) {
        await repo.updateRun(runId, {
          status: "failed",
          error_count: errors,
          summary: `La ejecución se ha detenido tras ${errors} errores seguidos. Último error: ${errorMessage(error)}`,
        });
      } else {
        await repo.updateRun(runId, { error_count: errors });
        retryAfter = LIMITS.errorRetrySeconds;
      }
    }
  } finally {
    await repo.updateRun(runId, { locked_until: lockUntil ? lockUntil.toISOString() : null });
  }

  const after = await repo.getRun(runId);
  const status = after?.status ?? run.status;
  return { status, done: isTerminal(status), retryAfter };
}

async function advance(repo: Repository, provider: AgentProvider, run: Run) {
  switch (run.status) {
    case "planning":
      return planStep(repo, provider, run);
    case "developing":
      return developStep(repo, provider, run);
    case "testing":
      return testStep(repo, provider, run);
    case "summarizing":
      return summarizeStep(repo, provider, run);
  }
}

async function planStep(repo: Repository, provider: AgentProvider, run: Run) {
  // Si un paso anterior insertó las tareas pero no llegó a cambiar el estado, no se repite.
  if ((await repo.listTasks(run.id)).length > 0) {
    await repo.updateRun(run.id, { status: "developing" });
    return;
  }

  const files = await repo.getFiles(run.id);
  await repo.addEvent({
    run_id: run.id,
    agent: "orchestrator",
    kind: "thinking",
    message: "Analizando la petición y dividiéndola en tareas…",
  });
  const planned = await provider.plan({ request: run.request, files });

  const tasks = planned
    .filter((t) => t && typeof t.title === "string" && t.title.trim())
    .slice(0, LIMITS.maxTasks)
    .map((t, position) => ({
      position,
      title: t.title.trim(),
      description: (t.description ?? "").trim(),
      acceptance_criteria: (t.acceptance_criteria ?? [])
        .filter((c) => typeof c === "string" && c.trim())
        .slice(0, LIMITS.maxCriteria),
    }));
  if (tasks.length === 0) throw new Error("El Orquestador no ha devuelto ninguna tarea válida");

  await repo.insertTasks(run.id, tasks);
  await repo.addEvent({
    run_id: run.id,
    agent: "orchestrator",
    kind: "plan",
    message: `He dividido la petición en ${tasks.length} ${tasks.length === 1 ? "tarea" : "tareas"}: ${tasks
      .map((t, i) => `${i + 1}) ${t.title}`)
      .join("; ")}. Se las paso a Develop.`,
    payload: { tasks },
  });
  await repo.updateRun(run.id, { status: "developing" });
}

async function developStep(repo: Repository, provider: AgentProvider, run: Run) {
  const tasks = await repo.listTasks(run.id);
  // "developing" incluido por si un paso anterior se cortó a mitad de la llamada.
  const task = tasks.find((t) => t.status === "pending" || t.status === "failed" || t.status === "developing");
  if (!task) {
    await repo.updateRun(run.id, { status: "summarizing" });
    return;
  }

  const files = await repo.getFiles(run.id);
  const retry = task.attempts > 0;
  await repo.updateTask(task.id, { status: "developing" });
  await repo.addEvent({
    run_id: run.id,
    task_id: task.id,
    agent: "develop",
    kind: "thinking",
    message: retry
      ? `Corrigiendo «${task.title}» con lo que indicó Testing (intento ${task.attempts + 1} de ${LIMITS.maxAttempts})…`
      : `Trabajando en «${task.title}»…`,
  });

  const output = await provider.develop({
    request: run.request,
    task: toTaskInput(task),
    feedback: retry ? task.last_feedback : null,
    files,
  });
  const { applied, rejected } = applyChanges(files, Array.isArray(output.changes) ? output.changes : []);

  const upserts: SiteFiles = {};
  const deletes: string[] = [];
  for (const change of applied) {
    if (change.action === "delete") deletes.push(change.path);
    else upserts[change.path] = change.content ?? "";
  }
  await repo.saveFiles(run.id, upserts, deletes);

  const verbs = { create: "creado", update: "modificado", delete: "borrado" } as const;
  const changed = applied.map((c) => `${c.path} (${verbs[c.action]})`).join(", ") || "ningún archivo";
  const rejectedText = rejected.length
    ? ` Descartados ${rejected.length} cambios no válidos: ${rejected.map((r) => `${r.change.path}: ${r.reason}`).join("; ")}.`
    : "";
  await repo.addEvent({
    run_id: run.id,
    task_id: task.id,
    agent: "develop",
    kind: "change",
    message: `${(output.summary || "Cambios aplicados.").trim()} Archivos: ${changed}.${rejectedText} Paso la tarea a Testing.`,
    payload: {
      applied: applied.map(({ path, action }) => ({ path, action })),
      rejected: rejected.map((r) => ({ path: r.change.path, reason: r.reason })),
    },
  });
  await repo.updateTask(task.id, { status: "testing" });
  await repo.updateRun(run.id, { status: "testing" });
}

async function testStep(repo: Repository, provider: AgentProvider, run: Run) {
  const tasks = await repo.listTasks(run.id);
  const task = tasks.find((t) => t.status === "testing");
  if (!task) {
    await repo.updateRun(run.id, { status: "developing" });
    return;
  }

  const files = await repo.getFiles(run.id);
  await repo.addEvent({
    run_id: run.id,
    task_id: task.id,
    agent: "testing",
    kind: "thinking",
    message: `Revisando «${task.title}»: comprobaciones automáticas y criterios de aceptación…`,
  });

  const automatic = runDeterministicChecks(files);
  let results: CheckResult[] = automatic;
  let passed = automatic.every((r) => r.ok);
  if (passed) {
    const review = await provider.review({ request: run.request, task: toTaskInput(task), files });
    const llmResults = Array.isArray(review.results) ? review.results : [];
    results = [...automatic, ...llmResults];
    passed = review.passed && llmResults.length > 0 && llmResults.every((r) => r.ok);
  }

  if (passed) {
    await repo.updateTask(task.id, { status: "done" });
    await repo.addEvent({
      run_id: run.id,
      task_id: task.id,
      agent: "testing",
      kind: "test_pass",
      message: `«${task.title}» supera las ${results.length} comprobaciones. Tarea hecha.`,
      payload: { results },
    });
  } else {
    const failures = results.filter((r) => !r.ok);
    const skippedLlm = !automatic.every((r) => r.ok)
      ? "\n(Las comprobaciones automáticas fallan; los criterios de aceptación se revisarán cuando estén corregidas.)"
      : "";
    const feedback = failures.map((r) => `- ${r.criterion}: ${r.reason}`).join("\n") + skippedLlm;
    const attempts = task.attempts + 1;
    const blocked = attempts >= LIMITS.maxAttempts;

    await repo.updateTask(task.id, { status: blocked ? "blocked" : "failed", attempts, last_feedback: feedback });
    await repo.addEvent({
      run_id: run.id,
      task_id: task.id,
      agent: "testing",
      kind: "test_fail",
      message: `«${task.title}» no pasa (fallo ${attempts} de ${LIMITS.maxAttempts}): ${failures
        .map((r) => r.reason)
        .join(" ")}${blocked ? "" : " Se la devuelvo a Develop."}`,
      payload: { results },
    });
    if (blocked) {
      await repo.addEvent({
        run_id: run.id,
        task_id: task.id,
        agent: "orchestrator",
        kind: "error",
        message: `«${task.title}» queda bloqueada tras ${LIMITS.maxAttempts} intentos. Sigo con el resto de tareas.`,
      });
    }
  }
  await repo.updateRun(run.id, { status: "developing" });
}

async function summarizeStep(repo: Repository, provider: AgentProvider, run: Run) {
  const tasks = await repo.listTasks(run.id);
  await repo.addEvent({
    run_id: run.id,
    agent: "orchestrator",
    kind: "thinking",
    message: "Todas las tareas han terminado. Redactando el resumen final…",
  });
  const summary = await provider.summarize({
    request: run.request,
    tasks: tasks.map((t) => ({
      title: t.title,
      status: t.status,
      attempts: t.attempts,
      last_feedback: t.last_feedback,
    })),
  });
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  const status: RunStatus = blocked > 0 ? "failed" : "done";
  const text = summary.trim() || `${tasks.length - blocked} de ${tasks.length} tareas completadas.`;
  await repo.updateRun(run.id, { status, summary: text });
  await repo.addEvent({ run_id: run.id, agent: "orchestrator", kind: "summary", message: text });
}
