# 08 - Reembolso de Despesa de Saude

Relacionado a [[06 - Follow-up Conversacional]], [[03 - Motor OCR de Nicho e Human-in-the-Loop]] e [[07 - Testes Exploratorios e Variacoes]].

Fase 15. Quando uma despesa de saude tem indicio de reembolso por plano,
convenio, seguro ou empregador, o bot pergunta se houve reembolso e de quanto
foi — e o valor dedutivel passa a ser o liquido.

## Por que isto vale uma pergunta

Deducao de despesa medica vale sobre o que saiu do bolso e **nao voltou**. A
Receita cruza a deducao declarada com o que a operadora informou na DMED. Quem
deduz o bruto de uma consulta reembolsada gera inconsistencia direta — nao e
lacuna de comprovacao, e um numero que nao bate com o que um terceiro ja
reportou.

Ate esta fase o TaxMind **detectava** o problema e nao fazia nada com ele. O
prompt ja gerava motivos de revisao do tipo *"Necessario confirmar ausencia de
reembolso"*, mas isso morria como texto livre em `metadados_ia`.

Pior: o indicio de reembolso **cancelava** o follow-up que existia. A regra do
prompt manda usar `deducibilidade_se_desbloqueado: null` quando ha possivel
reembolso, `derivarCamposBloqueantes` devolve `[]` com destino nulo, e nenhuma
pergunta era feita. Esta linha de [[07 - Testes Exploratorios e Variacoes]] §1.6
passou como comportamento correto na fase anterior:

| Mensagem | Resultado | Veredito de entao |
| --- | --- | --- |
| `paguei 250 no dentista, mas foi reembolsado pelo plano` | INDETERMINADO + revisao, **sem pergunta** | Passou |

A vaga unica de pendencia estava **vazia** exatamente nos casos que esta fase
quer preencher. Isso e o que torna a feature aditiva em vez de disputada.

## O que a IA declara e o que o codigo deriva

Mesma divisao da fase anterior — a IA declara juizo, o codigo deriva acao —, com
dois campos novos no schema do prompt:

| Campo | Tipo | O que responde |
| --- | --- | --- |
| `possui_indicio_reembolso` | booleano | Deteccao. Ha sinal de terceiro pagador nesta despesa de saude? |
| `deducibilidade_se_sem_reembolso` | `DEDUTIVEL` / `PARCIALMENTE_DEDUTIVEL` / `null` | Destino. Se o usuario confirmasse que nao houve reembolso, ficaria aprovavel? |

Casar string em `motivos_revisao` foi descartado pelo mesmo motivo que derrubou o
`campos_bloqueantes` original: depender de redacao do modelo.

### O gate e o indicio sozinho — e isso e uma divergencia deliberada

A pergunta de identificacao exige o destino declarado (`deducibilidade_se_desbloqueado`
nao nulo), porque ela **so servia para promover**: perguntar o CNPJ sem poder
promover e atrito puro.

A pergunta de reembolso dispara com `possui_indicio_reembolso` **sozinho**.
`deducibilidade_se_sem_reembolso` decide apenas a promocao, nunca se pergunta. A
razao e que os dois follow-ups tem propositos diferentes: este corrige o **numero
declarado**, e isso vale mesmo quando a despesa segue para revisao — o contador
que revisa precisa do dado, e a DMED cruza o numero de qualquer jeito.

## Precedencia: uma vaga, reembolso ganha

Continua valendo **uma pendencia aberta por usuario** (unique parcial da
migration `009`). Nao ha encadeamento e nao ha fila: se faltarem CNPJ **e**
reembolso, so o reembolso e perguntado.

Reembolso ganha por assimetria de risco:

| | Custo do dado faltando |
| --- | --- |
| Reembolso | Inconsistencia **afirmativa** contra a DMED — um numero errado declarado |
| Documento | Registro **incompleto**, que ja vai para revisao humana |

Numero errado e pior do que lacuna. E, na pratica, os dois quase nunca disputam,
pela regra do prompt citada acima. A precedencia escrita em
`derivarCampoFollowup` existe para o caso de a IA se contradizer — observado na
varredura: `300 na consulta do cardiologista, a guia foi autorizada` volta com
indicio de reembolso **e** destino de desbloqueio preenchido na mesma resposta.

