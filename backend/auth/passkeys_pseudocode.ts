/**
 * Futuro fluxo de Passkeys/WebAuthn para TaxMind.
 *
 * Objetivo:
 * - Depois que o usuario concluir o onboarding via WhatsApp + magic link,
 *   oferecer cadastro de passkey no app/web mobile.
 * - A passkey autentica retornos futuros sem senha e reduz risco de sequestro
 *   de sessao fiscal.
 *
 * Fluxo de registro:
 * 1. Frontend chama POST /passkeys/registration-options autenticado pelo Supabase.
 * 2. Backend gera challenge WebAuthn com user.id, email e telefone confirmado.
 * 3. Frontend chama navigator.credentials.create(options).
 * 4. Backend valida attestation, grava credential_id, public_key, counter e transports.
 *
 * Fluxo de login:
 * 1. Frontend chama POST /passkeys/authentication-options com email ou wa_id.
 * 2. Backend gera challenge para credentials vinculadas ao usuario.
 * 3. Frontend chama navigator.credentials.get(options).
 * 4. Backend valida assertion com public_key e counter.
 * 5. Backend cria sessao Supabase customizada ou emite token de troca seguro.
 *
 * Bibliotecas recomendadas para producao:
 * - @simplewebauthn/server no backend Node.js.
 * - @simplewebauthn/browser no frontend.
 *
 * Tabela futura sugerida:
 * passkeys (
 *   id uuid primary key,
 *   usuario_id uuid references usuarios(id) on delete cascade,
 *   credential_id text unique not null,
 *   public_key text not null,
 *   counter bigint not null default 0,
 *   transports text[] not null default '{}',
 *   criado_em timestamptz not null default now(),
 *   ultimo_uso_em timestamptz
 * )
 */
export const PASSKEYS_PSEUDOCODE_READY = true;
