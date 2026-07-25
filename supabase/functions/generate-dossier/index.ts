import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

type DossierRequest = {
  usuario_id: string;
};

type ReciboRow = {
  data_despesa: string | null;
  criado_em: string;
  descricao: string;
  categoria: string;
  valor: number | string;
  deducibilidade: string;
  status: string;
};

const jsonHeaders = { "content-type": "application/json" };

const env = (name: string, fallback = "") => Deno.env.get(name) ?? fallback;

const BUCKET = env("DOSSIE_BUCKET", "dossies");
const SIGNED_URL_TTL_SECONDS = 60 * 60;

const supabase = createClient(
  env("SUPABASE_URL"),
  env("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

// Layout A4 em pontos.
const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 40;
const BOTTOM_LIMIT = 60;

const COLUMNS = [
  { key: "data", label: "Data", width: 55 },
  { key: "descricao", label: "Descricao", width: 145 },
  { key: "categoria", label: "Categoria", width: 85 },
  { key: "valor", label: "Valor", width: 60 },
  { key: "deducibilidade", label: "Dedutibilidade", width: 90 },
  { key: "status", label: "Status", width: 80 },
] as const;

serve(async (request) => {
  try {
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }

    // A anon key e publica (vai no bundle do frontend de onboarding). Sem esta
    // checagem, qualquer pessoa com a anon key poderia pedir o dossie de
    // qualquer usuario_id e baixar o historico financeiro alheio. Esta funcao e
    // server-to-server (n8n), entao exigimos a service_role key.
    if (!isServiceRoleCaller(request)) {
      return json({ error: "unauthorized" }, 401);
    }

    const body = await request.json() as DossierRequest;
    const usuarioId = body?.usuario_id?.trim();
    if (!usuarioId) {
      return json({ error: "missing_usuario_id" }, 400);
    }

    const usuario = await fetchUsuario(usuarioId);
    if (!usuario) {
      return json({ error: "usuario_not_found" }, 404);
    }

    const recibos = await fetchRecibos(usuarioId);
    const pdfBytes = await buildDossierPdf(usuario.nome ?? "Usuario TaxMind", recibos);

    const filename = `dossie-taxmind-${formatDateForFilename(new Date())}.pdf`;
    const storagePath = `${usuarioId}/${filename}`;

    await ensureBucket();

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, pdfBytes, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (uploadError) {
      console.error("failed to upload dossier", uploadError);
      return json({ error: "upload_failed" }, 500);
    }

    const { data: signed, error: signedError } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

    if (signedError || !signed?.signedUrl) {
      console.error("failed to create signed url", signedError);
      return json({ error: "signed_url_failed" }, 500);
    }

    return json({
      url: signed.signedUrl,
      filename,
      total_recibos: recibos.length,
      expires_in_seconds: SIGNED_URL_TTL_SECONDS,
    });
  } catch (error) {
    console.error("generate-dossier error", error);
    return json({ error: "internal_error" }, 500);
  }
});

function isServiceRoleCaller(request: Request) {
  // Nao troque esta leitura por outra variavel achando que e redundante: o
  // runtime das Edge Functions injeta SUPABASE_SERVICE_ROLE_KEY ja no formato
  // novo (sb_secret_...), e e contra esse valor que o token recebido precisa
  // bater byte a byte. O resto do projeto (secrets do Supabase e variaveis do
  // n8n) ainda usa o JWT antigo (eyJ...), entao quem chama esta function — o
  // node "Edge - Gerar Dossie" no n8n — precisa mandar a versao sb_secret_,
  // guardada de forma isolada em SUPABASE_SECRET_KEY_SB_FORMAT.
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) {
    console.error("SUPABASE_SERVICE_ROLE_KEY not configured; refusing request");
    return false;
  }

  const header = request.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return timingSafeEqual(token, serviceRoleKey);
}

async function fetchUsuario(usuarioId: string) {
  const { data, error } = await supabase
    .from("usuarios")
    .select("id, nome")
    .eq("id", usuarioId)
    .maybeSingle();

  if (error) {
    console.error("failed to fetch usuario", error);
    throw new Error("usuario_lookup_failed");
  }

  return data;
}

async function fetchRecibos(usuarioId: string): Promise<ReciboRow[]> {
  const { data, error } = await supabase
    .from("recibos_evidencias")
    .select("data_despesa, criado_em, descricao, categoria, valor, deducibilidade, status")
    .eq("usuario_id", usuarioId)
    .order("data_despesa", { ascending: true, nullsFirst: false })
    .order("criado_em", { ascending: true });

  if (error) {
    console.error("failed to fetch recibos", error);
    throw new Error("recibos_lookup_failed");
  }

  return (data ?? []) as ReciboRow[];
}

