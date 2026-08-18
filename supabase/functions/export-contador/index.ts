// Export estruturado para o contador (.xlsx), complementar ao dossie em PDF.
//
// COMO ELE DIFERE DO DOSSIE
//
// O dossie mostra TUDO, inclusive o que nao e dedutivel, porque ele e a trilha
// de auditoria do titular. Este arquivo e material de trabalho do contador:
// entra so o que ele pode efetivamente usar, ja separado pelo MECANISMO de
// deducao, que e a decisao que ele precisa tomar linha a linha.
//
// POR QUE DUAS ABAS, E NAO UMA LISTA COM COLUNA "TIPO"
//
// "Pagamentos Efetuados" (SAUDE, EDUCACAO) e deducao pessoal universal: vale
// para qualquer contribuinte. Livro-Caixa so vale para quem recebe renda nao
// assalariada sujeita ao carne-leao, e e limitado a receita do mes — algo que o
// TaxMind nao rastreia. Sao mecanismos diferentes, com publicos diferentes e
// limites diferentes; numa lista unica o leitor soma um total geral que nao
// existe para ninguem. A regra de qual linha vai para qual aba fica em
// _shared/export_contador.ts.
//
// POR QUE .xlsx E NAO .csv
//
// O arquivo e entregue como documento do WhatsApp, e a Cloud API da Meta nao
// lista text/csv entre os mime types aceitos para documento — .xlsx esta na
// lista. Um CSV correto seria recusado no envio. Como bonus, o xlsx da as duas
// abas de graca e preserva valor como NUMERO, entao o contador soma e filtra
// sem reimportar nada.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import {
  type ReciboExportavel,
  secaoDoRecibo,
  valorLiquido,
} from "../_shared/export_contador.ts";
import { rotuloTitulo } from "../_shared/rotulos.ts";

type ExportRequest = {
  usuario_id: string;
};

type ReciboRow = ReciboExportavel & {
  data_despesa: string | null;
  criado_em: string;
  descricao: string;
  estabelecimento: string | null;
  documento_prestador: string | null;
  valor: number | string;
  // Null = nunca perguntado; 0 = o titular confirmou que nao houve reembolso.
  // A distincao sobrevive ate a celula: vazia contra 0,00.
  valor_reembolsado: number | string | null;
};

const jsonHeaders = { "content-type": "application/json" };

const env = (name: string, fallback = "") => Deno.env.get(name) ?? fallback;

const BUCKET = env("EXPORT_CONTADOR_BUCKET", "exports-contador");
const SIGNED_URL_TTL_SECONDS = 60 * 60;

const MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const supabase = createClient(
  env("SUPABASE_URL"),
  env("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

// Nomes de aba do Excel: maximo 31 caracteres, e sem : \ / ? * [ ].
export const ABA_PAGAMENTOS = "Pagamentos Efetuados";
export const ABA_LIVRO_CAIXA = "Possíveis deduções Livro-Caixa";

// A nota da aba de Livro-Caixa e o ponto inteiro da separacao: sem ela, um
// assalariado leria a aba como deducao disponivel e declararia despesa que a
// Receita glosa. Ela fica na PRIMEIRA linha da aba, acima do cabecalho da
// tabela, porque nota de rodape em planilha some assim que alguem ordena ou
// filtra a faixa de dados.
export const NOTA_LIVRO_CAIXA =
  "Aplicável apenas a quem recebe renda não assalariada sujeita a carnê-leão. " +
  "Sujeito a limite de receita mensal, não verificado por este sistema. " +
  "Confirme com seu contador antes de utilizar.";

// Transporte sai por vedacao legal, nao por triagem nossa, e o contador precisa
// saber disso: sem o aviso, a ausencia da categoria parece falta de despesa. Se
// o titular for representante comercial autonomo — a unica excecao do art. 68 —
// e justamente ele quem perde deducao com o silencio.
export const NOTA_TRANSPORTE_FORA =
  "Despesas de transporte e locomoção não entram nesta aba: o art. 68 do RIR/2018 " +
  "veda a dedução no livro-caixa, exceto para representante comercial autônomo. " +
  "Se for o seu caso, peça o dossiê completo em PDF, que lista essas despesas.";

// A ficha "Pagamentos Efetuados" tambem tem limite que o sistema nao verifica —
// educacao tem teto anual por pessoa. O valor do teto muda todo ano e por isso
// nao aparece aqui: um numero desatualizado no arquivo seria pior do que a
// remissao ao contador.
export const NOTA_PAGAMENTOS =
  "Saúde não tem limite de valor. Educação tem limite anual por pessoa, não verificado " +
  "por este sistema — confira o teto do exercício com seu contador.";

export const CABECALHO_TABELA = [
  "Data",
  "Descrição",
  "Estabelecimento",
  "CPF/CNPJ do prestador",
  "Categoria",
  "Valor bruto (R$)",
  "Reembolso (R$)",
  "Valor líquido (R$)",
  "Dedutibilidade (TaxMind)",
  "Status (TaxMind)",
];

// Indices 0-based das colunas de dinheiro no CABECALHO_TABELA acima. Ficam em
// constante porque o formato de moeda e aplicado por indice depois que a aba e
// montada; acrescentar coluna sem atualizar isto formataria a coluna errada, e
// ha teste que amarra os dois.
export const COLUNAS_MOEDA = [5, 6, 7];
export const COLUNA_DATA = 0;

serve(async (request) => {
  try {
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }

    // Mesmo raciocinio da generate-dossier: a anon key e publica (vai no bundle
    // do onboarding), e este arquivo e o historico financeiro consolidado do
    // titular. Chamada server-to-server (n8n) exige a service_role.
    if (!isServiceRoleCaller(request)) {
      return json({ error: "unauthorized" }, 401);
    }

    const body = await request.json() as ExportRequest;
    const usuarioId = body?.usuario_id?.trim();
    if (!usuarioId) {
      return json({ error: "missing_usuario_id" }, 400);
    }

    const usuario = await fetchUsuario(usuarioId);
    if (!usuario) {
      return json({ error: "usuario_not_found" }, 404);
    }

    const recibos = await fetchRecibos(usuarioId);
    const { bytes, totalPagamentos, totalLivroCaixa } = buildExportXlsx(
      usuario.nome ?? "Usuário TaxMind",
      recibos,
    );

    const filename = `taxmind-contador-${formatDateForFilename(new Date())}.xlsx`;
    const storagePath = `${usuarioId}/${filename}`;

    await ensureBucket();

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, bytes, { contentType: MIME_XLSX, upsert: true });

    if (uploadError) {
      console.error("failed to upload export", uploadError);
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
      // O n8n usa estes dois para escolher a legenda do WhatsApp: export sem
      // nenhuma linha precisa dizer isso, e nao chegar como planilha muda.
      total_pagamentos_efetuados: totalPagamentos,
      total_livro_caixa: totalLivroCaixa,
      total_linhas: totalPagamentos + totalLivroCaixa,
      expires_in_seconds: SIGNED_URL_TTL_SECONDS,
    });
  } catch (error) {
    console.error("export-contador error", error);
    return json({ error: "internal_error" }, 500);
  }
});

function isServiceRoleCaller(request: Request) {
  // Ver o comentario longo em generate-dossier: o runtime injeta a chave ja no
  // formato sb_secret_, e e contra esse valor que o token precisa bater. Quem
  // chama manda SUPABASE_SECRET_KEY_SB_FORMAT.
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
    // Literal unico: concatenar com + faz a inferencia de tipo do supabase-js
    // cair para GenericStringError e o cast abaixo parar de compilar.
    .select("data_despesa, criado_em, descricao, estabelecimento, documento_prestador, categoria, valor, valor_reembolsado, deducibilidade, status")
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

  // public: false, igual ao bucket do dossie. O acesso e sempre por signed URL
  // de vida curta.
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: "25MB",
    allowedMimeTypes: [MIME_XLSX],
  });

  if (error && !/already exists/i.test(error.message)) {
    console.error("failed to create bucket", error);
    throw new Error("bucket_creation_failed");
  }
}

