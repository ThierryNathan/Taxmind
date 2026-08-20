# TaxMind - Contexto Persistente Da IA

## Produto

TaxMind e um copiloto fiscal B2B2C integrado ao WhatsApp para profissionais autonomos, pequenos empreendedores e contadores parceiros.

O MVP automatiza captura, OCR, classificacao fiscal, trilha de auditoria e consolidacao de evidencias dedutiveis ao longo do ano.

## Stack Principal

- Interface conversacional: WhatsApp Cloud API via webhooks oficiais da Meta.
- Orquestracao: n8n em Docker, em VM Linux na Azure.
- IA: Google Gemini (`gemini-3-flash-preview`) para classificacao textual, visual e de intencao.
- Persistencia e autenticacao: Supabase/PostgreSQL com RLS.
- Backend auxiliar: Python/Node.js para relatorios, consolidacao e scripts operacionais.

## Convencoes Do Repositorio

- `supabase/` segue a convencao nativa do Supabase CLI.
- `supabase/migrations/` guarda migrations executaveis por `supabase db push`, `supabase migration up` e fluxos equivalentes.
- `supabase/functions/` guarda Edge Functions deployaveis por `supabase functions deploy`.
- `n8n/workflows/` guarda exports JSON versionados dos workflows.
- `backend/prompts/` guarda prompts de producao.
- `docs/` guarda notas Markdown compativeis com Obsidian usando links internos.
- `scripts/` guarda utilitarios repetiveis de setup e seed.
- `Mockup/` guarda o prototipo visual em Vite/React.
- `apps/onboarding/` guarda o app real de onboarding (Vite/React), separado do `Mockup/`.
- `tests/` guarda testes de Deno das Edge Functions, alem das pastas de fixtures, prompts e SQL. Rodar com `deno test --allow-env --allow-net tests/`. **A CI ainda nao executa esses testes** — `.github/workflows/ci.yml` so valida JSON dos workflows e existencia de migrations.

## Decisoes Arquiteturais

- RLS deve isolar dados por `auth.uid()`.
- Webhooks e automacoes backend podem usar `service_role`, mas a chave nunca deve aparecer em frontend, app mobile, mockup ou workflow publico.
- Midias recebidas pelo WhatsApp devem ser processadas, gravadas em bucket seguro e expurgadas do contexto temporario assim que possivel.
- Despesas com baixa confianca, conflito fiscal ou alto risco de glosa devem entrar em fila de revisao humana.
- O prompt fiscal deve devolver saida estruturada e rastreavel, separando dados extraidos, inferencias, nivel de confianca e motivos de revisao.

## Ordem Recomendada De Implementacao

1. Manter `AGENTS.md` atualizado como fonte compartilhada de contexto para IA.
2. Implementar `backend/prompts/taxmind_system_prompt.js`.
3. Implementar `supabase/functions/whatsapp-webhook/index.ts`.
4. Implementar `supabase/functions/bootstrap-identity/index.ts`.
5. Desenhar workflows reais em `n8n/workflows/`.
6. Fortalecer CI, testes locais e deploy depois que a logica central estiver validada.

## Aprendizados Operacionais

Armadilhas ja encontradas na pratica. Ler antes de mexer nas areas citadas.

### n8n

- Os `.json` em `n8n/workflows/` sao exports vivos da instancia real: carregam IDs de node, `webhookId`, `meta.instanceId`, `active` e ajustes feitos direto na UI. **Nunca regenerar por script.** Editar cirurgicamente o arquivo como esta e conferir o diff antes de fechar — regenerar sobrescreve ajuste manual e faz o import criar um workflow novo em vez de atualizar o existente.
- Code node em `runOnceForAllItems` nao tem item pareado: usar `$('No').first().json`. O `$('No').item.json` so funciona em `runOnceForEachItem`.
- Resposta `[]` do PostgREST pode fazer o node HTTP nao emitir item nenhum, e o node seguinte simplesmente nao executa. Marcar `alwaysOutputData: true` quando o branch precisa responder mesmo com resultado vazio.
- Existem dois webhooks separados e **nao intercambiaveis**: `N8N_WEBHOOK_URL` (midia -> `receipt-ocr-classification`) e `N8N_TEXT_WEBHOOK_URL` (texto -> `consulta-e-dossie`).
- O `usuario_id` de uma mensagem se resolve por `session_id` contra `sessoes_whatsapp.id`, **nao** por `wa_id`. Reaproveitar esse padrao em qualquer node ou function nova.
- Node HTTP roda **uma vez por item de entrada**. Consulta que vale para o lote inteiro (resolver dono, buscar ids ja gravados) tem que acontecer enquanto ainda ha um item so; fanar para N itens antes viraria N consultas identicas.
- Merge em modo `append` **dispara mesmo quando um dos ramos de entrada nunca executou** (verificado no 1.99.1). Isso deixa usar `IF -> dois ramos -> Merge` sem sentinela, e o caso importa de verdade: no sandbox do Pluggy 100% das transacoes caem no pre-filtro e o ramo da IA fica vazio.
- `import:workflow` respeita o campo `active` do JSON: importar um arquivo com `active: false` **desativa** o webhook que estava ativo. E `update:workflow --active=true` so vale depois de reiniciar o n8n.
- Terceiro webhook da casa: `N8N_OPENFINANCE_WEBHOOK_URL` (transacao bancaria -> `openfinance-transacoes`), sem relacao com os outros dois.
- Os exports sao byte a byte `JSON.stringify(obj, null, 2)` **sem newline final** (conferido nos tres arquivos). Isso permite edicao programatica cirurgica — ler, trocar so o campo alvo, reserializar — com diff minimo e sem perder id, `webhookId`, `position`, `connections` nem `active`. Continua valendo: nao regenerar o workflow, e conferir o diff.
- O prompt fiscal tem **tres** copias vivas: `backend/prompts/taxmind_system_prompt.js` (fonte de edicao), `supabase/functions/_shared/prompt_fiscal.ts` (o bundle da Edge Function nao atravessa a fronteira de `supabase/functions/`) e o literal embutido no node "Preparar Contexto" (o n8n nao importa arquivo do repositorio). `tests/n8n_fase12_test.ts` compara as tres e falha se alguem editar so uma.
- Code node de teste roda fora do n8n com um arremedo de `$input` / `$("Node")` (`new AsyncFunction("$input", "$", jsCode)`), lendo o jsCode do proprio export. Ver `tests/n8n_fase12_test.ts` — testa o artefato que vai ser importado, nao uma copia.

### Data da despesa

- Mensagem sem nenhuma referencia temporal **nao gera pergunta de volta**: a maioria das mensagens nao cita data mesmo sendo do dia, e perguntar criaria atrito em quase todo lancamento. A data cai no recebimento e fica marcada em `metadados_ia.data_inferida`.
- `data_inferida` e rastro de auditoria, nao pendencia: nao entra em `campos_ausentes`, nao vira motivo de revisao e **nao pode** ser lida pela decisao de status. A decisao continua sendo so `parsed.requer_revisao_humana`.
- A data de referencia e o dia em **America/Sao_Paulo**, nao em UTC: mensagem das 22h de Sao Paulo ja e o dia seguinte em UTC, e a despesa e de hoje para quem mandou.
- Deducao reduz a BASE DE CALCULO do IRPF, nao o imposto devido. Confirmacao no WhatsApp, resumo e cabecalho do dossie nunca apresentam o valor dedutivel como dinheiro que volta.

### Follow-up conversacional

Passo a passo em `docs/06 - Follow-up Conversacional.md`. Varredura de cenarios
contra o Gemini real, com os bugs achados e os candidatos a melhoria futura, em
`docs/07 - Testes Exploratorios e Variacoes.md`. O terceiro campo respondivel
(reembolso de saude) tem secao propria mais abaixo e
`docs/08 - Reembolso de Despesa de Saude.md`.

