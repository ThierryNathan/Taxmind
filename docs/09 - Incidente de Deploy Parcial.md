# 09 - Incidente de Deploy Parcial

Relacionado a [[08 - Reembolso de Despesa de Saude]], [[06 - Follow-up Conversacional]] e [[00 - Mapa da Arquitetura]].

2026-08-09. A Fase 15 foi para producao pela metade e o follow-up de reembolso
nasceu quebrado: duas pendencias reais foram descartadas segundos depois de
criadas, e quem respondeu a pergunta recebeu de volta *"Ainda nao ajudo com esse
tipo de pergunta"*.

## O que se viu de fora

| | Sequencia 1 | Sequencia 2 |
| --- | --- | --- |
| Pendencia | `4b75abd2-…` | `06903763-…` |
| Criada | 16:21:58.908 | 16:30:18.740 |
| Descartada | 16:22:08.436 (**9,5 s**) | 16:30:52.242 (**34 s**) |
| `descartada_motivo` | `EXPIRADA` | `EXPIRADA` |
| `expira_em` | 16:51:58 | 17:00:18 |
| `mensagens_restantes` | 2 | 2 |
| Resposta ao usuario | texto de `fora_do_escopo_financeiro` | idem |

A linha do banco afirmava algo impossivel: pendencia expirada **30 minutos antes
do proprio `expira_em`**, com o orcamento de mensagens intacto.

## Causa raiz

A `whatsapp-webhook` nunca foi redeployada com a Fase 15.

```
followup-resolve    v6   → 2026-08-09T16:10:35Z   Fase 15
generate-dossier    v16  → 2026-08-09T16:10:44Z   Fase 15
whatsapp-webhook    v39  → 2026-08-08T16:58:21Z   anterior
```

O bundle publicado da v39, baixado pela Management API, carrega esta versao do
modulo compartilhado:

```js
export const CAMPOS_FOLLOWUP = ["documento_prestador", "estabelecimento"];
export function campoRespondivel(campo) {
  return typeof campo === "string" && CAMPOS_FOLLOWUP.includes(campo);
}
```

Nenhuma ocorrencia de `valor_reembolso`, `CAMPO_REEMBOLSO` ou
`extrairRespostaDeReembolso`.

### A cadeia inteira

1. o n8n (atualizado) cria a pendencia com `campo_alvo = "valor_reembolso"`;
2. a mensagem seguinte chega na `whatsapp-webhook` v39;
3. `campoRespondivel("valor_reembolso")` devolve `false`;
4. `decidirFollowup` cai no primeiro ramo e devolve `descartar`;
5. `anotarFollowupPendente` descarta a pendencia e **devolve `null`**;
6. o payload sai para o n8n com `followup: null`;
7. `Preparar Contexto` deriva `followup_contexto` e `followup_instrucao` nulos;
8. o prompt do classificador nao ganha a categoria `resposta_de_followup`;
9. `"o plano cobriu 150 reais"` vira `fora_do_escopo_financeiro`.

Reproduzido contra o Gemini real, pelo caminho do proprio export:

```
SEM anotacao (v39 real)   "o plano cobriu 150 reais"  →  fora_do_escopo_financeiro (3/3)
COM anotacao (Fase 15)    "o plano cobriu 150 reais"  →  nem chega ao classificador
                                                         valor_detectado = "150.00"
```

O `followup_instrucao` derivado por campo — a correcao feita exatamente para a
pergunta de reembolso nao colidir com a regra do valor em dinheiro — estava
correto no repositorio e no export. Ele so **nunca foi exercitado**, porque a
mensagem chegou sem anotacao.

### Por que o deploy pulou justamente essa function

`supabase/functions/whatsapp-webhook/index.ts` **nao mudou na Fase 15**. Sua
ultima alteracao e de dois dias antes. O que mudou foi o
`supabase/functions/_shared/followup.ts` que ela importa.

Um deploy guiado por "quais arquivos de function mudaram" pega
`followup-resolve` e `generate-dossier` e pula a `whatsapp-webhook` — e vai
continuar pulando enquanto ninguem olhar para a fronteira do bundle. **A
dependencia compartilhada e invisivel para o diff de diretorio.**

