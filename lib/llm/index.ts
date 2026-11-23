import { GeminiProvider } from "./gemini";
import { MockProvider } from "./mock";
import type { AgentProvider } from "./types";

/** Elige el proveedor según LLM_PROVIDER (gemini | mock). */
export function getProvider(): AgentProvider {
  const provider = (process.env.LLM_PROVIDER ?? "gemini").toLowerCase();
  if (provider === "mock") {
    return new MockProvider(Number(process.env.MOCK_DELAY_MS ?? 1500));
  }
  if (provider !== "gemini") {
    throw new Error(`LLM_PROVIDER desconocido: ${provider} (usa gemini o mock)`);
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Falta GEMINI_API_KEY (o usa LLM_PROVIDER=mock)");
  return new GeminiProvider(apiKey, process.env.GEMINI_MODEL || "gemini-2.5-flash");
}
