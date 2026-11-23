import type { SiteFiles } from "./types";

/**
 * Web de partida que se copia a cada ejecución. HTML/CSS/JS sin build,
 * para que los agentes la puedan leer y modificar como texto.
 */
export const TEMPLATE_FILES: SiteFiles = {
  "index.html": `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Panadería La Espiga</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="cabecera">
    <a class="logo" href="index.html">La Espiga</a>
    <nav>
      <ul class="menu">
        <li><a href="index.html">Inicio</a></li>
        <li><a href="nosotros.html">Nosotros</a></li>
      </ul>
    </nav>
  </header>

  <main>
    <section class="hero">
      <h1>Pan de masa madre, hecho cada mañana</h1>
      <p>Horneamos en el barrio desde 1987 con harinas ecológicas y mucha paciencia.</p>
    </section>

    <section class="productos">
      <h2>Nuestros productos</h2>
      <div class="tarjetas">
        <article class="tarjeta">
          <h3>Hogaza de centeno</h3>
          <p>Fermentación de 24 horas, corteza crujiente.</p>
        </article>
        <article class="tarjeta">
          <h3>Barra rústica</h3>
          <p>La de siempre, con harina de trigo de la zona.</p>
        </article>
        <article class="tarjeta">
          <h3>Bollería artesana</h3>
          <p>Cruasanes y napolitanas con mantequilla de verdad.</p>
        </article>
      </div>
    </section>
  </main>

  <footer class="pie">
    <p>Panadería La Espiga · Calle del Horno, 12 · Abierto de 7:00 a 14:00</p>
    <p>&copy; <span id="anio"></span> La Espiga</p>
  </footer>
  <script src="script.js"></script>
</body>
</html>
`,
  "nosotros.html": `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nosotros · Panadería La Espiga</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="cabecera">
    <a class="logo" href="index.html">La Espiga</a>
    <nav>
      <ul class="menu">
        <li><a href="index.html">Inicio</a></li>
        <li><a href="nosotros.html">Nosotros</a></li>
      </ul>
    </nav>
  </header>

  <main>
    <section class="contenido">
      <h1>Quiénes somos</h1>
      <p>La Espiga nació como un pequeño obrador familiar. Hoy seguimos amasando a mano y usando masa madre propia.</p>
      <p>Trabajamos con molinos cercanos y no usamos mejorantes ni conservantes.</p>
    </section>
  </main>

  <footer class="pie">
    <p>Panadería La Espiga · Calle del Horno, 12 · Abierto de 7:00 a 14:00</p>
    <p>&copy; <span id="anio"></span> La Espiga</p>
  </footer>
  <script src="script.js"></script>
</body>
</html>
`,
  "styles.css": `:root {
  --color-fondo: #fffaf3;
  --color-texto: #3b2a1a;
  --color-acento: #b5651d;
  --color-tarjeta: #ffffff;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: Georgia, "Times New Roman", serif;
  background: var(--color-fondo);
  color: var(--color-texto);
  line-height: 1.6;
}

.cabecera {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1.5rem;
  border-bottom: 2px solid var(--color-acento);
}

.logo {
  font-size: 1.5rem;
  font-weight: bold;
  color: var(--color-acento);
  text-decoration: none;
}

.menu {
  display: flex;
  gap: 1rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.menu a { color: var(--color-texto); }

main { max-width: 960px; margin: 0 auto; padding: 1.5rem; }

.hero { text-align: center; padding: 2rem 0; }

.tarjetas {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1rem;
}

.tarjeta {
  background: var(--color-tarjeta);
  border-radius: 8px;
  padding: 1rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.pie {
  text-align: center;
  padding: 1.5rem;
  font-size: 0.9rem;
  border-top: 1px solid #e5d5c0;
}
`,
  "script.js": `document.addEventListener("DOMContentLoaded", function () {
  var anio = document.getElementById("anio");
  if (anio) {
    anio.textContent = String(new Date().getFullYear());
  }
});
`,
};
