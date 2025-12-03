import fs from "node:fs";

export type ParsedRecord = {
  sku: string;
  itemId: string;
  estado_competencia: "Ganando" | "Perdiendo" | "Compartiendo primer lugar" | "SIN_ESTADO";
  estado_operativo: "Activa" | "Pausada" | "Inactiva" | "UNKNOWN";
  titulo: string;
  url_item: string;
};

function clean(s?: string | null) {
  return (s || "").replace(/\s+/g, " ").trim();
}

/** Recorta el HTML de la fila que contiene el SKU indicado. */
function sliceRowForSku(html: string, sku: string): string | null {
  const rows =
    html.match(/<div class="sc-list-item-row sc-list-item-row--catalog[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g) || [];
  const needle = new RegExp(`\\bSKU\\s*${sku}\\b`, "i");
  const row = rows.find((r) => needle.test(r));
  return row || null;
}

/**
 * Extrae valores únicamente del HTML plano (archivo out/page-<sku>.html)
 */
export function parseHtmlForSku(html: string, fallbackSku: string): ParsedRecord {
  // Intentar limitar el análisis a la fila del SKU
  const row = sliceRowForSku(html, fallbackSku) || html;
  const hay = (pat: RegExp) => pat.test(row);

  const out: ParsedRecord = {
    sku: fallbackSku,
    itemId: "",
    estado_competencia: "SIN_ESTADO",
    estado_operativo: "UNKNOWN",
    titulo: "",
    url_item: "",
  };

  // --- ITEM_ID (enlace con ?itemId=MLU######## o JSON embebido)
  let mItem = row.match(/(?:\?|&)itemId=(MLU\d{6,})/i);
  if (!mItem) mItem = html.match(/"itemId"\s*:\s*"(MLU\d+)"/i) || html.match(/"item_id"\s*:\s*"(MLU\d+)"/i);
  if (mItem) out.itemId = mItem[1];

  // --- TITULO + URL
  const mTitle =
    row.match(/<a[^>]*class="sc-list-item-row-description__title"[^>]*>([^<]+)<\/a>/i) ||
    row.match(/<a[^>]*class="[^"]*sc-list-item-row-description__title[^"]*"[^>]*>([^<]+)<\/a>/i);
  if (mTitle) out.titulo = clean(mTitle[1]);

  const mHref =
    row.match(/<a[^>]*class="sc-list-item-row-description__title"[^>]*href="([^"]+)"/i) ||
    row.match(/<a[^>]*class="[^"]*sc-list-item-row-description__title[^"]*"[^>]*href="([^"]+)"/i);
  if (mHref) out.url_item = mHref[1];

  // --- ESTADO_OPERATIVO (label Activa/Pausada/Inactiva en la misma fila)
  if (hay(/sc-list-item-status-switch__label[^>]*>\s*Activa\s*</i)) out.estado_operativo = "Activa";
  else if (hay(/sc-list-item-status-switch__label[^>]*>\s*Inactiva\s*</i)) out.estado_operativo = "Inactiva";
  else if (hay(/sc-list-item-status-switch__label[^>]*>\s*Pausada\s*</i)) out.estado_operativo = "Pausada";
  else out.estado_operativo = "UNKNOWN";

  // --- ESTADO_COMPETENCIA (Ganando/Perdiendo/Compartiendo)
  if (hay(/>\s*Ganando\s*<\//i) || hay(/>\s*GANANDO\s*<\//)) {
    out.estado_competencia = "Ganando";
  } else if (hay(/>\s*Perdiendo\s*<\//i) || hay(/>\s*PERDIENDO\s*<\//)) {
    out.estado_competencia = "Perdiendo";
  } else if (
    hay(/>\s*Compartiendo\s+primer\s+lugar\s*<\//i) ||
    hay(/>\s*COMPITIENDO\s*<\//) // en tus fuentes equivale a “Compartiendo primer lugar”
  ) {
    out.estado_competencia = "Compartiendo primer lugar";
  } else {
    out.estado_competencia = "SIN_ESTADO";
  }

  // --- SKU validado desde el HTML (opcional)
  const mSku = row.match(/\bSKU\s+(\d{1,})\b/i);
  if (mSku) out.sku = mSku[1];

  return out;
}

/** Lee el archivo out/page-<sku>.html y devuelve el registro parseado. */
export function parseFromFile(sku: string): ParsedRecord | null {
  const path = `out/page-${sku}.html`;
  if (!fs.existsSync(path)) return null;
  const html = fs.readFileSync(path, "utf8");
  return parseHtmlForSku(html, sku);
}
