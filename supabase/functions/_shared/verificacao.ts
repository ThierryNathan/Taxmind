// Logica pura da re-verificacao por e-mail (Fase 7).
//
// Vive em _shared, e nao dentro da whatsapp-webhook, por testabilidade: o
// index.ts chama serve() no topo, entao importar aquele arquivo num teste
// subiria um servidor HTTP. Aqui ficam so funcoes deterministicas (geracao,
// hash, janela de confianca, avaliacao do codigo informado), exercitadas por
// tests/verificacao_test.ts. O I/O — Supabase, Resend, WhatsApp — continua na
// function.

import { hmacSha256Hex } from "./bootstrap_token.ts";

const env = (name: string, fallback = "") => Deno.env.get(name) ?? fallback;

/** Janela de confianca: passado esse tempo desde a ultima verificacao, o
 *  usuario precisa confirmar identidade por e-mail antes de a mensagem seguir
 *  para o n8n. */
export const JANELA_CONFIANCA_DIAS = 30;

/** Validade do codigo enviado por e-mail. */
export const CODIGO_TTL_MINUTOS = 15;

/** Tentativas erradas toleradas antes de exigir um codigo novo. */
export const MAX_TENTATIVAS = 3;

export const CODIGO_DIGITOS = 6;

const MS_POR_DIA = 24 * 60 * 60 * 1000;
const MS_POR_MINUTO = 60 * 1000;

/**
 * Codigo decimal de 6 digitos com entropia criptografica e sem vies de modulo.
 *
 * O descarte (rejection sampling) importa: 2^32 nao e multiplo de 10^6, entao
 * `uint32 % 1e6` deixaria os primeiros 967.296 codigos ligeiramente mais
 * provaveis que os demais. Zeros a esquerda sao codigos validos ("004217").
 */
export function gerarCodigoVerificacao(): string {
  const total = 10 ** CODIGO_DIGITOS;
  const limite = Math.floor(4294967296 / total) * total;
  const buffer = new Uint32Array(1);

  let sorteado = limite;
  while (sorteado >= limite) {
    crypto.getRandomValues(buffer);
    sorteado = buffer[0];
  }

  return String(sorteado % total).padStart(CODIGO_DIGITOS, "0");
}

/**
 * HMAC-SHA256 hex do codigo, com o mesmo pepper do cpf_hash.
 *
 * O codigo em claro nunca vai para o banco: vaza-lo num dump ou num log daria
 * a quem lesse a chance de assumir a sessao de WhatsApp de outra pessoa. Como
 * o espaco e de so 10^6 valores, hash sem pepper seria quebravel por tabela
 * pre-computada em segundos — por isso HMAC com segredo, nao sha256 puro.
 */
export function hashCodigoVerificacao(codigo: string, pepper = resolverPepper()): Promise<string> {
  return hmacSha256Hex(pepper, `codigo_verificacao:${codigo}`);
}

function resolverPepper() {
  const pepper = env("CPF_HASH_PEPPER") || env("TAXMIND_BOOTSTRAP_SECRET");
  if (!pepper) {
    throw new Error("missing_codigo_hash_pepper");
  }
  return pepper;
}

/**
 * A janela de confianca venceu?
 *
 * `null` significa "nunca verificado": nesse caso precisa verificar. A
 * comparacao e >= para que o limite exato de 30 dias ja exija verificacao, e
 * data invalida (parse NaN) tambem cai em "precisa", porque o caminho seguro
 * quando nao se sabe a data e verificar de novo.
 */
export function precisaReverificar(
  verificadoEm: string | Date | null | undefined,
  agora: Date = new Date(),
): boolean {
  if (!verificadoEm) return true;

  const referencia = verificadoEm instanceof Date ? verificadoEm : new Date(verificadoEm);
  const instante = referencia.getTime();
  if (Number.isNaN(instante)) return true;

  return agora.getTime() - instante >= JANELA_CONFIANCA_DIAS * MS_POR_DIA;
}

