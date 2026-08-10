# 11 - Encadeamento Reativo de Follow-up

Relacionado a [[06 - Follow-up Conversacional]], [[08 - Reembolso de Despesa de Saude]] e [[07 - Testes Exploratorios e Variacoes]].

Fase 16. Quando uma pendencia de follow-up resolve, o recibo e reavaliado: se
ainda houver campo respondivel, a pergunta seguinte nasce na mesma resposta.
Continua sendo **uma pergunta por vez** — o que muda e que a segunda existe.

## O bug, em dois transcripts reais

Nao era hipotese. As duas sequencias abaixo vieram de conversas de WhatsApp.

### Sequencia 1

| # | Mensagem | O que acontecia |
| --- | --- | --- |
| 1 | `Paguei 500 na consulta e com convênio` | pendencia de `valor_reembolso` criada |
| 2 | `Não teve reembolso` | reembolso gravado, pendencia fecha, **nenhuma nova** |
| 3 | `o cnpj é 11.222.333/0001-81` | *"Não consegui identificar o valor dessa despesa, então não registrei nada."* |

### Sequencia 2

| # | Mensagem | O que acontecia |
| --- | --- | --- |
| 1 | `Paguei 799 no dentista` | pendencia de `documento_prestador` criada |
| 2 | `Foi do convênio` | reclassificado, pendencia fecha, **nenhuma nova** |
| 3 | `o cnpj é 11.222.333/0001-81` | mesma falha |

## Causa raiz

`followup-resolve` tem tres modos, e os tres terminavam no mesmo par de linhas:
patch no recibo, `return`. Nada entre eles. No arquivo inteiro nao existia
`insert` nem chamada a `registrar_followup_pendente` — as unicas escritas em
`followups_pendentes` eram `reivindicar` e `descartar`. **A function so sabia
fechar pendencia, nunca abrir.**

O unico componente que abria era o no `Supabase - Registrar Follow-up` do
`receipt-ocr-classification`, atras do IF `Tem Campo Bloqueante?` — ou seja, so
no insert de um recibo novo. Despesa que precisava de duas respostas recebia uma
pergunta e nunca a segunda.

O passo 3 e consequencia direta: sem pendencia aberta, o classificador de
intencao nao recebe `followup_contexto`, le a mensagem como despesa nova
(`registro_despesa`, medido 3/3 no Gemini real), o prompt fiscal devolve
`valor: 0` tentando dar sentido ao texto, e o IF `Valor Válido?` responde com a
mensagem de valor invalido. Com pendencia aberta a mesma mensagem da
`resposta_de_followup` 3/3 — nao e o classificador que erra, e a ausencia de
pendencia para contextualiza-lo.

## Por que encadeamento reativo, e nao um fallback de CNPJ solto

A alternativa considerada era: quando a mensagem "parece" um documento isolado e
nao ha pendencia, procurar o recibo mais recente da sessao numa janela curta e
anexar ali. Foi descartada por tres razoes, e a primeira sozinha ja decide:

1. **Nao cobre o achado da sequencia 2.** O reembolso nunca viraria pergunta em
   caminho nenhum, e a despesa seguiria deduzindo valor possivelmente
   reembolsado — a inconsistencia com a DMED que [[08 - Reembolso de Despesa de Saude]] existe para evitar.
2. Nao cobre resposta em texto livre (`foi na clinica X`), que so o caminho de
   reclassificacao enxerga.
3. "Recibo mais recente da sessao nos ultimos 10 min" e uma **segunda nocao de
   pendencia**, implicita e paralela: sem TTL, sem orcamento de mensagens, sem
   `SUPERSEDIDA`, sem trilha em `followups_pendentes`. A migration 009 documenta
   por que a pendencia virou tabela propria em vez de estado inferido; o
   fallback reintroduziria o estado inferido por baixo.

O encadeamento tambem nao muda topologia nenhuma no n8n: `followup-resolve` ja
tinha service_role, o recibo em maos e o retorno `mensagem` que o no
`WhatsApp - Enviar Resposta do Follow-up` ja envia.

## O que a reavaliacao le

Nao e "reler `metadados_ia`". Duas correcoes, e as duas sao o motivo de
`estadoAposPatch` existir.

**1. Identificacao vem das COLUNAS pos-patch.** `metadados_ia` guarda a extracao
original e continua com o documento vazio depois de um `CAMPO_PREENCHIDO`. Ler
dali reperguntaria o que acabou de ser respondido.

**2. Depois do reembolso respondido, o destino e o residual.** Este e o ponto
que quase deixou a sequencia 1 sem correcao. O prompt manda declarar
`deducibilidade_se_desbloqueado: null` quando ha indicio de reembolso — medido
3/3 em `Paguei 500 na consulta e com convênio`:

```
possui_indicio_reembolso: true
deducibilidade_se_desbloqueado: null
deducibilidade_se_sem_reembolso: "DEDUTIVEL"
```

E `derivarCamposBloqueantes` faz gate exatamente em
`deducibilidade_se_desbloqueado`. Lendo o campo cru, a reavaliacao devolveria
`[]` e a sequencia 1 continuaria quebrada. Respondido o reembolso, quem responde
"identificar o prestador desbloqueia para onde?" passa a ser
`deducibilidade_se_sem_reembolso`.

