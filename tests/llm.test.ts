import { ApiError } from "@google/genai";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAINS,
  LinkError,
  callChain,
  parseChain,
  resolveChains,
  type ChainLink,
  type LinkCaller,
  type LlmRequest,
} from "@/lib/llm/chain";
import { createGeminiCaller, parseRetryDelay } from "@/lib/llm/gemini";
import { getProvider, resolveUsableChains } from "@/lib/llm";
import { MockProvider } from "@/lib/llm/mock";
import { buildChatBody, createOpenAICompatibleCaller, parseRetryAfter } from "@/lib/llm/openai-compatible";
import { ChainProvider } from "@/lib/llm/provider";
import { DEVELOP_SCHEMA, PLAN_SCHEMA, SUMMARY_SCHEMA, shapeError, toGeminiSchema } from "@/lib/llm/schemas";
import { RateLimitError } from "@/lib/llm/types";

const link = (label: string): ChainLink => parseChain(label)[0];
const chainOf = (...labels: string[]) => labels.map(link);

const request: Omit<LlmRequest, "timeoutMs"> = {
  system: "s",
  prompt: "p",
  output: SUMMARY_SCHEMA,
  temperature: 0.3,
  maxTokens: 100,
};

/** Caller falso: cada modelo responde lo que diga `behaviour` (texto o error). */
function fakeCaller(behaviour: Record<string, string | Error>, calls: string[] = []): LinkCaller {
  return async (l) => {
    calls.push(l.label);
    const result = behaviour[l.label];
    if (result === undefined) throw new Error(`modelo inesperado ${l.label}`);
    if (result instanceof Error) throw result;
    return result;
  };
}

const ok = '{"summary":"ok"}';

describe("cadenas: LLM_CHAIN_*", () => {
  it("proveedor/modelo, con barras en el modelo y opciones extra", () => {
    expect(parseChain(" groq/openai/gpt-oss-120b?reasoning_effort=low , mistral/mistral-small-2603,, gemini/g-1 ")).toEqual([
      { provider: "groq", model: "openai/gpt-oss-120b", options: { reasoning_effort: "low" }, label: "groq/openai/gpt-oss-120b" },
      { provider: "mistral", model: "mistral-small-2603", options: {}, label: "mistral/mistral-small-2603" },
      { provider: "gemini", model: "g-1", options: {}, label: "gemini/g-1" },
    ]);
  });

  it("no repite un eslabón y rechaza proveedores desconocidos o sin modelo", () => {
    expect(parseChain("groq/a,groq/a,mistral/a").map((l) => l.label)).toEqual(["groq/a", "mistral/a"]);
    expect(() => parseChain("openai/gpt-5")).toThrow(/Proveedor desconocido/);
    expect(() => parseChain("gemini-3.5-flash")).toThrow(/proveedor\/modelo/);
    expect(() => parseChain("groq/")).toThrow(/proveedor\/modelo/);
  });

  it("por defecto, la tabla de la auditoría; una variable vacía también usa el valor por defecto", () => {
    const chains = resolveChains({ LLM_CHAIN_DEVELOP: "mistral/x, gemini/y", LLM_CHAIN_TESTING: "  " });
    expect(chains.develop.map((l) => l.label)).toEqual(["mistral/x", "gemini/y"]);
    expect(chains.testing).toEqual(parseChain(DEFAULT_CHAINS.testing));
    expect(chains.orchestrator.map((l) => l.label)).toEqual([
      "groq/openai/gpt-oss-120b",
      "groq/qwen/qwen3.8-27b",
      "mistral/mistral-small-2603",
      "gemini/gemini-3.5-flash",
    ]);
    expect(chains.orchestrator[0].options).toEqual({ reasoning_effort: "low" });
  });

  it("un eslabón cuyo proveedor no tiene clave se salta y se registra", () => {
    const { chains, skipped } = resolveUsableChains({}, (p) => p === "gemini");
    expect(chains.orchestrator.map((l) => l.label)).toEqual(["gemini/gemini-3.5-flash"]);
    expect(chains.develop.map((l) => l.label)).toEqual(["gemini/gemini-3.5-flash-lite"]);
    expect(skipped).toContain("develop: mistral/mistral-large-4 (falta MISTRAL_API_KEY)");
    expect(skipped).toContain("testing: groq/openai/gpt-oss-20b (falta GROQ_API_KEY)");
  });

  it("si un agente se queda sin ningún modelo con clave, error de configuración claro", () => {
    expect(() => resolveUsableChains({ LLM_CHAIN_DEVELOP: "groq/a" }, (p) => p === "gemini")).toThrow(
      /cadena de develop.*GROQ_API_KEY/,
    );
  });

  it("getProvider: mock, real con solo la clave de Gemini, y error sin ninguna clave", () => {
    expect(getProvider({ LLM_PROVIDER: "mock" })).toBeInstanceOf(MockProvider);
    expect(getProvider({ GEMINI_API_KEY: "clave-falsa" })).toBeInstanceOf(ChainProvider);
    expect(getProvider({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "clave-falsa" })).toBeInstanceOf(ChainProvider);
    expect(() => getProvider({})).toThrow(/tiene clave/);
    expect(() => getProvider({ LLM_PROVIDER: "otro" })).toThrow(/LLM_PROVIDER desconocido/);
  });
});

