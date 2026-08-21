// Fase 12 - o prompt de classificacao contra o Gemini de verdade.
//
// Rodar:  deno test --allow-env --allow-net --allow-read tests/prompt_gemini_test.ts
//
// Chama `gemini-3-flash-preview` com o prompt de producao e a mesma montagem de
// entrada do node "Gemini - Classificação Textual" (prompt + data de
// recebimento + mensagem). Sem chave configurada os testes sao ignorados, nao
// falham: a chave vive no .env local e nao existe na CI.
//
// Por que teste contra a API real e nao mock: as duas regras desta fase que
// dependem do prompt — inferir a data em silencio e nunca prometer dinheiro de
// volta — sao comportamento do modelo. Mock provaria so que o texto do prompt
// mudou.
//
// Saida de LLM varia; as assercoes olham os campos estruturados e, na
// linguagem, o que nao pode aparecer. temperature 0.2 e a mesma do workflow.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  derivarCamposBloqueantes,
  montarContextoReclassificacao,
  perguntaParaCampo,
} from "../supabase/functions/_shared/followup.ts";

const CHAVE = await resolverChave();
const MODELO = "gemini-3-flash-preview";
const DATA_REFERENCIA = "2026-08-08";

async function resolverChave(): Promise<string> {
  const doAmbiente = Deno.env.get("GEMINI_API_KEY");
  if (doAmbiente) return doAmbiente;

  try {
    const arquivo = await Deno.readTextFile(".env");
    const linha = arquivo.split("\n").find((l) => l.startsWith("GEMINI_API_KEY="));
    return linha?.slice("GEMINI_API_KEY=".length).trim() ?? "";
  } catch {
    return "";
  }
}

const fonte = await Deno.readTextFile("backend/prompts/taxmind_system_prompt.js");
const PROMPT: string = eval(fonte.replace("export const", "var") + ";TAXMIND_SYSTEM_PROMPT").trim();

type Classificacao = {
  mensagemUsuario: string;
  expense: Record<string, any>;
};

async function classificar(mensagem: string): Promise<Classificacao> {
  return await gerar(
    `${PROMPT}\n\nData de recebimento da mensagem: ${DATA_REFERENCIA}` +
      `\n\nMensagem do usuário: ${mensagem}`,
  );
}

async function gerar(entrada: string): Promise<Classificacao> {
  const bruto = await gerarTexto(entrada);
  const bloco = bruto.match(/<expense>([\s\S]*?)<\/expense>/);

  // Gemini 3 Flash nao deixa desligar thinking: resposta vazia aqui costuma ser
  // orcamento de tokens consumido pelo thinking, nao prompt quebrado.
  assert(bloco, `resposta sem bloco <expense>: ${bruto.slice(0, 300)}`);

  return {
    mensagemUsuario: bruto.split("<expense>")[0].trim(),
    expense: JSON.parse(bloco![1].trim()),
  };
}

async function gerarTexto(entrada: string): Promise<string> {
  const resposta = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${CHAVE}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: entrada }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingLevel: "low" },
        },
      }),
    },
  );

  // O corpo so pode ser lido uma vez: montar a mensagem do assert com
  // `await resposta.text()` na chamada consumiria o corpo mesmo no caminho
  // feliz, e o erro que aparece e "Body already consumed", que nao tem relacao
  // aparente com a causa.
  if (!resposta.ok) {
    throw new Error(`Gemini respondeu ${resposta.status}: ${await resposta.text()}`);
  }

  const corpo = await resposta.json();
  return corpo?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

const comChave = { ignore: !CHAVE };

Deno.test("mensagem sem referencia temporal: data de hoje, marcada, e SEM revisao humana", comChave, async () => {
  const { expense } = await classificar(
    "Paguei 320 de mensalidade da faculdade Anhembi, CNPJ 12.345.678/0001-90",
  );

  assertEquals(expense.data_despesa, DATA_REFERENCIA);
  assertEquals(expense.data_inferida, true);

  // O ponto central da fase: a marcacao e rastro de auditoria, nao pendencia.
  assertEquals(expense.requer_revisao_humana, false, JSON.stringify(expense.motivos_revisao));
  assertEquals(expense.motivos_revisao, []);
  assertEquals(
    (expense.campos_ausentes ?? []).filter((c: string) => /^data/i.test(c)),
    [],
  );
  // E nao vira pergunta de volta para o usuario.
  assert(!textoNormalizado(expense.pergunta_de_followup ?? "").includes("data"));
});

