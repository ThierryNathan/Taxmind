// Testes da logica pura de re-verificacao por e-mail (Fase 7).
//
// Rodar:  deno test --allow-env tests/verificacao_test.ts
//
// Cobre geracao de codigo, hash, janela de confianca de 30 dias, expiracao de
// 15 minutos e a matriz de avaliacao (valido, invalido, esgotado, expirado,
// indisponivel). Nada aqui toca banco, Resend ou WhatsApp.

import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  avaliarCodigo,
  calcularExpiracaoCodigo,
  CODIGO_DIGITOS,
  codigoExpirado,
  extrairCodigo,
  gerarCodigoVerificacao,
  hashCodigoVerificacao,
  JANELA_CONFIANCA_DIAS,
  mascararEmail,
  MAX_TENTATIVAS,
  precisaReverificar,
} from "../supabase/functions/_shared/verificacao.ts";

Deno.env.set("CPF_HASH_PEPPER", "pepper_de_teste_com_mais_de_32_caracteres_ok");

const AGORA = new Date("2026-07-26T12:00:00.000Z");
const DIA = 24 * 60 * 60 * 1000;
const MINUTO = 60 * 1000;

// --- geracao de codigo ----------------------------------------------------

Deno.test("gerarCodigoVerificacao devolve sempre 6 digitos decimais", () => {
  for (let i = 0; i < 2000; i += 1) {
    const codigo = gerarCodigoVerificacao();
    assertEquals(codigo.length, CODIGO_DIGITOS, `codigo com tamanho errado: ${codigo}`);
    assert(/^\d{6}$/.test(codigo), `codigo fora do formato: ${codigo}`);
  }
});

Deno.test("gerarCodigoVerificacao nao repete de forma degenerada", () => {
  const amostras = new Set<string>();
  for (let i = 0; i < 5000; i += 1) {
    amostras.add(gerarCodigoVerificacao());
  }
  // Com 10^6 valores possiveis, 5000 sorteios devem render quase 5000 valores
  // distintos (colisao de aniversario espera ~12). Um gerador travado ou com
  // entropia pobre cairia muito abaixo disso.
  assert(amostras.size > 4900, `entropia suspeita: apenas ${amostras.size} valores distintos`);
});

Deno.test("gerarCodigoVerificacao cobre a faixa inteira, incluindo zeros a esquerda", () => {
  let comZeroInicial = 0;
  let acimaDeMeio = 0;
  for (let i = 0; i < 20000; i += 1) {
    const codigo = gerarCodigoVerificacao();
    if (codigo.startsWith("0")) comZeroInicial += 1;
    if (Number(codigo) >= 500000) acimaDeMeio += 1;
  }
  // ~10% esperado com zero inicial e ~50% na metade de cima. Margem larga de
  // proposito: o teste checa que a distribuicao nao esta truncada, nao a
  // qualidade estatistica do CSPRNG.
  assert(comZeroInicial > 1200, `poucos codigos com zero a esquerda: ${comZeroInicial}`);
  assert(
    acimaDeMeio > 8000 && acimaDeMeio < 12000,
    `distribuicao desbalanceada na faixa alta: ${acimaDeMeio}`,
  );
});

// --- hash -----------------------------------------------------------------

Deno.test("hashCodigoVerificacao e deterministico e nao devolve o codigo", async () => {
  const primeiro = await hashCodigoVerificacao("123456");
  const segundo = await hashCodigoVerificacao("123456");

  assertEquals(primeiro, segundo);
  assertEquals(primeiro.length, 64);
  assert(/^[0-9a-f]{64}$/.test(primeiro));
  assert(!primeiro.includes("123456"));
});

Deno.test("hashCodigoVerificacao separa codigos diferentes e peppers diferentes", async () => {
  const a = await hashCodigoVerificacao("123456");
  const b = await hashCodigoVerificacao("123457");
  const c = await hashCodigoVerificacao("123456", "outro_pepper");

  assertNotEquals(a, b);
  assertNotEquals(a, c);
});

Deno.test("codigo com zero a esquerda nao colide com a versao numerica", async () => {
  // Se em algum ponto o codigo virasse Number e voltasse para string, "004217"
  // e "4217" produziriam o mesmo hash. Este teste trava esse regresso.
  const comZero = await hashCodigoVerificacao("004217");
  const semZero = await hashCodigoVerificacao("4217");
  assertNotEquals(comZero, semZero);
});

