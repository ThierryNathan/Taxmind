# 06 - Follow-up Conversacional

Relacionado a [[00 - Mapa da Arquitetura]], [[01 - Fluxo Conversacional e Janela de 24h]] e [[03 - Motor OCR de Nicho e Human-in-the-Loop]].

Fase 13. Quando uma despesa cai em `REVISAO_HUMANA` porque falta um campo
**estruturado e objetivamente respondivel**, o bot pergunta esse campo na mesma
mensagem de confirmacao.

A regra que manda em tudo aqui e a de nao-bloqueio: **a despesa e gravada e
confirmada antes de a pergunta existir**. A pergunta e uma oportunidade de
upgrade para `DEDUTIVEL`, nunca um requisito para o lancamento. Ignorar nao
quebra nada; a pendencia expira sozinha.

Isso e o oposto do consentimento LGPD ([[05 - Consentimento LGPD no Onboarding]]),
que e bloqueante de proposito por ser um gate unico no cadastro.

## Quando a pergunta acontece

Nunca por ambiguidade fiscal. A decisao tem duas metades, e so uma delas e da
IA:

1. **A IA declara o destino**, em `deducibilidade_se_desbloqueado`: se o usuario
   dissesse agora quem foi o prestador, a despesa ficaria aprovavel? Preenchido
   (`DEDUTIVEL` / `PARCIALMENTE_DEDUTIVEL`) quer dizer sim; `null` quer dizer que
   sobra motivo que nenhuma resposta objetiva resolve.
2. **O codigo deriva o campo**, olhando quais dos dois campos de identificacao —
   `documento_prestador` e `estabelecimento` — sairam vazios da extracao.
   `documento_prestador` tem precedencia, por ser o unico verificavel sem IA.

| Situacao | Destino declarado | Campo derivado | Pergunta? |
| --- | --- | --- | --- |
| Falta o CNPJ da clinica, resto ok | `DEDUTIVEL` | `["documento_prestador"]` | Sim |
| Falta saber onde foi, resto ok | `DEDUTIVEL` | `["estabelecimento"]` | Sim |
| Falta CNPJ **e** estabelecimento | `DEDUTIVEL` | `["documento_prestador"]` | Sim |
| Uso misto pessoal/profissional | `null` | `[]` | Nao |
| Possivel reembolso pelo plano | `null` | `[]` | Nao |
| OCR ruim, valores contraditorios | `null` | `[]` | Nao |

O mesmo `deducibilidade_se_desbloqueado` diz para onde a despesa vai quando o
campo for preenchido. Sem ele a promocao teria que adivinhar dedutibilidade
fiscal, e adivinhar ali significa afirmar algo que ninguem analisou.

### Por que a lista deixou de ser um campo da IA

Ate a correcao existia um campo `campos_bloqueantes` na resposta do modelo,
definido como "o subconjunto de `campos_ausentes` que, preenchido **sozinho**,
removeria a revisao". A definicao e irrealizavel na linha 3 da tabela: faltando
os dois campos, nenhum deles sozinho satisfaz, e o modelo devolvia `[]`
obedecendo a regra ao pe da letra. O `Tem Campo Bloqueante?` nao criava
pendencia e o follow-up nunca disparava — em despesas de saude escritas do jeito
mais comum, "paguei 600 no proctologista", sem lugar e sem documento.

Medido contra o Gemini real na temperatura de producao: **10/10 execucoes com a
lista vazia** nessa mensagem, contra **6/6 preenchida** na mesma despesa com o
estabelecimento citado. Erro sistematico do desenho, nao variacao do modelo.

A correcao nao foi reescrever a regra, e sim tirar do modelo o que nunca foi
juizo dele. "Qual campo esta vazio" e fato da extracao, verificavel em codigo;
"identificar o prestador resolve o caso" e juizo fiscal, e continua com a IA num
campo so. Com um campo no lugar de dois, some a possibilidade de os dois se
contradizerem — que era exatamente o sintoma: `campos_ausentes`,
`motivos_revisao` e `pergunta_de_followup` apontando o documento enquanto
`campos_bloqueantes` vinha vazio na mesma resposta.

A lista derivada tem no maximo **um** campo. A regra fiscal de SAUDE pede
"identificacao do prestador **ou** estabelecimento", entao o CNPJ ja satisfaz o
requisito inteiro; e o follow-up so pergunta uma coisa, logo uma lista maior
nunca esvaziaria e a promocao ficaria esperando resposta que ninguem pediu.

Testes: `tests/n8n_campos_bloqueantes_test.ts` (derivacao e paridade entre as
duas copias) e `tests/prompt_gemini_test.ts` (consistencia entre execucoes
contra o Gemini real).

## Onde a pendencia vive

