import type { FileChange, SiteFiles } from "../types";
import type {
  AgentProvider,
  DevelopOutput,
  PlannedTask,
  PlanOutput,
  ReviewOutput,
  SummaryOutput,
  TaskInput,
} from "./types";

/**
 * Proveedor determinista para desarrollar y probar sin gastar la suscripción de Claude.
 * Reconoce unas pocas peticiones típicas (contacto, precios, modo oscuro) y
 * para cualquier otra genera una tarea genérica. La primera tarea falla
 * siempre la primera revisión de Testing, para que se vea el bucle
 * fallo → corrección → aprobado.
 */

interface MockTask extends PlannedTask {
  build(files: SiteFiles, flawed: boolean): FileChange[];
  /** Criterio que se marca como fallido en el primer intento y por qué. */
  flaw?: { criterion: number; reason: string };
}

interface Recipe {
  tasks: MockTask[];
}

const htmlPages = (files: SiteFiles) => Object.keys(files).filter((p) => p.endsWith(".html")).sort();

function addMenuLink(html: string, href: string, label: string): string {
  if (html.includes(`href="${href}"`)) return html;
  return html.replace(/(<ul class="menu">[\s\S]*?)(\n\s*<\/ul>)/, `$1\n        <li><a href="${href}">${label}</a></li>$2`);
}

function insertBeforeMainEnd(html: string, snippet: string): string {
  return html.replace(/(\n\s*<\/main>)/, `\n${snippet}$1`);
}