async function ensureBucket() {
  const { data: existing } = await supabase.storage.getBucket(BUCKET);
  if (existing) return;

  // public: false e obrigatorio — o acesso ao dossie deve ser sempre por
  // signed URL de vida curta, nunca por URL permanente.
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: "25MB",
    allowedMimeTypes: ["application/pdf"],
  });

  // Corrida entre duas execucoes simultaneas: se o bucket ja existe, seguimos.
  if (error && !/already exists/i.test(error.message)) {
    console.error("failed to create bucket", error);
    throw new Error("bucket_creation_failed");
  }
}

// Exportada para permitir teste isolado da geracao do PDF sem subir a function.
export async function buildDossierPdf(nome: string, recibos: ReciboRow[]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = drawHeader(page, bold, font, nome);
  y = drawTableHeader(page, bold, y);

  let total = 0;

  for (const recibo of recibos) {
    if (y < BOTTOM_LIMIT) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
      y = drawTableHeader(page, bold, y);
    }

    const valor = Number(recibo.valor) || 0;
    total += valor;

    const cells = [
      formatDate(recibo.data_despesa ?? recibo.criado_em),
      recibo.descricao ?? "",
      humanize(recibo.categoria),
      formatCurrency(valor),
      humanize(recibo.deducibilidade),
      humanize(recibo.status),
    ];

    drawRow(page, font, y, cells);
    y -= 16;
  }

  if (y < BOTTOM_LIMIT + 30) {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  }

  y -= 10;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 1,
    color: rgb(0.2, 0.2, 0.2),
  });

  y -= 18;
  page.drawText(sanitize(`Total geral: ${formatCurrency(total)}`), {
    x: MARGIN,
    y,
    size: 11,
    font: bold,
  });

  y -= 16;
  page.drawText(sanitize(`Lancamentos: ${recibos.length}`), {
    x: MARGIN,
    y,
    size: 9,
    font,
  });

  return await doc.save();
}

function drawHeader(page: PDFPage, bold: PDFFont, font: PDFFont, nome: string) {
  let y = PAGE_HEIGHT - MARGIN;

  page.drawText(sanitize("TaxMind - Dossie Fiscal"), {
    x: MARGIN,
    y,
    size: 18,
    font: bold,
    color: rgb(0.04, 0.35, 0.25),
  });

  y -= 22;
  page.drawText(sanitize(nome), { x: MARGIN, y, size: 12, font: bold });

  y -= 16;
  page.drawText(sanitize(`Gerado em ${formatDateTime(new Date())}`), {
    x: MARGIN,
    y,
    size: 9,
    font,
    color: rgb(0.35, 0.35, 0.35),
  });

  return y - 22;
}

function drawTableHeader(page: PDFPage, bold: PDFFont, y: number) {
  let x = MARGIN;
  for (const column of COLUMNS) {
    page.drawText(sanitize(column.label), { x, y, size: 9, font: bold });
    x += column.width;
  }

  const lineY = y - 5;
  page.drawLine({
    start: { x: MARGIN, y: lineY },
    end: { x: PAGE_WIDTH - MARGIN, y: lineY },
    thickness: 0.8,
    color: rgb(0.6, 0.6, 0.6),
  });

  return y - 20;
}

function drawRow(page: PDFPage, font: PDFFont, y: number, cells: string[]) {
  let x = MARGIN;
  cells.forEach((cell, index) => {
    const column = COLUMNS[index];
    page.drawText(fitToWidth(sanitize(cell), font, 8, column.width - 6), {
      x,
      y,
      size: 8,
      font,
    });
    x += column.width;
  });
}

// As StandardFonts do pdf-lib usam WinAnsi, que cobre acento latino mas nao
// emoji nem simbolos fora de Latin-1 (testado: "🏥" e "₂" lancam excecao e
// quebrariam o dossie inteiro). Como descricao vem de OCR, sanear e obrigatorio.
function sanitize(value: string) {
  return (value ?? "")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .normalize("NFC")
    // Remove o que sobrou fora do range imprimivel de Latin-1.
    .replace(/[^\x20-\x7E\xA1-\xFF]/g, "");
}

function fitToWidth(value: string, font: PDFFont, size: number, maxWidth: number) {
  if (font.widthOfTextAtSize(value, size) <= maxWidth) return value;

  let truncated = value;
  while (truncated.length > 1 && font.widthOfTextAtSize(`${truncated}...`, size) > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}...`;
}

function humanize(value: string) {
  if (!value) return "";
  return value.charAt(0) + value.slice(1).toLowerCase().replaceAll("_", " ");
}

function formatCurrency(value: number) {
  return `R$ ${value.toFixed(2).replace(".", ",")}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function formatDateTime(date: Date) {
  return date.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function formatDateForFilename(date: Date) {
  return date.toISOString().slice(0, 19).replaceAll(":", "").replaceAll("-", "");
}

function timingSafeEqual(a: string, b: string) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}
