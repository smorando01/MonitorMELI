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
  const m = href.match(/(?:\?|&)itemId=(MLU\d{6,})\b/i);
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
 * Estrategia de localización relativa:
 * 1) Espera el texto "SKU <n>".
 * 2) Desde ese texto, sube por ancestros hasta encontrar un contenedor que tenga un switch o el link "Modificar".
 * 3) Usa el innerText completo del contenedor para inferir estados y título; el itemId se extrae del href del link "Modificar".
 */
export async function extractFromPage(page: Page, sku: string): Promise<ParsedRecord | null> {
  const anchor = page.locator(`text=SKU ${sku}`).first();
  try {
    await anchor.waitFor({ state: "visible", timeout: 6000 });
  } catch {
    return null;
  }

  // Contenedor: ancestro que contenga switch o link "Modificar"
  const card = anchor.locator(
    'xpath=ancestor::*[descendant::*[@role="switch"] or descendant::a[contains(translate(normalize-space(.),"MODIFICAR","modificar"),"modificar")]][1]'
  );
  if (!(await card.isVisible({ timeout: 2000 }).catch(() => false))) return null;

  const text = clean(await card.innerText());
  if (!text) return null;

  // Título
  let titulo = "";
  try {
    const blacklist = [
      "experiencia de compra",
      "modificar",
      "promociones",
      "ver",
      "ganando",
      "perdiendo",
      "compartiendo primer lugar",
      "compitiendo",
      "activa",
      "pausada",
      "inactiva",
      "unidades vendidas",
      "flex",
      "unidades",
      "cuotas",
      "envío",
    ];

    // 1) Heading si existe
    const heading = card.getByRole("heading").first();
    if (await heading.isVisible({ timeout: 1200 }).catch(() => false)) {
      titulo = clean(await heading.innerText());
    }

    // 2) Línea más larga del innerText (excluyendo frases administrativas)
    if (!titulo) {
      const lines = text
        .split(/\r?\n/)
        .map(clean)
        .filter(Boolean)
        .filter((ln) => !blacklist.some((b) => ln.toLowerCase().includes(b)))
        .filter((ln) => ln.length > 5);
      lines.sort((a, b) => b.length - a.length);
      titulo = lines[0] || "";
    }

    // 3) Links filtrados (por orden en DOM) si aún no hay título
    if (!titulo) {
      const candidates = await card.locator("a").allInnerTexts();
      for (const txt of candidates) {
        const t = clean(txt);
        if (!t) continue;
        if (blacklist.some((b) => t.toLowerCase().includes(b))) continue;
        titulo = t;
        break;
      }
    }
  } catch {
    // noop
  }

  // Item ID desde link "Modificar" (o cualquier href)
  let itemId = "";
  try {
    const modificar = card.getByRole("link", { name: /modificar/i }).first();
    if (await modificar.isVisible({ timeout: 1500 }).catch(() => false)) {
      itemId = pickItemIdFromHref(await modificar.getAttribute("href"));
    }
    if (!itemId) {
      const hrefs = await card.getByRole("link").allAttribute("href");
      for (const href of hrefs) {
        itemId = pickItemIdFromHref(href);
        if (itemId) break;
      }
    }
  } catch {
    // noop
  }

  // Estado operativo
  let ariaChecked: string | null | undefined = null;
  try {
    const sw = card.getByRole("switch").first();
    if (await sw.isVisible({ timeout: 1500 }).catch(() => false)) {
      ariaChecked = await sw.getAttribute("aria-checked");
    }
  } catch {
    // noop
  }
  const estado_operativo = inferOperativo(text, ariaChecked);

  // Estado competencia
  const estado_competencia = inferCompetencia(text);

  const record: ParsedRecord = {
    sku,
    itemId,
    estado_competencia,
    estado_operativo,
    titulo,
  };

  return record.titulo || record.itemId ? record : null;
}
