# Equipo de agentes IA

Tres agentes de IA que trabajan juntos sobre una web pequeña:

1. **Orquestador**: recibe una petición («añade una página de contacto a esta web»), la divide en tareas con criterios de aceptación y se las reparte a los otros dos. Al final redacta un resumen.
2. **Develop**: hace cada tarea modificando los archivos de la web.
3. **Testing**: comprueba lo que ha hecho Develop y le devuelve lo que falla, hasta que todo pasa (o hasta 3 intentos).

En pantalla se ve en directo qué hace cada agente, en qué estado está cada tarea, el registro de eventos y la web resultante.

- **Demo:** <!-- TODO: URL de Vercel -->
- **Usuario de prueba:** <!-- TODO: email y contraseña de prueba -->

La web sobre la que trabajan es la de un negocio ficticio, la «Panadería La Espiga» (`index.html`, `nosotros.html`, `styles.css`, `script.js`). Cada ejecución parte de una copia propia, así que las ejecuciones no se pisan.

## Stack

- **Next.js 16** (App Router, TypeScript, Tailwind) desplegado en **Vercel Hobby**.
- **Supabase** (plan gratuito): Postgres, Auth (email + contraseña) y Realtime.
- **Google Gemini** (plan gratuito) con el SDK `@google/genai` y salida JSON estructurada (`responseMimeType: application/json` + `responseSchema`).
- **Vitest** para los tests de la lógica.

## Arquitectura

```mermaid
flowchart TD
    U[Usuario: nueva petición] --> P
    P["Orquestador<br/>(planning)<br/>divide en 1-5 tareas<br/>con criterios de aceptación"] --> D
    D["Develop<br/>(developing)<br/>siguiente tarea pendiente o con fallos<br/>+ feedback de Testing"] --> T
    T["Testing<br/>(testing)<br/>1. comprobaciones automáticas<br/>2. revisión de cada criterio con IA"]
    T -- "pasa" --> OK[Tarea hecha]
    T -- "falla (intentos < 3)" --> D
    T -- "falla 3 veces" --> B[Tarea bloqueada]
    OK --> Q{¿Quedan tareas?}
    B --> Q
    Q -- sí --> D
    Q -- no --> S["Orquestador<br/>(summarizing)<br/>resumen final"]
    S --> F["done · o failed si hay bloqueadas"]
```

### Un paso por petición (límite de Vercel)

En Vercel Hobby ninguna función puede durar más de 300 s (con Fluid Compute), y una ejecución completa encadena hasta ~30 llamadas al LLM. Por eso el motor es una **máquina de estados que avanza un solo paso por llamada** (`POST /api/runs/[id]/step`, `maxDuration = 300`): cada paso hace como mucho una llamada al LLM, guarda el resultado en la base de datos y devuelve el estado. La página de la ejecución llama a `step` en bucle mientras la ejecución no haya terminado.

- **Bloqueo:** antes de avanzar, el paso hace un `update` condicional sobre `runs.locked_until` (solo gana quien lo encuentra vacío o caducado). Si hay dos pestañas abiertas, la segunda recibe `busy` y espera; nunca se ejecutan dos pasos del mismo run a la vez.
- **Modelo saturado (503), tiempo agotado en el servidor (504) o modelo no disponible (404):** se prueba el siguiente modelo de la cadena de respaldo (ver «Modelo de cada agente»). El modelo que responde queda en el evento y se ve en el registro (en ámbar si ha sido un respaldo).
- **Límite de la API (429) o todos los modelos saturados:** el run no falla. Se registra el evento «límite de la API / modelo saturado, reintento en X s», el paso responde `retryAfter`, el bloqueo se alarga hasta esa hora y el navegador espera y reintenta.
- **Otros errores** (respuesta no válida, tiempo agotado…): se registran y se reintenta el paso; tras 3 errores seguidos el run se marca como `failed` con el motivo.
- **Directo:** la interfaz se suscribe con Supabase Realtime a `runs`, `tasks` y `events`. Antes de cada llamada al LLM se escribe un evento «trabajando en…», así la tarjeta del agente activo se ilumina mientras piensa. Si Realtime no conecta, la página consulta la base de datos cada 2 s.

