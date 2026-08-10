// Mitigacao de multiplas despesas no export vivo do n8n.
//
// Rodar: deno test --allow-read tests/n8n_multiplas_despesas_test.ts
//
// Executa o Code node importavel, nao uma reimplementacao. O sinal vem da IA,
// mas status, ausencia de follow-up e aviso ao usuario sao garantias locais.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const WORKFLOW = JSON.parse(
  await Deno.readTextFile("n8n/workflows/receipt-ocr-classification.json"),
);

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function node(nome: string) {
  const alvo = WORKFLOW.nodes.find((item: any) => item.name === nome);
  if (!alvo) throw new Error(`node nao encontrado no export: ${nome}`);
  return alvo;
}

async function montarPayload(parsed: Record<string, unknown>) {
  const contexto = {
    session_id: "22222222-2222-4222-8222-222222222222",
    origem: "WHATSAPP_TEXTO",
    wa_id: "5511999990000",
    data_recebimento: "2026-08-09",
    media_sha256: null,
    followup_anterior_id: null,
  };
  const tabela: Record<string, unknown> = {
    "Preparar Contexto": contexto,
    "Extrair Bloco Expense": {
      expense: parsed,
      mensagem_usuario: "Registrei sua despesa normalmente.",
    },
  };
  const pareado = (nome: string) => {
    const json = tabela[nome];
    if (!json) throw new Error(`o teste nao expos ${nome}`);
    return { item: { json }, first: () => ({ json }) };
  };

  const fn = new AsyncFunction(
    "$input",
    "$",
    node("Montar Payload do Recibo").parameters.jsCode,
  );
  return await fn.call({}, {
    item: { json: { usuario_id: "11111111-1111-4111-8111-111111111111" } },
    all:
      () => [{ json: { usuario_id: "11111111-1111-4111-8111-111111111111" } }],
  }, pareado);
}

function analise(overrides: Record<string, unknown> = {}) {
  return {
    descricao: "Despesa de teste",
    valor: 80,
    data_despesa: "2026-08-09",
    data_inferida: false,
    estabelecimento: "Estabelecimento teste",
    documento_prestador: "11.222.333/0001-81",
    categoria: "OUTROS",
    deducibilidade: "DEDUTIVEL",
    confidence_score: 0.95,
    requer_revisao_humana: false,
    motivos_revisao: [],
    campos_ausentes: [],
    deducibilidade_se_desbloqueado: null,
    possui_indicio_reembolso: false,
    deducibilidade_se_sem_reembolso: null,
    possui_multiplas_despesas: false,
    ...overrides,
  };
}

Deno.test("sinal de multiplas despesas vence aprovacao e qualquer follow-up", async () => {
  // Contradicao deliberada: mesmo que a IA acerte o sinal mas esqueça de elevar
  // requer_revisao_humana ou de limpar os destinos, o workflow nao pode aprovar
  // a linha nem perguntar CNPJ/reembolso para uma extracao misturada.
  const saida = await montarPayload(analise({
    possui_multiplas_despesas: true,
    possui_indicio_reembolso: true,
    deducibilidade_se_desbloqueado: "DEDUTIVEL",
    deducibilidade_se_sem_reembolso: "DEDUTIVEL",
  }));

  assertEquals(saida.json.status, "REVISAO_HUMANA");
  assertEquals(saida.json.requer_revisao_humana, true);
  assertEquals(saida.json.followup_campo, null);
  assertEquals(saida.json.followup_pergunta, null);
  assertEquals(saida.json.metadados_ia.possui_multiplas_despesas, true);
  assertEquals(
    saida.json.mensagem_usuario,
    "Percebi que você mencionou mais de uma despesa nesta mensagem. Registrei o total como um único item, em revisão, para seu contador separar corretamente. Da próxima vez, prefira enviar uma despesa por mensagem.",
  );
});

Deno.test("boolean false preserva a despesa unica aprovavel", async () => {
  const saida = await montarPayload(analise());

  assertEquals(saida.json.status, "RECEBIDO");
  assertEquals(saida.json.requer_revisao_humana, false);
  assertEquals(saida.json.followup_campo, null);
  assertEquals(
    saida.json.mensagem_usuario,
    "Registrei sua despesa normalmente.",
  );
});

Deno.test("campo ausente nao ativa a protecao por coercao", async () => {
  const { possui_multiplas_despesas: _, ...semCampo } = analise();
  const saida = await montarPayload(semCampo);
  assertEquals(saida.json.status, "RECEBIDO");
  assertEquals(saida.json.requer_revisao_humana, false);
});
