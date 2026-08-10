// Export estruturado para o contador — roteamento dentro do workflow.
//
// Rodar: deno test --allow-read --allow-run tests/n8n_export_contador_test.ts
//
// Mesmo harness das fases 12 a 15: o jsCode e as expressoes saem do export REAL
// e rodam num arremedo do runtime do n8n, entao o que se exercita aqui e o
// artefato que vai ser importado na instancia.
//
// O RISCO ESPECIFICO DESTA FASE
//
// O branch de dossie ja casa a palavra "exportar". "exportar para contador" —
// uma das frases-gatilho — cai nele se a ordem estiver errada, e o usuario
// recebe um PDF quando pediu a planilha. Pior: como palavra-chave vence IA, o
// erro e deterministico e nunca se corrige sozinho. Metade deste arquivo e
// adversarial por isso.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CAPACIDADES_ANUNCIADAS,
  mensagemBoasVindas,
} from "../supabase/functions/_shared/boas_vindas.ts";

const CONSULTA = JSON.parse(
  await Deno.readTextFile("n8n/workflows/consulta-e-dossie.json"),
);

function node(nome: string) {
  const alvo = CONSULTA.nodes.find((n: any) => n.name === nome);
  if (!alvo) throw new Error(`node nao encontrado no export: ${nome}`);
  return alvo;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function intentDe(texto: string): Promise<string | null> {
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
    throw new Error("Preparar Contexto nao deveria referenciar outro node");
  });
  return saida.json.intent;
}

// --- 1. o gatilho novo ----------------------------------------------------

Deno.test("as frases de planilha viram export_contador", async () => {
  const frases = [
    "planilha",
    "me manda a planilha",
    "quero a planilha das minhas despesas",
    "manda em excel",
    "tem como exportar em xlsx?",
    // A frase que o branch de dossie roubaria: contem "exportar".
    "exportar para contador",
    "export contador",
    "exporta pro meu contador",
    "preciso mandar o material pro contador",
    "gera o arquivo pro meu contabilista",
    // Acento e caixa nao podem importar — o node normaliza NFD.
    "PLANILHA",
    "Exportar Para Contador",
  ];

  for (const frase of frases) {
    assertEquals(await intentDe(frase), "export_contador", frase);
  }
});

// --- 2. adversarial: nenhum intent existente pode ser roubado -------------

Deno.test("o gatilho novo nao rouba os intents que ja existiam", async () => {
  const esperado: Array<[string, string | null]> = [
    // Dossie — inclusive as formas que citam contador junto. Quem disse "pdf"
    // ou "dossie" ja escolheu o formato; contador ali e o destinatario.
    ["me manda o dossie", "exportar_dossie"],
    ["quero o pdf", "exportar_dossie"],
    ["exportar", "exportar_dossie"],
    ["exportar minhas despesas", "exportar_dossie"],
    ["manda o dossie pro meu contador", "exportar_dossie"],
    ["preciso enviar o pdf para o contador", "exportar_dossie"],
    ["gera o relatorio pro contador", "exportar_dossie"],
    // Resumo.
    ["resumo", "consulta_resumo"],
    ["me manda o resumo", "consulta_resumo"],
    ["quanto tenho de dedutivel", "consulta_resumo"],
    // Conectar banco.
    ["quero conectar meu banco", "conectar_banco"],
    ["vincular minha conta bancaria", "conectar_banco"],
    // Sobre.
    ["o que voce faz", "sobre_o_taxmind"],
    ["quem e voce", "sobre_o_taxmind"],
    // Despesa comum: nao pode virar comando nenhum, vai para a IA.
    ["paguei 200 no dentista", null],
    ["gastei 50 no mercado", null],
    ["dentista 500", null],
    // "contador" sem verbo de entrega e sem planilha: nao e pedido de arquivo.
    ["quanto paguei ao meu contador esse ano", null],
    ["meu contador pediu umas coisas", null],
  ];

  for (const [frase, intent] of esperado) {
    assertEquals(await intentDe(frase), intent, frase);
  }
});

