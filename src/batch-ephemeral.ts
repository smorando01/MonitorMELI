import "dotenv/config";
import { chromium, Page, BrowserContext } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { parseFromFile, ParsedRecord } from "./extract";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "node:process";

const BASE = "https://www.mercadolibre.com.uy";
const PUBS_URL = `${BASE}/publicaciones/listado?filters=CHANNEL_ONLY_MARKETPLACE&page=1&sort=DEFAULT`;

/* ------------------ utilidades “humanas” ------------------ */

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function jitter(baseMs: number, spreadPct = 0.35) {
  const d = Math.round(baseMs * spreadPct);
  return baseMs + rand(-d, d);
}
async function humanPause(ms: number) {
  await new Promise((r) => setTimeout(r, jitter(ms)));
}

async function humanMouseMove(page: Page) {
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  const targetX = rand(Math.round(vp.width * 0.2), Math.round(vp.width * 0.8));
  const targetY = rand(Math.round(vp.height * 0.2), Math.round(vp.height * 0.8));
  const steps = rand(10, 24);
  const mouse = page.mouse;

  const start = { x: rand(0, vp.width), y: rand(0, vp.height) };
  await mouse.move(start.x, start.y);
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(start.x + (i / steps) * (targetX - start.x) + rand(-2, 2));
    const y = Math.round(start.y + (i / steps) * (targetY - start.y) + rand(-2, 2));
    await mouse.move(x, y);
    await humanPause(rand(8, 18));
  }
}

async function humanScroll(page: Page) {
  await page.mouse.wheel(0, rand(250, 400));
  await humanPause(rand(120, 240));
  await page.mouse.wheel(0, -rand(120, 220));
}

/* -------------- helpers base -------------- */

function log(msg: string) {
  console.log(msg);
}

async function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function dismissOverlays(page: Page) {
  const sels = [
    'button[aria-label="Cerrar"]',
    '.andes-modal__close',
    'button:has-text("×")',
    'button:has-text("Entendido")',
    'button:has-text("Aceptar")',
    'button:has-text("Aceptar todo")',
  ];
  for (const s of sels) {
    const btn = page.locator(s).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(120);
    }
  }
}

/** Espera pasiva mientras hacés login/2FA, sin navegar agresivo. */
async function waitForManualLogin(page: Page, maxMs: number) {
  const start = Date.now();
  if (/\/publicaciones\/listado/.test(page.url())) return true;
  while (Date.now() - start < maxMs) {
    if (/\/publicaciones\/listado/.test(page.url())) return true;
    const left = Math.max(0, Math.round((maxMs - (Date.now() - start)) / 1000));
    process.stdout.write(`\r🔐 Completá el login (CAPTCHA/2FA). Máximo ${left}s… `);
    await humanPause(1000);
  }
  process.stdout.write("\n");
  return false;
}

/** URL directa al editor desde itemId */
function itemUrl(itemId?: string) {
  return itemId ? `${BASE}/syi/core/modify?itemId=${encodeURIComponent(itemId)}` : "";
}

/** Guarda el HTML “tal cual” para ese SKU en out/page-<sku>.html */
async function saveHtmlForSku(page: Page, sku: string) {
  const url = `${PUBS_URL}&search=${encodeURIComponent(sku)}`;

  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  await humanPause(rand(400, 900));
  await dismissOverlays(page);
  try { await humanScroll(page); } catch {}
  try { await humanMouseMove(page); } catch {}

  const html = await page.content();
  await ensureDir("out");
  fs.writeFileSync(path.join("out", `page-${sku}.html`), html, "utf8");
}

/** Lee skus.csv (una columna, o primera columna). Ignora encabezados y no numéricos */
function readSkusCsv(file = "skus.csv"): string[] {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // si la primera línea parece encabezado (empieza con letra), saltarla
  const startIdx = /^[A-Za-z]/.test(lines[0] || "") ? 1 : 0;

  return lines
    .slice(startIdx)
    .map((line) => (line.split(/,|\t/)[0] || "").trim())
    .map((t) => t.replace(/[^\d]/g, "")) // dejar sólo dígitos
    .filter((t) => /^\d+$/.test(t));     // y validar
}

