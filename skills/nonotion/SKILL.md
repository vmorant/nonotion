---
name: nonotion
description: Trabajar con NoNotion (el workspace personal del usuario) a través del MCP "nonotion" - leer, buscar, crear y modificar páginas y adjuntos. Usar cuando el usuario mencione NoNotion, sus notas/páginas/apuntes, o pida guardar, apuntar, anotar o documentar algo.
---

# NoNotion — convenciones de uso

NoNotion es el workspace personal del usuario (tipo Notion, autoalojado). El MCP
`nonotion` da acceso completo: páginas en Markdown, búsqueda y adjuntos.

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

## Casos concretos

- **Reuniones**: página con `page_date` (YYYY-MM-DD) para que aparezca en el
  calendario. Estructura típica: 👥 Asistentes, 📋 Agenda, 📝 Notas, ✅ Acciones.
- **Sin destino claro**: `create_page` sin `parent_id` la deja en "📥 Inbox",
  que el usuario organiza después.
- **Adjuntos**: `read_page` lista los adjuntos con su `file_id`.
  `read_attachment` lee su contenido: extrae el texto de PDF, Word, Excel y
  PowerPoint, y muestra imágenes y archivos de texto/código. Si un PDF está
  escaneado o tiene diagramas/tablas que necesitas ver, usa
  `read_document_pages` con el rango de páginas (p. ej. "1-5").

## Prohibiciones

- No borres ni vacíes páginas salvo orden explícita; para borrar usa solo
  `trash_page` (papelera reversible). No hay herramienta de borrado definitivo
  y no debes buscarla.
- No reescribas (`update_page`) lo que se puede añadir (`append_to_page`) o
  retocar (`edit_page`).
- No dupliques: busca antes de crear.
