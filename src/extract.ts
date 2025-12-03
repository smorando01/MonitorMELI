import { Locator, Page } from "playwright";

export type ParsedRecord = {
  sku: string;
  itemId: string;
  estado_competencia: "Ganando" | "Perdiendo" | "Compartiendo primer lugar" | "SIN_ESTADO";
  estado_operativo: "Activa" | "Pausada" | "Inactiva" | "UNKNOWN";
  titulo: string;
};

function clean(s?: string | null) {
  return (s || "").replace(/\s+/g, " ").trim();
}

async function getFirstText(loc: Locator) {
  try {
    const txt = await loc.first().textContent({ timeout: 2000 });
    return clean(txt || "");
  } catch {
    return "";
  }
}

function pickItemId(hrefs: (string | null | undefined)[]) {
  for (const href of hrefs) {
    if (!href) continue;
    const m = href.match(/(?:\?|&)itemId=(MLU\d{6,})\b/i);
    if (m) return m[1];
  }
  return "";
}

function inferCompetencia(txt: string): ParsedRecord["estado_competencia"] {
  if (/ganando/i.test(txt)) return "Ganando";
  if (/perdiendo/i.test(txt)) return "Perdiendo";
  if (/compartiendo\s+primer\s+lugar/i.test(txt) || /compitiendo/i.test(txt)) return "Compartiendo primer lugar";
  return "SIN_ESTADO";
}

function inferOperativo(txt: string, ariaChecked?: string | null): ParsedRecord["estado_operativo"] {
  if (/activa/i.test(txt)) return "Activa";
  if (/pausada/i.test(txt)) return "Pausada";
  if (/inactiva/i.test(txt)) return "Inactiva";
  if (ariaChecked === "true") return "Activa";
  if (ariaChecked === "false") return "Pausada";
  return "UNKNOWN";
}

/**
 * Extrae datos directamente del DOM visible (sin guardar HTML en disco).
 * Estrategia: localizar el texto "SKU <n>", subir al contenedor de la fila
 * y leer título, itemId, estados y enlaces relativos a esa fila.
 */
export async function extractFromPage(page: Page, sku: string): Promise<ParsedRecord | null> {
  const skuLocator = page.locator(`:text-matches("\\bSKU\\s*${sku}\\b", "i")`).first();
  if (!(await skuLocator.isVisible().catch(() => false))) return null;

  // Subir al contenedor de la fila. No dependemos de clases exactas.
  const row = skuLocator.locator(
    'xpath=ancestor::*[@role="row" or @role="listitem" or contains(@class,"list-item") or contains(@class,"sc-list-item-row")][1]'
  );
  if (!(await row.isVisible().catch(() => false))) return null;

  const record: ParsedRecord = {
    sku,
    itemId: "",
    estado_competencia: "SIN_ESTADO",
    estado_operativo: "UNKNOWN",
    titulo: "",
  };

  // Título: el enlace visible más largo dentro de la fila.
  try {
    const linkTexts = (await row.locator('a:visible').allInnerTexts()).map(clean).filter(Boolean);
    linkTexts.sort((a, b) => b.length - a.length);
    record.titulo = linkTexts[0] || "";
  } catch {
    // noop
  }

  // itemId desde cualquier href con ?itemId=
  try {
    const hrefs = await row.locator("a[href]").allAttribute("href");
    record.itemId = pickItemId(hrefs);
  } catch {
    // noop
  }

  // Estado de competencia
  const competenciaTxt = await getFirstText(
    row.locator(':text-matches("(Ganando|Perdiendo|Compartiendo\\s+primer\\s+lugar|Compitiendo)", "i")')
  );
  record.estado_competencia = inferCompetencia(competenciaTxt);

  // Estado operativo: label visible o switch aria-checked
  const operativoTxt = await getFirstText(
    row.locator(':text-matches("(Activa|Pausada|Inactiva)", "i")')
  );
  let ariaChecked: string | null | undefined = null;
  try {
    const switchEl = row.locator('[role="switch"]').first();
    if ((await switchEl.count()) > 0) {
      ariaChecked = await switchEl.getAttribute("aria-checked");
    }
  } catch {
    // noop
  }
  record.estado_operativo = inferOperativo(operativoTxt, ariaChecked);

  // Validar que obtuvimos algo útil
  const hasData = record.titulo || record.itemId;
  return hasData ? record : null;
}
