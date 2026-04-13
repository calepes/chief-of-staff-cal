## name: briefing-pais
description: "Genera briefings ejecutivos diarios de cualquier país o región con criterio periodístico, económico y de riesgo. Usar cuando el usuario pida: briefing de [país], resumen de noticias [país], qué pasó ayer en [país/región], actualidad [país], brief [país], o cualquier solicitud de análisis diario de un país o región específica."

# Briefing Diario País/Región

Genera un briefing ejecutivo del día anterior para toma de decisiones. El output es un archivo HTML autónomo con diseño newsletter moderno.

## Proceso

1. Identificar país/región solicitado y su zona horaria
1. Determinar fecha de "ayer" en esa zona horaria
1. Verificar el día de la semana correcto para la fecha determinada (no asumir — calcular)
1. Buscar noticias en fuentes locales confiables del país/región (5-8 búsquedas segmentadas)
1. Aplicar criterios de selección (impacto > ruido)
1. Estructurar según formato obligatorio
1. Verificar tipo de cambio oficial y paralelo (si aplica)
1. Generar archivo HTML con diseño newsletter v2 y guardar en la carpeta de output

### Estrategia de Búsqueda

- Usar queries en español, específicas y ancladas a la fecha: "Camisea ducto reparación avance 8 marzo 2026"
- Primera búsqueda amplia: "[país] noticias [fecha]"
- Búsquedas temáticas de seguimiento: economía, deportes, diplomacia, tipo de cambio
- Para Bolivia electoral: cruzar Bolivia Verifica (fact-checking) con Ipsos-CIESMORI/Unitel (encuestas primarias)

## Criterios de Selección

Priorizar por impacto real en decisiones ejecutivas:

- Incluir: gobierno, estabilidad política, economía, moneda, inflación, energía, minería, banca, empresas relevantes, seguridad, elecciones, justicia
- Excluir: notas repetitivas, declaraciones sin hechos, opinión no sustentada, marketing

Apuntar a 8-15 ítems. Si varias fuentes reportan lo mismo, integrar en un solo ítem. Si una categoría no tuvo hechos relevantes, indicarlo explícitamente.

### Foco por Ciudad

Cuando el usuario solicita el briefing con una ciudad específica (ej: "briefing Santa Cruz, Bolivia" o "briefing Lima, Perú"), dar prelación a noticias locales de esa ciudad por sobre las nacionales. Concretamente:

- Top 5: al menos 3 de los 5 ítems deben tener impacto directo en la ciudad solicitada.
- Secciones temáticas: priorizar hechos locales de la ciudad; complementar con noticias nacionales solo cuando tengan impacto directo en la ciudad o sean de relevancia mayor (ej: decreto presidencial, tipo de cambio).
- Búsquedas: incluir búsquedas específicas con el nombre de la ciudad además de las nacionales.
- Masthead: mostrar la ciudad solicitada en el subtítulo.

Si solo se indica el país sin ciudad, el briefing es nacional sin sesgo geográfico.

## Idioma y Caracteres Especiales

Regla crítica: Todo el contenido HTML debe escribirse con ortografía completa en español, incluyendo todos los acentos (á, é, í, ó, ú), diéresis (ü), eñes (ñ, Ñ), signos de apertura (¿, ¡) y cualquier carácter especial requerido. Nunca omitir tildes ni eñes en nombres propios (Ñuble, Biobío, Concepción, Portoviejo) ni en palabras comunes (información, también, año, línea, número, país, región, edición, más, día, está, según, será). El <meta charset="UTF-8"> debe estar presente en el <head> del HTML.

## Citación y Verificación

Obligatorio para cada ítem:

- Incluir link directo a la fuente entre paréntesis al final
- Si hay múltiples fuentes, listar las 2-3 más relevantes
- Indicar fecha y hora del reporte cuando sea relevante

Formato de citación en HTML:
<span class="source-link"><a href="URL">Medio</a> · <a href="URL">Medio2</a></span>

Si no se encuentra link verificable: Indicar "Fuente: [nombre medio], sin link disponible" y priorizar otras noticias con fuentes verificables.

