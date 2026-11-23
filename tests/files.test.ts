import { describe, expect, it } from "vitest";
import { MAX_SITE_SIZE, applyChanges, contentTypeFor, normalizePath } from "@/lib/engine/files";

describe("applyChanges", () => {
  const base = { "index.html": "<html></html>", "styles.css": "body{}" };

  it("crea, modifica y borra archivos sin mutar el original", () => {
    const result = applyChanges(base, [
      { path: "contacto.html", action: "create", content: "nuevo" },
      { path: "styles.css", action: "update", content: "body{color:red}" },
      { path: "index.html", action: "delete" },
    ]);
    expect(result.files).toEqual({ "contacto.html": "nuevo", "styles.css": "body{color:red}" });
    expect(result.applied.map((c) => c.action)).toEqual(["create", "update", "delete"]);
    expect(result.rejected).toHaveLength(0);
    expect(base["index.html"]).toBe("<html></html>");
  });

  it("trata un create sobre un archivo existente como update", () => {
    const result = applyChanges(base, [{ path: "styles.css", action: "create", content: "x{}" }]);
    expect(result.applied[0].action).toBe("update");
  });

  it("rechaza rutas peligrosas, extensiones no permitidas y borrados inexistentes", () => {
    const result = applyChanges(base, [
      { path: "../secreto.html", action: "create", content: "x" },
      { path: "/etc/passwd", action: "create", content: "x" },
      { path: "virus.php", action: "create", content: "x" },
      { path: "nada.html", action: "delete" },
    ]);
    expect(result.applied).toHaveLength(0);
    expect(result.rejected).toHaveLength(4);
    expect(result.files).toEqual(base);
  });

  it("rechaza el cambio que haría pasar la web del tamaño total máximo, contando lo que se borra o reemplaza", () => {
    const chunk = "x".repeat(90_000);
    const files = { "a.html": chunk, "b.html": chunk, "c.html": chunk };
    const result = applyChanges(files, [
      { path: "d.html", action: "create", content: chunk }, // 360 KB: no cabe
      { path: "a.html", action: "update", content: "x".repeat(100_000) }, // 280 KB: cabe
      { path: "b.html", action: "delete" }, // 190 KB
      { path: "d.html", action: "create", content: "x".repeat(100_000) }, // 290 KB: ya cabe
    ]);
    expect(result.rejected).toEqual([{ change: expect.objectContaining({ path: "d.html" }), reason: expect.stringContaining("tamaño máximo total") }]);
    expect(result.applied.map((c) => `${c.action} ${c.path}`)).toEqual(["update a.html", "delete b.html", "create d.html"]);
    expect(Object.values(result.files).join("").length).toBeLessThanOrEqual(MAX_SITE_SIZE);
  });

  it("normaliza rutas con ./ inicial", () => {
    expect(normalizePath("./css/estilos.css")).toBe("css/estilos.css");
    expect(normalizePath("a/../b.html")).toBeNull();
  });

  it("devuelve el content-type según la extensión", () => {
    expect(contentTypeFor("index.html")).toContain("text/html");
    expect(contentTypeFor("styles.css")).toContain("text/css");
    expect(contentTypeFor("script.js")).toContain("javascript");
  });
});
