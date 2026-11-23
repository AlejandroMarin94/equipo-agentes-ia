import type { NextConfig } from "next";

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    // Todo salvo la vista previa (/api/runs/[id]/site/...), que se muestra en un iframe de la propia app
    // y pone sus propias cabeceras (sandbox y frame-ancestors 'self') en su ruta.
    return [{ source: "/:path((?!api/runs/[^/]+/site/).*)", headers: SECURITY_HEADERS }];
  },
  // El SDK lanza el CLI de Claude Code como subproceso: se carga de node_modules tal cual, sin empaquetar.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  // En Vercel la función del paso lleva el CLI de Linux comprimido (scripts/pack-claude-cli.mjs) y lo
  // descomprime en /tmp; los paquetes nativos del SDK (~380 MB cada uno) no caben y no se usan.
  outputFileTracingIncludes: {
    "/api/runs/*/step": ["./.claude-cli/claude-linux-x64.br", "./.claude-cli/meta.json"],
  },
  outputFileTracingExcludes: {
    "*": ["./node_modules/@anthropic-ai/claude-agent-sdk-*/**"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