describe("bucle de respaldo entre proveedores", () => {
  it("si el primero está saturado, responde el de otro proveedor y queda registrado", async () => {
    const calls: string[] = [];
    const caller = fakeCaller(
      {
        "groq/openai/gpt-oss-120b": new LinkError("overloaded", "x", 503),
        "mistral/mistral-small-2603": ok,
      },
      calls,
    );
    const out = await callChain(chainOf("groq/openai/gpt-oss-120b", "mistral/mistral-small-2603"), { groq: caller, mistral: caller }, request);
    expect(calls).toEqual(["groq/openai/gpt-oss-120b", "mistral/mistral-small-2603"]);
    expect(out).toEqual({ data: { summary: "ok" }, model: "mistral/mistral-small-2603", fallbackFrom: ["groq/openai/gpt-oss-120b (503)"] });
  });

  it("413 (petición demasiado grande para el plan de Groq) pasa al siguiente", async () => {
    const caller = fakeCaller({ "groq/a": new LinkError("too_large", "x", 413), "mistral/b": ok });
    const out = await callChain(chainOf("groq/a", "mistral/b"), { groq: caller, mistral: caller }, request);
    expect(out).toMatchObject({ model: "mistral/b", fallbackFrom: ["groq/a (413)"] });
  });

  it("JSON inválido o con forma incorrecta pasa al siguiente", async () => {
    const caller = fakeCaller({ "groq/a": "no es json", "groq/b": '{"resumen":"x"}', "gemini/c": "```json\n" + ok + "\n```" });
    const out = await callChain(chainOf("groq/a", "groq/b", "gemini/c"), { groq: caller, gemini: caller }, request);
    expect(out).toMatchObject({ model: "gemini/c", fallbackFrom: ["groq/a (JSON no válido)", "groq/b (JSON no válido)"] });
  });

  it("modelo no disponible en el plan, clave rechazada y corte por tiempo también pasan al siguiente", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const caller = fakeCaller({
      "mistral/large": new LinkError("unavailable", "not available in your subscription tier", 400),
      "groq/a": new LinkError("auth", "invalid key", 401),
      "groq/b": timeout,
      "gemini/c": ok,
    });
    const out = await callChain(chainOf("mistral/large", "groq/a", "groq/b", "gemini/c"), { mistral: caller, groq: caller, gemini: caller }, request);
    expect(out.fallbackFrom).toEqual(["mistral/large (400, no disponible)", "groq/a (401, clave rechazada)", "groq/b (tiempo agotado)"]);
  });

  it("un proveedor sin caller (sin clave) se salta sin contar como fallo", async () => {
    const caller = fakeCaller({ "gemini/c": ok });
    const out = await callChain(chainOf("groq/a", "gemini/c"), { gemini: caller }, request);
    expect(out).toMatchObject({ model: "gemini/c", fallbackFrom: [] });
  });

  it("si todos están saturados o sin tiempo, espera de saturación (15 s)", async () => {
    const caller = fakeCaller({ "groq/a": new LinkError("timeout", "x", 504), "mistral/b": new LinkError("overloaded", "x", 503) });
    const error = await callChain(chainOf("groq/a", "mistral/b"), { groq: caller, mistral: caller }, request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ overloaded: true, retryAfterSeconds: 15, message: "groq/a (504), mistral/b (503)" });
  });

  it("si todos dan 429, se espera el menor retry-after; con saturación además, 15 s", async () => {
    const quota = fakeCaller({ "groq/a": new LinkError("quota", "x", 429, 37), "gemini/b": new LinkError("quota", "x", 429, 12) });
    const onlyQuota = await callChain(chainOf("groq/a", "gemini/b"), { groq: quota, gemini: quota }, request).catch((e: unknown) => e);
    expect(onlyQuota).toMatchObject({ overloaded: false, retryAfterSeconds: 12 });

    const mixed = fakeCaller({ "groq/a": new LinkError("quota", "x", 429, 37), "gemini/b": new LinkError("overloaded", "x", 503) });
    const both = await callChain(chainOf("groq/a", "gemini/b"), { groq: mixed, gemini: mixed }, request).catch((e: unknown) => e);
    expect(both).toMatchObject({ overloaded: true, retryAfterSeconds: 15 });
  });

  it("si ninguno responde por motivos no pasajeros (404, 413, JSON), es un error con la lista", async () => {
    const caller = fakeCaller({ "groq/a": new LinkError("too_large", "x", 413), "gemini/b": new LinkError("unavailable", "x", 404), "mistral/c": "{" });
    const error = await callChain(chainOf("groq/a", "gemini/b", "mistral/c"), { groq: caller, gemini: caller, mistral: caller }, request).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(RateLimitError);
    expect((error as Error).message).toContain("groq/a (413), gemini/b (404, no disponible), mistral/c (JSON no válido)");
  });

  it("un error que otro modelo no arregla (400 de petición mal formada) se lanza sin seguir", async () => {
    const calls: string[] = [];
    const caller = fakeCaller({ "groq/a": new Error("groq 400: bad request"), "gemini/b": ok }, calls);
    await expect(callChain(chainOf("groq/a", "gemini/b"), { groq: caller, gemini: caller }, request)).rejects.toThrow("bad request");
    expect(calls).toEqual(["groq/a"]);
  });
});

