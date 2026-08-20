// Fase 18 - o fio do bloco de pontos de atencao dentro do export vivo do
// workflow, e nao numa copia dele.
//
// Rodar:  deno test --allow-read tests/n8n_pontos_atencao_test.ts
//
// Quatro coisas que quebram em silencio e por isso tem teste:
//
//  1. a TOPOLOGIA. O node novo entrou no meio do ramo do resumo; se a corrente
//     Formatar -> Complemento -> Atencao -> Enviar arrebentar num ponto, o
//     resumo simplesmente para de responder — foi o que aconteceu na fase 17,
//     e o sintoma foi silencio total;
//  2. a expressao de envio, que agora concatena DUAS listas. Perder uma delas
//     nao da erro nenhum: some um bloco e o resumo continua saindo;
//  3. `.first()` em vez de `.item`. Formatar Resumo agrega N linhas da RPC em 1
//     item, e `$("...").item` de qualquer node depois dele estoura com "Paired
//     item data is unavailable" quando a RPC devolve mais de uma categoria;
//  4. o fail open do node novo. Sem `onError: continueRegularOutput`, uma falha
//     do bloco acessorio derruba o resumo inteiro.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DIAS_REVISAO_PARADA } from "../supabase/functions/_shared/pontos_atencao.ts";

// deno-lint-ignore no-explicit-any
const CONSULTA: any = JSON.parse(
  await Deno.readTextFile("n8n/workflows/consulta-e-dossie.json"),
);

const NODE_ATENCAO = "Edge - Pontos de Atenção";
const NODE_COMPLEMENTO = "Edge - Complemento do Resumo";
const NODE_ENVIO = "WhatsApp - Enviar Resumo";
const NODE_FORMATAR = "Formatar Resumo";

// deno-lint-ignore no-explicit-any
function node(nome: string): any {
  const alvo = CONSULTA.nodes.find((n: { name: string }) => n.name === nome);
  assert(alvo, `node nao encontrado no export: ${nome}`);
  return alvo;
}

function destinos(nome: string): string[] {
  const conexao = CONSULTA.connections[nome];
  assert(conexao, `node sem conexao de saida: ${nome}`);
  return (conexao.main?.[0] ?? []).map((c: { node: string }) => c.node);
}

Deno.test("o node de pontos de atencao entra ENTRE o complemento e o envio", () => {
  node(NODE_ATENCAO);

  assertEquals(
    destinos(NODE_FORMATAR)[0],
    NODE_COMPLEMENTO,
    "a saida normal de Formatar Resumo deixou de ir para o complemento",
  );
  assertEquals(
    destinos(NODE_COMPLEMENTO),
    [NODE_ATENCAO],
    "o complemento deveria alimentar o node de pontos de atencao",
  );
  assertEquals(
    destinos(NODE_ATENCAO),
    [NODE_ENVIO],
    "o node de pontos de atencao deveria alimentar o envio do resumo",
  );
});

Deno.test("o node novo chama a function certa, com a chave de service_role", () => {
  const alvo = node(NODE_ATENCAO);

  assertEquals(alvo.type, "n8n-nodes-base.httpRequest");
  assertEquals(alvo.parameters.method, "POST");
  assert(
    String(alvo.parameters.url).endsWith("/functions/v1/pontos-atencao"),
    `url inesperada: ${alvo.parameters.url}`,
  );

  // A function exige service_role (o historico consolidado do titular sai por
  // ela). O runtime injeta a chave no formato sb_secret_, e e contra ele que o
  // token precisa bater — dai SUPABASE_SECRET_KEY_SB_FORMAT, e nao a variavel
  // do JWT antigo.
  const auth = alvo.parameters.headerParameters.parameters
    .find((p: { name: string }) => p.name === "Authorization");
  assert(auth, "header Authorization ausente");
  assert(
    String(auth.value).includes("SUPABASE_SECRET_KEY_SB_FORMAT"),
    `chave errada no Authorization: ${auth.value}`,
  );

  assert(
    String(alvo.parameters.jsonBody).includes('$("Montar Contexto").first().json.usuario_id'),
    `corpo nao manda o usuario_id resolvido: ${alvo.parameters.jsonBody}`,
  );
});

Deno.test("o bloco e acessorio: falha nele nao pode derrubar o resumo", () => {
  const alvo = node(NODE_ATENCAO);

  assertEquals(
    alvo.onError,
    "continueRegularOutput",
    "sem continueRegularOutput, uma falha do bloco acessorio mata a resposta principal",
  );
  // Resposta vazia da function nao pode fazer o node seguinte nao executar.
  assertEquals(alvo.alwaysOutputData, true);

  // O mesmo vale para o vizinho, que ja era acessorio antes desta fase.
  assertEquals(node(NODE_COMPLEMENTO).onError, "continueRegularOutput");
});

