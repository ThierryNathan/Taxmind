// Import da declaracao de IRPF do ano anterior (Fase 17).
//
// Logica pura: texto das mensagens, prompt de extracao, validacao da resposta
// da IA e composicao do complemento do resumo. O I/O fica nas functions, pelo
// mesmo motivo de _shared/followup.ts existir (o index.ts chama serve() no topo
// e importa-lo num teste subiria um servidor).
//
// POR QUE A PENDENCIA REUSA followups_pendentes
//
// TTL, orcamento de mensagens, SUPERSEDIDA, exclusao mutua e a anotacao que a
// whatsapp-webhook poe em toda mensagem sao por PENDENCIA, nao por tipo de
// campo. A migration 011 registra a decisao por extenso.
//
// A DIFERENCA DESTE CAMPO PARA OS OUTROS TRES
//
// Os outros tres se respondem por TEXTO; este se responde por ARQUIVO. Duas
// consequencias que atravessam o codigo todo:
//
//   1. `extrairRespostaDeCampo` devolve null para ele — e deve continuar
//      devolvendo. Nao existe resposta em texto para reconhecer, e tentar
//      adivinhar transformaria "manda o pdf" numa despesa.
//   2. A midia deixa de ser "sempre lancamento novo" ENQUANTO esta pendencia
//      estiver aberta. E o unico caso em que um documento nao e recibo.
//
// O FREIO QUE TORNA ISSO SEGURO
//
// Uma pendencia aberta nao pode sequestrar a foto do cupom que a pessoa mandou
// no meio do caminho. Por isso a extracao declara `e_declaracao_irpf`, e um
// documento que nao for declaracao volta para o fluxo de recibo em vez de virar
// baseline. Medido contra o Gemini real: recibo em PDF recusado 3/3.

import { economiaPorDeducao, type EconomiaEstimada } from "./irpf_calculo.ts";
import { parametrosDoAno } from "./irpf_parametros.ts";

/** Campo da pendencia, reexportado de followup.ts em vez de redeclarado.
 *
 *  O literal vive la porque e la que campoRespondivel decide se a
 *  whatsapp-webhook conhece a pendencia — duas copias da mesma string
 *  divergiriam em silencio, e o sintoma seria a pendencia sendo descartada com
 *  CAMPO_DESCONHECIDO, que foi o incidente da Fase 15 (docs/09). */
export { CAMPO_DECLARACAO_ANTERIOR as CAMPO_DECLARACAO } from "./followup.ts";

/** Janela maior que os 30 minutos das perguntas de recibo, e de proposito: as
 *  outras se respondem de cabeca, esta exige entrar no e-CAC com conta gov.br,
 *  achar o ano e baixar o arquivo. */
export const DECLARACAO_TTL_MINUTOS = 60;

/** Orcamento maior pelo mesmo motivo: a pessoa provavelmente vai conversar
 *  outra coisa enquanto procura o PDF. E seguro porque o que fecha esta
 *  pendencia e um ARQUIVO que se identifica sozinho, e nao uma frase ambigua —
 *  documento que nao for declaracao volta para o fluxo de recibo. */
export const DECLARACAO_MENSAGENS_TOLERADAS = 5;

export const VERSAO_PROMPT_DECLARACAO = "declaracao-irpf-2026-08-18";

/**
 * Passo a passo de onde tirar o PDF.
 *
 * O caminho foi conferido na documentacao da Receita, nao suposto:
 *
 *  - "A copia esta disponivel no Meu Imposto de Renda, via app no
 *    celular/tablet ou e-CAC, na opcao 'Documentos e Arquivos'" (FAQ oficial
 *    "Como obter copia da minha declaracao?");
 *  - dentro do e-CAC: Meu Imposto de Renda -> escolher o ano em "Declaracao do
 *    IRPF" -> "Servicos Disponiveis" -> "Documentos e Arquivos (Copia da
 *    Declaracao)" -> icone de download;
 *  - exige conta gov.br nivel PRATA ou OURO (ou certificado digital).
 *
 * O manual do MIR confirma que "Documentos e Arquivos (Copia da Declaracao)" e
 * servico do Portal, e nao uma secao da tela inicial do MIR — por isso a
 * instrucao aponta o e-CAC, e nao o app de preenchimento.
 *
 * A frase sobre o arquivo nao ficar guardado nao e cortesia: o PDF traz renda,
 * dependentes e bens, e a pessoa tem o direito de saber disso ANTES de enviar.
 */
