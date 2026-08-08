import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY precisam estar configuradas no .env')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false },
})

// Sonda o token sem enviar dados reais: a bootstrap-identity valida o token
// (401 = invalido/expirado) antes de checar o formato de email/cpf (400 =
// token ok, campos vazios). Isso permite validar o token na tela de loading
// sem duplicar a logica de verificacao que ja existe na Edge Function.
export async function probeBootstrapToken(token) {
  const { error } = await supabase.functions.invoke('bootstrap-identity', {
    body: { token, email: '', cpf: '' },
  })

  if (!error) return { valid: true }

  // supabase-js expõe a Response crua do fetch em error.context para FunctionsHttpError.
  const status = error.context?.status
  if (status === 401) return { valid: false }

  // Qualquer outro status (ex: 400 invalid_identity_fields) significa que o
  // token passou na verificacao e o form pode ser exibido.
  return { valid: true }
}

// Fase 10 — Open Finance.
//
// Aqui nao existe o passo de "sondar o token" separado: a propria
// pluggy-connect-token so devolve o Connect Token do Pluggy depois de validar
// o token HMAC e confirmar que o telefone tem cadastro concluido. Uma chamada
// resolve as duas coisas, e cada codigo de erro tem um significado proprio:
//   401 -> token invalido ou expirado
//   403 -> token valido, mas o cadastro ainda nao foi concluido
export async function fetchPluggyConnectToken(token) {
  const { data, error } = await supabase.functions.invoke('pluggy-connect-token', {
    body: { token },
  })

  if (error) {
    const status = error.context?.status
    const falha = new Error(
      status === 403
        ? 'Seu cadastro ainda não foi concluído.'
        : 'Não foi possível iniciar a conexão bancária agora.',
    )
    falha.status = status
    throw falha
  }

  if (!data?.accessToken) {
    throw new Error('Não foi possível iniciar a conexão bancária agora.')
  }

  return data.accessToken
}

// Grava o vinculo item do Pluggy -> usuario. Sem isso, o webhook do Pluggy
// recebe as transacoes e nao sabe de quem elas sao.
export async function linkPluggyItem({ token, itemId }) {
  const { data, error } = await supabase.functions.invoke('pluggy-item-link', {
    body: { token, item_id: itemId },
  })

  if (error || !data?.ok) {
    const falha = new Error('Conta conectada, mas o vínculo com sua conta TaxMind falhou.')
    falha.status = error?.context?.status
    throw falha
  }

  return data
}

export async function submitOnboardingProfile({ token, nome, email, cpf, consentimentoVersao }) {
  const { data, error } = await supabase.functions.invoke('bootstrap-identity', {
    body: {
      token,
      nome,
      email,
      cpf,
      // O consentimento e validado de novo no servidor: o checkbox e a
      // interface do gate, nao o gate.
      consentimento_aceito: true,
      consentimento_versao: consentimentoVersao,
    },
  })

  if (error) {
    const status = error.context?.status
    const codigo = await lerCodigoDeErro(error)

    // Versao recusada = este bundle esta velho em relacao ao texto publicado.
    // Recarregar e a unica saida, e insistir no botao nao resolveria.
    const message = status === 401
      ? 'Seu link expirou. Volte ao WhatsApp e envie "Oi" novamente para gerar um novo link.'
      : codigo === 'consentimento_versao_invalida'
        ? 'O texto de consentimento foi atualizado. Recarregue esta página para ler a versão atual.'
        : 'Não foi possível concluir seu cadastro agora. Tente novamente.'
    throw new Error(message)
  }

  if (!data?.ok) {
    throw new Error('Não foi possível concluir seu cadastro agora. Tente novamente.')
  }

  return data
}

// O supabase-js entrega a Response crua em error.context e nao consome o corpo,
// entao da para distinguir os 400 da Edge Function. Envolvido em try/catch
// porque um corpo vazio ou nao-JSON aqui nao pode virar erro de tela.
async function lerCodigoDeErro(error) {
  try {
    const corpo = await error.context?.clone?.().json?.()
    return corpo?.error ?? null
  } catch {
    return null
  }
}