Tabela `followups_pendentes` (migration `009`), nao `sessoes_whatsapp.contexto`.
O motivo e o mesmo que levou `codigos_verificacao` para tabela propria na fase
7: `contexto` e read-modify-write de tres escritores, e a corrida aqui e
concreta — o n8n escreve a confirmacao no mesmo instante em que a
`whatsapp-webhook` pode estar atualizando o contexto com a mensagem seguinte.

**Uma pendencia aberta por usuario**, garantida por unique parcial
(`where respondida_em is null and descartada_em is null`). Duas perguntas em
aberto tornariam "a qual delas isto responde" insoluvel. Pendencia nova encerra
a anterior com motivo `SUPERSEDIDA`, dentro da mesma transacao da funcao
`registrar_followup_pendente` — em dois requests, duas mensagens simultaneas
conseguiriam encerrar as duas e disputar o insert.

## Quem faz o que

| Componente | Papel |
| --- | --- |
| `receipt-ocr-classification` (n8n) | Cria a pendencia via RPC e anexa a pergunta a confirmacao. O node tem `onError: continueRegularOutput`: falha ao registrar nao pode segurar a confirmacao |
| `whatsapp-webhook` (Edge) | Ciclo de vida: expira por tempo, conta o orcamento de mensagens, detecta resposta e **anota** no payload. E o unico componente que ve toda mensagem — texto e midia vao para workflows diferentes |
| `consulta-e-dossie` (n8n) | Roteia: resposta reconhecida atalha o classificador de intencao; intent `outro` com pendencia aberta tenta texto livre antes da mensagem de ajuda |
| `followup-resolve` (Edge) | Decide o modo, reivindica a pendencia e faz o patch. Toda a logica vive aqui por testabilidade |

## Desambiguacao: e resposta ou mensagem nova?

Cascata do mais barato para o mais caro. O vies e sempre "na duvida, e mensagem
nova": tratar um lancamento legitimo como resposta apaga uma despesa; deixar a
pendencia expirar nao custa nada.

1. **Midia nunca responde.** Foto de recibo e lancamento novo; so gasta orcamento.
2. **Casamento deterministico** do formato esperado. So `documento_prestador`
   tem resposta reconhecivel sem IA, porque CNPJ e CPF tem digito verificador.
   O documento e procurado em **qualquer posicao** da mensagem, e a recusa vem
   de tres filtros: digito verificador invalido, numero sobrando (que em
   mensagem de WhatsApp e quase sempre valor) ou vocabulario de gasto
   ("paguei", "custou", "reais"). `paguei 11222333000181 no mercado` **nao** e
   resposta; `cnpj dele e 11222333000181` e.
3. **Classificador de intencao** (o que ja existia). `registro_despesa`,
   `consulta_resumo`, `exportar_dossie`, `conectar_banco` -> mensagem nova, a
   pendencia nao e tocada.
4. **Reclassificacao por IA** so quando o intent cai em `outro` — ou seja, a
   mensagem nao se encaixa em mais nada. Custo perto de zero no caso comum.

`estabelecimento` cai sempre no caminho 4, de proposito: adivinhar nome de lugar
em texto livre roubaria lancamentos ("mercado 50 reais" e nome ou despesa?).

## Expiracao

O que vier primeiro:

- **30 minutos** — ritmo de conversa de WhatsApp: da para procurar o recibo na
  gaveta, e e curto o bastante para nao colar numa conversa de outro assunto;
- **2 mensagens** que nao respondem — a proxima mensagem e o lugar natural da
  resposta; passadas duas, o assunto mudou;
- **pendencia nova** do mesmo usuario (`SUPERSEDIDA`).

Resposta reconhecida **nao** consome orcamento: a propria resposta nao pode ser
a mensagem que fecha a pendencia que ela veio responder.

Nao existe lembrete de "voce nao respondeu". Isso transformaria uma pergunta
opcional em cobranca.

## Patch local x reclassificacao

| | `CAMPO_PREENCHIDO` | `RECLASSIFICADO` |
| --- | --- | --- |
| Quando | A mensagem e o documento pedido | Texto livre, evidencia nova |
| Chamada de IA | Nenhuma | Uma |
| O que muda | So o campo + promocao se `campos_bloqueantes` esvaziou | Categoria, deducibilidade, justificativa, prestador |
| Promocao | `deducibilidade_se_desbloqueado` declarada na analise original | So se a analise nova disser `requer_revisao_humana: false` |

O patch local existe para nao reprocessar o mesmo texto: a temperatura e 0.2,
nao 0, e uma reclassificacao pode **mudar** uma classificacao ja auditada, o que
contamina a trilha — o dossie mostraria uma analise que nunca foi feita sobre a
evidencia original.

Em nenhum dos dois modos `valor` e `data_despesa` sao reescritos: a evidencia
deles foi a mensagem original, e texto de follow-up nao pode mudar quanto e
quando em silencio. A analise original permanece inteira em `metadados_ia`; o
follow-up entra ao lado, em `metadados_ia.followups` ou
`metadados_ia.reclassificacoes`.

