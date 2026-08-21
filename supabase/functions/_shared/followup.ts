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

/** Campos de IDENTIFICACAO do prestador. Ambiguidade de categoria fiscal nao
 *  entra aqui: aquilo e decisao de contador, nao dado que falta.
 *
 *  A lista continua com dois elementos de proposito: derivarCamposBloqueantes
 *  itera sobre ela procurando campo vazio EM analise[campo], e valor_reembolso
 *  nao e um campo da extracao — e uma pergunta sobre um fato que a analise nao
 *  tem como conhecer. Por isso ele entra como constante separada, e nao como
 *  terceiro item aqui. */
export const CAMPOS_FOLLOWUP = ["documento_prestador", "estabelecimento"] as const;

/** Pergunta de reembolso (Fase 15). Nao e campo da extracao: e um fato que so o
 *  usuario sabe, e que nenhuma evidencia de compra carrega. */
export const CAMPO_REEMBOLSO = "valor_reembolso";

/** Import da declaracao do ano anterior (Fase 17). Nao pertence a NENHUM
 *  recibo: e a unica pendencia cuja resposta e um arquivo, e a unica que nasce
 *  de um pedido explicito do usuario em vez de uma lacuna que a IA achou.
 *
 *  Entra aqui, e so aqui, porque campoRespondivel e o que a whatsapp-webhook
 *  usa para decidir se conhece a pendencia — sem isto ela descartaria toda
 *  pendencia de declaracao com motivo CAMPO_DESCONHECIDO, que foi exatamente o
 *  incidente da Fase 15 (docs/09). O texto da pergunta, o TTL e o orcamento
 *  ficam em _shared/declaracao_anterior.ts: nada aqui muda para os tres campos
 *  de recibo, e derivarCampoFollowup continua sem conhece-lo. */
export const CAMPO_DECLARACAO_ANTERIOR = "declaracao_anterior";

export type CampoFollowup =
  | typeof CAMPOS_FOLLOWUP[number]
  | typeof CAMPO_REEMBOLSO
  | typeof CAMPO_DECLARACAO_ANTERIOR;

const CAMPOS_RESPONDIVEIS: readonly string[] = [
  ...CAMPOS_FOLLOWUP,
  CAMPO_REEMBOLSO,
  CAMPO_DECLARACAO_ANTERIOR,
];

export function campoRespondivel(campo: unknown): campo is CampoFollowup {
  return typeof campo === "string" && CAMPOS_RESPONDIVEIS.includes(campo);
}

/** Para onde a despesa vai se a identificacao do prestador chegar. Unico juizo
 *  fiscal que continua sendo da IA nesta decisao; o resto e derivado aqui. */
export function destinoSeDesbloqueado(analise: Record<string, unknown> | null | undefined): string | null {
  const declarado = analise?.deducibilidade_se_desbloqueado;
  return typeof declarado === "string" && ["DEDUTIVEL", "PARCIALMENTE_DEDUTIVEL"].includes(declarado)
    ? declarado
    : null;
}

/**
 * Campos de identificacao que valem uma pergunta, derivados da analise.
 *
 * A IA JA declarou este conjunto num campo proprio (campos_bloqueantes) e o
 * campo foi removido do schema, porque a definicao dele era irrealizavel
 * justamente onde mais importava: "o subconjunto que, preenchido SOZINHO,
 * removeria a revisao". Quando faltam os dois campos ao mesmo tempo — o formato
 * de "paguei 600 no proctologista", sem lugar e sem documento — nenhum deles
 * sozinho satisfaz a definicao, e o modelo devolvia [] corretamente. Medido
 * contra o Gemini real: 10/10 execucoes com lista vazia, e a mesma mensagem com
 * um so campo faltando enchia a lista 6/6. Nao era variacao do modelo, era a
 * regra pedindo o impossivel.
 *
 * O que sobra para a IA e o juizo que so ela tem: identificar o prestador
 * resolve, ou sobra motivo subjetivo (uso misto, reembolso, OCR ruim,
 * ambiguidade de categoria, decisao de contador)? Isso e
 * deducibilidade_se_desbloqueado, que a promocao ja precisava consultar. Com um
 * campo so no lugar de dois, deixa de existir a possibilidade de os dois se
 * contradizerem.
 *
 * A lista tem no maximo UM campo, e nao a intersecao inteira, por dois motivos:
 * a regra fiscal de SAUDE pede "identificacao do prestador OU estabelecimento",
 * entao um CNPJ ja satisfaz o requisito inteiro; e o follow-up so pergunta uma
 * coisa, logo uma lista maior nunca esvaziaria e a promocao morreria esperando
 * resposta que ninguem pediu. documento_prestador vem primeiro por ser o unico
 * verificavel sem IA (digito verificador).
 *
 * Derivar do campo extraido, e nao de campos_ausentes, tira do caminho a ultima
 * dependencia de texto livre: "esta vazio" e fato da extracao, enquanto
 * campos_ausentes e uma lista que a IA redige.
 */