## Reglas Específicas por Sección

### Empresariales

Solo incluir: resultados financieros, inversiones/adquisiciones/cierres relevantes, cambios de control, decisiones regulatorias, conflictos laborales con impacto económico. Excluir marketing y lanzamientos comerciales.

Si no hubo noticias empresariales relevantes, declararlo.

### Deportes

Criterios por país:

- Bolivia: Liga profesional (División Profesional), selección boliviana (eliminatorias, Copa América), deportistas bolivianos en competencias internacionales. Solo resultados, no previas.
- Perú: Liga 1, selección peruana, deportistas peruanos destacados internacionalmente. Solo resultados.
- Colombia: Liga BetPlay, selección colombiana, ciclismo (Tour, Giro, Vuelta), boxeo/MMA colombianos en carteleras principales. Solo resultados.
- General: No incluir ligas europeas salvo que un jugador del país tenga actuación destacada. No incluir rumores de fichajes.

## Fuentes

Priorizar fuentes locales confiables y fuentes primarias (banco central, reguladores, ministerios, empresas). Usar fuentes internacionales solo cuando aporten contexto directo.

### Fuentes por País

- Bolivia: Unitel, La Razón, El Deber, Página Siete, Erbol, ABI, ANF, Correo del Sur, Bolivia Verifica, El País de Tarija
- Perú: RPP, La República, El Comercio, Infobae Perú, Gestión, Exitosa, TVPerú, Trome/Panorama
- Colombia: El Tiempo, El Espectador, Semana, Portafolio, La FM, Blu Radio, RCN, Caracol
- Otros: Buscar los 5-8 medios principales del país + agencia estatal + medio económico especializado

-----

## Output: Archivo HTML — Template Card Stack Liquid Glass

Este es el único template válido. El briefing se entrega como archivo HTML autónomo con diseño Liquid Glass (Apple-like): fondo gradient con ambient orbs, superficies glass con backdrop-filter, y Top 5 como carousel horizontal swipeable. No generar texto plano ni markdown. Siempre generar HTML.

### Nombre del archivo
briefing-{pais}-{DDmesAAAA}.html

Ejemplo: briefing-bolivia-9feb2026.html

### Paleta de Colores por País

Cada país tiene su propio --accent. Las pills de categoría son universales. Los colores del Liquid Glass (card-bg, glass-border, shadows, inset-highlight) son fijos para todos los países.

|País     |--accent  |
|---------|---------|
|Bolivia  |`#991b1b`|
|Perú     |`#1a4a6b`|
|Colombia |`#c4841d`|
|Panamá   |`#1a4a6b`|
|Argentina|`#2a6496`|
|Chile    |`#b22234`|
|México   |`#1a5e3a`|

Ambient orbs por país: El primer orb usa el accent del país con opacidad 0.10. El segundo orb usa rgba(175,82,222,0.07) (púrpura) para todos.

Variables fijas (todos los países):

- --ink: #1d1d1f
- --muted: rgba(60,60,67,0.6)
- --tertiary: rgba(60,60,67,0.3)
- --card-bg: rgba(255,255,255,0.55)
- --card-bg-strong: rgba(255,255,255,0.72)
- --glass-border: rgba(255,255,255,0.45)
- --shadow: rgba(0,0,0,0.06)
- --inset-highlight: rgba(255,255,255,0.7)

### Pills de Categoría (universales)

|Categoría    |Color texto|Color fondo (rgba)     |Clase CSS |
|-------------|-----------|-----------------------|----------|
|Político     |`#1e40af`  |`rgba(30,64,175,0.08)` |`pill-pol`|
|Económico    |`#065f46`  |`rgba(6,95,70,0.08)`   |`pill-eco`|
|Empresarial  |`#7c2d12`  |`rgba(124,45,18,0.08)` |`pill-emp`|
|Social       |`#6b21a8`  |`rgba(107,33,168,0.08)`|`pill-soc`|
|Deportes     |`#0369a1`  |`rgba(3,105,161,0.08)` |`pill-dep`|
|Internacional|`#374151`  |`rgba(55,65,81,0.08)`  |`pill-int`|
|Financiero   |`#065f46`  |`rgba(6,95,70,0.08)`   |`pill-eco`|