- A despesa e gravada e confirmada **antes** de a pergunta existir. Todo caminho novo desta fase e opcional: `onError: continueRegularOutput` nos nodes de follow-up e fail open em toda consulta da `whatsapp-webhook`. Se algum dia um deles virar bloqueante, a fase perdeu o proposito.
- A IA **nao** declara quais campos perguntar. Ela declara so o destino, em `deducibilidade_se_desbloqueado`; quem monta a lista e `derivarCamposBloqueantes` em `_shared/followup.ts`, olhando qual dos dois campos de identificacao saiu vazio da extracao. `documento_prestador` tem precedencia (unico verificavel sem IA) e a lista tem no maximo um campo — a regra fiscal de SAUDE pede prestador **ou** estabelecimento, e uma lista maior nunca esvaziaria, travando a promocao.
- O campo `campos_bloqueantes` **saiu do schema do prompt**. Ele era definido como "o campo que preenchido SOZINHO removeria a revisao", e essa definicao e irrealizavel justamente onde a pergunta mais vale: faltando documento E estabelecimento, nenhum dos dois satisfaz sozinho. Medido no Gemini real a 0.2: `Paguei 600 no proctologista` devolvia lista vazia em **10/10** execucoes (nenhum follow-up), contra 6/6 preenchida na mesma despesa com o estabelecimento citado. Nao era nao-determinismo do modelo — era a regra pedindo o impossivel, com `campos_ausentes` e `motivos_revisao` apontando o documento na mesma resposta.
- `deducibilidade_se_desbloqueado` e o que torna a promocao deterministica, e agora tambem e o unico freio contra perguntar em caso subjetivo: uso misto, reembolso e OCR ruim deixam o documento vazio do mesmo jeito, entao derivar a lista de `campos_ausentes` sem esse gate pediria o CNPJ da Vivo numa conta de internet residencial. Sem a declaracao, a promocao adivinharia dedutibilidade fiscal; o fallback e manter o que estava.
- Duas copias vivas da derivacao (`_shared/followup.ts` e o espelho no Code node, porque o n8n nao importa arquivo do repo). `tests/n8n_campos_bloqueantes_test.ts` roda os dois na mesma tabela de casos e falha se divergirem.
- So `documento_prestador` tem resposta reconhecivel sem IA (CNPJ/CPF tem digito verificador). `estabelecimento` e texto livre e cai na reclassificacao de proposito: adivinhar nome de lugar roubaria lancamento ("mercado 50 reais" e nome ou despesa?).
- Resposta reconhecida **nao** consome orcamento de mensagens: senao a propria resposta poderia fechar a pendencia que ela veio responder.
- `valor` e `data_despesa` nunca sao reescritos por follow-up, nos dois modos. A analise original fica inteira em `metadados_ia`; a nova entra em `followups`/`reclassificacoes`, ao lado.
- A `whatsapp-webhook` e o unico componente que ve toda mensagem (texto vai para `consulta-e-dossie`, midia para `receipt-ocr-classification`), entao o orcamento e contado la, e nao no n8n.
- Teste de concorrencia com mock sincrono **passa sem testar nada**: a segunda execucao ja encontra a linha reivindicada no SELECT e nem chega ao UPDATE. Para exercitar a exclusao mutua de verdade, segurar o PATCH da primeira ate a segunda ter lido — ver a barreira em `tests/followup_resolve_test.ts`.
- Fixture de reclassificacao precisa de `valor`/`data` **diferentes** dos gravados. Com os mesmos valores, um `valor: analise.valor ?? recibo.valor` passa despercebido pelo teste.
- O reconhecimento do documento e **lista negra, nao lista branca**. Exigir que toda palavra da mensagem esteja numa lista fechada de prefixos recusa a forma como a pessoa escreve: `cnpj dele e <CNPJ>` (frase real) morria em "dele" e virava despesa nova. O que segura o falso positivo nao sao as palavras, sao o digito verificador, o numero sobrando (valor) e um punhado de termos de gasto — ver `extrairDocumento` em `_shared/followup.ts`.
- A instrucao `SEM_RELACAO` da reclassificacao testava **relacao**, nao **conteudo**, e por isso nao cobria o caso mais comum: `Sim` e perfeitamente relacionado a "voce tem o CNPJ?" e nao responde nada. Medido no Gemini real, dez respostas desse tipo reclassificaram em **22 de 30** execucoes, e de forma instavel (`Sim` fechou 1/3, `sim` 2/3, `ok` 0/3) — em todas, a analise voltou com estabelecimento e documento vazios. O estrago nao era so o ruido: a pendencia fechava com "anotei essa informacao" sem ter anotado, e o CNPJ da mensagem SEGUINTE ja nao tinha pendencia para responder. Hoje ha `respostaSemConteudo` em `_shared/followup.ts` rodando **antes** da chamada de IA, mais a instrucao reforcada no contexto para as formas que a lista nao preve (18/18 no Gemini real).
- A guarda de conteudo e lista negra de mensagem **inteira**: so recusa quando toda palavra esta na lista, e qualquer digito no texto a desliga na hora (documento e valor sao digitos). Mesmo raciocinio do `extrairDocumento` — uma palavra de fora ja e evidencia potencial e segue para a IA.
- A guarda fica **antes** de `reivindicar`: pendencia que nao foi respondida nao pode ser consumida. O orcamento continua sendo debitado na `whatsapp-webhook`, entao isso nao cria pendencia imortal.
- Uma resposta de follow-up que **nao** e reconhecida nao cai em lugar nenhum inofensivo: ela segue para o classificador de intencao, que a le como `registro_despesa` (verificado no Gemini real, temperatura 0), e o prompt fiscal devolve `valor: 0` tentando dar sentido ao texto. O custo do erro de desambiguacao e maior do que "a pendencia expira".
- O classificador de intencao **nao sabia que havia pergunta pendente**, e por isso lia toda resposta em texto livre como despesa nova: `foi na clinica vida`, `nao tenho o cnpj mas foi na clinica vida`, `hospital sirio libanes` — **9/9** viraram `registro_despesa` no Gemini real. Como so o intent `outro` chega na `followup-resolve`, o modo `RECLASSIFICADO` era inalcancavel na pratica, e cada resposta virava despesa sem valor morrendo na guarda de valor. Hoje a `Preparar Contexto` deriva `followup_contexto` do campo da pendencia e o prompt do classificador ganha a categoria `resposta_de_followup` **so quando ha pendencia aberta** — sem pendencia o prompt e byte a byte o de antes, e ha teste comparando com `git show HEAD`. O discriminador escrito no prompt e "valor em dinheiro de gasto novo e `registro_despesa`". Medido: 23/23, incluindo 6/6 despesas novas que continuam sendo despesa.
- Documento com **digito verificador errado** (`11.222.333/0001-82`) era recusado pela extracao — certo — e caia na reclassificacao, onde o Gemini gravava o numero invalido em `documento_prestador` e promovia a despesa para `DEDUTIVEL` sem revisao, **3/3**. O caminho de IA desfazia a validacao que o caminho deterministico existe para fazer. Hoje ha `respostaDocumentoInvalido` (irma de `extrairDocumento`, mesmos filtros de recusa, roda antes da IA e antes de `reivindicar`) e `documentoConferido` no patch. A pendencia fica aberta para a pessoa corrigir o digito.
- Pendencia substituida (`SUPERSEDIDA`) deixou de ser silenciosa. O aviso sai do proprio payload: a `whatsapp-webhook` ja anota a pendencia anterior em toda mensagem, e **anotacao presente equivale a "vai haver substituicao"** — se ela expirou ou gastou o orcamento, a webhook descarta e nao anota, e ai nao ha o que substituir. O texto **nao** convida a responder a antiga depois: ela esta fechada, e um documento enviado mais tarde seria gravado no recibo NOVO.
- `SEM_CONTEUDO` devolve `mensagem` (a pergunta original repetida) em vez de `null`; o `WhatsApp - Enviar Ajuda` usa `$json.mensagem || <ajuda>`, entao nao houve mudanca de topologia. `SEM_RELACAO` continua caindo na ajuda generica — e `nao faco ideia` / `nao lembro` caem ali (SEM_RELACAO 3/3), o que e a mesma lacuna de UX ainda em aberto (ver `docs/07`).
- Multiplas despesas numa mensagem continuam **somadas em um recibo so** — separar linhas ainda e mudanca de escopo — mas nao podem mais ser aprovadas automaticamente. O prompt declara o booleano `possui_multiplas_despesas` para gastos autonomos; o Code node do workflow forca `REVISAO_HUMANA`, suprime follow-up de CNPJ/reembolso e substitui a confirmacao por aviso explicito. Componentes de um unico total (ex.: consulta incluindo estacionamento) nao contam so por haver dois valores. `tests/multiplas_despesas_gemini_test.ts` mede o criterio no Gemini real e `tests/n8n_multiplas_despesas_test.ts` cobre a precedencia deterministica.
- **Code node que agrega (`runOnceForAllItems`, N entradas -> 1 saida) nao declara paired item sozinho, e o n8n so adivinha quando a entrada tem UM item.** Com dois itens ou mais, todo `$("Node").item` de qualquer node **depois** dele estoura com `Paired item data for item from node 'X' is unavailable`. Foi o que matou o comando `resumo`: `Formatar Resumo` sempre agregou as linhas da RPC, mas enquanto o envio vinha logo depois dele a expressao era `$json` e nada quebrava; a fase 17 meteu o `Edge - Complemento do Resumo` no meio e trocou por `$("Formatar Resumo").item`. Reproduzido no n8n 1.99.1 real: **1 categoria de despesa passa, 3 nao**. Duas correcoes, e as duas foram medidas isoladamente por mutacao — `.first()` nas expressoes (nenhuma delas precisa de item pareado: os dois nodes emitem um item so) e `pairedItem` declarado no Code node, que sozinho ja faz o `.item` voltar a funcionar.
- O sintoma daquele bug era **silencio total**, e a razao de ter passado despercebido esta no vizinho: `Edge - Complemento do Resumo` tem `onError: continueRegularOutput`, entao ele engolia o MESMO erro de expressao, era registrado como "finished successfully" e nunca chamava a `declaracao-resumo` — a comparacao com a declaracao anterior nunca rodou em producao, e o log nao dizia isso em lugar nenhum. Erro de resolucao de parametro e capturado pelo `onError` do node HTTP como se fosse falha de rede.
- **`alwaysOutputData: true` + `onError: continueErrorOutput` no mesmo node manda o erro pelos DOIS lados.** Na primeira tentativa de fail open do resumo, a RPC fora do ar entregava o aviso de falha (saida de erro) **e** um "voce ainda nao tem despesas registradas" (item vazio da saida normal) — duas mensagens contradizendo uma a outra. Como o `alwaysOutputData` e obrigatorio ali pelo `[]` legitimo do PostgREST, quem traduz a falha passou a ser o Code node seguinte, que ja sabe separar lista vazia de resposta ausente (`l.error !== undefined`) e lanca para a saida de erro.
- Falha do insert em `recibos_evidencias` era **silencio total** para o usuario: o unico node de WhatsApp daquele ramo vinha depois do insert, entao a execucao morria antes de responder. Regra que vale para todo ramo novo: nenhum caminho pode ter o unico node de resposta depois de um node que pode falhar. Hoje ha um IF `Valor Válido?` antes do insert (`tests/n8n_valor_invalido_test.ts`).

