// Logica pura do follow-up conversacional (Fase 13).
//
// Mesma razao de _shared/verificacao.ts existir: o index.ts das functions chama
// serve() no topo, entao importar aquele arquivo num teste subiria um servidor.
// Aqui ficam so funcoes deterministicas — validacao de CNPJ/CPF, extracao da
// resposta, janela de expiracao, texto da pergunta — exercitadas por
// tests/followup_test.ts. O I/O fica nas functions.
//
// Principio que atravessa o arquivo inteiro: o follow-up e OPCIONAL. Toda
// duvida se resolve a favor de "isto e uma mensagem nova", porque tratar um
// lancamento legitimo como resposta a pergunta e um estrago visivel, e deixar
// uma pendencia expirar nao e.

/** Tempo de vida da pendencia. Ritmo de conversa de WhatsApp: da para procurar
 *  o recibo na gaveta, e e curto o bastante para nao colar numa conversa de
 *  outro assunto meia hora depois. */
export const FOLLOWUP_TTL_MINUTOS = 30;

/** Quantas mensagens seguintes ainda podem ser consideradas resposta. A
 *  proxima mensagem e o lugar natural da resposta; passadas duas, o assunto
 *  mudou. */
export const FOLLOWUP_MENSAGENS_TOLERADAS = 2;

/** Campos estruturados e objetivamente respondiveis. Ambiguidade de categoria
 *  fiscal nao entra aqui: aquilo e decisao de contador, nao dado que falta. */
export const CAMPOS_FOLLOWUP = ["documento_prestador", "estabelecimento"] as const;
export type CampoFollowup = typeof CAMPOS_FOLLOWUP[number];

export function campoRespondivel(campo: unknown): campo is CampoFollowup {
  return typeof campo === "string" && (CAMPOS_FOLLOWUP as readonly string[]).includes(campo);
}

const MS_POR_MINUTO = 60 * 1000;

export function calcularExpiracaoFollowup(agora: Date = new Date()): Date {
  return new Date(agora.getTime() + FOLLOWUP_TTL_MINUTOS * MS_POR_MINUTO);
}

export function followupExpirado(
  expiraEm: string | Date | null | undefined,
  agora: Date = new Date(),
): boolean {
  if (!expiraEm) return true;

  const limite = expiraEm instanceof Date ? expiraEm : new Date(expiraEm);
  const instante = limite.getTime();
  if (Number.isNaN(instante)) return true;

  return agora.getTime() >= instante;
}

/**
 * Pergunta anexada a mensagem de confirmacao.
 *
 * Curta e com o objetivo explicito ("para confirmar se e dedutivel"), porque a
 * pessoa precisa saber que ignorar nao quebra nada — o lancamento ja existe.
 */
export function perguntaParaCampo(
  campo: CampoFollowup,
  contexto: { estabelecimento?: string | null } = {},
): string {
  if (campo === "documento_prestador") {
    const onde = contexto.estabelecimento?.trim();
    return onde
      ? `Para confirmar se e dedutivel, voce tem o CNPJ ou CPF de ${onde}?`
      : "Para confirmar se e dedutivel, voce tem o CNPJ ou CPF do prestador?";
  }
  return "Para confirmar se e dedutivel, onde foi essa despesa? Pode me dizer o nome do estabelecimento.";
}

/**
 * A mensagem responde a pergunta pendente?
 *
 * So `documento_prestador` tem resposta reconhecivel sem IA: CNPJ e CPF tem
 * digito verificador, entao da para afirmar que a mensagem e um documento e nao
 * um valor. `estabelecimento` e texto livre — tentar adivinhar ali roubaria
 * lancamentos novos ("mercado 50 reais" e nome de lugar ou despesa?), entao ele
 * cai de proposito no caminho de reclassificacao, que enxerga a intencao.
 *
 * Devolve o documento so em digitos, ou null.
 */
