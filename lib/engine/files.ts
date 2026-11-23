import type { FileChange, SiteFiles } from "../types";

const ALLOWED_EXTENSIONS = [".html", ".css", ".js", ".svg", ".txt", ".json"];
const MAX_FILE_SIZE = 100_000;
const MAX_FILES = 30;
/** La web entera viaja en cada llamada a Develop y Testing: su tamaño total también tiene tope. */
export const MAX_SITE_SIZE = 300_000;

const siteSize = (files: SiteFiles) => Object.values(files).reduce((total, content) => total + content.length, 0);

interface ApplyResult {
  files: SiteFiles;
  applied: FileChange[];
  rejected: { change: FileChange; reason: string }[];
}

/** Normaliza una ruta relativa de la web. Devuelve null si no es válida. */
export function normalizePath(raw: string): string | null {
  const path = raw.trim().replace(/^\.?\/+/, "");
  if (!path || path.length > 120) return null;
  if (!/^[a-zA-Z0-9._\-/]+$/.test(path)) return null;
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  if (!ALLOWED_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext))) return null;
  return path;
}

/**
 * Aplica los cambios propuestos por Develop sobre una copia de los archivos.
 * Los cambios inválidos no se aplican y se devuelven en `rejected`.
 */
export function applyChanges(current: SiteFiles, changes: FileChange[]): ApplyResult {
  const files: SiteFiles = { ...current };
  const applied: FileChange[] = [];
  const rejected: ApplyResult["rejected"] = [];
  let total = siteSize(files);

  for (const change of changes) {
    const path = normalizePath(change.path ?? "");
    if (!path) {
      rejected.push({ change, reason: "Ruta no válida o extensión no permitida" });
      continue;
    }

    if (change.action === "delete") {
      if (!(path in files)) {
        rejected.push({ change, reason: "El archivo no existe" });
        continue;
      }
      total -= files[path].length;
      delete files[path];
      applied.push({ path, action: "delete" });
      continue;
    }

    if (change.action !== "create" && change.action !== "update") {
      rejected.push({ change, reason: `Acción desconocida: ${String(change.action)}` });
      continue;
    }

    const content = change.content ?? "";
    if (content.length > MAX_FILE_SIZE) {
      rejected.push({ change, reason: "El archivo supera el tamaño máximo" });
      continue;
    }
    if (!(path in files) && Object.keys(files).length >= MAX_FILES) {
      rejected.push({ change, reason: "Se ha alcanzado el número máximo de archivos" });
      continue;
    }

    const newTotal = total - (files[path]?.length ?? 0) + content.length;
    if (newTotal > MAX_SITE_SIZE) {
      rejected.push({ change, reason: "La web superaría el tamaño máximo total" });
      continue;
    }

    const action = path in files ? "update" : "create";
    total = newTotal;
    files[path] = content;
    applied.push({ path, action, content });
  }

  return { files, applied, rejected };
}

export function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "text/plain; charset=utf-8";
  }
}
