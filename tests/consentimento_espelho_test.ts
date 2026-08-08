// Fase 12 - as duas copias do texto de consentimento dizem a mesma coisa.
//
// Rodar:  deno test tests/consentimento_espelho_test.ts
//
// O texto vive em dois arquivos porque o bundle da Edge Function so enxerga
// supabase/functions/ e o Vite so enxerga apps/onboarding/. O cenario perigoso
// e a tela exibir um texto enquanto o banco registra o aceite de outro, entao a
// divergencia precisa quebrar aqui, e nao em producao.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CONSENTIMENTO_ATUAL as CANONICO,
  hashTextoConsentimento,
  textoCanonicoConsentimento,
  versaoConsentimentoAceita,
} from "../supabase/functions/_shared/consentimento.ts";
import {
  CONSENTIMENTO_ATUAL as ESPELHO,
  textoCanonicoConsentimento as canonicoDoEspelho,
} from "../apps/onboarding/src/lib/consentimento.js";

Deno.test("o texto exibido no onboarding e o texto registrado pela Edge Function", () => {
  assertEquals(canonicoDoEspelho(ESPELHO), textoCanonicoConsentimento(CANONICO));
  assertEquals(ESPELHO.versao, CANONICO.versao);
});

Deno.test("o texto cobre os quatro pontos exigidos pela fase", () => {
  const texto = textoCanonicoConsentimento().toLowerCase();

  assert(texto.includes("tcc") && texto.includes("prototipo"), "prototipo academico");
  assert(texto.includes("saude") && texto.includes("sensivel"), "dado sensivel de saude");
  assert(texto.includes("anonimizada") && texto.includes("academica"), "uso academico anonimizado");
  assert(texto.includes("exclusao"), "direito de exclusao");
  // O rotulo do checkbox precisa ser afirmativo por si so: e ele que fica
  // ao lado da caixa que a pessoa marca.
  assert(CANONICO.rotuloCheckbox.toLowerCase().startsWith("li e concordo"));
});

Deno.test("hash canonico e estavel e sensivel a qualquer edicao do texto", async () => {
  const original = await hashTextoConsentimento();
  assertEquals(original, await hashTextoConsentimento());
  assert(/^[0-9a-f]{64}$/.test(original));

  const editado = await hashTextoConsentimento({
    ...CANONICO,
    itens: CANONICO.itens.map((item, indice) =>
      indice === 0 ? { ...item, texto: item.texto.replace("TCC", "projeto") } : item
    ),
  });
  assert(original !== editado, "hash nao mudou com o texto editado");
});

Deno.test("so a versao atual e aceita pelo servidor", () => {
  assert(versaoConsentimentoAceita(CANONICO.versao));
  assert(versaoConsentimentoAceita(` ${CANONICO.versao} `));
  assert(!versaoConsentimentoAceita("2020-01-01.v0"));
  assert(!versaoConsentimentoAceita(undefined));
  assert(!versaoConsentimentoAceita(true));
});
