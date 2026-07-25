export default function Screen({ children }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <span className="inline-block text-2xl font-semibold text-white">TaxMind</span>
        </div>
        <div className="bg-[#111b21] border border-white/10 rounded-2xl shadow-xl p-6">
          {children}
        </div>
        <p className="text-center text-xs text-white/40 mt-4">
          Seus dados são protegidos e usados apenas para identificar seu cadastro fiscal.
        </p>
      </div>
    </div>
  )
}