### Tipografía (Google Fonts)

Siempre importar estas tres familias:
Sora:wght@300;400;500;600;700;800
Newsreader:ital,wght@0,400;0,500;0,600;1,400
IBM Plex Mono:wght@400;500;600

Uso:

- Newsreader: Nombre del país en masthead (h1)
- Sora: Body text, headlines de noticias, labels, section headers, footer
- IBM Plex Mono: Números del Top 5 (grandes, 36px), valores de tipo de cambio, deltas

### Estructura HTML

```
AMBIENT ORBS (fixed, z-index 0)
├── orb-1: radial-gradient con accent del país, top-right
└── orb-2: radial-gradient púrpura, bottom-left

WRAPPER (max-width 680px, z-index 1)

MASTHEAD (glass card centrado, card-bg-strong)
├── masthead-eyebrow: "Briefing Ejecutivo"
├── h1: Nombre del país (Newsreader, 600 weight)
├── masthead-date: "Día DD de mes de AAAA · Ciudad"
│   IMPORTANTE: Calcular el día de la semana correcto para la fecha del briefing.
│   No asumir ni hardcodear — verificar con el calendario real.
│   Días en español: Lunes, Martes, Miércoles, Jueves, Viernes, Sábado, Domingo.
└── masthead-tag: "Edición Diaria" (pill con accent bg)

SECTION HEADER: "Top 5 del Día"

CAROUSEL (horizontal scroll, scroll-snap)
├── swipe-card 01: número grande (36px, accent) + título (18px, bold) + body + why-box + source
├── swipe-card 02: número + título + body + why-box + source
├── swipe-card 03: número + título + body + why-box + source
├── swipe-card 04: número + título + body + why-box + source
└── swipe-card 05: número + título + body + why-box + source
DOTS (5 dots, el activo se expande a pill)
SWIPE HINT: "Desliza para ver más →"

DIVIDER: ── Noticias por Sección ──

NEWS ITEMS (glass cards individuales, una columna)
├── news-item: pill-pol + h3 + p + source-link
├── news-item: pill-eco + h3 + p + source-link
├── news-item: pill-emp + h3 + p + source-link
├── news-item: pill-soc + h3 + p + source-link
├── news-item: pill-dep + h3 + p + source-link
└── news-item: pill-int + h3 + p + source-link

DATA STRIP (3 glass cells en grid horizontal)
├── Dólar Oficial: valor + delta
├── Dólar Paralelo: valor + delta (rojo/verde)
└── Brecha: porcentaje + delta

QUÉ VIGILAR HOY (dark glass panel, backdrop-filter blur(24px))
├── → item prospectivo
├── → item prospectivo
└── → item prospectivo

FOOTER (centrado)
├── "Fuentes: [lista de medios separados por ·]"
└── "Briefing generado con Claude — Solo para uso informativo"
```

### Top 5: Swipe Cards con "Por qué importa"

Obligatorio en TODOS los 5 ítems del Top 5. Cada card del carousel tiene una sección why con contexto estratégico.

```html
<div class="swipe-card">
  <div>
    <div class="swipe-top">
      <div class="swipe-num">01</div>
      <div class="swipe-title">Título de la noticia</div>
    </div>
    <div class="swipe-body">Detalle de la noticia.</div>
  </div>
  <div>
    <div class="swipe-why">
      <strong>Por qué importa</strong>
      Texto explicativo de impacto estratégico.
    </div>
    <div class="swipe-source"><a href="URL">Medio</a> · <a href="URL">Medio2</a></div>
  </div>
</div>
```

### CSS Completo

