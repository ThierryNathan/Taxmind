# 10 - Export Estruturado para o Contador

Planilha `.xlsx` com as despesas dedutíveis, separada pelos **dois mecanismos de
dedução do IRPF**, entregue pelo WhatsApp como documento. Complementa o dossiê em
PDF — não o substitui.

Relacionado: [[00 - Mapa da Arquitetura]], [[08 - Reembolso de Despesa de Saude]],
[[09 - Incidente de Deploy Parcial]].

## O problema que ele resolve

O dossiê em PDF é a trilha de auditoria do titular: mostra tudo, inclusive o que
não é dedutível. É o artefato certo para "me prova o que eu gastei", e o errado
para "meu contador precisa lançar isso".

O contador precisa de outra coisa: só o que dá para usar, com valor somável, já
separado pela **ficha da declaração** em que cada linha entra. Essa separação é a
parte que o TaxMind pode fazer e que o PDF não fazia.

## As duas seções, e por que são duas

O enum `categoria_fiscal` (migration 001) mistura dois mecanismos que não são
graus da mesma coisa:

| Seção | Categorias | Quem pode usar |
| --- | --- | --- |
| **Pagamentos Efetuados** | `SAUDE`, `EDUCACAO` | Qualquer contribuinte |
| **Possíveis deduções via Livro-Caixa** | `ESCRITORIO`, `EQUIPAMENTOS`, `SOFTWARE`, `INTERNET_TELEFONIA`, `SERVICOS_PROFISSIONAIS`, `IMPOSTOS_TAXAS` | Só quem tem renda não assalariada sujeita ao carnê-leão |

Numa lista única o leitor soma um total geral que **não existe para ninguém**:
metade dele depende de carnê-leão, metade não. Daí duas abas, e não uma coluna
"tipo".

### `IMPOSTOS_TAXAS` está no Livro-Caixa de propósito

A tentação é descartá-lo como "taxa não é dedutível". Mas o próprio prompt fiscal
manda classificar **conselhos profissionais** nessa categoria
(`_shared/prompt_fiscal.ts`, seção 8), e anuidade de CRM/CRO/OAB e contribuição a
sindicato de classe são despesa de custeio clássica do livro-caixa. Descartar a
categoria apagaria uma dedução real do material de trabalho.

O bucket é reconhecidamente heterogêneo — taxa bancária pessoal e multa caem nele
também. É por isso que a aba carrega a nota de conferir com o contador, e não por
isso que ela seria removida.

### Categoria pessoal com nexo profissional declarado

`MORADIA`, `ALIMENTACAO` e `OUTROS` entram no Livro-Caixa **quando a IA já
julgou** a linha `DEDUTIVEL` ou `PARCIALMENTE_DEDUTIVEL`.

O caso concreto é aluguel de consultório e rateio de home office: o prompt lista
"aluguel de consultorio, luz" entre os exemplos de livro-caixa (seção 3) e manda
marcar home office como `PARCIALMENTE_DEDUTIVEL` (seção 6) — mas a categoria
gravada nessas linhas é `MORADIA`. Filtro só por categoria descartaria exatamente
a despesa que a regra manda deduzir.

`INDETERMINADO` **não** libera: é a ausência de julgamento, e promover por
ausência levaria toda conta de luz residencial para a planilha.

`OUTROS` está na lista por um motivo mais chato: é o `default` da coluna
(001:92), então toda linha cuja classificação falhou cai nele.

### `TRANSPORTE` nunca entra

Não por ser "pouco dedutível na prática" — por vedação expressa. O **art. 68 do
RIR/2018** exclui despesa de locomoção e transporte do livro-caixa, com uma única
exceção: representante comercial autônomo, quando o ônus for dele. O TaxMind não
registra profissão e não tem como identificar a exceção.

A aba **diz** que transporte ficou de fora e por quê. Silêncio faria o contador
achar que o titular não teve a despesa — e para o representante comercial, o
único que poderia deduzi-la, a omissão sem aviso seria dedução perdida.

## `.xlsx`, não `.csv`

A decisão inverteu depois de checar a documentação da Meta: a Cloud API **não
lista `text/csv`** entre os mime types aceitos para documento, e `.xlsx` está na
lista. Um CSV correto seria recusado no envio, que é o único canal de entrega.

Ganhos colaterais: as duas abas saem de graça (em CSV seriam blocos separados por
linha em branco) e `valor` chega como **número**, então o contador soma e filtra
sem reimportar. `xlsx@0.18.5` roda no runtime Deno das Edge Functions —
verificado, com número, acento e duas abas sobrevivendo ao round-trip.

## Detalhes que custaram tempo