### Reembolso de despesa de saude

Passo a passo, numeros da varredura e decisoes em
`docs/08 - Reembolso de Despesa de Saude.md`.

- Antes desta fase o indicio de reembolso **cancelava** o follow-up em vez de disputa-lo: o prompt manda usar `deducibilidade_se_desbloqueado: null` quando ha possivel reembolso, `derivarCamposBloqueantes` devolve `[]` com destino nulo, e nenhuma pergunta era feita. A vaga unica de pendencia estava vazia justamente nos casos que a pergunta de reembolso preenche — por isso a feature e aditiva, e nao uma disputa. `docs/07` §1.6 registra o caso passando como "correto" na fase anterior.
- O gate da pergunta e `possui_indicio_reembolso` **sozinho**, e isso diverge de proposito do gate da identificacao, que exige o destino declarado. A pergunta de CNPJ so servia para promover (perguntar sem promover e atrito puro); a de reembolso corrige o **numero declarado**, e isso vale mesmo com a despesa seguindo para revisao. `deducibilidade_se_sem_reembolso` decide so a promocao.
- Precedencia na vaga unica: reembolso ganha, por assimetria de risco — deduzir valor reembolsado e inconsistencia **afirmativa** contra a DMED, documento faltando e registro **incompleto** que ja ia para revisao. Escrita em `derivarCampoFollowup`, que **nao** toca `derivarCamposBloqueantes`. Sem encadeamento e sem fila: faltando CNPJ e reembolso, so o reembolso e perguntado.
- `valor` nunca vira liquido. `valor_reembolsado` entra ao lado (migration 010) e o dedutivel e derivado na leitura. Quatro motivos independentes, sendo o quarto o mais concreto: reembolso integral daria liquido 0 e violaria `recibos_valor_positivo_chk` — o modelo "liquido na coluna" nem representa o caso.
- `NULL` e `0` sao estados diferentes na coluna, e um `default 0` apagaria a diferenca: NULL = nunca perguntado, 0 = o titular confirmou que nao houve. A distincao chega ate o dossie (`-` contra `R$ 0,00`) e tem teste dedicado nos dois lugares.
- Reembolso parcial **nao** e `PARCIALMENTE_DEDUTIVEL`: esse status e uso misto pessoal/profissional. O que sobra depois do reembolso e integralmente dedutivel, e confundir os dois derrubaria o dedutivel duas vezes.
- O CNPJ **nao** serve de modelo para reconhecer a resposta: ele funciona por digito verificador, e valor monetario nao tem. Tambem nao havia extracao de valor para reusar — quem extrai valor no fluxo principal e o Gemini, e o unico parsing deterministico coage um campo ja numerico. O falso positivo e segurado por contexto de pendencia + um numero so + verbo de gasto + corte de 11 digitos (documento colado). O teto contra o valor da despesa fica na `followup-resolve` e na constraint, que sao quem conhece o recibo.
- `respostaSemConteudo` tem `nao` na lista negra — certo para a pergunta de CNPJ, onde `nao` nao carrega dado, e **errado** para a de reembolso, onde `nao` e a resposta completa. A funcao nao foi tocada: o que muda e a ordem no chamador, e uma negacao reconhecida nunca chega ate ela.
- Os verbos de afirmacao (`houve`, `teve`, `cobriu`) precisam estar no vocabulario de ligacao da negacao, senao `nao houve reembolso` — a forma mais natural de negar — nao e reconhecida. Seguro porque a negacao e testada primeiro e exige uma palavra de negacao presente. Ja `nao vou pedir reembolso ainda` fica de fora de proposito: gravar 0 ali criaria a inconsistencia com a DMED que a fase existe para evitar.
- O modo `REEMBOLSO_INFORMADO` **nao chama IA em caminho nenhum**, e cada teste confere `chamadasGemini === 0`. Nao e economia: o espaco de respostas e fechado, e mandar o texto ao modelo poderia promover a despesa com o reembolso em aberto.
- Promocao exige identificacao no recibo **alem** do destino declarado. Medido: o Gemini devolve `deducibilidade_se_sem_reembolso: "DEDUTIVEL"` em despesa sem prestador nenhum (`consulta 400 reais, usei o convenio`), e sem essa checagem responder `nao` aprovaria automaticamente uma despesa de saude sem prestador.
- A instrucao injetada no classificador de intencao **nao podia continuar fixa**: ela terminava em "NAO use esta categoria quando a mensagem trouxer o VALOR em dinheiro", e na pergunta de reembolso o valor em dinheiro e a resposta certa. Hoje `Preparar Contexto` deriva `followup_instrucao` por campo; sem pendencia os dois campos sao nulos e o prompt continua byte a byte o de antes.
- "Na duvida marque true" foi lido pelo modelo como "toda despesa de saude e duvida": `paguei 600 no proctologista` disparava reembolso **3/3**, e como reembolso tem precedencia isso roubaria a vaga do follow-up de CNPJ na frase mais comum de despesa de saude. A correcao nao foi afrouxar o gate, foi exigir que o indicio **esteja** na mensagem ou na evidencia — ausencia de mencao a plano nao e indicio de plano. Depois: 22/22 estaveis em 5 execucoes, com 6/6 nos "convenio" fora de contexto medico (prefeitura, estagio, B2B, farmacia e restaurante conveniados).

### Encadeamento reativo de follow-up

Passo a passo, os transcripts e as medicoes em
`docs/11 - Encadeamento Reativo de Follow-up.md`.

