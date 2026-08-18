// Espelho do texto de consentimento LGPD que a Edge Function considera
// canonico (supabase/functions/_shared/consentimento.ts).
//
// Duas copias porque o bundle da Edge Function so enxerga supabase/functions/ e
// o Vite so enxerga apps/onboarding/. tests/consentimento_espelho_test.ts
// importa os dois arquivos e compara o texto canonico: editar so um lado quebra
// o teste, que e exatamente o cenario perigoso — a tela mostrando um texto e o
// banco registrando o aceite de outro.

export const CONSENTIMENTO_ATUAL = {
  versao: '2026-08-16.v1',
  titulo: 'Antes de concluir, precisamos do seu consentimento',
  intro:
    'O TaxMind é um protótipo acadêmico. Leia com atenção o que acontece com os seus dados antes de continuar.',
  itens: [
    {
      titulo: 'Protótipo acadêmico',
      texto:
        'O TaxMind é um projeto de conclusão de curso (TCC), em desenvolvimento. Não é um serviço comercial, não substitui contador ou a Receita Federal, e pode apresentar erros de classificação fiscal.',
    },
    {
      titulo: 'Dados financeiros e de saúde',
      texto:
        'Para classificar suas despesas, o TaxMind processa valores, estabelecimentos, documentos fiscais e categorias de despesa — incluindo despesas de saúde, que a LGPD trata como dado pessoal sensível. Recibos enviados por foto são lidos por um serviço de inteligência artificial.',
    },
    {
      titulo: 'Uso acadêmico anonimizado',
      texto:
        'Seus dados podem ser usados de forma anonimizada e agregada na apresentação e na documentação acadêmica do TCC. Nome, CPF, e-mail, telefone e qualquer identificação direta nunca aparecem nesse material.',
    },
    {
      titulo: 'Exclusão a qualquer momento',
      texto:
        'Você pode pedir a exclusão dos seus dados a qualquer momento, pelo próprio WhatsApp do TaxMind ou pelo e-mail de contato do projeto. O pedido apaga seu cadastro, suas despesas e os arquivos enviados.',
    },
  ],
  rotuloCheckbox:
    'Li e concordo com o tratamento dos meus dados, incluindo dados sensíveis de saúde, e com o uso anonimizado em apresentação acadêmica.',
  rodape:
    'Sem esse consentimento não conseguimos criar sua conta — ele é registrado com data, hora e versão deste texto.',
}

export function textoCanonicoConsentimento(texto = CONSENTIMENTO_ATUAL) {
  return [
    `versao:${texto.versao}`,
    `titulo:${texto.titulo}`,
    `intro:${texto.intro}`,
    ...texto.itens.map((item, indice) => `item${indice}:${item.titulo}|${item.texto}`),
    `checkbox:${texto.rotuloCheckbox}`,
    `rodape:${texto.rodape}`,
  ].join('\n')
}
