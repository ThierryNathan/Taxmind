// Mensagem de boas-vindas enviada quando o cadastro conclui.
//
// POR QUE ELA VIVE EM _shared, E NAO DENTRO DA bootstrap-identity
//
// O texto lista o que o TaxMind faz, e ja existe uma segunda lista dessas no
// node "WhatsApp - Enviar Sobre o TaxMind" do consulta-e-dossie.json. Sao
// mensagens diferentes de proposito — uma recebe, a outra responde "o que voce
// faz?" — mas descrevem o mesmo produto, e capacidade nova costuma entrar em so
// uma delas. Com o texto aqui, tests/n8n_export_contador_test.ts compara a
// cobertura das duas e falha quando divergem; dentro do index.ts o teste teria
// que importar um modulo que chama serve(), e duas suites nao dividem a porta
// 8000.
//
// POR QUE ELA E ENVIADA PELA bootstrap-identity
//
// O gatilho "cadastro concluido" nao existia em lugar nenhum. Os candidatos
// eram:
//
//   1. o fim do fluxo React. Descartado: o navegador nao pode disparar envio de
//      WhatsApp sem expor credencial, e a tela ja pode ser fechada antes.
//   2. a primeira mensagem que chega depois do cadastro, na whatsapp-webhook.
//      Descartado: exigiria uma flag de "ja dei boas-vindas" so para isso, e a
//      mensagem chegaria em resposta a outra coisa que o usuario mandou —
//      atrasada e fora de contexto.
//   3. a propria bootstrap-identity. Escolhida: e o unico ponto do sistema onde
//      o cadastro conclui de fato (e onde onboarding_concluido vira true), tem o
//      telefone verificado no token e roda uma vez so por cadastro.
//
// A tela de sucesso do onboarding manda "volte para o WhatsApp"; esta mensagem e
// o que espera a pessoa la.

/** Itens que a mensagem precisa cobrir. O teste de espelho usa esta lista para
 *  cobrar a mesma cobertura da resposta "o que voce faz?" no n8n. */
export const CAPACIDADES_ANUNCIADAS = [
  "despesa",
  "dedu",
  "resumo",
  "dossiê",
  "planilha",
  "contador",
] as const;

export function mensagemBoasVindas(nome?: string | null): string {
  const saudacao = nome?.trim() ? `Tudo certo, ${primeiroNome(nome)}!` : "Tudo certo!";

  return [
    `${saudacao} Seu cadastro está concluído e já pode me mandar recibo.`,
    "O que eu faço por aqui:",
    "1. Registro suas despesas — manda a foto do cupom ou escreve por texto (ex.: 'dentista 500').",
    "2. Classifico cada uma quanto à dedutibilidade no IRPF e separo o que precisa de revisão.",
    "3. Mostro seu resumo fiscal quando você manda 'resumo'.",
    "4. Gero seu dossiê completo em PDF quando você manda 'dossiê'.",
    "5. Monto a planilha estruturada para o seu contador, já separada entre dedução pessoal e Livro-Caixa — é só pedir 'planilha'.",
    "6. Conecto sua conta bancária pelo Open Finance para importar transações — é só pedir 'conectar meu banco'.",
    // O mesmo cuidado do dossie e da confirmacao de despesa: deducao reduz a
    // BASE DE CALCULO, e a mensagem de boas-vindas e justamente onde a
    // expectativa de "dinheiro de volta" se forma.
    "Uma nota: o que eu organizo reduz a base de cálculo do seu IR, não é dinheiro que volta — e eu não substituo seu contador, preparo a evidência para ele revisar.",
    "Pode começar mandando um recibo.",
  ].join("\n\n");
}

function primeiroNome(nome: string) {
  return nome.trim().split(/\s+/)[0];
}