- Ate a Fase 16 a `followup-resolve` **so sabia fechar pendencia, nunca abrir**: os tres modos terminavam no mesmo par de linhas (patch no recibo, `return`), e no arquivo inteiro nao havia `insert` nem `registrar_followup_pendente`. Quem abria era so o no `Supabase - Registrar Follow-up` do workflow de recibo, atras do IF `Tem Campo Bloqueante?` — ou seja, **so no insert**. Despesa que precisava de duas respostas recebia uma pergunta e nunca a segunda.
- O sintoma nao era a pergunta faltando, era a mensagem seguinte: sem pendencia aberta o classificador de intencao nao recebe `followup_contexto`, le o CNPJ solto como despesa nova (`registro_despesa` 3/3 no Gemini real), o prompt fiscal devolve `valor: 0` e o usuario recebe "Nao consegui identificar o valor dessa despesa". Com pendencia aberta a MESMA mensagem da `resposta_de_followup` 3/3 — nao e o classificador que erra, e a ausencia de pendencia para contextualiza-lo.
- O fallback alternativo ("mensagem parece documento + recibo recente da sessao") foi descartado por nao cobrir o caso do reembolso nem a resposta em texto livre, e principalmente por ser uma **segunda nocao de pendencia** — sem TTL, sem orcamento, sem `SUPERSEDIDA`, sem trilha. A migration 009 documenta por que a pendencia virou tabela em vez de estado inferido.
- A reavaliacao **nao pode reler `metadados_ia` cru**. Os campos de identificacao vem das COLUNAS pos-patch (a analise original continua com o documento vazio depois de um `CAMPO_PREENCHIDO`, e reperguntaria o que acabou de ser respondido).
- **O destino tem que ser o residual depois que o reembolso e respondido.** O prompt manda declarar `deducibilidade_se_desbloqueado: null` quando ha indicio de reembolso (medido 3/3), e `derivarCamposBloqueantes` faz gate exatamente nesse campo: lendo o campo cru, a reavaliacao devolve `[]` e a sequencia do reembolso continua sem nunca pedir o CNPJ. A mesma regra vale em `promoverDeducibilidade` — sem ela o CNPJ encadeado promove para `APROVADO_AUTOMATICAMENTE` mantendo `INDETERMINADO`, uma despesa que nao chega ao contador e tambem nao conta como dedutivel.
- Quatro freios, nesta ordem: recibo fora de revisao, reembolso ja gravado (`valor_reembolsado !== null`), identificacao ja satisfeita (prestador OU estabelecimento — `derivarCamposBloqueantes` olha campo a campo e pediria `estabelecimento` a um recibo que acabou de receber o CNPJ), e campo ja perguntado neste recibo. O ultimo e o que torna verdadeira a invariante de no maximo dois passos.
- Os freios de reembolso e de campo-ja-perguntado **se sobrepoem em todo caminho alcancavel hoje**, e so a mutacao mostrou isso: arrancar o de `valor_reembolsado` nao quebrava teste nenhum. Eles respondem perguntas diferentes — "ja perguntei?" (conversacional) contra "ja sei a resposta?" (factual) — e ha teste que as separa. Cuidado ao escrever esse teste: se o recibo for promovido, a execucao para no primeiro freio e a guarda nem e consultada.
- Fail open em tudo, **menos** em `camposJaPerguntados`, que falha fechado: sem saber o que ja foi perguntado o risco vira repetir a pergunta em laco, e nao perguntar e so o comportamento de antes da fase.
- A sequencia do "Foi do convenio" **nao ficou inteiramente corrigida**, e o resto e fila de multiplas pendencias (fora de escopo desde a Fase 13). Depois da correcao a pendencia aberta ali e a de reembolso, e o CNPJ que chega responde uma pergunta que nao foi feita: `extrairRespostaDeReembolso` devolve null (certo, sao tres grupos de digitos) e o classificador devolve `registro_despesa` **6/6 mesmo com `followup_contexto` de `valor_reembolso`**. A pendencia sobrevive, mas a mensagem de valor invalido volta.
- `Foi do convenio` so reproduz o bug com o recibo **sem** estabelecimento: preenchido, a reclassificacao devolve `SEM_RELACAO` 6/6 e a pendencia nem fecha; null, reclassifica 6/6. E o passo 1 (`Paguei 799 no dentista`) devolve estabelecimento preenchido em 2/3. Teste de aceite tem que semear o ramo especifico — a media esconde o unico caso que reproduz.
- Emular o RPC `registrar_followup_pendente` no mini-PostgREST **nao e opcional** para testar isto: sem ele a chamada estoura no mock, cai no fail-open e a suite passa inteira sem exercitar nada. Foi o que aconteceu na primeira execucao depois da implementacao.

### Export estruturado para o contador

Passo a passo, a tabela de categorias e as medicoes em
`docs/10 - Export Estruturado para o Contador.md`.

- O enum `categoria_fiscal` mistura **dois mecanismos de deducao que nao sao graus da mesma coisa**: `SAUDE`/`EDUCACAO` sao a ficha "Pagamentos Efetuados" (qualquer contribuinte) e o resto e Livro-Caixa (so renda nao assalariada sujeita a carne-leao, limitado a receita do mes, que o TaxMind nao rastreia). Numa lista unica o leitor soma um total geral que nao existe para ninguem — dai duas abas, e nao uma coluna "tipo".
- `IMPOSTOS_TAXAS` **entra** no Livro-Caixa, e a tentacao de descarta-lo como "taxa nao e dedutivel" volta sempre. O proprio prompt fiscal manda classificar **conselhos profissionais** ali (secao 8), e anuidade de CRM/CRO/OAB e contribuicao sindical sao despesa de custeio classica. O bucket e heterogeneo de verdade — taxa bancaria e multa caem nele — e e por isso que a aba tem a nota de conferir com o contador, nao por isso que ela sairia.
- `MORADIA`/`ALIMENTACAO`/`OUTROS` entram **so** quando a IA ja julgou a linha `DEDUTIVEL` ou `PARCIALMENTE_DEDUTIVEL`. Aluguel de consultorio e rateio de home office sao gravados como `MORADIA` (o prompt manda marcar `PARCIALMENTE_DEDUTIVEL`), e filtro so por categoria descartaria exatamente a despesa que a regra manda deduzir. `INDETERMINADO` nao libera: e ausencia de julgamento, e promover por ausencia levaria toda conta de luz residencial junto. `OUTROS` esta na lista porque e o `default` da coluna (001:92).
- `TRANSPORTE` nunca entra, e **nao** por ser pouco dedutivel na pratica: o art. 68 do RIR/2018 veda locomocao e transporte no livro-caixa, exceto para representante comercial autonomo. A aba diz que ficou de fora e por que — silencio faria o contador achar que nao houve a despesa, e o representante comercial (o unico que poderia deduzi-la) e justamente quem perderia deducao com a omissao.
- **`.csv` nao serve**, e a descoberta inverteu a decisao de formato: a Cloud API da Meta nao lista `text/csv` entre os mime types de documento, e `.xlsx` esta na lista. Como o WhatsApp e o unico canal de entrega, um CSV correto seria recusado no envio. `xlsx@0.18.5` roda no runtime Deno, com numero, acento e duas abas sobrevivendo ao round-trip.
- `XLSX.read` **nao popula `celula.z` sem `cellNF: true`**. O formato de moeda vai correto para o arquivo, mas o teste que ler sem a opcao acusa "nenhuma celula recebeu formato" e o erro parece do gerador, nao do leitor.
- Nota de aviso em planilha vai **acima** do cabecalho, nunca como rodape: rodape some no primeiro "ordenar por valor", e a nota do carne-leao e a unica coisa que impede um assalariado de usar a aba. Nome de aba do Excel tem limite de **31 caracteres**.
- O branch de palavra-chave do export e checado **antes** do de dossie, porque o de dossie casa `"exportar"` e comeria `"exportar para contador"`. Como palavra-chave vence IA, esse erro seria deterministico e nunca se corrigiria sozinho — ha teste posicional, e nao so comportamental. `"contador"` sozinho nao pode disparar: `"manda o dossie pro meu contador"` e dossie, e `"quanto paguei ao meu contador"` e consulta.
- Acrescentar categoria ao classificador muda o espaco de decisao de **todas** as mensagens, inclusive as que nada tem a ver com o assunto. O teste que importa e o adversarial contra o Gemini real, e ele so prova algo se as frases medidas **nao casarem palavra-chave** — `tests/export_contador_gemini_test.ts` confere isso antes de medir (33/33 em 3 execucoes).
- O teste "sem pendencia, o prompt e o mesmo de antes" (fases 14 e 15) compara com `git show HEAD` e por isso quebra em **toda** adicao deliberada ao prompt base. O padrao ja estabelecido e filtrar a linha nova e cobrar o resto — nao remover a comparacao, que continua pegando qualquer outra deriva.
- O gatilho de "cadastro concluido" nao existia e passou a ser a `bootstrap-identity`: e o unico ponto onde `onboarding_concluido` vira true, tem o telefone do token assinado e roda uma vez por cadastro. Fim do fluxo React foi descartado (navegador nao dispara WhatsApp sem expor credencial) e "primeira mensagem depois do cadastro" tambem (a mensagem chegaria fora de contexto, em resposta a outra coisa). O estado tem que ser lido **antes** do upsert — depois dele todo mundo e `true` e quem refaz o link receberia boas-vindas de novo.

### Pontos de atencao antes de declarar

Migration 012 (`pontos_atencao_usuario`), `_shared/pontos_atencao.ts`, o salto ano
a ano em `_shared/declaracao_anterior.ts` e a Edge Function `pontos-atencao`.