```css
:root {
  --accent: [según país];
  --accent-soft: [según país, accent con opacidad 0.06];
  --ink: #1d1d1f;
  --muted: rgba(60,60,67,0.6);
  --tertiary: rgba(60,60,67,0.3);
  --card-bg: rgba(255,255,255,0.55);
  --card-bg-strong: rgba(255,255,255,0.72);
  --glass-border: rgba(255,255,255,0.45);
  --shadow: rgba(0,0,0,0.06);
  --inset-highlight: rgba(255,255,255,0.7);
  --pill-pol: #1e40af; --pill-pol-bg: rgba(30,64,175,0.08);
  --pill-eco: #065f46; --pill-eco-bg: rgba(6,95,70,0.08);
  --pill-emp: #7c2d12; --pill-emp-bg: rgba(124,45,18,0.08);
  --pill-soc: #6b21a8; --pill-soc-bg: rgba(107,33,168,0.08);
  --pill-dep: #0369a1; --pill-dep-bg: rgba(3,105,161,0.08);
  --pill-int: #374151; --pill-int-bg: rgba(55,65,81,0.08);
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: linear-gradient(160deg, #F0E8E8 0%, #E4D4D8 25%, #D4DEE7 55%, #E8EDF2 80%, #F2F2F7 100%);
  color: var(--ink);
  font-family: 'Sora', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  line-height: 1.6; -webkit-font-smoothing: antialiased;
  min-height: 100vh; max-width: 680px; margin: 0 auto; padding: 32px 20px;
  overflow-x: hidden;
}

/* Ambient orbs */
.orb { position: fixed; border-radius: 50%; pointer-events: none; z-index: 0; }
.orb-1 { top: -120px; right: -80px; width: 380px; height: 380px; background: radial-gradient(circle, rgba([accent-rgb],0.10) 0%, transparent 70%); }
.orb-2 { bottom: -80px; left: -60px; width: 300px; height: 300px; background: radial-gradient(circle, rgba(175,82,222,0.07) 0%, transparent 70%); }
.wrap { position: relative; z-index: 1; }

/* Glass surface (reusable) */
.glass {
  background: var(--card-bg);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border-radius: 16px;
  border: 0.5px solid var(--glass-border);
  box-shadow: 0 4px 16px var(--shadow), inset 0 0.5px 0 var(--inset-highlight);
}

/* Masthead */
.masthead { text-align: center; margin-bottom: 28px; padding: 32px 24px 26px; background: var(--card-bg-strong); }
.masthead-eyebrow { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 3px; color: var(--accent); margin-bottom: 6px; }
.masthead h1 { font-family: 'Newsreader', Georgia, serif; font-size: clamp(36px, 8vw, 52px); font-weight: 600; line-height: 1.1; letter-spacing: -0.5px; margin-bottom: 6px; }
.masthead-date { font-size: 13px; color: var(--muted); }
.masthead-tag { display: inline-block; background: var(--accent); color: white; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; padding: 4px 14px; border-radius: 100px; margin-top: 10px; }

/* Section header */
.section-header { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 2.5px; color: var(--accent); margin-bottom: 14px; padding-left: 4px; }

/* === SWIPE CAROUSEL === */
.carousel-container { position: relative; margin-bottom: 32px; }
.carousel-track {
  display: flex; gap: 16px; overflow-x: auto; scroll-snap-type: x mandatory;
  -webkit-overflow-scrolling: touch; scrollbar-width: none; padding: 4px 0 16px;
}
.carousel-track::-webkit-scrollbar { display: none; }

.swipe-card {
  flex: 0 0 calc(100% - 16px); scroll-snap-align: start;
  background: var(--card-bg-strong);
  backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%);
  border-radius: 20px; border: 0.5px solid var(--glass-border);
  box-shadow: 0 8px 32px rgba(0,0,0,0.08), inset 0 0.5px 0 var(--inset-highlight);
  padding: 28px 24px; min-height: 280px;
  display: flex; flex-direction: column; justify-content: space-between;
}
.swipe-top { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 16px; }
.swipe-num { font-family: 'IBM Plex Mono', monospace; font-size: 36px; font-weight: 700; color: var(--accent); line-height: 1; flex-shrink: 0; }
.swipe-title { font-size: 18px; font-weight: 700; line-height: 1.3; letter-spacing: -0.3px; }
.swipe-body { font-size: 15px; color: rgba(60,60,67,0.78); line-height: 1.6; margin-bottom: 14px; flex: 1; }
.swipe-why { background: var(--accent-soft); border-left: 3px solid var(--accent); padding: 10px 14px; border-radius: 0 10px 10px 0; font-size: 13px; line-height: 1.5; }
.swipe-why strong { font-weight: 700; color: var(--accent); font-size: 10px; text-transform: uppercase; letter-spacing: 1.5px; display: block; margin-bottom: 2px; }
.swipe-source { color: var(--muted); font-size: 11px; margin-top: 10px; }
.swipe-source a { color: var(--accent); text-decoration: none; }

/* Dots */
.dots { display: flex; justify-content: center; gap: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(60,60,67,0.15); transition: all 0.3s ease; }
.dot.active { background: var(--accent); width: 24px; border-radius: 4px; }

.swipe-hint { text-align: center; font-size: 11px; color: var(--tertiary); margin-top: 10px; }

/* Divider */
.divider { display: flex; align-items: center; gap: 12px; margin: 8px 0 20px; }
.divider::before, .divider::after { content: ''; flex: 1; height: 0.5px; background: var(--tertiary); }
.divider-text { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 2.5px; color: var(--muted); white-space: nowrap; }

/* News items */
.news-item { padding: 18px 20px; margin-bottom: 10px; }
.pill { display: inline-block; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; padding: 3px 10px; border-radius: 100px; margin-bottom: 8px; }
.pill-pol { background: var(--pill-pol-bg); color: var(--pill-pol); }
.pill-eco { background: var(--pill-eco-bg); color: var(--pill-eco); }
.pill-emp { background: var(--pill-emp-bg); color: var(--pill-emp); }
.pill-soc { background: var(--pill-soc-bg); color: var(--pill-soc); }
.pill-dep { background: var(--pill-dep-bg); color: var(--pill-dep); }
.pill-int { background: var(--pill-int-bg); color: var(--pill-int); }
.news-item h3 { font-size: 16px; font-weight: 600; line-height: 1.4; margin-bottom: 6px; }
.news-item p { font-size: 15px; color: rgba(60,60,67,0.78); line-height: 1.55; }
.source-link { color: var(--muted); font-size: 11px; margin-top: 8px; display: block; }
.source-link a { color: var(--accent); text-decoration: none; }

/* Data strip */
.data-strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 32px 0; }
.data-cell { padding: 20px 14px; text-align: center; }
.data-cell-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; color: var(--muted); margin-bottom: 6px; }
.data-cell-value { font-family: 'IBM Plex Mono', monospace; font-size: 22px; font-weight: 700; }
.data-cell-delta { font-family: 'IBM Plex Mono', monospace; font-size: 12px; font-weight: 500; margin-top: 4px; }
.green { color: #34C759; }
.red { color: #FF3B30; }

/* Qué vigilar */
.vigilar {
  background: rgba(29,29,31,0.82);
  backdrop-filter: blur(24px) saturate(180%); -webkit-backdrop-filter: blur(24px) saturate(180%);
  border-radius: 16px; padding: 24px; margin: 32px 0;
  border: 0.5px solid rgba(255,255,255,0.08);
  box-shadow: 0 4px 24px rgba(0,0,0,0.15), inset 0 0.5px 0 rgba(255,255,255,0.04);
  color: white;
}
.vigilar-header { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 2.5px; color: #93c5fd; margin-bottom: 14px; }
.vigilar-item { font-size: 15px; line-height: 1.6; margin-bottom: 10px; padding-left: 22px; position: relative; color: rgba(255,255,255,0.88); }
.vigilar-item::before { content: '\2192'; position: absolute; left: 0; color: #93c5fd; font-weight: 600; }
.vigilar-item:last-child { margin-bottom: 0; }

/* Footer */
.footer { text-align: center; padding-top: 24px; font-size: 12px; color: var(--muted); line-height: 2; }

/* Staggered reveal */
.reveal { opacity: 0; transform: translateY(14px); transition: all 0.5s cubic-bezier(0.25,0.1,0.25,1); }
.reveal.visible { opacity: 1; transform: translateY(0); }

@media (prefers-reduced-motion: reduce) {
  .reveal { opacity: 1; transform: none; }
}

/* Responsive */
@media (max-width: 500px) {
  body { padding: 20px 14px; }
  .data-strip { grid-template-columns: 1fr; }
}
```

