import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress } from "node:zlib";

/**
 * El ejecutable del CLI de Claude Code que lanza el SDK.
 *
 * En Vercel (Linux) el binario no cabe sin comprimir en la función: el build lo deja en
 * .claude-cli/claude-linux-x64.br (scripts/pack-claude-cli.mjs) y aquí se descomprime en /tmp
 * la primera vez que se necesita en cada instancia (~2 s). En cualquier otro sitio (macOS en local)
 * no hay nada que descomprimir: el SDK usa el binario de su paquete para la plataforma.
 */

const PACKED_DIR = join(process.cwd(), ".claude-cli");
const PACKED_FILE = "claude-linux-x64.br";

interface Meta {
  version: string;
  size: number;
}

let unpacking: Promise<string> | null = null;

export async function claudeExecutable(
  options: { platform?: NodeJS.Platform; packedDir?: string; targetDir?: string } = {},
): Promise<string | undefined> {
  const { platform = process.platform, packedDir = PACKED_DIR, targetDir = tmpdir() } = options;
  if (platform !== "linux") return undefined;
  const packed = join(packedDir, PACKED_FILE);
  if (!(await exists(packed))) return undefined;
  // Una sola descompresión por instancia aunque lleguen varios pasos a la vez.
  unpacking ??= unpack(packed, join(packedDir, "meta.json"), targetDir).catch((error: unknown) => {
    unpacking = null;
    throw error;
  });
  return unpacking;
}

async function unpack(packed: string, metaFile: string, targetDir: string): Promise<string> {
  const meta = JSON.parse(await readFile(metaFile, "utf8")) as Meta;
  const dir = join(targetDir, `claude-cli-${meta.version}`);
  const target = join(dir, "claude");
  // Sin sha256 al reutilizar: leer ~381 MB cuesta ~0,5 s (más en Vercel) en cada arranque, /tmp es de la propia
  // instancia y el rename atómico ya impide un binario a medio escribir; el sha256 se comprueba al empaquetar.
  if ((await stat(target).catch(() => null))?.size === meta.size) return target;

  await mkdir(dir, { recursive: true });
  // A un archivo propio y luego rename (atómico): nunca se lanza un binario a medio escribir.
  const partial = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await pipeline(createReadStream(packed), createBrotliDecompress(), createWriteStream(partial));
    const written = (await stat(partial)).size;
    if (written !== meta.size) throw new Error(`CLI de Claude descomprimido con ${written} bytes; se esperaban ${meta.size}`);
    await chmod(partial, 0o755);
    await rename(partial, target);
  } finally {
    await rm(partial, { force: true });
  }
  return target;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Solo para los tests: olvida la descompresión ya hecha. */
export function resetClaudeExecutable() {
  unpacking = null;
}
