// src/report.ts
import nodemailer from "nodemailer";

export type Row = {
  sku: string;
  itemId: string;
  estado_competencia: "Ganando" | "Perdiendo" | "Compartiendo primer lugar" | "SIN_ESTADO";
  estado_operativo: "Activa" | "Pausada" | "Inactiva" | "UNKNOWN";
  titulo: string;
};

type Groups = Record<
  Row["estado_competencia"],
  Row[]
>;

const STATUS_ORDER: Row["estado_competencia"][] = [
  "Ganando",
  "Compartiendo primer lugar",
  "Perdiendo",
  "SIN_ESTADO",
];

function formatLocal(ts: Date | string) {
  const d = typeof ts === "string" ? new Date(ts) : ts;
  return new Intl.DateTimeFormat("es-UY", {
    timeZone: "America/Montevideo",
    dateStyle: "full",
    timeStyle: "medium",
  }).format(d);
}

function itemUrl(itemId?: string) {
  if (!itemId) return "#";
  return `https://www.mercadolibre.com.uy/syi/core/modify?itemId=${encodeURIComponent(itemId)}`;
}

export function summarize(rows: Row[]) {
  const total = rows.length;

  // Agrupar por competencia
  const groups: Groups = {
    Ganando: [],
    "Compartiendo primer lugar": [],
    Perdiendo: [],
    SIN_ESTADO: [],
  };
  for (const r of rows) groups[r.estado_competencia].push(r);

  // Conteos rápidos
  const compCounts = Object.fromEntries(
    STATUS_ORDER.map(st => [st, groups[st].length])
  ) as Record<Row["estado_competencia"], number>;

  const opCounts = rows.reduce<Record<Row["estado_operativo"], number>>((acc, r) => {
    acc[r.estado_operativo] = (acc[r.estado_operativo] ?? 0) + 1;
    return acc;
  }, { Activa: 0, Pausada: 0, Inactiva: 0, UNKNOWN: 0 });

  return { total, groups, compCounts, opCounts };
}

function tableFor(rows: Row[]) {
  // Orden dentro del grupo: primero “Activa”, luego el resto; y por título.
  const ordered = [...rows].sort((a, b) => {
    const opRank = (s: Row["estado_operativo"]) =>
      s === "Activa" ? 0 : s === "Pausada" ? 1 : s === "Inactiva" ? 2 : 3;
    const d = opRank(a.estado_operativo) - opRank(b.estado_operativo);
    if (d !== 0) return d;
    return (a.titulo || "").localeCompare(b.titulo || "", "es");
  });

  const rowsHtml = ordered.map(r => {
    const url = itemUrl(r.itemId);
    return `
      <tr>
        <td>${r.sku}</td>
        <td>${r.itemId || "-"}</td>
        <td>${r.estado_operativo}</td>
        <td>${(r.titulo || "").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</td>
        <td><a href="${url}" target="_blank" rel="noopener">Abrir</a></td>
      </tr>`;
  }).join("");

  return `
    <table role="grid" style="width:100%;border-collapse:collapse;font-size:14px">
      <thead>
        <tr style="background:#f5f5f5">
          <th style="text-align:left;padding:8px;border:1px solid #e5e5e5;">SKU</th>
          <th style="text-align:left;padding:8px;border:1px solid #e5e5e5;">Item ID</th>
          <th style="text-align:left;padding:8px;border:1px solid #e5e5e5;">Operativo</th>
          <th style="text-align:left;padding:8px;border:1px solid #e5e5e5;">Título</th>
          <th style="text-align:left;padding:8px;border:1px solid #e5e5e5;">URL</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}

export function buildHtmlReport(rows: Row[]) {
  const now = new Date();
  const tsLocal = formatLocal(now);
  const { total, groups, compCounts, opCounts } = summarize(rows);

  const sections = STATUS_ORDER
    .filter(st => groups[st].length > 0)
    .map(st => `
      <h3 style="margin:24px 0 8px">${st} (${groups[st].length})</h3>
      ${tableFor(groups[st])}
    `).join("");

  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Helvetica,Arial,sans-serif;line-height:1.35;color:#111">
    <h2 style="margin:0 0 4px">Reporte Monitor ML</h2>
    <div style="margin:0 0 24px;color:#555">Generado: ${tsLocal} (America/Montevideo)</div>

    <div style="margin:0 0 16px">
      <strong>Total SKUs:</strong> ${total}
    </div>

    <div style="display:flex;gap:24px;flex-wrap:wrap;margin:0 0 16px">
      <div><strong>Competencia</strong> — 
        Ganando: ${compCounts.Ganando} · 
        Compartiendo: ${compCounts["Compartiendo primer lugar"]} · 
        Perdiendo: ${compCounts.Perdiendo} · 
        SIN_ESTADO: ${compCounts.SIN_ESTADO}
      </div>
      <div><strong>Operativo</strong> — 
        Activa: ${opCounts.Activa} · 
        Pausada: ${opCounts.Pausada} · 
        Inactiva: ${opCounts.Inactiva} · 
        UNKNOWN: ${opCounts.UNKNOWN}
      </div>
    </div>

    ${sections || "<p>No hubo resultados.</p>"}

    <hr style="margin:24px 0;border:none;border-top:1px solid #eee" />
    <div style="font-size:12px;color:#777">Este mensaje fue generado automáticamente.</div>
  </div>`;
  return html;
}

export async function sendEmailReport(rows: Row[]) {
  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_SECURE,
    SMTP_USER,
    SMTP_PASS,
    MAIL_TO,     // CSV
    MAIL_CC,     // CSV (opcional)
    MAIL_FROM,   // opcional: nombre visible
  } = process.env;

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 465),
    secure: String(SMTP_SECURE || "true").toLowerCase() === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const html = buildHtmlReport(rows);
  const subject = `Reporte Monitor ML - ${formatLocal(new Date())}`;

  const to = (MAIL_TO || "").split(",").map(s => s.trim()).filter(Boolean);
  const cc = (MAIL_CC || "").split(",").map(s => s.trim()).filter(Boolean);

  await transporter.sendMail({
    from: MAIL_FROM || SMTP_USER!,
    to,
    cc: cc.length ? cc : undefined,
    subject,
    html,
  });
}