Deno.test("o envio concatena as duas listas e tolera as duas ausentes", () => {
  const corpo = String(node(NODE_ENVIO).parameters.jsonBody);

  // As duas fontes precisam estar na expressao. A do complemento passou a ser
  // lida por nome porque ele deixou de ser o node imediatamente anterior.
  assert(
    corpo.includes(`$("${NODE_COMPLEMENTO}").first().json.linhas`),
    "a expressao perdeu as linhas do complemento da declaracao",
  );
  assert(corpo.includes("$json.linhas"), "a expressao perdeu as linhas de pontos de atencao");

  // Array.isArray como guarda nas DUAS: quando um dos nodes falha em
  // continueRegularOutput, o item que chega e o de erro, sem `linhas`.
  assertEquals(
    (corpo.match(/Array\.isArray/g) ?? []).length,
    2,
    "cada uma das duas listas precisa da propria guarda de tipo",
  );

  // Nenhum `.item` depois de um Code node agregador: e o bug de paired item que
  // deixou o comando resumo mudo na fase 17.
  assert(
    !/\$\("[^"]+"\)\.item\b/.test(corpo),
    `expressao usa .item em vez de .first(): ${corpo}`,
  );
  assert(corpo.includes(`$("${NODE_FORMATAR}").first().json.mensagem`));
});

Deno.test("a mensagem do resumo continua sendo a primeira parte do corpo", () => {
  // Ordem importa: os dois blocos sao complementos do resumo, e nao substitutos
  // dele. Um usuario que recebesse o bloco de atencao antes dos proprios totais
  // leria uma cobranca antes de saber do que se trata.
  const corpo = String(node(NODE_ENVIO).parameters.jsonBody);
  const posMensagem = corpo.indexOf(`$("${NODE_FORMATAR}").first().json.mensagem`);
  const posComplemento = corpo.indexOf(`$("${NODE_COMPLEMENTO}").first().json.linhas`);
  const posAtencao = corpo.indexOf("$json.linhas");

  assert(posMensagem >= 0 && posComplemento >= 0 && posAtencao >= 0);
  assert(posMensagem < posComplemento, "o bloco da declaracao vem antes do resumo");
  assert(posComplemento < posAtencao, "pontos de atencao deveriam fechar a mensagem");
});

Deno.test("o ramo do resumo continua com um caminho de falha para o usuario", () => {
  // Regra que vale para todo ramo: nenhum caminho pode ter o unico node de
  // resposta depois de um node que pode falhar. O aviso de falha continua
  // pendurado na saida de erro de Formatar Resumo e do proprio envio.
  const saidaErroFormatar = (CONSULTA.connections[NODE_FORMATAR].main?.[1] ?? [])
    .map((c: { node: string }) => c.node);
  assertEquals(saidaErroFormatar, ["WhatsApp - Enviar Falha do Resumo"]);

  const saidaErroEnvio = (CONSULTA.connections[NODE_ENVIO].main?.[1] ?? [])
    .map((c: { node: string }) => c.node);
  assertEquals(saidaErroEnvio, ["WhatsApp - Enviar Falha do Resumo"]);
});

Deno.test("o export continua ativo e sem duplicar id de node", () => {
  // import:workflow respeita o campo active: importar com false desativa o
  // webhook que estava ativo.
  assertEquals(CONSULTA.active, true);

  const ids = CONSULTA.nodes.map((n: { id: string }) => n.id);
  assertEquals(new Set(ids).size, ids.length, "ha id de node repetido no export");

  const nomes = CONSULTA.nodes.map((n: { name: string }) => n.name);
  assertEquals(new Set(nomes).size, nomes.length, "ha nome de node repetido no export");
});

Deno.test("o export e byte a byte JSON.stringify(obj, null, 2) sem newline final", () => {
  // O formato permite edicao programatica cirurgica sem perder id, webhookId,
  // position nem active. Um newline extra aqui e um diff inteiro de ruido na
  // proxima edicao.
  const bruto = Deno.readTextFileSync("n8n/workflows/consulta-e-dossie.json");
  assertEquals(bruto, JSON.stringify(JSON.parse(bruto), null, 2));
});

Deno.test("o limiar de dias nao aparece cravado no workflow", () => {
  // O n8n nao importa arquivo do repositorio, e todo numero copiado para um node
  // vira uma copia viva que deriva em silencio. Aqui o corpo so manda o
  // usuario_id: quem decide o limiar e a Edge Function, com o default da
  // migration 012.
  const corpo = String(node(NODE_ATENCAO).parameters.jsonBody);
  assert(
    !corpo.includes(String(DIAS_REVISAO_PARADA)),
    `o limiar de ${DIAS_REVISAO_PARADA} dias foi copiado para o workflow: ${corpo}`,
  );
  assert(!corpo.includes("dias_revisao"), `o workflow passou a mandar o limiar: ${corpo}`);
});
