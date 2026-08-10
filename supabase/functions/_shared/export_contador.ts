// Classificacao das despesas nas secoes do export estruturado para o contador.
//
// POR QUE ESTE MODULO EXISTE SEPARADO DA FUNCTION
//
// A regra fiscal aqui e a parte que erra caro e a parte que nao precisa de
// rede: dado um recibo, em que secao ele entra. Manter isso fora do
// index.ts permite testar a tabela inteira de categorias sem subir a function,
// sem Supabase e sem gerar xlsx.
//
// O QUE ESTE ARQUIVO NAO E
//
// Nao e uma segunda opiniao sobre dedutibilidade. Quem julga dedutibilidade e o
// prompt fiscal, e o resultado ja esta gravado em recibos_evidencias.
// deducibilidade. Este modulo so decide ONDE a linha aparece no arquivo, a
// partir da categoria e — nas categorias pessoais — do julgamento que a IA ja
// fez. Nada aqui promove nem rebaixa despesa.
//
// O ENUM REAL
//
// Conferido em supabase/migrations/001_init_taxmind_schema.sql:4-17, e nao
// assumido. Os doze membros estao cobertos abaixo, e ha teste que falha se a
// migration ganhar um decimo terceiro sem passar por aqui.

/** Os dois mecanismos de deducao do IRPF que o export separa.
 *
 *  Eles NAO sao graus da mesma coisa, e por isso o arquivo tem duas abas em vez
 *  de uma lista com coluna "tipo": "Pagamentos Efetuados" vale para qualquer
 *  contribuinte, e Livro-Caixa so vale para quem tem renda nao assalariada
 *  sujeita ao carne-leao. Misturar os dois num relatorio unico convida a somar
 *  um total que nao existe para ninguem. */
export type SecaoExport = "PAGAMENTOS_EFETUADOS" | "LIVRO_CAIXA";

/** Ficha "Pagamentos Efetuados" — deducao pessoal universal.
 *
 *  Sao exatamente os dois membros do enum que pertencem a essa ficha. */
export const CATEGORIAS_PAGAMENTOS_EFETUADOS = [
  "SAUDE",
  "EDUCACAO",
] as const;

/** Categorias cuja natureza JA e profissional: entram no Livro-Caixa pela
 *  categoria, sem depender do julgamento de dedutibilidade.
 *
 *  IMPOSTOS_TAXAS entrou aqui depois de conferir o proprio prompt fiscal, que
 *  manda classificar "conselhos profissionais" nessa categoria
 *  (_shared/prompt_fiscal.ts, secao 8). Anuidade de CRM/CRO/OAB e contribuicao
 *  a sindicato de classe sao despesa de custeio classica do livro-caixa, entao
 *  deixar a categoria fora do export apagaria uma deducao real do material de
 *  trabalho do contador. O bucket e reconhecidamente heterogeneo — taxa
 *  bancaria pessoal e multa caem nele tambem — e e por isso que a aba carrega a
 *  nota de conferir com o contador. */
export const CATEGORIAS_LIVRO_CAIXA = [
  "ESCRITORIO",
  "EQUIPAMENTOS",
  "SOFTWARE",
  "INTERNET_TELEFONIA",
  "SERVICOS_PROFISSIONAIS",
  "IMPOSTOS_TAXAS",
] as const;

/** Categorias normalmente pessoais que ainda assim podem carregar despesa
 *  profissional, e por isso passam por um segundo teste em vez de serem
 *  descartadas pela categoria.
 *
 *  O caso concreto e aluguel de consultorio e rateio de home office: o prompt
 *  fiscal lista "aluguel de consultorio, luz" entre os exemplos de livro-caixa
 *  (secao 3) e manda marcar home office como PARCIALMENTE_DEDUTIVEL (secao 6),
 *  mas a categoria gravada nessas linhas e MORADIA. Um filtro so por categoria
 *  descartaria exatamente a despesa que a regra manda deduzir.
 *
 *  OUTROS esta na lista por um motivo diferente e mais chato: e o DEFAULT da
 *  coluna categoria (001:92). Toda linha cuja classificacao falhou cai nele,
 *  inclusive despesa profissional legitima.
 *
 *  TRANSPORTE de proposito NAO esta aqui — ver CATEGORIAS_SEMPRE_FORA. */
