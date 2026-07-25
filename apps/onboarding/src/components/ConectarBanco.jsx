import { useEffect, useState } from 'react'
import { PluggyConnect } from 'react-pluggy-connect'
import Screen from './Screen.jsx'
import { fetchPluggyConnectToken, linkPluggyItem } from '../lib/supabaseClient.js'

// Tela de ?modo=conectar-banco.
//
// Diferente do OnboardingFlow, aqui nao ha formulario: quem chega neste modo ja
// tem cadastro concluido (a pluggy-connect-token recusa com 403 quem nao tem),
// entao a pagina vai direto para o widget do Pluggy.
export default function ConectarBanco({ token }) {
  // 'loading' | 'invalid-token' | 'sem-cadastro' | 'widget' | 'vinculando' | 'success' | 'error'
  const [state, setState] = useState(token ? 'loading' : 'invalid-token')
  const [connectToken, setConnectToken] = useState(null)
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    if (!token) return

    let cancelled = false
    fetchPluggyConnectToken(token)
      .then((accessToken) => {
        if (cancelled) return
        setConnectToken(accessToken)
        setState('widget')
      })
      .catch((error) => {
        if (cancelled) return
        if (error.status === 401) {
          setState('invalid-token')
          return
        }
        if (error.status === 403) {
          setState('sem-cadastro')
          return
        }
        setErrorMessage(error.message)
        setState('error')
      })

    return () => {
      cancelled = true
    }
  }, [token])

  async function handleSuccess(itemData) {
    setState('vinculando')
    try {
      await linkPluggyItem({ token, itemId: itemData.item.id })
      setState('success')
    } catch (error) {
      setErrorMessage(error.message)
      setState('error')
    }
  }

  if (state === 'loading') {
    return (
      <Screen>
        <div className="flex flex-col items-center gap-4 py-6 text-center">
          <Spinner />
          <p className="text-white/80">Preparando a conexão segura...</p>
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
            Esse link de conexão bancária não é mais válido. Volte ao WhatsApp e envie
            "conectar banco" para o TaxMind — vamos gerar um novo link para você.
          </p>
        </div>
      </Screen>
    )
  }

  if (state === 'sem-cadastro') {
    return (
      <Screen>
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <div className="text-3xl">📝</div>
          <h1 className="text-lg font-semibold text-white">Falta concluir seu cadastro</h1>
          <p className="text-white/70 text-sm">
            Antes de conectar uma conta bancária, precisamos confirmar seu e-mail e CPF.
            Volte ao WhatsApp e envie "Oi" para o TaxMind para receber o link de cadastro.
          </p>
        </div>
      </Screen>
    )
  }

  if (state === 'vinculando') {
    return (
      <Screen>
        <div className="flex flex-col items-center gap-4 py-6 text-center">
          <Spinner />
          <p className="text-white/80">Vinculando sua conta...</p>
        </div>
      </Screen>
    )
  }

  if (state === 'success') {
    return (
      <Screen>
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <div className="text-3xl">✅</div>
          <h1 className="text-lg font-semibold text-white">Conta conectada!</h1>
          <p className="text-white/70 text-sm">
            Suas transações serão importadas automaticamente.
          </p>
          <p className="text-white/50 text-xs">
            Pode fechar esta página e voltar para o WhatsApp — é lá que a conversa continua.
          </p>
        </div>
      </Screen>
    )
  }

  if (state === 'error') {
    return (
      <Screen>
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <div className="text-3xl">❌</div>
          <h1 className="text-lg font-semibold text-white">Não deu certo</h1>
          <p className="text-white/70 text-sm">{errorMessage}</p>
          <p className="text-white/50 text-xs">
            Volte ao WhatsApp e envie "conectar banco" para tentar de novo.
          </p>
        </div>
      </Screen>
    )
  }

  return (
    <Screen>
      <div className="flex flex-col gap-3 py-2 text-center">
        <h1 className="text-lg font-semibold text-white">Conecte sua conta bancária</h1>
        <p className="text-white/60 text-sm">
          Escolha seu banco na janela do Open Finance. Suas credenciais são informadas
          direto na instituição — o TaxMind nunca vê sua senha.
        </p>
      </div>

      {/*
        includeSandbox fica true enquanto a Fase 10 roda no sandbox do Pluggy:
        e o que faz o conector "Pluggy Bank" de teste aparecer na lista. Precisa
        virar false (ou sair) antes de ir para producao com banco real.
      */}
      <PluggyConnect
        connectToken={connectToken}
        includeSandbox={true}
        language="pt"
        onSuccess={handleSuccess}
        onError={(error) => {
          setErrorMessage(error?.message || 'A conexão com o banco falhou.')
          setState('error')
        }}
      />
    </Screen>
  )
}

function Spinner() {
  return (
    <div className="h-8 w-8 rounded-full border-2 border-white/20 border-t-emerald-500 animate-spin" />
  )
}
