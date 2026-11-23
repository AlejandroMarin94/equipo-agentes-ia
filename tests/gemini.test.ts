import { ApiError } from "@google/genai";
import { describe, expect, it } from "vitest";
import { DEFAULT_GEMINI_MODELS, GeminiProvider, parseRetryDelay, resolveGeminiModels } from "@/lib/llm/gemini";
import { RateLimitError } from "@/lib/llm/types";

/** Sustituye la llamada real a la API por una respuesta o un error. */
function providerReturning(impl: (request: { model: string }) => Promise<unknown>) {
  const provider = new GeminiProvider("clave-falsa", { orchestrator: "m-orq", develop: "m-dev", testing: "m-test" });
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

describe("modelo por agente", () => {
  it("usa los valores por defecto sin variables", () => {
    expect(resolveGeminiModels({})).toEqual(DEFAULT_GEMINI_MODELS);
  });

  it("GEMINI_MODEL hace de respaldo común y cada GEMINI_MODEL_<AGENTE> manda sobre él", () => {
    expect(
      resolveGeminiModels({ GEMINI_MODEL: "comun", GEMINI_MODEL_DEVELOP: "dev", GEMINI_MODEL_TESTING: "  " }),
    ).toEqual({ orchestrator: "comun", develop: "dev", testing: "comun" });
  });

  it("cada agente llama a su modelo", async () => {
    const models: string[] = [];
    const provider = providerReturning(async ({ model }) => {
      models.push(model);
      return { text: '{"tasks":[],"summary":"ok","changes":[],"passed":true,"results":[]}' };
    });
    const task = { position: 0, title: "t", description: "d", acceptance_criteria: ["c"], attempts: 0 };
    await provider.plan({ request: "x", files: {} });
    await provider.develop({ request: "x", task, feedback: null, files: {} });
    await provider.review({ request: "x", task, files: {} });
    await provider.summarize({ request: "x", tasks: [] });
    expect(models).toEqual(["m-orq", "m-dev", "m-test", "m-orq"]);
  });
});