// --- janela de confianca de 30 dias --------------------------------------

Deno.test("precisaReverificar respeita a janela de 30 dias", () => {
  const casos: Array<[string, number, boolean]> = [
    ["1 dia atras", 1, false],
    ["29 dias atras", 29, false],
    ["30 dias menos 1 minuto", 30 - 1 / (24 * 60), false],
    ["exatamente 30 dias", 30, true],
    ["31 dias atras", 31, true],
    ["1 ano atras", 365, true],
  ];

  for (const [rotulo, dias, esperado] of casos) {
    const verificadoEm = new Date(AGORA.getTime() - dias * DIA).toISOString();
    assertEquals(
      precisaReverificar(verificadoEm, AGORA),
      esperado,
      `caso "${rotulo}" deveria devolver ${esperado}`,
    );
  }

  assertEquals(JANELA_CONFIANCA_DIAS, 30);
});

Deno.test("precisaReverificar trata ausencia e sujeira como 'precisa verificar'", () => {
  assertEquals(precisaReverificar(null, AGORA), true);
  assertEquals(precisaReverificar(undefined, AGORA), true);
  assertEquals(precisaReverificar("", AGORA), true);
  assertEquals(precisaReverificar("nao-e-data", AGORA), true);
});

Deno.test("precisaReverificar aceita Date e data no futuro", () => {
  assertEquals(precisaReverificar(new Date(AGORA.getTime() - 2 * DIA), AGORA), false);
  // Relogio adiantado no banco nao deve disparar verificacao.
  assertEquals(precisaReverificar(new Date(AGORA.getTime() + DIA), AGORA), false);
});

// --- expiracao do codigo -------------------------------------------------

Deno.test("calcularExpiracaoCodigo devolve 15 minutos a frente", () => {
  const expira = calcularExpiracaoCodigo(AGORA);
  assertEquals(expira.getTime() - AGORA.getTime(), 15 * MINUTO);
});

Deno.test("codigoExpirado vira no limite dos 15 minutos", () => {
  const expira = calcularExpiracaoCodigo(AGORA);

  assertEquals(codigoExpirado(expira, AGORA), false);
  assertEquals(codigoExpirado(expira, new Date(AGORA.getTime() + 14 * MINUTO)), false);
  assertEquals(
    codigoExpirado(expira, new Date(AGORA.getTime() + 15 * MINUTO - 1)),
    false,
  );
  assertEquals(codigoExpirado(expira, new Date(AGORA.getTime() + 15 * MINUTO)), true);
  assertEquals(codigoExpirado(expira, new Date(AGORA.getTime() + 60 * MINUTO)), true);
});

Deno.test("codigoExpirado trata ausencia e sujeira como expirado", () => {
  assertEquals(codigoExpirado(null, AGORA), true);
  assertEquals(codigoExpirado(undefined, AGORA), true);
  assertEquals(codigoExpirado("qualquer coisa", AGORA), true);
});

// --- extracao do codigo da mensagem -------------------------------------

Deno.test("extrairCodigo aceita o que o usuario realmente digita", () => {
  assertEquals(extrairCodigo("123456"), "123456");
  assertEquals(extrairCodigo("  123456 "), "123456");
  assertEquals(extrairCodigo("123 456"), "123456");
  assertEquals(extrairCodigo("123-456"), "123456");
  assertEquals(extrairCodigo("004217"), "004217");
});

Deno.test("extrairCodigo recusa texto que apenas contem digitos", () => {
  // O caso que importa: uma despesa legitima nao pode ser lida como palpite de
  // codigo, senao queima tentativa e a despesa se perde.
  assertEquals(extrairCodigo("gastei 123456 no mercado"), null);
  assertEquals(extrairCodigo("codigo 123456"), null);
  assertEquals(extrairCodigo("12345"), null);
  assertEquals(extrairCodigo("1234567"), null);
  assertEquals(extrairCodigo("R$ 123,45"), null);
  assertEquals(extrairCodigo("bom dia"), null);
  assertEquals(extrairCodigo(""), null);
  assertEquals(extrairCodigo(null), null);
});

