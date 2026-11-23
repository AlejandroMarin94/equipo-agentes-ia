import { ApiError } from "@google/genai";
import { describe, expect, it } from "vitest";
import { GeminiProvider, parseRetryDelay } from "@/lib/llm/gemini";
import { RateLimitError } from "@/lib/llm/types";

/** Sustituye la llamada real a la API por una respuesta o un error. */
function providerReturning(impl: () => Promise<unknown>) {
  const provider = new GeminiProvider("clave-falsa", "modelo");
  (provider as unknown as { client: unknown }).client = { models: { generateContent: impl } };
  return provider;
}

const body429 = JSON.stringify({
  error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" }],
  },
});

describe("proveedor Gemini", () => {
  it("lee el JSON de response.text", async () => {
    const provider = providerReturning(async () => ({ text: '{"summary":"Hecho."}' }));
    expect(await provider.summarize({ request: "x", tasks: [] })).toBe("Hecho.");
  });

  it("convierte un 429 en RateLimitError con el retryDelay de la API", async () => {
    const provider = providerReturning(async () => {
      throw new ApiError({ message: body429, status: 429 });
    });
    const error = await provider.summarize({ request: "x", tasks: [] }).catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.retryAfterSeconds).toBe(37);
    expect(error.overloaded).toBe(false);
  });

  it("trata un 503 (modelo saturado) como espera, no como error", async () => {
    const provider = providerReturning(async () => {
      throw new ApiError({ message: "The model is overloaded", status: 503 });
    });
    const error = await provider.summarize({ request: "x", tasks: [] }).catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.overloaded).toBe(true);
  });

  it("deja pasar el resto de errores", async () => {
    const provider = providerReturning(async () => {
      throw new ApiError({ message: "bad request", status: 400 });
    });
    const error = await provider.summarize({ request: "x", tasks: [] }).catch((e) => e);
    expect(error).not.toBeInstanceOf(RateLimitError);
  });

  it("usa 30 s si la API no indica retryDelay", () => {
    expect(parseRetryDelay("sin pista")).toBe(30);
    expect(parseRetryDelay('"retryDelay": "2.5s"')).toBe(3);
  });
});
