/**
 * Ejecuta una petición completa con el motor real, sin Supabase ni navegador:
 * repositorio en memoria y el proveedor de LLM_PROVIDER (Gemini por defecto).
 *
 *   npx tsx scripts/run-local.ts ["petición"] [--out carpeta]
 *
 * Lee la configuración de .env.local (la clave no se imprime). Imprime los eventos y el
 * estado de las tareas hasta done/failed y, con --out, guarda ahí la web resultante.
 * Cuenta las peticiones HTTP a la API de Gemini (respaldos y reintentos incluidos).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startRun, step } from "../lib/engine/engine";
import { MemoryRepository } from "../lib/engine/memory-repository";
import { getProvider } from "../lib/llm";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Sin .env.local: se usan las variables del entorno.
}

const MAX_STEPS = 80;
const DEFAULT_REQUEST = "Añade una página de contacto con formulario";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : null;
const request = args.filter((_, i) => i !== outIndex && i !== outIndex + 1)[0] ?? DEFAULT_REQUEST;

const secret = process.env.GEMINI_API_KEY?.trim();
const mask = (text: string) => (secret ? text.replaceAll(secret, "***") : text);

// Cuenta las llamadas reales a la API (el SDK usa el fetch global).
const apiCalls: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes("generativelanguage.googleapis.com")) return originalFetch(input, init);
  const model = url.match(/models\/([^:/?]+)/)?.[1] ?? "?";
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
  while (steps < MAX_STEPS) {
    steps += 1;
    const result = await step(repo, provider, runId);
    await flush();
    if (result.done) break;
    if (result.retryAfter) await sleep(result.retryAfter * 1000 + 500);
  }

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
