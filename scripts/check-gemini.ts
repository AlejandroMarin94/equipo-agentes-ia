/**
 * Comprueba la clave de Gemini, los modelos de cada agente y los de respaldo.
 *
 *   npx tsx scripts/check-gemini.ts
 *
 * Lee GEMINI_API_KEY, GEMINI_MODEL_* y GEMINI_FALLBACK_MODELS del entorno o de .env.local (la clave no se imprime).
 * 1. Lista los modelos de la cuenta que contienen «flash».
 * 2. Hace una llamada mínima con JSON estructurado a cada modelo configurado y de respaldo.
 * Un 503 suele ser saturación pasajera del plan gratuito: repetir más tarde antes de descartar el modelo.
 */
import { ApiError, GoogleGenAI, Type } from "@google/genai";
import { resolveFallbackModels, resolveGeminiModels } from "../lib/llm/gemini";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Sin .env.local: se usan las variables del entorno.
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("Falta GEMINI_API_KEY (en el entorno o en .env.local).");
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 30_000 } });

  console.log("Modelos «flash» disponibles para esta clave:");
  const flash: string[] = [];
  for await (const model of await ai.models.list()) {
    const name = (model.name ?? "").replace(/^models\//, "");
    if (name.includes("flash")) flash.push(name);
  }
  for (const name of flash.sort()) console.log(`  ${name}`);
  if (flash.length === 0) console.log("  (ninguno)");

  const models = resolveGeminiModels(process.env);
  const agentsByModel = new Map<string, string[]>();
  for (const [agent, model] of Object.entries(models)) {
    agentsByModel.set(model, [...(agentsByModel.get(model) ?? []), agent]);
  }
  for (const model of resolveFallbackModels(process.env)) {
    agentsByModel.set(model, [...(agentsByModel.get(model) ?? []), "respaldo"]);
  }

  console.log("\nLlamada de prueba a los modelos configurados:");
  let failures = 0;
  for (const [model, agents] of agentsByModel) {
    const label = `${model} (${agents.join(", ")})`;
    const started = Date.now();
    try {
      const response = await ai.models.generateContent({
        model,
        contents: 'Responde con {"ok": true}.',
        config: {
          responseMimeType: "application/json",
          responseSchema: { type: Type.OBJECT, properties: { ok: { type: Type.BOOLEAN } }, required: ["ok"] },
        },
      });
      const parsed = JSON.parse(response.text ?? "") as { ok?: unknown };
      if (parsed.ok !== true) throw new Error(`JSON inesperado: ${response.text}`);
      console.log(`  OK     ${label}: responde con JSON válido en ${Date.now() - started} ms`);
    } catch (error) {
      failures += 1;
      const status = error instanceof ApiError ? `HTTP ${error.status}: ` : "";
      const message = (error instanceof Error ? error.message : String(error)).replaceAll(apiKey, "***").slice(0, 300);
      console.log(`  FALLO  ${label}: ${status}${message}`);
    }
  }
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