`derivarCamposBloqueantes` nao foi tocada. Ela continua respondendo o que
respondia antes, e `tests/n8n_campos_bloqueantes_test.ts` continua sendo a prova.

## O valor bruto nunca e sobrescrito

`valor` continua sendo o bruto pago. O reembolso entra em coluna propria,
`valor_reembolsado` (migration `010`), e o dedutivel e derivado **na leitura**.

Quatro motivos independentes para nao guardar o liquido em `valor`:

1. quebraria a invariante ja escrita em [[06 - Follow-up Conversacional]] —
   *"valor e data_despesa nunca sao reescritos por follow-up"* — e a quebraria em
   silencio, que e o que a regra existe para impedir;
2. a nota fiscal comprova o **bruto**. Com o liquido na coluna, a linha do dossie
   deixa de bater com qualquer documento, e o cruzamento da DMED (que a Receita
   faz sobre bruto + reembolso) fica irreconciliavel;
3. a coluna e o que todo consumidor le. Guardar o bruto so em `metadados_ia`
   deixaria a coluna errada e o rastro escondido;
4. reembolso integral daria liquido 0 e violaria `recibos_valor_positivo_chk`. O
   modelo "liquido na coluna" nao consegue nem representar o caso.

`NULL` e `0` sao estados diferentes, e um `default 0` apagaria a diferenca:
**NULL = nunca perguntado; 0 = o titular confirmou que nao houve**. O segundo e
evidencia de auditoria, o primeiro e lacuna. A distincao chega ate o papel: no
dossie, `-` contra `R$ 0,00`.

### Armadilha semantica

Reembolso parcial **nao** torna a despesa `PARCIALMENTE_DEDUTIVEL`. Esse status e
para uso misto pessoal/profissional. O que sobra depois do reembolso e
**integralmente** dedutivel. Confundir os dois derrubaria o dedutivel duas vezes.

## Reconhecer a resposta sem IA

O CNPJ **nao** serve de modelo: ele funciona por digito verificador, um token que
se auto-valida. Valor monetario nao tem isso. E nao havia extracao de valor para
reusar — quem extrai valor no fluxo principal e o Gemini; o unico parsing
deterministico que existia coage um campo ja numerico.

`extrairRespostaDeReembolso` tem quatro saidas:

| Resposta | Leitura | Serializado para o payload |
| --- | --- | --- |
| `nao`, `nao houve`, `foi particular`, `zero` | `{ houve: false, valor: 0 }` | `"NAO"` |
| `300`, `o plano cobriu 300 reais`, `1.200,00` | `{ houve: true, valor }` | `"300.00"` |
| `sim`, `houve`, `o plano cobriu` | `{ houve: true, valor: null }` | `"SIM"` |
| qualquer outra coisa | `null` | `null` — segue a cascata de sempre |

Sem digito verificador, o falso positivo e segurado por outras quatro coisas:

1. **contexto de pendencia** — a funcao so roda quando a pergunta aberta e
   `valor_reembolso`;
2. **um numero so** — dois numeros e "valor + alguma coisa", e volta a ser
   mensagem nova;
3. **verbo de gasto** — `paguei 300 no mercado` e despesa, nao resposta;
4. **tamanho** — 11 digitos ou mais e documento colado, nao valor.

O teto de verdade (reembolso nao pode ser maior que a despesa) fica na
`followup-resolve` e na constraint da `010`, porque so eles conhecem o recibo.

### O conflito com a guarda de conteudo vazio

`respostaSemConteudo` tem `nao`, `n`, `nao tenho` na lista negra — correto para a
pergunta de CNPJ, onde `nao` nao carrega dado. Para a pergunta de reembolso,
`nao` e a **resposta completa e mais valiosa que existe**.

A funcao nao foi tocada. O que muda e a **ordem no chamador**: para
`valor_reembolso` o reconhecimento roda antes, e uma negacao reconhecida nunca
chega ate ela. As duas leituras convivem porque nunca sao consultadas juntas.

