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
  // 2026-08-16.v1 sucede 2026-08-08.v1 numa correcao de ACENTUACAO, sem mudanca
  // de sentido. A versao subiu mesmo assim porque a regra deste arquivo e "a
  // versao responde a que texto esta pessoa disse sim": mantendo o rotulo
  // antigo, dois textos diferentes (e dois hashes diferentes) passariam a
  // responder pelo mesmo identificador, e o registro de aceite deixaria de
  // apontar para um texto unico. Quem ja aceitou continua registrado na versao
  // anterior; navegador com bundle em cache recebe 400 e recarrega.
  versao: "2026-08-16.v1",
  titulo: "Antes de concluir, precisamos do seu consentimento",
  intro:
    "O TaxMind é um protótipo acadêmico. Leia com atenção o que acontece com os seus dados antes de continuar.",
  itens: [
    {
      titulo: "Protótipo acadêmico",
      texto:
        "O TaxMind é um projeto de conclusão de curso (TCC), em desenvolvimento. Não é um serviço comercial, não substitui contador ou a Receita Federal, e pode apresentar erros de classificação fiscal.",
    },
    {
      titulo: "Dados financeiros e de saúde",
      texto:
        "Para classificar suas despesas, o TaxMind processa valores, estabelecimentos, documentos fiscais e categorias de despesa — incluindo despesas de saúde, que a LGPD trata como dado pessoal sensível. Recibos enviados por foto são lidos por um serviço de inteligência artificial.",
    },
    {
      titulo: "Uso acadêmico anonimizado",
      texto:
        "Seus dados podem ser usados de forma anonimizada e agregada na apresentação e na documentação acadêmica do TCC. Nome, CPF, e-mail, telefone e qualquer identificação direta nunca aparecem nesse material.",
    },
    {
      titulo: "Exclusão a qualquer momento",
      texto:
        "Você pode pedir a exclusão dos seus dados a qualquer momento, pelo próprio WhatsApp do TaxMind ou pelo e-mail de contato do projeto. O pedido apaga seu cadastro, suas despesas e os arquivos enviados.",
    },
  ],
  rotuloCheckbox:
    "Li e concordo com o tratamento dos meus dados, incluindo dados sensíveis de saúde, e com o uso anonimizado em apresentação acadêmica.",
  rodape:
    "Sem esse consentimento não conseguimos criar sua conta — ele é registrado com data, hora e versão deste texto.",
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