### Cómo comprueba Testing

1. **Comprobaciones automáticas** sobre toda la web (no solo lo que ha tocado Develop): HTML no vacío y con las etiquetas principales bien cerradas, enlaces / hojas de estilo / scripts locales que existen y con rutas relativas, CSS con llaves equilibradas y JavaScript sin errores de sintaxis (se compila, no se ejecuta).
2. Si pasan, **revisión con IA de cada criterio de aceptación**, con un motivo por criterio. Si las automáticas fallan, no se gasta la llamada al LLM: el fallo vuelve directamente a Develop.

Lo que falla se guarda en `tasks.last_feedback` y es lo que recibe Develop en el siguiente intento.

### Proveedor de IA intercambiable

`LLM_PROVIDER=gemini|mock`:

- `gemini`: los agentes reales, cada uno con su modelo (ver abajo).
- `mock`: respuestas deterministas y plausibles sin clave de API, para desarrollar, probar y enseñar el flujo. Reconoce las peticiones de ejemplo (contacto, precios, modo oscuro) y la primera tarea falla siempre la primera revisión de Testing, para que se vea el bucle fallo → corrección → aprobado.

### Modelo de cada agente

La cuota gratuita de Gemini va por modelo, y los agentes no gastan igual: el Orquestador hace 2 llamadas por ejecución (planificar y resumir) y Develop y Testing hacen el resto (hasta ~30). Por eso cada agente tiene su modelo:

| Agente | Variable | Por defecto |
|---|---|---|
| Orquestador | `GEMINI_MODEL_ORCHESTRATOR` | `gemini-3.5-flash` (Flash: mejor para planificar, menos cuota) |
| Develop | `GEMINI_MODEL_DEVELOP` | `gemini-3.5-flash-lite` (Flash-Lite: más peticiones al día) |
| Testing | `GEMINI_MODEL_TESTING` | `gemini-3.5-flash-lite` |

Si falta la variable de un agente se usa `GEMINI_MODEL`, y si tampoco está, el valor por defecto. Estos valores se han comprobado con una clave nueva del plan gratuito (23/11/2026): `gemini-3.8-flash` y `gemini-3.7-flash` respondían 503 («high demand») de forma repetida, `gemini-3.6-flash` daba 503 o 504 tras esperar 90-220 s, y los 2.5 dan 404 («no longer available to new users»). `gemini-3.5-flash` y los Flash-Lite respondían con JSON estructurado (los Flash-Lite, con algún 503 inmediato). El 503 no lo provoca el JSON estructurado: el mismo modelo responde o no con y sin `responseSchema` según el momento.

**Cadena de respaldo.** En el plan gratuito los 503 son frecuentes y pasajeros, y afectan a cada modelo por separado. Si el modelo de un agente da 503, 504 o 404, el proveedor prueba en la misma llamada los de `GEMINI_FALLBACK_MODELS` (separados por comas; vacía = sin respaldo), primero los de su misma gama (Flash-Lite para Develop y Testing, Flash para el Orquestador) para no gastar la cuota de la otra. Por defecto: `gemini-3.5-flash-lite, gemini-3.1-flash-lite, gemini-3.5-flash, gemini-3.6-flash`. Cada modelo tiene como mucho 120 s (el SDK se lo pasa al servidor, que corta con 504) y la cadena entera, 240 s: con el plan gratuito saturado un modelo puede tardar más de 3 minutos en contestar 503, y sin ese tope no quedaría tiempo para el respaldo. Si todos fallan por saturación, el paso se reintenta a los 15 s sin contar como error; si ninguno existe (todo 404), es un error de configuración. El 429 no pasa al siguiente modelo: se espera lo que indique la API.

Para comprobar la clave y los modelos (configurados y de respaldo):

```bash
npx tsx scripts/check-gemini.ts   # lee la clave de .env.local o del entorno, sin imprimirla
```

El script lista los modelos «flash» de la cuenta y hace una llamada mínima con JSON estructurado a cada uno. Un 503 suele ser saturación del momento: conviene repetir antes de descartar un modelo. Las cuotas exactas de cada modelo se ven en AI Studio.

### Prueba de extremo a extremo sin Supabase