export const CATEGORIAS_PESSOAIS_COM_NEXO = [
  "MORADIA",
  "ALIMENTACAO",
  "OUTROS",
] as const;

/** Categorias que nunca entram, nem com nexo profissional declarado.
 *
 *  TRANSPORTE nao esta fora por ser "pouco dedutivel na pratica": esta fora por
 *  vedacao expressa. O art. 68 do RIR/2018 exclui despesa de locomocao e
 *  transporte do livro-caixa, com uma unica excecao — representante comercial
 *  autonomo, quando o onus for dele. O TaxMind nao registra profissao, entao
 *  nao tem como identificar a excecao, e incluir a categoria ofereceria ao
 *  contador uma deducao vedada para quase todo titular.
 *
 *  A aba de Livro-Caixa diz explicitamente que transporte ficou de fora e por
 *  que: silencio faria o contador achar que o titular nao teve a despesa, e
 *  para o representante comercial — o unico que poderia deduzi-la — a omissao
 *  sem aviso seria uma deducao perdida. */
export const CATEGORIAS_SEMPRE_FORA = ["TRANSPORTE"] as const;

/** Julgamentos de dedutibilidade que liberam uma categoria pessoal para o
 *  Livro-Caixa. INDETERMINADO nao entra: e a ausencia de julgamento, e promover
 *  por ausencia levaria toda conta de luz residencial para o arquivo. */
export const DEDUCIBILIDADES_COM_NEXO = [
  "DEDUTIVEL",
  "PARCIALMENTE_DEDUTIVEL",
] as const;

/** Status de processamento que nunca vao para o contador.
 *
 *  REJEITADO e ARQUIVADO sao decisoes ja tomadas de que a linha nao vale como
 *  evidencia; reapresenta-las como material de trabalho desfaria a decisao. */
export const STATUS_FORA_DO_EXPORT = ["REJEITADO", "ARQUIVADO"] as const;

export type ReciboExportavel = {
  categoria: string;
  deducibilidade: string;
  status: string;
};

/**
 * Em qual secao esta despesa entra, ou null quando ela fica fora do export.
 *
 * A ordem dos testes importa e nao e arbitraria:
 *   1. status descartado vence tudo — linha rejeitada nao vira material;
 *   2. vedacao legal (TRANSPORTE) vence o nexo declarado, porque o nexo nao
 *      derruba o art. 68;
 *   3. as duas listas por categoria;
 *   4. o escape das categorias pessoais, que e o unico teste que olha
 *      dedutibilidade.
 */
export function secaoDoRecibo(recibo: ReciboExportavel): SecaoExport | null {
  const categoria = (recibo.categoria ?? "").toUpperCase();
  const deducibilidade = (recibo.deducibilidade ?? "").toUpperCase();
  const status = (recibo.status ?? "").toUpperCase();

  if (contem(STATUS_FORA_DO_EXPORT, status)) return null;
  if (contem(CATEGORIAS_SEMPRE_FORA, categoria)) return null;
  if (contem(CATEGORIAS_PAGAMENTOS_EFETUADOS, categoria)) return "PAGAMENTOS_EFETUADOS";
  if (contem(CATEGORIAS_LIVRO_CAIXA, categoria)) return "LIVRO_CAIXA";

  if (
    contem(CATEGORIAS_PESSOAIS_COM_NEXO, categoria) &&
    contem(DEDUCIBILIDADES_COM_NEXO, deducibilidade)
  ) {
    return "LIVRO_CAIXA";
  }

  return null;
}

/**
 * Valor que o contador pode considerar, ja liquido do reembolso.
 *
 * NULL e 0 continuam sendo estados diferentes na coluna (migration 010), e essa
 * diferenca importa na EXIBICAO — celula vazia contra 0,00 — mas nao no
 * calculo: nos dois casos nada foi devolvido, entao o liquido e o bruto.
 */
export function valorLiquido(
  valor: number | string,
  valorReembolsado: number | string | null | undefined,
): number {
  const bruto = Number(valor) || 0;
  const reembolso = valorReembolsado === null || valorReembolsado === undefined
    ? 0
    : Number(valorReembolsado) || 0;
  return bruto - reembolso;
}

function contem(lista: readonly string[], valor: string) {
  return lista.includes(valor);
}
