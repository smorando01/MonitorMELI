import { Page } from "playwright";

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

function inferCompetencia(txt: string): ParsedRecord["estado_competencia"] {
  const lc = txt.toLowerCase();
  if (lc.includes("ganando")) return "Ganando";
  if (lc.includes("perdiendo")) return "Perdiendo";
  if (lc.includes("compartiendo primer lugar") || lc.includes("compitiendo")) return "Compartiendo primer lugar";
  return "SIN_ESTADO";
}

function inferOperativo(txt: string, ariaChecked?: string | null): ParsedRecord["estado_operativo"] {
  const lc = txt.toLowerCase();
  if (lc.includes("activa")) return "Activa";
  if (lc.includes("pausada")) return "Pausada";
  if (lc.includes("inactiva")) return "Inactiva";
  if (ariaChecked === "true") return "Activa";
  if (ariaChecked === "false") return "Pausada";
  return "UNKNOWN";
}

function pickItemIdFromHref(href?: string | null) {
  if (!href) return "";
  const m = href.match(/(?:\\?|&)itemId=(MLU\\d{6,})\\b/i);
  return m ? m[1] : "";
}

function pickTitle(candidates: string[]) {
  const filtered = candidates
    .map(clean)
    .filter(Boolean)
    .filter((t) => !/^(modificar|ir a promociones)/i.test(t)); // evita acciones
  filtered.sort((a, b) => b.length - a.length);
  return filtered[0] || "";
}

/**
 * Extrae datos directamente del DOM usando locators semánticos:
 * - filtra el contenedor por texto "SKU <n>"
 * - lee innerText para inferir estados
 * - busca link "Modificar" para itemId
 */
export async function extractFromPage(page: Page, sku: string): Promise<ParsedRecord | null> {
  const row = page
    .locator('[role="listitem"], [role="row"], article, div')
    .filter({ hasText: new RegExp(`\\bSKU\\s*${sku}\\b`, "i") })
    .first();

  if (!(await row.isVisible({ timeout: 4000 }).catch(() => false))) return null;

  const text = clean(await row.innerText());
  if (!text) return null;

  // Título: prioriza headings; si no, el link visible más largo (excluyendo acciones).
  let titulo = "";
  try {
    const heading = row.getByRole("heading").first();
    if (await heading.isVisible({ timeout: 1500 }).catch(() => false)) {
      titulo = clean(await heading.innerText());
    }
    if (!titulo) {
      const linkTexts = await row.getByRole("link").allInnerTexts();
      titulo = pickTitle(linkTexts);
    }
  } catch {
    // noop
  }

  // Item ID desde link "Modificar"
  let itemId = "";
  try {
    const modificar = row.getByRole("link", { name: /modificar/i }).first();
    if (await modificar.isVisible({ timeout: 1500 }).catch(() => false)) {
      const href = await modificar.getAttribute("href");
      itemId = pickItemIdFromHref(href);
    }
    if (!itemId) {
      // fallback: cualquier href dentro del contenedor
      const hrefs = await row.getByRole("link").allAttribute("href");
      for (const href of hrefs) {
        itemId = pickItemIdFromHref(href);
        if (itemId) break;
      }
    }
  } catch {
    // noop
  }

  // Estado operativo cerca del toggle
  let ariaChecked: string | null | undefined = null;
  try {
    const sw = row.getByRole("switch").first();
    if (await sw.isVisible({ timeout: 1500 }).catch(() => false)) {
      ariaChecked = await sw.getAttribute("aria-checked");
    }
  } catch {
    // noop
  }
  const estado_operativo = inferOperativo(text, ariaChecked);

  // Estado competencia desde badges/etiquetas
  const estado_competencia = inferCompetencia(text);

  const record: ParsedRecord = {
    sku,
    itemId,
    estado_competencia,
    estado_operativo,
    titulo,
  };

  // Consideramos válido si al menos título o itemId existen.
  return record.titulo || record.itemId ? record : null;
}
