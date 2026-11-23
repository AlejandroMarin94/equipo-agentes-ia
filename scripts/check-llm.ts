/**
 * Prueba cada eslabón de las cadenas de los tres agentes con una llamada mínima de su esquema real.
 *
 *   npx tsx scripts/check-llm.ts                 # las tres cadenas
 *   npx tsx scripts/check-llm.ts develop testing # solo esas
 *
 * Lee GROQ_API_KEY, MISTRAL_API_KEY, GEMINI_API_KEY y LLM_CHAIN_* del entorno o de .env.local
 * (las claves no se imprimen). Por cada eslabón: proveedor/modelo, OK/FALLO, código y tiempo.
 * Un 503 o un 429 suelen ser pasajeros: repetir más tarde antes de descartar un modelo.
 */
import { ApiError } from "@google/genai";
import { API_KEY_ENV, LinkError, parseOutput, resolveChains, type AgentName, type LlmRequest } from "../lib/llm/chain";
import { createCallers } from "../lib/llm";
import { DEVELOP_SCHEMA, PLAN_SCHEMA, REVIEW_SCHEMA } from "../lib/llm/schemas";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Sin .env.local: se usan las variables del entorno.
}

const PAGE = '<!DOCTYPE html><html lang="es"><head><title>Inicio</title></head><body><h1>Panadería</h1></body></html>';

const REQUESTS: Record<AgentName, Omit<LlmRequest, "timeoutMs">> = {
  orchestrator: {
    system: "Eres el Orquestador. Divide la petición en 1 tarea con 1 criterio de aceptación.",
    prompt: `Petición: cambia el título h1 por «Hola».\n\n=== index.html ===\n${PAGE}`,
    output: PLAN_SCHEMA,
    temperature: 0.3,
    maxTokens: 1024,
  },
  develop: {
    system: 'Eres Develop. Devuelve solo los archivos que cambian, con "content" completo.',
    prompt: `Tarea: cambia el h1 de index.html por «Hola».\n\n=== index.html ===\n${PAGE}`,
    output: DEVELOP_SCHEMA,
    temperature: 0.3,
    maxTokens: 1024,
  },
  testing: {
    system: "Eres Testing. Evalúa cada criterio de aceptación con un motivo breve.",
    prompt: `Criterio 1: el h1 de index.html dice «Panadería».\n\n=== index.html ===\n${PAGE}`,
    output: REVIEW_SCHEMA,
    temperature: 0.3,
    maxTokens: 1024,
  },
};

const AGENT_LABEL: Record<AgentName, string> = { orchestrator: "Orquestador", develop: "Develop", testing: "Testing" };

const secrets = Object.values(API_KEY_ENV)
  .map((name) => process.env[name]?.trim())
  .filter((v): v is string => Boolean(v));
const mask = (text: string) => secrets.reduce((acc, s) => acc.replaceAll(s, "***"), text);

function codeOf(error: unknown): string {
  if (error instanceof LinkError) return error.status ? String(error.status) : error.kind;
  if (error instanceof ApiError) return String(error.status);
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "tiempo";
  return "error";
}

async function main() {
  const chains = resolveChains(process.env);
  const callers = createCallers(process.env);
  const selected = process.argv.slice(2) as AgentName[];
  const agents = (Object.keys(chains) as AgentName[]).filter((a) => selected.length === 0 || selected.includes(a));
  let failures = 0;

  for (const agent of agents) {
    console.log(`\n${AGENT_LABEL[agent]} (${chains[agent].length} eslabones):`);
    if (!chains[agent].some((l) => callers[l.provider])) failures += 1;
    for (const link of chains[agent]) {
      const caller = callers[link.provider];
      const name = link.label.padEnd(34);
      if (!caller) {
        console.log(`  SIN CLAVE  ${name} falta ${API_KEY_ENV[link.provider]}`);
        continue;
      }
      const started = Date.now();
      try {
        const text = await caller(link, { ...REQUESTS[agent], timeoutMs: 60_000 });
        parseOutput(text, REQUESTS[agent].output);
        console.log(`  OK         ${name} 200    ${Date.now() - started} ms`);
      } catch (error) {
        failures += 1;
        const message = mask(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);
        console.log(`  FALLO      ${name} ${codeOf(error).padEnd(6)} ${Date.now() - started} ms · ${message}`);
      }
    }
  }
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(mask(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