export function extrairRespostaDeCampo(
  campo: CampoFollowup,
  texto: string | null | undefined,
): string | null {
  if (campo !== "documento_prestador") return null;
  return extrairDocumento(texto);
}

// Prefixos que a pessoa naturalmente escreve antes do numero. Qualquer outra
// palavra na mensagem faz a extracao recusar: "paguei 12345678000190 no
// mercado" nao e resposta, e trata-la como tal apagaria uma despesa.
const PREFIXOS_ACEITOS = [
  "cnpj",
  "cpf",
  "e",
  "eo",
  "ea",
  "o",
  "a",
  "seguem",
  "segue",
  "ta",
  "ai",
  "aqui",
  "esta",
  "numero",
  "doc",
  "documento",
];

export function extrairDocumento(texto: string | null | undefined): string | null {
  if (!texto) return null;

  const semAcento = texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

  // Separadores de documento (ponto, barra, hifen) somem; o resto do texto
  // precisa sobrar limpo para a checagem de palavras.
  const semPontuacao = semAcento.replace(/[.\-/\\:,]/g, " ").replace(/\s+/g, " ").trim();
  const palavras = semPontuacao.split(" ").filter(Boolean);

  const digitos: string[] = [];
  const outras: string[] = [];
  for (const palavra of palavras) {
    if (/^\d+$/.test(palavra)) digitos.push(palavra);
    else outras.push(palavra);
  }

  if (outras.some((palavra) => !PREFIXOS_ACEITOS.includes(palavra))) return null;

  const numero = digitos.join("");
  if (!numero) return null;

  if (numero.length === 14 && cnpjValido(numero)) return numero;
  if (numero.length === 11 && cpfValido(numero)) return numero;
  return null;
}

/**
 * CNPJ com digito verificador conferido, e nao so 14 digitos.
 *
 * A checagem importa aqui mais do que de costume: e ela que separa "documento"
 * de "sequencia numerica qualquer" e evita que um numero solto vire resposta.
 */