export function derivarCamposBloqueantes(
  analise: Record<string, unknown> | null | undefined,
): CampoFollowup[] {
  if (!analise) return [];
  if (!destinoSeDesbloqueado(analise)) return [];

  const vazio = (valor: unknown) =>
    valor === null || valor === undefined || String(valor).trim() === "";

  return CAMPOS_FOLLOWUP.filter((campo) => vazio(analise[campo])).slice(0, 1);
}

/** Para onde a despesa vai se o usuario confirmar que NAO houve reembolso.
 *  Irmao de destinoSeDesbloqueado, e pela mesma razao: sem a declaracao, a
 *  promocao teria que adivinhar dedutibilidade fiscal. */
export function destinoSeSemReembolso(
  analise: Record<string, unknown> | null | undefined,
): string | null {
  const declarado = analise?.deducibilidade_se_sem_reembolso;
  return typeof declarado === "string" && ["DEDUTIVEL", "PARCIALMENTE_DEDUTIVEL"].includes(declarado)
    ? declarado
    : null;
}

/**
 * Vale perguntar sobre reembolso?
 *
 * O gate e possui_indicio_reembolso SOZINHO — e essa e uma divergencia
 * deliberada em relacao ao gate da pergunta de identificacao, que exige o
 * destino declarado.
 *
 * A pergunta de CNPJ so servia para promover: perguntar sem poder promover era
 * atrito puro. A pergunta de reembolso corrige o NUMERO declarado, e isso vale
 * mesmo quando a despesa continua em revisao por outro motivo — o contador que
 * revisa precisa saber, e a Receita cruza a deducao com a DMED da operadora.
 * Por isso destinoSeSemReembolso nao entra aqui: ele decide so a promocao.
 */
export function deveperguntarReembolso(
  analise: Record<string, unknown> | null | undefined,
): boolean {
  return analise?.possui_indicio_reembolso === true;
}

/**
 * O unico campo que vai virar pergunta, entre os tres possiveis.
 *
 * Uma vaga so (unique parcial da migration 009), entao alguem tem que ganhar.
 * Reembolso ganha por assimetria de risco: deduzir valor reembolsado e uma
 * INCONSISTENCIA AFIRMATIVA contra a DMED, enquanto documento faltando e um
 * registro INCOMPLETO que ja vai para revisao humana de qualquer jeito. Numero
 * errado e pior do que lacuna.
 *
 * Na pratica os dois quase nunca disputam: o prompt manda usar
 * deducibilidade_se_desbloqueado null quando ha indicio de reembolso, entao a
 * derivacao de identificacao ja devolve [] nesses casos — a vaga esta vazia. A
 * precedencia escrita aqui existe para o caso de a IA se contradizer, que foi
 * observado na varredura (guia autorizada com indicio de reembolso E destino de
 * desbloqueio preenchido na mesma resposta).
 *
 * derivarCamposBloqueantes NAO foi tocada: ela continua respondendo exatamente
 * o que respondia ontem, e tests/n8n_campos_bloqueantes_test.ts continua sendo
 * a prova disso.
 */
export function derivarCampoFollowup(
  analise: Record<string, unknown> | null | undefined,
): CampoFollowup | null {
  if (deveperguntarReembolso(analise)) return CAMPO_REEMBOLSO;
  return derivarCamposBloqueantes(analise)[0] ?? null;
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
  // Pergunta fechada primeiro ("foi reembolsado?") e o valor como complemento:
  // a resposta mais comum e "nao", e ela precisa caber em uma palavra. Dizer
  // como responder "nao" e o que torna a negacao reconhecivel sem IA.
  if (campo === CAMPO_REEMBOLSO) {
    return "Para calcular a dedução certa, esse valor foi reembolsado pelo plano? " +
      'Se foi, me diz quanto — se não foi, é só responder "não".';
  }
  if (campo === "documento_prestador") {
    const onde = contexto.estabelecimento?.trim();
    return onde
      ? `Para confirmar se é dedutível, você tem o CNPJ ou CPF de ${onde}?`
      : "Para confirmar se é dedutível, você tem o CNPJ ou CPF do prestador?";
  }
  return "Para confirmar se é dedutível, onde foi essa despesa? Pode me dizer o nome do estabelecimento.";
}