- **Nao e preditor de malha fina, e o texto nao pode sugerir que e.** O algoritmo
  da Receita e confidencial. O que existe e agregacao de sinal ja gravado, por
  causa conhecida de pedido de comprovacao. Ha teste que varre o bloco inteiro
  com todos os sinais ligados e falha com qualquer `%`, "risco",
  "probabilidade", "chance" ou "score", e que cobra a ressalva em todo bloco.
- **Dois sinais da especificacao sao DEGENERADOS no schema real, e nao adianta
  fingir que nao.** (1) "PARCIALMENTE_DEDUTIVEL sem percentual documentado" e o
  mesmo conjunto que "PARCIALMENTE_DEDUTIVEL": nao existe campo de rateio em
  lugar nenhum — nem coluna, nem no schema do prompt fiscal. Minerar
  `justificativa_deducibilidade` por texto foi descartado (heuristica fragil
  sobre texto livre de LLM). (2) "REVISAO_HUMANA sem revisao" nao filtra nada:
  `revisado_em`/`revisado_por` sao declarados na 001 e **nenhum componente do
  repositorio os escreve**. A clausula fica assim mesmo — o sinal seria falso no
  dia em que a revisao existir, e sinal que so acerta por acidente e bug adiado.
- O limiar de 30 dias e o ciclo mensal do carne-leao e do livro-caixa, nao numero
  redondo. Medido no banco real (28 linhas em revisao, tres usuarios): 30 dias
  marca 0, 14 marca 5/2/3, 7 marca 17/2/8 — aos 7 dias vira quase tudo que esta
  em revisao, que e ruido.
- **Ausencia de categoria na declaracao anterior NAO e evidencia de ausencia de
  gasto.** A unica declaracao real importada em producao e SIMPLIFICADO com
  `categorias_pagamentos: []` e `pagamentos_detalhados: []` — ficha nao
  itemizada. Sem o gate `fichaPreenchida`, toda despesa de saude de quem usou o
  desconto simplificado no ano passado viraria ponto de atencao. O gate e a
  ficha, e nao o `modelo`: ficha preenchida sem saude e informativa ate numa
  declaracao simplificada.
- O criterio de salto exige as DUAS condicoes: `>= 2x` o valor do ano-base E
  aumento `>= 5%` dos rendimentos tributaveis. O multiplo alto existe porque o
  numero do TaxMind e parcial por construcao (so entra o que a pessoa mandou); a
  ancora na renda existe porque o repositorio ja rejeitou hardcodar cifra fiscal
  que envelhece, e porque o que chama conferencia e a desproporcao com a renda,
  nao o valor absoluto. Sem renda no ano-base, silencio — nao chute.
- A comparacao e assimetrica de proposito: dedutivel LIQUIDO deste ano contra
  valor PAGO da ficha. A assimetria faz o criterio sub-disparar, que e o erro
  barato dos dois.
- **`_shared/pontos_atencao.ts` nao importa NADA, e isso e estrutural.** A
  `export-contador` o importa so pelas marcas por item; com a comparacao ano a
  ano dentro dele, a planilha do contador passava a carregar
  `declaracao_anterior.ts` -> `irpf_calculo.ts` + `irpf_parametros.ts` +
  `followup.ts` no bundle, e a exigir redeploy a cada mudanca de parametro
  fiscal. O `deploy_drift_test.ts` mostrou isso na hora. O ponto de encontro e
  `linhasPontosAtencao(contagens, itensExtras)`: quem tem a declaracao renderiza
  os itens la e passa os textos. Ha teste que falha se o modulo ganhar qualquer
  import.
- Agregacao em SQL, e nao em TypeScript: 221 das 256 linhas do banco real vem do
  Open Finance, e um usuario ativo passa de mil por ano. Medido com EXPLAIN
  ANALYZE no usuario de maior volume (244 linhas): 0,4 ms, 46 buffers. Baixar as
  linhas para contar quatro numeros gastaria banda e esbarraria no teto de linhas
  do PostgREST, que hoje nao aparece so por causa do volume baixo.
- O juizo de produto NAO fica no SQL: a funcao devolve contagens e o dedutivel
  por categoria; limiares, criterio de salto e texto ficam no TypeScript,
  testaveis sem banco. `p_dias_revisao` e parametro com default, e ha teste
  comparando o default da migration com a constante do modulo — sao duas copias
  do mesmo numero, e divergirem faria a mensagem afirmar um prazo e a contagem
  usar outro, sem erro nenhum.
- `formatarReaisComMilhar` existe ao lado de `formatarReais` porque o segundo nao
  tem separador de milhar: usa-lo nas linhas novas entregaria "R$ 30000,00" numa
  mensagem cujos totais, escritos pelo Code node `Formatar Resumo`, saem como
  "R$ 30.000,00" — os dois formatos no MESMO texto. Trocar o antigo mudaria a
  frase de estimativa da Fase 17, que ja esta em producao.
- Mutacao e o que provou os testes: dos 14 mutantes, o unico sobrevivente inicial
  foi "desligar o mapa de codigos da ficha" — as descricoes dos fixtures
  ("Despesas medicas", "Instrucao") sao reconhecidas TAMBEM pelo fallback de
  palavra-chave, entao o mapa de codigos nao estava sendo testado. Um caso com
  nome comercial de operadora ("Unimed Central Nacional", codigo 11) e o que
  separa os dois caminhos.

### Deploy das Edge Functions

Incidente completo em `docs/09 - Incidente de Deploy Parcial.md`.

- Function nova nao basta ser criada: a fase do export estruturado exigiu redeploy tambem da `bootstrap-identity`, cujo `index.ts` mudou e que passou a importar `_shared/boas_vindas.ts`. O `deploy_drift_test.ts` acusou o bundle atrasado antes de qualquer coisa ir para producao — e e para isso que ele existe.
- **Function NUNCA deployada era ignorada pelo proprio drift test**, e a linha acima afirmava o contrario. Os dois testes de rede comparavam o bundle publicado com o repositorio e faziam `continue` quando nao havia bundle (`nao deployada (ignorada)`) — sem bundle nao ha o que comparar. O efeito era o pior possivel: criar a pasta da function, escrever o `index.ts` e esquecer o deploy passava com a suite inteira VERDE, que e o mesmo desfecho do incidente da Fase 15 por outro caminho. Hoje ha um terceiro teste (`toda function do repositorio existe no projeto`) que trata a ausencia como o erro.
- **Function cujo `index.ts` nao mudou tambem precisa de redeploy quando um modulo de `_shared` que ela importa mudou.** O bundle carrega uma copia do modulo; o diff de diretorio nao ve essa dependencia. Foi assim que a Fase 15 foi para producao pela metade: `whatsapp-webhook/index.ts` nao mudou, o `_shared/followup.ts` que ela importa mudou, e a function ficou uma versao atras — passando a descartar toda pendencia de `valor_reembolso` porque `campoRespondivel` publicado nao conhecia o campo.
- A suite inteira testa o **repositorio**, e por isso ficou verde durante o incidente. `tests/deploy_drift_test.ts` e o unico teste que afirma algo sobre o que esta **publicado**: le o fecho transitivo de `_shared` de cada function, baixa o bundle pela Management API e compara. Sem `~/.supabase/access-token` os testes de rede sao ignorados (nao existem na CI); com token, erro de API falha de proposito.
- O bundle guarda codigo **transpilado**, entao comparar bytes nao serve. O que sobrevive: nomes de declaracoes de topo (o Deno **nao** minifica — verificado: `montarContextoReclassificacao` esta no bundle da `whatsapp-webhook` sem ser usada por ela), literais de string e numeros de `const` de topo. Nao pega troca de operador dentro de corpo de funcao.
- `import type` puro nao gera dependencia de bundle: o modulo e apagado na transpilacao, e cobrar a presenca dele seria falso positivo.
- Simular "bundle antigo" **recortando** um trecho do arquivo nao funciona — os usos do simbolo mais abaixo continuam la e a busca por substring acha o nome, entao o teste passa por acidente. Remover o **token** em todas as posicoes e o que reproduz a versao antiga.
- O corpo publicado se baixa em `GET /v1/projects/{ref}/functions/{slug}/body` (o `updated_at` de `GET .../functions` sozinho **nao** prova o conteudo: no incidente ele marcava 16:58 de um dia em que o modulo dentro do bundle era de tres commits antes).
- O endpoint de analytics de log (`/analytics/endpoints/logs.all`) devolveu `{"result":[]}` para toda consulta, inclusive sem filtro. Isso e falta de acesso, nao ausencia de invocacao — nao serve de evidencia em nenhuma direcao.
- Motivo de descarte de pendencia tem **quatro** valores distintos e nenhum deles pode compartilhar rotulo: `CAMPO_DESCONHECIDO` (versao publicada nao conhece o campo), `EXPIRADA` (tempo), `ORCAMENTO_ESGOTADO` (mensagens), `SUPERSEDIDA` (despesa nova tomou a vaga). Enquanto o primeiro se chamava `EXPIRADA`, a trilha afirmava pendencia expirada 30 minutos antes do proprio `expira_em` com o orcamento intacto, e a investigacao comecou no lugar errado. `descartada_motivo` e texto livre — mudar rotulo nao pede migration.

