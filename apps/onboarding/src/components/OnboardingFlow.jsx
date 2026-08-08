import { useEffect, useState } from 'react'
import Screen from './Screen.jsx'
import { probeBootstrapToken, submitOnboardingProfile } from '../lib/supabaseClient.js'
import { isValidCpf, maskCpf, normalizeCpf } from '../lib/cpf.js'
import { CONSENTIMENTO_ATUAL } from '../lib/consentimento.js'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function OnboardingFlow({ token }) {
  // 'loading' | 'invalid-token' | 'form' | 'consentimento' | 'submitting' | 'success' | 'submit-error'
  const [state, setState] = useState(token ? 'loading' : 'invalid-token')
  const [errorMessage, setErrorMessage] = useState('')
  const [fields, setFields] = useState({ nome: '', email: '', cpf: '' })
  const [fieldErrors, setFieldErrors] = useState({})
  // Nasce false e nunca e pre-marcado: consentimento pre-marcado nao e
  // consentimento. O estado vive aqui, e nao no submit, para sobreviver ao
  // "voltar" da tela de consentimento sem perder o que ja foi lido.
  const [consentimentoAceito, setConsentimentoAceito] = useState(false)

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

  // O formulario nao conclui mais o cadastro: ele leva ao consentimento, que e
  // o ultimo passo. Bloquear aqui e aceitavel porque acontece uma vez so, no
  // cadastro, junto do que ja e obrigatorio (nome, e-mail, CPF).
  function handleAvancarParaConsentimento(event) {
    event.preventDefault()
    if (!validateFields()) return
    setState('consentimento')
  }

  async function handleConfirmar() {
    if (!consentimentoAceito) return

    setState('submitting')
    try {
      await submitOnboardingProfile({
        token,
        nome: fields.nome.trim(),
        email: fields.email.trim(),
        cpf: normalizeCpf(fields.cpf),
        consentimentoVersao: CONSENTIMENTO_ATUAL.versao,
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

  if (state === 'consentimento') {
    return (
      <Screen>
        <div className="flex flex-col gap-4">
          <div>
            <h1 className="text-lg font-semibold text-white mb-1">{CONSENTIMENTO_ATUAL.titulo}</h1>
            <p className="text-white/60 text-sm">{CONSENTIMENTO_ATUAL.intro}</p>
          </div>

          <div className="flex flex-col gap-3 max-h-[45vh] overflow-y-auto pr-1">
            {CONSENTIMENTO_ATUAL.itens.map((item) => (
              <div key={item.titulo} className="rounded-lg bg-[#0b141a] border border-white/10 p-3">
                <p className="text-sm font-medium text-emerald-400 mb-1">{item.titulo}</p>
                <p className="text-white/70 text-xs leading-relaxed">{item.texto}</p>
              </div>
            ))}
          </div>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={consentimentoAceito}
              onChange={(event) => setConsentimentoAceito(event.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-emerald-600"
            />
            <span className="text-white/80 text-xs leading-relaxed">
              {CONSENTIMENTO_ATUAL.rotuloCheckbox}
            </span>
          </label>

          <p className="text-white/40 text-xs">{CONSENTIMENTO_ATUAL.rodape}</p>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setState('form')}
              className="w-1/3 rounded-lg border border-white/15 text-white/80 hover:bg-white/5 font-medium py-2.5 transition-colors"
            >
              Voltar
            </button>
            <button
              type="button"
              onClick={handleConfirmar}
              disabled={!consentimentoAceito}
              className="flex-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-900 disabled:text-white/40 disabled:cursor-not-allowed text-white font-medium py-2.5 transition-colors"
            >
              Concordo e concluir cadastro
            </button>
          </div>
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
            onClick={() => setState('consentimento')}
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
      <form onSubmit={handleAvancarParaConsentimento} className="flex flex-col gap-4" noValidate>
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
          Continuar
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