/**
 * Aviso de que a pergunta anterior morreu para dar lugar a esta.
 *
 * Uma pendencia aberta por usuario (unique parcial da migration 009): despesa
 * nova que tambem precisa de follow-up encerra a anterior com SUPERSEDIDA,
 * dentro da mesma transacao da registrar_followup_pendente. Ate a Fase 14 isso
 * acontecia em silencio — a despesa mais antiga perdia a chance de resolucao
 * por conversa sem nenhum sinal de que tinha perdido.
 *
 * O texto NAO convida a responder a antiga depois, e a ausencia desse convite e
 * o ponto: a pendencia antiga esta fechada e a unica aberta e a da despesa
 * nova, entao um CNPJ enviado mais tarde seria gravado no recibo NOVO. Prometer
 * o canal seria pior do que o silencio que estamos corrigindo — colaria
 * evidencia no recibo errado. Fila de multiplas pendencias e outra fase.
 *
 * Copia viva no Code node "Montar Payload do Recibo" (o n8n nao importa arquivo
 * do repo); tests/n8n_fase14_test.ts compara as duas.
 */
export const AVISO_PENDENCIA_SUBSTITUIDA =
  "A pergunta da despesa anterior ficou sem resposta — ela continua registrada e vai para a revisão do contador.";

/**
 * Resposta a uma mensagem que nao carregava informacao nenhuma ("sim", "ok").
 *
 * Antes da Fase 14 este caminho caia no texto de ajuda generico do
 * consulta-e-dossie ("posso registrar despesas, mostrar seu resumo..."), que
 * nao diz a unica coisa que importa ali: a pergunta continua de pe e ainda pode
 * ser respondida. A pendencia nao foi consumida — respostaSemConteudo roda
 * antes de reivindicar —, entao a mensagem seguinte com o dado ainda resolve.
 *
 * A frase repete a pergunta original em vez de resumi-la: o dado que falta ja
 * esta escrito ali, e reescrever de memoria criaria uma segunda versao da
 * pergunta para manter em dia.
 */
export function mensagemPerguntaSegueAberta(pergunta: string): string {
  return [
    "Sem problema — a despesa já está registrada, isso não trava nada.",
    "Se você tiver esse dado por aí, é só me mandar aqui na sequência:",
    pergunta,
  ].join("\n\n");
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
  if (campo === CAMPO_REEMBOLSO) return serializarRespostaReembolso(texto);
  // declaracao_anterior cai neste return: a resposta dela e um ARQUIVO, e
  // nenhuma frase deve fechar a pendencia. Quem a resolve e a
  // declaracao-import, depois de ler o PDF.
  if (campo !== "documento_prestador") return null;
  return extrairDocumento(texto);
}

/**
 * Forma da resposta de reembolso no payload da whatsapp-webhook.
 *
 * O contrato de valor_detectado e string|null e o IF "Resposta de Follow-up?"
 * do n8n so testa "nao vazio", entao a resposta de reembolso e serializada em
 * string para nao mexer em nenhum dos dois. Esta string e SINAL DE ROTEAMENTO,
 * nunca dado: quem grava e a followup-resolve, que reparseia o texto cru e tem
 * o recibo em maos para conferir o teto do valor.
 */
export function serializarRespostaReembolso(texto: string | null | undefined): string | null {
  const resposta = extrairRespostaDeReembolso(texto);
  if (!resposta) return null;
  if (!resposta.houve) return "NAO";
  return resposta.valor === null ? "SIM" : resposta.valor.toFixed(2);
}

export type RespostaReembolso =
  | { houve: false; valor: 0 }
  | { houve: true; valor: number | null };

// Verbos que denunciam DESPESA NOVA. Subconjunto proposital de
// TERMOS_DE_LANCAMENTO: os substantivos de dinheiro daquela lista ("reais",
// "valor", "conto") ficam de fora aqui, porque a resposta esperada NESTA
// pergunta e justamente um valor em dinheiro — "o plano cobriu 300 reais" e a
// resposta certa, e recusa-la por causa de "reais" seria copiar a regra do
// campo errado. O que segura o falso positivo aqui e a exigencia de um numero
// so, mais estes verbos.
const VERBOS_DE_LANCAMENTO = [
  "paguei", "pagamos", "pagando", "pagar", "gastei", "gastamos", "gastou",
  "gastar", "gasto", "comprei", "compramos", "comprou", "comprar", "compra",
  "custou", "custa", "custo", "transferi", "depositei",
];

// Palavras que negam o reembolso.
const NEGACOES_REEMBOLSO = [
  "nao", "n", "nenhum", "nenhuma", "nada", "zero", "negativo", "particular",
  "nunca", "sem",
];