describe("ChainProvider", () => {
  const chains = { orchestrator: chainOf("groq/orq"), develop: chainOf("mistral/dev"), testing: chainOf("groq/test") };

  it("cada agente usa su cadena", async () => {
    const calls: string[] = [];
    const answer = '{"tasks":[],"summary":"ok","changes":[],"passed":true,"results":[]}';
    const caller = fakeCaller({ "groq/orq": answer, "mistral/dev": answer, "groq/test": answer }, calls);
    const provider = new ChainProvider(chains, { groq: caller, mistral: caller });
    const task = { position: 0, title: "t", description: "d", acceptance_criteria: ["c"], attempts: 0 };
    await provider.plan({ request: "x", files: {} });
    await provider.develop({ request: "x", task, feedback: null, files: {} });
    await provider.review({ request: "x", task, files: {} });
    expect(await provider.summarize({ request: "x", tasks: [] })).toEqual({ summary: "ok", model: "groq/orq", fallbackFrom: [] });
    expect(calls).toEqual(["groq/orq", "mistral/dev", "groq/test", "groq/orq"]);
  });

  it("Develop: content null (delete) se convierte en un cambio sin contenido", async () => {
    const caller = fakeCaller({
      "mistral/dev": JSON.stringify({
        summary: "s",
        changes: [
          { path: "a.html", action: "update", content: "<p>hola</p>" },
          { path: "b.html", action: "delete", content: null },
        ],
      }),
    });
    const provider = new ChainProvider(chains, { mistral: caller });
    const task = { position: 0, title: "t", description: "d", acceptance_criteria: ["c"], attempts: 0 };
    const out = await provider.develop({ request: "x", task, feedback: null, files: {} });
    expect(out.changes).toEqual([
      { path: "a.html", action: "update", content: "<p>hola</p>" },
      { path: "b.html", action: "delete" },
    ]);
  });

  it("de extremo a extremo con fetch simulado: Groq da 413 y responde Mistral", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url.includes("groq")) return new Response('{"error":{"message":"Request too large for model"}}', { status: 413 });
      return Response.json({ choices: [{ message: { content: ok }, finish_reason: "stop" }] });
    }) as unknown as typeof fetch;
    const provider = new ChainProvider(
      { ...chains, orchestrator: chainOf("groq/openai/gpt-oss-120b", "mistral/mistral-small-2603") },
      {
        groq: createOpenAICompatibleCaller("groq", "k1", fetchImpl),
        mistral: createOpenAICompatibleCaller("mistral", "k2", fetchImpl),
      },
    );
    expect(await provider.summarize({ request: "x", tasks: [] })).toEqual({
      summary: "ok",
      model: "mistral/mistral-small-2603",
      fallbackFrom: ["groq/openai/gpt-oss-120b (413)"],
    });
    expect(urls).toEqual(["https://api.groq.com/openai/v1/chat/completions", "https://api.mistral.ai/v1/chat/completions"]);
  });
});