```bash
npx tsx scripts/run-local.ts                                   # «Añade una página de contacto con formulario»
npx tsx scripts/run-local.ts "Añade un modo oscuro" --out /tmp/web
```

Ejecuta el motor completo con el repositorio en memoria y el proveedor de `LLM_PROVIDER` (Gemini real por defecto; con `LLM_PROVIDER=mock` no gasta cuota). Imprime los eventos, el modelo que responde y el estado de las tareas hasta `done` o `failed`, cuenta las peticiones HTTP a la API y, con `--out`, guarda la web resultante y los eventos.

### Estructura

```
app/
  login/                     login con email y contraseña (sin registro público)
  page.tsx                   nueva petición + lista de ejecuciones
  runs/[id]/                 agentes, tablero de tareas, registro y vista previa
  api/runs/[id]/step         avanza un paso del motor
  api/runs/[id]/site/[...]   sirve la web generada para la vista previa
  actions.ts                 login, logout y crear ejecución
lib/
  engine/                    máquina de estados, aplicación de cambios y comprobaciones (lógica pura)
  llm/                       proveedores Gemini y mock
  supabase/                  clientes (usuario, navegador, servicio) y repositorio
  template.ts                web de partida
proxy.ts                     refresca la sesión y exige login
supabase/migrations/         esquema SQL
scripts/create-test-user.ts  crea el usuario de prueba
scripts/check-gemini.ts      comprueba la clave y los modelos de Gemini
scripts/run-local.ts         ejecución completa en local, sin Supabase
tests/                       Vitest
```

## Modelo de datos

| Tabla | Contenido |
|---|---|
| `runs` | Una ejecución: petición, estado (`planning → developing ⇄ testing → summarizing → done/failed`), resumen final, errores seguidos y `locked_until` para el bloqueo. |
| `tasks` | Tareas del Orquestador: título, descripción, criterios de aceptación (`jsonb`), estado (`pending`, `developing`, `testing`, `failed`, `done`, `blocked`), fallos de Testing y último feedback. |
| `run_files` | Archivos de la web de cada ejecución (`run_id` + `path`). |
| `events` | Registro de lo que hace cada agente (`orchestrator`, `develop`, `testing`, `system`), con un mensaje legible y el detalle en `payload`. |

Seguridad: RLS activado en las cuatro tablas; cada usuario solo puede **leer** sus ejecuciones. Todas las escrituras las hace el servidor con la service role key, que nunca llega al navegador. El esquema completo está en [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql).

La vista previa se sirve en `/api/runs/[id]/site/...` con el `content-type` correcto (así funcionan los enlaces entre páginas). Como su HTML y JavaScript los ha escrito un LLM, se sirve aislada: cabecera `Content-Security-Policy: sandbox` e iframe con `sandbox`, sin acceso a la sesión ni a la API de la aplicación. El id de la ejecución (UUID) hace de enlace secreto.

## Arranque en local

Requisitos: Node 22 y un proyecto de Supabase (el plan gratuito sirve).

```bash
npm install
cp .env.example .env.local      # y rellena los valores
npm run dev                     # http://localhost:3000
```

Para probar sin clave de Gemini, pon `LLM_PROVIDER=mock` en `.env.local`.

Antes del primer arranque hay que preparar Supabase (abajo) y crear un usuario:

```bash
npx tsx scripts/create-test-user.ts prueba@ejemplo.com 'una-contraseña-larga'
```

El script lee `NEXT_PUBLIC_SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` de `.env.local`. Si el usuario ya existe, le actualiza la contraseña.

### Variables de entorno

| Variable | Dónde se usa |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Navegador y servidor |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Clave pública (anon o publishable). Navegador y servidor |
| `SUPABASE_SERVICE_ROLE_KEY` | Solo servidor: escrituras del motor y vista previa |
| `GEMINI_API_KEY` | Solo servidor |
| `GEMINI_MODEL_ORCHESTRATOR`, `GEMINI_MODEL_DEVELOP`, `GEMINI_MODEL_TESTING` | Opcionales: modelo de cada agente (ver «Modelo de cada agente») |
| `GEMINI_MODEL` | Opcional: modelo común para el agente que no tenga su variable |
| `GEMINI_FALLBACK_MODELS` | Opcional: modelos de respaldo si el del agente está saturado o no disponible (ver «Modelo de cada agente») |
| `LLM_PROVIDER` | `gemini` (por defecto) o `mock` |
| `MAX_RUNS_PER_DAY` | Ejecuciones por usuario cada 24 h, por defecto 15 |
| `MAX_RUNS_PER_HOUR` | Ejecuciones de todos los usuarios juntos en la última hora, por defecto 4 |
| `MOCK_DELAY_MS` | Opcional, retardo simulado del modo mock (por defecto 1500 ms) |

