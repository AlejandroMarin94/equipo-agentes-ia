import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_SITE = /^\/api\/runs\/[^/]+\/site\//;

/** Refresca la sesión de Supabase y exige login en todas las páginas salvo /login. */
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  // La vista previa de la web se sirve sin sesión (ver la ruta site).
  if (PUBLIC_SITE.test(path)) return NextResponse.next();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    return new NextResponse("Faltan las variables de entorno de Supabase.", { status: 500 });
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers ?? {}).forEach(([k, v]) => response.headers.set(k, v));
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const loggedIn = Boolean(data?.claims);

  // Las rutas de API responden 401 por su cuenta en vez de redirigir.
  if (!loggedIn && path !== "/login" && !path.startsWith("/api/")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  if (loggedIn && path === "/login") {
    return NextResponse.redirect(new URL("/", request.url));
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