### JavaScript Obligatorio (al final del body)

```html
<script>
  // Carousel dots
  const track = document.getElementById('carousel');
  const dots = document.querySelectorAll('.dot');
  track.addEventListener('scroll', () => {
    const idx = Math.round(track.scrollLeft / track.offsetWidth);
    dots.forEach((d,i) => d.classList.toggle('active', i===idx));
  });
  // Staggered reveal
  const obs = new IntersectionObserver(es => es.forEach(e => {
    if(e.isIntersecting){e.target.classList.add('visible');obs.unobserve(e.target);}
  }),{threshold:0.1});
  document.querySelectorAll('.reveal').forEach(el => obs.observe(el));
</script>
```

### Reglas de Diseño

1. Sin emojis. Nunca. El diseño es tipográfico y limpio.
1. Una sola columna. Max-width 680px. Optimizado para lectura rápida.
1. Liquid Glass. Todas las superficies usan backdrop-filter: blur(20px) saturate(180%) + borde 0.5px + inset highlight. Nunca usar bordes sólidos de 1px ni fondos blancos planos.
1. Fondo gradient + orbs. El body siempre tiene el gradient y al menos 2 ambient orbs fijos. Sin esto, el glass se ve plano.
1. Top 5 como carousel swipeable. Cards grandes (min-height 280px) con scroll horizontal snap. Números a 36px en IBM Plex Mono. Dots de progreso centrados debajo.
1. "Por qué importa" en todos los Top 5. Sin excepciones. Dentro de cada swipe-card.
1. Pills de categoría. Cada news-item lleva su pill de color antes del h3.
1. Data strip con glass cells. Tipo de cambio en 3 celdas glass con gap de 10px.
1. Vigilar como dark glass panel. Fondo oscuro translúcido con blur(24px), no negro sólido.
1. Links funcionales. Todos los source-link y swipe-source deben tener hrefs reales.
1. Archivo autónomo. Todo el CSS inline en `<style>`. Sin archivos externos excepto Google Fonts.
1. 800-1200 palabras de contenido (sin contar HTML/CSS/JS).
1. Staggered reveal. Todos los elementos usan clase .reveal con transition-delay incremental (0.04s step).
1. Responsive. Data strip colapsa a 1 columna en mobile (<500px).
1. border-radius: 16px para cards estándar, 20px para swipe-cards y masthead (elementos prominentes).

-----

## Flujo Post-Generación (obligatorio)

Una vez guardado el HTML del briefing, ejecutar siempre estos dos pasos en secuencia:

### Paso A — Publicar en GitHub Pages

Publicar el HTML en el repositorio de GitHub Pages.
La URL pública resultante será:
https://apps.lepesqueur.net/dailynews/{Pais}/{Pais}-{YYYYMMDD}.html

### Paso B — Notificar por Telegram

Enviar al chat ID 94137698 el siguiente mensaje:

```
*Briefing {Pais} — {DD} {mes} {YYYY}*

Ya está disponible el briefing ejecutivo de hoy.

Top titulares:
- [titular 1 del Top 5]
- [titular 2 del Top 5]
- [titular 3 del Top 5]

Ver briefing: https://apps.lepesqueur.net/dailynews/{Pais}/{Pais}-{YYYYMMDD}.html
```

Si el deploy falla, enviar igualmente el mensaje indicando el error.

### Flujo completo
[briefing-pais]          → genera HTML + guarda en workspace
[github-pages-deploy]    → push a DailyNews + push a calepes.github.io
[telegram-notifications] → envía link + top 3 titulares
