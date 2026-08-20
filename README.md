# TaxMind

Copiloto fiscal no WhatsApp para quem tem medo de cair na malha fina e nao tem
onde guardar comprovante. O usuario manda a foto do recibo ou descreve o gasto
por texto, e o TaxMind classifica a despesa, julga a dedutibilidade no IRPF,
pergunta o que faltou e mantem a trilha de auditoria do ano inteiro em um lugar
so. Na hora de declarar, o material sai pronto: resumo no WhatsApp, dossie em
PDF e planilha estruturada pelas fichas reais do IRPF para o contador.

> **Prototipo academico (TCC).** Nao e produto comercial, nao substitui
> contador e nao presta consultoria tributaria. Roda com contas de sandbox e
> dados de teste; o que existe aqui e uma implementacao funcional de ponta a
> ponta, com as decisoes de projeto documentadas.

## Como funciona na pratica

O WhatsApp e o unico canal de uso. Nao ha app para instalar nem tela para
aprender.

1. **Captura.** Foto do cupom, PDF da nota ou texto solto ("paguei 350 no
   dentista"). A `whatsapp-webhook` valida a assinatura da Meta, resolve a
   sessao e roteia: midia vai para o workflow de OCR, texto para o de consulta.
2. **Classificacao.** O Gemini recebe o prompt fiscal do projeto e devolve um
   bloco estruturado: descricao normalizada, valor, data, estabelecimento,
   documento do prestador, categoria, dedutibilidade, confianca, motivos de
   revisao e evidencias extraidas.
3. **Gravacao e resposta.** A despesa entra em `recibos_evidencias` com status
   `APROVADO_AUTOMATICAMENTE` ou `REVISAO_HUMANA`, e o usuario recebe a
   confirmacao na hora — antes de qualquer pergunta de acompanhamento.
4. **Follow-up.** Quando falta um dado objetivo (CNPJ do prestador, valor
   reembolsado pelo plano), o bot pergunta uma coisa so, com prazo e orcamento
   de mensagens. A resposta reconhecida promove a despesa sem passar pela IA.
5. **Consolidacao.** A qualquer momento: `resumo`, `dossie`, `exportar para
   contador`, `conectar banco`, `importar declaracao anterior`.

O que a IA nao decide sozinha fica em revisao humana em vez de virar deducao
otimista — a premissa do projeto e que erro para mais custa mais caro que
lancamento incompleto.

## Funcionalidades

Cada item abaixo existe no repositorio e tem teste, migration ou workflow
correspondente.

| Funcionalidade | O que faz |
| --- | --- |
| **Classificacao fiscal e dedutibilidade** | Prompt fiscal proprio classifica a despesa em 12 categorias e julga dedutibilidade (`DEDUTIVEL`, `PARCIALMENTE_DEDUTIVEL`, `NAO_DEDUTIVEL`, `INDETERMINADO`), com justificativa, score de confianca e motivos de revisao gravados linha a linha. |
| **Human-in-the-loop** | Baixa confianca, conflito fiscal ou dado essencial faltando mandam a despesa para `REVISAO_HUMANA` em vez de aprova-la. |
| **Follow-up conversacional** | Uma pergunta objetiva por vez sobre campo faltante (`documento_prestador`, `estabelecimento`), com TTL de 30 min, orcamento de 2 mensagens e substituicao explicita quando chega despesa nova. |
| **Reembolso de despesa de saude** | Pergunta se o plano devolveu parte do valor e grava `valor_reembolsado` ao lado do bruto (nunca no lugar dele). Resumo, dossie e export passam a usar o liquido, que e o que a Receita cruza com a DMED. |
| **Encadeamento reativo** | Respondida a pergunta do reembolso, o sistema reavalia o recibo e, se ainda faltar identificacao do prestador, faz a segunda pergunta — com quatro freios que garantem no maximo dois passos. |
| **Mitigacao de multiplas despesas** | Mensagem com mais de um gasto e somada em um lancamento so, mas nunca aprovada automaticamente: vai para revisao com aviso explicito ao usuario. |
| **Open Finance via Pluggy** | Conexao bancaria pelo widget do Pluggy, sincronizacao de transacoes de conta e cartao, pre-filtro por categoria e classificacao por IA so no que sobra, com deduplicacao e agregacao de lote entre invocacoes concorrentes. |
| **Resumo fiscal** | Agregacao por categoria com total gasto, total dedutivel (liquido de reembolso) e quantos lancamentos aguardam revisao. |
| **Dossie em PDF** | Trilha de auditoria completa do titular — inclusive o que nao e dedutivel — com totais e a nota de que deducao reduz a base de calculo, nao o imposto devido. |
| **Export estruturado para o contador** | Planilha `.xlsx` com duas abas separadas pelo mecanismo real de deducao: ficha "Pagamentos Efetuados" e possiveis deducoes de Livro-Caixa, cada uma com as ressalvas de limite que o sistema nao verifica. |
| **Import da declaracao anterior** | O usuario envia o PDF da declaracao do e-CAC; o sistema extrai modelo, aliquota efetiva, base, rendimentos e deducoes declaradas, **descarta o arquivo** e guarda so o hash SHA-256. |
| **Comparacao com o historico** | Com a declaracao importada, o resumo passa a estimar quanto o dedutivel deste ano representaria de imposto a menos, e a perguntar sobre categoria declarada no ano passado sem nenhum registro este ano. |
| **Pontos de atencao antes de declarar** | Agrega sinais ja gravados que sao causas conhecidas de pedido de comprovacao — falta de identificacao do prestador, reembolso de saude nao confirmado, uso misto sem percentual, lancamento parado em revisao e salto de valor em relacao a declaracao anterior. Aparece agregado no resumo e marcado linha a linha no export. **Nao e preditor de malha fina**, e o texto diz isso. |
| **Motor de calculo do IRPF** | Tabela progressiva mais os redutores da Lei 15.270/2025, indexados por ano-calendario, com truncagem e apuracao faixa a faixa iguais as do simulador oficial. Os parametros sao versionados em fixtures e conferidos contra o servico da Receita. |
| **Onboarding por magic link** | O cadastro acontece em uma pagina React aberta por link assinado (HMAC, TTL de 15 min) enviado no WhatsApp; nome, e-mail e CPF nunca trafegam pela conversa. |
| **Re-verificacao por e-mail** | Depois de 30 dias sem confirmacao de identidade, o acesso a dado consolidado exige um codigo enviado por e-mail (Resend), com expiracao e limite de tentativas. |
| **Consentimento LGPD** | Texto versionado, aceite obrigatorio e verificado no servidor, com hash do texto calculado no backend — nao no navegador. |
| **Isolamento por RLS** | Toda tabela isola por `auth.uid()`; funcoes de agregacao sao `SECURITY INVOKER` de proposito, e tabela nova nasce com `revoke` explicito de `anon`/`authenticated`. |

## Stack tecnica

| Camada | Escolha |
| --- | --- |
| Interface | WhatsApp Cloud API (webhooks oficiais da Meta), com validacao de assinatura `x-hub-signature-256` |
| Orquestracao | n8n 1.99.1 em Docker (`docker-compose.yml`), tres webhooks independentes: recibo, texto e Open Finance |
| IA | Google Gemini `gemini-3-flash-preview` — classificacao textual, visual, de intencao e reclassificacao de follow-up |
| Dados | Supabase / PostgreSQL com RLS, 12 migrations versionadas |
| Backend | Supabase Edge Functions (Deno/TypeScript), logica pura isolada em `_shared/` para ser testavel sem rede |
| Open Finance | Pluggy (`pluggy-sdk`), widget Connect + webhooks de transacao |
| Frontend | React + Vite (`apps/onboarding`), deploy na Vercel |
| Infra do n8n | VM Linux na Azure, com Docker |
| Arquivos | Supabase Storage, buckets privados com signed URL de vida curta |

## Estrutura do repositorio

```
supabase/migrations/   schema, RLS, funcoes SQL (001..012)
supabase/functions/    Edge Functions deployaveis + _shared/ (logica pura)
n8n/workflows/         exports JSON vivos dos workflows
backend/prompts/       fonte de edicao do prompt fiscal
apps/onboarding/       app real de onboarding (Vite/React)
Mockup/                prototipo visual, anterior ao app real
tests/                 testes Deno das functions, workflows e SQL
docs/                  notas de projeto em Markdown (Obsidian)
AGENTS.md              contexto persistente e aprendizados operacionais
```

Dois arquivos em `backend/` sao intencionalmente inertes:
`reports/generate_dossier.py` e um placeholder (o dossie real e a Edge Function
`generate-dossier`) e `auth/passkeys_pseudocode.ts` e pseudocodigo de estudo.

## Rodar localmente

Cada parte tem instrucoes proprias, e elas nao sao duplicadas aqui:

- **App de onboarding** (`npm run dev`, variaveis `VITE_*`, deploy na Vercel):
  [`apps/onboarding/README.md`](apps/onboarding/README.md).
- **Edge Functions** (modulos compartilhados, chamador e autenticacao de cada
  function): [`supabase/functions/README.md`](supabase/functions/README.md).
- **Workflows n8n** (contrato de entrada, roteamento e variaveis de ambiente):
  [`n8n/workflows/README.md`](n8n/workflows/README.md).

Para o essencial:

```bash
cp .env.example .env       # segredos de backend ficam so na raiz
docker compose up -d n8n   # n8n 1.99.1 em http://localhost:5678
```

Testes:

```bash
deno test --allow-env --allow-net tests/
```

Testes que dependem de rede (Gemini real, Management API do Supabase, Pluggy)
se auto-ignoram sem credencial. As migrations sao validadas em Postgres puro
com um shim de ~10 linhas:

```bash
bash tests/sql/run_migrations_docker.sh
```

A CI (`.github/workflows/ci.yml`) hoje so valida o JSON dos workflows e a
existencia das migrations — ela **nao** executa a suite de testes.

## Documentacao

`AGENTS.md` e a fonte principal de contexto: produto, decisoes arquiteturais e
uma secao longa de aprendizados operacionais (armadilhas ja encontradas em n8n,
Supabase, Gemini, Pluggy e PDF). As notas por tema ficam em `docs/`:

| Nota | Assunto |
| --- | --- |
| `04` | Re-verificacao por e-mail com Resend |
| `05` | Consentimento LGPD no onboarding |
| `06` | Follow-up conversacional |
| `07` | Testes exploratorios contra o Gemini real |
| `08` | Reembolso de despesa de saude |
| `09` | Incidente de deploy parcial das Edge Functions |
| `10` | Export estruturado para o contador |
| `11` | Encadeamento reativo de follow-up |

## Limitacoes Conhecidas

Comportamentos decididos, e nao bugs em aberto. Detalhes em
`docs/06 - Follow-up Conversacional.md`.

- **Referencia a despesa antiga sem pendencia aberta.** O bot so sabe a qual
  despesa uma mensagem se refere enquanto existe uma pergunta aberta em
  `followups_pendentes` — a janela e de 30 minutos ou 2 mensagens. Fora dela,
  "corrige a consulta de ontem" ou "o cnpj daquela clinica e X" nao encontra o
  lancamento e cai na mensagem de ajuda. Resolver isso e feature nova
  (identificar a despesa alvo em linguagem natural), nao conserto do follow-up.
- **Midia nunca responde a uma pergunta.** Foto do recibo com o CNPJ pedido
  entra como lancamento novo, e nao como resposta. E deliberado: tratar imagem
  como resposta transformaria um recibo legitimo em patch de outra despesa, e o
  custo do erro e assimetrico — a pendencia ignorada expira sozinha, o
  lancamento perdido nao volta. A unica excecao e o PDF da declaracao anterior,
  e so enquanto a pendencia especifica dele estiver aberta.
- **Uma pendencia por vez.** Nao ha fila: pergunta nova encerra a anterior, com
  aviso explicito ao usuario. Duas perguntas abertas tornariam insoluvel a
  questao de a qual delas uma resposta se refere.
- **Multiplas despesas numa mensagem viram um lancamento so.** Elas sao
  marcadas e enviadas para revisao humana, mas nao separadas em linhas.
- **Revisao humana nao tem interface.** `REVISAO_HUMANA` marca o lancamento e o
  resumo mostra a contagem, mas as colunas `revisado_por`/`revisado_em` nao sao
  escritas por nenhum componente: nao existe painel de revisao no MVP. O ponto
  de atencao "parado em revisao" ja le essas colunas para continuar correto no
  dia em que a revisao existir.
- **O sistema nao guarda percentual de rateio.** Uma despesa de uso misto e
  marcada como `PARCIALMENTE_DEDUTIVEL` e fica fora do total dedutivel, mas a
  fracao profissional nunca e registrada — ela e decisao do contador. Por isso
  o ponto de atencao de uso misto vale para toda despesa parcial, sem
  distinguir "com" e "sem" percentual documentado.

## Licenca

Ver [`LICENSE`](LICENSE).
