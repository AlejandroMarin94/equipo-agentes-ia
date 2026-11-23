import { describe, expect, it } from "vitest";
import { runDeterministicChecks } from "@/lib/engine/checks";
import { TEMPLATE_FILES } from "@/lib/template";

const failing = (files: Record<string, string>) => runDeterministicChecks(files).filter((r) => !r.ok);

describe("comprobaciones deterministas de Testing", () => {
  it("la web de partida las pasa todas", () => {
    expect(failing(TEMPLATE_FILES)).toEqual([]);
  });

  it("detecta un HTML vacío", () => {
    const result = failing({ ...TEMPLATE_FILES, "contacto.html": "   " });
    expect(result[0].reason).toContain("contacto.html: el archivo está vacío");
  });

  it("detecta etiquetas sin cerrar", () => {
    const html = TEMPLATE_FILES["index.html"].replace("</main>", "");
    const result = failing({ ...TEMPLATE_FILES, "index.html": html });
    expect(result[0].reason).toContain("<main>");
  });

  it("detecta enlaces a páginas que no existen y rutas absolutas", () => {
    const html = TEMPLATE_FILES["index.html"]
      .replace('href="nosotros.html"', 'href="contacto.html"')
      .replace('href="styles.css"', 'href="/styles.css"');
    const [refs] = failing({ ...TEMPLATE_FILES, "index.html": html });
    expect(refs.reason).toContain('"contacto.html", que no existe');
    expect(refs.reason).toContain("ruta absoluta");
  });

  it("ignora enlaces externos, anclas y mailto", () => {
    const html = TEMPLATE_FILES["index.html"].replace(
      "</main>",
      '<a href="https://example.com">x</a><a href="#arriba">y</a><a href="mailto:a@b.es">z</a></main>',
    );
    expect(failing({ ...TEMPLATE_FILES, "index.html": html })).toEqual([]);
  });

  it("detecta CSS con llaves descompensadas", () => {
    const [css] = failing({ ...TEMPLATE_FILES, "styles.css": "body { color: red;" });
    expect(css.criterion).toContain("CSS");
  });

  it("detecta errores de sintaxis en JavaScript sin ejecutarlo", () => {
    const [js] = failing({ ...TEMPLATE_FILES, "script.js": "function ( {" });
    expect(js.criterion).toContain("JavaScript");
  });
});