/* ---------- CSV ---------- */

function nowISO() {
  return new Date().toISOString();
}
function csvHeader(): string {
  return "SKU,ITEM_ID,ESTADO_COMPETENCIA,ESTADO_OPERATIVO,TITULO,URL,TIMESTAMP\n";
}
function recordsToCsv(rows: Array<ParsedRecord & { timestamp: string }>): string {
  const esc = (s: string) => `"${(s || "").replace(/"/g, '""')}"`;
  const lines = rows.map(r =>
    [
      r.sku,
      r.itemId,
      r.estado_competencia,
      r.estado_operativo,
      esc(r.titulo || ""),
      itemUrl(r.itemId),
      r.timestamp, // ISO para procesar en planillas
    ].join(",")
  );
  return csvHeader() + lines.join("\n") + "\n";
}

/* ---------- Reporte HTML + Email ---------- */

type RowWithTs = ParsedRecord & { timestamp: string };

const STATUS_ORDER: ParsedRecord["estado_competencia"][] = [
  "Ganando",
  "Compartiendo primer lugar",
  "Perdiendo",
  "SIN_ESTADO",
];

function localFmt(d: Date | string) {
  const dt = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("es-UY", {
    timeZone: "America/Montevideo",
    dateStyle: "short",
    timeStyle: "short",
  }).format(dt);
}

function summarize(rows: RowWithTs[]) {
  const byComp = new Map<string, number>();
  const byOp = new Map<string, number>();
  for (const r of rows) {
    byComp.set(r.estado_competencia, (byComp.get(r.estado_competencia) || 0) + 1);
    byOp.set(r.estado_operativo, (byOp.get(r.estado_operativo) || 0) + 1);
  }
  return { byComp, byOp, total: rows.length };
}

