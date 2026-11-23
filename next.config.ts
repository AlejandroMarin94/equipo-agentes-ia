import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