// --- avaliacao do codigo informado --------------------------------------

const registroBase = async (overrides: Record<string, unknown> = {}) => ({
  codigo_hash: await hashCodigoVerificacao("123456"),
  expira_em: calcularExpiracaoCodigo(AGORA).toISOString(),
  tentativas: 0,
  max_tentativas: MAX_TENTATIVAS,
  consumido_em: null,
  invalidado_em: null,
  ...overrides,
});

Deno.test("avaliarCodigo aceita o codigo correto dentro da validade", async () => {
  const registro = await registroBase();
  const resultado = avaliarCodigo(registro, await hashCodigoVerificacao("123456"), AGORA);
  assertEquals(resultado.status, "valido");
});

Deno.test("avaliarCodigo conta tentativa errada e esgota na terceira", async () => {
  const informado = await hashCodigoVerificacao("999999");

  const primeira = avaliarCodigo(await registroBase({ tentativas: 0 }), informado, AGORA);
  assertEquals(primeira, { status: "invalido", tentativas: 1, tentativasRestantes: 2 });

  const segunda = avaliarCodigo(await registroBase({ tentativas: 1 }), informado, AGORA);
  assertEquals(segunda, { status: "invalido", tentativas: 2, tentativasRestantes: 1 });

  // Terceira tentativa errada nao volta "invalido": o codigo morre aqui e o
  // usuario precisa de um codigo novo.
  const terceira = avaliarCodigo(await registroBase({ tentativas: 2 }), informado, AGORA);
  assertEquals(terceira.status, "esgotado");
});

Deno.test("avaliarCodigo recusa registro que ja atingiu o limite", async () => {
  const registro = await registroBase({ tentativas: MAX_TENTATIVAS });
  const correto = await hashCodigoVerificacao("123456");

  // Mesmo com o codigo certo: limite estourado exige codigo novo.
  assertEquals(avaliarCodigo(registro, correto, AGORA).status, "esgotado");
});

Deno.test("avaliarCodigo trata expiracao antes de comparar o hash", async () => {
  const registro = await registroBase();
  const depois = new Date(AGORA.getTime() + 16 * MINUTO);

  assertEquals(
    avaliarCodigo(registro, await hashCodigoVerificacao("123456"), depois).status,
    "expirado",
  );
  // Codigo errado e vencido tambem devolve "expirado" — nao consome tentativa
  // nem revela se o palpite estava certo.
  assertEquals(
    avaliarCodigo(registro, await hashCodigoVerificacao("999999"), depois).status,
    "expirado",
  );
});

Deno.test("avaliarCodigo recusa codigo ja consumido ou invalidado", async () => {
  const correto = await hashCodigoVerificacao("123456");

  const consumido = await registroBase({ consumido_em: AGORA.toISOString() });
  assertEquals(avaliarCodigo(consumido, correto, AGORA).status, "indisponivel");

  const invalidado = await registroBase({ invalidado_em: AGORA.toISOString() });
  assertEquals(avaliarCodigo(invalidado, correto, AGORA).status, "indisponivel");

  assertEquals(avaliarCodigo(null, correto, AGORA).status, "indisponivel");
});

Deno.test("avaliarCodigo nao valida por prefixo nem por tamanho de hash", async () => {
  const registro = await registroBase();
  const correto = await hashCodigoVerificacao("123456");

  assertEquals(avaliarCodigo(registro, correto.slice(0, 32), AGORA).status, "invalido");
  assertEquals(avaliarCodigo(registro, "", AGORA).status, "invalido");
  assertEquals(avaliarCodigo(registro, `${correto}00`, AGORA).status, "invalido");
});

// --- mascara de e-mail ---------------------------------------------------

Deno.test("mascararEmail preserva o dominio e esconde o local-part", () => {
  assertEquals(mascararEmail("thierrynathan1@gmail.com"), "t***1@gmail.com");
  assertEquals(mascararEmail("ab@dominio.com.br"), "a***@dominio.com.br");
  assertEquals(mascararEmail("a@dominio.com"), "a***@dominio.com");
  assertEquals(mascararEmail(null), "seu e-mail cadastrado");
  assertEquals(mascararEmail("sem-arroba"), "seu e-mail cadastrado");
});
