# 04 - Re-verificacao por E-mail (Resend)

Relacionado a [[00 - Mapa da Arquitetura]] e [[02 - Arquitetura de Confianca e LGPD]].

Fase 7. Um numero de WhatsApp cadastrado nao prova para sempre que a pessoa
atras dele continua sendo a mesma: chip clonado, aparelho vendido, numero
reciclado pela operadora. A partir desta fase, passados **30 dias** desde a
ultima verificacao bem-sucedida, a proxima mensagem do usuario nao segue para o
n8n antes de ele digitar um codigo de 6 digitos enviado ao e-mail cadastrado.

## Dois canais de e-mail, papeis diferentes

Isto e a fonte de confusao mais provavel nesta fase, entao fica registrado:

| | SMTP customizado no dashboard | `RESEND_API_KEY` na Edge Function |
| --- | --- | --- |
| Quem envia | Supabase Auth (GoTrue) | `whatsapp-webhook`, via `POST https://api.resend.com/emails` |
| Quais e-mails | Magic link e templates do proprio Auth (onboarding) | Codigo de re-verificacao |
| Por que existe | Sair do remetente compartilhado do Supabase, que tem limite de ~2 e-mails/hora e nao serve para producao | O codigo validado e nosso, guardado em `codigos_verificacao` |

Nao da para trocar um pelo outro. `supabase.auth.admin.generateLink` — o padrao
que a `bootstrap-identity` usa — **nao despacha e-mail**: ele devolve
`action_link` e `email_otp` para quem chama enviar. E o `email_otp` do Auth so
se valida via `verifyOtp`, que cria sessao autenticada: semantica de login, nao
de "confirme que ainda e voce neste WhatsApp".

## 1. Conta Resend: o que voce precisa de la

1. Criar conta em [resend.com](https://resend.com) (o plano gratuito cobre
   3.000 e-mails/mes, suficiente para o MVP).
2. **Dominio verificado** em *Domains -> Add Domain*. O Resend gera os
   registros DNS; publique todos no seu provedor de DNS:
   - `TXT` de SPF (`send.seu-dominio.com.br`);
   - `TXT` de DKIM (`resend._domainkey`);
   - `TXT` de DMARC (opcional no Resend, mas o Gmail cobra na pratica: sem
     DMARC o codigo vai para spam com frequencia alta).
   Verificacao leva de minutos a algumas horas. **Nao use o dominio
   `onboarding@resend.dev` de teste** para o codigo de verificacao: ele so
   entrega para o e-mail dono da conta Resend.
3. **API key** em *API Keys -> Create API Key*:
   - permissao `Sending access` (nao precisa de full access);
   - restrita ao dominio verificado;
   - o valor (`re_...`) aparece **uma unica vez** — copie na hora.
4. **Credenciais de SMTP** para o passo 2 (*Settings -> SMTP* no painel do
   Resend). Sao estes os valores:
   - Host: `smtp.resend.com`
   - Porta: `465` (TLS implicito) ou `587` (STARTTLS). O Supabase aceita as
     duas; use `465`.
   - Usuario: `resend` (literal, nao e o seu e-mail)
   - Senha: a **mesma API key** do passo 3
   - Remetente: um endereco no dominio verificado, ex.
     `nao-responda@seu-dominio.com.br`

## 2. SMTP customizado no Supabase (Authentication -> Emails -> SMTP Settings)

Dashboard do projeto -> **Authentication** -> **Emails** -> aba **SMTP
Settings** -> ativar *Enable Custom SMTP*:

| Campo | Valor |
| --- | --- |
| Sender email | `nao-responda@seu-dominio.com.br` (dominio verificado no Resend) |
| Sender name | `TaxMind` |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | a API key do Resend (`re_...`) |
| Minimum interval between emails | manter o default |

Salvar e usar o **Send test email** da propria tela. Se o teste falhar:

- `535 Authentication failed` -> username nao e `resend`, ou a API key foi
  colada com espaco/quebra de linha.
- `403 domain is not verified` -> DNS do passo 1.2 ainda nao propagou.
- Chega na caixa de spam -> falta DMARC.

