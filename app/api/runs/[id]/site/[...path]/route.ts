import { contentTypeFor, normalizePath } from "@/lib/engine/files";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * La web generada se sirve aislada: el id del run (UUID) hace de enlace
 * secreto y la cabecera CSP sandbox le da un origen opaco, así su JavaScript
 * no puede leer la sesión ni llamar a la API de la aplicación.
 */
const SANDBOX_HEADERS = {
  "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-modals",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

function notFound(message: string) {
  return new Response(`<!DOCTYPE html><meta charset="utf-8"><p style="font-family:sans-serif">${message}</p>`, {
    status: 404,
    headers: { ...SANDBOX_HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function GET(_request: Request, ctx: RouteContext<"/api/runs/[id]/site/[...path]">) {
  const { id, path } = await ctx.params;
  const filePath = normalizePath(path.join("/"));
  if (!UUID.test(id) || !filePath) return notFound("Archivo no válido.");

  const { data, error } = await createAdminClient()
    .from("run_files")
    .select("content")
    .eq("run_id", id)
    .eq("path", filePath)
    .maybeSingle();
  if (error) return new Response("Error al leer el archivo", { status: 500 });
  if (!data) return notFound(`Esta página (${filePath}) no existe en la web.`);

  return new Response(data.content as string, {
    headers: { ...SANDBOX_HEADERS, "Content-Type": contentTypeFor(filePath) },
  });
}

/** Los formularios de la web de demo no envían nada: se confirma y ya está. */
export async function POST() {
  return new Response(
    `<!DOCTYPE html><html lang="es"><meta charset="utf-8"><body style="font-family:sans-serif;padding:2rem">
<p>Formulario recibido. Esto es una vista previa: no se ha enviado nada.</p>
<p><a href="javascript:history.back()">Volver</a></p></body></html>`,
    { headers: { ...SANDBOX_HEADERS, "Content-Type": "text/html; charset=utf-8" } },
  );
}