## Despliegue

### Supabase

1. Crea un proyecto en [supabase.com](https://supabase.com) (plan gratuito).
2. **SQL Editor** → pega el contenido de `supabase/migrations/0001_init.sql` y ejecútalo. Crea las tablas, las políticas RLS y añade `runs`, `tasks` y `events` a la publicación de Realtime.
3. Comprueba en **Database → Publications → supabase_realtime** que las tres tablas están activadas.
4. **Authentication → Sign In / Providers**: desactiva «Allow new users to sign up» (no hay registro público; los usuarios se crean con el script).
5. Copia la URL del proyecto (botón **Connect** o **Project Settings → Data API**) y las claves de **Project Settings → API Keys**: la *publishable* (`sb_publishable_…`, o la `anon` de *Legacy API keys*) va en `NEXT_PUBLIC_SUPABASE_ANON_KEY`, y una *secret key* (`sb_secret_…`, o la `service_role` legacy) en `SUPABASE_SERVICE_ROLE_KEY`.

### Vercel

1. Importa el repositorio en [vercel.com](https://vercel.com) (plan Hobby). No hace falta configurar nada del build.
2. En **Settings → Environment Variables** añade las variables de la tabla anterior.
3. Despliega y crea el usuario de prueba con el script.

## Tests

```bash
npm test        # Vitest
npm run lint
npm run build
```

Los tests cubren la lógica pura con el proveedor mock y un repositorio en memoria (detrás de la misma interfaz que el de Supabase): transiciones de la máquina de estados, aplicación de cambios a los archivos, comprobaciones automáticas de Testing, el bucle fallo → reintento → bloqueo, los límites por usuario y global por hora, el modelo de cada agente, el 429, el 503 y el 504 de Gemini, la cadena de respaldo de modelos, el bloqueo entre pasos simultáneos (incluida la relectura del run tras bloquearlo), los pasos cortados a mitad y los errores repetidos.

## Límites conocidos

- **Cuota gratuita de Gemini:** pocas peticiones por minuto y por día. Una ejecución hace entre ~5 y ~32 llamadas. Para protegerla: máximo 5 tareas por ejecución, 3 intentos por tarea, `MAX_RUNS_PER_DAY` ejecuciones por usuario cada 24 h y `MAX_RUNS_PER_HOUR` ejecuciones en la última hora entre todos los usuarios (la cuota es de la clave, no de cada usuario). Al llegar al límite por hora, el formulario dice a qué hora (de Madrid) queda libre el siguiente hueco. Si se agota la cuota diaria, la ejecución queda esperando y reintentando mientras la página esté abierta.
- **El motor avanza mientras la página está abierta.** Si se cierra, la ejecución se queda en su estado y continúa al volver a abrirla. Para que avanzara sola haría falta una cola o un cron (fuera del plan gratuito y del alcance de la prueba).
- **Develop devuelve archivos completos**, no diffs. Es lo más fiable con webs pequeñas como esta; con archivos grandes habría que pasar a parches.
- **Las comprobaciones automáticas son heurísticas** (sin navegador real): detectan HTML roto, enlaces rotos y errores de sintaxis, pero no errores en tiempo de ejecución ni problemas visuales. Esa parte la cubre la revisión con IA, que puede equivocarse.
- **Cada paso tiene hasta 300 s.** La llamada al LLM se corta a los 240 s y cuenta como error reintentable; el bloqueo del run caduca a los 320 s por si un paso se queda colgado.
- Los formularios de la web de demo no envían nada: la vista previa responde con un aviso.

## Cómo se ha programado con Claude Code

<!-- TODO: lo completa Alejandro -->
