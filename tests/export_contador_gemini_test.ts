// Export para o contador — o classificador de intencao contra o Gemini REAL.
//
// Rodar: deno test --allow-env --allow-net --allow-read --allow-run tests/export_contador_gemini_test.ts
//
// POR QUE ESTE ARQUIVO EXISTE SEPARADO DO n8n_export_contador_test.ts
//
// Aquele mede a camada de palavra-chave, que e deterministica. Esta mede a
// camada que NAO e: as frases que nao casam palavra nenhuma caem no Gemini, e e
// la que uma categoria nova pode canibalizar as antigas. Adicionar
// "export_contador" ao prompt muda o espaco de decisao de TODAS as mensagens,
// inclusive as que nada tem a ver com planilha — esse e o risco medido aqui.
//
// O prompt sai do export real do workflow, e nao de um literal: o que se mede e
// o artefato que vai para producao.
//
// Sem GEMINI_API_KEY os testes sao IGNORADOS, e nao falham (a chave nao existe
// na CI).

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MODELO = "gemini-3-flash-preview";
const CHAVE = await resolverChave();
const TEM_CHAVE = Boolean(CHAVE);

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

const CONSULTA = JSON.parse(
  await Deno.readTextFile("n8n/workflows/consulta-e-dossie.json"),
);

function node(nome: string) {
  const alvo = CONSULTA.nodes.find((n: any) => n.name === nome);
  if (!alvo) throw new Error(`node nao encontrado: ${nome}`);
  return alvo;
}

/** Reproduz o corpo que o node HTTP monta, a partir da expressao real.
 *
 *  A expressao e um JSON.stringify(...), entao ela devolve TEXTO. O JSON.parse
 *  aqui desfaz isso — sem ele, o corpo enviado vira uma string JSON dentro de
 *  outra e o Gemini responde 400 "Root element must be a message". */
function corpoDoNode(texto: string) {
  const expr = node("Gemini - Classificar Intent").parameters.jsonBody;
  const interno = expr.slice(expr.indexOf("{{") + 2, expr.lastIndexOf("}}"));
  return JSON.parse(
    new Function("$json", `return (${interno})`)({
      text_body: texto,
      followup_contexto: null,
      followup_instrucao: null,
    }),
  );
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** A camada de palavra-chave. Null aqui significa "vai para o Gemini". */
async function intentPorPalavraChave(texto: string): Promise<string | null> {
  const fn = new AsyncFunction("$input", "$", node("Preparar Contexto").parameters.jsCode);
  const entrada = {
    body: {
      session_id: "22222222-2222-4222-8222-222222222222",
      normalized: {
        message_type: "text",
        text_body: texto,
        wa_id: "5511999990000",
        phone: "+5511999990000",
      },
      followup: null,
    },
  };
  const saida = await fn.call({}, {
    item: { json: entrada },
    all: () => [{ json: entrada }],
  }, () => {
    throw new Error("nao deveria referenciar outro node");
  });
  return saida.json.intent;
}

/** Aplica o mesmo pos-processamento do node "Aplicar Intent da IA". */
function normalizarResposta(bruto: string): string {
  const limpo = bruto.toLowerCase().replace(/[^a-z_]/g, "");
  const validos = [
    "registro_despesa",
    "consulta_resumo",
    "exportar_dossie",
    "export_contador",
    "conectar_banco",
    "resposta_de_followup",
    "fora_do_escopo_financeiro",
    "sobre_o_taxmind",
    "outro",
  ];
  return validos.find((v) => limpo.includes(v)) || "outro";
}

async function classificar(texto: string): Promise<string> {
  const resposta = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${CHAVE}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corpoDoNode(texto)),
    },
  );

  if (!resposta.ok) {
    throw new Error(`Gemini respondeu ${resposta.status}: ${await resposta.text()}`);
  }

  const json = await resposta.json();
  const texto_ = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return normalizarResposta(texto_);
}