## Por que a suite estava verde

Porque ela testa o **repositorio**, e o repositorio estava certo. Os 191 testes
passavam enquanto producao rodava outro codigo. Nao havia nada no projeto que
afirmasse qualquer coisa sobre o que estava publicado.

## As duas correcoes

### 1. `CAMPO_DESCONHECIDO` separado de `EXPIRADA`

O ramo `!campoRespondivel` reusava o rotulo `EXPIRADA`, e foi isso que mandou a
investigacao para o lugar errado. Agora ele tem nome proprio, e a
`followup-resolve` — que ja distinguia a mesma condicao com um terceiro nome,
`CAMPO_INVALIDO` — passou a gravar o mesmo rotulo.

| Motivo | Quando |
| --- | --- |
| `CAMPO_DESCONHECIDO` | pendencia criada com campo que esta versao do codigo nao conhece |
| `EXPIRADA` | `expira_em` no passado |
| `ORCAMENTO_ESGOTADO` | acabaram as mensagens toleradas |
| `SUPERSEDIDA` | despesa nova tomou a vaga (escrito no SQL da `registrar_followup_pendente`) |

`descartada_motivo` e texto livre — nao houve migration.

### 2. `tests/deploy_drift_test.ts`

Le do repositorio o fecho transitivo de `_shared` de cada Edge Function, baixa o
bundle publicado de cada uma e compara.

Como o bundle guarda codigo **transpilado**, comparar bytes nao serve. A
comparacao usa o que sobrevive a transpilacao: nomes de declaracoes de topo (o
Deno nao minifica), literais de string do codigo e literais numericos de `const`
de topo.

Limite conhecido e aceito: uma troca de operador dentro de um corpo de funcao
(`>` para `>=`) nao muda nenhum desses e passaria batido. O caso real, e a forma
de quase toda evolucao deste codigo, e acrescentar constante, funcao ou texto.

Sem credencial da Management API os dois testes de rede sao **ignorados**, nao
falham: o token vive em `~/.supabase/access-token` e nao existe na CI. Com
credencial, erro de API falha de proposito — um verde por indisponibilidade nao
diria nada sobre producao.

O detector tem teste proprio, offline, nos dois sentidos: fonte contra si mesma
nao acusa nada, e fonte contra um bundle sem os simbolos da Fase 15 acusa. Sem
esse par, um detector quebrado deixaria a suite verde — a mesma classe de falha
que o incidente expos.

> Armadilha encontrada ao escrever esse teste: simular o "bundle antigo"
> **recortando** o bloco do reembolso nao funciona. Os usos do simbolo mais
> abaixo no arquivo continuam la, a busca por substring acha o nome, e o teste
> passa por acidente. A simulacao correta remove o **token** em todas as
> posicoes.

## Achado lateral: `pluggy-item-link`

O teste de drift encontrou, sem que ninguem estivesse procurando, uma segunda
function desatualizada — publicada em 2026-07-25, com uma copia de
`_shared/pluggy_api.ts` anterior a `bd8c950` (2026-07-26). Faltam ali
`pluggyGetUrl`, `proximaPagina`, `fetchTransactionsByIds`, `pluggyFetch`,
`normalizarTransacao` e `PAGINAS_MAX`.

Hoje e inofensivo: `pluggy-item-link` so importa `fetchItem`, e essa funcao e
identica nas duas pontas. Mas e sorte, nao desenho — `fetchItem` chama
`pluggyGet`, e uma mudanca ali passaria a divergir em silencio.

A comparacao e por **modulo**, e nao por simbolo usado, de proposito: rastrear
uso intra-modulo reintroduziria exatamente o ponto cego que causou o incidente.

## Estado no fim desta sessao

O teste de drift esta **vermelho de proposito** e lista tres functions:

```
supabase functions deploy whatsapp-webhook
supabase functions deploy followup-resolve
supabase functions deploy pluggy-item-link
```

- `whatsapp-webhook` — o incidente;
- `followup-resolve` — o rotulo `CAMPO_DESCONHECIDO` novo;
- `pluggy-item-link` — o achado lateral acima.

Cinco functions foram reportadas em dia na mesma execucao, o que exercita o
caminho verde contra bundles reais.
