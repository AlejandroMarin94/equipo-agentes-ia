import { describe, expect, it, vi } from "vitest";
import { runDeterministicChecks } from "@/lib/engine/checks";
import { LIMITS, hourlyLimitReleaseAt, startRun, step } from "@/lib/engine/engine";
import { MemoryRepository } from "@/lib/engine/memory-repository";
import { MockProvider } from "@/lib/llm/mock";
import { RateLimitError, type AgentProvider } from "@/lib/llm/types";
import { TEMPLATE_FILES } from "@/lib/template";
import type { RunStatus } from "@/lib/types";

async function newRun(repo: MemoryRepository, request: string) {
  const result = await startRun(repo, "user-1", request, { maxRunsPerDay: 15, maxRunsPerHour: 100 });
  if (!result.ok) throw new Error(result.error);
  return result.runId;
}

async function runToEnd(repo: MemoryRepository, provider: AgentProvider, runId: string) {
  const statuses: RunStatus[] = [];
  for (let i = 0; i < 60; i++) {
    const result = await step(repo, provider, runId);
    statuses.push(result.status);
    if (result.done) return statuses;
  }
  throw new Error("El run no ha terminado en 60 pasos");
}

/** Proveedor mock con alguna pieza sustituida. */
function providerWith(overrides: Partial<AgentProvider>): AgentProvider {
  const mock = new MockProvider();
  return {
    name: "test",
    plan: (i) => mock.plan(i),
    develop: (i) => mock.develop(i),
    review: (i) => mock.review(i),
    summarize: (i) => mock.summarize(i),
    ...overrides,
  };
}

describe("startRun", () => {
  it("crea el run en planning con una copia de la web de partida", async () => {
    const repo = new MemoryRepository();
    const runId = await newRun(repo, "Añade una página de contacto");
    expect((await repo.getRun(runId))?.status).toBe("planning");
    expect(await repo.getFiles(runId)).toEqual(TEMPLATE_FILES);
  });

  it("valida la longitud de la petición y el límite diario", async () => {
    const repo = new MemoryRepository();
    expect((await startRun(repo, "u", "hola", { maxRunsPerDay: 2, maxRunsPerHour: 100 })).ok).toBe(false);
    await startRun(repo, "u", "petición uno", { maxRunsPerDay: 2, maxRunsPerHour: 100 });
    await startRun(repo, "u", "petición dos", { maxRunsPerDay: 2, maxRunsPerHour: 100 });
    const third = await startRun(repo, "u", "petición tres", { maxRunsPerDay: 2, maxRunsPerHour: 100 });
    expect(third).toEqual({ ok: false, error: expect.stringContaining("límite de 2") });
    expect((await startRun(repo, "otro", "petición tres", { maxRunsPerDay: 2, maxRunsPerHour: 100 })).ok).toBe(true);
  });

  it("aplica el límite global por hora a todos los usuarios y dice cuándo se libera", async () => {
    const repo = new MemoryRepository();
    const limits = { maxRunsPerDay: 15, maxRunsPerHour: 2 };
    expect((await startRun(repo, "ana", "petición uno", limits)).ok).toBe(true);
    expect((await startRun(repo, "luis", "petición dos", limits)).ok).toBe(true);
    const third = await startRun(repo, "eva", "petición tres", limits);
    expect(third).toEqual({ ok: false, error: expect.stringMatching(/2 ejecuciones por hora.*a las \d{2}:\d{2}.*dentro de \d+ min/) });

    const oldest = new Date([...repo.runs.values()][0].created_at);
    const later = new Date(oldest.getTime() + 61 * 60 * 1000);
    expect((await startRun(repo, "eva", "petición tres", { ...limits, now: later })).ok).toBe(true);
  });

  it("calcula cuándo queda libre un hueco del límite por hora", () => {
    const at = (min: number) => new Date(Date.UTC(2026, 10, 23, 10, min));
    expect(hourlyLimitReleaseAt([at(0), at(10)], 4)).toBeNull();
    expect(hourlyLimitReleaseAt([at(0), at(10), at(20), at(30)], 4)).toEqual(new Date(Date.UTC(2026, 10, 23, 11, 0)));
    // Con más de las permitidas (carreras), hay que esperar a que salgan las que sobran.
    expect(hourlyLimitReleaseAt([at(0), at(10), at(20), at(30), at(40)], 4)).toEqual(new Date(Date.UTC(2026, 10, 23, 11, 10)));
  });
});

