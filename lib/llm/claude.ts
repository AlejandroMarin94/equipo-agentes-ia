import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  query,
  type Options,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_RETRY_SECONDS, ModelError, type LlmRequest, type ModelCaller } from "./models";
import { claudeExecutable } from "./claude-cli";
import { FatalLlmError, describeError } from "./types";

/**
 * Claude por la suscripción (Claude Agent SDK, que lanza el CLI de Claude Code como subproceso),
 * nunca por la API de pago:
 *
 * - **Facturación**: el subproceso recibe un entorno mínimo (el SDK no lo mezcla con process.env),
 *   sin ANTHROPIC_API_KEY ni ninguna variable que haga cobrar por la API o por una nube. Si el mensaje
 *   `init` del CLI dice que la credencial no es la suscripción (`apiKeySource` distinto de «none»),
 *   se corta la llamada.
 * - **Solo generación**: sin herramientas del SDK (`tools: []`), sin MCP, sin ajustes ni CLAUDE.md,
 *   un solo turno y el prompt tal cual (`verbatimPrompts`: el HTML de la web no se interpreta como
 *   `@archivo` ni `/comando`). Si el `init` anuncia alguna herramienta, se corta.
 *
 * Autenticación: CLAUDE_CODE_OAUTH_TOKEN (de `claude setup-token`) o, solo fuera de Vercel, la sesión
 * de Claude Code del equipo. Con token, HOME y CLAUDE_CONFIG_DIR van a un directorio propio en /tmp.
 */

const OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

/** Lo único del entorno de la app que necesita el CLI. */
const ALLOWED_ENV = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TERM",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];
/** Con la sesión del equipo: el CLI busca su credencial en el llavero del usuario. */
const SESSION_ENV = ["HOME", "USER", "LOGNAME"];

type Env = Record<string, string | undefined>;
export type ClaudeAuth = "token" | "session";

const NO_SESSION =
  "Claude no tiene con qué entrar: pon CLAUDE_CODE_OAUTH_TOKEN (de `claude setup-token`) o, en local, inicia sesión en Claude Code.";

/** Cómo entra el CLI. En Vercel no hay sesión que valga: sin token es un error de configuración. */
export function claudeAuth(env: Env): ClaudeAuth {
  if (env[OAUTH_TOKEN_ENV]?.trim()) return "token";
  if (env.VERCEL) throw new FatalLlmError("Falta CLAUDE_CODE_OAUTH_TOKEN en el entorno (se obtiene con `claude setup-token`).");
  return "session";
}

/** Directorio vacío y fijo: cwd del CLI (y su HOME con token), sin el código de la app ni configuraciones. */
function workDir(base = tmpdir()): string {
  const dir = join(base, "equipo-agentes-claude");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** El entorno completo del subproceso: la lista blanca y nada más. */
export function subprocessEnv(env: Env, auth: ClaudeAuth, home: string): Record<string, string> {
  const names = auth === "session" ? [...ALLOWED_ENV, ...SESSION_ENV] : ALLOWED_ENV;
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value) out[name] = value;
  }
  Object.assign(out, {
    CLAUDE_AGENT_SDK_CLIENT_APP: "equipo-agentes-ia",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    // Nada más que la respuesta: ni telemetría, ni actualizarse, ni los conectores de claude.ai.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    TZ: "Europe/Madrid",
  });
  if (auth === "token") {
    Object.assign(out, {
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      [OAUTH_TOKEN_ENV]: env[OAUTH_TOKEN_ENV]!.trim(),
    });
  }
  return out;
}

function claudeOptions(
  model: string,
  request: LlmRequest,
  extra: { env: Record<string, string>; cwd: string; executable?: string; abortController: AbortController },
): Options {
  return {
    model,
    systemPrompt: `${request.system}\n\nResponde SOLO con un objeto JSON válido, sin texto alrededor ni bloques de código, que siga este esquema JSON:\n${JSON.stringify(request.output)}`,
    tools: [],
    allowedTools: [],
    mcpServers: {},
    strictMcpConfig: true,
    permissionMode: "dontAsk",
    settingSources: [],
    maxTurns: 1,
    verbatimPrompts: true,
    persistSession: false,
    cwd: extra.cwd,
    env: extra.env,
    abortController: extra.abortController,
    ...(extra.executable ? { pathToClaudeCodeExecutable: extra.executable } : {}),
  };
}

/** Lo que se sabe de cada llamada (para run-local y el log). */
export interface CallInfo {
  model: string;
  ms: number;
  ok: boolean;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
}

type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

const QUOTA_PATTERN = /usage limit|rate.?limit|limit reached|quota|too many requests|\b429\b/i;
const NO_SESSION_PATTERN = /not logged in|please run \/login|invalid api key|oauth token|authentication|\b401\b/i;
const OVERLOADED_PATTERN = /overloaded|\b529\b|\b5\d\d\b|server error/i;
const UNAVAILABLE_PATTERN = /model.{0,40}(not found|not available|does not exist)|invalid model|unknown model|\b404\b/i;
const AUTH_ERRORS: SDKAssistantMessageError[] = [
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
];

const secondsUntil = (unixSeconds: number | undefined, now = Date.now()) =>
  unixSeconds ? Math.max(1, Math.ceil(unixSeconds - now / 1000)) : DEFAULT_RETRY_SECONDS;