// Palavras que afirmam o reembolso sem dizer quanto.
const AFIRMACOES_REEMBOLSO = [
  "sim", "s", "houve", "teve", "tive", "cobriu", "cobre", "reembolsou",
  "reembolsaram", "reembolsado", "reembolsada", "positivo", "isso", "exato",
];

// Ligacao aceita em volta de uma negacao ou de uma afirmacao seca. Lista curta
// de proposito: palavra de fora ja e evidencia potencial e segue para a IA,
// mesmo vies do resto do arquivo. "vou", "pedir" e "ainda" ficam FORA — "nao
// vou pedir reembolso ainda" nao e "nao houve reembolso", e gravar 0 ali criaria
// exatamente a inconsistencia com a DMED que esta fase existe para evitar.
// Os verbos de afirmacao entram aqui de proposito: "nao houve reembolso" e uma
// NEGACAO que carrega o verbo da afirmacao, e sem eles a frase mais natural de
// negar nao seria reconhecida. E seguro porque a negacao e testada primeiro e
// exige pelo menos uma palavra de negacao presente — "houve reembolso", sem
// negacao nenhuma, continua caindo no ramo afirmativo.
const LIGACAO_REEMBOLSO = [
  "reembolso", "reembolsos", "plano", "convenio", "seguro", "operadora",
  "cobertura", "foi", "era", "de", "do", "da", "o", "a", "e", "um", "uma",
  "que", "eu", "meu", "minha", "no", "na", "em", "pelo", "pela", "esse",
  "essa", "isso", "tudo", "nem", "me", "recebi", "voltou", "volta",
  "houve", "teve", "tive", "cobriu", "cobre", "cobriram", "reembolsou",
  "reembolsaram", "reembolsado", "reembolsada", "devolveu", "devolveram",
];

/**
 * A mensagem responde "houve reembolso, e de quanto?".
 *
 * Nao existe digito verificador para valor monetario — e isso muda a natureza
 * da guarda em relacao a extrairDocumento. O que segura o falso positivo aqui:
 *
 *  1. **Contexto de pendencia.** Esta funcao so roda quando a pergunta aberta e
 *     valor_reembolso, ou seja, acabamos de perguntar isso uma ou duas
 *     mensagens atras.
 *  2. **Um numero so.** Dois numeros e "valor + alguma coisa", e volta a ser
 *     mensagem nova.
 *  3. **Verbo de gasto.** "paguei 300 no mercado" e despesa, nao resposta.
 *  4. **Tamanho.** Numero com cara de documento (11 digitos ou mais) nao e
 *     valor de reembolso; sem esse corte, um CPF colado viraria R$ 11 bilhoes.
 *
 * O teto de verdade — reembolso nao pode ser maior que a despesa — fica na
 * followup-resolve e na constraint da migration 010, porque so eles conhecem o
 * recibo. Aqui a resposta e so roteamento.
 */
export function extrairRespostaDeReembolso(
  texto: string | null | undefined,
): RespostaReembolso | null {
  if (!texto) return null;

  const semAcento = texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
  if (!semAcento) return null;

  const palavras = semAcento.replace(/[^a-z]+/g, " ").split(" ").filter(Boolean);

  if (palavras.some((palavra) => VERBOS_DE_LANCAMENTO.includes(palavra))) return null;

  // Valor monetario em qualquer das formas que a pessoa escreve: 300, 300,50,
  // 1.200,00, 1200.50, R$ 300.
  const achados = semAcento.match(/\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?|\d+/g) ?? [];

  if (achados.length > 1) return null;

  if (achados.length === 1) {
    const valor = valorEmReais(achados[0]);
    if (valor === null) return null;
    // Reembolso de zero e negacao escrita com numero.
    return valor === 0 ? { houve: false, valor: 0 } : { houve: true, valor };
  }

  const todasConhecidas = (vocabulario: string[]) =>
    palavras.every((palavra) =>
      vocabulario.includes(palavra) || LIGACAO_REEMBOLSO.includes(palavra)
    );

  // Negacao antes de afirmacao: "nao houve reembolso" carrega "houve", e sem
  // esta ordem viraria afirmacao.
  if (palavras.some((p) => NEGACOES_REEMBOLSO.includes(p)) && todasConhecidas(NEGACOES_REEMBOLSO)) {
    return { houve: false, valor: 0 };
  }

  if (palavras.some((p) => AFIRMACOES_REEMBOLSO.includes(p)) && todasConhecidas(AFIRMACOES_REEMBOLSO)) {
    return { houve: true, valor: null };
  }

  return null;
}

