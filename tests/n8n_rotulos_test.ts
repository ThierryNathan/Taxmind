// Rotulos de enum entregues ao usuario.
//
// Rodar:  deno test --allow-read tests/n8n_rotulos_test.ts
//
// Contexto: os valores de enum sao identificadores de banco e por isso ASCII
// (SAUDE, REVISAO_HUMANA, PARCIALMENTE_DEDUTIVEL). Quatro componentes rendiam
// esses valores direto na tela com a mesma receita — minusculas e underscore
// virando espaco —, e o texto entregue saia sem acento nenhum: "Saude" no
// resumo do WhatsApp, "Revisao humana" na coluna do dossie e da planilha do
// contador, "parcialmente dedutivel" no meio da frase de confirmacao.
//
// A traducao agora vive em _shared/rotulos.ts, com um espelho dentro do Code
// node "Formatar Resumo" do consulta-e-dossie (o n8n nao importa arquivo do
// repositorio). Este arquivo cobre as duas implementacoes e exige que
// concordem valor a valor, alem de cobrar cobertura completa dos enums que a
// migration 001 declara — membro novo sem rotulo cairia no fallback sem acento
// e ninguem perceberia.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ROTULOS_ENUM, rotuloEnum, rotuloTitulo } from "../supabase/functions/_shared/rotulos.ts";

const CONSULTA = JSON.parse(
  await Deno.readTextFile("n8n/workflows/consulta-e-dossie.json"),
);

const MIGRATION = await Deno.readTextFile(
  "supabase/migrations/001_init_taxmind_schema.sql",
);

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** Membros declarados na migration, e nao uma lista copiada para ca: a copia
 *  envelheceria em silencio, que e exatamente o que o teste quer impedir. */
function membrosDoEnum(nome: string): string[] {
  const bloco = MIGRATION.match(
    new RegExp(`create type public\\.${nome} as enum \\(([^)]*)\\)`, "i"),
  );
  assert(bloco, `enum ${nome} nao encontrado na migration 001`);
  return [...bloco![1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
}

const ENUMS_NA_TELA = [
  "categoria_fiscal",
  "status_deducibilidade",
  "status_processamento",
];

Deno.test("todo membro dos enums exibidos tem rotulo acentuado", () => {
  for (const enumNome of ENUMS_NA_TELA) {
    const membros = membrosDoEnum(enumNome);
    assert(membros.length > 0, `enum ${enumNome} veio vazio`);
    for (const membro of membros) {
      assert(
        membro in ROTULOS_ENUM,
        `${enumNome}.${membro} nao tem rotulo em _shared/rotulos.ts`,
      );
    }
  }
});

Deno.test("o fallback preserva o comportamento antigo", () => {
  // Valor fora do mapa continua legivel, exatamente como o humanize anterior.
  assertEquals(rotuloEnum("VALOR_DESCONHECIDO"), "valor desconhecido");
  assertEquals(rotuloTitulo("VALOR_DESCONHECIDO"), "Valor desconhecido");
  assertEquals(rotuloEnum(null), "");
  assertEquals(rotuloTitulo(""), "");
});

Deno.test("rotuloTitulo capitaliza sem estragar o acento", () => {
  assertEquals(rotuloTitulo("SAUDE"), "Saúde");
  assertEquals(rotuloTitulo("REVISAO_HUMANA"), "Revisão humana");
  assertEquals(rotuloTitulo("SERVICOS_PROFISSIONAIS"), "Serviços profissionais");
  assertEquals(rotuloEnum("PARCIALMENTE_DEDUTIVEL"), "parcialmente dedutível");
});

/** Extrai o espelho do Code node executando o proprio jsCode do export — o
 *  artefato que vai ser importado na instancia, nao uma copia dele. */
async function espelhoDoNode(): Promise<{
  mapa: Record<string, string>;
  titulo: (v: unknown) => string;
}> {
  const node = CONSULTA.nodes.find((n: any) => n.name === "Formatar Resumo");
  assert(node, 'node "Formatar Resumo" nao encontrado no export');

  // O corpo do node termina devolvendo a mensagem; para inspecionar o mapa,
  // roda-se so o trecho ate a definicao de rotuloTitulo e devolve-se os dois.
  const jsCode: string = node.parameters.jsCode;
  const corte = jsCode.indexOf("const validas =");
  assert(corte > 0, "o node mudou de forma: 'const validas =' sumiu");

  const prefixo = jsCode.slice(0, corte) +
    "\nreturn { mapa: ROTULOS_ENUM, titulo: rotuloTitulo };";

  const fn = new AsyncFunction("$input", "$", prefixo);
  return await fn(
    { all: () => [], item: { json: {} } },
    () => ({ first: () => ({ json: {} }), item: { json: {} } }),
  );
}

Deno.test("o espelho do n8n concorda com _shared/rotulos.ts", async () => {
  const { mapa, titulo } = await espelhoDoNode();

  assertEquals(
    Object.keys(mapa).sort(),
    Object.keys(ROTULOS_ENUM).sort(),
    "o espelho do Code node e _shared/rotulos.ts cobrem conjuntos diferentes",
  );

  for (const [chave, valor] of Object.entries(ROTULOS_ENUM)) {
    assertEquals(mapa[chave], valor, `rotulo divergente para ${chave}`);
    assertEquals(titulo(chave), rotuloTitulo(chave), `titulo divergente para ${chave}`);
  }

  // O fallback tambem precisa concordar, senao um valor desconhecido apareceria
  // de um jeito no resumo e de outro no dossie.
  assertEquals(titulo("VALOR_DESCONHECIDO"), rotuloTitulo("VALOR_DESCONHECIDO"));
  assertEquals(titulo(""), rotuloTitulo(""));
});