describe("máquina de estados con el proveedor mock", () => {
  it("sigue planning → developing → testing → developing … → summarizing → done", async () => {
    const repo = new MemoryRepository();
    const runId = await newRun(repo, "Añade una página de contacto con formulario");
    const statuses = await runToEnd(repo, new MockProvider(), runId);

    expect(statuses.slice(0, 3)).toEqual(["developing", "testing", "developing"]);
    expect(statuses.at(-2)).toBe("summarizing");
    expect(statuses.at(-1)).toBe("done");

    const tasks = await repo.listTasks(runId);
    expect(tasks).toHaveLength(3);
    expect(tasks.every((t) => t.status === "done")).toBe(true);
    // La primera tarea falla una vez y se corrige.
    expect(tasks[0].attempts).toBe(1);
    expect(tasks[0].last_feedback).toContain("required");
    expect(repo.events.filter((e) => e.kind === "test_fail")).toHaveLength(1);

    const files = await repo.getFiles(runId);
    expect(files["contacto.html"]).toContain('type="email" required');
    expect(files["nosotros.html"]).toContain('href="contacto.html"');
    expect(runDeterministicChecks(files).every((r) => r.ok)).toBe(true);

    const run = await repo.getRun(runId);
    expect(run?.summary).toContain("3 de 3");
    expect(run?.locked_until).toBeNull();
  });

  it.each(["Añade una sección de precios", "Añade un modo oscuro", "Pon un banner de Navidad"])(
    "termina en done y deja una web válida: %s",
    async (request) => {
      const repo = new MemoryRepository();
      const runId = await newRun(repo, request);
      await runToEnd(repo, new MockProvider(), runId);
      expect((await repo.getRun(runId))?.status).toBe("done");
      expect(runDeterministicChecks(await repo.getFiles(runId)).every((r) => r.ok)).toBe(true);
    },
  );

  it("escribe un evento 'thinking' antes de cada llamada al LLM", async () => {
    const repo = new MemoryRepository();
    const runId = await newRun(repo, "Añade un modo oscuro");
    const provider = new MockProvider();
    const spy = vi.spyOn(provider, "develop");
    await step(repo, provider, runId); // planning
    spy.mockImplementationOnce(async () => {
      expect(repo.events.at(-1)).toMatchObject({ agent: "develop", kind: "thinking" });
      const task = (await repo.listTasks(runId))[0];
      expect(task.status).toBe("developing");
      return { summary: "ok", changes: [] };
    });
    await step(repo, provider, runId);
    expect(spy).toHaveBeenCalledOnce();
  });

  it("limita el plan a 5 tareas", async () => {
    const repo = new MemoryRepository();
    const runId = await newRun(repo, "Muchas cosas");
    const provider = providerWith({
      plan: async () =>
        Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, description: "", acceptance_criteria: ["c"] })),
    });
    await step(repo, provider, runId);
    expect(await repo.listTasks(runId)).toHaveLength(LIMITS.maxTasks);
  });

  it("da un criterio por defecto a las tareas que llegan sin criterios", async () => {
    const repo = new MemoryRepository();
    const runId = await newRun(repo, "Añade un modo oscuro");
    const provider = providerWith({
      plan: async () => [{ title: "Hacer algo", description: "", acceptance_criteria: [] }],
    });
    await step(repo, provider, runId);
    const [task] = await repo.listTasks(runId);
    expect(task.acceptance_criteria).toEqual(["La tarea «Hacer algo» está implementada en la web"]);
  });
});

describe("bucle fallo → reintento → bloqueo", () => {
  it("bloquea la tarea tras 3 fallos, sigue con las demás y termina en failed", async () => {
    const repo = new MemoryRepository();
    const runId = await newRun(repo, "Añade una página de contacto");
    const develop = vi.fn(new MockProvider().develop.bind(new MockProvider()));
    const provider = providerWith({
      develop,
      // Testing rechaza siempre la primera tarea.
      review: async ({ task }) => {
        const results = task.acceptance_criteria.map((criterion) => ({
          criterion,
          ok: task.position !== 0,
          reason: task.position === 0 ? "Sigue sin cumplirse" : "OK",
        }));
        return { passed: results.every((r) => r.ok), results };
      },
    });

    await runToEnd(repo, provider, runId);

    const [first, ...rest] = await repo.listTasks(runId);
    expect(first.status).toBe("blocked");
    expect(first.attempts).toBe(LIMITS.maxAttempts);
    expect(rest.every((t) => t.status === "done")).toBe(true);

    const firstTaskCalls = develop.mock.calls.filter(([input]) => input.task.position === 0);
    expect(firstTaskCalls).toHaveLength(LIMITS.maxAttempts);
    // A partir del segundo intento Develop recibe el feedback de Testing.
    expect(firstTaskCalls[0][0].feedback).toBeNull();
    expect(firstTaskCalls[1][0].feedback).toContain("Sigue sin cumplirse");

    const run = await repo.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.summary).toContain("No se pudo completar");
  });

  it("si fallan las comprobaciones automáticas no gasta una llamada de revisión al LLM", async () => {
    const repo = new MemoryRepository();
    const runId = await newRun(repo, "Rompe la portada");
    const review = vi.fn();
    const provider = providerWith({
      plan: async () => [{ title: "Romper", description: "", acceptance_criteria: ["x"] }],
      develop: async () => ({ summary: "roto", changes: [{ path: "index.html", action: "update", content: "" }] }),
      review,
    });
    await step(repo, provider, runId); // plan
    await step(repo, provider, runId); // develop
    await step(repo, provider, runId); // test
    expect(review).not.toHaveBeenCalled();
    const [task] = await repo.listTasks(runId);
    expect(task.status).toBe("failed");
    expect(task.last_feedback).toContain("[Automática]");
  });

  it("si Testing rechaza sin señalar criterios, Develop recibe igualmente un motivo", async () => {
    const repo = new MemoryRepository();
    const runId = await newRun(repo, "Añade un modo oscuro");
    const provider = providerWith({ review: async () => ({ passed: false, results: [] }) });
    await step(repo, provider, runId); // plan
    await step(repo, provider, runId); // develop
    await step(repo, provider, runId); // test
    const [task] = await repo.listTasks(runId);
    expect(task.status).toBe("failed");
    expect(task.last_feedback).toContain("no ha indicado qué criterio falla");
  });
});