/**
 * Monta o workbook. Exportada para permitir teste da planilha inteira sem subir
 * a function nem tocar em Supabase.
 */
export function buildExportXlsx(nome: string, recibos: ReciboRow[]) {
  const pagamentos: ReciboRow[] = [];
  const livroCaixa: ReciboRow[] = [];

  for (const recibo of recibos) {
    const secao = secaoDoRecibo(recibo);
    if (secao === "PAGAMENTOS_EFETUADOS") pagamentos.push(recibo);
    else if (secao === "LIVRO_CAIXA") livroCaixa.push(recibo);
  }

  // O periodo e o das linhas EXPORTADAS, nao o de todos os recibos: dizer
  // "janeiro a dezembro" num arquivo cuja primeira linha e de agosto faria o
  // contador procurar dado que nunca esteve la.
  const periodo = periodoCoberto([...pagamentos, ...livroCaixa]);

  const wb = XLSX.utils.book_new();
  wb.Props = {
    Title: "TaxMind - Export para revisão contábil",
    Author: "TaxMind",
  };

  XLSX.utils.book_append_sheet(
    wb,
    montarAba({
      nome,
      periodo,
      titulo: "Pagamentos Efetuados",
      notas: [NOTA_PAGAMENTOS],
      recibos: pagamentos,
    }),
    ABA_PAGAMENTOS,
  );

  XLSX.utils.book_append_sheet(
    wb,
    montarAba({
      nome,
      periodo,
      titulo: "Possíveis deduções via Livro-Caixa",
      notas: [NOTA_LIVRO_CAIXA, NOTA_TRANSPORTE_FORA],
      recibos: livroCaixa,
    }),
    ABA_LIVRO_CAIXA,
  );

  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });

  return {
    bytes: new Uint8Array(out as ArrayBuffer),
    totalPagamentos: pagamentos.length,
    totalLivroCaixa: livroCaixa.length,
  };
}

function montarAba(input: {
  nome: string;
  periodo: string;
  titulo: string;
  notas: string[];
  recibos: ReciboRow[];
}) {
  const linhas: unknown[][] = [
    ["Preparado para revisão contábil"],
    [input.nome],
    [`Período coberto: ${input.periodo}`],
    [input.titulo],
    [],
  ];

  // As notas ficam ACIMA do cabecalho de proposito. Como rodape elas some no
  // primeiro "ordenar por valor" que o contador aplicar, e a nota do
  // Livro-Caixa e a unica coisa que impede um assalariado de usar a aba.
  for (const nota of input.notas) {
    linhas.push([nota]);
  }
  linhas.push([]);

  const primeiraLinhaDados = linhas.length + 1; // 1-based, ja depois do cabecalho
  linhas.push([...CABECALHO_TABELA]);

  let totalBruto = 0;
  let totalReembolso = 0;
  let totalLiquido = 0;

  for (const recibo of input.recibos) {
    const bruto = Number(recibo.valor) || 0;
    const reembolso = recibo.valor_reembolsado === null ||
        recibo.valor_reembolsado === undefined
      ? null
      : Number(recibo.valor_reembolsado) || 0;
    const liquido = valorLiquido(recibo.valor, recibo.valor_reembolsado);

    totalBruto += bruto;
    totalReembolso += reembolso ?? 0;
    totalLiquido += liquido;

    linhas.push([
      dataDaDespesa(recibo),
      recibo.descricao ?? "",
      recibo.estabelecimento ?? "",
      recibo.documento_prestador ?? "",
      humanize(recibo.categoria),
      bruto,
      // null vira celula VAZIA, e 0 vira 0,00. A distincao e a mesma do dossie:
      // vazio e uma lacuna que o contador pode querer preencher, 0,00 e uma
      // resposta que o titular ja deu.
      reembolso,
      liquido,
      humanize(recibo.deducibilidade),
      humanize(recibo.status),
    ]);
  }

  if (input.recibos.length === 0) {
    linhas.push(["Nenhuma despesa desta natureza no período."]);
  } else {
    linhas.push([]);
    linhas.push([
      "TOTAL",
      "",
      "",
      "",
      `${input.recibos.length} lançamento(s)`,
      totalBruto,
      totalReembolso,
      totalLiquido,
      "",
      "",
    ]);
  }

  const sheet = XLSX.utils.aoa_to_sheet(linhas, { cellDates: true });
  aplicarFormatos(sheet, linhas, primeiraLinhaDados);
  sheet["!cols"] = [
    { wch: 11 }, // Data
    { wch: 34 }, // Descricao
    { wch: 26 }, // Estabelecimento
    { wch: 20 }, // CPF/CNPJ
    { wch: 18 }, // Categoria
    { wch: 15 }, // Valor bruto
    { wch: 14 }, // Reembolso
    { wch: 16 }, // Valor liquido
    { wch: 22 }, // Dedutibilidade
    { wch: 22 }, // Status
  ];
  // Congela tudo que esta acima da primeira linha de dados, cabecalho incluso:
  // com o bloco de notas no topo, rolar a tabela levaria embora justamente o
  // aviso do carne-leao.
  sheet["!freeze"] = { xSplit: 0, ySplit: primeiraLinhaDados };

  return sheet;
}