A mesma regra vale em `promoverDeducibilidade`, e precisa valer nos dois
lugares: sem ela o CNPJ encadeado promoveria o recibo para
`APROVADO_AUTOMATICAMENTE` mantendo `INDETERMINADO` — uma despesa que nao chega
ao contador e tambem nao conta como dedutivel. Esse caminho so e alcancavel via
encadeamento: antes desta fase nao existia recibo com `valor_reembolsado`
preenchido **e** pendencia de identificacao aberta.

## Os quatro freios

Em ordem de avaliacao dentro de `proximaPergunta`:

1. **Recibo fora de revisao nao ganha pergunta.** Cobre a promocao dos tres
   modos e o reembolso integral (fecha em `NAO_DEDUTIVEL`). Nenhuma pergunta
   mudaria o desfecho.
2. **Reembolso ja gravado.** `valor_reembolsado !== null` — a distincao
   NULL/0 da migration 010 e o que torna isso possivel.
3. **Identificacao ja satisfeita.** A regra fiscal de SAUDE pede prestador OU
   estabelecimento, entao um CNPJ conferido fecha o requisito inteiro.
   `derivarCamposBloqueantes` olha campo a campo e devolveria `estabelecimento`
   para um recibo que acabou de receber o documento. Num lancamento novo isso
   nunca aparecia, porque a pendencia nascia uma vez so.
4. **Campo ja perguntado neste recibo, com qualquer desfecho.** E o que torna
   verdadeira a invariante de no maximo dois passos.

Os freios 2 e 4 se sobrepoem em todo caminho alcancavel hoje, e isso foi
descoberto por mutacao: arrancar o freio 2 nao quebrava teste nenhum. Eles
respondem perguntas diferentes — `camposJaPerguntados` responde *"ja perguntei
isso?"* (conversacional) e `valor_reembolsado` responde *"ja sei a resposta?"*
(factual). A factual e a mais robusta: se algum caminho futuro gravar a coluna
sem ter conversado, so ela segura a pergunta. Ha teste que separa as duas.

## Fail open, com uma excecao

A resposta ao usuario e o patch no recibo ja existem quando o encadeamento roda.
Falha ali nao pode derrubar nem uma coisa nem outra — o pior caso e a segunda
pergunta nao ser feita, que e o comportamento de antes desta fase.

A excecao e `camposJaPerguntados`, que **falha fechado**: sem saber o que ja foi
perguntado, o risco vira repetir a pergunta em laco. Nao perguntar e o
comportamento antigo; repetir seria pior do que ele.

## O que ficou de fora, e por que

**A sequencia 2 nao esta inteiramente corrigida.** O achado do reembolso esta: a
analise nova declara `possui_indicio_reembolso: true` (6/6 quando o recibo ainda
nao tem estabelecimento) e isso agora vira pergunta em vez de morrer na trilha.

Mas o passo 3 continua falhando. Depois da correcao, a pendencia aberta naquele
ponto e a de **reembolso**, e o CNPJ responde uma pergunta que nao foi feita:

- `extrairRespostaDeReembolso("o cnpj é 11.222.333/0001-81")` devolve `null` —
  correto, sao tres grupos de digitos;
- o classificador, mesmo com `followup_contexto` de `valor_reembolso`, devolve
  `registro_despesa` **6/6**;
- resultado: a mesma mensagem de valor invalido, com a pendencia de reembolso
  sobrevivendo (orcamento 2 -> 1).

Responder uma pendencia diferente da aberta e a **fila de multiplas pendencias**,
decidida fora de escopo desde a Fase 13 e registrada como tal na migration 010.
Corrigir isso aqui exigiria roteamento cruzado entre campos, que e outra fase.

## Instabilidade da sequencia 2, medida

O passo 2 nao e estavel, e a instabilidade vem do passo 1:

| Recibo | `Foi do convênio` | Efeito |
| --- | --- | --- |
| com `estabelecimento` preenchido (2/3 no passo 1) | `SEM_RELACAO` **6/6** | pendencia nem fecha |
| com `estabelecimento` null (1/3 no passo 1) | reclassifica **6/6** | pendencia fecha — o bug relatado |

O teste de aceite semeia **especificamente** o ramo `estabelecimento=null`, e
nao a media das execucoes: testar a media esconderia o unico ramo que reproduz o
transcript.

## Onde isto vive

- `supabase/functions/followup-resolve/index.ts` — `proximaPergunta`,
  `estadoAposPatch`, `reembolsoRespondido`, `camposJaPerguntados`,
  `comPerguntaSeguinte`, e o destino residual em `promoverDeducibilidade`.
- `tests/followup_resolve_test.ts` — os dois testes `ACEITE seq1` / `ACEITE seq2`
  mais os freios, com o RPC `registrar_followup_pendente` espelhado no
  mini-PostgREST.

`_shared/followup.ts` **nao foi tocado**: tudo o que o encadeamento precisa ja
era exportado de la, e a reavaliacao nao tem espelho no n8n. Por isso a
`whatsapp-webhook` fica fora do redeploy — confirmado pelo
`tests/deploy_drift_test.ts`, que acusou so a `followup-resolve`.
