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
  // Null = nunca perguntado; 0 = o usuario confirmou que nao houve reembolso.
  // A coluna valor continua sendo o BRUTO pago, que e o que a nota comprova; o
  // liquido e derivado aqui, na leitura.
  valor_reembolsado: number | string | null;
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

// Deducao reduz a BASE DE CALCULO do IRPF, nao o imposto devido. Sem esta nota
// o dossie e lido como "valor que volta para o bolso", que e o erro que o
// texto de confirmacao no WhatsApp e o resumo tambem passaram a evitar.
// Quebrado em linhas fixas de proposito: o cabecalho nao tem quebra automatica,
// e tests/dossie_nota_deducao_test.ts prova que cada linha cabe na largura util.
export const NOTA_DEDUCAO = [
  "Valores dedutiveis reduzem a base de calculo do IR — a economia real depende da sua",
  "faixa de tributacao. Nao e o valor que voce recebe de volta.",
];

// A soma das larguras e exatamente a largura util (595 - 2 * 40 = 515), e
// tests/dossie_nota_deducao_test.ts prova isso. A coluna Reembolso entrou
// tirando espaco das outras, e nao esticando a tabela: fitToWidth trunca o que
// nao couber, entao Descricao encolher e degradacao aceitavel — a alternativa
// seria a tabela vazar a margem.
export const COLUMNS = [
  { key: "data", label: "Data", width: 55 },
  { key: "descricao", label: "Descricao", width: 115 },
  { key: "categoria", label: "Categoria", width: 75 },
  { key: "valor", label: "Valor", width: 60 },
  { key: "reembolso", label: "Reembolso", width: 55 },
  { key: "deducibilidade", label: "Dedutibilidade", width: 82 },
  { key: "status", label: "Status", width: 73 },
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
    // Literal unico de proposito: o supabase-js infere o tipo do resultado a
    // partir do texto do select, e concatenar com + faz a inferencia cair para
    // GenericStringError e o cast abaixo parar de compilar.
    .select("data_despesa, criado_em, descricao, categoria, valor, valor_reembolsado, deducibilidade, status")
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
  let totalReembolsado = 0;
  let totalDedutivel = 0;

  for (const recibo of recibos) {
    if (y < BOTTOM_LIMIT) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
      y = drawTableHeader(page, bold, y);
    }

    const valor = Number(recibo.valor) || 0;
    total += valor;

    // null e "nunca perguntado", e nao "zero": a diferenca aparece na coluna,
    // porque um traco e uma lacuna que o contador pode querer preencher, e
    // "R$ 0,00" e uma resposta que o titular ja deu.
    const reembolsado = recibo.valor_reembolsado === null ||
        recibo.valor_reembolsado === undefined
      ? null
      : Number(recibo.valor_reembolsado) || 0;
    totalReembolsado += reembolsado ?? 0;

    // Mesma regra do resumo_fiscal_usuario: so DEDUTIVEL entra, e entra pelo
    // liquido. Somar o bruto de despesa reembolsada superestima a deducao, que
    // e o gatilho de malha fina que o cruzamento com a DMED procura.
    if (recibo.deducibilidade === "DEDUTIVEL") {
      totalDedutivel += valor - (reembolsado ?? 0);
    }

    const cells = [
      formatDate(recibo.data_despesa ?? recibo.criado_em),
      recibo.descricao ?? "",
      humanize(recibo.categoria),
      formatCurrency(valor),
      reembolsado === null ? "-" : formatCurrency(reembolsado),
      humanize(recibo.deducibilidade),
      humanize(recibo.status),
    ];

    drawRow(page, font, y, cells);
    y -= 16;
  }

  // O rodape cresceu com as duas linhas de reembolso; a folga precisa crescer
  // junto, senao a ultima linha cai fora da pagina em vez de comecar outra.
  if (y < BOTTOM_LIMIT + 62) {
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

  // As duas linhas so aparecem quando ha reembolso informado: sem isso, todo
  // dossie carregaria "Total reembolsado: R$ 0,00", que sugere uma pergunta que
  // nunca foi feita.
  if (totalReembolsado > 0) {
    y -= 16;
    page.drawText(sanitize(`Total reembolsado: ${formatCurrency(totalReembolsado)}`), {
      x: MARGIN,
      y,
      size: 10,
      font,
    });

    y -= 14;
    page.drawText(
      sanitize(`Total dedutivel (liquido do reembolso): ${formatCurrency(totalDedutivel)}`),
      { x: MARGIN, y, size: 10, font: bold },
    );
  }

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

  y -= 16;
  for (const linha of NOTA_DEDUCAO) {
    page.drawText(sanitize(linha), {
      x: MARGIN,
      y,
      size: 8,
      font,
      color: rgb(0.35, 0.35, 0.35),
    });
    y -= 11;
  }

  return y - 14;
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