### Import da declaracao anterior

Modulo em `supabase/functions/_shared/declaracao_anterior.ts`, functions
`declaracao-import` e `declaracao-resumo`, migration 011.

- A pendencia reusa `followups_pendentes` com `campo_alvo = 'declaracao_anterior'`, e esse campo e o **primeiro que nao pertence a um recibo**: `recibo_id` deixou de ser NOT NULL e uma constraint nova (`followups_recibo_conforme_campo_chk`) amarra os dois casos — declaracao EXIGE recibo nulo, os outros tres EXIGEM recibo preenchido. Sem essa segunda constraint, afrouxar o NOT NULL abriria a porta para pendencia de CNPJ orfa, que e o que a 009 evitava.
- O campo precisa entrar em `CAMPOS_RESPONDIVEIS` de `_shared/followup.ts`, e so ali: `campoRespondivel` e o que a `whatsapp-webhook` usa para decidir se conhece a pendencia, e sem isso toda pendencia de declaracao seria descartada com `CAMPO_DESCONHECIDO` — o incidente da Fase 15 outra vez. `derivarCampoFollowup` continua sem conhece-lo (ele nao nasce de lacuna que a IA achou, nasce de pedido do usuario).
- Este e o unico campo cuja resposta e **arquivo, nao texto**. `extrairRespostaDeCampo` devolve null para ele de proposito, e a midia deixa de ser "sempre lancamento novo" so enquanto a pendencia esta aberta.
- O freio que torna isso seguro e `e_declaracao_irpf` na extracao: documento que nao e declaracao **volta para o fluxo de recibo** (`seguir_como_recibo: true`) em vez de virar baseline, e a pendencia nao e consumida. Sem isso, uma pendencia aberta sequestraria a foto do cupom mandada no meio do caminho. Medido no Gemini real: recibo em PDF recusado 2/2 nesta fase, 3/3 na investigacao.
- TTL de 60 min e orcamento de 5 mensagens (contra 30 min e 2 dos campos de recibo), porque a resposta exige entrar no e-CAC com conta gov.br. Sao parametros da `registrar_followup_pendente`, nao mudanca de logica.
- O PDF **nao e guardado** — so o SHA-256. Ele traz renda, dependentes e bens, muito alem dos tres campos que o produto usa; e politica mais restritiva que a de midia de recibo, de proposito. A mensagem que pede o arquivo avisa isso ANTES do envio.
- Caminho real do arquivo, conferido na documentacao da Receita e nao suposto: e-CAC -> **Meu Imposto de Renda** -> escolher o ano em **Declaracao do IRPF** -> **Servicos Disponiveis** -> **Documentos e Arquivos (Copia da Declaracao)** -> icone de download; exige conta gov.br **prata ou ouro**. O manual do MIR confirma que essa opcao e servico do Portal, e nao secao da tela inicial do MIR — por isso a instrucao aponta o e-CAC, e nao o app de preenchimento. Ha teste cobrando o nome exato de cada menu no texto.
- O branch de palavra-chave fica **depois de export_contador e antes do dossie**, e as duas fronteiras vieram de frases concretas: "mandar minha declaracao para o contador" tem que continuar sendo export_contador, e "exportar a declaracao do ano passado" tem que ser import (o branch de dossie casa "exportar" sozinho). Ha teste posicional alem do comportamental.
- Ano em quatro digitos ficou **fora** do segundo eixo da palavra-chave: casaria "quanto vou pagar na declaracao de 2026", que e consulta. O ganho seria so cobrir "declaracao de 2025", que o classificador de IA pega.
- A estimativa de economia tem dois metodos, e o fallback e o menos preciso: com `rendimentos_tributaveis` no PDF ela passa pelo motor real (`MOTOR_IRPF`, com redutor e teto do §1o) e sabe dizer ZERO para quem ja estava isento; sem ele cai em `dedutivel x aliquota efetiva` (`ALIQUOTA_EFETIVA`), que ignora o redutor. Nos dois casos a frase carrega a ressalva de dado historico.
- Ano de declaracao **nunca sai sozinho** na mensagem: `rotuloAnoDeclaracao` escreve "ano-calendário 2025, exercício 2026". "Declaracao de 2025" e ambiguo entre o ano dos gastos e o ano da entrega — a mesma ambiguidade que faz o endpoint do simulador da Receita devolver a tabela do ano errado (secao do calculo do IRPF, acima). Aqui o custo seria a pessoa conferir contra o PDF que ela entregou em 2025, que e o ano-calendario 2024, e concluir que importamos o arquivo errado. O que se guarda no banco continua sendo so o ano-calendario; o exercicio e derivado (`ano + 1`) e existe apenas no texto.
- O passo a passo do e-CAC tem uma saida para quem nao acha **Meu Imposto de Renda** no menu: trocar para a **versao classica** pelo botao no canto da tela. Sem essa linha o roteiro termina em beco sem saida no passo 2, e a pessoa nao tem como saber que existe outro layout com o mesmo item.
- A pergunta de categoria so acompanha **SAUDE e EDUCACAO**: sao as que mapeiam 1 para 1 no enum `categoria_fiscal`. PREVIDENCIA nao chega por recibo no WhatsApp, e `SERVICOS_PROFISSIONAIS` da ficha de Pagamentos e majoritariamente pensao alimenticia e acao judicial — comparar com a categoria homonima do enum seria comparar rotulos parecidos com significados diferentes.
- O complemento do resumo entra **depois** de `Formatar Resumo`, nunca no meio: aquele node consome `$input.all()` da RPC e um node intermediario quebraria a agregacao. O node do complemento e `onError: continueRegularOutput` e a expressao de envio trata `linhas` ausente — resumo sem declaracao importada continua byte a byte o de antes.

### Calculo do IRPF (tabela + redutor)

Parametros em `supabase/functions/_shared/irpf_parametros.ts`, conta em
`_shared/irpf_calculo.ts`. Fixtures de proveniencia em
`tests/fixtures/simulador-irpf/`.

- Desde a Lei 15.270/2025 o imposto tem **duas camadas em sequencia**: tabela progressiva e, depois dela, um redutor. Calcular so pela tabela superestima o imposto de quem esta na faixa do redutor, e "imposto(base) - imposto(base - deducao)" pela tabela superestima a economia de uma deducao.
- Os dois redutores sao dispositivos **diferentes, com vigencias diferentes**: o MENSAL e o art. 3o-A (a partir de janeiro de 2026, retencao na fonte) e o ANUAL e o **art. 11-A** (a partir do exercicio 2027, ano-calendario 2026). O ano-calendario 2025 — que e o baseline tipico de uma declaracao importada hoje — **nao tem redutor nenhum**. Por isso os parametros sao indexados por `ano_calendario` e `parametrosDoAno` devolve `null` para ano desconhecido em vez de cair no ano mais proximo.
- O redutor incide sobre **rendimentos tributaveis**, nao sobre a base de calculo (a lei escreve "0,095575 x rendimentos tributaveis sujeitos ao ajuste anual"). Deduzir mais nao aumenta o redutor. E ele e **limitado ao imposto da tabela** (§1o dos dois artigos): quando a deducao derruba o imposto abaixo do redutor, o excedente se perde e a economia da deducao deixa de ser linear — pode ser zero para quem ja estava zerado.
- `GET https://www27.receita.fazenda.gov.br/api/simulador/tabela/{ano}` e o servico de parametros que alimenta o Simulador de Aliquotas Efetivas da Receita, e serve de fonte primaria legivel por maquina. **Armadilha:** o bloco ANUAL de `/tabela/2026` devolve a tabela de 2025 (28.467,20 / 10.853,78) e nao a de 2026 (29.145,60 / 10.904,66). A causa esta na interface: a aba mensal pergunta "Ano-calendario" e a anual pergunta "Exercicio", as duas batem no mesmo endpoint, e o exercicio 2027 ainda nao existe. Quem puxar aquele bloco achando que e AC2026 usa a tabela do ano passado sem nenhum sintoma. O bloco mensal do mesmo payload esta correto.
- O simulador **trunca**, nao arredonda: `trunc(e,t){return Math.trunc(e*Math.pow(10,t))/Math.pow(10,t)}`, aplicado uma vez so em `imposto - reducao`. Nao e detalhe: no exemplo 5 da propria Receita a soma das faixas da 1.016,2785, e so a truncagem reproduz o R$ 1.016,27 publicado (arredondar daria 1.016,28).
- Ele tambem apura o imposto **somando faixa a faixa**, e nao pelo atalho "base x aliquota - parcela a deduzir". Os dois coincidem em aritmetica exata, mas a parcela publicada e arredondada ao centavo — na anual de 2026 a exata seria 10.904,658. `impostoPelaParcelaDeduzir` existe so para o teste cruzar os dois caminhos, o que valida cada parcela publicada sem depender de fonte externa.
- Divergencia entre fontes secundarias sobre a parcela de 27,5% em 2025 tem explicacao simples: **a tabela mensal mudou no meio do ano**. Janeiro a abril usa 896,00; maio em diante, 908,73 (que e tambem a de 2026). Quem cita um valor so para "2025" acerta quatro meses.
- A formula do redutor anual **nao zera exatamente** no teto: 8.429,73 - 0,095575 x 88.200 = 0,015. E residuo do arredondamento das constantes da lei; a implementacao segue a formula e deixa o §2o zerar acima do teto, em vez de inventar um clamp.
- Teste com rede (`--allow-net`) rebaixa os tres payloads e compara com as fixtures: mudanca de parametro na Receita falha o teste. Sem rede ele e ignorado, como o `deploy_drift_test.ts`.

