import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  ModelError,
  callChain,
  parseModels,
  resolveModels,
  type LlmRequest,
  type ModelCaller,
} from "@/lib/llm/chain";
import { claudeAuth, classifyFailure, createClaudeCaller, subprocessEnv, type CallInfo } from "@/lib/llm/claude";
import { claudeExecutable, resetClaudeExecutable } from "@/lib/llm/claude-cli";
import { getProvider } from "@/lib/llm";
import { MockProvider } from "@/lib/llm/mock";
import { ClaudeProvider } from "@/lib/llm/provider";
import { DEVELOP_SCHEMA, SUMMARY_SCHEMA, shapeError } from "@/lib/llm/schemas";
import { FatalLlmError, RateLimitError } from "@/lib/llm/types";

const request: Omit<LlmRequest, "timeoutMs"> = { system: "s", prompt: "p", output: SUMMARY_SCHEMA };
const ok = '{"summary":"ok"}';

/** Caller falso: cada modelo responde, en orden, lo que diga su lista (texto o error). */
function fakeCaller(behaviour: Record<string, (string | Error)[]>, calls: { model: string; prompt: string }[] = []): ModelCaller {
  return async (model, req) => {
    calls.push({ model, prompt: req.prompt });
    const result = behaviour[model]?.shift();
    if (result === undefined) throw new Error(`llamada inesperada a ${model}`);
    if (result instanceof Error) throw result;
    return result;
  };
}

describe("modelos de cada agente", () => {
  it("Opus para el Orquestador con Sonnet de respaldo; Sonnet para Develop y Testing", () => {
    expect(resolveModels({})).toEqual({
      orchestrator: ["claude-opus-5-5", "claude-sonnet-5-5"],
      develop: ["claude-sonnet-5-5"],
      testing: ["claude-sonnet-5-5"],
    });
  });

  it("CLAUDE_MODELS_*: lista separada por comas, sin repetir; vacía = por defecto", () => {
    expect(parseModels(" a , b,,a ")).toEqual(["a", "b"]);
    const models = resolveModels({ CLAUDE_MODELS_DEVELOP: "claude-opus-5-5", CLAUDE_MODELS_TESTING: "  " });
    expect(models.develop).toEqual(["claude-opus-5-5"]);
    expect(models.testing).toEqual(parseModels(DEFAULT_MODELS.testing));
  });

  it("getProvider: claude por defecto, mock, y error con otro valor", () => {
    expect(getProvider({})).toBeInstanceOf(ClaudeProvider);
    expect(getProvider({ LLM_PROVIDER: "mock" })).toBeInstanceOf(MockProvider);
    expect(() => getProvider({ LLM_PROVIDER: "otro" })).toThrow(/LLM_PROVIDER desconocido/);
  });
});

