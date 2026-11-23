import { Script } from "node:vm";
import type { CheckResult, SiteFiles } from "../types";

/** Etiquetas contenedoras cuyo cierre comprobamos (no las vacías ni <p>/<li>, que admiten cierre implícito). */
const PAIRED_TAGS = [
  "html", "head", "body", "header", "main", "footer", "nav", "section", "article",
  "aside", "div", "form", "ul", "ol", "table", "button", "label", "select",
  "textarea", "a", "h1", "h2", "h3", "h4", "title", "span",
];

const EXTERNAL_REF = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

function stripHtmlNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "<script></script>")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "<style></style>");
}

function htmlProblems(path: string, html: string): string[] {
  if (!html.trim()) return [`${path}: el archivo está vacío`];
  const problems: string[] = [];
  const clean = stripHtmlNoise(html);
  for (const tag of ["html", "head", "body"]) {
    if (!new RegExp(`<${tag}[\\s>]`, "i").test(clean)) problems.push(`${path}: falta <${tag}>`);
  }
  for (const tag of PAIRED_TAGS) {
    const opens = (clean.match(new RegExp(`<${tag}(?=[\\s>])[^>]*>`, "gi")) ?? []).length;
    const closes = (clean.match(new RegExp(`</${tag}\\s*>`, "gi")) ?? []).length;
    if (opens !== closes) {
      problems.push(`${path}: <${tag}> abierta ${opens} veces y cerrada ${closes}`);
    }
  }
  return problems;
}

function resolveRef(fromPath: string, ref: string): string {
  const base = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")).split("/") : [];
  const parts = [...base];
  for (const segment of ref.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

function safeDecode(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

/** Referencias locales (href/src) de un HTML que no existen entre los archivos. */
function brokenRefs(path: string, html: string, files: SiteFiles): string[] {
  const problems: string[] = [];
  const clean = html.replace(/<!--[\s\S]*?-->/g, "");
  const attr = /\s(?:href|src)\s*=\s*["']([^"']*)["']/gi;
  for (const match of clean.matchAll(attr)) {
    const raw = match[1].trim();
    if (!raw || EXTERNAL_REF.test(raw)) continue;
    const ref = safeDecode(raw.split(/[?#]/)[0]);
    if (!ref) continue;
    if (ref.startsWith("/")) {
      problems.push(`${path}: "${raw}" usa una ruta absoluta; debe ser relativa`);
      continue;
    }
    const target = resolveRef(path, ref);
    if (!(target in files)) problems.push(`${path}: enlaza a "${raw}", que no existe`);
  }
  return problems;
}

function cssProblems(path: string, css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
  let depth = 0;
  for (const ch of clean) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth < 0) return [`${path}: hay una llave "}" de más`];
  }
  return depth === 0 ? [] : [`${path}: faltan ${depth} llaves de cierre`];
}

function jsProblems(path: string, js: string): string[] {
  try {
    // Solo compila (no ejecuta) para detectar errores de sintaxis.
    new Script(js, { filename: path });
    return [];
  } catch (error) {
    return [`${path}: error de sintaxis (${(error as Error).message})`];
  }
}

function result(criterion: string, problems: string[], okReason: string): CheckResult {
  return problems.length === 0
    ? { criterion, ok: true, reason: okReason }
    : { criterion, ok: false, reason: problems.join("; ") };
}

/**
 * Comprobaciones deterministas sobre toda la web (no solo lo que ha tocado
 * Develop), para detectar también lo que se rompe en otras páginas.
 */
export function runDeterministicChecks(files: SiteFiles): CheckResult[] {
  const paths = Object.keys(files).sort();
  const html = paths.filter((p) => p.endsWith(".html"));
  const css = paths.filter((p) => p.endsWith(".css"));
  const js = paths.filter((p) => p.endsWith(".js"));

  return [
    result(
      "[Automática] HTML no vacío y bien formado",
      html.length === 0 ? ["No hay ningún archivo HTML"] : html.flatMap((p) => htmlProblems(p, files[p])),
      `${html.length} archivos HTML correctos`,
    ),
    result(
      "[Automática] Enlaces, hojas de estilo y scripts locales existen",
      html.flatMap((p) => brokenRefs(p, files[p], files)),
      "Todas las referencias locales existen",
    ),
    result(
      "[Automática] CSS con llaves equilibradas",
      css.flatMap((p) => cssProblems(p, files[p])),
      `${css.length} archivos CSS correctos`,
    ),
    result(
      "[Automática] JavaScript sin errores de sintaxis",
      js.flatMap((p) => jsProblems(p, files[p])),
      `${js.length} archivos JS correctos`,
    ),
  ];
}