Deno.test("o branch novo e checado antes do de dossie", async () => {
  // Prova posicional, e nao so comportamental: se alguem reordenar os branches,
  // "exportar para contador" volta a cair em exportar_dossie silenciosamente.
  const codigo = node("Preparar Contexto").parameters.jsCode;
  const posExport = codigo.indexOf('intent = "export_contador"');
  const posDossie = codigo.indexOf('intent = "exportar_dossie"');
  assert(posExport > 0 && posDossie > 0, "branches nao encontrados");
  assert(posExport < posDossie, "export_contador precisa ser checado antes do dossie");
});

// --- 3. o classificador de IA --------------------------------------------

function promptDe(json: Record<string, unknown>): string {
  const expr = node("Gemini - Classificar Intent").parameters.jsonBody;
  const interno = expr.slice(expr.indexOf("{{") + 2, expr.lastIndexOf("}}"));
  return JSON.parse(new Function("$json", `return (${interno})`)(json))
    .contents[0].parts[0].text;
}

Deno.test("o prompt do Gemini descreve a categoria nova e a distingue do dossie", () => {
  const prompt = promptDe({ text_body: "manda o material pro contador" });

  assert(prompt.includes("export_contador:"), "categoria ausente do prompt");
  // O discriminador precisa estar escrito: os dois intents sao "me da um
  // arquivo das minhas despesas", e sem isso o modelo escolhe por sorte.
  assert(prompt.includes("planilha"), "o prompt nao cita planilha");
  assert(
    prompt.includes("PDF ou dossie, e exportar_dossie"),
    "falta a regra de desempate explicita",
  );
});

Deno.test("Aplicar Intent da IA aceita o rotulo novo sem colisao de substring", () => {
  const codigo = node("Aplicar Intent da IA").parameters.jsCode;
  assert(codigo.includes('"export_contador"'), "intent novo nao esta na lista de validos");

  // A lista e varrida com find(v => bruto.includes(v)), entao um rotulo que
  // fosse substring de outro casaria antes da hora. "exportar_dossie" e
  // "export_contador" compartilham prefixo mas nenhum contem o outro — se um
  // rotulo futuro quebrar isso, o teste avisa.
  const validos = [...codigo.matchAll(/"([a-z_]+)",/g)].map((m) => m[1]);
  assert(validos.includes("export_contador"));
  for (const a of validos) {
    for (const b of validos) {
      if (a !== b) assert(!a.includes(b), `"${a}" contem "${b}": a ordem passa a importar`);
    }
  }

  // Simula a resposta do modelo pelo mesmo caminho do node.
  const escolher = (resposta: string) => {
    const bruto = resposta.toLowerCase().replace(/[^a-z_]/g, "");
    return validos.find((v) => bruto.includes(v)) || "outro";
  };
  assertEquals(escolher("export_contador"), "export_contador");
  assertEquals(escolher("exportar_dossie"), "exportar_dossie");
  assertEquals(escolher(""), "outro", "resposta vazia continua caindo em outro");
});

// --- 4. topologia do ramo -------------------------------------------------

Deno.test("o Switch roteia export_contador para a Edge Function nova", () => {
  const regras = node("Switch por Intent").parameters.rules.values;
  const indice = regras.findIndex((r: any) => r.outputKey === "export_contador");
  assert(indice >= 0, "saida export_contador ausente do Switch");
  assertEquals(regras[indice].conditions.conditions[0].rightValue, "export_contador");

  // A ordem das saidas do Switch e a ordem das conexoes: se as duas
  // desalinharem, o intent novo dispara o ramo de outro intent.
  const saidas = CONSULTA.connections["Switch por Intent"].main;
  assertEquals(saidas.length, regras.length, "saidas e regras desalinhadas");
  assertEquals(saidas[indice].map((c: any) => c.node), ["Edge - Gerar Export Contador"]);
});

