// Rotulos em portugues correto para os valores de enum que aparecem na tela.
//
// POR QUE ESTE MODULO EXISTE
//
// Tres componentes rendiam o enum direto para o usuario com a mesma receita —
// minusculas e underscore virando espaco (`humanize` na generate-dossier e na
// export-contador, `humanizar` na followup-resolve, e o espelho no Code node
// "Formatar Resumo" do n8n). Como os valores do enum sao ASCII por serem
// identificadores de banco (SAUDE, REVISAO_HUMANA, PARCIALMENTE_DEDUTIVEL), o
// texto entregue saia sem acento nenhum: "Saude", "Revisao humana",
// "parcialmente dedutivel". O identificador nao muda; o que muda e a traducao
// dele para leitura humana, que agora mora num lugar so.
//
// O mapa cobre os tres enums da migration 001 que chegam ao usuario:
// categoria_fiscal, status_deducibilidade e status_processamento. Ha teste que
// le a migration e falha se um membro novo nao tiver rotulo aqui — sem isso, o
// membro novo cairia no fallback e ninguem perceberia.
//
// O fallback e exatamente o comportamento antigo (minusculas, underscore vira
// espaco): valor desconhecido continua legivel, so que sem acento.

/** Forma minuscula, para encaixar no meio de uma frase ("fica classificada como
 *  parcialmente dedutível"). A forma de titulo sai de `rotuloTitulo`. */
export const ROTULOS_ENUM: Readonly<Record<string, string>> = {
  // categoria_fiscal
  SAUDE: "saúde",
  EDUCACAO: "educação",
  ALIMENTACAO: "alimentação",
  TRANSPORTE: "transporte",
  MORADIA: "moradia",
  ESCRITORIO: "escritório",
  EQUIPAMENTOS: "equipamentos",
  SOFTWARE: "software",
  // "internet telefonia" e o texto que ja era entregue. Trocar por "internet e
  // telefonia" seria melhoria de redacao, e esta varredura corrige ortografia.
  INTERNET_TELEFONIA: "internet telefonia",
  SERVICOS_PROFISSIONAIS: "serviços profissionais",
  IMPOSTOS_TAXAS: "impostos taxas",
  OUTROS: "outros",

  // status_deducibilidade
  DEDUTIVEL: "dedutível",
  NAO_DEDUTIVEL: "não dedutível",
  PARCIALMENTE_DEDUTIVEL: "parcialmente dedutível",
  INDETERMINADO: "indeterminado",

  // status_processamento
  RECEBIDO: "recebido",
  PROCESSANDO: "processando",
  APROVADO_AUTOMATICAMENTE: "aprovado automaticamente",
  REVISAO_HUMANA: "revisão humana",
  REJEITADO: "rejeitado",
  ARQUIVADO: "arquivado",
};

/** Rotulo minusculo. Fallback identico ao comportamento anterior. */
export function rotuloEnum(valor: string | null | undefined): string {
  if (!valor) return "";
  return ROTULOS_ENUM[valor.toUpperCase()] ?? valor.toLowerCase().replaceAll("_", " ");
}

/** Rotulo com a primeira letra maiuscula, para celula de tabela e coluna de
 *  planilha. Mesma capitalizacao que o `humanize` antigo produzia. */
export function rotuloTitulo(valor: string | null | undefined): string {
  const rotulo = rotuloEnum(valor);
  if (!rotulo) return "";
  return rotulo.charAt(0).toUpperCase() + rotulo.slice(1);
}
