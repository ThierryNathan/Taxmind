import Screen from './Screen.jsx'

// Fase 7 (futuro): fluxo de re-verificação com código de 6 dígitos enviado
// por WhatsApp, para confirmar identidade em acessos sensíveis. Placeholder
// por enquanto para não retrabalhar a estrutura de rotas por query param.
export default function Reverificacao() {
  return (
    <Screen>
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <div className="text-3xl">🚧</div>
        <h1 className="text-lg font-semibold text-white">Em breve</h1>
        <p className="text-white/70 text-sm">
          A re-verificação por código ainda não está disponível. Volte ao WhatsApp
          para continuar.
        </p>
      </div>
    </Screen>
  )
}
