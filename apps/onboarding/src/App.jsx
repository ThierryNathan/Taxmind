import OnboardingFlow from './components/OnboardingFlow.jsx'
import Reverificacao from './components/Reverificacao.jsx'
import ConectarBanco from './components/ConectarBanco.jsx'

export default function App() {
  const params = new URLSearchParams(window.location.search)
  const token = params.get('token')
  const modo = params.get('modo')

  if (modo === 'reverificacao') {
    return <Reverificacao />
  }

  // Link gerado pela Edge Function pluggy-connect-link, a partir do branch
  // conectar_banco do workflow consulta-e-dossie. Mesmo token HMAC do
  // onboarding, tela diferente.
  if (modo === 'conectar-banco') {
    return <ConectarBanco token={token} />
  }

  return <OnboardingFlow token={token} />
}
