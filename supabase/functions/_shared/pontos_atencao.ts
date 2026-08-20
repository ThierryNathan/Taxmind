// Pontos de atencao antes de declarar (Fase 18).
//
// O QUE ISTO E, E O QUE NAO E
//
// NAO e preditor de malha fina. O algoritmo de selecao da Receita e
// confidencial e o TaxMind nao tem acesso a ele. O que existe aqui e uma camada
// de APRESENTACAO sobre sinais que o sistema ja gravou, escolhidos por serem
// causas conhecidas e documentadas de pedido de comprovacao.
//
// Tres regras de linguagem que nao podem ser afrouxadas, e que tem teste:
//   1. nunca um percentual, uma probabilidade ou um "risco de X";
//   2. nunca afirmar que o sistema preve ou detecta fiscalizacao;
//   3. a ressalva de que isto nao e previsao acompanha o bloco SEMPRE, e nao
//      so quando a lista fica grande.
//
// Nada neste modulo reclassifica, promove ou rebaixa despesa. Ele nao escreve
// no banco e nao chama IA: le contagens e escreve texto.
//
// DIVISAO DE TRABALHO COM O SQL
//
// A migration 012 conta as linhas (e onde o dado esta, e o volume pode passar
// de mil linhas por ano num usuario de Open Finance). Aqui ficam os limiares e
// o texto — as partes que sao juizo de produto, e que precisam ser testaveis
// sem banco.
//
// POR QUE ESTE MODULO NAO IMPORTA NADA
//
// Ele e importado pela export-contador, que so precisa das marcas por item. A
// comparacao ano a ano mora em _shared/declaracao_anterior.ts, junto das outras
// comparacoes com a declaracao — e nao aqui — porque aquele modulo arrasta o
// motor de IRPF e o modulo de follow-up para dentro do bundle de quem o
// importa. Com a comparacao aqui, a planilha do contador passaria a carregar a
// tabela progressiva do IRPF e a precisar de redeploy a cada mudanca de
// parametro fiscal, que e exatamente o tipo de dependencia invisivel do
// incidente de docs/09.
//
// O ponto de encontro e `linhasPontosAtencao(contagens, itensExtras)`: quem
// tiver a declaracao em maos renderiza os itens la e passa os textos para ca.

/**
 * Dias em REVISAO_HUMANA a partir dos quais o lancamento vira ponto de atencao.
 *
 * 30 dias nao e numero redondo: e o ciclo mensal do carne-leao (DARF ate o
 * ultimo dia util do mes seguinte) e da escrituracao do livro-caixa. Um
 * lancamento parado alem disso atravessou o fechamento do mes em que o
 * tratamento dele importava.
 *
 * Medido no banco real em 19/08/2026, com 28 linhas em revisao nos tres
 * usuarios: 30 dias marca 0 (a mais antiga tinha 21 dias), 14 dias marcaria
 * 5/2/3 e 7 dias marcaria 17/2/8 — no ultimo caso, quase tudo que esta em
 * revisao, que e ruido e nao sinal.
 */
export const DIAS_REVISAO_PARADA = 30;

export type ContagensAtencao = {
  ano_referencia: number;
  sem_identificacao: number;
  saude_sem_reembolso: number;
  uso_misto: number;
  revisao_parada: number;
  revisao_parada_desde: string | null;
  totais_categoria: Array<{ categoria: string; total_dedutivel: number | string }>;
};

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------

export const TITULO_BLOCO = "⚠️ *Pontos de atenção antes de declarar*";

/**
 * A ressalva. Ela acompanha o bloco SEMPRE.
 *
 * O produto nao tem acesso ao algoritmo da Receita e nao pode sugerir que tem.
 * "Causas conhecidas de pedido de comprovacao" e o que se pode afirmar; "risco
 * de malha fina" — como numero, probabilidade ou promessa — nao e.
 *
 * O fecho aponta para o export do contador porque e la que cada item aparece
 * marcado (coluna "Pontos de atenção"). Apontar para o dossie duplicaria a
 * chamada que o proprio resumo ja faz na ultima linha.
 */
export const RESSALVA_BLOCO =
  "Isso não é previsão de fiscalização: são causas conhecidas de pedido de comprovação. " +
  "Cada item aparece marcado em *exportar para contador*.";

function plural(n: number, singular: string, pluralForma: string): string {
  return n === 1 ? singular : pluralForma;
}

/**
 * O bloco do resumo.
 *
 * Devolve lista vazia quando nao ha nada — e nao um "está tudo certo". O sistema
 * ve o que recebeu, e uma confirmacao de conformidade seria uma garantia que ele
 * nao tem como dar. Alem disso, o resumo sem pontos de atencao continua byte a
 * byte o de antes desta fase, que e a mesma aditividade do complemento da
 * declaracao.
 */