describe("callChain: respaldo y JSON", () => {
  it("si Opus está saturado responde Sonnet y queda registrado", async () => {
    const caller = fakeCaller({ opus: [new ModelError("overloaded", "x")], sonnet: [ok] });
    expect(await callChain(["opus", "sonnet"], caller, request)).toEqual({
      data: { summary: "ok" },
      model: "sonnet",
      fallbackFrom: ["opus (saturado)"],
    });
  });

  it("JSON no válido: se repite una vez con el error en el prompt y, si vale, no pasa al siguiente", async () => {
    const calls: { model: string; prompt: string }[] = [];
    const caller = fakeCaller({ opus: ["no es json", "```json\n" + ok + "\n```"] }, calls);
    const out = await callChain(["opus", "sonnet"], caller, request);
    expect(out).toMatchObject({ model: "opus", fallbackFrom: [] });
    expect(calls.map((c) => c.model)).toEqual(["opus", "opus"]);
    expect(calls[1].prompt).toMatch(/^p\n\nTu respuesta anterior no era válida \(JSON no válido/);
  });

  it("JSON con forma incorrecta dos veces: pasa al siguiente modelo", async () => {
    const caller = fakeCaller({ opus: ['{"resumen":"x"}', '{"resumen":"x"}'], sonnet: [ok] });
    const out = await callChain(["opus", "sonnet"], caller, request);
    expect(out).toMatchObject({ model: "sonnet", fallbackFrom: ["opus (JSON no válido)"] });
  });

  it("límite de uso en todos: espera hasta la renovación más próxima", async () => {
    const caller = fakeCaller({ opus: [new ModelError("quota", "x", 3600)], sonnet: [new ModelError("quota", "x", 900)] });
    const error = await callChain(["opus", "sonnet"], caller, request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ overloaded: false, retryAfterSeconds: 900, message: "opus (límite de uso), sonnet (límite de uso)" });
  });

  it("saturación o tiempo agotado: reintento a los 15 s sin contar como error", async () => {
    const caller = fakeCaller({ opus: [new ModelError("timeout", "x")], sonnet: [new ModelError("quota", "x", 900)] });
    expect(await callChain(["opus", "sonnet"], caller, request).catch((e: unknown) => e)).toMatchObject({
      overloaded: true,
      retryAfterSeconds: 15,
    });
  });

  it("modelo no disponible en todos: error con la lista", async () => {
    const caller = fakeCaller({ opus: [new ModelError("unavailable", "no existe")] });
    const error = await callChain(["opus"], caller, request).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(RateLimitError);
    expect((error as Error).message).toContain("opus (no disponible)");
  });

  it("un fallo fatal (sin sesión, credencial de pago) se lanza sin probar el resto", async () => {
    const calls: { model: string; prompt: string }[] = [];
    const caller = fakeCaller({ opus: [new FatalLlmError("sin sesión")], sonnet: [ok] }, calls);
    await expect(callChain(["opus", "sonnet"], caller, request)).rejects.toBeInstanceOf(FatalLlmError);
    expect(calls).toHaveLength(1);
  });
});

describe("ClaudeProvider", () => {
  const models = { orchestrator: ["opus"], develop: ["sonnet-dev"], testing: ["sonnet-test"] };
  const task = { position: 0, title: "t", description: "d", acceptance_criteria: ["c"], attempts: 0 };

  it("cada agente usa sus modelos", async () => {
    const answer = '{"tasks":[],"summary":"ok","changes":[],"passed":true,"results":[]}';
    const calls: { model: string; prompt: string }[] = [];
    const caller = fakeCaller({ opus: [answer, answer], "sonnet-dev": [answer], "sonnet-test": [answer] }, calls);
    const provider = new ClaudeProvider(models, caller);
    await provider.plan({ request: "x", files: {} });
    await provider.develop({ request: "x", task, feedback: null, files: {} });
    await provider.review({ request: "x", task, files: {} });
    expect(await provider.summarize({ request: "x", tasks: [] })).toEqual({ summary: "ok", model: "opus", fallbackFrom: [] });
    expect(calls.map((c) => c.model)).toEqual(["opus", "sonnet-dev", "sonnet-test", "opus"]);
  });

  it("Develop: content null (delete) se convierte en un cambio sin contenido", async () => {
    const answer = JSON.stringify({
      summary: "s",
      changes: [
        { path: "a.html", action: "update", content: "<p>hola</p>" },
        { path: "b.html", action: "delete", content: null },
      ],
    });
    const provider = new ClaudeProvider(models, fakeCaller({ "sonnet-dev": [answer] }));
    const out = await provider.develop({ request: "x", task, feedback: null, files: {} });
    expect(out.changes).toEqual([
      { path: "a.html", action: "update", content: "<p>hola</p>" },
      { path: "b.html", action: "delete" },
    ]);
  });
});