function pageShell(files: SiteFiles, title: string, body: string): string {
  const base = files["index.html"] ?? "";
  const header = base.match(/<header[\s\S]*?<\/header>/)?.[0] ?? "";
  const footer = base.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? "";
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Panadería La Espiga</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  ${header}

  <main>
${body}
  </main>

  ${footer}
  <script src="script.js"></script>
</body>
</html>
`;
}

const contactRecipe: Recipe = {
  tasks: [
    {
      title: "Crear la página de contacto",
      description: "Crear contacto.html con la misma cabecera y pie que el resto de páginas y un formulario de contacto.",
      acceptance_criteria: [
        "Existe contacto.html con la misma cabecera y pie que index.html",
        "El formulario tiene los campos nombre, email y mensaje, todos obligatorios",
        "El campo de email es de tipo email para que el navegador valide el formato",
      ],
      flaw: {
        criterion: 2,
        reason: 'El campo de email es type="text" y ningún campo tiene el atributo required.',
      },
      build(files, flawed) {
        const req = flawed ? "" : " required";
        const emailType = flawed ? "text" : "email";
        const body = `    <section class="contenido">
      <h1>Contacto</h1>
      <p>¿Encargos para eventos o alguna duda? Escríbenos y te respondemos en el día.</p>
      <form class="formulario" action="#" method="post">
        <label for="nombre">Nombre</label>
        <input id="nombre" name="nombre" type="text"${req}>
        <label for="email">Email</label>
        <input id="email" name="email" type="${emailType}"${req}>
        <label for="mensaje">Mensaje</label>
        <textarea id="mensaje" name="mensaje" rows="5"${req}></textarea>
        <button type="submit">Enviar</button>
      </form>
    </section>`;
        return [{ path: "contacto.html", action: "create", content: pageShell(files, "Contacto", body) }];
      },
    },
    {
      title: "Enlazar la página de contacto desde el menú",
      description: "Añadir el enlace «Contacto» al menú de navegación de todas las páginas.",
      acceptance_criteria: ["El menú de todas las páginas HTML incluye un enlace a contacto.html"],
      build(files) {
        return htmlPages(files).map((path) => ({
          path,
          action: "update" as const,
          content: addMenuLink(files[path], "contacto.html", "Contacto"),
        }));
      },
    },
    {
      title: "Dar estilo al formulario de contacto",
      description: "Añadir estilos al formulario coherentes con la paleta de la web.",
      acceptance_criteria: [
        "styles.css incluye estilos para .formulario",
        "Los campos ocupan el ancho disponible y el botón usa el color de acento",
      ],
      build(files) {
        const css = files["styles.css"] ?? "";
        if (css.includes(".formulario")) return [];
        return [
          {
            path: "styles.css",
            action: "update",
            content: `${css}
.formulario { display: grid; gap: 0.5rem; max-width: 520px; }
.formulario input,
.formulario textarea { width: 100%; padding: 0.6rem; border: 1px solid #d8c4a8; border-radius: 6px; font: inherit; }
.formulario button { justify-self: start; padding: 0.6rem 1.4rem; border: 0; border-radius: 6px; background: var(--color-acento); color: #fff; font: inherit; cursor: pointer; }
`,
          },
        ];
      },
    },
  ],
};

const pricingRecipe: Recipe = {
  tasks: [
    {
      title: "Añadir la sección de precios a la portada",
      description: "Añadir en index.html una sección «Precios» con los productos principales y su precio.",
      acceptance_criteria: [
        "index.html tiene una sección con id=\"precios\" y un título «Precios»",
        "La sección lista al menos tres productos, cada uno con su precio en euros",
      ],
      flaw: { criterion: 1, reason: "Solo aparecen dos productos y uno de ellos no tiene precio." },
      build(files, flawed) {
        const items = flawed
          ? `          <li><span>Hogaza de centeno</span> <strong>4,50 €</strong></li>
          <li><span>Barra rústica</span></li>`
          : `          <li><span>Hogaza de centeno</span> <strong>4,50 €</strong></li>
          <li><span>Barra rústica</span> <strong>1,20 €</strong></li>
          <li><span>Cruasán de mantequilla</span> <strong>1,60 €</strong></li>`;
        const section = `    <section id="precios" class="precios">
      <h2>Precios</h2>
      <ul class="lista-precios">
${items}
      </ul>
    </section>`;
        const base = (files["index.html"] ?? "").replace(/\n\s*<section id="precios"[\s\S]*?<\/section>/, "");
        return [{ path: "index.html", action: "update", content: insertBeforeMainEnd(base, section) }];
      },
    },
    {
      title: "Dar estilo a la lista de precios",
      description: "Estilos para que cada producto y su precio se lean alineados.",
      acceptance_criteria: ["styles.css incluye estilos para .lista-precios con producto y precio alineados"],
      build(files) {
        const css = files["styles.css"] ?? "";
        if (css.includes(".lista-precios")) return [];
        return [
          {
            path: "styles.css",
            action: "update",
            content: `${css}
.lista-precios { list-style: none; padding: 0; max-width: 480px; }
.lista-precios li { display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px dashed #d8c4a8; }
.lista-precios strong { color: var(--color-acento); }
`,
          },
        ];
      },
    },
  ],
};

const darkModeRecipe: Recipe = {
  tasks: [
    {
      title: "Definir los colores del modo oscuro",
      description: "Añadir en styles.css una variante oscura de las variables de color, activada con la clase .oscuro en <body>.",
      acceptance_criteria: [
        "styles.css define body.oscuro con colores de fondo y texto oscuros",
        "Las tarjetas también cambian de color en modo oscuro",
      ],
      flaw: { criterion: 1, reason: "body.oscuro cambia el fondo, pero --color-tarjeta sigue siendo blanco." },
      build(files, flawed) {
        const css = (files["styles.css"] ?? "").replace(/\nbody\.oscuro \{[\s\S]*?\}\n/, "\n");
        const tarjeta = flawed ? "" : "\n  --color-tarjeta: #3a2f26;";
        return [
          {
            path: "styles.css",
            action: "update",
            content: `${css}
body.oscuro {
  --color-fondo: #1f1a16;
  --color-texto: #f3e9dc;${tarjeta}
}
`,
          },
        ];
      },
    },
    {
      title: "Añadir el botón para alternar el modo oscuro",
      description: "Botón en la cabecera de todas las páginas que activa o desactiva el modo oscuro y recuerda la elección.",
      acceptance_criteria: [
        "Todas las páginas tienen un botón con id=\"modo-oscuro\" en la cabecera",
        "script.js alterna la clase .oscuro en <body> y guarda la preferencia en localStorage",
      ],
      build(files) {
        const changes: FileChange[] = htmlPages(files)
          .filter((p) => !files[p].includes('id="modo-oscuro"'))
          .map((path) => ({
            path,
            action: "update" as const,
            content: files[path].replace(
              /(\n\s*<\/header>)/,
              `\n    <button id="modo-oscuro" class="boton-modo" type="button">Modo oscuro</button>$1`,
            ),
          }));
        const js = files["script.js"] ?? "";
        if (!js.includes("modo-oscuro")) {
          changes.push({
            path: "script.js",
            action: "update",
            content: `${js}
function leerModo() {
  try { return localStorage.getItem("modo"); } catch (e) { return null; }
}
function guardarModo(modo) {
  try { localStorage.setItem("modo", modo); } catch (e) { /* almacenamiento no disponible */ }
}
document.addEventListener("DOMContentLoaded", function () {
  var boton = document.getElementById("modo-oscuro");
  if (leerModo() === "oscuro") document.body.classList.add("oscuro");
  if (!boton) return;
  boton.addEventListener("click", function () {
    var activo = document.body.classList.toggle("oscuro");
    guardarModo(activo ? "oscuro" : "claro");
  });
});
`,
          });
        }
        return changes;
      },
    },
  ],
};

function genericRecipe(request: string): Recipe {
  const text = request.replace(/[<>&"]/g, "");
  return {
    tasks: [
      {
        title: "Añadir una sección nueva en la portada",
        description: `Añadir en index.html una sección que responda a la petición: «${text}».`,
        acceptance_criteria: [
          "index.html tiene una sección nueva con un título y un texto relacionados con la petición",
          "La sección mantiene el estilo del resto de la portada",
        ],
        flaw: { criterion: 0, reason: "La sección se ha añadido sin título <h2>." },
        build(files, flawed) {
          const base = (files["index.html"] ?? "").replace(/\n\s*<section class="novedad">[\s\S]*?<\/section>/, "");
          const title = flawed ? "" : "\n      <h2>Novedades</h2>";
          const section = `    <section class="novedad">${title}
      <p>${text}</p>
    </section>`;
          return [{ path: "index.html", action: "update", content: insertBeforeMainEnd(base, section) }];
        },
      },
    ],
  };
}

function normalize(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function recipeFor(request: string): Recipe {
  const r = normalize(request);
  if (r.includes("contact")) return contactRecipe;
  if (r.includes("precio") || r.includes("tarifa")) return pricingRecipe;
  if (r.includes("oscuro") || r.includes("dark")) return darkModeRecipe;
  return genericRecipe(request);
}

const isFirstTry = (task: TaskInput) => task.attempts === 0;

export class MockProvider implements AgentProvider {
  readonly name = "mock";

  constructor(private readonly delayMs = 0) {}

  private async wait() {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
  }

  async plan({ request }: Parameters<AgentProvider["plan"]>[0]): Promise<PlanOutput> {
    await this.wait();
    return {
      tasks: recipeFor(request).tasks.map(({ title, description, acceptance_criteria }) => ({
        title,
        description,
        acceptance_criteria,
      })),
    };
  }

  async develop({ request, task, files }: Parameters<AgentProvider["develop"]>[0]): Promise<DevelopOutput> {
    await this.wait();
    const recipeTask = recipeFor(request).tasks[task.position];
    if (!recipeTask) return { summary: "No he encontrado nada que cambiar para esta tarea.", changes: [] };
    const flawed = Boolean(recipeTask.flaw) && isFirstTry(task);
    const changes = recipeTask.build(files, flawed);
    const summary = isFirstTry(task)
      ? `He hecho «${task.title}»: ${changes.map((c) => c.path).join(", ") || "sin cambios"}.`
      : `He corregido lo que indicó Testing en «${task.title}».`;
    return { summary, changes };
  }

  async review({ request, task }: Parameters<AgentProvider["review"]>[0]): Promise<ReviewOutput> {
    await this.wait();
    const recipeTask = recipeFor(request).tasks[task.position];
    const flaw = recipeTask?.flaw && isFirstTry(task) ? recipeTask.flaw : null;
    const results = task.acceptance_criteria.map((criterion, i) =>
      flaw && flaw.criterion === i
        ? { criterion, ok: false, reason: flaw.reason }
        : { criterion, ok: true, reason: "Se cumple." },
    );
    return { passed: results.every((r) => r.ok), results };
  }

  async summarize({ tasks }: Parameters<AgentProvider["summarize"]>[0]): Promise<SummaryOutput> {
    await this.wait();
    const done = tasks.filter((t) => t.status === "done");
    const blocked = tasks.filter((t) => t.status === "blocked");
    let text = `Se han completado ${done.length} de ${tasks.length} tareas`;
    text += done.length ? `: ${done.map((t) => t.title).join("; ")}.` : ".";
    if (blocked.length) {
      text += ` No se pudo completar: ${blocked
        .map((t) => `«${t.title}» (último fallo: ${t.last_feedback ?? "sin detalle"})`)
        .join("; ")}.`;
    }
    return { summary: text };
  }
}