Detalhe do vocabulario que custou uma iteracao: os verbos de afirmacao (`houve`,
`teve`, `cobriu`) precisam entrar na lista de ligacao da negacao, senao
`nao houve reembolso` — a forma mais natural de negar — nao e reconhecida. E
seguro porque a negacao e testada primeiro e exige uma palavra de negacao
presente.

E `nao vou pedir reembolso ainda` **nao** e negacao: `vou`, `pedir` e `ainda`
ficaram de fora do vocabulario de proposito. Gravar 0 ali criaria exatamente a
inconsistencia com a DMED que a fase existe para evitar.

## Resolucao 100% deterministica

O modo `REEMBOLSO_INFORMADO` **nao chama a IA em nenhum caminho**, e os testes
conferem isso em cada cenario. Nao e economia de chamada: o espaco de respostas
aqui e minusculo e fechado, e mandar o texto ao modelo abriria a porta de
promover a despesa com o reembolso ainda em aberto — a propria inconsistencia que
a fase combate.

| Resposta | O que acontece | Pendencia |
| --- | --- | --- |
| `nao` | `valor_reembolsado = 0`, promove se houver destino **e** identificacao | Fechada |
| valor parcial | grava o valor, deducibilidade vai para o destino declarado | Fechada |
| valor igual a despesa | `NAO_DEDUTIVEL`, sem revisao | Fechada |
| valor maior que a despesa | mensagem de conferencia, nada gravado | **Aberta** |
| `sim` sem valor | pede o valor | **Aberta** |
| nao reconhecida / sem conteudo | repete a pergunta | **Aberta** |

As tres ultimas ficam **antes** de `reivindicar`, como as guardas da fase
anterior: pendencia que nao foi respondida nao pode ser consumida. O orcamento
continua sendo debitado na `whatsapp-webhook`, entao nao vira pendencia imortal.

Reembolso integral rebaixa para `NAO_DEDUTIVEL`, e isso **nao** contradiz
"promocao nunca rebaixa": aquela regra protege classificacao auditada contra
variacao do modelo, e aqui nao ha modelo no caminho. Quem afirmou que voltou tudo
foi o titular.

### A promocao exige identificacao no recibo

Alem do destino declarado. Medido na varredura: o Gemini devolve
`deducibilidade_se_sem_reembolso: "DEDUTIVEL"` em despesa **sem prestador
nenhum** (`consulta 400 reais, usei o convenio`). Sem esta checagem, responder
`nao` aprovaria automaticamente uma despesa de saude sem prestador — o oposto do
que o follow-up de identificacao existe para garantir. E fato da linha, nao juizo,
por isso e conferido em codigo.

## O discriminador do classificador de intencao tambem mudou

A instrucao injetada quando ha pendencia aberta terminava com *"NAO use esta
categoria quando a mensagem trouxer o VALOR em dinheiro de um gasto novo"*. Na
pergunta de reembolso o valor em dinheiro **e** a resposta certa, e herdar aquela
frase empurraria a resposta de volta para `registro_despesa` — o bug 9/9 da fase
anterior com outra roupa.

`Preparar Contexto` passou a derivar `followup_instrucao` por campo, alem de
`followup_contexto`. Sem pendencia os dois sao nulos e o prompt continua **byte a
byte** o de antes, com teste comparando contra `git show HEAD`.

## Numeros da validacao

### Gatilho, contra o Gemini real (temperatura 0.2, a de producao)

**22/22 casos estaveis em 5 execucoes** — 110 chamadas, zero divergencia.

Convenio **fora de contexto medico**, que era a preocupacao explicita: **6/6**.

| Mensagem | `possui_indicio_reembolso` |
| --- | --- |
| `paguei 1200 de taxa do convenio com a prefeitura` | false (IMPOSTOS_TAXAS) |
| `300 reais da mensalidade do convenio de estagio da faculdade` | false (EDUCACAO) |
| `assinei o convenio de parceria comercial, custou 800 de honorarios` | false (SERVICOS_PROFISSIONAIS) |
| `convenio entre empresas, paguei 450 de adesao` | false |
| `comprei remedio 90 reais na farmacia conveniada da empresa` | false (SAUDE) |
| `paguei 60 de almoco no restaurante conveniado` | false (ALIMENTACAO) |