export const MENSAGEM_PEDIR_DECLARACAO = [
  "Boa! Me manda o PDF da sua declaração do ano passado aqui no WhatsApp.",
  "Onde pegar, se você não tiver o arquivo à mão:",
  "1. Entre no e-CAC (cav.receita.fazenda.gov.br) com sua conta gov.br — precisa ser nível prata ou ouro.\n" +
  "2. Clique em *Meu Imposto de Renda*.\n" +
  "   Não achou essa opção? No canto da tela tem um botão para trocar para a " +
  "*versão clássica* do e-CAC — nela o *Meu Imposto de Renda* aparece.\n" +
  "3. Em *Declaração do IRPF*, escolha o ano.\n" +
  "4. Em *Serviços Disponíveis*, clique em *Documentos e Arquivos (Cópia da Declaração)* e baixe o PDF.",
  "Eu leio só a alíquota efetiva, se você usou desconto simplificado ou completa, e quais deduções apareceram. " +
    "O arquivo não fica guardado — depois de ler, eu descarto e mantenho apenas esses números.",
  "Tenho uma hora de janela. Se passar, é só pedir de novo.",
].join("\n\n");

/** Resposta quando o documento chega mas nao e uma declaracao. O texto diz o
 *  que aconteceu com o arquivo (seguiu como despesa) para a pessoa nao mandar
 *  de novo achando que se perdeu. */
export const MENSAGEM_NAO_E_DECLARACAO = [
  "Esse arquivo não parece a declaração do IRPF, então não usei como base do ano anterior.",
  "Tratei ele como um comprovante comum — se era isso mesmo, está registrado.",
  "Se você quis mandar a declaração, ela é o PDF de *Documentos e Arquivos (Cópia da Declaração)* no e-CAC. É só pedir *importar declaração anterior* de novo.",
].join("\n\n");

export type CategoriaDeclaracao =
  | "SAUDE"
  | "EDUCACAO"
  | "PREVIDENCIA"
  | "SERVICOS_PROFISSIONAIS"
  | "OUTROS";

export type DeclaracaoExtraida = {
  ano_calendario: number;
  modelo: "SIMPLIFICADO" | "COMPLETO";
  aliquota_efetiva: number | null;
  imposto_devido: number | null;
  base_calculo: number | null;
  rendimentos_tributaveis: number | null;
  categorias_pagamentos: CategoriaDeclaracao[];
  pagamentos_detalhados: Array<{ codigo?: string; descricao?: string; valor?: number }>;
  confianca: "ALTA" | "MEDIA" | "BAIXA";
  motivos_revisao: string[];
};

/**
 * Prompt de extracao.
 *
 * O bloco de FORMATO e copiado do prompt fiscal de proposito: sem ele o modelo
 * devolve ```json em vez da tag, medido 3/3 na primeira execucao contra o
 * Gemini real. O resto foi medido em 9/9 (tres modelos de declaracao x tres
 * execucoes) mais 3/3 recusando um recibo comum.
 *
 * "imposto_devido" e pedido porque, quando o PDF traz o numero ja calculado
 * pela Receita, ele vira o baseline sem risco de erro de calculo nosso.
 */
export const PROMPT_EXTRACAO_DECLARACAO =
  `Voce recebe o PDF de visualizacao de uma Declaracao de Ajuste Anual do IRPF,
exportado pelo portal da Receita Federal pelo proprio contribuinte.

Extraia APENAS o que estiver escrito no documento. Nunca calcule, estime ou complete.

FORMATO DE RESPOSTA OBRIGATORIO
Responda com um bloco tecnico unico dentro de <declaracao>...</declaracao> contendo JSON valido.
Nao use Markdown, nao use crase, nao escreva nada antes de <declaracao> nem depois de </declaracao>.

<declaracao>{ ... }</declaracao>, com este formato:

{
  "e_declaracao_irpf": true | false,
  "ano_calendario": <numero de 4 digitos ou null>,
  "modelo": "SIMPLIFICADO" | "COMPLETO" | null,
  "aliquota_efetiva": <numero com ponto decimal, em pontos percentuais, ou null>,
  "imposto_devido": <numero ou null>,
  "base_calculo": <numero ou null>,
  "rendimentos_tributaveis": <numero ou null>,
  "categorias_pagamentos": [ "SAUDE" | "EDUCACAO" | "PREVIDENCIA" | "SERVICOS_PROFISSIONAIS" | "OUTROS" ],
  "pagamentos_detalhados": [ { "codigo": "<codigo da ficha>", "descricao": "<como esta escrito>", "valor": <numero> } ],
  "confianca": "ALTA" | "MEDIA" | "BAIXA",
  "motivos_revisao": [ "<texto curto>" ]
}

Regras:
1. e_declaracao_irpf = false para qualquer outro documento (recibo, nota fiscal,
   extrato, contrato, comprovante de pagamento). Nesse caso todos os demais
   campos vao nulos ou vazios.
2. "modelo" e a opcao pela qual a declaracao FOI APRESENTADA. O PDF costuma
   trazer os dois resumos lado a lado para comparacao; escolha o que estiver
   marcado como a opcao utilizada/apresentada. Se nao houver marcacao explicita,
   devolva null e registre o motivo.
3. "aliquota_efetiva" e a do modelo escolhido no item 2, nunca a do outro bloco.
   Use ponto decimal: 11,74% -> 11.74.
4. "imposto_devido", "base_calculo" e "rendimentos_tributaveis" tambem sao os do
   modelo escolhido no item 2. Se o documento nao trouxer o campo, use null.
5. "categorias_pagamentos" so lista o que aparece na ficha PAGAMENTOS EFETUADOS
   com valor informado. Ficha vazia -> lista vazia. Mapeie:
   despesas medicas, plano de saude, hospital -> SAUDE
   instrucao, escola, faculdade -> EDUCACAO
   previdencia complementar, PGBL -> PREVIDENCIA
   advogados, contadores, engenheiros e afins -> SERVICOS_PROFISSIONAIS
   qualquer outro -> OUTROS
6. Sem inventar: campo ausente no documento e null.`;

