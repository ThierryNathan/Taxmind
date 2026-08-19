// Fase 17 medida contra o Gemini real.
//
// Rodar: deno test --allow-env --allow-net --allow-read tests/declaracao_gemini_test.ts
//
// Duas medicoes, e as duas usam o artefato de PRODUCAO (o prompt de
// _shared/declaracao_anterior.ts e o corpo do node do n8n), nunca uma copia:
//
//  1. EXTRACAO — o prompt le o PDF por inline_data e acerta os campos que viram
//     linha no banco. Inclui o caso que torna a feature segura: um recibo comum
//     em PDF precisa ser RECUSADO, senao uma pendencia aberta sequestraria a
//     nota fiscal que a pessoa mandou no meio do caminho.
//
//  2. INTENT — acrescentar uma categoria muda o espaco de decisao de TODA
//     mensagem, inclusive as que nada tem a ver com o assunto. O teste so prova
//     algo se as frases medidas NAO casarem palavra-chave, entao ele confere
//     isso antes de medir (mesmo padrao de export_contador_gemini_test.ts).
//
// Sem GEMINI_API_KEY os testes sao ignorados, como os demais que dependem de
// rede.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  interpretarExtracao,
  PROMPT_EXTRACAO_DECLARACAO,
} from "../supabase/functions/_shared/declaracao_anterior.ts";
import { gerarPdf, MODELOS } from "./fixtures/gerar_declaracao_sintetica.ts";

const MODELO = "gemini-3-flash-preview";
const REPETICOES = Number(Deno.env.get("REPETICOES") ?? "2");

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

const CHAVE = await resolverChave();
const TEM_CHAVE = CHAVE.length > 0;

function paraBase64(bytes: Uint8Array): string {
  let bruto = "";
  const passo = 8192;
  for (let i = 0; i < bytes.length; i += passo) {
    bruto += String.fromCharCode(...bytes.subarray(i, i + passo));
  }
  return btoa(bruto);
}

async function extrair(bytes: Uint8Array): Promise<string> {
  const resposta = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${CHAVE}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { inline_data: { mime_type: "application/pdf", data: paraBase64(bytes) } },
            { text: PROMPT_EXTRACAO_DECLARACAO },
          ],
        }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 8192,
          thinkingConfig: { thinkingLevel: "low" },
        },
      }),
    },
  );

  if (!resposta.ok) throw new Error(`Gemini ${resposta.status}: ${await resposta.text()}`);
  const corpo = await resposta.json();
  return corpo?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
}

const ESPERADOS = [
  { slug: "simplificado", modelo: "SIMPLIFICADO", aliquota: 11.74, categorias: ["SAUDE", "EDUCACAO", "PREVIDENCIA"] },
  { slug: "completo", modelo: "COMPLETO", aliquota: 8.32, categorias: ["SAUDE", "EDUCACAO", "SERVICOS_PROFISSIONAIS", "OUTROS"] },
  { slug: "sem-pagamentos", modelo: "SIMPLIFICADO", aliquota: 8.56, categorias: [] },
];

