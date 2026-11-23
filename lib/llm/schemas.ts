/**
 * Esquemas de salida de los agentes, en JSON Schema: van en el prompt de sistema y la respuesta
 * se valida contra ellos (`shapeError`).
 */
export interface JsonSchema {
  type: "object" | "array" | "string" | "boolean" | ["string", "null"];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: JsonSchema;
  enum?: string[];
}

const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const string: JsonSchema = { type: "string" };
const boolean: JsonSchema = { type: "boolean" };
const arrayOf = (items: JsonSchema): JsonSchema => ({ type: "array", items });

export const PLAN_SCHEMA = object({
  tasks: arrayOf(object({ title: string, description: string, acceptance_criteria: arrayOf(string) })),
});

export const DEVELOP_SCHEMA = object({
  summary: string,
  changes: arrayOf(
    object({
      path: string,
      action: { type: "string", enum: ["create", "update", "delete"] },
      // null en delete.
      content: { type: ["string", "null"] },
    }),
  ),
});

export const REVIEW_SCHEMA = object({
  passed: boolean,
  results: arrayOf(object({ criterion: string, ok: boolean, reason: string })),
});

export const SUMMARY_SCHEMA = object({ summary: string });

const nullable = (schema: JsonSchema) => Array.isArray(schema.type);

/**
 * Validación mínima de la forma: tipos, campos obligatorios y enums. Devuelve el primer problema o null.
 * Un campo anulable puede faltar (equivale a null). Ignora campos de más.
 */
export function shapeError(value: unknown, schema: JsonSchema, path = "respuesta"): string | null {
  if (value === null && nullable(schema)) return null;
  const base = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (actual !== base) return `${path} debería ser ${base} y es ${actual}`;
  if (schema.enum && !schema.enum.includes(value as string)) return `${path} no es uno de ${schema.enum.join(", ")}`;
  if (base === "array" && schema.items) {
    const items = value as unknown[];
    for (let i = 0; i < items.length; i++) {
      const error = shapeError(items[i], schema.items, `${path}[${i}]`);
      if (error) return error;
    }
  }
  if (base === "object" && schema.properties) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      const property = schema.properties[key];
      if (record[key] === undefined) {
        if (nullable(property)) continue;
        return `falta ${path}.${key}`;
      }
      const error = shapeError(record[key], property, `${path}.${key}`);
      if (error) return error;
    }
  }
  return null;
}