Deno.test("despesa de saude sem data tambem passa sem revisao", comChave, async () => {
  const { expense } = await classificar(
    "consulta com a dermatologista dra ana, clinica Vida, CNPJ 11.222.333/0001-44, R$ 450",
  );

  assertEquals(expense.data_despesa, DATA_REFERENCIA);
  assertEquals(expense.data_inferida, true);
  assertEquals(expense.requer_revisao_humana, false, JSON.stringify(expense.motivos_revisao));
});

Deno.test("referencia relativa vira data real, sem marcacao de inferencia", comChave, async () => {
  const { expense } = await classificar("ontem gastei 45 no estacionamento do escritorio");

  assertEquals(expense.data_despesa, "2026-08-07");
  assertEquals(expense.data_inferida, false);
});

Deno.test("referencia explicita a um dia do mes e calculada a partir do recebimento", comChave, async () => {
  const { expense } = await classificar("no dia 3 paguei 200 no dentista Dr Souza CRO 12345");

  assertEquals(expense.data_despesa, "2026-08-03");
  assertEquals(expense.data_inferida, false);
});

Deno.test("data escrita por extenso na mensagem e preservada", comChave, async () => {
  const { expense } = await classificar("paguei 1200 de plano de saude da Unimed em 15/07/2026");

  assertEquals(expense.data_despesa, "2026-07-15");
  assertEquals(expense.data_inferida, false);
});

Deno.test("despesa dedutivel nao e apresentada como dinheiro de volta", comChave, async () => {
  const { mensagemUsuario, expense } = await classificar(
    "consulta com a dermatologista dra ana, clinica Vida, CNPJ 11.222.333/0001-44, R$ 450",
  );

  assertEquals(expense.deducibilidade, "DEDUTIVEL");
  const mensagem = textoNormalizado(mensagemUsuario);
  const tecnica = textoNormalizado(expense.mensagem_usuario ?? "");

  for (const saida of [mensagem, tecnica]) {
    assert(saida.includes("base de calculo"), `sem a explicacao correta: ${saida}`);

    // "recebe de volta" so pode aparecer dentro da negacao de referencia. O
    // resto da frase e vasculhado com ela removida, senao a propria frase
    // correta dispara o alarme.
    const semNegacao = saida.replace(/nao e o valor que voce recebe de volta/g, "");
    assert(!/receb\w* de volta/.test(semNegacao), `promessa de dinheiro de volta: ${saida}`);
    assert(!/de volta (para|pro) (o seu |seu |teu )?bolso/.test(semNegacao), saida);
    assert(!semNegacao.includes("restitui"), `promessa de restituicao: ${saida}`);
    assert(!/economiza \w*\s?r\$/.test(semNegacao), `promessa de economia direta: ${saida}`);
  }
});

// --- Fase 13: campos bloqueantes e reclassificacao ------------------------

Deno.test("falta so o documento: destino declarado e campo derivado", comChave, async () => {
  const { mensagemUsuario, expense } = await classificar(
    "consulta com a dermatologista dra ana, clinica Vida, R$ 450",
  );

  assertEquals(expense.requer_revisao_humana, true);
  // A IA declara so o destino; a lista de campos e derivada do que ficou vazio.
  assert(
    ["DEDUTIVEL", "PARCIALMENTE_DEDUTIVEL"].includes(expense.deducibilidade_se_desbloqueado),
    JSON.stringify(expense.deducibilidade_se_desbloqueado),
  );
  assertEquals(derivarCamposBloqueantes(expense), ["documento_prestador"]);

  // A pergunta e anexada pelo backend, junto com a pendencia. Se a IA
  // perguntasse por conta propria, o usuario responderia para o vazio.
  const mensagem = textoNormalizado(mensagemUsuario);
  assert(!mensagem.includes("?"), `a IA perguntou na mensagem: ${mensagemUsuario}`);
});

