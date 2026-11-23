import { ApiError, GoogleGenAI } from "@google/genai";
import { DEFAULT_RETRY_SECONDS, LinkError, REQUEST_TIMEOUT_MS, errorFromStatus, type LinkCaller } from "./chain";
import { toGeminiSchema } from "./schemas";

/** Extrae el retraso sugerido por la API de Gemini ("retryDelay": "37s") o usa uno por defecto. */
export function parseRetryDelay(message: string): number {
  const match = message.match(/retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s/);
  return match ? Math.ceil(Number(match[1])) : DEFAULT_RETRY_SECONDS;
}

type GenerateContent = GoogleGenAI["models"]["generateContent"];

function sdkGenerate(apiKey: string): GenerateContent {
  const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS } });
  return (params) => client.models.generateContent(params);
}

/**
 * Gemini como un eslabón más de la cadena, con su SDK y `responseSchema` (el esquema plano convertido).
 * `generate` se sustituye en los tests.
 */
export function createGeminiCaller(apiKey: string, generate?: GenerateContent): LinkCaller {
  const call = generate ?? sdkGenerate(apiKey);
  return async (link, request) => {
    try {
      const response = await call({
        model: link.model,
        contents: request.prompt,
        config: {
          systemInstruction: request.system,
          responseMimeType: "application/json",
          responseSchema: toGeminiSchema(request.output.schema),
          temperature: request.temperature,
          // El SDK se lo pasa al servidor (X-Server-Timeout), que responde 504 al agotarlo.
          httpOptions: { timeout: request.timeoutMs },
        },
      });
      // Sin texto (p. ej. bloqueo de seguridad): se trata como respuesta no válida y pasa al siguiente.
      return response.text ?? "";
    } catch (error) {
      if (error instanceof ApiError) {
        const retryAfter = error.status === 429 ? parseRetryDelay(error.message) : undefined;
        throw errorFromStatus(error.status, `gemini ${error.status}: ${error.message.slice(0, 500)}`, retryAfter);
      }
      if (error instanceof TypeError) throw new LinkError("network", `gemini: ${error.message}`);
      throw error;
    }
  };
}