const mesmaLista = (a: string[], b: string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

Deno.test({
  name: "o prompt de producao extrai os campos que viram linha no banco",
  ignore: !TEM_CHAVE,
  fn: async () => {
    for (const esperado of ESPERADOS) {
      const modelo = MODELOS.find((m) => m.slug === esperado.slug)!;
      const bytes = await gerarPdf(modelo);

      for (let i = 0; i < REPETICOES; i++) {
        const resultado = interpretarExtracao(await extrair(bytes));
        assertEquals(resultado.status, "ok", `${esperado.slug} execucao ${i + 1}`);
        if (resultado.status !== "ok") continue;

        const d = resultado.dados;
        assertEquals(d.ano_calendario, 2025, `${esperado.slug}: ano`);
        assertEquals(d.modelo, esperado.modelo, `${esperado.slug}: modelo apresentado`);
        assertEquals(d.aliquota_efetiva, esperado.aliquota, `${esperado.slug}: aliquota efetiva`);
        assert(
          mesmaLista(d.categorias_pagamentos, esperado.categorias),
          `${esperado.slug}: categorias ${JSON.stringify(d.categorias_pagamentos)}`,
        );
      }
    }
  },
});

Deno.test({
  name: "recibo comum em PDF e recusado, e nao vira baseline",
  ignore: !TEM_CHAVE,
  fn: async () => {
    const { PDFDocument, StandardFonts } = await import("https://esm.sh/pdf-lib@1.17.1");
    const doc = await PDFDocument.create();
    const fonte = await doc.embedFont(StandardFonts.Helvetica);
    const pagina = doc.addPage([595, 842]);
    let y = 780;
    for (
      const linha of [
        "CLINICA ODONTOLOGICA SINTETICA LTDA",
        "CNPJ: 11.222.333/0001-81",
        "RECIBO DE PAGAMENTO",
        "Recebi de CONTRIBUINTE SINTETICO DE TESTE",
        "a importancia de R$ 799,00 (setecentos e noventa e nove reais)",
        "referente a tratamento odontologico.",
        "Sao Paulo, 12 de marco de 2026.",
      ]
    ) {
      pagina.drawText(linha, { x: 48, y, size: 11, font: fonte });
      y -= 22;
    }
    const bytes = await doc.save();

    for (let i = 0; i < REPETICOES; i++) {
      const resultado = interpretarExtracao(await extrair(bytes));
      assertEquals(
        resultado.status,
        "nao_e_declaracao",
        `execucao ${i + 1}: um recibo virou declaracao`,
      );
    }
  },
});

// --- intent -----------------------------------------------------------------

const CONSULTA = JSON.parse(await Deno.readTextFile("n8n/workflows/consulta-e-dossie.json"));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** Roda o Code node do export para saber se a frase casa palavra-chave. So
 *  frases que NAO casam medem o classificador de IA. */
async function intentPorPalavraChave(texto: string): Promise<string | null> {
  const node = CONSULTA.nodes.find((n: any) => n.name === "Preparar Contexto");
  const body = {
    session_id: "s",
    normalized: { message_type: "text", text_body: texto, wa_id: "1", phone: "+1", profile_name: null },
    followup: null,
  };
  const fn = new AsyncFunction("$input", "$", node.parameters.jsCode);
  return (await fn({ item: { json: { body } } }, () => ({ item: { json: {} } }))).json.intent ?? null;
}

/** Manda a mensagem pelo corpo REAL do node do Gemini, com as chaves de
 *  ambiente substituidas. Assim o prompt medido e o que vai rodar. */
async function intentPorIA(texto: string): Promise<string> {
  const node = CONSULTA.nodes.find((n: any) => n.name === "Gemini - Classificar Intent");
  const expressao: string = node.parameters.jsonBody;

  const corpoJs = expressao
    .replace(/^=\{\{\s*/, "")
    .replace(/\s*\}\}$/, "")
    .replace(/\$json\.text_body/g, JSON.stringify(texto))
    .replace(/\$json\.followup_contexto/g, "null")
    .replace(/\$json\.followup_instrucao/g, "null");

  const corpo = new Function(`return (${corpoJs});`)();

  const resposta = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${CHAVE}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: corpo },
  );
  if (!resposta.ok) throw new Error(`Gemini ${resposta.status}: ${await resposta.text()}`);

  const json = await resposta.json();
  const bruto = (json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "")
    .toLowerCase()
    .replace(/[^a-z_]/g, "");

  const validos = [
    "registro_despesa",
    "consulta_resumo",
    "exportar_dossie",
    "export_contador",
    "conectar_banco",
    "importar_declaracao",
    "resposta_de_followup",
    "fora_do_escopo_financeiro",
    "sobre_o_taxmind",
    "outro",
  ];
  return validos.find((v) => bruto.includes(v)) ?? "outro";
}

const CASOS_IA: Array<{ frase: string; esperado: string }> = [
  // Pedidos de import que a palavra-chave nao pega.
  { frase: "consegui baixar o arquivo da minha ultima declaracao, e agora?", esperado: "importar_declaracao" },
  { frase: "quero que voce olhe o que eu declarei no ano retrasado", esperado: "importar_declaracao" },
  { frase: "posso te passar o espelho da minha DIRPF?", esperado: "importar_declaracao" },
  // A categoria nova NAO pode roubar o que ja tinha dono.
  { frase: "quanto eu ja gastei com saude esse ano", esperado: "consulta_resumo" },
  { frase: "preciso passar tudo pro meu contador organizar", esperado: "export_contador" },
  { frase: "paguei 350 no oftalmologista ontem", esperado: "registro_despesa" },
  { frase: "queria imprimir tudo que registrei pra guardar", esperado: "exportar_dossie" },
  { frase: "quero ligar minha conta do banco", esperado: "conectar_banco" },
  { frase: "voce serve pra que exatamente", esperado: "sobre_o_taxmind" },
  { frase: "qual o melhor investimento pra 2027", esperado: "fora_do_escopo_financeiro" },
];

Deno.test({
  name: "a categoria nova nao desestabiliza a classificacao das outras",
  ignore: !TEM_CHAVE,
  fn: async () => {
    const falhas: string[] = [];

    for (const caso of CASOS_IA) {
      // Se a frase casar palavra-chave, o teste nao estaria medindo a IA.
      const porChave = await intentPorPalavraChave(caso.frase);
      assertEquals(
        porChave,
        null,
        `"${caso.frase}" casou palavra-chave (${porChave}) e nao mede o classificador`,
      );

      for (let i = 0; i < REPETICOES; i++) {
        const obtido = await intentPorIA(caso.frase);
        if (obtido !== caso.esperado) {
          falhas.push(`"${caso.frase}" -> ${obtido} (esperado ${caso.esperado})`);
        }
      }
    }

    assertEquals(falhas, [], `classificacoes divergentes:\n${falhas.join("\n")}`);
  },
});
