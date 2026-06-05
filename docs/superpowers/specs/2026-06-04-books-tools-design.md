# Books Tools para Jano — Design Spec
**Fecha:** 2026-06-04  
**Estado:** Aprobado para implementación

## Objetivo

Agregar capacidades a Jano para gestionar la BD de libros en Notion: agregar libros, actualizar propiedades, registrar progreso de lectura, y buscar/setear covers automáticamente desde internet.

## BD involucradas

| BD | ID | Propósito |
|----|-----|-----------|
| Libros (database page) | `b9222a76-e940-4e22-9091-b1c0e26c29dd` | Catálogo principal |
| Libros (data source) | `901dba51-1d00-4e3f-95b1-17ba628a0915` | Para queries y crear páginas |
| Books reading tracking | `908f96f0-f573-4945-8da8-172641151265` | Sesiones de lectura |
| Tracking DB page | `70b1e190-8547-4813-b918-43ce59071d3e` | Parent para crear tracking entries |

## Herramienta: ntn CLI

`ntn` (v0.14.0, `/opt/homebrew/bin/ntn`) es el Notion CLI oficial. Está instalado y autenticado vía macOS Keychain (integración "Notion CLI", workspace calepes).

**Auth en daemon:** el daemon es un servicio launchd user-level (`gui/$(id -u)`) y tiene acceso al Keychain de macOS — el mismo mecanismo que usa el Agent SDK para las credenciales OAuth de Claude. `ntn` encuentra su token en el Keychain automáticamente. No se requiere ninguna variable de entorno adicional.

El helper simplemente llama `spawnSync('/opt/homebrew/bin/ntn', ['api', ...args])` heredando el env del proceso.

## Cover search

Dos fuentes, sin API key:

1. **Open Library (preferido si hay ISBN):**  
   `https://covers.openlibrary.org/b/isbn/{ISBN}-L.jpg`  
   Verificar con HEAD request (302 = existe).

2. **Google Books API (fallback por título+autor):**  
   `https://www.googleapis.com/books/v1/volumes?q=intitle:{title}+inauthor:{author}&maxResults=3`  
   Extraer `items[0].volumeInfo.imageLinks.thumbnail`.

`setBookCover` setea **siempre ambos** — `cover` (banner) e `icon` (thumbnail) — con la misma URL. Notion acepta URLs externas directamente sin upload.

## % de progreso

El campo `% Inicial` y `% Final` en el tracking DB usa escala decimal:
- `0` = 0%
- `0.1` = 10%  
- `1.0` = 100%

Las fórmulas `Avance (pag)` calculan páginas automáticamente a partir de los porcentajes y `Total Páginas` del libro.

## 5 Tools

### 1. `searchBooks`
```typescript
searchBooks({ query?: string, estado?: EstadoLibro })
```
Busca libros en la BD por nombre (text search) o filtra por estado. Retorna array con `{ pageId, name, estado, rating, startDate, avanceTracking }`. Usa `ntn api v1/data_sources/{BOOKS_DS}/query`.

### 2. `addBook`
```typescript
addBook({
  name: string,
  subtitle?: string,
  isbn?: string,
  estado: EstadoLibro,       // Goal | Reading | Read | Focus | Stand-By | Reference | wish list
  planningToRead?: string,   // "2026" | "2025" | ...
  totalPaginas?: number,
  startDate?: string,        // ISO date
  finishDate?: string,
  url?: string,
  fetchCover?: boolean,      // default true
})
```
Crea página nueva en `BOOKS_DB`. Si `fetchCover=true` (default), busca cover automáticamente y lo setea en cover + icon. Retorna `{ pageId, url }`.

### 3. `updateBook`
```typescript
updateBook({
  pageId: string,
  estado?: EstadoLibro,
  rating?: Rating,           // 🥱 | 😶 | 😊 | 😍
  startDate?: string,
  finishDate?: string,
  totalPaginas?: number,
  isbn?: string,
  subtitle?: string,
  url?: string,
  planningToRead?: string,
})
```
PATCH a `v1/pages/{pageId}` con las propiedades provistas (solo las que vienen en el call). Al menos un campo requerido.

### 4. `logReadingProgress`
```typescript
logReadingProgress({
  pageId: string,            // ID del libro
  porcentajeInicial: number, // 0.0 – 1.0
  porcentajeFinal: number,
  fecha?: string,            // ISO date, default hoy
})
```
Crea entrada en `TRACKING_DB` con relación al libro, fecha y porcentajes. Las fórmulas calculan páginas automáticamente.

### 5. `setBookCover`
```typescript
setBookCover({
  pageId: string,
  title?: string,
  author?: string,
  isbn?: string,
})
```
Busca cover online (Open Library si hay ISBN, Google Books como fallback). Hace PATCH a `v1/pages/{pageId}` seteando **ambos** `cover` e `icon` con la misma URL externa. Si no encuentra cover, retorna error descriptivo sin modificar la página.

## Archivo de implementación

**Nuevo:** `daemon-v2/src/tools/books.ts`
- Helper `callNtn(args, body?)` — spawnSync con `NOTION_API_TOKEN` desde env
- Helper `searchCover(isbn?, title?, author?)` — fetch Open Library + fallback Google Books
- Implementación de las 5 tools

**Modificaciones:**
- `agent-tools.ts` — registrar las 5 tools en `buildSdkTools()`
- `agent-options.ts` — añadir `mcp__cos-tools__searchBooks` etc. a `CLAUDE_AI_COS_TOOLS`
- `system-prompt.ts` — sección `## Libros (Notion)` con triggers y ejemplos
- `agent.ts:TOOL_MESSAGES` — mensajes de progreso para cada tool

## System prompt triggers

```
"agrega el libro X"           → addBook
"estoy leyendo X"             → addBook(estado=Reading) + logReadingProgress
"terminé de leer X"           → updateBook(estado=Read, finishDate=hoy)
"voy por el 30% de X"         → logReadingProgress
"pon el cover de X"           → setBookCover
"actualiza el cover de todos" → searchBooks + setBookCover para cada uno sin cover
"califica X con 😍"            → updateBook(rating)
"qué estoy leyendo"           → searchBooks(estado=Reading)
```

## POC validado (2026-06-04)

Creación de "Leadership on the Line" verificó:
- `ntn api v1/pages POST` — crea libro con todas las propiedades, cover externo e ícono en una sola llamada ✅
- `ntn api v1/data_sources/{id}/query POST` — lee tracking entries y confirma formato decimal de % ✅  
- `ntn api v1/pages/{id} PATCH` — actualiza ícono post-creación ✅
- Cover Open Library: `covers.openlibrary.org/b/isbn/{ISBN}-L.jpg` ✅
- Tracking entry creada y relacionada al libro ✅
- Auth keychain funciona en sesión interactiva y en daemon launchd user-level (mismo mecanismo que OAuth Agent SDK) ✅