Deno.test("revisao por motivo subjetivo nao vira campo bloqueante", comChave, async () => {
  // Uso misto pessoal/profissional nao se resolve com resposta objetiva: e
  // decisao de contador. Perguntar aqui seria atrito sem desfecho. O documento
  // do prestador esta vazio, entao quem segura a pergunta e o destino null — a
  // derivacao nao tem como saber sozinha que o motivo e subjetivo.
  const { expense } = await classificar(
    "paguei 180 de internet residencial da Vivo, uso pra trabalhar tambem",
  );

  assertEquals(expense.requer_revisao_humana, true);
  assertEquals(expense.deducibilidade_se_desbloqueado, null);
  assertEquals(derivarCamposBloqueantes(expense), []);
});

// Regressao da despesa de saude sem NENHUMA identificacao: nem documento nem
// estabelecimento. Era o caso que o desenho anterior nao cobria — a definicao
// pedia o campo que SOZINHO destravaria, e faltando os dois nenhum satisfazia.
// Medido antes da mudanca: 10/10 execucoes com campos_bloqueantes vazio, e
// nenhum follow-up disparado.
//
// Roda a mesma mensagem varias vezes de proposito: o ponto do teste nao e "deu
// certo uma vez", e sim que a saida nao oscila entre execucoes.
Deno.test("saude sem documento e sem estabelecimento: destino estavel entre execucoes", comChave, async () => {
  const EXECUCOES = 5;
  const resultados = await Promise.all(
    Array.from({ length: EXECUCOES }, () => classificar("Paguei 600 no proctologista")),
  );

  for (const [i, { expense }] of resultados.entries()) {
    const contexto = `execucao ${i}: ${
      JSON.stringify({
        destino: expense.deducibilidade_se_desbloqueado,
        estabelecimento: expense.estabelecimento,
        documento: expense.documento_prestador,
        ausentes: expense.campos_ausentes,
      })
    }`;

    assertEquals(expense.categoria, "SAUDE", contexto);
    assertEquals(expense.requer_revisao_humana, true, contexto);
    assert(
      ["DEDUTIVEL", "PARCIALMENTE_DEDUTIVEL"].includes(expense.deducibilidade_se_desbloqueado),
      contexto,
    );
    // documento_prestador tem precedencia: e o unico verificavel sem IA.
    assertEquals(derivarCamposBloqueantes(expense), ["documento_prestador"], contexto);
  }
});

const RECIBO_PENDENTE = {
  descricao: "Consulta medica",
  valor: 450,
  data_despesa: "2026-08-08",
  estabelecimento: "Clinica Vida",
  documento_prestador: null,
  categoria: "SAUDE",
  deducibilidade: "INDETERMINADO",
  motivos_revisao: ["Falta documento do prestador"],
};

const PERGUNTA = perguntaParaCampo("documento_prestador", { estabelecimento: "Clinica Vida" });

Deno.test("resposta em texto livre reclassifica sem reescrever valor e data", comChave, async () => {
  const { expense } = await gerar(
    `${PROMPT}\n\n${
      montarContextoReclassificacao(
        RECIBO_PENDENTE,
        PERGUNTA,
        "nao tenho o CNPJ agora, mas foi uma consulta com psicologa, sessao de terapia mesmo",
      )
    }`,
  );

  assertEquals(expense.valor, 450);
  assertEquals(expense.data_despesa, "2026-08-08");
  assertEquals(expense.categoria, "SAUDE");
  // A evidencia nova e melhor que a original, mas ainda falta o documento:
  // a analise honesta continua pedindo revisao.
  assert(
    expense.requer_revisao_humana === true ||
      derivarCamposBloqueantes(expense).includes("documento_prestador"),
    JSON.stringify({
      revisao: expense.requer_revisao_humana,
      destino: expense.deducibilidade_se_desbloqueado,
    }),
  );
});

