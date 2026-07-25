# TaxMind Onboarding

Página web de onboarding acessada via magic link enviado pelo WhatsApp. Valida o
token gerado pela Edge Function `whatsapp-webhook`, coleta nome/e-mail/CPF e
confirma o cadastro chamando a Edge Function `bootstrap-identity`.

## Rodar local

```bash
cd apps/onboarding
npm install
cp .env.example .env
```

Preencha `apps/onboarding/.env` com a URL e a **anon key** do seu projeto
Supabase (local ou remoto):

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Este `.env` é separado do `.env` da raiz de propósito: tudo com prefixo `VITE_`
é embutido no bundle público, então só valores públicos entram aqui. Segredos de
backend (`service_role`, `CPF_HASH_PEPPER`, `TAXMIND_BOOTSTRAP_SECRET`, etc.)
ficam no `.env` da raiz e nunca devem ser copiados para cá nem para a Vercel.

```bash
npm run dev
```

Para testar o fluxo completo localmente, gere uma URL com um token válido, por
exemplo `http://localhost:5173/?token=<token-assinado>`. O token é assinado pela
`whatsapp-webhook` com `TAXMIND_BOOTSTRAP_SECRET` — sem um token válido a tela
de "link inválido" é exibida.

## Deploy na Vercel

1. Importe o repositório na Vercel apontando o **Root Directory** para
   `apps/onboarding`.
2. Framework preset: Vite.
3. Configure as variáveis de ambiente no projeto Vercel:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Deploy. A URL pública resultante é o valor que deve ser configurado em
   `ONBOARDING_BASE_URL` (ver seção de configuração manual no PR/checklist).