### Gemini

- Modelos 3.x usam `generationConfig.thinkingConfig.thinkingLevel` (`minimal`/`low`/`medium`/`high`). O `thinkingBudget` e da geracao 2.5 e nao vale aqui.
- Gemini 3 Flash nao permite desligar thinking. Com `maxOutputTokens` baixo o thinking consome o orcamento e a resposta volta **vazia** — deixar folga no teto e tratar resposta vazia no parser.

### Supabase

- Funcao Postgres que agrega dado sensivel recebendo `usuario_id` por parametro deve ser `SECURITY INVOKER`. Com `SECURITY DEFINER` a RLS e ignorada e qualquer `authenticated` le o dado de outro usuario passando o uuid alheio.
- O runtime das Edge Functions injeta `SUPABASE_SERVICE_ROLE_KEY` ja no formato novo (`sb_secret_...`), enquanto secrets do Supabase e variaveis do n8n podem estar no JWT antigo (`eyJ...`). Ao comparar chave byte a byte (validacao de chamador interno), confirmar que os dois lados usam o mesmo formato.
- `.env.example` e separado por fronteira de seguranca: raiz = backend, com segredos; `apps/onboarding/.env.example` = so variaveis `VITE_*` publicas, que vao no bundle. O `.gitignore` fica centralizado na raiz e ja cobre subpastas.
- O projeto tem `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated, service_role` no schema `public`: **tabela nova nasce com privilegio total para o anon key**. RLS habilitada sem policy ja nega tudo, mas quem cria tabela que guarda credencial (hash de codigo, token) deve tambem `revoke all ... from anon, authenticated` — senao um `disable row level security` acidental no futuro expoe a tabela inteira. Mesmo raciocinio para log append-only: sem revoke, `authenticated` tem INSERT/UPDATE/DELETE no proprio registro de auditoria.
- `SET LOCAL role` fora de bloco de transacao e ignorado com apenas um WARNING, e o psql segue como superusuario. Teste de RLS que use `set local` sem `begin/rollback` passa achando que testou isolamento quando na verdade nao testou nada.
- Migration validada de graca em `postgres:15` puro com um shim de ~10 linhas (roles `anon`/`authenticated`/`service_role`, schema `auth`, `auth.users`, `auth.uid()`, e o `alter default privileges` acima). Mais rapido que `supabase start` e suficiente para constraint, trigger, RLS e idempotencia. O shim e o runner viraram arquivo: `tests/sql/shim_supabase.sql` e `bash tests/sql/run_migrations_docker.sh` (aplica 001..N e roda todo `tests/sql/*_test.sql`).

### Resend / Re-verificacao por e-mail

- Dois canais de e-mail que **nao se substituem**: o SMTP customizado do dashboard (Authentication -> Emails) serve os e-mails do proprio Auth (magic link do onboarding); a `RESEND_API_KEY` serve a chamada direta que a `whatsapp-webhook` faz a `https://api.resend.com/emails` para o codigo de re-verificacao. Passo a passo em `docs/04 - Re-verificacao por E-mail (Resend).md`.
- `supabase.auth.admin.generateLink` **nao despacha e-mail** — devolve `action_link`/`email_otp` para quem chama enviar. E o `email_otp` do Auth so se valida via `verifyOtp`, que cria sessao autenticada: nao serve para reconfirmar identidade no WhatsApp, so para login.
- No painel do Resend, o usuario de SMTP e a string literal `resend` e a senha e a propria API key. Errar isso da `535 Authentication failed`, que parece problema de key.
- `sessoes_whatsapp.verificado_em` existe, mas a janela de confianca **nao pode ser lida da sessao atual**: sessao expira em 24h e sessao nova nasce sem contexto, entao a janela de 30 dias viraria 24 horas. Ler o maior `verificado_em` entre as sessoes do usuario, com fallback em `usuarios.criado_em`.
- Codigo esgotado por tentativas nao gera codigo novo automaticamente: exige outra mensagem do usuario. Renovar na hora deixaria um chute em rajada renovando codigo para sempre e enchendo a caixa de entrada do dono.
- Nao ha como validar o fluxo com Supabase e Meta reais em dev, mas da para importar o `index.ts` num teste de Deno e stubbar `globalThis.fetch` **antes** do import (o `createClient` no topo do modulo captura a referencia de fetch nesse momento). Um mini-PostgREST em memoria de ~100 linhas cobre `eq/gt/is.null/not.is.null/order/limit`, que e tudo o que as functions usam. Ver `tests/reverificacao_webhook_test.ts`.

### PDF

- As `StandardFonts` do pdf-lib usam WinAnsi: acento latino passa, mas emoji e simbolos fora de Latin-1 lancam excecao e derrubam a geracao inteira. Como `descricao` vem de OCR, sanear o texto antes de cada `drawText`.
- O cabecalho nao tem quebra automatica de linha: texto novo entra como array de linhas ja quebradas, com o teste medindo `widthOfTextAtSize` contra a largura util (515pt).
- Procurar a frase desenhada nos bytes do PDF **nao acha nada**, por dois motivos somados: o `save()` comprime os streams e o `drawText` emite string hexadecimal (`<5461...> Tj`), nao texto literal. Nos dois casos o "nao achei" parece bug do cabecalho. Ver o extrator em `tests/dossie_nota_deducao_test.ts`.
- `DecompressionStream("deflate")` recusa os bytes de sobra que o PDF deixa depois do fim do fluxo zlib (`failed to write whole buffer`); `inflateSync` de `node:zlib` ignora, como os leitores de PDF.

### Consentimento LGPD

- O texto vive em duas copias — `supabase/functions/_shared/consentimento.ts` (canonica) e `apps/onboarding/src/lib/consentimento.js` (espelho da tela) — porque o bundle da Edge Function so enxerga `supabase/functions/` e o Vite so enxerga `apps/onboarding/`. `tests/consentimento_espelho_test.ts` compara o texto canonico dos dois e falha se so um lado mudar. Detalhes em `docs/05 - Consentimento LGPD no Onboarding.md`.
- O checkbox e a interface do gate, nao o gate: a `bootstrap-identity` recusa `consentimento_aceito !== true` e versao desconhecida, **depois** da checagem do token — se essa ordem inverter, o `probeBootstrapToken` do frontend para de distinguir 401 de 400 e a tela passa a dizer "link expirado" para todo mundo.
- O `texto_hash` e calculado no servidor. Hash recebido do navegador provaria so o que o navegador quis afirmar.

### Frontend do onboarding

- `apps/onboarding/src/index.css` tem um reset `* { margin: 0; padding: 0 }` **fora de `@layer`**, e CSS sem camada vence `@layer utilities` do Tailwind v4: todo `py-2.5` computa `padding-block: 0` e os botoes saem achatados (~24px em vez de ~42px). Vale para as telas antigas tambem — nao e regressao de tela nova.

### Pluggy / Open Finance