/**
 * Numero escrito em portugues para reais.
 *
 * A ambiguidade real e o ponto sozinho: "1.200" e mil e duzentos, "1.20" e um e
 * vinte. A regra do idioma resolve — ponto seguido de exatamente tres digitos e
 * separador de milhar.
 */
function valorEmReais(bruto: string): number | null {
  let normalizado: string;

  if (bruto.includes(",")) {
    normalizado = bruto.replace(/\./g, "").replace(",", ".");
  } else if (/\.\d{3}(?:\.\d{3})*$/.test(bruto)) {
    normalizado = bruto.replace(/\./g, "");
  } else {
    normalizado = bruto;
  }

  // Documento colado (CPF tem 11, CNPJ tem 14) nao e valor de reembolso.
  if (normalizado.replace(/\D/g, "").length >= 11) return null;

  const numero = Number(normalizado);
  if (!Number.isFinite(numero) || numero < 0) return null;
  return numero;
}

/** Resposta a um "sim" sem valor. A pendencia continua aberta: quem confirmou o
 *  reembolso quase sempre sabe, ou consegue ver, de quanto foi. */
export function mensagemReembolsoSemValor(): string {
  return [
    "Certo — e de quanto foi esse reembolso?",
    "Me manda só o valor que o plano devolveu, que eu desconto da dedução.",
  ].join("\n\n");
}

/** Resposta a um valor de reembolso maior que a propria despesa. Quase sempre e
 *  digito a mais, ou o valor da despesa repetido por engano. */
export function mensagemReembolsoMaiorQueDespesa(valorDespesa: string): string {
  return [
    `Esse valor é maior que a despesa, que foi de ${valorDespesa}.`,
    `Confere aí e me manda de novo — se o plano cobriu tudo, é só repetir ${valorDespesa}.`,
  ].join("\n\n");
}

// Palavras que denunciam LANCAMENTO NOVO, e nao resposta. E a unica lista
// fechada que sobrou aqui, e ela so tem termo que descreve gasto.
//
// A versao anterior fazia o contrario — exigia que toda palavra da mensagem
// estivesse numa lista curta de prefixos aceitos — e isso recusava a forma como
// a pessoa realmente escreve: "cnpj dele e 25.255.628/0001-69" morria em
// "dele". Recusada a resposta, a mensagem seguia para o classificador de
// intencao, que a leu como despesa nova; o resto do estrago esta em
// docs/06 - Follow-up Conversacional.md.
//
// A troca de lista branca por lista negra e segura porque o peso da decisao nao
// esta nas palavras: esta no digito verificador do documento e na regra de
// numero sobrando logo abaixo. Uma mensagem precisa carregar um CNPJ/CPF
// aritmeticamente valido para chegar ate aqui.
const TERMOS_DE_LANCAMENTO = [
  "paguei",
  "pagamos",
  "pagando",
  "pagar",
  "pago",
  "paga",
  "gastei",
  "gastamos",
  "gastou",
  "gastar",
  "gasto",
  "comprei",
  "compramos",
  "comprou",
  "comprar",
  "compra",
  "custou",
  "custa",
  "custo",
  "transferi",
  "depositei",
  "reais",
  "real",
  "conto",
  "contos",
  "pila",
  "valor",
  "valores",
];

/**
 * Procura um CNPJ ou CPF valido em qualquer posicao da mensagem.
 *
 * Tres filtros, do mais forte para o mais fraco:
 *
 *  1. **Digito verificador.** Um numero qualquer nao passa; e isto que separa
 *     "documento" de "sequencia de digitos".
 *  2. **Numero sobrando.** Qualquer grupo de digitos que nao seja o documento
 *     faz recusar. Numero solto em mensagem de WhatsApp e quase sempre valor,
 *     e "paguei 450 na clinica 11.222.333/0001-81" tem que continuar sendo
 *     lancamento novo.
 *  3. **Vocabulario de gasto.** "paguei 11222333000181 no mercado" e uma
 *     despesa escrita com o CNPJ no meio, nao uma resposta.
 *
 *  Documento ambiguo (dois validos na mesma mensagem) tambem recusa: o vies do
 *  arquivo continua sendo "na duvida, e mensagem nova".
 */