Promocao nunca rebaixa, e `SEM_RELACAO` (mensagem desconexa) nao mexe no recibo
nem fecha a pendencia.

### A resposta que nao responde nada

Antes de chamar a IA, o modo `RECLASSIFICADO` pergunta uma coisa mais basica: a
mensagem carrega **alguma** informacao? `respostaSemConteudo` recusa a mensagem
cujas palavras sao todas confirmacao, negacao, cortesia ou promessa de voltar
depois — e devolve `SEM_CONTEUDO`, com a pendencia intacta.

O motivo e um caso real: perguntamos o CNPJ do proctologista, a pessoa respondeu
`Sim`, e a reclassificacao tratou isso como evidencia nova. Fechou a pendencia
com *"Obrigado, anotei essa informacao na despesa"* — sem ter anotado nada — e o
CNPJ que veio na mensagem **seguinte** ja nao tinha pendencia aberta para
responder.

A instrucao `SEM_RELACAO` nao cobria o caso porque ela testa **relacao**, e
`Sim` e perfeitamente relacionado a pergunta; so nao carrega dado. Medido contra
o Gemini real na temperatura de producao, dez respostas desse tipo
reclassificaram em **22 de 30 execucoes**, e de forma instavel — `Sim` fechou
1/3, `sim` 2/3, `ok` 0/3. Em todas, a analise voltou com estabelecimento e
documento vazios: nao havia o que extrair.

Duas camadas, porque nenhuma sozinha basta:

| | Cobre | Como se comporta |
| --- | --- | --- |
| `respostaSemConteudo` (codigo) | As formas previstas: `sim`, `ok`, `tenho sim`, `nao tenho`, `beleza`, `ja mando` | Deterministico, roda antes da IA, tira o desfecho do sorteio do modelo |
| Instrucao no contexto | O que a lista nao preve: `acho que sim rs`, `pode deixar comigo`, `nossa, esqueci total` | 18/18 no Gemini real |

A lista e **negra e de mensagem inteira**: so recusa quando toda palavra esta
nela, e qualquer digito no texto a desliga na hora, porque documento e valor sao
digitos. Uma palavra de fora — nome de lugar, tipo de servico — ja e evidencia
potencial e segue para a IA. Mesmo vies do `extrairDocumento`: na duvida, deixa
passar.

A guarda fica **antes** de reivindicar a pendencia — pendencia que nao foi
respondida nao pode ser consumida. O orcamento de mensagens continua sendo
debitado na `whatsapp-webhook`, como em qualquer mensagem que nao e resposta,
entao isto nao cria pendencia imortal: `Sim` gasta uma das duas, e o CNPJ
seguinte ainda resolve.

Efeito colateral util: `nao tenho` tambem para aqui. Antes ele reclassificava e
**rebaixava** a despesa para `NAO_DEDUTIVEL` (3/3 no Gemini real) — uma despesa
de saude marcada como nao dedutivel porque a pessoa nao estava com o recibo na
mao.

Consequencia a conhecer: sem `resolvido`, o `consulta-e-dossie` cai no texto de
ajuda de sempre, que e o mesmo desfecho que `SEM_RELACAO` ja tinha. A pendencia
segue aberta ate o orcamento ou os 30 minutos acabarem.

## O que acontece quando a desambiguacao erra

Um caso real, que rendeu as duas correcoes atuais. Sequencia:
`paguei 500 no dentista` -> pergunta de CNPJ anexada -> `sim` (nao e resposta,
consome uma mensagem) -> `cnpj dele e 11.222.333/0001-81` (o CNPJ da conversa
real era de uma clinica de verdade e foi trocado pelo sintetico aqui e nos
testes).

A terceira mensagem **era** a resposta e nao foi reconhecida: a extracao exigia
que toda palavra da mensagem estivesse numa lista fechada de prefixos, e "dele"
nao estava. Recusada a resposta, a mensagem seguiu a cascata e o classificador
de intencao (Gemini, temperatura 0) devolveu `registro_despesa`. O prompt
fiscal, tentando dar sentido a um texto que nao descreve despesa, gravou
`valor: 0` — e o insert bateu em `recibos_valor_positivo_chk`.

O estrago nao parou no recibo que nao existiu. O unico node de WhatsApp daquele
ramo vinha **depois** do insert, entao a execucao morreu antes dele: sem
lancamento, sem resposta, sem sinal nenhum para quem mandou a mensagem.

Duas correcoes independentes, de propósito:

- a extracao procura o documento em qualquer posicao da mensagem (acima), o que
  fecha esta porta;
- um IF `Valor Válido?` antes do insert manda o valor impossivel para uma
  mensagem de esclarecimento no WhatsApp. Vale para qualquer caminho futuro em
  que a IA devolva valor ausente, nulo ou zero — a lição que fica e que
  **nenhum ramo pode ter o unico node de resposta depois de um node que pode
  falhar**.
