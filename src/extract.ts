// src/extract.ts
import fs from "node:fs";

export type ParsedRecord = {
  sku: string;
  itemId: string;
  estado_competencia: "Ganando" | "Perdiendo" | "Compartiendo primer lugar" | "SIN_ESTADO";
  estado_operativo: "Activa" | "Pausada" | "Inactiva" | "UNKNOWN";
  titulo: string;
};

/** Recorta el HTML de la fila que contiene el SKU indicado. */
function sliceRowForSku(html: string, sku: string): string | null {
  const rows =
    html.match(/<div class="sc-list-item-row sc-list-item-row--catalog[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g) || [];
  const needle = new RegExp(`\\bSKU\\s*${sku}\\b`, "i");
  const row = rows.find((r) => needle.test(r));
  return row || null;
}

function clean(s?: string | null) {
  return (s || "").replace(/\s+/g, " ").trim();
}

/**
 * Parser robusto únicamente sobre HTML plano (sin ejecutar JS).
 * - itemId: de href ?itemId=MLU########
 * - estado_competencia: Ganando / Perdiendo / Compartiendo primer lugar (incluye fallback COMPITIENDO)
 * - estado_operativo: Activa / Pausada / Inactiva (label, clases del row o switch)
 * - titulo: texto del enlace con class sc-list-item-row-description__title (tolerante a etiquetas internas)
 * - sku: revalida si aparece "SKU <n>"
 */
export function parseHtmlForSku(html: string, fallbackSku: string): ParsedRecord | null {
  // Intentar limitar el análisis a la fila del SKU; si no aparece, devolvemos null para evitar falsos positivos.
  const row = sliceRowForSku(html, fallbackSku);
  if (!row) return null;

  const out: ParsedRecord = {
    sku: fallbackSku,
    itemId: "",
    estado_competencia: "SIN_ESTADO",
    estado_operativo: "UNKNOWN",
    titulo: "",
  };

  const hay = (pat: RegExp) => pat.test(row);

  // --- ITEM_ID (href ?itemId=MLU########)
  const mItem = row.match(/(?:\?|&)itemId=(MLU\d{6,})\b/i);
  if (mItem) out.itemId = mItem[1];

  // --- ESTADO_COMPETENCIA (tres textos + fallback “COMPITIENDO”)
  if (hay(/>\s*Ganando\s*<\//i)) out.estado_competencia = "Ganando";
  else if (hay(/>\s*Perdiendo\s*<\//i)) out.estado_competencia = "Perdiendo";
  else if (hay(/>\s*Compartiendo\s+primer\s+lugar\s*<\//i)) out.estado_competencia = "Compartiendo primer lugar";
  else if (hay(/>\s*COMPITIENDO\s*<\//)) out.estado_competencia = "Compartiendo primer lugar";

  // --- TITULO
  // Soporta variantes: el anchor puede tener tags internas (<span>...) antes del texto
  // Capturamos el innerHTML y luego quitamos tags para quedarnos con texto limpio.
  const mTitleBlock =
    row.match(/<a[^>]*class="[^"]*\bsc-list-item-row-description__title\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
    row.match(/class="sc-list-item-row-description__title"[^>]*>([\s\S]*?)<\/a>/i);
  if (mTitleBlock) {
    const inner = mTitleBlock[1] || "";
    const textOnly = inner.replace(/<[^>]+>/g, " "); // quita etiquetas internas
    out.titulo = clean(textOnly);
  }

  // --- SKU (si viene “SKU 1234” lo revalida)
  const mSku = row.match(/\bSKU\s+(\d{1,})\b/i);
  if (mSku) out.sku = mSku[1];

  // ======= ESTADO_OPERATIVO (mejorado) =======
  // 1) Label explícito visible
  if (hay(/sc-list-item-status-switch__label[^>]*>\s*Activa\s*</i)) out.estado_operativo = "Activa";
  else if (hay(/sc-list-item-status-switch__label[^>]*>\s*Pausada\s*</i)) out.estado_operativo = "Pausada";
  else if (hay(/sc-list-item-status-switch__label[^>]*>\s*Inactiva\s*</i)) out.estado_operativo = "Inactiva";
  else {
    // 2) Clases del row (ej: sc-list-item-row--active / --paused / --inactive)
    if (hay(/sc-list-item-row[^"]*--active/i)) out.estado_operativo = "Activa";
    else if (hay(/sc-list-item-row[^"]*--paused/i)) out.estado_operativo = "Pausada";
    else if (hay(/sc-list-item-row[^"]*--inactive/i)) out.estado_operativo = "Inactiva";
    else {
      // 3) Switch <input role="switch"> (checked/aria-checked)
      // Buscamos el bloque del switch para no recorrer todo el HTML con regex costosas
      const switchBlock =
        row.match(/<label[^>]*class="[^"]*sc-list-item-status-switch__switch[^"]*"[^>]*>[\s\S]*?<\/label>/i)?.[0] ||
        row.match(/<div[^>]*class="[^"]*sc-list-item-status-switch[^"]*"[^>]*>[\s\S]*?<\/div>/i)?.[0] ||
        "";

      if (switchBlock) {
        // checked o aria-checked="true" => Activa
        if (/role=["']switch["'][^>]*\bchecked\b/i.test(switchBlock)) {
          out.estado_operativo = "Activa";
        } else if (/role=["']switch["'][^>]*aria-checked=["']true["']/i.test(switchBlock)) {
          out.estado_operativo = "Activa";
        } else if (/role=["']switch["'][^>]*aria-checked=["']false["']/i.test(switchBlock)) {
          // Si está desmarcado y no detectamos “Inactiva” explícito por clases/label,
          // lo interpretamos como “Pausada” (comportamiento conservador).
          out.estado_operativo = "Pausada";
        }
      }
    }
  }

  // Si no se obtuvo ningún campo significativo, se considera fallo de parseo
  const hasData = Boolean(out.itemId || out.titulo || out.sku !== fallbackSku);
  return hasData ? out : null;
}

/**
 * Lee el archivo out/page-<sku>.html y devuelve el registro parseado.
 */
export function parseFromFile(sku: string): ParsedRecord | null {
  const path = `out/page-${sku}.html`;
  if (!fs.existsSync(path)) return null;
  const html = fs.readFileSync(path, "utf8");
  return parseHtmlForSku(html, sku);
}