Deno.test("mensagem desconexa devolve SEM_RELACAO em vez de reclassificar", comChave, async () => {
  const bruto = await gerarTexto(
    `${PROMPT}\n\n${
      montarContextoReclassificacao(
        RECIBO_PENDENTE,
        PERGUNTA,
        "voces atendem no sabado? queria saber o horario",
      )
    }`,
  );

  assert(bruto.includes("SEM_RELACAO"), `esperava SEM_RELACAO, veio: ${bruto.slice(0, 300)}`);
  assert(!bruto.includes("<expense>"), "reclassificou uma mensagem desconexa");
});

// --- negacao na ABERTURA nao anula a evidencia que vem depois --------------
//
// A regra 2 do SEM_RELACAO lista "nao tenho" como resposta sem conteudo. Ate a
// qualificacao com INTEIRA, uma mensagem que COMECAVA por esse termo e trazia
// evidencia real em seguida caia entre duas instrucoes opostas, e o modelo nao
// escolhia nenhuma das duas: largava a tarefa e respondia com uma apresentacao
// da propria persona, sem <expense> e sem SEM_RELACAO.
//
// Os dois casos abaixo sao a mesma falha com desfechos diferentes, e por isso
// os dois ficam: o primeiro devolvia apresentacao em 13 de 13 execucoes (falha
// barulhenta, quebrava o teste acima), o segundo devolvia SEM_RELACAO 3/3 —
// falha CALADA, que descartava evidencia legitima sem nenhum teste cobrindo.
//
// O contraprova de que a regra 2 continua viva e o teste da mensagem desconexa
// acima mais "resposta seca nao reclassifica", logo abaixo: se a qualificacao
// tivesse afrouxado a regra em vez de delimita-la, aqueles dois quebrariam.

const NEGACAO_COM_EVIDENCIA: Array<[string, string]> = [
  ["servico dito por extenso", "nao tenho o CNPJ agora, mas foi uma consulta com psicologa, sessao de terapia mesmo"],
  ["outra especialidade", "nao tenho o CNPJ agora, mas foi uma consulta com dentista, limpeza mesmo"],
];

for (const [rotulo, mensagem] of NEGACAO_COM_EVIDENCIA) {
  Deno.test(`negacao na abertura nao apaga a evidencia: ${rotulo}`, comChave, async () => {
    const { expense } = await gerar(
      `${PROMPT}\n\n${montarContextoReclassificacao(RECIBO_PENDENTE, PERGUNTA, mensagem)}`,
    );

    // Follow-up nunca reescreve quanto e quando.
    assertEquals(expense.valor, 450, mensagem);
    assertEquals(expense.data_despesa, "2026-08-08", mensagem);
    assertEquals(expense.categoria, "SAUDE", mensagem);

    // O documento continua faltando: a negacao era verdadeira. A evidencia nova
    // melhora a descricao, nao promove a despesa.
    assert(
      expense.requer_revisao_humana === true ||
        derivarCamposBloqueantes(expense).includes("documento_prestador"),
      JSON.stringify({
        mensagem,
        revisao: expense.requer_revisao_humana,
        destino: expense.deducibilidade_se_desbloqueado,
      }),
    );
  });
}

Deno.test("resposta seca continua sem reclassificar, com ou sem negacao", comChave, async () => {
  // O par que delimita a regra pelo outro lado: as duas mensagens estao na
  // lista negra da regra 2 e nao trazem nada alem dela.
  for (const seca of ["nao tenho o CNPJ agora", "ja mando, deixa eu ver aqui"]) {
    const bruto = await gerarTexto(
      `${PROMPT}\n\n${montarContextoReclassificacao(RECIBO_PENDENTE, PERGUNTA, seca)}`,
    );
    assert(bruto.includes("SEM_RELACAO"), `esperava SEM_RELACAO para "${seca}", veio: ${bruto.slice(0, 200)}`);
    assert(!bruto.includes("<expense>"), `reclassificou a resposta seca "${seca}"`);
  }
});

function textoNormalizado(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}
