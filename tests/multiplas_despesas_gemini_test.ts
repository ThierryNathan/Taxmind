// Mitigacao de multiplas despesas — medicao contra o Gemini real.
//
// Mede o campo presente no prompt de producao contra gemini-3-flash-preview.
//
// Rodar: deno test --allow-env --allow-net --allow-read tests/multiplas_despesas_gemini_test.ts

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const CHAVE = await resolverChave();
const MODELO = "gemini-3-flash-preview";
const DATA_REFERENCIA = "2026-08-08";

async function resolverChave(): Promise<string> {
  const doAmbiente = Deno.env.get("GEMINI_API_KEY");
  if (doAmbiente) return doAmbiente;

  try {
    const arquivo = await Deno.readTextFile(".env");
    const linha = arquivo.split("\n").find((l) =>
      l.startsWith("GEMINI_API_KEY=")
    );
    return linha?.slice("GEMINI_API_KEY=".length).trim() ?? "";
  } catch {
    return "";
  }
}

const fonte = await Deno.readTextFile(
  "backend/prompts/taxmind_system_prompt.js",
);
const PROMPT_ATUAL: string = eval(
  fonte.replace("export const", "var") + ";TAXMIND_SYSTEM_PROMPT",
).trim();

type Resultado = Record<string, unknown>;

async function classificar(mensagem: string): Promise<Resultado> {
  const resposta = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${CHAVE}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{
            text:
              `${PROMPT_ATUAL}\n\nData de recebimento da mensagem: ${DATA_REFERENCIA}\n\nMensagem do usuario: ${mensagem}`,
          }],
        }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingLevel: "low" },
        },
      }),
    },
  );

  if (!resposta.ok) {
    throw new Error(
      `Gemini respondeu ${resposta.status}: ${await resposta.text()}`,
    );
  }
  const corpo = await resposta.json();
  const bruto = corpo?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const bloco = bruto.match(/<expense>([\s\S]*?)<\/expense>/);
  assert(bloco, `resposta sem bloco <expense>: ${bruto.slice(0, 300)}`);
  return JSON.parse(bloco![1].trim());
}

const CRITICOS = [
  {
    id: "mercado-e-uber",
    mensagem: "gastei 50 no mercado e 30 no uber",
    esperado: true,
  },
  {
    id: "dois-estabelecimentos",
    mensagem:
      "paguei R$ 80 no estacionamento do Shopping Patio e R$ 140 de gasolina no Posto Shell",
    esperado: true,
  },
  {
    id: "total-com-componentes",
    mensagem: "paguei 400 na consulta, incluindo 50 de estacionamento",
    esperado: false,
  },
] as const;

// Casos unitarios ja medidos em docs/07. Eles verificam que a nova deteccao nao
// transforma a presenca de giria, data, dois valores de um mesmo atendimento ou
// uma despesa comum em falso positivo.
const NAO_REGRESSAO = [
  "dentista 500",
  "fui no dentista hj, saiu 500 pila",
  "paguei 89,90 na farmacia sao joao",
  "consulta psicologa 200 conto",
  "mano paguei 1.200 no oftalmo ontem",
  "gastei 60 no uber pro cliente",
  "paguei R$ 1.500 e mais 300 de anestesista no dentista",
] as const;

const comChave = { ignore: !CHAVE };

Deno.test(
  "detecta despesas distintas e preserva um total composto",
  comChave,
  async () => {
    const EXECUCOES = 3;
    const resultados = await Promise.all(CRITICOS.flatMap((caso) =>
      Array.from(
        { length: EXECUCOES },
        async () => ({ caso, expense: await classificar(caso.mensagem) }),
      )
    ));

    for (const { caso, expense } of resultados) {
      const contexto = `${caso.id}: ${JSON.stringify(expense)}`;
      assertEquals(expense.possui_multiplas_despesas, caso.esperado, contexto);

      if (caso.esperado) {
        assertEquals(expense.requer_revisao_humana, true, contexto);
        assertEquals(expense.deducibilidade_se_desbloqueado, null, contexto);
        assertEquals(expense.deducibilidade_se_sem_reembolso, null, contexto);
        assertEquals(expense.pergunta_de_followup, null, contexto);
      }
    }
  },
);

Deno.test(
  "despesas unitarias ja medidas nao viram multiplas",
  comChave,
  async () => {
    const resultados = await Promise.all(
      NAO_REGRESSAO.map(async (mensagem) => ({
        mensagem,
        expense: await classificar(mensagem),
      })),
    );
    for (const { mensagem, expense } of resultados) {
      assertEquals(
        expense.possui_multiplas_despesas,
        false,
        `${mensagem}: ${JSON.stringify(expense)}`,
      );
    }
  },
);

Deno.test(
  "despesas unitarias completas continuam aprovaveis",
  comChave,
  async () => {
    const expense = await classificar(
      "Paguei 320 de mensalidade da faculdade Anhembi, CNPJ 12.345.678/0001-90",
    );
    assertEquals(
      expense.possui_multiplas_despesas,
      false,
      JSON.stringify(expense),
    );
    assertEquals(expense.requer_revisao_humana, false, JSON.stringify(expense));
  },
);
