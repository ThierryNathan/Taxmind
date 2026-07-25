import { useEffect, useState } from 'react'
import Screen from './Screen.jsx'
import { probeBootstrapToken, submitOnboardingProfile } from '../lib/supabaseClient.js'
import { isValidCpf, maskCpf, normalizeCpf } from '../lib/cpf.js'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function OnboardingFlow({ token }) {
  // 'loading' | 'invalid-token' | 'form' | 'submitting' | 'success' | 'submit-error'
  const [state, setState] = useState(token ? 'loading' : 'invalid-token')
  const [errorMessage, setErrorMessage] = useState('')
  const [fields, setFields] = useState({ nome: '', email: '', cpf: '' })
  const [fieldErrors, setFieldErrors] = useState({})

  useEffect(() => {
    if (!token) return

    let cancelled = false
    probeBootstrapToken(token).then(({ valid }) => {
      if (cancelled) return
      setState(valid ? 'form' : 'invalid-token')
    })

    return () => {
      cancelled = true
    }
  }, [token])

  function updateField(name, value) {
    setFields((prev) => ({ ...prev, [name]: value }))
  }

  function validateFields() {
    const errors = {}
    if (!fields.nome.trim()) errors.nome = 'Informe seu nome completo.'
    if (!EMAIL_REGEX.test(fields.email.trim())) errors.email = 'Informe um e-mail válido.'
    if (!isValidCpf(fields.cpf)) errors.cpf = 'Informe um CPF válido.'
    setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (!validateFields()) return

    setState('submitting')
    try {
      await submitOnboardingProfile({
        token,
        nome: fields.nome.trim(),
        email: fields.email.trim(),
        cpf: normalizeCpf(fields.cpf),
      })
      setState('success')
    } catch (error) {
      setErrorMessage(error.message)
      setState('submit-error')
    }
  }

  if (state === 'loading') {
    return (
      <Screen>
        <div className="flex flex-col items-center gap-4 py-6 text-center">
          <Spinner />
          <p className="text-white/80">Validando seu link...</p>
        </div>
      </Screen>
    )
  }

  if (state === 'invalid-token') {
    return (
      <Screen>
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <div className="text-3xl">⚠️</div>
          <h1 className="text-lg font-semibold text-white">Link inválido ou expirado</h1>
          <p className="text-white/70 text-sm">
            Esse link de cadastro não é mais válido. Volte ao WhatsApp e envie "Oi"
            para o TaxMind novamente — vamos gerar um novo link para você.
          </p>
        </div>
      </Screen>
    )
  }

  if (state === 'submitting') {
    return (
      <Screen>
        <div className="flex flex-col items-center gap-4 py-6 text-center">
          <Spinner />
          <p className="text-white/80">Salvando seu cadastro...</p>
        </div>
      </Screen>
    )
  }

  if (state === 'success') {
    return (
      <Screen>
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <div className="text-3xl">✅</div>
          <h1 className="text-lg font-semibold text-white">Cadastro concluído!</h1>
          <p className="text-white/70 text-sm">
            Pode fechar esta página e voltar para o WhatsApp — é lá que a conversa continua.
          </p>

          {/*
            Fase 11 (futuro): botão "Ativar acesso por biometria" chamando
            registerPasskey do Supabase Auth para vincular uma passkey a este
            usuário logo após a conclusão do onboarding. Ver
            backend/auth/passkeys_pseudocode.ts para o fluxo completo.
          */}

          {/*
            Fase 10 (futuro): widget PluggyConnect (pacote react-pluggy-connect)
            para o usuário conectar uma conta bancária via Open Finance,
            oferecido como passo opcional nesta mesma tela de sucesso.
          */}
        </div>
      </Screen>
    )
  }

  if (state === 'submit-error') {
    return (
      <Screen>
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <div className="text-3xl">❌</div>
          <h1 className="text-lg font-semibold text-white">Não deu certo</h1>
          <p className="text-white/70 text-sm">{errorMessage}</p>
          <button
            type="button"
            onClick={() => setState('form')}
            className="mt-2 w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-2.5 transition-colors"
          >
            Tentar novamente
          </button>
        </div>
      </Screen>
    )
  }

  return (
    <Screen>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        <div>
          <h1 className="text-lg font-semibold text-white mb-1">Confirme seu cadastro</h1>
          <p className="text-white/60 text-sm">
            Precisamos de mais alguns dados para proteger suas informações fiscais.
          </p>
        </div>

        <Field label="Nome completo" error={fieldErrors.nome}>
          <input
            type="text"
            autoComplete="name"
            value={fields.nome}
            onChange={(event) => updateField('nome', event.target.value)}
            className="w-full rounded-lg bg-[#0b141a] border border-white/15 focus:border-emerald-500 outline-none px-3 py-2.5 text-white"
            placeholder="Seu nome completo"
          />
        </Field>

        <Field label="E-mail" error={fieldErrors.email}>
          <input
            type="email"
            autoComplete="email"
            value={fields.email}
            onChange={(event) => updateField('email', event.target.value)}
            className="w-full rounded-lg bg-[#0b141a] border border-white/15 focus:border-emerald-500 outline-none px-3 py-2.5 text-white"
            placeholder="voce@exemplo.com"
          />
          <p className="text-white/50 text-xs mt-1.5">
            Usamos seu e-mail apenas para segurança e recuperação de acesso à sua conta —
            o WhatsApp continua sendo o principal canal do TaxMind.
          </p>
        </Field>

        <Field label="CPF" error={fieldErrors.cpf}>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={maskCpf(fields.cpf)}
            onChange={(event) => updateField('cpf', event.target.value)}
            className="w-full rounded-lg bg-[#0b141a] border border-white/15 focus:border-emerald-500 outline-none px-3 py-2.5 text-white"
            placeholder="000.000.000-00"
            maxLength={14}
          />
        </Field>

        <button
          type="submit"
          className="mt-2 w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-2.5 transition-colors"
        >
          Confirmar cadastro
        </button>
      </form>
    </Screen>
  )
}

function Field({ label, error, children }) {
  return (
    <label className="block">
      <span className="block text-sm text-white/80 mb-1">{label}</span>
      {children}
      {error ? <p className="text-red-400 text-xs mt-1.5">{error}</p> : null}
    </label>
  )
}

function Spinner() {
  return (
    <div className="h-8 w-8 rounded-full border-2 border-white/20 border-t-emerald-500 animate-spin" />
  )
}