function tableFor(rows: RowWithTs[]) {
  const ordered = [...rows].sort((a, b) => {
    const opRank = (s: ParsedRecord["estado_operativo"]) =>
      s === "Activa" ? 0 : s === "Pausada" ? 1 : s === "Inactiva" ? 2 : 3;
    const d = opRank(a.estado_operativo) - opRank(b.estado_operativo);
    if (d !== 0) return d;
    return (a.titulo || "").localeCompare(b.titulo || "", "es");
  });

  const rowsHtml = ordered.map(r => `
    <tr>
      <td>${r.sku}</td>
      <td>${r.itemId || "-"}</td>
      <td>${r.estado_operativo}</td>
      <td>${(r.titulo || "").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</td>
      <td>${r.itemId ? `<a href="${itemUrl(r.itemId)}" target="_blank" rel="noopener">Abrir</a>` : ""}</td>
      <td>${localFmt(r.timestamp)}</td>
    </tr>
  `).join("");

  return `
    <table role="grid" style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:#f6f6f6">
          <th style="text-align:left;padding:8px;border:1px solid #eee">SKU</th>
          <th style="text-align:left;padding:8px;border:1px solid #eee">Item ID</th>
          <th style="text-align:left;padding:8px;border:1px solid #eee">Operativo</th>
          <th style="text-align:left;padding:8px;border:1px solid #eee">Título</th>
          <th style="text-align:left;padding:8px;border:1px solid #eee">URL</th>
          <th style="text-align:left;padding:8px;border:1px solid #eee">Hora</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;
}

function htmlReport(rows: RowWithTs[]) {
  const { byComp, byOp, total } = summarize(rows);
  const style = `
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Helvetica, Arial; color:#222; line-height:1.35; }
    h1 { font-size:18px; margin:0 0 6px }
    h3 { font-size:15px; margin:22px 0 8px }
    .meta { color:#666; font-size:12px; margin:0 0 14px }
    .badges { display:flex; gap:8px; flex-wrap:wrap; margin:0 0 14px }
    .badge { border:1px solid #e5e5e5; background:#fafafa; border-radius:10px; padding:8px 10px; font-size:12px }
    table { margin-bottom:8px }
  </style>`;

  const compStr = STATUS_ORDER
    .map(s => `${s}: ${(byComp.get(s) || 0)}`)
    .join(" · ");
  const opStr = ["Activa","Pausada","Inactiva","UNKNOWN"]
    .map(s => `${s}: ${(byOp.get(s) || 0)}`)
    .join(" · ");

  const sections = STATUS_ORDER
    .filter(st => rows.some(r => r.estado_competencia === st))
    .map(st => {
      const rws = rows.filter(r => r.estado_competencia === st);
      return `<h3>${st} (${rws.length})</h3>${tableFor(rws)}`;
    })
    .join("");

  const when = new Intl.DateTimeFormat("es-UY", {
    timeZone: "America/Montevideo", dateStyle: "full", timeStyle: "medium"
  }).format(new Date());

  return `<!doctype html><html><head><meta charset="utf-8" />${style}</head><body>
    <h1>Reporte Monitor ML</h1>
    <div class="meta">Generado: ${when} (America/Montevideo) · Total SKUs: <b>${total}</b></div>
    <div class="badges">
      <div class="badge"><b>Competencia</b> — ${compStr}</div>
      <div class="badge"><b>Operativo</b> — ${opStr}</div>
    </div>
    ${sections || "<p>No hubo resultados.</p>"}
    <hr style="margin:18px 0;border:none;border-top:1px solid #eee" />
    <div style="font-size:12px;color:#777">Mensaje generado automáticamente.</div>
  </body></html>`;
}

async function trySendEmail(html: string, subject: string) {
  // carga perezosa de nodemailer
  let nodemailer: any = null;
  try {
    // @ts-ignore
    nodemailer = await import("nodemailer");
  } catch {
    console.log("✉️  nodemailer no está instalado. Guardé el reporte en out/report.html");
    return false;
  }

  const {
    SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS,
    MAIL_FROM, MAIL_TO, MAIL_CC,
  } = process.env;

  if (!SMTP_HOST || !SMTP_PORT || !MAIL_FROM || !MAIL_TO) {
    console.log("✉️  Faltan variables SMTP (SMTP_HOST/SMTP_PORT/MAIL_FROM/MAIL_TO). Guardé el reporte en out/report.html");
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: String(SMTP_SECURE || "false") === "true",
    auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });

  await transporter.sendMail({
    from: MAIL_FROM,
    to: MAIL_TO,
    cc: MAIL_CC || undefined,
    subject,
    html,
  });

  console.log("✅ Reporte enviado por email.");
  return true;
}

/* ---------- NUEVO: edición de asunto y confirmación ---------- */

async function promptSubjectAndConfirm(defaultSubject: string) {
  const { MAIL_TO = "", MAIL_CC = "" } = process.env;

  const rl = createInterface({ input, output });

  output.write(`\n✉️  Previa de envío de email\n`);
  output.write(`   Para: ${MAIL_TO || "(sin TO)"}\n`);
  output.write(`   CC  : ${MAIL_CC || "(sin CC)"}\n`);
  output.write(`   Asunto (enter para aceptar sugerido)\n`);

  const typed = await rl.question(`> ${defaultSubject}\n> `);
  const finalSubject = (typed || "").trim() || defaultSubject;

  const confirm = (await rl.question(`¿Confirmás el envío? (s/N): `))
    .trim()
    .toLowerCase();

  rl.close();

  const ok =
    confirm === "s" ||
    confirm === "si" ||
    confirm === "sí" ||
    confirm === "y" ||
    confirm === "yes";

  return { subject: finalSubject, ok };
}

/* ------------------ MAIN ------------------ */

(async () => {
  // UA realistas
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  ];
  const ua = userAgents[rand(0, userAgents.length - 1)];

  // Viewport humanizado
  const vp = { width: rand(1200, 1440), height: rand(750, 900) };

  // Contexto persistente (cookies/sesión)
  const userDataDir = path.resolve(".meli-profile");
  const context: BrowserContext = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: vp,
    userAgent: ua,
    locale: "es-UY",
    timezoneId: "America/Montevideo",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-default-browser-check",
      "--disable-popup-blocking",
    ],
  });

  const page = await context.newPage();

  // Cabeceras suaves
  await page.setExtraHTTPHeaders({
    "Accept-Language": "es-UY,es-ES;q=0.9,es;q=0.8,en;q=0.6",
  });

  log("➡️ Abriendo Mercado Libre…");
  await page.goto(PUBS_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
  await humanPause(rand(350, 800));
  await dismissOverlays(page);

  if (!/\/publicaciones\/listado/.test(page.url())) {
    log("🔐 Hacé login (usuario/2FA/CAPTCHA). Tenés 5 minutos.");
    const ok = await waitForManualLogin(page, 5 * 60_000);
    if (!ok) {
      log("\n❌ No se detectó login. Cerrando.");
      await context.close();
      process.exit(1);
    }
    log("\n✅ Login detectado.");
  } else {
    log("✅ Sesión existente detectada.");
  }

  const skus = readSkusCsv("skus.csv");
  if (skus.length === 0) {
    log("⚠️ skus.csv está vacío o no existe.");
    await context.close();
    process.exit(0);
  }

  // Procesamos y guardamos en memoria (no se acumula histórico)
  const rows: RowWithTs[] = [];

  for (const sku of skus) {
    try {
      await humanPause(rand(180, 420)); // pausas humanas entre SKUs

      log(`🔎 SKU ${sku}: guardando HTML…`);
      await saveHtmlForSku(page, sku);

      log(`🧩 SKU ${sku}: parseando HTML…`);
      const parsed = parseFromFile(sku);
      if (!parsed) {
        log(
          `⚠️ SKU ${sku}: el HTML guardado no contiene una fila para ese SKU o no se pudo parsear (revisá out/page-${sku}.html)`
        );
        continue;
      }
      const withTs: RowWithTs = { ...parsed, timestamp: nowISO() };
      rows.push(withTs);

      log(
        `✅ SKU ${sku}: ${parsed.estado_competencia} | ${parsed.estado_operativo} | ${parsed.itemId} | ${parsed.titulo}`
      );

      await humanPause(rand(300, 700)); // “respiro” aleatorio
    } catch (e: any) {
      log(`❌ SKU ${sku}: ERROR ${e?.message || e}`);
      await humanPause(rand(600, 1200));
    }
  }

  // --- CSV (sobrescribe siempre)
  const OUT = "results.csv";
  fs.writeFileSync(OUT, recordsToCsv(rows), "utf8");
  log(`📄 ${OUT} regenerado (${rows.length} filas).`);

  // --- Consola legible
  try {
    console.table(
      rows.map((r) => ({
        SKU: r.sku,
        ITEM_ID: r.itemId,
        COMPETENCIA: r.estado_competencia,
        OPERATIVO: r.estado_operativo,
        TITULO: r.titulo.slice(0, 80),
      }))
    );
  } catch {}

  // --- Reporte HTML
  await ensureDir("out");
  const html = htmlReport(rows);
  const reportPath = path.join("out", "report.html");
  fs.writeFileSync(reportPath, html, "utf8");
  log(`🗂  Reporte guardado en ${reportPath}`);

  // --- Email (interactivo opcional)
  let subject = `Reporte Monitor ML - ${localFmt(new Date())}`;
  const interactive = String(process.env.MAIL_INTERACTIVE || "false").toLowerCase() === "true";
  if (interactive) {
    const { subject: edited, ok } = await promptSubjectAndConfirm(subject);
    subject = edited;
    if (!ok) {
      log("✉️  Envío cancelado por el usuario.");
      await context.close();
      log("✅ Listo.");
      process.exit(0);
    }
  }

  try {
    await trySendEmail(html, subject);
  } catch (err: any) {
    log(`❌ No se pudo enviar el email: ${err?.message || err}`);
  }

  await context.close();
  log(`✅ Listo.`);
})();
