// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: orange; icon-glyph: book;
/***********************
 * CONFIG
 ***********************/
const BOOKS_DB = "b9222a76e9404e229091b1c0e26c29dd";
const TRACKING_DB = "70b1e190-8547-4813-b918-43ce59071d3e";
const NOTION_VERSION = "2022-06-28";
// ponytail: 7 filas es el techo que entra sin recortarse en el widget Large
// (338x354pt). Si la meta 2026 crece más allá de 7 libros, se siguen
// mostrando los 7 más relevantes (orden: avance 7d desc) y el subtítulo
// avisa "7 de N libros" — subir el techo requeriría achicar ROW_H/ROW_GAP
// dinámicamente en vez de usar valores fijos.
const MAX_ROWS = 7;
const CACHE_FILE = "libros-2026.json";

/***********************
 * HELPERS
 ***********************/
function notionToken() {
  if (!Keychain.contains("NOTION_TOKEN")) {
    throw new Error("Falta token — correr 'Setup Libros 2026' una vez");
  }
  return Keychain.get("NOTION_TOKEN");
}

async function notionQuery(dbId, filter) {
  const req = new Request(`https://api.notion.com/v1/databases/${dbId}/query`);
  req.method = "POST";
  req.headers = {
    Authorization: `Bearer ${notionToken()}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
  req.body = JSON.stringify({ filter, page_size: 100 });
  req.timeoutInterval = 15;
  const res = await req.loadJSON();
  if (res.object === "error") throw new Error(res.message || "Error Notion");
  return res.results || [];
}

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function truncate(str, maxWidthPt, fontSizePt) {
  const avgCharW = fontSizePt * 0.52; // heurística: ancho promedio de glifo ≈ 52% del tamaño de fuente (System proporcional)
  const maxChars = Math.max(1, Math.floor(maxWidthPt / avgCharW));
  if (str.length <= maxChars) return str;
  return str.slice(0, Math.max(1, maxChars - 1)) + "…";
}

/***********************
 * FETCH + COMPUTE
 ***********************/
async function loadBooks() {
  const bookRows = await notionQuery(BOOKS_DB, {
    property: "Planning to read",
    select: { equals: "2026" },
  });

  const trackingRows = await notionQuery(TRACKING_DB, {
    property: "Fecha",
    date: { on_or_after: daysAgoISO(30) },
  });

  const cutoff7 = daysAgoISO(7);
  const pagesByBook = {};
  for (const row of trackingRows) {
    const p = row.properties;
    const bookId = p.Book?.relation?.[0]?.id;
    if (!bookId) continue;
    const fecha = p.Fecha?.date?.start;
    const pag = p["Avance (pag)"]?.formula?.number || 0;
    if (!pagesByBook[bookId]) pagesByBook[bookId] = { pag7: 0, pag30: 0 };
    pagesByBook[bookId].pag30 += pag;
    if (fecha && fecha >= cutoff7) pagesByBook[bookId].pag7 += pag;
  }

  const books = bookRows.map((row) => {
    const p = row.properties;
    const name = p.Name?.title?.[0]?.plain_text || "(sin título)";
    const estado = p.Estado?.status?.name || null;
    const avance = p["Avance Tracking"]?.rollup?.number;
    const pct = avance != null ? Math.round(avance * 100) : 0;
    const pages = pagesByBook[row.id] || { pag7: 0, pag30: 0 };
    return { name, estado, pct, pag7: pages.pag7, pag30: pages.pag30 };
  });

  books.sort(
    (a, b) => b.pag7 - a.pag7 || b.pag30 - a.pag30 || a.name.localeCompare(b.name)
  );

  return { books, total: books.length };
}

let data, cached = false, error = null;
const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), CACHE_FILE);

try {
  data = await loadBooks();
  fm.writeString(cachePath, JSON.stringify(data));
} catch (e) {
  if (fm.fileExists(cachePath)) {
    data = JSON.parse(fm.readString(cachePath));
    cached = true;
  } else {
    error = e.message || "No disponible";
  }
}

/***********************
 * ESCALA POR DISPOSITIVO — Large: iPhone 338pt, iPad mini 306pt de ancho
 * (ver skill scriptable-widgets §2, variante Large). SCALE=1 en iPhone.
 ***********************/
const CANVAS = Device.isPad() ? 306 : 338;
const SCALE = CANVAS / 338;
const pad = (n) => Math.round(n * SCALE);

/***********************
 * COLORES — se adaptan solos con Color.dynamic; único costo: dentro del
 * DrawContext de las filas quedan "horneados" al momento del refresh (ver
 * skill §3/§7) — igual límite aceptado que Inversiones Anual.js.
 ***********************/
const INK = Color.dynamic(new Color("#1c1c1e"), new Color("#f2f2f3"));
const INK_2 = Color.dynamic(new Color("#3c3c43", 0.6), new Color("#ebebf5", 0.6));
const INK_3 = Color.dynamic(new Color("#3c3c43", 0.35), new Color("#ebebf5", 0.52));
const TRACK_BG = Color.dynamic(new Color("#3c3c43", 0.12), new Color("#ebebf5", 0.3));
const GREEN = Color.dynamic(new Color("#2f8f4e"), new Color("#57c37b"));
const ORANGE = Color.dynamic(new Color("#c8721c"), new Color("#e8974a"));

/***********************
 * FILAS (título + % + barra + 7d/30d) — DrawContext: evita los gotchas de
 * alineación de WidgetStack documentados en el skill (§1, "plan C").
 ***********************/
function buildRowsImage(books, contentW) {
  const scale = 3;
  const rowH = pad(30);
  const rowGap = pad(6);
  const titleLineH = pad(16);
  const lineGap = pad(3);
  const deltaLineH = rowH - titleLineH - lineGap;
  const pctW = pad(40);
  const colGap = pad(6);
  const deltaW = pad(70);
  const colGap2 = pad(8);
  const titleColW = contentW - pctW - colGap;
  const trackW = contentW - deltaW - colGap2;
  const barH = pad(4);

  const totalH = books.length * rowH + Math.max(0, books.length - 1) * rowGap;

  const ctx = new DrawContext();
  ctx.size = new Size(contentW * scale, totalH * scale);
  ctx.opaque = false;
  ctx.respectScreenScale = false;

  books.forEach((b, i) => {
    const rowY = i * (rowH + rowGap);
    const color = b.estado === "Reading" ? GREEN : b.estado === "Focus" ? ORANGE : INK;
    const barColor = b.estado === "Reading" ? GREEN : b.estado === "Focus" ? ORANGE : INK_3;
    const active = b.pag7 > 0 || b.pag30 > 0;

    ctx.setFont(Font.semiboldSystemFont(pad(13) * scale));
    ctx.setTextColor(color);
    ctx.setTextAlignedLeft();
    ctx.drawTextInRect(
      truncate(b.name, titleColW, pad(13)),
      new Rect(0, rowY * scale, titleColW * scale, titleLineH * scale)
    );

    ctx.setFont(Font.boldSystemFont(pad(13) * scale));
    ctx.setTextColor(color);
    ctx.setTextAlignedRight();
    ctx.drawTextInRect(
      `${b.pct}%`,
      new Rect((contentW - pctW) * scale, rowY * scale, pctW * scale, titleLineH * scale)
    );

    const line2Y = rowY + titleLineH + lineGap;
    const barY = line2Y + (deltaLineH - barH) / 2;

    ctx.setFillColor(TRACK_BG);
    ctx.fillRect(new Rect(0, barY * scale, trackW * scale, barH * scale));

    const fillW = (trackW * Math.max(0, Math.min(100, b.pct))) / 100;
    if (fillW > 0.5) {
      ctx.setFillColor(barColor);
      ctx.fillRect(new Rect(0, barY * scale, fillW * scale, barH * scale));
    }

    ctx.setFont(Font.systemFont(pad(9.5) * scale));
    ctx.setTextColor(active ? INK_2 : INK_3);
    ctx.setTextAlignedRight();
    const deltaTxt = active ? `+${b.pag7} · +${b.pag30}` : "sin avance";
    ctx.drawTextInRect(
      deltaTxt,
      new Rect((contentW - deltaW) * scale, line2Y * scale, deltaW * scale, deltaLineH * scale)
    );
  });

  return { image: ctx.getImage(), height: totalH };
}

/***********************
 * WIDGET UI
 ***********************/
const widget = new ListWidget();
widget.setPadding(pad(16), pad(16), pad(16), pad(16));

if (data && data.books.length > 0) {
  const contentW = CANVAS - 2 * pad(16);
  const shown = data.books.slice(0, MAX_ROWS);

  // Título + subtítulo + filas van en UN SOLO bloque, centrado como unidad
  // con addSpacer() a los lados de `outer` (confiable: hijo DIRECTO de
  // `widget`, ver skill scriptable-widgets §1). `content` no declara ancho
  // fijo — queda del ancho de su hijo más ancho (la imagen de filas,
  // contentW) y TODO adentro se queda alineado a la izquierda entre sí. Así
  // título y filas comparten siempre el mismo margen izquierdo, sea cual sea
  // la holgura real entre CANVAS (aproximado, ver skill §2) y el ancho real
  // del iPad. En iPhone, donde CANVAS es el valor oficial y no hay holgura,
  // los spacers de `outer` quedan en 0 y el resultado es idéntico a antes.
  const outer = widget.addStack();
  outer.layoutHorizontally();
  outer.addSpacer();
  const content = outer.addStack();
  content.layoutVertically();
  outer.addSpacer();

  const title = content.addText("Libros");
  title.font = Font.boldSystemFont(pad(18));
  title.textColor = INK;

  content.addSpacer(pad(2));
  const subtitleText =
    data.total <= MAX_ROWS
      ? `meta 2026 · ${data.total} libro${data.total === 1 ? "" : "s"}`
      : `meta 2026 · ${MAX_ROWS} de ${data.total} libros`;
  const subtitle = content.addText(subtitleText);
  subtitle.font = Font.systemFont(pad(12));
  subtitle.textColor = INK_2;

  content.addSpacer(pad(14));

  const rows = buildRowsImage(shown, contentW);
  const rowsEl = content.addImage(rows.image);
  rowsEl.imageSize = new Size(contentW, rows.height);
  rowsEl.leftAlignImage();

  // Spacer flexible: confiable acá porque es hijo DIRECTO de `widget`
  // (ver skill scriptable-widgets §1) — empuja el footer al fondo sin
  // depender de calcular a mano el espacio sobrante.
  widget.addSpacer();

  const footerText = cached
    ? "última data disponible"
    : `actualizado ${new Date().toLocaleTimeString("es-BO", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })}`;
  const footer = widget.addText(footerText);
  footer.font = Font.systemFont(pad(10));
  footer.textColor = INK_3;
  footer.rightAlignText();
} else {
  const label = widget.addText(error || "Sin libros en la meta 2026");
  label.font = Font.systemFont(pad(14));
  label.textColor = Color.red();
  label.centerAlignText();
}

widget.refreshAfterDate = new Date(Date.now() + 60 * 60 * 1000);

/***********************
 * PRESENT
 ***********************/
if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentLarge();
}

Script.complete();