/**
 * Formato de exibicao das celulas.
 *
 * Aplicado depois de aoa_to_sheet e por INDICE de coluna, entao COLUNAS_MOEDA e
 * COLUNA_DATA precisam acompanhar CABECALHO_TABELA — ha teste amarrando os dois.
 * Sem isto o valor aparece como 350.5 em vez de R$ 350,50, e a data como um
 * numero de serie do Excel.
 */
function aplicarFormatos(
  sheet: XLSX.WorkSheet,
  linhas: unknown[][],
  primeiraLinhaDados: number,
) {
  for (let r = primeiraLinhaDados - 1; r < linhas.length; r += 1) {
    for (const c of COLUNAS_MOEDA) {
      const ref = XLSX.utils.encode_cell({ r, c });
      const celula = sheet[ref];
      if (celula && celula.t === "n") celula.z = '"R$" #,##0.00';
    }

    const refData = XLSX.utils.encode_cell({ r, c: COLUNA_DATA });
    const celulaData = sheet[refData];
    if (celulaData && celulaData.t === "d") celulaData.z = "dd/mm/yyyy";
  }
}

/**
 * Data da despesa, com o mesmo fallback do dossie: quando data_despesa e nula,
 * vale a data de recebimento da mensagem.
 */
function dataDaDespesa(recibo: ReciboRow): Date | string {
  const bruto = recibo.data_despesa ?? recibo.criado_em;
  // data_despesa e DATE ("2026-08-09") e criado_em e timestamptz. O sufixo
  // T12:00:00 no primeiro caso evita que o parse em UTC puxe a data um dia para
  // tras em Sao Paulo (UTC-3), que e o bug classico de data-sem-hora.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(bruto) ? `${bruto}T12:00:00` : bruto;
  const data = new Date(iso);
  return Number.isNaN(data.getTime()) ? "" : data;
}

function periodoCoberto(recibos: ReciboRow[]): string {
  const datas = recibos
    .map((r) => dataDaDespesa(r))
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime());

  if (datas.length === 0) return "sem lançamentos";

  const inicio = formatDate(datas[0]);
  const fim = formatDate(datas[datas.length - 1]);
  return inicio === fim ? inicio : `${inicio} a ${fim}`;
}

// O rotulo em portugues correto vive em _shared/rotulos.ts, junto com o da
// generate-dossier e o da followup-resolve: as tres rendiam o mesmo enum com a
// mesma receita ASCII e entregavam "Saude"/"Revisao humana" ao contador.
function humanize(value: string) {
  return rotuloTitulo(value);
}

function formatDate(date: Date) {
  return date.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
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