const MODELOS_VALIDOS = ["SIMPLIFICADO", "COMPLETO"];
const CONFIANCAS_VALIDAS = ["ALTA", "MEDIA", "BAIXA"];
const CATEGORIAS_VALIDAS: CategoriaDeclaracao[] = [
  "SAUDE",
  "EDUCACAO",
  "PREVIDENCIA",
  "SERVICOS_PROFISSIONAIS",
  "OUTROS",
];

export type ResultadoExtracao =
  | { status: "ok"; dados: DeclaracaoExtraida }
  | { status: "nao_e_declaracao" }
  | { status: "invalida"; motivo: string };

/**
 * Le a resposta do modelo e decide se ela vira linha no banco.
 *
 * Recusa em vez de gravar quando falta o que da sentido ao registro: ano e
 * modelo. Sem ano nao ha chave; sem modelo nao da para dizer de qual bloco veio
 * a aliquota, e gravar a aliquota errada e pior do que nao gravar nada — ela
 * vira estimativa apresentada ao usuario.
 *
 * Aceita `aliquota_efetiva` nula: o registro ainda serve para a pergunta de
 * categoria do ano anterior, que nao depende de aliquota nenhuma.
 */
export function interpretarExtracao(bruto: string | null | undefined): ResultadoExtracao {
  if (!bruto) return { status: "invalida", motivo: "RESPOSTA_VAZIA" };

  const bloco = bruto.match(/<declaracao>([\s\S]*?)<\/declaracao>/);
  // Fallback para cerca de codigo: o modelo respeita a tag depois da instrucao
  // reforcada, mas um parser que so aceita a tag transforma um desvio de
  // formato numa falha silenciosa de produto.
  const json = bloco
    ? bloco[1].trim()
    : (bruto.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim() ??
      (bruto.trim().startsWith("{") ? bruto.trim() : null));

  if (!json) return { status: "invalida", motivo: "SEM_BLOCO_JSON" };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { status: "invalida", motivo: "JSON_INVALIDO" };
  }

  if (parsed.e_declaracao_irpf !== true) return { status: "nao_e_declaracao" };

  const ano = numeroOuNulo(parsed.ano_calendario);
  if (ano === null || !Number.isInteger(ano) || ano < 1900 || ano > new Date().getFullYear() + 1) {
    return { status: "invalida", motivo: "ANO_AUSENTE_OU_IMPLAUSIVEL" };
  }

  const modelo = typeof parsed.modelo === "string" ? parsed.modelo.toUpperCase() : null;
  if (!modelo || !MODELOS_VALIDOS.includes(modelo)) {
    return { status: "invalida", motivo: "MODELO_AUSENTE" };
  }

  const aliquota = numeroOuNulo(parsed.aliquota_efetiva);
  const confianca = typeof parsed.confianca === "string" ? parsed.confianca.toUpperCase() : "MEDIA";

  return {
    status: "ok",
    dados: {
      ano_calendario: ano,
      modelo: modelo as "SIMPLIFICADO" | "COMPLETO",
      // Aliquota fora de 0-100 e leitura errada, nao dado: a constraint da
      // migration recusaria e derrubaria o import inteiro.
      aliquota_efetiva: aliquota !== null && aliquota >= 0 && aliquota <= 100 ? aliquota : null,
      imposto_devido: naoNegativoOuNulo(parsed.imposto_devido),
      base_calculo: naoNegativoOuNulo(parsed.base_calculo),
      rendimentos_tributaveis: naoNegativoOuNulo(parsed.rendimentos_tributaveis),
      categorias_pagamentos: Array.isArray(parsed.categorias_pagamentos)
        ? [
          ...new Set(
            parsed.categorias_pagamentos
              .map((c) => String(c).toUpperCase())
              .filter((c): c is CategoriaDeclaracao =>
                (CATEGORIAS_VALIDAS as string[]).includes(c)
              ),
          ),
        ]
        : [],
      pagamentos_detalhados: Array.isArray(parsed.pagamentos_detalhados)
        ? parsed.pagamentos_detalhados.slice(0, 40)
        : [],
      confianca: (CONFIANCAS_VALIDAS.includes(confianca) ? confianca : "MEDIA") as
        | "ALTA"
        | "MEDIA"
        | "BAIXA",
      motivos_revisao: Array.isArray(parsed.motivos_revisao)
        ? parsed.motivos_revisao.map((m) => String(m)).slice(0, 10)
        : [],
    },
  };
}