/** Traduce un fallo del CLI: límite o saturación → siguiente modelo / espera; sin sesión o pago → fatal. */
export function classifyFailure(
  model: string,
  detail: string,
  status: number | null | undefined,
  assistantError: SDKAssistantMessageError | undefined,
  limit: SDKRateLimitInfo | null,
): Error {
  const message = `${model}: ${detail.slice(0, 300) || "sin detalle"}`;
  if (assistantError === "billing_error") {
    return new FatalLlmError("Claude pide facturación: se corta para no cobrar fuera de la suscripción.", message);
  }
  if (assistantError === "rate_limit" || status === 429 || QUOTA_PATTERN.test(detail)) {
    return new ModelError("quota", message, secondsUntil(limit?.resetsAt));
  }
  if (AUTH_ERRORS.includes(assistantError!) || status === 401 || status === 403 || NO_SESSION_PATTERN.test(detail)) {
    return new FatalLlmError(NO_SESSION, message);
  }
  if (assistantError === "model_not_found" || status === 404 || UNAVAILABLE_PATTERN.test(detail)) {
    return new ModelError("unavailable", message);
  }
  if (assistantError === "overloaded" || assistantError === "server_error" || (status ?? 0) >= 500 || OVERLOADED_PATTERN.test(detail)) {
    return new ModelError("overloaded", message);
  }
  if (assistantError === "max_output_tokens") return new ModelError("invalid_output", `${message} (respuesta cortada)`);
  return new Error(`Claude falló: ${message}`);
}

/** Corta ante el límite de uso agotado o cualquier señal de uso extra de pago (overage). */
function checkLimit(model: string, info: SDKRateLimitInfo) {
  const overage = info.rateLimitType === "overage" || info.isUsingOverage || info.overageInUse;
  if (info.status === "rejected" || overage) {
    const what = overage ? "uso extra de pago" : `límite de uso ${info.rateLimitType ?? ""}`.trim();
    throw new ModelError("quota", `${model}: ${what}`, secondsUntil(info.resetsAt));
  }
}

/**
 * Caller de Claude para callWithFallback (models.ts). `run` (el `query` del SDK) y `env` se sustituyen en los tests;
 * `onCall` recibe cada llamada terminada.
 */
export function createClaudeCaller(
  options: { env?: Env; run?: QueryFn; onCall?: (info: CallInfo) => void } = {},
): ModelCaller {
  const { env = process.env, run = query as QueryFn, onCall } = options;
  return async (model, request) => {
    const started = Date.now();
    const usage: Partial<CallInfo> = {};
    try {
      const text = await callOnce(model, request, env, run, usage);
      onCall?.({ model, ms: Date.now() - started, ok: true, ...usage });
      return text;
    } catch (error) {
      onCall?.({ model, ms: Date.now() - started, ok: false, error: describeError(error), ...usage });
      throw error;
    }
  };
}

async function callOnce(model: string, request: LlmRequest, env: Env, run: QueryFn, usage: Partial<CallInfo>): Promise<string> {
  const auth = claudeAuth(env);
  const home = workDir();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), request.timeoutMs);
  let authorized = false;
  let result: SDKResultMessage | null = null;
  let limit: SDKRateLimitInfo | null = null;
  let assistantError: SDKAssistantMessageError | undefined;

  try {
    const executable = await claudeExecutable();
    const messages = run({
      prompt: request.prompt,
      options: claudeOptions(model, request, { env: subprocessEnv(env, auth, home), cwd: home, executable, abortController }),
    });
    for await (const message of messages) {
      if (message.type === "system" && message.subtype === "init") {
        if (message.apiKeySource !== "none") {
          throw new FatalLlmError(
            `Claude no está usando la suscripción (credencial «${message.apiKeySource}»): se corta para no cobrar por la API.`,
          );
        }
        if (!Array.isArray(message.tools) || message.tools.length > 0) {
          throw new FatalLlmError("Claude arrancó con herramientas: solo debe generar texto.", String(message.tools));
        }
        authorized = true;
      } else if (message.type === "rate_limit_event") {
        limit = message.rate_limit_info;
        checkLimit(model, limit);
      } else if (message.type === "assistant" || message.type === "result") {
        if (!authorized) {
          throw new FatalLlmError("Claude respondió sin decir antes con qué credencial entraba: se corta para no cobrar por la API.");
        }
        if (message.type === "assistant" && message.error) assistantError = message.error;
        if (message.type === "result") result = message;
      }
    }
  } catch (error) {
    if (error instanceof FatalLlmError || error instanceof ModelError) throw error;
    if (abortController.signal.aborted) {
      throw new ModelError("timeout", `${model}: sin respuesta en ${Math.round(request.timeoutMs / 1000)} s`);
    }
    // El CLI sale con error tras un resultado con is_error: vale el resultado si llegó.
    if (!result) {
      throw classifyFailure(model, error instanceof Error ? error.message : String(error), null, assistantError, limit);
    }
  } finally {
    clearTimeout(timer);
  }

  if (!result) throw new Error(`Claude (${model}) terminó sin responder.`);
  // La entrada cuenta también lo leído o escrito en la caché de prompts.
  const u = result.usage;
  usage.inputTokens = u && (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  usage.outputTokens = u?.output_tokens;
  if (result.subtype !== "success" || result.is_error) {
    const detail = result.subtype === "success" ? result.result : [result.subtype, ...(result.errors ?? [])].join(": ");
    const status = result.subtype === "success" ? result.api_error_status : null;
    throw classifyFailure(model, detail, status, assistantError, limit);
  }
  return result.result;
}
