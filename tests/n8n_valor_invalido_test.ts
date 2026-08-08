// Guarda de valor antes do insert do recibo.
//
// Rodar:  deno test --allow-read tests/n8n_valor_invalido_test.ts
//
// O bug que originou este arquivo: uma resposta de CNPJ em linguagem natural
// nao foi reconhecida como resposta ao follow-up, virou "despesa nova" no
// classificador de intencao, e o Gemini — tentando dar sentido a um texto que
// nao descreve despesa — devolveu valor 0. O insert bateu em
// recibos_valor_positivo_chk, a execucao morreu no node do insert e o usuario
// nao recebeu mensagem nenhuma, porque o unico node de WhatsApp desse ramo
// vinha DEPOIS do insert.
//
// A causa raiz esta corrigida em _shared/followup.ts (ver tests/followup_test.ts).
// Esta guarda e defesa em profundidade e vale para qualquer outro caminho que
// leve a IA a devolver valor ausente, nulo, zero ou nao numerico.
//
// Mesmo harness dos outros testes de n8n: o jsCode sai do export real que vai
// ser importado, nao de uma copia.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const RECEIPT = JSON.parse(
  await Deno.readTextFile("n8n/workflows/receipt-ocr-classification.json"),
);

function node(nome: string) {
  const alvo = RECEIPT.nodes.find((n: any) => n.name === nome);
  if (!alvo) throw new Error(`node nao encontrado no export: ${nome}`);
  return alvo;
}

const destinos = (nome: string, saida = 0) =>
  (RECEIPT.connections[nome]?.main?.[saida] ?? []).map((c: any) => c.node);

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function montarPayload(parsed: Record<string, unknown>) {
  const pareado = (nome: string) => {
    const json = ({
      "Preparar Contexto": {
        session_id: "22222222-2222-4222-8222-222222222222",
        origem: "WHATSAPP_TEXTO",
        wa_id: "5511999990000",
        phone: "+5511999990000",
        data_recebimento: "2026-08-08",
        media_sha256: null,
      },
      "Extrair Bloco Expense": {
        expense: parsed,
        mensagem_usuario: "Registrei sua despesa.",
      },
    } as Record<string, unknown>)[nome];
    if (!json) throw new Error(`o teste nao expos "${nome}"`);
    return { item: { json }, first: () => ({ json }) };
  };

  const fn = new AsyncFunction("$input", "$", node("Montar Payload do Recibo").parameters.jsCode);
  return await fn.call({}, {
    item: { json: { usuario_id: "11111111-1111-4111-8111-111111111111" } },
  }, pareado);
}

function expense(overrides: Record<string, unknown> = {}) {
  return {
    descricao: "Consulta medica",
    valor: 450,
    data_despesa: "2026-08-08",
    estabelecimento: "Clinica Vida",
    categoria: "SAUDE",
    deducibilidade: "DEDUTIVEL",
    confidence_score: 0.9,
    requer_revisao_humana: false,
    campos_bloqueantes: [],
    ...overrides,
  };
}

Deno.test("valor 0 nao chega ao insert e vira pedido de esclarecimento", async () => {
  // Exatamente o que o Gemini devolveu na conversa real, para a mensagem
  // "cnpj dele e <CNPJ>" classificada como despesa:
  // { valor: 0, descricao: "Despesa vinculada ao CNPJ ...", requer_revisao_humana: true }
  const saida = await montarPayload(expense({
    valor: 0,
    descricao: "Despesa vinculada ao CNPJ",
    requer_revisao_humana: true,
  }));

  assertEquals(saida.json.valor_valido, false);
  // null, e nao 0: se algum dia o item vazar para o insert, a coluna reclama de
  // NOT NULL em vez de passar por uma constraint de valor plausivel.
  assertEquals(saida.json.valor, null);
  assert(saida.json.mensagem_valor_invalido.length > 0);
  // A analise da IA continua inteira no rastro de auditoria.
  assertEquals(saida.json.metadados_ia.valor, 0);
});

Deno.test("todo formato de valor impossivel e recusado igual", async () => {
  for (const valor of [0, -10, null, undefined, "", "  ", "nao informado", NaN, "R$"]) {
    const saida = await montarPayload(expense({ valor }));
    assertEquals(saida.json.valor_valido, false, `valor ${JSON.stringify(valor)} passou`);
    assertEquals(saida.json.valor, null);
  }
});

Deno.test("valor legitimo passa sem mudanca de comportamento", async () => {
  assertEquals((await montarPayload(expense({ valor: 450 }))).json.valor, 450);
  assertEquals((await montarPayload(expense({ valor: 0.5 }))).json.valor, 0.5);
  // A IA as vezes devolve string; PostgREST aceitava, mas normalizar aqui deixa
  // o numero pronto para a comparacao acima.
  assertEquals((await montarPayload(expense({ valor: "450" }))).json.valor, 450);
  assertEquals((await montarPayload(expense({ valor: "450,00" }))).json.valor, 450);

  const saida = await montarPayload(expense({ valor: 450 }));
  assertEquals(saida.json.valor_valido, true);
  assertEquals(saida.json.status, "RECEBIDO");
});

Deno.test("a mensagem de esclarecimento nao afirma que registrou nada", async () => {
  const texto: string = (await montarPayload(expense({ valor: 0 }))).json.mensagem_valor_invalido;

  assert(texto.includes("não registrei"), texto);
  // A confirmacao normal continua sendo outra coisa: sem despesa gravada nao ha
  // o que confirmar.
  assert(!texto.includes("Registrei sua despesa"), texto);
});

Deno.test("o insert so e alcancavel pelo ramo valido do IF", () => {
  // Estrutural, e e o que impede o modo de falha original: com o insert ligado
  // direto em Montar Payload, valor 0 derrubava a execucao antes de qualquer
  // node de WhatsApp.
  assertEquals(destinos("Montar Payload do Recibo"), ["Valor Válido?"]);
  assertEquals(destinos("Valor Válido?", 0), ["Supabase - Inserir Recibo"]);
  assertEquals(destinos("Valor Válido?", 1), ["WhatsApp - Pedir Valor"]);
});

Deno.test("o ramo invalido responde no WhatsApp e para ali", () => {
  const pedir = node("WhatsApp - Pedir Valor");
  const corpo: string = pedir.parameters.jsonBody;

  // O telefone vem do contexto, nao do item: $json aqui e o payload do recibo.
  assert(corpo.includes('$("Preparar Contexto").item.json.phone'), corpo);
  assert(corpo.includes('$("Montar Payload do Recibo").item.json.mensagem_valor_invalido'), corpo);

  // Fim de linha: nada depois dele, e em especial nenhum caminho de volta para
  // o insert.
  assertEquals(destinos("WhatsApp - Pedir Valor"), []);
});

Deno.test("o caminho feliz continua identico ao de antes", () => {
  assertEquals(destinos("Supabase - Inserir Recibo"), ["Requer Revisão Humana"]);
  assertEquals(destinos("Requer Revisão Humana", 0), ["Supabase - Atualizar Status Aprovado"]);
  assertEquals(destinos("Requer Revisão Humana", 1), ["Tem Campo Bloqueante?"]);
});