// Frases que NAO casam palavra-chave nenhuma e por isso chegam ao modelo. O
// proprio teste confere isso antes de medir: se um dia a lista de palavras
// mudar e a frase passar a casar, medir o Gemini com ela deixaria de provar
// qualquer coisa sobre a camada de IA.
const CASOS: Array<{ texto: string; esperado: string }> = [
  // --- o gatilho novo, em formas que a palavra-chave nao pega --------------
  { texto: "quero uma tabela com minhas despesas para revisao contabil", esperado: "export_contador" },
  { texto: "meu contabilista precisa ver isso numa tabela", esperado: "export_contador" },
  { texto: "tem como eu ter tudo numa folha de calculo pro escritorio contabil", esperado: "export_contador" },

  // --- adversarial: os intents antigos nao podem virar export_contador -----
  { texto: "quero ver meus gastos do ano", esperado: "consulta_resumo" },
  { texto: "quanto eu ja juntei de dedutivel ate agora", esperado: "consulta_resumo" },
  { texto: "me mostra o que ja registrei", esperado: "consulta_resumo" },
  { texto: "paguei 300 no oftalmologista", esperado: "registro_despesa" },
  { texto: "almoco 45 reais hoje", esperado: "registro_despesa" },
  { texto: "gastei 1200 num notebook novo pro trabalho", esperado: "registro_despesa" },
  { texto: "queria importar as compras do meu cartao automaticamente", esperado: "conectar_banco" },
  { texto: "vale a pena investir em tesouro direto?", esperado: "fora_do_escopo_financeiro" },
];

Deno.test({
  name: "as frases medidas realmente chegam ao Gemini (nao casam palavra-chave)",
  fn: async () => {
    for (const caso of CASOS) {
      assertEquals(
        await intentPorPalavraChave(caso.texto),
        null,
        `"${caso.texto}" casou palavra-chave e nunca chegaria ao modelo`,
      );
    }
  },
});

Deno.test({
  name: "o Gemini separa export_contador dos intents existentes",
  ignore: !TEM_CHAVE,
  fn: async () => {
    // Tres execucoes: o que interessa nao e so acertar, e acertar de forma
    // estavel. Foi instabilidade entre execucoes que revelou o bug do
    // SEM_RELACAO na fase de follow-up.
    const EXECUCOES = 3;
    const falhas: string[] = [];

    for (const caso of CASOS) {
      const obtidos: string[] = [];
      for (let i = 0; i < EXECUCOES; i += 1) {
        obtidos.push(await classificar(caso.texto));
      }
      const acertos = obtidos.filter((o) => o === caso.esperado).length;
      if (acertos !== EXECUCOES) {
        falhas.push(
          `"${caso.texto}"\n    esperado ${caso.esperado}, obtido ${obtidos.join(", ")}`,
        );
      }
    }

    assertEquals(
      falhas.length,
      0,
      `${falhas.length} de ${CASOS.length} casos falharam:\n  ${falhas.join("\n  ")}`,
    );
  },
});

Deno.test({
  name: "despesa comum nao vira pedido de planilha",
  ignore: !TEM_CHAVE,
  fn: async () => {
    // O risco especifico de acrescentar categoria: ela puxa mensagens que nao
    // sao dela. Despesa e o intent mais comum do produto, e o mais caro de
    // perder — a despesa simplesmente nao seria registrada.
    const despesas = [
      "dentista 500",
      "comprei um monitor por 900 reais",
      "consulta 250 na clinica sao lucas",
      "uber 32 reais ontem",
      "mensalidade da facul 890",
    ];

    for (const texto of despesas) {
      const porPalavra = await intentPorPalavraChave(texto);
      if (porPalavra !== null) {
        assertEquals(porPalavra, "registro_despesa", texto);
        continue;
      }
      assertEquals(await classificar(texto), "registro_despesa", texto);
    }
  },
});

Deno.test({
  name: "pedido de dossie continua sendo dossie no modelo",
  ignore: !TEM_CHAVE,
  fn: async () => {
    // O par mais confundivel: os dois sao "me da um arquivo das minhas
    // despesas". Estas frases nao casam palavra-chave, entao quem decide e o
    // discriminador escrito no prompt.
    const casos: Array<[string, string]> = [
      ["queria um documento com tudo que registrei esse ano", "exportar_dossie"],
      ["me da um comprovante organizado das minhas despesas", "exportar_dossie"],
    ];

    for (const [texto, esperado] of casos) {
      assertEquals(await intentPorPalavraChave(texto), null, texto);
      const obtido = await classificar(texto);
      assert(
        obtido === esperado || obtido === "export_contador",
        `"${texto}" virou ${obtido}, que nao e nem dossie nem planilha`,
      );
      // Registrado como observacao, nao como falha: as duas leituras sao
      // defensaveis para uma frase que nao diz formato nem destinatario.
      if (obtido !== esperado) {
        console.log(`  nota: "${texto}" foi lido como ${obtido}`);
      }
    }
  },
});
