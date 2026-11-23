import { DEFAULT_RETRY_SECONDS, LinkError, errorFromStatus, type ChainLink, type LinkCaller, type LlmRequest } from "./chain";

/** Proveedores con API compatible con OpenAI (`POST {baseURL}/chat/completions`). */
export const OPENAI_COMPATIBLE = {
  groq: { baseURL: "https://api.groq.com/openai/v1" },
  mistral: { baseURL: "https://api.mistral.ai/v1" },
} as const;

export type OpenAICompatibleId = keyof typeof OPENAI_COMPATIBLE;

export type ResponseFormat = "json_schema" | "json_object";

/**
 * Cómo se pide el JSON a cada modelo. Groq solo garantiza el esquema estricto con gpt-oss; con el resto
 * se usa json_object y el esquema va en el mensaje de sistema. Mistral admite json_schema estricto.
 * Se puede forzar por eslabón con `?format=json_object`.
 */
export function responseFormatFor(provider: OpenAICompatibleId, link: Pick<ChainLink, "model" | "options">): ResponseFormat {
  const forced = link.options.format;
  if (forced === "json_schema" || forced === "json_object") return forced;
  if (provider === "groq") return link.model.startsWith("openai/gpt-oss") ? "json_schema" : "json_object";
  return "json_schema";
}

/** Cabecera retry-after: segundos o fecha HTTP. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(1, Math.ceil(seconds));
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(1, Math.ceil((date - now) / 1000));
}

interface ChatCompletion {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
}

export function buildChatBody(provider: OpenAICompatibleId, link: ChainLink, request: LlmRequest) {
  const format = responseFormatFor(provider, link);
  const extra = Object.fromEntries(Object.entries(link.options).filter(([key]) => key !== "format"));
  const system =
    format === "json_object"
      ? `${request.system}\n\nResponde SOLO con un objeto JSON válido que siga este esquema JSON:\n${JSON.stringify(request.output.schema)}`
      : request.system;
  return {
    model: link.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: request.prompt },
    ],
    temperature: request.temperature,
    max_tokens: request.maxTokens,
    response_format:
      format === "json_schema"
        ? { type: "json_schema", json_schema: { name: request.output.name, schema: request.output.schema, strict: true } }
        : { type: "json_object" },
    ...extra,
  };
}

/** Caller de la cadena para un proveedor compatible con OpenAI. `fetchImpl` se sustituye en los tests. */
export function createOpenAICompatibleCaller(
  provider: OpenAICompatibleId,
  apiKey: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): LinkCaller {
  const { baseURL } = OPENAI_COMPATIBLE[provider];
  return async (link, request) => {
    const response = await fetchImpl(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildChatBody(provider, link, request)),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    const raw = await response.text();
    if (!response.ok) {
      const message = `${provider} ${response.status}: ${raw.slice(0, 500)}`;
      // Groq responde 400 json_validate_failed cuando el modelo no consigue cumplir el esquema.
      if (response.status === 400 && raw.includes("json_validate_failed")) {
        throw new LinkError("invalid_output", message, 400);
      }
      const retryAfter =
        response.status === 429 ? (parseRetryAfter(response.headers.get("retry-after")) ?? DEFAULT_RETRY_SECONDS) : undefined;
      throw errorFromStatus(response.status, message, retryAfter) ?? new Error(message);
    }
    let body: ChatCompletion;
    try {
      body = JSON.parse(raw) as ChatCompletion;
    } catch {
      throw new LinkError("invalid_output", `${provider}: respuesta que no es JSON`);
    }
    const choice = body.choices?.[0];
    if (choice?.finish_reason === "length") {
      throw new LinkError("invalid_output", `${provider}: respuesta cortada por max_tokens`);
    }
    const content = choice?.message?.content;
    if (!content) throw new LinkError("invalid_output", `${provider}: respuesta sin contenido`);
    return content;
  };
}
