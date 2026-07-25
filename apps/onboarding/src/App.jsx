import OnboardingFlow from './components/OnboardingFlow.jsx'
import Reverificacao from './components/Reverificacao.jsx'

export default function App() {
  const params = new URLSearchParams(window.location.search)
  const token = params.get('token')
  const modo = params.get('modo')

  if (modo === 'reverificacao') {
    return <Reverificacao />
  }

  return <OnboardingFlow token={token} />
}
