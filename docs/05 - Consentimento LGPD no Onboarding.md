# 05 - Consentimento LGPD no Onboarding

Relacionado a [[00 - Mapa da Arquitetura]] e [[02 - Arquitetura de Confianca e LGPD]].

Fase 12. O onboarding passou a ter um passo de consentimento entre o formulario
(nome, e-mail, CPF) e a criacao da conta. E o unico ponto **bloqueante** da
fase: sem o checkbox marcado, a `bootstrap-identity` recusa a chamada com
`400 consentimento_obrigatorio` e nenhuma conta e criada.

Bloquear aqui e aceitavel porque acontece **uma vez**, no cadastro, junto do que
ja era obrigatorio. Os outros ajustes da fase (data inferida e follow-up de
campo faltante) seguem a regra oposta: nunca atrasam o fluxo do usuario.

## Onde o consentimento e verificado

O checkbox e a interface do gate, nao o gate. A validacao real esta no servidor,
na `bootstrap-identity`, e roda **depois** da verificacao do token HMAC e do
formato de e-mail/CPF:

1. `consentimento_aceito !== true` -> `400 consentimento_obrigatorio`.
2. `consentimento_versao` diferente da versao atual -> `400 consentimento_versao_invalida`.

A ordem preserva o `probeBootstrapToken` do frontend, que sonda o token com
corpo vazio e distingue `401` (token invalido) de qualquer outro status.

Recusar versao desconhecida nao e formalidade: um bundle antigo em cache
enviaria a versao anterior depois de o texto mudar, e o registro afirmaria que a
pessoa concordou com um texto que ela nunca leu. O frontend traduz esse 400 em
"recarregue esta pagina".

## Onde o aceite fica gravado

Tabela propria `consentimentos_lgpd` (migration `008`), e nao apenas
`usuarios.consentimento_lgpd_em`:

| Motivo | Detalhe |
| --- | --- |
| A pergunta da LGPD e "consentiu com o que" | Um timestamp sozinho nao diz a qual texto a pessoa disse sim |
| O texto vai mudar | Hoje ele diz "prototipo academico / TCC". Cada versao precisa do proprio aceite, e uma coluna guarda so o ultimo estado |
| Evidencia nao pode ser editavel pelo titular | `usuarios` tem policy de UPDATE do proprio registro desde a `001`; a tabela nova nao tem policy de escrita para `authenticated` |

`usuarios.consentimento_lgpd_em` continua sendo preenchida como ponteiro barato
("ja consentiu?"). A prova fica na tabela nova, com `versao`, `texto_hash`,
`canal` e `aceito_em`.

O `texto_hash` e SHA-256 da serializacao canonica do texto, **calculado no
servidor**. Hash vindo do navegador provaria apenas o que o navegador quis
afirmar.

Unique em `(usuario_id, versao)` com insert `ignoreDuplicates`: refazer o
onboarding com o mesmo texto preserva o aceite original, que e a data que
interessa.

## As duas copias do texto

O texto vive em dois arquivos:

- `supabase/functions/_shared/consentimento.ts` — canonico, usado pela Edge Function;
- `apps/onboarding/src/lib/consentimento.js` — espelho, usado pela tela.

Nao ha import que atravesse essa fronteira: o bundle da Edge Function so enxerga
`supabase/functions/` e o Vite so enxerga `apps/onboarding/`.
`tests/consentimento_espelho_test.ts` compara o texto canonico dos dois arquivos
e falha se alguem editar so um lado — o cenario perigoso e a tela mostrar um
texto enquanto o banco registra o aceite de outro.

## Versoes publicadas

| Versao | Desde | Resumo |
| --- | --- | --- |
| `2026-08-08.v1` | Fase 12 | Prototipo academico (TCC); processamento de dados financeiros e de categorias de saude (sensiveis pela LGPD), com leitura de recibos por IA; uso anonimizado e agregado em apresentacao academica; exclusao a pedido a qualquer momento |

O texto integral de cada versao esta no arquivo canonico, no historico do git.
Ao publicar uma versao nova: editar os **dois** arquivos, subir a `versao`,
acrescentar a linha nesta tabela e rodar `tests/consentimento_espelho_test.ts`.