- `XLSX.read` **não popula `celula.z`** sem `cellNF: true`. O formato de moeda
  está corretamente gravado no arquivo, mas um teste que leia sem essa opção
  acusa "nenhuma célula recebeu formato" e parece bug do gerador.
- As notas ficam **acima** do cabeçalho da tabela, não como rodapé: rodapé
  desaparece no primeiro "ordenar por valor" que o contador aplicar, e a nota do
  carnê-leão é a única coisa que impede um assalariado de usar a aba.
- `data_despesa` é `DATE` e `criado_em` é `timestamptz`. Parsear `"2026-08-09"`
  direto puxa a data um dia para trás em São Paulo (UTC-3); o `T12:00:00` no meio
  do dia evita isso.
- O período coberto é o das linhas **exportadas**, não o de todos os recibos.
  Dizer "janeiro a dezembro" num arquivo cuja primeira linha é de agosto faz o
  contador procurar dado que nunca esteve lá.
- `NULL` e `0` em `valor_reembolsado` continuam distintos até a célula (célula
  vazia contra `0,00`), pela mesma razão da migration 010.
- Nome de aba do Excel tem limite de **31 caracteres**; passar disso corrompe o
  arquivo ao abrir. Daí `Possiveis deducoes Livro-Caixa` e não o título completo.

## Gatilho

Mesmo padrão de resumo/dossiê/conectar_banco: palavra-chave primeiro, Gemini como
fallback.

O branch novo é checado **antes** do de dossiê, e isso não é estética: o branch de
dossiê casa `"exportar"`, então `"exportar para contador"` cairia nele. Como
palavra-chave vence IA, o erro seria determinístico e nunca se corrigiria sozinho.

Dois caminhos, com riscos diferentes:

1. `planilha` / `excel` / `xlsx` — inequívocos, a palavra sozinha basta.
2. `contador`/`contabil` **junto de** um verbo de entrega **e sem** termo de
   dossiê. `"contador"` sozinho não pode bastar: `"manda o dossiê pro meu
   contador"` é pedido de dossiê, e `"quanto paguei ao meu contador"` é consulta.
   Quem citou PDF ou dossiê já escolheu o formato — ali contador é o
   destinatário, não o formato.

Medições contra o Gemini real (`tests/export_contador_gemini_test.ts`, 3
execuções por caso): **33/33** estáveis nas 11 frases que não casam palavra-chave,
incluindo os intents antigos que não podiam ser canibalizados.

## Descoberta (UX)

- `sobre_o_taxmind` ganhou o item 6, a planilha.
- A ajuda genérica (`WhatsApp - Enviar Ajuda`) também passou a citá-la.
- **Boas-vindas após o cadastro**, novidade desta fase — ver abaixo.

### Onde fica o gatilho de "cadastro concluído"

Ele não existia. Os candidatos avaliados:

1. **Fim do fluxo React.** Descartado: o navegador não pode disparar envio de
   WhatsApp sem expor credencial, e a tela pode ser fechada antes.
2. **Primeira mensagem depois do cadastro, na `whatsapp-webhook`.** Descartado:
   exigiria uma flag de "já dei boas-vindas" só para isso, e a mensagem chegaria
   em resposta a outra coisa que o usuário mandou — atrasada e fora de contexto.
3. **A própria `bootstrap-identity`.** Escolhida: é o único ponto do sistema onde
   o cadastro conclui de fato (onde `onboarding_concluido` vira `true`), tem o
   telefone verificado no token e roda uma vez só por cadastro.

A tela de sucesso já manda "volte para o WhatsApp"; a mensagem é o que espera a
pessoa lá.

Duas restrições que valem para qualquer envio nesse ponto:

- **Nunca derruba o cadastro.** A mensagem é cortesia, o cadastro é o produto. Um
  500 do Graph API virando erro de cadastro mostraria "Não deu certo" na tela com
  a conta já criada — e o botão "Tentar novamente" não teria o que consertar.
- **`onboarding_concluido` é lido ANTES do upsert.** Depois dele todo mundo é
  `true` e não há mais como distinguir cadastro novo de refação, então quem
  repete o link receberia as boas-vindas de novo.

## Deploy

Além do óbvio (`export-contador` é function nova), a `bootstrap-identity` **tem
que ser redeployada**: o `index.ts` dela mudou e ela passou a importar
`_shared/boas_vindas.ts`. É exatamente a classe de omissão de
[[09 - Incidente de Deploy Parcial]], e `tests/deploy_drift_test.ts` já a acusa.

```bash
supabase functions deploy export-contador && supabase functions deploy bootstrap-identity
```

O workflow `consulta-e-dossie.json` precisa ser reimportado no n8n. Conferir que
o `active: true` sobreviveu à importação.