export function extrairDocumento(texto: string | null | undefined): string | null {
  if (!texto) return null;

  const semAcento = texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
  if (!semAcento) return null;

  // Simbolo de moeda e prova de que a mensagem fala de dinheiro. Checado no
  // texto cru porque "r$500" nao vira palavra separada.
  if (/r\$/.test(semAcento)) return null;

  // Separadores de documento (ponto, barra, hifen) somem; o resto do texto
  // precisa sobrar limpo para a checagem de palavras.
  const semPontuacao = semAcento.replace(/[.\-/\\:,;()]/g, " ").replace(/\s+/g, " ").trim();
  const palavras = semPontuacao.split(" ").filter(Boolean);

  // Grupos de digitos CONSECUTIVOS formam um candidato so: "25 255 628 0001 69"
  // e um documento com separador, nao cinco numeros soltos. Grupo separado por
  // palavra comeca candidato novo, e e assim que o valor de uma despesa deixa
  // de se colar ao documento.
  const candidatos: string[] = [];
  const sobras: string[] = [];
  const outras: string[] = [];

  let corrente = "";
  const fecharGrupo = () => {
    if (!corrente) return;
    if (corrente.length === 14 && cnpjValido(corrente)) candidatos.push(corrente);
    else if (corrente.length === 11 && cpfValido(corrente)) candidatos.push(corrente);
    else sobras.push(corrente);
    corrente = "";
  };

  for (const palavra of palavras) {
    if (/^\d+$/.test(palavra)) {
      corrente += palavra;
      continue;
    }
    fecharGrupo();
    outras.push(palavra);
  }
  fecharGrupo();

  if (candidatos.length !== 1) return null;
  if (sobras.length > 0) return null;
  if (outras.some((palavra) => TERMOS_DE_LANCAMENTO.includes(palavra))) return null;

  return candidatos[0];
}

/**
 * A mensagem parece um documento, mas o digito verificador nao fecha?
 *
 * Existe por um caso medido na varredura da Fase 14: respondido
 * `11.222.333/0001-82` (um digito trocado no CNPJ da pergunta), a extracao
 * deterministica recusa — como deve —, e a mensagem seguia para a
 * reclassificacao por IA. O Gemini entao gravava o numero invalido em
 * documento_prestador e promovia a despesa para DEDUTIVEL com
 * requer_revisao_humana false, em 3 de 3 execucoes. Ou seja: o caminho de IA
 * apagava exatamente a validacao que o caminho deterministico existe para
 * fazer, e o recibo terminava aprovado com um documento que nao existe.
 *
 * Esta funcao NAO altera extrairDocumento — ela e a irma dele, e as duas sao
 * mutuamente exclusivas por construcao (a primeira coisa aqui e perguntar se
 * aquela aceitou). A varredura de grupos de digitos e repetida de proposito em
 * vez de extraida para um helper comum: extrairDocumento e codigo validado
 * contra conversa real e nao vai ser reescrito para caber num refactor.
 * tests/followup_test.ts prova que as duas nunca respondem sim ao mesmo texto.
 *
 * Os filtros de recusa sao os mesmos do irmao, pelo mesmo motivo: numero
 * sobrando e vocabulario de gasto indicam lancamento novo, nao documento
 * digitado errado.
 */
export function respostaDocumentoInvalido(texto: string | null | undefined): boolean {
  if (!texto) return false;
  // Documento valido tem caminho proprio; aqui so entra o que aquela recusou.
  if (extrairDocumento(texto)) return false;

  const semAcento = texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
  if (!semAcento) return false;
  if (/r\$/.test(semAcento)) return false;

  const semPontuacao = semAcento.replace(/[.\-/\\:,;()]/g, " ").replace(/\s+/g, " ").trim();
  const palavras = semPontuacao.split(" ").filter(Boolean);

  const grupos: string[] = [];
  const outras: string[] = [];
  let corrente = "";
  const fecharGrupo = () => {
    if (!corrente) return;
    grupos.push(corrente);
    corrente = "";
  };

  for (const palavra of palavras) {
    if (/^\d+$/.test(palavra)) {
      corrente += palavra;
      continue;
    }
    fecharGrupo();
    outras.push(palavra);
  }
  fecharGrupo();

  // Um grupo so, do tamanho de um documento, e nenhum termo de gasto em volta.
  // Dois numeros ja e "valor + alguma coisa", e ai o vies volta a ser o de
  // sempre: na duvida, isto e mensagem nova.
  if (grupos.length !== 1) return false;
  if (outras.some((palavra) => TERMOS_DE_LANCAMENTO.includes(palavra))) return false;

  const numero = grupos[0];
  if (numero.length === 14) return !cnpjValido(numero);
  if (numero.length === 11) return !cpfValido(numero);
  return false;
}

