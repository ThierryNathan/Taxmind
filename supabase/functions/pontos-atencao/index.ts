// Pontos de atencao antes de declarar (Fase 18).
//
// NAO E PREDITOR DE MALHA FINA. O algoritmo de selecao da Receita e
// confidencial e o TaxMind nao tem acesso a ele. Esta function agrega sinais
// que o sistema JA gravou — todos causas conhecidas de pedido de comprovacao —
// e devolve as linhas de texto que o resumo acrescenta. As regras de linguagem
// (sem percentual, sem probabilidade, ressalva sempre presente) estao escritas
// em _shared/pontos_atencao.ts, junto do texto.
//
// POR QUE FUNCTION PROPRIA, E NAO UM PEDACO DA declaracao-resumo
//
// A declaracao-resumo tem uma invariante testada: sem declaracao importada, o
// resumo e byte a byte o de antes daquela fase. Pontos de atencao precisam
// funcionar SEM declaracao nenhuma — que e o caso da maioria dos usuarios —,
// entao dobrar as duas coisas na mesma function transformaria aquela invariante
// numa condicao ambigua. Separadas, cada uma falha sozinha e o resumo sobrevive
// as duas.
//
// ELA NAO ESCREVE NADA. Nao reclassifica, nao promove, nao abre pendencia, nao
// chama IA. Le contagens e devolve texto.
//
// FAIL OPEN EM TUDO: erro aqui devolve lista vazia, nunca 500. O resumo e a
// resposta principal; derrubar o resumo inteiro por causa de um bloco acessorio
// seria trocar o essencial pelo acessorio — mesma postura da declaracao-resumo.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { timingSafeEqual } from "../_shared/bootstrap_token.ts";
// A comparacao ano a ano vive junto das outras comparacoes com a declaracao, e
// nao em pontos_atencao.ts: aquele modulo e importado pela export-contador, e
// este aqui arrasta o motor de IRPF para o bundle de quem o importa.
import {
  type BaselineDeclaracao,
  type CategoriaDeclaracao,
  itensDeSaltoAnoAAno,
} from "../_shared/declaracao_anterior.ts";
import {
  type ContagensAtencao,
  DIAS_REVISAO_PARADA,
  linhasPontosAtencao,
} from "../_shared/pontos_atencao.ts";

type AtencaoRequest = { usuario_id?: string; dias_revisao?: number };

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

    const body = await request.json() as AtencaoRequest;
    const usuarioId = body?.usuario_id?.trim();
    if (!usuarioId) return json({ error: "missing_usuario_id" }, 400);

    const dias = Number.isInteger(body?.dias_revisao) && (body!.dias_revisao as number) > 0
      ? body!.dias_revisao as number
      : DIAS_REVISAO_PARADA;

    const contagens = await buscarContagens(usuarioId, dias);
    if (!contagens) return json({ linhas: [] as string[] });

    // A declaracao so e buscada quando ha dedutivel em alguma categoria: sem
    // isso nao existe salto possivel, e a consulta seria pura perda.
    const baseline = contagens.totais_categoria.length > 0
      ? await buscarBaseline(usuarioId)
      : null;

    const linhas = linhasPontosAtencao(
      contagens,
      itensDeSaltoAnoAAno(baseline, contagens.totais_categoria),
    );

    return json({
      linhas,
      ano_referencia: contagens.ano_referencia,
      // O n8n nao usa estes campos hoje; eles existem para a execucao ficar
      // auditavel no log sem precisar refazer a consulta a mao.
      contagens: {
        sem_identificacao: contagens.sem_identificacao,
        saude_sem_reembolso: contagens.saude_sem_reembolso,
        uso_misto: contagens.uso_misto,
        revisao_parada: contagens.revisao_parada,
      },
    });
  } catch (error) {
    console.error("pontos-atencao error", error);
    // Ate o catch devolve 200 com lista vazia: ver o comentario de fail open.
    return json({ linhas: [] as string[] });
  }
});

async function buscarContagens(
  usuarioId: string,
  diasRevisao: number,
): Promise<ContagensAtencao | null> {
  const { data, error } = await supabase.rpc("pontos_atencao_usuario", {
    p_usuario_id: usuarioId,
    p_dias_revisao: diasRevisao,
  });

  if (error) {
    console.error("failed to aggregate pontos de atencao", error);
    return null;
  }

  // A funcao SQL devolve uma linha; o PostgREST entrega array.
  const linha = Array.isArray(data) ? data[0] : data;
  if (!linha) return null;

  return {
    ano_referencia: Number(linha.ano_referencia),
    sem_identificacao: Number(linha.sem_identificacao) || 0,
    saude_sem_reembolso: Number(linha.saude_sem_reembolso) || 0,
    uso_misto: Number(linha.uso_misto) || 0,
    revisao_parada: Number(linha.revisao_parada) || 0,
    revisao_parada_desde: linha.revisao_parada_desde ?? null,
    totais_categoria: Array.isArray(linha.totais_categoria) ? linha.totais_categoria : [],
  };
}

/** A declaracao mais recente, e nao "a do ano passado": mesma escolha da
 *  declaracao-resumo, e pelo mesmo motivo — quem importou 2024 e 2025 quer a
 *  comparacao com a mais proxima, e quem so importou 2024 nao pode ficar sem
 *  nenhuma. */
async function buscarBaseline(usuarioId: string): Promise<BaselineDeclaracao | null> {
  const { data, error } = await supabase
    .from("declaracoes_anteriores")
    .select("ano_calendario, categorias_pagamentos, pagamentos_detalhados, rendimentos_tributaveis, base_calculo")
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
    categorias_pagamentos: (linha.categorias_pagamentos ?? []) as CategoriaDeclaracao[],
    pagamentos_detalhados: Array.isArray(linha.pagamentos_detalhados)
      ? linha.pagamentos_detalhados
      : [],
    rendimentos_tributaveis: linha.rendimentos_tributaveis === null
      ? null
      : Number(linha.rendimentos_tributaveis),
    base_calculo: linha.base_calculo === null ? null : Number(linha.base_calculo),
  };
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
