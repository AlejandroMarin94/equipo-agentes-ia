/**
 * Ejecuta una petición completa con el motor real, sin Supabase ni navegador:
 * repositorio en memoria y el proveedor de LLM_PROVIDER (las cadenas LLM_CHAIN_* por defecto).
 *
 *   npx tsx scripts/run-local.ts ["petición"] [--out carpeta]
 *
 * Lee la configuración de .env.local (las claves no se imprimen). Imprime los eventos y el
 * estado de las tareas hasta done/failed y, con --out, guarda ahí la web resultante.
 * Cuenta las peticiones HTTP a Groq, Mistral y Gemini (respaldos y reintentos incluidos).
 * Se detiene (guardando lo hecho) si la API pide esperar más de 5 min o con Ctrl+C.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startRun, step } from "../lib/engine/engine";
import { formatWaitUntil } from "../lib/format";
import { MemoryRepository } from "../lib/engine/memory-repository";
import { getProvider } from "../lib/llm";
import { API_KEY_ENV } from "../lib/llm/chain";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Sin .env.local: se usan las variables del entorno.
}

const MAX_STEPS = 80;
const MAX_WAIT_SECONDS = 300;
const DEFAULT_REQUEST = "Añade una página de contacto con formulario";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : null;
const request = args.filter((_, i) => i !== outIndex && i !== outIndex + 1)[0] ?? DEFAULT_REQUEST;

const secrets = Object.values(API_KEY_ENV)
  .map((name) => process.env[name]?.trim())
  .filter((v): v is string => Boolean(v));
const mask = (text: string) => secrets.reduce((acc, s) => acc.replaceAll(s, "***"), text);

const API_HOSTS = { "generativelanguage.googleapis.com": "gemini", "api.groq.com": "groq", "api.mistral.ai": "mistral" };

/** «proveedor/modelo» de una petición a la API: Gemini lo lleva en la URL; Groq y Mistral, en el cuerpo. */
function modelOf(url: string, init?: RequestInit): string | null {
  const host = Object.entries(API_HOSTS).find(([h]) => url.includes(h));
  if (!host) return null;
  if (host[1] === "gemini") return `gemini/${url.match(/models\/([^:/?]+)/)?.[1] ?? "?"}`;
  try {
    return `${host[1]}/${(JSON.parse(String(init?.body)) as { model?: string }).model ?? "?"}`;
  } catch {
    return `${host[1]}/?`;
  }
}

// Cuenta las llamadas reales a la API (el SDK de Gemini y el proveedor compatible con OpenAI usan el fetch global).
const apiCalls: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const model = modelOf(url, init);
  if (!model) return originalFetch(input, init);
  const sent = Date.now();
  try {
    const response = await originalFetch(input, init);
    apiCalls.push(`${model} ${response.status}`);
    console.log(`${" ".repeat(10)}API ${model} → ${response.status} en ${elapsed(sent)}`);
    return response;
  } catch (error) {
    apiCalls.push(`${model} sin respuesta`);
    console.log(`${" ".repeat(10)}API ${model} → sin respuesta en ${elapsed(sent)}`);
    throw error;
  }
};

const elapsed = (start: number) => `${((Date.now() - start) / 1000).toFixed(1)} s`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const provider = getProvider();
  const repo = new MemoryRepository();
  const started = await startRun(repo, "local", request, { maxRunsPerDay: 100, maxRunsPerHour: 100 });
  if (!started.ok) throw new Error(started.error);
  const runId = started.runId;
  const start = Date.now();
  console.log(`Proveedor: ${provider.name} · Petición: «${request}»\n`);

  let printed = 0;
  let lastBoard = "";
  const flush = async () => {
    for (const event of repo.events.slice(printed)) {
      const payload = event.payload as { model?: string; fallbackFrom?: string[] } | null;
      const model = payload?.model
        ? ` [${payload.model}${payload.fallbackFrom?.length ? `, respaldo tras ${payload.fallbackFrom.join(", ")}` : ""}]`
        : "";
      console.log(`[${elapsed(start).padStart(7)}] ${event.agent.padEnd(12)} ${event.kind.padEnd(10)} ${mask(event.message)}${model}`);
    }
    printed = repo.events.length;
    const tasks = await repo.listTasks(runId);
    const board = tasks.map((t) => `  #${t.position + 1} ${t.status.padEnd(10)} fallos=${t.attempts} ${t.title}`).join("\n");
    if (board && board !== lastBoard) {
      console.log(`${" ".repeat(10)}Tareas:\n${board}`);
      lastBoard = board;
    }
  };

  let steps = 0;
  const report = async (stopReason?: string) => {
    await flush();
    if (stopReason) console.log(`\nDetenido: ${stopReason}`);
    await printReport(repo, runId, start, steps);
  };
  process.once("SIGINT", () => {
    report("interrumpido con Ctrl+C").finally(() => process.exit(130));
  });

  while (steps < MAX_STEPS) {
    steps += 1;
    const result = await step(repo, provider, runId);
    await flush();
    if (result.done) return report();
    if (result.retryAfter && result.retryAfter > MAX_WAIT_SECONDS) {
      return report(`la API pide esperar ${formatWaitUntil(result.retryAfter)} (cuota agotada)`);
    }
    if (result.retryAfter) await sleep(result.retryAfter * 1000 + 500);
  }
  return report(`${MAX_STEPS} pasos sin terminar`);
}

async function printReport(repo: MemoryRepository, runId: string, start: number, steps: number) {
  const run = await repo.getRun(runId);
  const tasks = await repo.listTasks(runId);
  console.log(`\nEstado final: ${run?.status} en ${elapsed(start)} y ${steps} pasos.`);
  for (const t of tasks) {
    console.log(`  #${t.position + 1} ${t.status} (fallos de Testing: ${t.attempts}) ${t.title}`);
    t.acceptance_criteria.forEach((c) => console.log(`       · ${c}`));
  }
  console.log(`Resumen: ${mask(run?.summary ?? "(sin resumen)")}`);
  const byStatus = apiCalls.reduce<Record<string, number>>((acc, c) => ((acc[c] = (acc[c] ?? 0) + 1), acc), {});
  console.log(`Llamadas a la API: ${apiCalls.length}`, byStatus);

  if (outDir) {
    const files = await repo.getFiles(runId);
    for (const [path, content] of Object.entries(files)) {
      const target = join(outDir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    writeFileSync(join(outDir, "_eventos.json"), mask(JSON.stringify({ run, tasks, events: repo.events }, null, 2)));
    console.log(`Web resultante y eventos guardados en ${outDir}`);
  }
  if (run?.status !== "done") process.exitCode = 1;
}

main().catch((error) => {
  console.error(mask(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
