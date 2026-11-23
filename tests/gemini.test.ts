import { ApiError } from "@google/genai";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FALLBACK_MODELS,
  DEFAULT_GEMINI_MODELS,
  GeminiProvider,
  modelChain,
  parseRetryDelay,
  resolveFallbackModels,
  resolveGeminiModels,
} from "@/lib/llm/gemini";
import { RateLimitError } from "@/lib/llm/types";

/** Sustituye la llamada real a la API por una respuesta o un error. */
function providerReturning(impl: (request: { model: string }) => Promise<unknown>, fallbacks: string[] = []) {
  const provider = new GeminiProvider(
    "clave-falsa",
    { orchestrator: "m-orq", develop: "m-dev", testing: "m-test" },
    fallbacks,
  );
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
    expect(await provider.summarize({ request: "x", tasks: [] })).toEqual({
      summary: "Hecho.",
      model: "m-orq",
      fallbackFrom: [],
    });
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

  it("trata un 503 (modelo saturado) sin respaldo como espera, no como error", async () => {
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

describe("cadena de respaldo de modelos", () => {
  const apiError = (status: number) => new ApiError({ message: `error ${status}`, status });

  it("si el modelo del agente está saturado, responde el siguiente y queda registrado", async () => {
    const calls: string[] = [];
    const provider = providerReturning(async ({ model }) => {
      calls.push(model);
      if (model === "m-orq") throw apiError(503);
      if (model === "resp-1") throw apiError(504);
      return { text: '{"summary":"ok"}' };
    }, ["resp-1", "resp-2"]);
    const out = await provider.summarize({ request: "x", tasks: [] });
    expect(calls).toEqual(["m-orq", "resp-1", "resp-2"]);
    expect(out).toEqual({ summary: "ok", model: "resp-2", fallbackFrom: ["m-orq (503)", "resp-1 (504)"] });
  });

  it("un modelo no disponible (404) también pasa al siguiente", async () => {
    const provider = providerReturning(async ({ model }) => {
      if (model === "m-orq") throw apiError(404);
      return { text: '{"summary":"ok"}' };
    }, ["resp-1"]);
    expect((await provider.summarize({ request: "x", tasks: [] })).model).toBe("resp-1");
  });

  it("si todos están saturados o agotan el tiempo, RateLimitError de saturación", async () => {
    const provider = providerReturning(async ({ model }) => {
      throw apiError(model === "m-orq" ? 504 : 503);
    }, ["resp-1"]);
    const error = await provider.summarize({ request: "x", tasks: [] }).catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.overloaded).toBe(true);
    expect(error.message).toContain("m-orq (504), resp-1 (503)");
  });

  it("si ninguno existe (todo 404), es un error de configuración, no una espera", async () => {
    const provider = providerReturning(async () => {
      throw apiError(404);
    }, ["resp-1"]);
    const error = await provider.summarize({ request: "x", tasks: [] }).catch((e) => e);
    expect(error).not.toBeInstanceOf(RateLimitError);
    expect(error.status).toBe(404);
  });

  it("un 429 no prueba más modelos: se espera lo que diga la API", async () => {
    const calls: string[] = [];
    const provider = providerReturning(async ({ model }) => {
      calls.push(model);
      throw new ApiError({ message: body429, status: 429 });
    }, ["resp-1"]);
    const error = await provider.summarize({ request: "x", tasks: [] }).catch((e) => e);
    expect(calls).toEqual(["m-orq"]);
    expect(error.retryAfterSeconds).toBe(37);
  });

  it("ordena el respaldo: primero los de la misma gama y sin repetir el del agente", () => {
    const fallbacks = ["a-flash-lite", "b-flash", "c-flash-lite", "b-flash"];
    expect(modelChain("b-flash", fallbacks)).toEqual(["b-flash", "a-flash-lite", "c-flash-lite"]);
    expect(modelChain("x-flash-lite", fallbacks)).toEqual(["x-flash-lite", "a-flash-lite", "c-flash-lite", "b-flash"]);
  });

  it("GEMINI_FALLBACK_MODELS: lista separada por comas, vacía = sin respaldo", () => {
    expect(resolveFallbackModels({})).toEqual(DEFAULT_FALLBACK_MODELS);
    expect(resolveFallbackModels({ GEMINI_FALLBACK_MODELS: " m1, ,m2 " })).toEqual(["m1", "m2"]);
    expect(resolveFallbackModels({ GEMINI_FALLBACK_MODELS: "" })).toEqual([]);
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
