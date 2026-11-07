---
name: nonotion
description: Trabajar con NoNotion (el workspace personal del usuario) a través del MCP "nonotion" - leer, buscar, crear y modificar páginas y adjuntos. Usar cuando el usuario mencione NoNotion, sus notas/páginas/apuntes, o pida guardar, apuntar, anotar o documentar algo.
---

# NoNotion — convenciones de uso

NoNotion es el workspace personal del usuario (tipo Notion, autoalojado). El MCP
`nonotion` da acceso completo: páginas en Markdown, búsqueda y adjuntos.

NoNotion se organiza en **espacios** (un proyecto o cliente cada uno) y cada
conector ve **solo un espacio** (`list_pages` lo indica en la primera línea).
Si el usuario tiene varios conectores (uno por proyecto), usa el del proyecto
del que se habla y no mezcles información entre espacios.

## Regla nº 1: escribir solo cuando el usuario lo pida

NUNCA escribas en NoNotion por iniciativa propia. El usuario indica el momento
("apúntalo", "guárdalo", "añade eso a la página", "documenta esto"). Mientras
tanto, conversa con normalidad. Leer (`read_page`, `search_pages`, `list_pages`,
`read_attachment`) sí puedes hacerlo libremente cuando ayude a responder.

## Regla nº 2: la página de trabajo es un documento vivo

Una conversación suele trabajar sobre UNA página, no una página por respuesta:

1. La primera vez que el usuario pida guardar algo, fija la página de trabajo:
   - Si menciona una página concreta, búscala (`search_pages`) y usa su id.
   - Si no, pregunta si quiere una página nueva o usar una existente.
2. Recuerda ese `page_id` y úsalo el resto de la conversación.
3. Para añadir contenido: `append_to_page` (conserva lo existente).
4. Para corregir un fragmento: `edit_page` (find_text exacto y único — si dudas,
   relee antes con `read_page`).
5. Para reestructurar el documento entero: `update_page` (hay historial de
   versiones, no se pierde nada).

`create_page` solo cuando el usuario pida explícitamente una página nueva.
Antes de crear, busca por si ya existe una página del tema y ofrécela.

## Formato del contenido