Deno.test("o ramo responde no WhatsApp mesmo quando a Edge Function falha", () => {
  // A regra que o incidente do insert de recibos deixou: nenhum caminho pode ter
  // o unico node de resposta depois de um node que pode falhar, senao a execucao
  // morre antes de falar com o usuario e o silencio e total.
  const edge = node("Edge - Gerar Export Contador");
  assertEquals(edge.onError, "continueRegularOutput");
  assertEquals(edge.alwaysOutputData, true);

  const depoisDaEdge = CONSULTA.connections["Edge - Gerar Export Contador"].main[0];
  assertEquals(depoisDaEdge.map((c: any) => c.node), ["Export Gerado?"]);

  const ramos = CONSULTA.connections["Export Gerado?"].main;
  assertEquals(ramos[0].map((c: any) => c.node), ["WhatsApp - Enviar Export Contador"]);
  assertEquals(ramos[1].map((c: any) => c.node), ["WhatsApp - Enviar Falha do Export"]);

  // O IF decide pela presenca da url, que e o que a function devolve no sucesso.
  const cond = node("Export Gerado?").parameters.conditions.conditions[0];
  assertEquals(cond.leftValue, "={{ $json.url }}");
  assertEquals(cond.operator.operation, "notEmpty");
});

Deno.test("a Edge Function certa e chamada, com a chave no formato certo", () => {
  const edge = node("Edge - Gerar Export Contador");
  assert(
    edge.parameters.url.includes("/functions/v1/export-contador"),
    "url aponta para outra function",
  );
  // O runtime injeta a service_role no formato sb_secret_, e e contra ela que a
  // function compara byte a byte. Mandar a JWT antiga daria 401 em producao com
  // tudo certo no repositorio.
  const auth = edge.parameters.headerParameters.parameters.find(
    (p: any) => p.name === "Authorization",
  );
  assert(auth.value.includes("SUPABASE_SECRET_KEY_SB_FORMAT"), "chave em formato errado");
});

Deno.test("a planilha e enviada como documento xlsx", () => {
  const envio = node("WhatsApp - Enviar Export Contador").parameters.jsonBody;
  assert(envio.includes('type: "document"'), "precisa ir como documento");
  assert(envio.includes("$json.url"), "link do arquivo ausente");
  assert(envio.includes("$json.filename"), "nome do arquivo ausente");
  // A legenda muda quando nao ha lancamento: mandar "aqui esta sua planilha"
  // com o arquivo vazio faria o usuario procurar dado que nao existe.
  assert(envio.includes("total_linhas"), "a legenda nao trata o caso vazio");
});

// --- 5. descoberta --------------------------------------------------------

Deno.test("sobre_o_taxmind e a ajuda generica citam a planilha", () => {
  // As duas mensagens sao os unicos lugares onde alguem descobre a
  // funcionalidade sem saber que ela existe.
  const sobre = node("WhatsApp - Enviar Sobre o TaxMind").parameters.jsonBody;
  assert(sobre.includes("planilha"), "sobre_o_taxmind nao cita a planilha");
  assert(sobre.includes("contador"), "sobre_o_taxmind nao diz para quem serve");
  // E continua citando o que ja citava: a adicao nao pode ter comido item.
  for (const item of ["resumo", "dossiê", "Open Finance"]) {
    assert(sobre.includes(item), `sobre_o_taxmind perdeu a mencao a ${item}`);
  }

  const ajuda = node("WhatsApp - Enviar Ajuda").parameters.jsonBody;
  assert(ajuda.includes("planilha"), "a ajuda generica nao cita a planilha");
  assert(ajuda.includes("dossie"), "a ajuda generica perdeu o dossie");
});

Deno.test("boas-vindas e sobre_o_taxmind anunciam as mesmas capacidades", () => {
  // Duas listas vivas do que o produto faz, em lugares que nao se enxergam: uma
  // na Edge Function (bootstrap-identity, via _shared/boas_vindas.ts) e outra no
  // node do n8n. Sao mensagens diferentes de proposito — uma recebe, a outra
  // responde "o que voce faz?" — mas capacidade nova costuma entrar em so uma
  // delas, e a que fica para tras vira desinformacao silenciosa.
  //
  // A comparacao e por COBERTURA e nao por texto: exigir texto igual obrigaria
  // as duas a ter o mesmo tom, que e justamente o que elas nao devem ter.
  const boasVindas = mensagemBoasVindas("Contribuinte de Teste").toLowerCase();
  const sobre = node("WhatsApp - Enviar Sobre o TaxMind").parameters.jsonBody.toLowerCase();

  for (const capacidade of CAPACIDADES_ANUNCIADAS) {
    assert(boasVindas.includes(capacidade), `boas-vindas nao cobre "${capacidade}"`);
    assert(sobre.includes(capacidade), `sobre_o_taxmind nao cobre "${capacidade}"`);
  }
});
