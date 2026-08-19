// Complemento do resumo fiscal a partir da declaracao do ano anterior (Fase 17).
//
// POR QUE ISTO E UMA EDGE FUNCTION, E NAO CODIGO NO CODE NODE DO n8n
//
// O calculo de economia passa pelo motor real (irpf_calculo.ts +
// irpf_parametros.ts): tabela progressiva, redutor, teto do §1o e parametros
// por ano-calendario. O n8n nao importa arquivo do repositorio, entao a
// alternativa seria uma QUINTA copia viva daquele codigo dentro de um Code
// node — copia de um motor fiscal, que e justamente o tipo de coisa que nao
// pode derivar em silencio. Aqui ele e importado uma vez, do arquivo real.
//
// A function nao decide texto de produto: as duas frases vem de
// _shared/declaracao_anterior.ts, e as duas regras que as governam estao
// escritas la (pergunta nunca vira afirmacao; estimativa sempre com ressalva).
//
// Ela e ADITIVA por construcao: sem declaracao importada devolve lista vazia, e
// o resumo continua exatamente o que era antes desta fase.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { timingSafeEqual } from "../_shared/bootstrap_token.ts";
import {
  type CategoriaDeclaracao,
  complementoDoResumo,
  type TotalPorCategoria,
} from "../_shared/declaracao_anterior.ts";

type ResumoRequest = { usuario_id?: string };

const jsonHeaders = { "content-type": "application/json" };
const env = (name: string, fallback = "") => Deno.env.get(name) ?? fallback;

const supabase = createClient(
  env("SUPABASE_URL"),
  env("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

serve(async (request) => {
  try {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (!isServiceRoleCaller(request)) return json({ error: "unauthorized" }, 401);

    const body = await request.json() as ResumoRequest;
    const usuarioId = body?.usuario_id?.trim();
    if (!usuarioId) return json({ error: "missing_usuario_id" }, 400);

    // Fail open em tudo: o resumo e a resposta principal, e o complemento e
    // opcional. Erro aqui devolve lista vazia, nunca 500 — derrubar o resumo
    // inteiro por causa de uma linha extra seria trocar o essencial pelo
    // acessorio.
    const declaracao = await buscarDeclaracaoMaisRecente(usuarioId);
    if (!declaracao) return json({ linhas: [] as string[] });

    const totais = await buscarTotaisDoAno(usuarioId);

    // Dedutivel acumulado NO ANO CORRENTE. A RPC agrega o historico inteiro, e
    // a filtragem por ano acontece na consulta abaixo — comparar o acumulado de
    // varios anos com a declaracao de um ano so inflaria a estimativa.
    const totalDedutivel = totais.reduce((soma, l) => soma + Number(l.total_dedutivel || 0), 0);

    const linhas = complementoDoResumo(
      {
        ano_calendario: declaracao.ano_calendario,
        aliquota_efetiva: declaracao.aliquota_efetiva,
        rendimentos_tributaveis: declaracao.rendimentos_tributaveis,
        base_calculo: declaracao.base_calculo,
        categorias_pagamentos: declaracao.categorias_pagamentos,
      },
      totais,
      totalDedutivel,
    );

    return json({
      linhas,
      ano_base: declaracao.ano_calendario,
      total_dedutivel_ano_corrente: totalDedutivel,
    });
  } catch (error) {
    console.error("declaracao-resumo error", error);
    // Ate o catch devolve 200 com lista vazia: ver o comentario de fail open.
    return json({ linhas: [] as string[] });
  }
});

type DeclaracaoRow = {
  ano_calendario: number;
  aliquota_efetiva: number | null;
  rendimentos_tributaveis: number | null;
  base_calculo: number | null;
  categorias_pagamentos: CategoriaDeclaracao[];
};

/** A mais recente, e nao "a do ano passado": quem importou 2024 e 2025 quer a
 *  comparacao com a mais proxima, e quem importou so 2024 nao pode ficar sem
 *  nenhuma. */
async function buscarDeclaracaoMaisRecente(usuarioId: string): Promise<DeclaracaoRow | null> {
  const { data, error } = await supabase
    .from("declaracoes_anteriores")
    .select("ano_calendario, aliquota_efetiva, rendimentos_tributaveis, base_calculo, categorias_pagamentos")
    .eq("usuario_id", usuarioId)
    .order("ano_calendario", { ascending: false })
    .limit(1);

  if (error) {
    console.error("failed to lookup declaracao anterior", error);
    return null;
  }

  const linha = data?.[0];
  if (!linha) return null;

  return {
    ano_calendario: Number(linha.ano_calendario),
    aliquota_efetiva: linha.aliquota_efetiva === null ? null : Number(linha.aliquota_efetiva),
    rendimentos_tributaveis: linha.rendimentos_tributaveis === null
      ? null
      : Number(linha.rendimentos_tributaveis),
    base_calculo: linha.base_calculo === null ? null : Number(linha.base_calculo),
    categorias_pagamentos: (linha.categorias_pagamentos ?? []) as CategoriaDeclaracao[],
  };
}

/**
 * Totais por categoria do ANO CORRENTE.
 *
 * Nao usa resumo_fiscal_usuario porque aquela RPC agrega o historico inteiro, e
 * aqui a janela precisa ser o ano em curso — e a comparacao "ano passado x este
 * ano" que da sentido tanto a estimativa quanto a pergunta.
 *
 * O ano corrente e o de America/Sao_Paulo, e nao o de UTC: em 31 de dezembro as
 * 22h ja seria o ano seguinte em UTC, e o resumo trocaria de janela antes da
 * virada para quem esta olhando.
 */
async function buscarTotaisDoAno(usuarioId: string): Promise<TotalPorCategoria[]> {
  const anoCorrente = Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric" })
      .format(new Date()),
  );

  const { data, error } = await supabase
    .from("recibos_evidencias")
    .select("categoria, valor, valor_reembolsado, deducibilidade, data_despesa, criado_em")
    .eq("usuario_id", usuarioId)
    .gte("data_despesa", `${anoCorrente}-01-01`)
    .lte("data_despesa", `${anoCorrente}-12-31`);

  if (error) {
    console.error("failed to aggregate recibos do ano", error);
    return [];
  }

  const porCategoria = new Map<string, TotalPorCategoria>();
  for (const linha of data ?? []) {
    const categoria = String(linha.categoria ?? "OUTROS").toUpperCase();
    const atual = porCategoria.get(categoria) ??
      { categoria, total: 0, total_dedutivel: 0 };

    const valor = Number(linha.valor) || 0;
    atual.total += valor;

    // Mesma regra do resumo_fiscal_usuario e do dossie: so DEDUTIVEL entra, e
    // entra pelo liquido do reembolso. Somar o bruto superestimaria a deducao,
    // que e o gatilho de malha fina que o cruzamento com a DMED procura.
    if (linha.deducibilidade === "DEDUTIVEL") {
      atual.total_dedutivel += valor - (Number(linha.valor_reembolsado) || 0);
    }

    porCategoria.set(categoria, atual);
  }

  return [...porCategoria.values()];
}

function isServiceRoleCaller(request: Request) {
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) {
    console.error("SUPABASE_SERVICE_ROLE_KEY not configured; refusing request");
    return false;
  }
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  return timingSafeEqual(token, serviceRoleKey);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}
