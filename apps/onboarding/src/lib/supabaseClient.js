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

export async function submitOnboardingProfile({ token, nome, email, cpf }) {
  const { data, error } = await supabase.functions.invoke('bootstrap-identity', {
    body: { token, nome, email, cpf },
  })

  if (error) {
    const status = error.context?.status
    const message = status === 401
      ? 'Seu link expirou. Volte ao WhatsApp e envie "Oi" novamente para gerar um novo link.'
      : 'Não foi possível concluir seu cadastro agora. Tente novamente.'
    throw new Error(message)
  }

  if (!data?.ok) {
    throw new Error('Não foi possível concluir seu cadastro agora. Tente novamente.')
  }

  return data
}
