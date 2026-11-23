/**
 * Comprueba que Claude responde por la suscripción con cada modelo de los agentes: una llamada mínima
 * con el esquema real del Orquestador por modelo.
 *
 *   npx tsx scripts/check-claude.ts
 *
 * Lee CLAUDE_CODE_OAUTH_TOKEN y CLAUDE_MODELS_* de .env.local o del entorno (el token no se imprime);
 * sin token, usa la sesión de Claude Code de este equipo. Por modelo: OK/FALLO, tiempo y motivo.
 */
import { resolveModels, parseOutput, type LlmRequest } from "../lib/llm/chain";
import { createClaudeCaller } from "../lib/llm/claude";
import { PLAN_SCHEMA } from "../lib/llm/schemas";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Sin .env.local: se usan las variables del entorno.
}

const REQUEST: LlmRequest = {
  system: "Eres el Orquestador. Divide la petición en 1 tarea con 1 criterio de aceptación.",
  prompt: 'Petición: cambia el título h1 por «Hola».\n\n=== index.html ===\n<!DOCTYPE html><html lang="es"><body><h1>Panadería</h1></body></html>',
  output: PLAN_SCHEMA,
  timeoutMs: 120_000,
};

const secret = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
const mask = (text: string) => (secret ? text.replaceAll(secret, "***") : text);

async function main() {
  const models = [...new Set(Object.values(resolveModels(process.env)).flat())];
  const caller = createClaudeCaller();
  console.log(`Autenticación: ${secret ? "CLAUDE_CODE_OAUTH_TOKEN" : "sesión de Claude Code de este equipo"}`);
  for (const model of models) {
    const started = Date.now();
    try {
      parseOutput(await caller(model, REQUEST), REQUEST.output);
      console.log(`  OK     ${model.padEnd(22)} ${Date.now() - started} ms`);
    } catch (error) {
      process.exitCode = 1;
      const message = mask(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);
      console.log(`  FALLO  ${model.padEnd(22)} ${Date.now() - started} ms · ${message}`);
    }
  }
}

main().catch((error) => {
  console.error(mask(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