Disparo correto em saude com terceiro pagador: **8/8** (convenio, reembolso
declarado, coparticipacao, operadora nomeada, carteirinha, guia autorizada,
empregador, dependente de plano).

Saude sem indicio e fora de saude: **8/8** false, incluindo
`1500 de mensalidade da faculdade, a empresa reembolsa parte` — reembolso real,
mas o gate e so SAUDE.

### O ajuste que a varredura obrigou

A primeira versao da instrucao dizia *"na duvida entre particular e convenio numa
despesa de saude, marque true"*. O modelo leu isso como "toda despesa de saude e
duvida":

| Mensagem | Antes | Depois |
| --- | --- | --- |
| `paguei 600 no proctologista` | true **3/3** | false 5/5 |
| `paguei 200 no dentista` | true 2/3 | false 5/5 |
| `450 de consulta na clinica vida, paguei no pix` | true **3/3** | false 5/5 |

O estrago seria grande e silencioso: `paguei 600 no proctologista` e a frase
canonica do follow-up de CNPJ, documentada em [[06 - Follow-up Conversacional]].
Com o gatilho disparando ali, a pergunta de reembolso **roubaria a vaga** da
pergunta validada na fase anterior, em todas as despesas de saude escritas do
jeito mais comum.

A correcao nao foi afrouxar o gate, foi exigir que o indicio **esteja** na
mensagem ou na evidencia: ausencia de mencao a plano nao e indicio de plano. O
"errar para o lado de perguntar" continua valendo **dentro** da zona de duvida —
so nao serve para entrar nela.

### Classificador de intencao, contra o Gemini real (temperatura 0)

**17/18 casos estaveis em 3 execucoes.**

- 7/7 respostas em texto livre a pergunta de reembolso -> `resposta_de_followup`
  (`o plano cobriu metade`, `o convenio cobre 70 por cento`,
  `so a parte da coparticipacao ficou comigo`, `pedi mas ainda nao caiu na conta`);
- 3/3 despesas novas com pendencia de reembolso aberta continuam
  `registro_despesa`;
- 5/5 sem regressao na pergunta de identificacao — as mesmas frases da fase
  anterior.

O 18º nao e falha: `o plano cobriu metade` **sem pendencia nenhuma** vira
`fora_do_escopo_financeiro`. Como o teste prova que o prompt sem pendencia e byte
a byte o de `HEAD`, isso e comportamento pre-existente.

### Postgres real e mutation check

Migration validada em `postgres:15` com o shim (`bash tests/sql/run_migrations_docker.sh`),
com **4/4 mutantes detectados** na propria migration.

Mutation check dos testes novos: **12/12** na logica e na Edge Function, **7/7**
nos espelhos do n8n, **6/6** no dossie. Dois mutantes passaram na primeira
rodada e viraram teste:

- a recusa por "dois numeros" so era observavel com uma palavra de negacao ou
  afirmacao na frase (`nao 200 300`), porque sem ela a mensagem ja caia em `null`
  por outro caminho;
- o traco da lacuna no dossie nao era afirmado — o teste so via a descricao, e um
  `R$ 0,00` no lugar do traco passava batido.

## Arquivos

| Camada | Arquivo |
| --- | --- |
| Schema | `supabase/migrations/010_reembolso_saude.sql` |
| Prompt | `backend/prompts/taxmind_system_prompt.js` (+ 2 copias vivas) |
| Logica pura | `supabase/functions/_shared/followup.ts` |
| Resolucao | `supabase/functions/followup-resolve/index.ts` |
| Dossie | `supabase/functions/generate-dossier/index.ts` |
| n8n | `Montar Payload do Recibo`, `Preparar Contexto`, `Gemini - Classificar Intent` |
| Testes | `tests/followup_reembolso_test.ts`, `tests/n8n_fase15_test.ts`, `tests/sql/010_reembolso_saude_test.sql`, alem dos blocos novos em `followup_resolve_test.ts` e `dossie_nota_deducao_test.ts` |