/**
 * Documento vindo da IA, so quando o digito verificador fecha.
 *
 * Segunda camada da mesma correcao: mesmo com a guarda acima, a analise pode
 * devolver um documento que ninguem digitou (alucinacao, OCR do texto). Gravar
 * documento nao conferido e pior do que nao gravar nada, porque ele vira
 * evidencia no dossie que o contador vai revisar.
 */
export function documentoConferido(valor: unknown): string | null {
  if (typeof valor !== "string" || !valor.trim()) return null;
  const numero = valor.replace(/\D/g, "");
  if (numero.length === 14 && cnpjValido(numero)) return valor;
  if (numero.length === 11 && cpfValido(numero)) return valor;
  return null;
}

/** Resposta a um documento digitado errado. A pendencia continua aberta: quem
 *  errou um digito quase sempre tem o numero certo em maos. */
export function mensagemDocumentoNaoConfere(): string {
  return [
    "Esse número não fecha como CNPJ nem como CPF — deve ter escapado algum dígito.",
    "Confere aí e me manda de novo que eu anoto na despesa.",
  ].join("\n\n");
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

// Palavras que, sozinhas, nao carregam evidencia nenhuma sobre a despesa:
// confirmacao, negacao, saudacao, cortesia e promessa de voltar depois.
//
// A lista e usada como lista NEGRA de mensagem inteira, e nao como lista branca
// de resposta valida: so recusa quando TODA palavra da mensagem esta aqui. Uma
// palavra de fora — nome de lugar, tipo de servico, qualquer coisa — ja e
// evidencia potencial e segue o caminho normal. O vies e o de sempre: na
// duvida, deixar passar para a IA decidir.
const TERMOS_SEM_CONTEUDO = [
  // confirmacao e negacao
  "sim", "s", "nao", "n", "claro", "certo", "certeza", "com", "exato",
  "exatamente", "isso", "aham", "uhum", "hum", "positivo", "negativo", "ok",
  "okay", "okey", "blz", "beleza", "confirmo", "confirmado",
  // posse, que e o verbo da pergunta
  "tenho", "tem", "temos", "ter", "tinha", "consigo", "acho", "acredito",
  "sei", "la", "talvez",
  // cortesia e reacao
  "obrigado", "obrigada", "obg", "vlw", "valeu", "show", "top", "perfeito",
  "otimo", "legal", "bom", "boa", "bem", "tudo", "opa", "oi", "ola", "eae",
  "entendi", "entendido", "certinho",
  // promessa de voltar depois
  "ja", "agora", "depois", "mais", "tarde", "so", "um", "uma", "momento",
  "minuto", "minutinho", "pera", "perai", "calma", "deixa", "vou", "ver",
  "procurar", "olhar", "mandar", "mando", "envio", "enviar", "te",
  // glue que sobra em volta do que esta acima
  "eu", "e", "a", "o", "que", "de", "do", "da", "ele", "ela", "dele", "dela",
  "aqui", "ali", "ta", "tah", "esta", "pra", "para", "por", "no", "na", "em",
];

/**
 * A mensagem e uma resposta sem nenhuma informacao extraivel?
 *
 * Existe por causa de um caso real: perguntamos o CNPJ do proctologista, a
 * pessoa respondeu "Sim", e a reclassificacao tratou isso como evidencia nova —
 * fechou a pendencia com uma confirmacao enganosa ("anotei essa informacao") e
 * a mensagem SEGUINTE, com o CNPJ de verdade, ja nao tinha pendencia para
 * responder.
 *
 * A instrucao SEM_RELACAO do contexto nao cobria o caso porque ela testa
 * RELACAO, e "Sim" e perfeitamente relacionado a pergunta — so nao carrega
 * dado. Medido contra o Gemini real na temperatura de producao, dez respostas
 * desse tipo reclassificaram em 22 de 30 execucoes, e de forma instavel: "Sim"
 * fechou 1/3, "sim" 2/3, "ok" 0/3. Em todas, a analise voltou com
 * estabelecimento e documento vazios — nao havia o que extrair.
 *
 * Este filtro roda ANTES da chamada de IA. Nao e otimizacao: e o que garante
 * que o desfecho de "Sim" nao dependa de sorteio do modelo. A instrucao no
 * contexto continua existindo para as formas que a lista nao preve.
 *
 * Qualquer digito na mensagem faz devolver false na hora: documento e valor sao
 * digitos, e nenhuma mensagem com numero pode ser descartada por esta funcao.
 */
export function respostaSemConteudo(texto: string | null | undefined): boolean {
  if (!texto) return true;

  const semAcento = texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

  if (/\d/.test(semAcento)) return false;

  const palavras = semAcento.replace(/[^a-z]+/g, " ").split(" ").filter(Boolean);
  if (palavras.length === 0) return true;

  return palavras.every((palavra) => TERMOS_SEM_CONTEUDO.includes(palavra));
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
 *
 * O "INTEIRA" do caso 2 e uma palavra so, e ela custou uma investigacao.
 * Enquanto a regra dizia apenas "negacao seca entra aqui", uma mensagem que
 * ABRIA por um termo da lista e trazia evidencia real depois punha o modelo
 * entre duas instrucoes opostas: "nao tenho" pedindo SEM_RELACAO e "consulta
 * com psicologa" pedindo reclassificacao. O desfecho nao era nenhum dos dois —
 * medido contra o Gemini real na temperatura e no thinkingLevel de producao, em
 * 13 de 13 execucoes o modelo largava a tarefa e respondia com uma apresentacao
 * da propria persona ("Sou o TaxMind, seu copiloto fiscal"), sem <expense> e
 * sem SEM_RELACAO. Trocando so a ORDEM das mesmas palavras (evidencia antes,
 * negacao depois) a mensagem voltava a extrair 3/3: nao era o conteudo, era a
 * negacao em posicao de abertura. Um caso vizinho falhava calado pelo mesmo
 * motivo — "nao tenho o CNPJ, mas foi uma consulta com dentista" devolvia
 * SEM_RELACAO 3/3, descartando evidencia legitima.
 *
 * O criterio "mensagem inteira" e o mesmo que respostaSemConteudo ja aplica em
 * codigo deterministico (`palavras.every(...)` sobre a lista negra), e ter os
 * dois lados dizendo a mesma coisa e o ponto: o filtro deterministico roda
 * ANTES e ja deixa essas mensagens passarem — faltava a instrucao parar de
 * contradize-lo.
 *
 * NAO REESCREVER ESTE BLOCO PARA "EXPLICAR MELHOR". Ele esta perto de um
 * penhasco de estabilidade, e a primeira tentativa de correcao foi um paragrafo
 * a mais dizendo exatamente isto em prosa: ela consertou o caso alvo e QUEBROU
 * dois que funcionavam (evidencia sem negacao nenhuma passou a devolver
 * apresentacao 3/3). Cinco redacoes foram medidas lado a lado nos mesmos casos;
 * acrescentar uma unica linha curta ao fim do bloco derrubou o placar de 5/7
 * para 1/7, com apresentacao ate nos controles. A redacao atual e a de menor
 * delta possivel — uma palavra e refluxo de linha — e foi a unica a fechar 7/7
 * em 5 execucoes. Mudanca aqui se mede, nao se argumenta.
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
    "",
    "Responda exatamente SEM_RELACAO, sem tags e sem JSON, em DOIS casos:",
    "1. a resposta nao tem nenhuma relacao com essa despesa;",
    "2. a resposta INTEIRA nao acrescenta NENHUMA informacao nova sobre a",
    "   despesa, ainda que seja uma reacao natural a pergunta. Confirmacao,",
    "   negacao ou cortesia secas entram aqui: sim, ok, tenho, nao tenho,",
    "   claro, beleza, ja mando, deixa eu ver. Nada disso identifica prestador,",
    "   servico ou estabelecimento, e reclassificar por cima disso apagaria a",
    "   pendencia sem ter respondido a pergunta.",
    "So reclassifique quando houver dado novo de verdade: nome do lugar, tipo",
    "de servico, quem atendeu, natureza da despesa ou documento.",
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
  | { acao: "descartar"; motivo: "EXPIRADA" | "ORCAMENTO_ESGOTADO" | "CAMPO_DESCONHECIDO" }
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

  // CAMPO_DESCONHECIDO tem rotulo proprio, e a separacao custou um incidente
  // para existir. Este ramo dispara quando a pendencia foi criada com um
  // campo_alvo que ESTA versao do codigo nao conhece — na pratica, quando o n8n
  // e a migration ja foram para producao e esta function nao. Enquanto ele
  // devolvia "EXPIRADA", a trilha de auditoria afirmava uma coisa impossivel:
  // pendencia descartada 30 minutos ANTES do proprio expira_em, com o orcamento
  // de mensagens intacto. Os dois numeros no banco contradiziam o motivo
  // gravado, e nada apontava para a causa real.
  //
  // Verificado em producao em 2026-08-09: duas pendencias de valor_reembolso
  // (4b75abd2 e 06903763) descartadas em 9s e 34s, motivo "EXPIRADA",
  // expira_em 30 minutos a frente. Ver docs/09.
  if (!campoRespondivel(pendencia.campo_alvo)) {
    return { acao: "descartar", motivo: "CAMPO_DESCONHECIDO" };
  }

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