export function calcularExpiracaoCodigo(agora: Date = new Date()): Date {
  return new Date(agora.getTime() + CODIGO_TTL_MINUTOS * MS_POR_MINUTO);
}

export function codigoExpirado(
  expiraEm: string | Date | null | undefined,
  agora: Date = new Date(),
): boolean {
  if (!expiraEm) return true;

  const limite = expiraEm instanceof Date ? expiraEm : new Date(expiraEm);
  const instante = limite.getTime();
  if (Number.isNaN(instante)) return true;

  return agora.getTime() >= instante;
}

/**
 * Extrai um codigo de 6 digitos de uma mensagem de texto do WhatsApp.
 *
 * Aceita o que o usuario naturalmente digita ("123456", " 123 456 ",
 * "123-456") e recusa qualquer coisa que tenha outro conteudo — "gastei 123456
 * no mercado" nao e um codigo, e tratar como codigo transformaria uma despesa
 * legitima em tentativa errada, queimando o limite de tentativas.
 */
export function extrairCodigo(texto: string | null | undefined): string | null {
  if (!texto) return null;

  const limpo = texto.trim().replace(/[\s.\-]/g, "");
  return new RegExp(`^\\d{${CODIGO_DIGITOS}}$`).test(limpo) ? limpo : null;
}

export type CodigoArmazenado = {
  codigo_hash: string;
  expira_em: string;
  tentativas: number;
  max_tentativas: number;
  consumido_em?: string | null;
  invalidado_em?: string | null;
};

export type ResultadoValidacao =
  | { status: "valido" }
  | { status: "expirado" }
  | { status: "indisponivel" }
  | { status: "esgotado" }
  | { status: "invalido"; tentativas: number; tentativasRestantes: number };

/**
 * Avalia o codigo informado contra o registro do banco. Funcao pura: quem
 * chama decide o que gravar a partir do status.
 *
 * Ordem das checagens e deliberada — consumido/invalidado e expiracao vem
 * antes da comparacao do hash, para que um codigo vencido nao consuma
 * tentativa nem revele, pelo tipo de resposta, se o palpite estava certo.
 */
export function avaliarCodigo(
  armazenado: CodigoArmazenado | null | undefined,
  hashInformado: string,
  agora: Date = new Date(),
): ResultadoValidacao {
  if (!armazenado || armazenado.consumido_em || armazenado.invalidado_em) {
    return { status: "indisponivel" };
  }

  if (codigoExpirado(armazenado.expira_em, agora)) {
    return { status: "expirado" };
  }

  const maxTentativas = armazenado.max_tentativas ?? MAX_TENTATIVAS;
  if (armazenado.tentativas >= maxTentativas) {
    return { status: "esgotado" };
  }

  if (timingSafeEqualHex(armazenado.codigo_hash, hashInformado)) {
    return { status: "valido" };
  }

  const tentativas = armazenado.tentativas + 1;
  return {
    status: tentativas >= maxTentativas ? "esgotado" : "invalido",
    tentativas,
    tentativasRestantes: Math.max(maxTentativas - tentativas, 0),
  } as ResultadoValidacao;
}

// Comparacao dos hashes em tempo constante. Ambos os lados sao hex de 64
// caracteres derivados do mesmo HMAC, entao vazamento por timing aqui e
// remoto; ainda assim, comparar credencial com === e o tipo de detalhe que
// depois ninguem revisita.
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * Mascara o e-mail para exibicao no WhatsApp.
 *
 * O WhatsApp e o canal menos protegido do fluxo: se alguem esta com o celular
 * da pessoa, repetir o endereco completo entrega o proximo alvo. Mascarado, o
 * dono reconhece a conta e um terceiro nao aprende nada novo.
 */
export function mascararEmail(email: string | null | undefined): string {
  if (!email || !email.includes("@")) return "seu e-mail cadastrado";

  const [usuario, dominio] = email.split("@");
  if (usuario.length <= 2) {
    return `${usuario[0] ?? ""}***@${dominio}`;
  }
  return `${usuario[0]}***${usuario[usuario.length - 1]}@${dominio}`;
}