function numeroOuNulo(valor: unknown): number | null {
  if (typeof valor === "number" && Number.isFinite(valor)) return valor;
  if (typeof valor === "string" && valor.trim()) {
    const n = Number(valor.replace(/\./g, "").replace(",", "."));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function naoNegativoOuNulo(valor: unknown): number | null {
  const n = numeroOuNulo(valor);
  return n !== null && n >= 0 ? n : null;
}

/**
 * Como o ano de uma declaracao aparece para o usuario: SEMPRE os dois numeros.
 *
 * "Declaracao de 2025" e ambiguo e a ambiguidade nao e teorica — e a mesma que
 * derruba o simulador oficial da Receita, onde a aba mensal pergunta
 * "Ano-calendario" e a anual pergunta "Exercicio", as duas batem no mesmo
 * endpoint, e quem le um numero solto puxa a tabela do ano errado sem nenhum
 * sintoma (o caso esta escrito em AGENTS.md, secao do calculo do IRPF).
 *
 * Aqui o estrago seria do mesmo tipo: a pessoa confere "declaracao de 2025"
 * contra o PDF que ela entregou EM 2025 — que e o ano-calendario 2024 — e
 * conclui que importamos o arquivo errado. O que guardamos e sempre o
 * ano-calendario; o exercicio e ele mais um, e so existe no texto para remover
 * a duvida.
 */
export function rotuloAnoDeclaracao(anoCalendario: number): string {
  return `ano-calendário ${anoCalendario}, exercício ${anoCalendario + 1}`;
}

/** Confirmacao do import. Diz o que foi lido para a pessoa poder discordar —
 *  numero extraido de PDF que ninguem confere e numero que ninguem audita. */
export function mensagemDeclaracaoImportada(dados: DeclaracaoExtraida): string {
  const partes = [
    `Importei sua declaração de ${rotuloAnoDeclaracao(dados.ano_calendario)}. ` +
    "O PDF já foi descartado; guardei só o resumo:",
  ];

  const linhas = [
    `• Modelo: ${dados.modelo === "SIMPLIFICADO" ? "desconto simplificado" : "todas as deduções (completa)"}`,
  ];
  if (dados.aliquota_efetiva !== null) {
    linhas.push(`• Alíquota efetiva: ${formatarPercentual(dados.aliquota_efetiva)}`);
  }
  if (dados.categorias_pagamentos.length > 0) {
    linhas.push(`• Deduções declaradas: ${dados.categorias_pagamentos.map(rotuloCategoria).join(", ")}`);
  } else {
    linhas.push("• Deduções declaradas: nenhuma na ficha de Pagamentos Efetuados");
  }
  partes.push(linhas.join("\n"));

  partes.push(
    "A partir de agora, quando você pedir *resumo*, eu comparo com esse histórico e te mostro uma estimativa do que as despesas deste ano podem representar.",
  );

  if (dados.confianca === "BAIXA") {
    partes.push("Alguns campos ficaram difíceis de ler. Se algum número acima estiver errado, me avisa que eu refaço.");
  }

  return partes.join("\n\n");
}

const ROTULOS_CATEGORIA: Record<CategoriaDeclaracao, string> = {
  SAUDE: "saúde",
  EDUCACAO: "educação",
  PREVIDENCIA: "previdência",
  SERVICOS_PROFISSIONAIS: "serviços profissionais",
  OUTROS: "outros",
};

export function rotuloCategoria(categoria: CategoriaDeclaracao): string {
  return ROTULOS_CATEGORIA[categoria] ?? String(categoria).toLowerCase();
}

/**
 * Categorias do ano anterior que valem uma pergunta no resumo.
 *
 * So SAUDE e EDUCACAO. As duas sao a ficha "Pagamentos Efetuados" propriamente
 * dita e mapeiam 1 para 1 no enum categoria_fiscal, entao "apareceu la e nao
 * aparece aqui" e uma comparacao que se sustenta.
 *
 * PREVIDENCIA nao entra porque o TaxMind nao registra contribuicao de
 * previdencia (nao e despesa que chega por recibo no WhatsApp), e perguntar
 * "voce nao registrou previdencia" seria cobrar algo que o produto nem aceita.
 * SERVICOS_PROFISSIONAIS e OUTROS nao entram porque na ficha de Pagamentos eles
 * sao majoritariamente pensao alimenticia e acao judicial, que nao sao a mesma
 * coisa que a categoria homonima do nosso enum — a comparacao seria entre
 * rotulos parecidos com significados diferentes.
 */
export const CATEGORIAS_ACOMPANHADAS: CategoriaDeclaracao[] = ["SAUDE", "EDUCACAO"];

export type TotalPorCategoria = { categoria: string; total: number; total_dedutivel: number };

/**
 * Categorias que apareceram na declaracao e nao tem NENHUM registro este ano.
 *
 * "Nenhum registro" e proposital: basta uma despesa registrada na categoria
 * para a pergunta perder sentido. Nao comparamos VALOR — o ano ainda esta
 * correndo, e cobrar volume seria afirmar que a pessoa esta atrasada.
 */
export function categoriasSemRegistroEsteAno(
  declaradas: CategoriaDeclaracao[],
  totaisDoAno: TotalPorCategoria[],
): CategoriaDeclaracao[] {
  const comRegistro = new Set(
    totaisDoAno
      .filter((linha) => Number(linha.total) > 0)
      .map((linha) => String(linha.categoria).toUpperCase()),
  );

  return declaradas
    .filter((c) => CATEGORIAS_ACOMPANHADAS.includes(c))
    .filter((c) => !comRegistro.has(c));
}

export type EstimativaEconomia = {
  valor: number;
  metodo: "MOTOR_IRPF" | "ALIQUOTA_EFETIVA";
  anoBase: number;
  /** A economia parou de crescer porque o redutor do ano-base ja zerava o
   *  imposto. So o metodo MOTOR_IRPF sabe disso. */
  limitadaPeloRedutor: boolean;
};

/**
 * Quanto o dedutivel acumulado deste ano representaria de imposto a menos.
 *
 * DOIS METODOS, e a diferenca entre eles importa:
 *
 *   MOTOR_IRPF — quando o PDF trouxe rendimentos tributaveis e o ano-base esta
 *   parametrizado, a conta passa pelo motor real (tabela progressiva + redutor,
 *   com o teto do §1o). E o unico jeito de a estimativa dizer ZERO para quem ja
 *   estava zerado, em vez de prometer economia que nao existe.
 *
 *   ALIQUOTA_EFETIVA — fallback quando falta rendimento ou parametro do ano:
 *   dedutivel x aliquota efetiva do ano anterior. E o que a especificacao pede,
 *   e e conservador por construcao (a aliquota efetiva e menor que a marginal),
 *   mas ignora o redutor.
 *
 * Nos dois casos o numero e ESTIMATIVA sobre dado historico, e a mensagem diz
 * isso. Devolve null quando nao da para estimar nada — silencio e melhor que
 * numero inventado.
 */
export function estimarEconomia(
  declaracao: {
    ano_calendario: number;
    aliquota_efetiva: number | null;
    rendimentos_tributaveis: number | null;
    base_calculo: number | null;
  },
  totalDedutivelAcumulado: number,
): EstimativaEconomia | null {
  if (!(totalDedutivelAcumulado > 0)) return null;

  const rendimentos = declaracao.rendimentos_tributaveis;
  if (rendimentos !== null && rendimentos > 0 && parametrosDoAno(declaracao.ano_calendario)) {
    // Deducoes ja consideradas naquele ano: o que separa rendimento de base.
    const deducoesBase = declaracao.base_calculo !== null
      ? Math.max(0, rendimentos - declaracao.base_calculo)
      : 0;

    const calculo: EconomiaEstimada | null = economiaPorDeducao(
      declaracao.ano_calendario,
      rendimentos,
      deducoesBase,
      totalDedutivelAcumulado,
    );

    if (calculo) {
      return {
        valor: calculo.economia,
        metodo: "MOTOR_IRPF",
        anoBase: declaracao.ano_calendario,
        limitadaPeloRedutor: calculo.limitadaPeloRedutor,
      };
    }
  }

  if (declaracao.aliquota_efetiva === null || declaracao.aliquota_efetiva <= 0) return null;

  return {
    valor: Math.round(totalDedutivelAcumulado * (declaracao.aliquota_efetiva / 100) * 100) / 100,
    metodo: "ALIQUOTA_EFETIVA",
    anoBase: declaracao.ano_calendario,
    limitadaPeloRedutor: false,
  };
}

function formatarReais(valor: number): string {
  return `R$ ${valor.toFixed(2).replace(".", ",")}`;
}

function formatarPercentual(valor: number): string {
  return `${valor.toFixed(2).replace(".", ",")}%`;
}

/**
 * Linhas que a declaracao anterior acrescenta ao resumo.
 *
 * DUAS REGRAS QUE NAO PODEM SER AFROUXADAS
 *
 * 1. A comparacao de categoria sai como PERGUNTA, nunca como afirmacao. O
 *    sistema nao sabe se a pessoa nao teve o gasto ou so nao mandou o
 *    comprovante, e afirmar qualquer um dos dois e errar metade das vezes com
 *    tom de cobranca.
 * 2. A estimativa vem sempre com a ressalva de que e historico. A aliquota (ou
 *    o rendimento) e do ano passado; o ano corrente pode ter outra renda, e a
 *    lei mudou no meio do caminho.
 *
 * Sai vazio quando nao ha o que dizer — resumo sem declaracao importada
 * continua byte a byte o de antes.
 */
export function complementoDoResumo(
  declaracao: {
    ano_calendario: number;
    aliquota_efetiva: number | null;
    rendimentos_tributaveis: number | null;
    base_calculo: number | null;
    categorias_pagamentos: CategoriaDeclaracao[];
  } | null,
  totaisDoAno: TotalPorCategoria[],
  totalDedutivelAcumulado: number,
): string[] {
  if (!declaracao) return [];

  const partes: string[] = [];

  const estimativa = estimarEconomia(declaracao, totalDedutivelAcumulado);
  if (estimativa) {
    if (estimativa.valor > 0) {
      partes.push(
        `Comparando com sua declaração de ${rotuloAnoDeclaracao(estimativa.anoBase)}: ` +
          "o que você já registrou este ano " +
          `representaria cerca de ${formatarReais(estimativa.valor)} a menos de imposto. ` +
          "É uma estimativa baseada no seu histórico, não uma garantia deste ano — sua renda e as regras podem ter mudado.",
      );
    } else if (estimativa.metodo === "MOTOR_IRPF") {
      // Zero calculado pelo motor e informacao, nao ausencia: e o caso de quem
      // ja estava isento. Omitir deixaria a pessoa esperando um retorno que nao
      // vem.
      partes.push(
        `Pelos números da sua declaração de ${rotuloAnoDeclaracao(estimativa.anoBase)}, ` +
          "seu imposto já ficava zerado — " +
          "então essas deduções não mudariam o valor a pagar. Continuo registrando tudo para o seu contador conferir.",
      );
    }
  }

  const ausentes = categoriasSemRegistroEsteAno(declaracao.categorias_pagamentos, totaisDoAno);
  if (ausentes.length > 0) {
    const lista = ausentes.map(rotuloCategoria).join(" e ");
    const plural = ausentes.length > 1;
    partes.push(
      `Uma pergunta: na sua declaração de ${rotuloAnoDeclaracao(declaracao.ano_calendario)} ` +
        `você declarou despesa de ${lista}, e este ano eu ainda não ` +
        `registrei nada ${plural ? "nessas categorias" : "nessa categoria"}. ` +
        "Foi só não ter guardado o comprovante ainda, ou não teve esse gasto este ano?",
    );
  }

  return partes;
}

// ---------------------------------------------------------------------------
// Salto de valor ano a ano (Fase 18)
// ---------------------------------------------------------------------------
//
// A comparacao mora AQUI, e nao em _shared/pontos_atencao.ts, por dois motivos:
//
//   1. e a mesma familia de categoriasSemRegistroEsteAno logo acima — as duas
//      confrontam o ano corrente com a ficha do ano-base, e as duas dependem de
//      CATEGORIAS_ACOMPANHADAS. Separar deixaria duas nocoes de "categoria
//      comparavel" em arquivos diferentes;
//   2. este modulo arrasta o motor de IRPF e o modulo de follow-up para o bundle
//      de quem o importa. A export-contador importa pontos_atencao.ts so pelas
//      marcas por item; se a comparacao estivesse la, a planilha do contador
//      passaria a carregar a tabela progressiva do IRPF e a exigir redeploy a
//      cada mudanca de parametro fiscal — a dependencia invisivel de docs/09.
//
// Quem monta o bloco final e linhasPontosAtencao, que recebe daqui os itens ja
// redigidos.

/**
 * Quantas vezes o valor do ano-base o total deste ano precisa alcancar para o
 * salto ser reportado.
 *
 * O numero do TaxMind e PARCIAL por construcao: so entra o que a pessoa mandou.
 * No banco real, 18 das 21 despesas de saude do usuario principal ainda estavam
 * sem resposta de reembolso — cobertura incompleta e o estado normal, nao a
 * excecao. Um aumento pequeno e muito mais provavel ser cobertura melhorando do
 * que gasto saltando, e dobrar e o menor multiplo que nao se explica por
 * inflacao nem por uma consulta a mais no ano.
 */
export const FATOR_SALTO = 2;

/**
 * Fracao dos rendimentos tributaveis do ano-base a partir da qual o AUMENTO
 * absoluto e material.
 *
 * Ancorado na renda declarada, e nao num valor fixo em reais, por dois motivos:
 *
 *   - o repositorio ja rejeitou hardcodar cifra fiscal que muda todo ano (ver a
 *     NOTA_PAGAMENTOS da export-contador, que remete o teto de educacao ao
 *     contador em vez de imprimir um numero que envelhece);
 *   - o que chama conferencia nao e o valor absoluto da deducao, e a
 *     desproporcao dela em relacao a renda. 5% da renda em uma categoria so e
 *     uma linha material no ajuste; R$ 5.000 pode ser muito ou irrelevante
 *     dependendo de quem declara.
 *
 * As duas condicoes valem JUNTAS. So a razao marcaria R$ 100 -> R$ 400; so o
 * absoluto marcaria a variacao normal de quem ganha muito.
 */
export const FRACAO_RENDA_MATERIAL = 0.05;

export type BaselineDeclaracao = {
  ano_calendario: number;
  categorias_pagamentos: CategoriaDeclaracao[];
  pagamentos_detalhados: Array<{ codigo?: string; descricao?: string; valor?: number }>;
  rendimentos_tributaveis: number | null;
  base_calculo: number | null;
};

/**
 * Codigos da ficha "Pagamentos Efetuados" que mapeiam nas duas categorias
 * acompanhadas.
 *
 * O codigo vem primeiro porque e o identificador estavel do formulario; a
 * descricao e fallback porque a extracao le o que esta escrito no PDF, e o
 * texto varia ("Despesas medicas no Brasil", "Plano de saude no Brasil").
 */
const CODIGOS_FICHA: Readonly<Record<string, CategoriaDeclaracao>> = {
  "01": "EDUCACAO", // Instrucao no Brasil
  "02": "EDUCACAO", // Instrucao no exterior
  "10": "SAUDE", // Despesas medicas no Brasil
  "11": "SAUDE", // Plano de saude no Brasil
  "21": "SAUDE", // Despesas medicas no exterior
  "26": "SAUDE", // Reembolso de despesa medica
};

const TERMOS_SAUDE = [
  "medic",
  "médic",
  "saude",
  "saúde",
  "plano de",
  "hospital",
  "odonto",
  "dentist",
  "psic",
  "fisioterap",
];

const TERMOS_EDUCACAO = [
  "instru",
  "escola",
  "faculdade",
  "ensino",
  "educa",
  "universi",
  "creche",
];

function categoriaDoPagamento(
  item: { codigo?: string; descricao?: string },
): CategoriaDeclaracao | null {
  const codigo = String(item.codigo ?? "").trim().padStart(2, "0");
  if (CODIGOS_FICHA[codigo]) return CODIGOS_FICHA[codigo];

  const descricao = String(item.descricao ?? "").toLowerCase();
  if (!descricao) return null;
  if (TERMOS_SAUDE.some((t) => descricao.includes(t))) return "SAUDE";
  if (TERMOS_EDUCACAO.some((t) => descricao.includes(t))) return "EDUCACAO";
  return null;
}

/**
 * A ficha foi preenchida?
 *
 * ESTE E O GATE MAIS IMPORTANTE DO SINAL, e ele veio do dado real. A unica
 * declaracao importada em producao tem `categorias_pagamentos: []` e
 * `pagamentos_detalhados: []` — modelo SIMPLIFICADO, ficha nao itemizada. Ou
 * seja: ausencia de categoria na declaracao NAO e evidencia de ausencia de
 * gasto, e tratar como se fosse marcaria toda despesa de saude de quem usou o
 * desconto simplificado no ano passado.
 *
 * Gatear pela ficha, e nao pelo `modelo`, e mais preciso: ficha preenchida sem
 * saude e informativa mesmo numa declaracao simplificada (a pessoa itemizou e a
 * categoria nao estava la), e ficha vazia nao informa nada nem na completa.
 */
export function fichaPreenchida(baseline: BaselineDeclaracao | null): boolean {
  if (!baseline) return false;
  return (baseline.categorias_pagamentos?.length ?? 0) > 0 ||
    (baseline.pagamentos_detalhados?.length ?? 0) > 0;
}

/** Quanto o ano-base declarou em cada categoria acompanhada. Categoria fora do
 *  mapa fica de fora — nao ha como comparar o que nao se sabe somar. */
export function valorDeclaradoPorCategoria(
  baseline: BaselineDeclaracao | null,
): Map<CategoriaDeclaracao, number> {
  const mapa = new Map<CategoriaDeclaracao, number>();
  if (!baseline) return mapa;

  for (const item of baseline.pagamentos_detalhados ?? []) {
    const categoria = categoriaDoPagamento(item);
    if (!categoria) continue;
    const valor = Number(item.valor);
    if (!Number.isFinite(valor) || valor <= 0) continue;
    mapa.set(categoria, (mapa.get(categoria) ?? 0) + valor);
  }

  return mapa;
}

/**
 * Renda de referencia do ano-base para o teste de materialidade.
 *
 * `rendimentos_tributaveis` primeiro porque e o denominador certo;
 * `base_calculo` como aproximacao quando o PDF nao trouxe o primeiro. Sem
 * nenhum dos dois devolve null e o sinal fica em silencio — a mesma postura de
 * `estimarEconomia`, que prefere nao dizer nada a inventar numero.
 */
export function rendaDeReferencia(baseline: BaselineDeclaracao | null): number | null {
  if (!baseline) return null;
  const rendimentos = baseline.rendimentos_tributaveis;
  if (rendimentos !== null && rendimentos > 0) return rendimentos;
  const base = baseline.base_calculo;
  if (base !== null && base > 0) return base;
  return null;
}

export type SaltoAnoAAno = {
  categoria: CategoriaDeclaracao;
  valorEsteAno: number;
  /** null no caso SEM_HISTORICO: a categoria nao apareceu na ficha do ano-base. */
  valorAnoBase: number | null;
  anoBase: number;
  tipo: "SALTO" | "SEM_HISTORICO";
};

/**
 * Categorias cujo dedutivel deste ano destoa do que a declaracao do ano-base
 * mostrou.
 *
 * Restrito a SAUDE e EDUCACAO por CATEGORIAS_ACOMPANHADAS, cujo raciocinio esta
 * logo acima: sao as duas que mapeiam 1 para 1 no enum categoria_fiscal, e
 * comparar as outras seria comparar rotulos parecidos com significados
 * diferentes.
 *
 * A comparacao e ASSIMETRICA de proposito: o lado de ca e o dedutivel LIQUIDO
 * do reembolso, o lado de la e o valor PAGO informado na ficha. A assimetria
 * puxa o nosso numero para baixo, entao ela faz o criterio sub-disparar, nunca
 * sobre-disparar — que e o erro barato dos dois.
 */
export function detectarSaltos(
  baseline: BaselineDeclaracao | null,
  totaisCategoria: Array<{ categoria: string; total_dedutivel: number | string }>,
): SaltoAnoAAno[] {
  if (!baseline) return [];

  const renda = rendaDeReferencia(baseline);
  if (renda === null) return [];

  const material = renda * FRACAO_RENDA_MATERIAL;
  const declarado = valorDeclaradoPorCategoria(baseline);
  const temFicha = fichaPreenchida(baseline);

  const saltos: SaltoAnoAAno[] = [];

  for (const categoria of CATEGORIAS_ACOMPANHADAS) {
    const linha = (totaisCategoria ?? []).find(
      (l) => String(l.categoria).toUpperCase() === categoria,
    );
    const esteAno = Number(linha?.total_dedutivel ?? 0);
    if (!(esteAno > 0)) continue;

    const anoBase = declarado.get(categoria) ?? null;

    if (anoBase === null) {
      // Sem historico: so vale quando a ficha FOI preenchida. Ficha vazia nao
      // distingue "nao teve o gasto" de "nao itemizou".
      if (!temFicha) continue;
      if (esteAno < material) continue;
      saltos.push({
        categoria,
        valorEsteAno: esteAno,
        valorAnoBase: null,
        anoBase: baseline.ano_calendario,
        tipo: "SEM_HISTORICO",
      });
      continue;
    }

    if (esteAno < anoBase * FATOR_SALTO) continue;
    if (esteAno - anoBase < material) continue;

    saltos.push({
      categoria,
      valorEsteAno: esteAno,
      valorAnoBase: anoBase,
      anoBase: baseline.ano_calendario,
      tipo: "SALTO",
    });
  }

  return saltos;
}

/**
 * Os itens de salto ja redigidos, SEM o marcador de lista — quem monta o bloco
 * e `linhasPontosAtencao`.
 *
 * O texto e descritivo, nunca acusatorio: ele poe os dois numeros lado a lado e
 * para por ai. O sistema nao sabe se o gasto realmente cresceu ou se o ano
 * passado e que estava sub-registrado, e afirmar qualquer um dos dois seria
 * errar metade das vezes com tom de cobranca — a mesma regra que faz a
 * comparacao de categoria sair como pergunta em `complementoDoResumo`.
 */
/**
 * Reais COM separador de milhar.
 *
 * Existe ao lado de `formatarReais` (que nao tem separador) de proposito, e a
 * duplicacao e a escolha menos ruim entre tres:
 *
 *   - usar `formatarReais` aqui entregaria "R$ 30000,00" numa mensagem cujos
 *     totais, escritos pelo Code node "Formatar Resumo", saem como
 *     "R$ 30.000,00". Os dois formatos apareceriam no MESMO texto;
 *   - trocar `formatarReais` mudaria a frase de estimativa de economia da fase
 *     17, que ja esta em producao e nao faz parte desta mudanca.
 *
 * Os valores desta fase sao totais anuais por categoria, entao passam de mil
 * com frequencia; os da estimativa raramente passam, que e por que a falta de
 * separador la nunca incomodou.
 */
function formatarReaisComMilhar(valor: number): string {
  return `R$ ${
    valor.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }`;
}

export function itensDeSaltoAnoAAno(
  baseline: BaselineDeclaracao | null,
  totaisCategoria: Array<{ categoria: string; total_dedutivel: number | string }>,
): string[] {
  return detectarSaltos(baseline, totaisCategoria).map((salto) => {
    const rotulo = rotuloCategoria(salto.categoria);
    const nome = rotulo.charAt(0).toUpperCase() + rotulo.slice(1);

    if (salto.tipo === "SEM_HISTORICO") {
      return `${nome}: ${formatarReaisComMilhar(salto.valorEsteAno)} dedutíveis este ano, ` +
        `e essa categoria não aparece na sua declaração de ${rotuloAnoDeclaracao(salto.anoBase)}`;
    }

    return `${nome}: ${formatarReaisComMilhar(salto.valorEsteAno)} dedutíveis este ano contra ` +
      `${formatarReaisComMilhar(salto.valorAnoBase ?? 0)} na sua declaração de ` +
      rotuloAnoDeclaracao(salto.anoBase);
  });
}