Depois de ativar, os limites de rate do Supabase mudam de lugar: veja
*Authentication -> Rate Limits* e suba o limite de e-mails por hora, que
continua valendo mesmo com SMTP proprio.

## 3. Secrets da Edge Function

O SMTP acima nao alcanca a `whatsapp-webhook` — ela chama a API do Resend
direto. Configure os secrets do projeto (nao commitar valores; `.env.example`
tem as entradas):

```bash
supabase secrets set RESEND_API_KEY=re_xxxxxxxxxxxx RESEND_FROM_EMAIL="TaxMind <verificacao@seu-dominio.com.br>"
```

Sem essas duas variaveis a function registra erro, invalida o codigo gerado e
avisa o usuario no WhatsApp em vez de deixa-lo esperando um e-mail que nunca
chega.

## 4. Como o fluxo se comporta

```
mensagem de usuario cadastrado
  -> ultima verificacao ha menos de 30 dias?  -> segue para o n8n (nada muda)
  -> venceu?
       existe codigo ativo?
         mensagem e um codigo de 6 digitos?
            correto            -> carimba verificado_em, libera a PROXIMA mensagem
            errado             -> conta tentativa (limite 3), pede de novo
            3a errada          -> bloqueia o codigo; proxima mensagem gera outro
            expirado (15 min)  -> gera e envia um novo na hora
         nao e codigo          -> relembra, sem gastar novo e-mail
       nao existe              -> gera, envia por e-mail, pede o codigo
```

Detalhes que valem lembrar antes de mexer:

- **A janela e avaliada por usuario, nao pela sessao atual.** `verificado_em`
  mora em `sessoes_whatsapp`, mas sessao expira em 24h e sessao nova nasce sem
  contexto; ler a sessao corrente transformaria a janela de 30 dias em 24
  horas. A function le o maior `verificado_em` entre as sessoes do usuario, com
  fallback em `usuarios.criado_em`.
- **A mensagem que disparou a verificacao nao e reprocessada.** Ela nao vai
  para o n8n, e a que traz o codigo tambem nao: o fluxo normal volta na
  seguinte.
- **Toda falha de infraestrutura libera a mensagem** (consulta que erra, insert
  que erra, usuario sem e-mail cadastrado). Perder recibo por indisponibilidade
  nossa e pior do que uma janela de confianca esticada — e o evento fica em
  `eventos_acesso` para o motor de risco futuro.
- **Codigo em claro nunca toca o banco nem o log.** `codigos_verificacao`
  guarda HMAC-SHA256 com pepper (`CPF_HASH_PEPPER`); espaco de 10^6 valores
  seria quebravel por tabela pre-computada se fosse sha256 puro.
- **Uma despesa com numero de 6 digitos nao e confundida com codigo.**
  `extrairCodigo` exige que a mensagem inteira seja o codigo; "gastei 123456 no
  mercado" nao queima tentativa.

## 5. Tabelas

- `sessoes_whatsapp.verificado_em` — ultima verificacao carimbada naquela
  sessao. Backfill da migration 006 usou `criado_em`, para nao forcar
  re-verificacao de todo mundo no deploy.
- `codigos_verificacao` — hash do codigo, `expira_em`, `tentativas`,
  `max_tentativas`, `consumido_em`, `invalidado_em`. RLS ligada **sem policy
  para `authenticated`**: so `service_role` acessa. `unique index` parcial
  garante um codigo ativo por usuario.
- `eventos_acesso` — trilha append-only. Tipos: `CODIGO_VERIFICACAO_GERADO`,
  `CODIGO_VERIFICACAO_ENVIO_FALHOU`, `VERIFICACAO_SUCESSO`,
  `VERIFICACAO_FALHA`, `VERIFICACAO_INDISPONIVEL`. Usuario le so o proprio
  historico; nao existe policy de update ou delete para quem esta sendo
  auditado.

## 6. Testes

`tests/verificacao_test.ts` cobre geracao, hash, janela de 30 dias, expiracao
de 15 minutos e a matriz de avaliacao do codigo:

```bash
deno test --allow-env tests/verificacao_test.ts
```