export function linhasPontosAtencao(
  contagens: ContagensAtencao | null,
  /** Itens ja redigidos por quem conhece a declaracao anterior — hoje, a
   *  comparacao ano a ano de _shared/declaracao_anterior.ts. Chegam SEM o
   *  marcador de lista: quem monta o bloco e daqui. */
  itensExtras: string[] = [],
): string[] {
  if (!contagens) return [];

  const itens: string[] = [];

  if (contagens.sem_identificacao > 0) {
    const n = contagens.sem_identificacao;
    itens.push(
      `• ${n} ${plural(n, "lançamento", "lançamentos")} sem CNPJ e sem estabelecimento ` +
        `${plural(n, "identificado", "identificados")}`,
    );
  }

  if (contagens.saude_sem_reembolso > 0) {
    const n = contagens.saude_sem_reembolso;
    itens.push(
      `• ${n} ${plural(n, "despesa de saúde", "despesas de saúde")} sem confirmação de ` +
        "reembolso do plano",
    );
  }

  if (contagens.uso_misto > 0) {
    const n = contagens.uso_misto;
    itens.push(
      `• ${n} ${plural(n, "lançamento", "lançamentos")} de uso misto ` +
        `${plural(n, "aguarda", "aguardam")} a definição do percentual profissional ` +
        "com seu contador",
    );
  }

  if (contagens.revisao_parada > 0) {
    const n = contagens.revisao_parada;
    itens.push(
      `• ${n} ${plural(n, "lançamento", "lançamentos")} em revisão há mais de ` +
        `${DIAS_REVISAO_PARADA} dias`,
    );
  }

  for (const extra of itensExtras) {
    if (extra && extra.trim()) itens.push(`• ${extra.trim()}`);
  }

  if (itens.length === 0) return [];

  return [TITULO_BLOCO + "\n" + itens.join("\n"), RESSALVA_BLOCO];
}

// ---------------------------------------------------------------------------
// Por item
// ---------------------------------------------------------------------------

export type ReciboParaAtencao = {
  categoria?: string | null;
  deducibilidade?: string | null;
  status?: string | null;
  documento_prestador?: string | null;
  estabelecimento?: string | null;
  valor_reembolsado?: number | string | null;
  revisado_em?: string | null;
  criado_em?: string | null;
};

export const MARCA_SEM_IDENTIFICACAO = "sem identificação do prestador";
export const MARCA_REEMBOLSO_ABERTO = "reembolso não confirmado";
export const MARCA_USO_MISTO = "uso misto sem percentual definido";
export const MARCA_REVISAO_PARADA = `em revisão há mais de ${DIAS_REVISAO_PARADA} dias`;

/**
 * As marcas de UMA linha, para a coluna do export do contador.
 *
 * Mesmas quatro condicoes da migration 012, na mesma ordem, e sem a janela do
 * ano: aqui a linha ja foi escolhida pelo export, e o periodo coberto e o do
 * arquivo. O salto ano a ano nao aparece por item de proposito — ele e uma
 * propriedade da CATEGORIA no ano, e marcar cada linha dela sugeriria que
 * aquele lancamento especifico e o problema.
 */
export function pontosAtencaoDoRecibo(
  recibo: ReciboParaAtencao,
  agora: Date = new Date(),
): string[] {
  const categoria = (recibo.categoria ?? "").toUpperCase();
  const deducibilidade = (recibo.deducibilidade ?? "").toUpperCase();
  const status = (recibo.status ?? "").toUpperCase();
  const marcas: string[] = [];

  const vazio = (v: string | null | undefined) => String(v ?? "").trim() === "";

  if (
    ["DEDUTIVEL", "INDETERMINADO"].includes(deducibilidade) &&
    vazio(recibo.documento_prestador) && vazio(recibo.estabelecimento)
  ) {
    marcas.push(MARCA_SEM_IDENTIFICACAO);
  }

  if (
    categoria === "SAUDE" &&
    (recibo.valor_reembolsado === null || recibo.valor_reembolsado === undefined) &&
    deducibilidade !== "NAO_DEDUTIVEL"
  ) {
    marcas.push(MARCA_REEMBOLSO_ABERTO);
  }

  if (deducibilidade === "PARCIALMENTE_DEDUTIVEL") {
    marcas.push(MARCA_USO_MISTO);
  }

  if (status === "REVISAO_HUMANA" && !recibo.revisado_em && recibo.criado_em) {
    const criado = new Date(recibo.criado_em);
    if (!Number.isNaN(criado.getTime())) {
      const dias = (agora.getTime() - criado.getTime()) / 86_400_000;
      if (dias > DIAS_REVISAO_PARADA) marcas.push(MARCA_REVISAO_PARADA);
    }
  }

  return marcas;
}

/** Conteudo da celula: as marcas de uma linha, ou vazio. */
export function celulaPontosAtencao(
  recibo: ReciboParaAtencao,
  agora: Date = new Date(),
): string {
  return pontosAtencaoDoRecibo(recibo, agora).join("; ");
}