describe("límites de la API, errores y bloqueo", () => {
  it("ante un 429 no rompe el run: pide esperar, lo registra y lo reintenta después", async () => {
    const repo = new MemoryRepository();
    const runId = await newRun(repo, "Añade un modo oscuro");
    const mock = new MockProvider();
    let calls = 0;
    const provider = providerWith({
      plan: async (input) => {
        calls += 1;
        if (calls === 1) throw new RateLimitError(12);
        return mock.plan(input);
      },
    });
    let clock = new Date("2026-11-23T10:00:00Z");
    const now = () => clock;

    const first = await step(repo, provider, runId, now);
    expect(first).toMatchObject({ status: "planning", done: false, retryAfter: 12 });
    expect(repo.events.at(-1)).toMatchObject({ kind: "rate_limit", agent: "orchestrator" });
    expect((await repo.getRun(runId))?.error_count).toBe(0);

    // Antes de que pase la espera, el run sigue bloqueado.
    expect(await step(repo, provider, runId, now)).toMatchObject({ busy: true });

    clock = new Date(clock.getTime() + 13_000);
    expect((await step(repo, provider, runId, now)).status).toBe("developing");
  });

  it("no ejecuta dos pasos a la vez del mismo run", async () => {
    const repo = new MemoryRepository();
    const runId = await newRun(repo, "Añade un modo oscuro");
    await repo.tryLock(runId, new Date(Date.now() + 60_000), new Date());
    const result = await step(repo, new MockProvider(), runId);
    expect(result).toMatchObject({ busy: true, status: "planning" });
    expect(repo.tasks).toHaveLength(0);
  });

  it("relee el run tras ganar el bloqueo: no actúa sobre un estado viejo", async () => {
    const repo = new MemoryRepository();
    const runId = await newRun(repo, "Añade una página de contacto");
    const provider = new MockProvider();
    await step(repo, provider, runId); // plan
    await step(repo, provider, runId); // develop de la tarea 1 → testing
    // Otro paso leyó el run cuando aún estaba en developing y gana el bloqueo después.
    const stale = { ...(await repo.getRun(runId))!, status: "developing" as const };
    const realGetRun = repo.getRun.bind(repo);
    let first = true;
    repo.getRun = async (id) => {
      if (first) {
        first = false;
        return stale;
      }
      return realGetRun(id);
    };
    const develop = vi.spyOn(provider, "develop");

    await step(repo, provider, runId);

    expect(develop).not.toHaveBeenCalled();
    const tasks = await repo.listTasks(runId);
    expect(tasks[0].status).toBe("failed"); // Testing ha revisado la tarea 1
    expect(tasks[1].status).toBe("pending"); // y Develop no ha empezado la 2 en paralelo
  });

  it("si un paso se cortó con una tarea en pruebas, la prueba antes de seguir", async () => {
    const repo = new MemoryRepository();
    const runId = await newRun(repo, "Añade una página de contacto");
    const provider = new MockProvider();
    await step(repo, provider, runId); // plan
    await step(repo, provider, runId); // develop de la tarea 1 → testing
    await repo.updateRun(runId, { status: "developing" }); // el run no llegó a pasar a testing
    const develop = vi.spyOn(provider, "develop");

    expect((await step(repo, provider, runId)).status).toBe("testing");
    expect(develop).not.toHaveBeenCalled();
    await runToEnd(repo, provider, runId);
    expect((await repo.listTasks(runId)).every((t) => t.status === "done")).toBe(true);
  });

  it("tras 3 errores seguidos marca el run como failed", async () => {
    const repo = new MemoryRepository();
    const runId = await newRun(repo, "Añade un modo oscuro");
    const provider = providerWith({
      plan: async () => {
        throw new Error("respuesta no válida");
      },
    });
    expect((await step(repo, provider, runId)).retryAfter).toBe(LIMITS.errorRetrySeconds);
    await step(repo, provider, runId);
    const last = await step(repo, provider, runId);
    expect(last).toMatchObject({ status: "failed", done: true });
    expect((await repo.getRun(runId))?.summary).toContain("respuesta no válida");
    expect(repo.events.filter((e) => e.kind === "error")).toHaveLength(3);
  });

  it("un run terminado no avanza más", async () => {
    const repo = new MemoryRepository();
    const runId = await newRun(repo, "Añade un modo oscuro");
    await runToEnd(repo, new MockProvider(), runId);
    const before = repo.events.length;
    expect(await step(repo, new MockProvider(), runId)).toEqual({ status: "done", done: true });
    expect(repo.events.length).toBe(before);
  });
});
