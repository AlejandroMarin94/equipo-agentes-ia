/**
 * Empaqueta el CLI de Claude Code para Linux x64 (glibc) comprimido con brotli en .claude-cli/,
 * para la función del paso en Vercel: el binario (~381 MB) no cabe en los 250 MB de una función,
 * comprimido sí. En el arranque en frío lib/llm/claude-cli.ts lo descomprime en /tmp.
 *
 *   node scripts/pack-claude-cli.mjs            # solo en el build de Vercel (VERCEL=1); fuera, no hace nada
 *   node scripts/pack-claude-cli.mjs --force    # también en local, para comprobar tamaños
 *
 * Versión fijada a la del SDK instalado. El binario sale de node_modules si npm ya instaló el paquete
 * de Linux x64 (en Vercel) y, si no (macOS), se descarga con `npm pack`; se comprueba con el sha256 del
 * manifiesto del SDK. Si .claude-cli/ ya tiene esa versión, no se repite. .claude-cli/ no va a git.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { constants, createBrotliCompress } from "node:zlib";

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, ".claude-cli");
const OUT_FILE = join(OUT_DIR, "claude-linux-x64.br");
const META_FILE = join(OUT_DIR, "meta.json");
const PACKAGE = "@anthropic-ai/claude-agent-sdk-linux-x64";
const QUALITY = 9;

// MB decimales (1 MB = 10^6 bytes), como el límite de 250 MB de Vercel y el README.
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

if (!process.env.VERCEL && !process.argv.includes("--force")) {
  console.log("pack-claude-cli: fuera de Vercel no hace falta (usa --force para probarlo).");
  process.exit(0);
}

const SDK_DIR = join(ROOT, "node_modules/@anthropic-ai/claude-agent-sdk");
const version = readJson(join(SDK_DIR, "package.json")).version;
const expected = readJson(join(SDK_DIR, "manifest.json")).platforms["linux-x64"];
if (existsSync(OUT_FILE) && existsSync(META_FILE) && readJson(META_FILE).version === version) {
  console.log(`pack-claude-cli: ya empaquetado ${PACKAGE}@${version} (${mb(statSync(OUT_FILE).size)}).`);
  process.exit(0);
}

let source = join(ROOT, "node_modules", PACKAGE, "claude");
let cleanup = null;
const installed = join(ROOT, "node_modules", PACKAGE, "package.json");
if (!existsSync(source) || readJson(installed).version !== version) {
  const work = mkdtempSync(join(tmpdir(), "claude-cli-"));
  cleanup = () => rmSync(work, { recursive: true, force: true });
  console.log(`pack-claude-cli: descargando ${PACKAGE}@${version}…`);
  const tarball = execFileSync("npm", ["pack", `${PACKAGE}@${version}`, "--pack-destination", work, "--silent"], {
    encoding: "utf8",
  }).trim().split("\n").at(-1);
  execFileSync("tar", ["-xzf", join(work, tarball), "-C", work, "package/claude"]);
  source = join(work, "package", "claude");
}

const size = statSync(source).size;
const sha256 = createHash("sha256").update(readFileSync(source)).digest("hex");
if (sha256 !== expected.checksum || size !== expected.size) {
  cleanup?.();
  throw new Error(`pack-claude-cli: el binario no coincide con el manifiesto del SDK (${sha256}, ${size} bytes)`);
}

mkdirSync(OUT_DIR, { recursive: true });
const started = Date.now();
const partial = `${OUT_FILE}.${process.pid}.tmp`;
await pipeline(
  createReadStream(source),
  createBrotliCompress({
    params: {
      [constants.BROTLI_PARAM_QUALITY]: QUALITY,
      [constants.BROTLI_PARAM_LGWIN]: 24,
      [constants.BROTLI_PARAM_SIZE_HINT]: size,
    },
  }),
  createWriteStream(partial),
);
renameSync(partial, OUT_FILE);
writeFileSync(META_FILE, `${JSON.stringify({ version, size, sha256 }, null, 2)}\n`);
cleanup?.();
console.log(
  `pack-claude-cli: ${PACKAGE}@${version} ${mb(size)} → ${mb(statSync(OUT_FILE).size)} (brotli q${QUALITY}) en ${((Date.now() - started) / 1000).toFixed(0)} s.`,
);
