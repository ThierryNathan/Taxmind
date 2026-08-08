// Espelho do texto de consentimento LGPD que a Edge Function considera
// canonico (supabase/functions/_shared/consentimento.ts).
//
// Duas copias porque o bundle da Edge Function so enxerga supabase/functions/ e
// o Vite so enxerga apps/onboarding/. tests/consentimento_espelho_test.ts
// importa os dois arquivos e compara o texto canonico: editar so um lado quebra
// o teste, que e exatamente o cenario perigoso — a tela mostrando um texto e o
// banco registrando o aceite de outro.

export const CONSENTIMENTO_ATUAL = {
  versao: '2026-08-08.v1',
  titulo: 'Antes de concluir, precisamos do seu consentimento',
  intro:
    'O TaxMind e um prototipo academico. Leia com atencao o que acontece com os seus dados antes de continuar.',
  itens: [
    {
      titulo: 'Prototipo academico',
      texto:
        'O TaxMind e um projeto de conclusao de curso (TCC), em desenvolvimento. Nao e um servico comercial, nao substitui contador ou a Receita Federal, e pode apresentar erros de classificacao fiscal.',
    },
    {
      titulo: 'Dados financeiros e de saude',
      texto:
        'Para classificar suas despesas, o TaxMind processa valores, estabelecimentos, documentos fiscais e categorias de despesa — incluindo despesas de saude, que a LGPD trata como dado pessoal sensivel. Recibos enviados por foto sao lidos por um servico de inteligencia artificial.',
    },
    {
      titulo: 'Uso academico anonimizado',
      texto:
        'Seus dados podem ser usados de forma anonimizada e agregada na apresentacao e na documentacao academica do TCC. Nome, CPF, e-mail, telefone e qualquer identificacao direta nunca aparecem nesse material.',
    },
    {
      titulo: 'Exclusao a qualquer momento',
      texto:
        'Voce pode pedir a exclusao dos seus dados a qualquer momento, pelo proprio WhatsApp do TaxMind ou pelo e-mail de contato do projeto. O pedido apaga seu cadastro, suas despesas e os arquivos enviados.',
    },
  ],
  rotuloCheckbox:
    'Li e concordo com o tratamento dos meus dados, incluindo dados sensiveis de saude, e com o uso anonimizado em apresentacao academica.',
  rodape:
    'Sem esse consentimento nao conseguimos criar sua conta — ele e registrado com data, hora e versao deste texto.',
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