describe("proveedor claude: suscripción, entorno y errores", () => {
  const full: LlmRequest = { ...request, timeoutMs: 5000 };
  const init = (extra: Record<string, unknown> = {}) =>
    ({ type: "system", subtype: "init", apiKeySource: "none", tools: [], ...extra }) as unknown as SDKMessage;
  const success = (text: string, extra: Record<string, unknown> = {}) =>
    ({
      type: "result",
      subtype: "success",
      is_error: false,
      result: text,
      usage: { input_tokens: 10, output_tokens: 5 },
      ...extra,
    }) as unknown as SDKMessage;

  /** `query` falso: devuelve los mensajes dados y guarda las opciones con las que se llamó. */
  function fakeQuery(messages: SDKMessage[], seen: Options[] = [], thrown?: Error) {
    return (params: { prompt: string; options: Options }) => {
      seen.push(params.options);
      return (async function* () {
        yield* messages;
        if (thrown) throw thrown;
      })();
    };
  }

  const tokenEnv = {
    CLAUDE_CODE_OAUTH_TOKEN: "token-de-prueba",
    ANTHROPIC_API_KEY: "sk-de-pago",
    ANTHROPIC_AUTH_TOKEN: "otro",
    CLAUDE_CODE_USE_BEDROCK: "1",
    SUPABASE_SERVICE_ROLE_KEY: "secreta",
    PATH: "/usr/bin",
    HOME: "/Users/ale",
  };

  it("entorno mínimo: sin claves de pago ni variables de la app; con token, HOME y config en un directorio propio", () => {
    const env = subprocessEnv(tokenEnv, "token", "/tmp/equipo-agentes-claude");
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/tmp/equipo-agentes-claude",
      CLAUDE_CONFIG_DIR: "/tmp/equipo-agentes-claude/.claude",
      CLAUDE_CODE_OAUTH_TOKEN: "token-de-prueba",
    });
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "SUPABASE_SERVICE_ROLE_KEY"]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it("con la sesión del equipo pasa HOME (llavero) y nunca un token", () => {
    const env = subprocessEnv({ ...tokenEnv, CLAUDE_CODE_OAUTH_TOKEN: undefined }, "session", "/tmp/x");
    expect(env.HOME).toBe("/Users/ale");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  it("en Vercel sin token es un error de configuración; fuera, usa la sesión", () => {
    expect(() => claudeAuth({ VERCEL: "1" })).toThrow(FatalLlmError);
    expect(claudeAuth({})).toBe("session");
    expect(claudeAuth({ CLAUDE_CODE_OAUTH_TOKEN: "t" })).toBe("token");
  });

  it("solo generación: sin herramientas, sin ajustes, un turno, prompt literal y el entorno limpio", async () => {
    const seen: Options[] = [];
    const calls: CallInfo[] = [];
    const caller = createClaudeCaller({ env: tokenEnv, run: fakeQuery([init(), success(ok)], seen), onCall: (c) => calls.push(c) });
    expect(await caller("claude-sonnet-5-5", full)).toBe(ok);
    expect(seen[0]).toMatchObject({
      model: "claude-sonnet-5-5",
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      maxTurns: 1,
      verbatimPrompts: true,
      persistSession: false,
      permissionMode: "dontAsk",
    });
    expect(seen[0].systemPrompt).toContain('"summary"');
    expect(seen[0].env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(seen[0]).not.toHaveProperty("pathToClaudeCodeExecutable");
    expect(calls).toEqual([expect.objectContaining({ model: "claude-sonnet-5-5", ok: true, inputTokens: 10, outputTokens: 5 })]);
  });

  it("corta si la credencial no es la suscripción, si hay herramientas o si responde sin init", async () => {
    const run = (messages: SDKMessage[]) =>
      createClaudeCaller({ env: tokenEnv, run: fakeQuery(messages) })("m", full).catch((e: unknown) => e);
    expect(await run([init({ apiKeySource: "ANTHROPIC_API_KEY" }), success(ok)])).toMatchObject({
      name: "FatalLlmError",
      message: expect.stringContaining("no está usando la suscripción"),
    });
    expect(await run([init({ tools: ["Bash"] }), success(ok)])).toBeInstanceOf(FatalLlmError);
    expect(await run([success(ok)])).toBeInstanceOf(FatalLlmError);
  });

  it("límite de uso agotado o uso extra de pago: espera hasta la renovación", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 600;
    const rejected = { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour" } };
    const overage = { type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: true, resetsAt } };
    for (const event of [rejected, overage]) {
      const error = await createClaudeCaller({ env: tokenEnv, run: fakeQuery([init(), event as unknown as SDKMessage, success(ok)]) })(
        "m",
        full,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ModelError);
      expect((error as ModelError).kind).toBe("quota");
      expect((error as ModelError).retryAfterSeconds).toBeGreaterThan(590);
    }
  });

  it("mapea los errores del CLI: saturado, límite, modelo inexistente, sin sesión, facturación", () => {
    expect(classifyFailure("m", "API Error: 529 Overloaded", 529, "overloaded", null)).toMatchObject({ kind: "overloaded" });
    expect(classifyFailure("m", "Claude AI usage limit reached", null, undefined, null)).toMatchObject({ kind: "quota", retryAfterSeconds: 60 });
    expect(classifyFailure("m", "x", 404, "model_not_found", null)).toMatchObject({ kind: "unavailable" });
    expect(classifyFailure("m", "Not logged in · Please run /login", null, undefined, null)).toBeInstanceOf(FatalLlmError);
    expect(classifyFailure("m", "x", 401, "authentication_failed", null)).toBeInstanceOf(FatalLlmError);
    expect(classifyFailure("m", "x", 402, "billing_error", null)).toBeInstanceOf(FatalLlmError);
    expect(classifyFailure("m", "algo raro", 400, "invalid_request", null)).not.toBeInstanceOf(ModelError);
  });

  it("un resultado con error se traduce; si el CLI sale con error tras él, vale el resultado", async () => {
    const failed = success("API Error: 529 Overloaded", { is_error: true, api_error_status: 529 });
    const error = await createClaudeCaller({ env: tokenEnv, run: fakeQuery([init(), failed], [], new Error("exited with code 1")) })(
      "m",
      full,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "overloaded" });
  });

  it("sin respuesta en el tiempo dado: ModelError timeout", async () => {
    const hang = (params: { options: Options }) =>
      (async function* () {
        yield init();
        await new Promise((_, reject) => params.options.abortController!.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      })() as AsyncIterable<SDKMessage>;
    const error = await createClaudeCaller({ env: tokenEnv, run: hang })("m", { ...full, timeoutMs: 20 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "timeout" });
  });
});

describe("CLI de Claude comprimido (Vercel)", () => {
  afterEach(() => resetClaudeExecutable());

  function packed(content: Buffer) {
    const dir = mkdtempSync(join(tmpdir(), "cli-test-"));
    writeFileSync(join(dir, "claude-linux-x64.br"), brotliCompressSync(content));
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ version: "9.9.9", size: content.length }));
    return dir;
  }

  it("fuera de Linux o sin el archivo, el SDK usa su binario: no descomprime nada", async () => {
    expect(await claudeExecutable({ platform: "darwin", packedDir: packed(Buffer.from("x")) })).toBeUndefined();
    expect(await claudeExecutable({ platform: "linux", packedDir: mkdtempSync(join(tmpdir(), "vacio-")) })).toBeUndefined();
  });

  it("en Linux lo descomprime una sola vez en /tmp, ejecutable, aunque lo pidan dos pasos a la vez", async () => {
    const content = Buffer.from("#!/bin/sh\necho claude\n".repeat(1000));
    const packedDir = packed(content);
    const targetDir = mkdtempSync(join(tmpdir(), "destino-"));
    const [a, b] = await Promise.all([
      claudeExecutable({ platform: "linux", packedDir, targetDir }),
      claudeExecutable({ platform: "linux", packedDir, targetDir }),
    ]);
    expect(a).toBe(join(targetDir, "claude-cli-9.9.9", "claude"));
    expect(b).toBe(a);
    expect(readFileSync(a!)).toEqual(content);
    expect(statSync(a!).mode & 0o111).toBeTruthy();
  });

  it("si el tamaño no cuadra, falla y se puede volver a intentar", async () => {
    const packedDir = packed(Buffer.from("contenido"));
    writeFileSync(join(packedDir, "meta.json"), JSON.stringify({ version: "1.0.0", size: 999 }));
    const targetDir = mkdtempSync(join(tmpdir(), "destino-"));
    await expect(claudeExecutable({ platform: "linux", packedDir, targetDir })).rejects.toThrow(/se esperaban 999/);
  });
});

describe("esquemas", () => {
  it("validación mínima de la forma", () => {
    const schema = DEVELOP_SCHEMA.schema;
    expect(shapeError({ summary: "s", changes: [{ path: "a", action: "delete" }] }, schema)).toBeNull();
    expect(shapeError({ summary: "s", changes: [{ path: "a", action: "borrar" }] }, schema)).toMatch(/action/);
    expect(shapeError({ summary: "s" }, schema)).toBe("falta respuesta.changes");
    expect(shapeError({ summary: 1, changes: [] }, schema)).toMatch(/summary debería ser string/);
    expect(shapeError([], schema)).toMatch(/object/);
  });
});