- `npm:pluggy-sdk@0.90.0` roda dentro do edge-runtime real do Supabase (testado na imagem `public.ecr.aws/supabase/edge-runtime:v1.74.2`, Deno 2.1.4), com chamada HTTPS de saida funcionando. A versao `latest` e **0.90.0**, nao 1.x — pedir `@1.x` quebra a resolucao do `npm:`.
- O `session_id` do token HMAC de onboarding **nao** e um id de `sessoes_whatsapp`: a `whatsapp-webhook` gera um `crypto.randomUUID()` novo a cada link. Quem precisa do usuario a partir do token resolve por `phone` contra `usuarios.telefone_whatsapp` — o padrao de resolver por `session_id` vale para as mensagens que chegam ao n8n, nao para o token.
- O item do Pluggy guarda o `clientUserId` que passamos no `createConnectToken`. Isso permite recuperar o dono de um item pelo `GET /items/{id}` quando o vinculo local nao chegou a ser gravado — sem esse fallback, uma conexao concluida com o navegador fechado antes do `onSuccess` viraria transacao orfa para sempre.
- O webhook do Pluggy aceita headers customizados no cadastro (campo `headers` de `CreateWebhook`), entao da para exigir um segredo proprio em vez de deixar o endpoint aberto.
- Processamento pos-resposta em Edge Function precisa de `EdgeRuntime.waitUntil`; sem isso o trabalho e morto junto com a requisicao e o webhook responde rapido sem nunca terminar o servico.
- `GET /transactions` **foi desativado** e responde `410 ENDPOINT_DEPRECATED`. O substituto e `GET /v2/transactions`, e nao basta trocar o path: `from`, `to`, `page` e `pageSize` sao todos rejeitados com `400 property X should not exist`. Os nomes validos sao `dateFrom`, `dateTo`, `createdAtFrom` e `after` (cursor). Envelope `{ results, next }`, pagina fixa em 500 sem parametro para reduzir — o que impede exercitar a paginacao no sandbox, que tem 25 transacoes por conta.
- O sandbox devolve `category`/`categoryId` preenchidos em 100% das transacoes, mas isso **nao diz nada** sobre a conta real: no sandbox o dado ja vem categorizado de fabrica, e a categorizacao e addon pago depois do trial. Qualquer logica que dependa da categoria tem que tratar `null` como caminho normal, nao como excecao.
- Sandbox nao serve para avaliar qualidade de classificacao: `merchant` vem `null` em 100% dos casos e a descricao e literalmente `PAGAMENTO`/`PGTO`. Da para validar encanamento, nao a IA.
- Filtrar por `categoryId` (hierarquico e estavel, 2 primeiros digitos = categoria de topo) em vez do rotulo `category`, que e texto de exibicao. Taxonomia completa em `GET /categories` (130 categorias).
- `GET /accounts?itemId=` ja devolve conta corrente, poupanca **e cartao de credito** na mesma lista: nao ha filtro por tipo a corrigir ali. Quando transacao de cartao some, procurar o descarte depois da busca, nao antes.
- Convencoes de conta CREDIT que invertem o que vale em conta BANK, e sao a causa real de transacao de cartao sumir: (1) `DEBIT` chega com `amount` **positivo** (em BANK vem negativo) — daí o `Math.abs` na normalizacao nao ser redundante; (2) `PENDING` nao e estado transitorio, e o estado da compra ate a fatura fechar. Descartar PENDING derrubava 12 das 23 compras do cartao no item sandbox, e elas nao voltavam: a sincronizacao seguinte usa um `dateFrom` mais recente que a data da compra.
- `GET /transactions` (colecao) responde 410, mas `GET /transactions/{id}` continua respondendo 200 com o objeto completo. E o unico caminho para o `transactionIds` do `transactions/updated`: `/v2/transactions?ids=` responde 400 exigindo `accountId`.
- `dateFrom` e truncado em dia. Teste que pretenda distinguir `dateFrom` de `createdAtFrom` precisa de um corte em **outro dia**, senao passa com os dois e nao prova nada.
- `createdAtFrom` (quando o registro entrou na base do Pluggy) e `dateFrom` (quando a compra aconteceu) diferem por dias em fatura de cartao. O evento `transactions/created` manda a janela na primeira dimensao; filtrar por `dateFrom` ali descarta justamente a transacao que acabou de chegar.
- O `createdTransactionsLink` do evento `transactions/created` aponta para a colecao `/transactions`, ja desativada. Remontar a consulta em `/v2/transactions` — e evita seguir URL de fora carregando a `X-API-KEY`.
- Os eventos `transactions/*` sao por **conta**, nao por item, e o `accountId` vem do corpo forjavel do webhook. Conferir `account.itemId === payload.itemId` antes de usar: sem isso, um evento com item de um usuario e conta de outro grava transacao alheia sob o usuario errado.
- Teste da `pluggy-webhook` com Pluggy real e Supabase mockado: `tests/pluggy_webhook_transacoes_test.ts`. Mesmo padrao do `reverificacao_webhook_test.ts` (stub de `globalThis.fetch` **antes** do import), mas deixando `api.pluggy.ai` passar direto. As duas suites sobem `serve()` na porta 8000 e por isso **nao rodam no mesmo processo** do `deno test`.
- Item de sandbox **tem vida curta**: tres ja viraram `404 ITEM_NOT_FOUND` depois de alguns dias, e `GET /accounts?itemId=` de item apagado responde **200 com lista vazia**, nao 404 — teste sem guarda falha com "esperado 3, recebido 0" e parece bug de codigo. O id fica em `PLUGGY_TEST_ITEM_ID`, com default no arquivo.
- `PATCH /items/{id}` (forcar atualizacao) e limitado a **1 por hora** por item: `409 CLIENT_IS_UPDATING_BEFORE_ALLOWED_FREQUENCY`. Planejar o teste ponta a ponta em torno disso, ou criar item novo.
- `POST /items` no connector 600 (Sandbox Open Finance) exige CPF com **digito verificador valido** — `12345678900` e recusado com `CONNECTOR_VALIDATION_ERROR`. Mas passar na validacao de formato nao basta: CPF sintetico qualquer volta `LOGIN_ERROR / INVALID_CREDENTIALS`. Reconectar pelo widget e mais rapido que descobrir o CPF que o sandbox aceita.
- Os eventos `transactions/*` sao por conta e caem em invocacoes **isoladas** da Edge Function (um `booted` por evento no log): nao ha estado em memoria que enxergue os irmaos. Agregar exige ponto de encontro externo — hoje a tabela `open_finance_lotes_pendentes` (migration 007). Sem isso, conexao com 3 contas gerava 3 mensagens de WhatsApp.
- O padrao de exclusao mutua entre invocacoes concorrentes e `UPDATE ... WHERE consumido_em IS NULL RETURNING`: o Postgres serializa os UPDATEs na mesma linha e **reavalia o predicado** no READ COMMITTED, entao a segunda transacao atualiza zero linhas. Verificado com duas sessoes psql concorrentes, nao inferido.
- Para decidir "o lote parou de crescer", comparar **contagem** entre duas leituras, nao `now() - criado_em`: o `criado_em` vem do relogio do Postgres e a espera roda no relogio do runtime da Edge Function.
- Migration pode ser aplicada em producao pela Management API (`POST /v1/projects/{ref}/database/query`) com o token de `~/.supabase/access-token`, sem precisar da senha do banco que o `supabase db push` pede. Lembrar de inserir a linha em `supabase_migrations.schema_migrations` na mao, que e o que o `db push` faria.

### Windows / Git Bash

- `MSYS_NO_PATHCONV=1` resolve o destino dentro do container e quebra a origem no host: `docker cp /c/Users/... container:/destino` vira `CreateFile C:\c: file not found`, porque o docker e binario Windows e o caminho MSYS chega cru. Origem no host passa por `cygpath -w`, destino no container fica POSIX. Ver `tests/sql/run_migrations_docker.sh`.
- Argumento com barra inicial e reescrito pelo MSYS para `C:/Program Files/Git/...` em **qualquer** subcomando do docker, nao so no `docker run`: `docker exec ... psql -f /arquivo.sql` vira `psql: error: C:/Program Files/Git/arquivo.sql: No such file or directory`, e `docker cp origem container:/destino` erra o destino. A mensagem sempre parece problema do arquivo, nunca do path. Fazer `export MSYS_NO_PATHCONV=1` uma vez no inicio do script, em vez de prefixar comando a comando e esquecer um.

## Regras De Seguranca

- Nunca commitar credenciais reais.
- Nunca expor `SUPABASE_SERVICE_ROLE_KEY` fora de ambientes backend controlados.
- Evitar dados pessoais reais em seeds, fixtures, prints, logs e exemplos.
- CPF deve ser armazenado apenas como hash quando nao houver necessidade legal de guardar o valor bruto.
- Artefatos de OCR e midia devem ter trilha de auditoria, hash e politica de retencao clara.
