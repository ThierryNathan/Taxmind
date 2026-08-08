// Texto de consentimento LGPD exibido no onboarding (Fase 12).
//
// Copia canonica. A tela do onboarding tem um espelho em
// apps/onboarding/src/lib/consentimento.js, porque o bundle da Edge Function so
// enxerga supabase/functions/ e o Vite so enxerga apps/onboarding/ — nao existe
// import que atravesse essa fronteira sem quebrar um dos dois deploys.
// tests/consentimento_espelho_test.ts compara o texto canonico dos dois
// arquivos e falha se alguem editar so um lado.
//
// A versao entra no registro do aceite: e ela que responde "a que texto esta
// pessoa disse sim". Mudou uma palavra do texto, muda a versao — o hash
// canonico existe justamente para que uma edicao silenciosa nao passe
// despercebida (o teste do espelho recalcula e compara).

export type TextoConsentimento = {
  versao: string;
  titulo: string;
  intro: string;
  itens: Array<{ titulo: string; texto: string }>;
  rotuloCheckbox: string;
  rodape: string;
};

export const CONSENTIMENTO_ATUAL: TextoConsentimento = {
  versao: "2026-08-08.v1",
  titulo: "Antes de concluir, precisamos do seu consentimento",
  intro:
    "O TaxMind e um prototipo academico. Leia com atencao o que acontece com os seus dados antes de continuar.",
  itens: [
    {
      titulo: "Prototipo academico",
      texto:
        "O TaxMind e um projeto de conclusao de curso (TCC), em desenvolvimento. Nao e um servico comercial, nao substitui contador ou a Receita Federal, e pode apresentar erros de classificacao fiscal.",
    },
    {
      titulo: "Dados financeiros e de saude",
      texto:
        "Para classificar suas despesas, o TaxMind processa valores, estabelecimentos, documentos fiscais e categorias de despesa — incluindo despesas de saude, que a LGPD trata como dado pessoal sensivel. Recibos enviados por foto sao lidos por um servico de inteligencia artificial.",
    },
    {
      titulo: "Uso academico anonimizado",
      texto:
        "Seus dados podem ser usados de forma anonimizada e agregada na apresentacao e na documentacao academica do TCC. Nome, CPF, e-mail, telefone e qualquer identificacao direta nunca aparecem nesse material.",
    },
    {
      titulo: "Exclusao a qualquer momento",
      texto:
        "Voce pode pedir a exclusao dos seus dados a qualquer momento, pelo proprio WhatsApp do TaxMind ou pelo e-mail de contato do projeto. O pedido apaga seu cadastro, suas despesas e os arquivos enviados.",
    },
  ],
  rotuloCheckbox:
    "Li e concordo com o tratamento dos meus dados, incluindo dados sensiveis de saude, e com o uso anonimizado em apresentacao academica.",
  rodape:
    "Sem esse consentimento nao conseguimos criar sua conta — ele e registrado com data, hora e versao deste texto.",
};

/**
 * Serializacao estavel do texto, usada para hash e para a comparacao com o
 * espelho do frontend. Formato proprio (e nao JSON.stringify) para nao depender
 * da ordem das chaves do objeto em cada runtime.
 */
export function textoCanonicoConsentimento(texto: TextoConsentimento = CONSENTIMENTO_ATUAL): string {
  return [
    `versao:${texto.versao}`,
    `titulo:${texto.titulo}`,
    `intro:${texto.intro}`,
    ...texto.itens.map((item, indice) => `item${indice}:${item.titulo}|${item.texto}`),
    `checkbox:${texto.rotuloCheckbox}`,
    `rodape:${texto.rodape}`,
  ].join("\n");
}

export async function hashTextoConsentimento(
  texto: TextoConsentimento = CONSENTIMENTO_ATUAL,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(textoCanonicoConsentimento(texto)),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * A versao informada pelo navegador e aceitavel?
 *
 * Recusar versao desconhecida nao e formalidade: um bundle antigo em cache
 * enviaria a versao antiga depois de o texto mudar, e o registro afirmaria que
 * a pessoa concordou com um texto que ela nao leu. Quando houver versao nova,
 * a antiga sai desta lista e o navegador com cache velho recebe 400 — o
 * onboarding recarrega e mostra o texto atual.
 */
export function versaoConsentimentoAceita(versao: unknown): versao is string {
  return typeof versao === "string" && versao.trim() === CONSENTIMENTO_ATUAL.versao;
}