- Markdown estándar: encabezados, listas, tablas, `- [ ]` para tareas y bloques
  de código con lenguaje (```python). El editor de NoNotion lo renderiza como
  bloques nativos.
- Escribe contenido limpio y final, sin meta-comentarios ("aquí tienes...").
- Código relevante que el usuario querrá ejecutar o descargar: además del bloque
  en el markdown, adjúntalo como archivo con `attach_file` (p. ej. `script.sh`).
- Binarios (Excel, Word, PDF, imágenes) con `attach_file` van en base64 y
  **completos**. Si la herramienta responde que el archivo llegó incompleto, no
  se ha guardado: vuelve a generarlo, o si es grande pon los datos en la página
  como tabla Markdown (el usuario puede copiarla a Excel con un clic).

## Casos concretos

- **Reuniones**: página con `page_date` (YYYY-MM-DD) para que aparezca en el
  calendario. Estructura típica: 👥 Asistentes, 📋 Agenda, 📝 Notas, ✅ Acciones.
- **Dónde crear**: antes de `create_page`, mira `list_pages` (o `search_pages`)
  y elige el padre temático adecuado. Usa "📥 Inbox" (sin `parent_id`) solo si
  no encaja en ninguna sección.
- **Reorganizar**: `move_page` mueve una página con sus subpáginas bajo otro
  padre (`new_parent_id`, o `null` para la raíz), opcionalmente en una posición
  (`position`, `before_id`, `after_id`). Para varias, `move_pages` en una sola
  llamada: es atómico, si una falla no se mueve ninguna. Mover no cambia
  contenido, etiquetas ni ids. Como cualquier escritura, solo cuando el
  usuario lo pida (o lo apruebe tras proponérselo).
- **Etiquetas**: no distinguen mayúsculas y se guardan en minúsculas.
- **Canvas** (lienzo visual, formato JSON Canvas como Obsidian): `list_pages`
  marca los canvas; `read_page` devuelve su resumen y su JSON. Para mapas
  mentales, diagramas o tableros que pida el usuario, `create_canvas` con
  tarjetas `text` (Markdown), `file` (`/p/<id>` para enlazar una página),
  `link` y `group`, y conexiones entre ellas. Para cambiar uno, lee su JSON y
  envíalo entero con `update_canvas` (conserva lo que no cambies). No uses
  append/edit/update_page en un canvas. Coloca las tarjetas sin solaparse.
- **Enlazar páginas** con `[Título](/p/<id>)` hace que aparezcan conectadas en
  el grafo de NoNotion.
- **Seguimiento** (elementos fuera del árbol; vista Seguimiento): bloqueos,
  problemas, riesgos, tareas, decisiones y preguntas con clave por espacio
  (`AXA-12`), estado (open → in_progress → blocked → resolved → closed),
  prioridad, responsable (usuario de GitHub o nombre libre), fecha límite e
  hito, y una descripción en Markdown normal.
  - Consultar libremente: "¿qué está bloqueado en AXA?" → `list_issues`
    (`blocked_only`), "¿qué tengo abierto?" → `list_issues` (`status: active`,
    `assignee`). Para el detalle, `read_page` del elemento (campos,
    descripción, relaciones y cronología).
  - Crear solo cuando el usuario lo pida ("apúntalo como bloqueo", "crea los
    elementos de esta reunión"): antes `list_issues` para no duplicar. Título
    corto y concreto; tipo y prioridad realistas; relaciónalo al crear
    (`links`): `origin` con el acta o página de la que sale, `documents` con
    la página de AXA que lo documenta, `blocks` si frena a otro elemento. De
    una idea, `create_issue` con `from_idea_id`.
  - Avances: `update_issue` con `comment` (queda en la cronología con fecha y
    autor) y el cambio de estado cuando el usuario lo confirme. No cierres ni
    cambies responsables por tu cuenta.
  - En cualquier página, escribir la clave (`AXA-12`) la enlaza al elemento.
    No uses `move_page` con elementos (no están en el árbol).
- **Ideas** (desarrollo de ideas, fuera del árbol; vista Ideas): una idea
  separa **semilla** (lo que llegó: texto, captura, enlace, fragmento de una
  página; no se reescribe), **desarrollo** (pasos fechados) y **resultado**
  (dónde se materializó). Estados: seed → developing → documented → archived.
  - Guardar: `create_idea` cuando el usuario diga "guárdalo como idea" (texto,
    lista de temas, enlace o `source_page_id`). Una captura: crea la idea y
    adjúntala con `attach_file`; aparecerá como semilla.
  - Desarrollar ("desarrolla la idea X"): `list_ideas` → `read_page` de la idea
    (mira sus capturas con `read_attachment`). Haz preguntas concretas y
    conversa; NO escribas hasta que el usuario lo pida. Cuando lo pida, deja
    constancia con `develop_idea`: pasos cortos y de un solo tipo cada uno
    (`question` lo que falta por saber, `answer` lo que el usuario responde,
    `hypothesis`, `decision` lo acordado, `discarded` lo descartado y por qué,
    `outline` el esquema del documento). Actualiza `summary` con el enunciado
    de la idea en una o dos frases cuando se aclare.
  - Materializar ("documéntala"): propón primero la forma: una página de
    documentación (`create_page` bajo el padre temático, no en Inbox), un
    diagrama o mapa (`create_canvas`), un planning (`create_page` con tabla de
    hitos/tareas y `page_date`), un archivo (`attach_file`) o un documento
    externo. Enlaza desde lo creado a la idea con `[💡 Título](/p/<idea_id>)`.
    Después registra todo con `materialize_idea` (varios resultados a la vez
    si procede): la idea pasa a documented y queda conectada en el grafo.
  - Nunca uses `append_to_page`/`edit_page`/`update_page` ni `move_page` con
    una idea (el servidor lo rechaza).
- **Adjuntos**: `read_page` lista los adjuntos con su `file_id`.
  `read_attachment` lee su contenido: extrae el texto de PDF, Word y
  PowerPoint, devuelve las hojas de Excel completas en CSV, y muestra imágenes y archivos de texto/código. Si un PDF está
  escaneado o tiene diagramas/tablas que necesitas ver, usa
  `read_document_pages` con el rango de páginas (p. ej. "1-5").

- **Tablas con cálculos**: si una tabla necesita totales o cálculos, puedes
  añadir debajo fórmulas al estilo Obsidian Advanced Tables, una por línea:
  `<!-- TBLFM: @>$2=sum(@I..@-1) -->` (`@` fila, `$` columna, `@I` primera fila
  de datos, `@>` última; `sum`, `mean`, `if`, `(a+b)`; `;%.2f` decimales). El
  usuario las recalcula con ↻ Calcular; escribe tú también el resultado en la
  celda para que la tabla sea correcta desde el principio.
- **Enlaces entre páginas**: para referirte a otra página de NoNotion escribe
  un enlace Markdown a su ruta: `[🤖 Título](/p/<id>)`. En la app se abre
  dentro de NoNotion y la página enlazada muestra "Enlazada desde".
- **Etiquetas**: `read_page`, `list_pages` y `search_pages` muestran las
  etiquetas (`#nombre`). `search_pages` acepta `tags` para filtrar. Para
  clasificar usa `tag_page` (añadir/quitar) **solo cuando el usuario lo pida**;
  antes consulta `list_tags` y reutiliza las existentes en vez de crear
  variantes (mayúsculas, plurales, sinónimos). Puedes *proponer* etiquetas en
  tu respuesta sin aplicarlas.

## Prohibiciones

- No borres ni vacíes páginas salvo orden explícita; para borrar usa solo
  `trash_page` (papelera reversible). No hay herramienta de borrado definitivo
  y no debes buscarla.
- No reescribas (`update_page`) lo que se puede añadir (`append_to_page`) o
  retocar (`edit_page`).
- No dupliques: busca antes de crear.