export function cnpjValido(valor: string): boolean {
  const numero = valor.replace(/\D/g, "");
  if (numero.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(numero)) return false;

  const digito = (tamanho: number) => {
    let soma = 0;
    let peso = tamanho - 7;
    for (let i = 0; i < tamanho; i += 1) {
      soma += Number(numero[i]) * peso;
      peso -= 1;
      if (peso < 2) peso = 9;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  return digito(12) === Number(numero[12]) && digito(13) === Number(numero[13]);
}

export function cpfValido(valor: string): boolean {
  const numero = valor.replace(/\D/g, "");
  if (numero.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(numero)) return false;

  const digito = (tamanho: number) => {
    let soma = 0;
    for (let i = 0; i < tamanho; i += 1) {
      soma += Number(numero[i]) * (tamanho + 1 - i);
    }
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  return digito(9) === Number(numero[9]) && digito(10) === Number(numero[10]);
}

/** Formata CNPJ/CPF para exibicao. O banco guarda como veio da IA; a mensagem
 *  ao usuario mostra mascarado para ele reconhecer o que gravamos. */
export function formatarDocumento(numero: string): string {
  if (numero.length === 14) {
    return `${numero.slice(0, 2)}.${numero.slice(2, 5)}.${numero.slice(5, 8)}/` +
      `${numero.slice(8, 12)}-${numero.slice(12)}`;
  }
  if (numero.length === 11) {
    return `${numero.slice(0, 3)}.${numero.slice(3, 6)}.${numero.slice(6, 9)}-${numero.slice(9)}`;
  }
  return numero;
}

/**
 * Contexto da reclassificacao por evidencia nova em texto livre.
 *
 * Vive aqui, e nao dentro da function, para poder ser exercitado contra a API
 * real do Gemini sem subir a Edge Function — ver tests/prompt_gemini_test.ts.
 *
 * Duas instrucoes carregam peso: manter valor e data (a evidencia deles foi a
 * mensagem original, e texto de follow-up nao pode reescrever quanto e quando
 * em silencio) e a saida SEM_RELACAO, que e o que impede uma mensagem
 * desconexa de virar reclassificacao "aproveitada".
 */
export function montarContextoReclassificacao(
  recibo: {
    descricao: string;
    valor: number | string;
    data_despesa: string | null;
    estabelecimento: string | null;
    documento_prestador: string | null;
    categoria: string;
    deducibilidade: string;
    motivos_revisao?: string[];
  },
  pergunta: string,
  texto: string,
): string {
  return [
    "Uma despesa ja foi registrada com a analise abaixo e ficou pendente de revisao.",
    `Descricao: ${recibo.descricao}`,
    `Valor: ${recibo.valor}`,
    `Data: ${recibo.data_despesa ?? "nao informada"}`,
    `Estabelecimento: ${recibo.estabelecimento ?? "nao informado"}`,
    `Documento do prestador: ${recibo.documento_prestador ?? "nao informado"}`,
    `Categoria: ${recibo.categoria}`,
    `Deducibilidade: ${recibo.deducibilidade}`,
    `Motivos de revisao: ${JSON.stringify(recibo.motivos_revisao ?? [])}`,
    "",
    `Perguntamos ao usuario: ${pergunta}`,
    `O usuario respondeu: ${texto}`,
    "",
    "Reclassifique a MESMA despesa considerando a resposta como evidencia nova.",
    "Mantenha valor e data_despesa exatamente como estao acima.",
    "Se a resposta do usuario nao tiver nenhuma relacao com essa despesa,",
    "responda exatamente SEM_RELACAO, sem tags e sem JSON.",
  ].join("\n");
}

export type PendenciaFollowup = {
  id: string;
  recibo_id: string;
  campo_alvo: string;
  expira_em: string;
  mensagens_restantes: number;
};

export type DecisaoFollowup =
  | { acao: "ignorar" }
  | { acao: "descartar"; motivo: "EXPIRADA" | "ORCAMENTO_ESGOTADO" }
  | { acao: "anotar"; valorDetectado: string | null; mensagensRestantes: number };

/**
 * O que fazer com a pendencia diante da mensagem que acabou de chegar.
 *
 * Funcao pura: quem chama decide o que gravar. A ordem e deliberada — a
 * expiracao por tempo e avaliada ANTES de consumir orcamento, e a resposta
 * reconhecida nao consome orcamento nenhum, senao a propria resposta poderia
 * ser a mensagem que fecha a pendencia que ela veio responder.
 */
export function decidirFollowup(
  pendencia: PendenciaFollowup | null | undefined,
  entrada: { tipo: string; texto: string | null | undefined },
  agora: Date = new Date(),
): DecisaoFollowup {
  if (!pendencia) return { acao: "ignorar" };
  if (!campoRespondivel(pendencia.campo_alvo)) return { acao: "descartar", motivo: "EXPIRADA" };
  if (followupExpirado(pendencia.expira_em, agora)) {
    return { acao: "descartar", motivo: "EXPIRADA" };
  }

  // Midia e lancamento novo, nunca resposta: foto de recibo nao responde "qual
  // o CNPJ". Ela so gasta orcamento.
  const valorDetectado = entrada.tipo === "text"
    ? extrairRespostaDeCampo(pendencia.campo_alvo, entrada.texto)
    : null;

  if (valorDetectado) {
    return { acao: "anotar", valorDetectado, mensagensRestantes: pendencia.mensagens_restantes };
  }

  const restantes = pendencia.mensagens_restantes - 1;
  if (restantes < 0) return { acao: "descartar", motivo: "ORCAMENTO_ESGOTADO" };

  // Ainda anota: a mensagem pode ser resposta em texto livre ("foi na clinica
  // X, nao tenho o CNPJ"), e quem decide isso e o classificador de intencao la
  // no n8n.
  return { acao: "anotar", valorDetectado: null, mensagensRestantes: restantes };
}