describe("proveedor compatible con OpenAI", () => {
  const full: LlmRequest = { ...request, output: PLAN_SCHEMA, timeoutMs: 1000 };

  it("gpt-oss en Groq y Mistral: json_schema estricto y opciones extra del eslabón", () => {
    const body = buildChatBody("groq", link("groq/openai/gpt-oss-120b?reasoning_effort=low"), full);
    expect(body).toMatchObject({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "system", content: "s" }, { role: "user", content: "p" }],
      temperature: 0.3,
      max_tokens: 100,
      reasoning_effort: "low",
      response_format: { type: "json_schema", json_schema: { name: "plan", schema: PLAN_SCHEMA.schema, strict: true } },
    });
    expect(buildChatBody("mistral", link("mistral/mistral-small-2603"), full).response_format.type).toBe("json_schema");
  });

  it("otros modelos de Groq: json_object con el esquema en el mensaje de sistema; se puede forzar con ?format=", () => {
    const body = buildChatBody("groq", link("groq/qwen/qwen3.8-27b"), full);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content).toContain('"acceptance_criteria"');
    const forced = buildChatBody("mistral", link("mistral/m?format=json_object"), full);
    expect(forced.response_format).toEqual({ type: "json_object" });
    expect(forced).not.toHaveProperty("format");
  });

  const respond = (status: number, body: string, headers: Record<string, string> = {}) =>
    createOpenAICompatibleCaller("groq", "clave-secreta", (async () => new Response(body, { status, headers })) as unknown as typeof fetch);
  const failure = (status: number, body: string, headers?: Record<string, string>) =>
    respond(status, body, headers)(link("groq/m"), full).catch((e: unknown) => e as LinkError);

  it("clasifica los errores HTTP", async () => {
    expect(await failure(413, "Request too large")).toMatchObject({ kind: "too_large", status: 413 });
    expect(await failure(503, "over capacity")).toMatchObject({ kind: "overloaded" });
    expect(await failure(404, "model not found")).toMatchObject({ kind: "unavailable" });
    expect(await failure(400, '{"error":{"code":"json_validate_failed"}}')).toMatchObject({ kind: "invalid_output" });
    expect(await failure(400, '{"message":"Model not available in your subscription tier"}')).toMatchObject({ kind: "unavailable" });
    expect(await failure(429, "rate limit", { "retry-after": "42" })).toMatchObject({ kind: "quota", retryAfterSeconds: 42 });
    expect(await failure(429, "rate limit")).toMatchObject({ kind: "quota", retryAfterSeconds: 30 });
    const bad = await failure(400, "bad request");
    expect(bad).not.toBeInstanceOf(LinkError);
    expect(String(bad)).not.toContain("clave-secreta");
  });

  it("respuesta cortada por max_tokens o sin contenido: JSON no válido", async () => {
    const cut = JSON.stringify({ choices: [{ message: { content: '{"tas' }, finish_reason: "length" }] });
    expect(await failure(200, cut)).toMatchObject({ kind: "invalid_output" });
    expect(await failure(200, JSON.stringify({ choices: [] }))).toMatchObject({ kind: "invalid_output" });
  });

  it("retry-after en segundos o como fecha", () => {
    const now = Date.parse("2026-11-23T10:00:00Z");
    expect(parseRetryAfter("7", now)).toBe(7);
    expect(parseRetryAfter("Mon, 23 Nov 2026 10:01:30 GMT", now)).toBe(90);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe("Gemini como eslabón", () => {
  const body429 = JSON.stringify({ error: { code: 429, details: [{ retryDelay: "37s" }] } });
  const geminiFailure = (error: Error) =>
    createGeminiCaller("clave", async () => {
      throw error;
    })(link("gemini/g"), { ...request, timeoutMs: 1000 }).catch((e: unknown) => e as LinkError);

  it("traduce los errores del SDK: 429 con retryDelay, 503 y 404", async () => {
    expect(await geminiFailure(new ApiError({ message: body429, status: 429 }))).toMatchObject({ kind: "quota", retryAfterSeconds: 37 });
    expect(await geminiFailure(new ApiError({ message: "overloaded", status: 503 }))).toMatchObject({ kind: "overloaded" });
    expect(await geminiFailure(new ApiError({ message: "no longer available", status: 404 }))).toMatchObject({ kind: "unavailable" });
    expect(await geminiFailure(new ApiError({ message: "bad", status: 400 }))).toBeInstanceOf(ApiError);
  });

  it("manda el esquema convertido y devuelve el texto", async () => {
    let config: unknown;
    const caller = createGeminiCaller("clave", (async (params: { config?: unknown }) => {
      config = params.config;
      return { text: ok };
    }) as never);
    expect(await caller(link("gemini/g"), { ...request, timeoutMs: 1000 })).toBe(ok);
    expect(config).toMatchObject({ responseMimeType: "application/json", responseSchema: { type: "OBJECT", required: ["summary"] } });
  });

  it("usa 30 s si la API no indica retryDelay", () => {
    expect(parseRetryDelay("sin pista")).toBe(30);
    expect(parseRetryDelay('"retryDelay": "2.5s"')).toBe(3);
  });
});

describe("esquemas", () => {
  it("un solo esquema plano, estricto y convertible a Gemini", () => {
    const change = DEVELOP_SCHEMA.schema.properties!.changes.items!;
    expect(change).toMatchObject({ additionalProperties: false, required: ["path", "action", "content"] });
    expect(toGeminiSchema(change)).toMatchObject({
      type: "OBJECT",
      required: ["path", "action"],
      properties: { content: { type: "STRING", nullable: true }, action: { enum: ["create", "update", "delete"] } },
    });
  });

  it("validación mínima de la forma", () => {
    const schema = DEVELOP_SCHEMA.schema;
    expect(shapeError({ summary: "s", changes: [{ path: "a", action: "delete" }] }, schema)).toBeNull();
    expect(shapeError({ summary: "s", changes: [{ path: "a", action: "borrar" }] }, schema)).toMatch(/action/);
    expect(shapeError({ summary: "s" }, schema)).toBe("falta respuesta.changes");
    expect(shapeError({ summary: 1, changes: [] }, schema)).toMatch(/summary debería ser string/);
    expect(shapeError([], schema)).toMatch(/object/);
  });
});
