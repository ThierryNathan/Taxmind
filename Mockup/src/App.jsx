import React, { useState, useRef, useEffect } from 'react';
import { Send, Paperclip, ArrowLeft, MoreVertical, Phone, Video, Check, CheckCheck, BarChart3, X, TrendingUp, AlertCircle, FileText, Receipt, Plus, Trash2 } from 'lucide-react';

const TAXMIND_SYSTEM_PROMPT = `Você é o TaxMind, um copiloto fiscal brasileiro que funciona pelo WhatsApp. Você ajuda pequenos empresários e autônomos a organizar gastos ao longo do ano para evitar a "cegueira fiscal" na hora do Imposto de Renda.

SEU TOM:
- Informal, direto, amigável (como um contador que virou amigo no WhatsApp)
- Use emojis com moderação (💰 📊 ✅ ⚠️ 🧾)
- Respostas CURTAS (2-4 linhas idealmente). Isso é WhatsApp, não e-mail.
- Português brasileiro coloquial

SUAS CAPACIDADES:
1. **Registrar gastos**: quando o usuário mencionar um gasto (ex: "gastei 120 no Uber", "paguei 450 no dentista"), confirme o registro e categorize automaticamente.
2. **Categorizar corretamente** seguindo regras da Receita Federal:
   - Despesas médicas (dedutíveis no IR): consultas, exames, plano de saúde, dentista, psicólogo, fisioterapia
   - Educação (dedutível com limite): escola, faculdade, pós-graduação (NÃO cursos livres)
   - Previdência privada (dedutível): PGBL, contribuição INSS
   - Despesas da empresa (PJ): material de escritório, software, viagens a trabalho
   - Pessoal (não dedutível): alimentação, transporte cotidiano, lazer
   - Dependentes (dedução fixa por dependente)
3. **Alertas fiscais**: avise quando um gasto for dedutível ou precisar de comprovante (nota fiscal, recibo com CPF).
4. **Dicas rápidas**: educar sobre IR de forma prática.

FORMATO DE RESPOSTA PARA GASTOS:
Quando identificar um gasto, SEMPRE responda no formato JSON dentro de tags <expense></expense> ANTES da mensagem humana. Exemplo:
<expense>{"amount": 120, "category": "Saúde", "deductible": true, "description": "Consulta médica", "needsReceipt": true}</expense>
Anotado! 🧾 Consulta médica de R$ 120 - essa é dedutível no IR. Guarde o recibo com seu CPF!

Se NÃO for um gasto, apenas responda normalmente sem a tag.

CATEGORIAS VÁLIDAS: "Saúde", "Educação", "Previdência", "Empresa", "Alimentação", "Transporte", "Moradia", "Lazer", "Outros"

IMPORTANTE: Você não tem memória entre mensagens além do histórico que recebe. Seja útil e contextual com base no que vê.`;

const STORAGE_KEYS = {
  USER: 'taxmind_user',
  MESSAGES: 'taxmind_messages',
  EXPENSES: 'taxmind_expenses'
};

const CATEGORY_COLORS = {
  'Saúde': '#00a884',
  'Educação': '#3b82f6',
  'Previdência': '#8b5cf6',
  'Empresa': '#f59e0b',
  'Alimentação': '#ef4444',
  'Transporte': '#ec4899',
  'Moradia': '#14b8a6',
  'Lazer': '#f97316',
  'Outros': '#6b7280',
};

// Hook para persistir estado no localStorage
function usePersistentState(key, initialValue) {
  const [state, setState] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved ? JSON.parse(saved) : initialValue;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch (e) {
      console.error('Erro ao salvar no localStorage:', e);
    }
  }, [key, state]);

  return [state, setState];
}

const getInitialMessages = (userName) => ([
  {
    id: 1,
    role: 'assistant',
    text: `Oi ${userName}! 👋 Aqui é a TaxMind, seu copiloto fiscal.`,
    time: getCurrentTimeStr(),
    status: 'read'
  },
  {
    id: 2,
    role: 'assistant',
    text: 'Pode me mandar seus gastos por aqui mesmo — eu organizo tudo e te aviso o que é dedutível no IR. 📊\n\nPor exemplo, tenta digitar: *"gastei 150 no dentista hoje"*',
    time: getCurrentTimeStr(),
    status: 'read'
  }
]);

function getCurrentTimeStr() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function getCurrentDateStr() {
  const now = new Date();
  return `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export default function App() {
  const [user, setUser] = usePersistentState(STORAGE_KEYS.USER, null);

  if (!user) {
    return <OnboardingScreen onComplete={setUser} />;
  }

  return <TaxMindApp user={user} onReset={() => {
    if (confirm('Tem certeza? Isso vai apagar todos os seus dados.')) {
      localStorage.removeItem(STORAGE_KEYS.USER);
      localStorage.removeItem(STORAGE_KEYS.MESSAGES);
      localStorage.removeItem(STORAGE_KEYS.EXPENSES);
      setUser(null);
    }
  }} />;
}

function OnboardingScreen({ onComplete }) {
  const [name, setName] = useState('');
  const [profile, setProfile] = useState('');

  const canSubmit = name.trim().length >= 2 && profile;

  return (
    <div className="min-h-screen bg-[#0b141a] flex items-center justify-center p-6" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <div className="inline-flex w-20 h-20 rounded-full items-center justify-center mb-4 text-white font-bold text-2xl shadow-lg" style={{ background: 'linear-gradient(135deg, #00a884 0%, #008f72 100%)' }}>
            TM
          </div>
          <h1 className="text-white text-3xl font-bold mb-2" style={{ fontFamily: 'Georgia, serif' }}>TaxMind</h1>
          <p className="text-gray-400 text-sm">Seu copiloto fiscal no WhatsApp</p>
        </div>

        <div className="bg-[#202c33] rounded-2xl p-6 shadow-xl">
          <h2 className="text-white text-lg font-semibold mb-1">Vamos começar</h2>
          <p className="text-gray-400 text-sm mb-5">Só preciso de algumas informações rápidas</p>

          <label className="block mb-4">
            <span className="text-gray-300 text-sm block mb-1.5">Como posso te chamar?</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: Marcelo"
              className="w-full bg-[#2a3942] text-white px-4 py-3 rounded-lg outline-none focus:ring-2 focus:ring-emerald-500 text-base"
              autoFocus
            />
          </label>

          <div className="mb-6">
            <span className="text-gray-300 text-sm block mb-2">Você é...</span>
            <div className="grid grid-cols-1 gap-2">
              {[
                { id: 'mei', label: 'MEI', desc: 'Microempreendedor Individual' },
                { id: 'pj', label: 'Pequena empresa', desc: 'Simples Nacional / LTDA' },
                { id: 'autonomo', label: 'Autônomo / PF', desc: 'Sem CNPJ, faz IR como pessoa física' },
                { id: 'clt', label: 'CLT com IR', desc: 'Quero organizar dedutíveis' },
              ].map(opt => (
                <button
                  key={opt.id}
                  onClick={() => setProfile(opt.id)}
                  className={`text-left p-3 rounded-lg border-2 transition-all ${profile === opt.id ? 'border-emerald-500 bg-emerald-500/10' : 'border-transparent bg-[#2a3942] hover:bg-[#364249]'}`}
                >
                  <div className="text-white font-medium text-sm">{opt.label}</div>
                  <div className="text-gray-400 text-xs">{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={() => canSubmit && onComplete({ name: name.trim(), profile, createdAt: new Date().toISOString() })}
            disabled={!canSubmit}
            className="w-full py-3 rounded-lg font-semibold text-white transition-all disabled:opacity-40"
            style={{ backgroundColor: '#00a884' }}
          >
            Começar
          </button>

          <p className="text-gray-500 text-xs text-center mt-4">
            🔒 Seus dados ficam salvos só no seu navegador. Nada é enviado para servidores além das mensagens de chat com a IA.
          </p>
        </div>
      </div>
    </div>
  );
}

function TaxMindApp({ user, onReset }) {
  const [messages, setMessages] = usePersistentState(STORAGE_KEYS.MESSAGES, getInitialMessages(user.name));
  const [expenses, setExpenses] = usePersistentState(STORAGE_KEYS.EXPENSES, []);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  const parseExpenseFromResponse = (text) => {
    const match = text.match(/<expense>([\s\S]*?)<\/expense>/);
    if (!match) return { cleanText: text, expense: null };
    try {
      const expense = JSON.parse(match[1]);
      const cleanText = text.replace(/<expense>[\s\S]*?<\/expense>/, '').trim();
      return { cleanText, expense };
    } catch {
      return { cleanText: text.replace(/<expense>[\s\S]*?<\/expense>/, '').trim(), expense: null };
    }
  };

  const callAI = async (userMessage) => {
    // Monta histórico limitando a últimas 20 mensagens para não estourar contexto
    const recentMessages = messages.slice(-20);
    const conversationHistory = recentMessages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text }]
    }));

    conversationHistory.push({
      role: 'user',
      parts: [{ text: userMessage }]
    });

    try {
      const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
      if (!apiKey) {
        return 'Ops, a chave da IA não está configurada. Verifica o arquivo .env';
      }

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: TAXMIND_SYSTEM_PROMPT + `\n\nContexto do usuário: Nome é ${user.name}, perfil fiscal é ${user.profile}.` }] },
            contents: conversationHistory,
            generationConfig: { maxOutputTokens: 1000, temperature: 0.7 }
          })
        }
      );

      const data = await response.json();
      if (data.error) {
        console.error('Gemini error:', data.error);
        return `Ops, erro da IA: ${data.error.message}. Tenta de novo em alguns segundos.`;
      }
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      return text || 'Desculpa, tive um problema aqui. Tenta de novo? 🤔';
    } catch (err) {
      console.error(err);
      return 'Ops, não consegui processar agora. Verifica sua conexão e tenta de novo.';
    }
  };

  const sendMessage = async (textOverride = null) => {
    const text = textOverride || input.trim();
    if (!text) return;

    const userMsg = {
      id: Date.now(),
      role: 'user',
      text,
      time: getCurrentTimeStr(),
      status: 'read'
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);

    const response = await callAI(text);
    const { cleanText, expense } = parseExpenseFromResponse(response);

    setIsTyping(false);

    const assistantMsg = {
      id: Date.now() + 1,
      role: 'assistant',
      text: cleanText,
      time: getCurrentTimeStr(),
      status: 'read',
      expense
    };

    setMessages(prev => [...prev, assistantMsg]);

    if (expense) {
      setExpenses(prev => [{
        id: `e${Date.now()}`,
        amount: expense.amount,
        category: expense.category,
        deductible: expense.deductible,
        description: expense.description,
        date: getCurrentDateStr(),
        createdAt: new Date().toISOString()
      }, ...prev]);
    }
  };

  const handleFileUpload = async () => {
    setShowAttach(false);

    const fileMsg = {
      id: Date.now(),
      role: 'user',
      text: '📎 extrato_banco_abril.pdf',
      time: getCurrentTimeStr(),
      status: 'read',
      isFile: true
    };
    setMessages(prev => [...prev, fileMsg]);
    setIsTyping(true);

    await new Promise(r => setTimeout(r, 1200));

    const simulatedExtract = `Recebi um extrato bancário com as seguintes transações:
- 03/04 DROGARIA SAO PAULO R$ 87,50
- 07/04 CLINICA ODONTO LTDA R$ 380,00
- 12/04 UBER R$ 32,40
- 18/04 PAPELARIA CENTRAL R$ 145,00
- 25/04 ACADEMIA FIT R$ 180,00

Analise brevemente e diga quais são dedutíveis. Não use a tag <expense> nessa mensagem.`;

    const response = await callAI(simulatedExtract);
    const { cleanText } = parseExpenseFromResponse(response);

    setIsTyping(false);
    setMessages(prev => [...prev, {
      id: Date.now() + 1,
      role: 'assistant',
      text: cleanText,
      time: getCurrentTimeStr(),
      status: 'read'
    }]);

    const extractExpenses = [
      { amount: 87.50, category: 'Saúde', deductible: false, description: 'Drogaria' },
      { amount: 380, category: 'Saúde', deductible: true, description: 'Dentista' },
      { amount: 32.40, category: 'Transporte', deductible: false, description: 'Uber' },
      { amount: 145, category: 'Empresa', deductible: true, description: 'Papelaria' },
      { amount: 180, category: 'Lazer', deductible: false, description: 'Academia' },
    ];

    setExpenses(prev => [
      ...extractExpenses.map((e, i) => ({
        ...e,
        id: `ext${Date.now()}-${i}`,
        date: getCurrentDateStr(),
        createdAt: new Date().toISOString()
      })),
      ...prev
    ]);
  };

  const deleteExpense = (id) => {
    setExpenses(prev => prev.filter(e => e.id !== id));
  };

  const totalDeductible = expenses.filter(e => e.deductible).reduce((s, e) => s + e.amount, 0);
  const totalMonth = expenses.reduce((s, e) => s + e.amount, 0);
  const byCategory = expenses.reduce((acc, e) => {
    acc[e.category] = (acc[e.category] || 0) + e.amount;
    return acc;
  }, {});

  return (
    <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }} className="w-full min-h-screen bg-gray-900 flex items-center justify-center p-0 md:p-4">
      <div className="relative w-full md:w-[390px] h-screen md:h-[844px] md:max-h-[95vh]">
        <div className="absolute inset-0 bg-black md:rounded-[50px] shadow-2xl md:p-[12px]">
          <div className="relative w-full h-full md:rounded-[40px] overflow-hidden bg-[#0b141a] flex flex-col">

            <div className="hidden md:block absolute top-0 left-1/2 -translate-x-1/2 w-32 h-7 bg-black rounded-b-2xl z-50"></div>

            <div className="bg-[#202c33] text-white flex items-center px-3 pt-4 md:pt-10 pb-2.5 shadow-sm z-10">
              <ArrowLeft size={22} className="mr-2 text-gray-300" />
              <div className="w-10 h-10 rounded-full flex items-center justify-center mr-3 text-white font-bold text-sm" style={{ background: 'linear-gradient(135deg, #00a884 0%, #008f72 100%)' }}>
                TM
              </div>
              <div className="flex-1">
                <div className="font-semibold text-[17px] leading-tight">TaxMind</div>
                <div className="text-[13px] text-gray-400">online</div>
              </div>
              <button onClick={() => setShowDashboard(true)} className="p-2 hover:bg-white/10 rounded-full transition-colors">
                <BarChart3 size={22} className="text-gray-300" />
              </button>
              <div className="relative">
                <button onClick={() => setShowMenu(!showMenu)} className="p-2 hover:bg-white/10 rounded-full">
                  <MoreVertical size={20} className="text-gray-300" />
                </button>
                {showMenu && (
                  <div className="absolute right-0 top-full mt-1 bg-[#233138] rounded-lg shadow-xl z-30 min-w-[180px] overflow-hidden">
                    <button
                      onClick={() => { setShowMenu(false); onReset(); }}
                      className="w-full text-left px-4 py-3 text-red-400 hover:bg-white/5 text-sm flex items-center gap-2"
                    >
                      <Trash2 size={16} /> Resetar dados
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div
              className="flex-1 overflow-y-auto px-3 py-3"
              style={{
                backgroundColor: '#0b141a',
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100' viewBox='0 0 100 100'%3E%3Cg fill='%23182229' fill-opacity='0.4'%3E%3Cpath d='M50 20 L60 40 L50 30 L40 40 Z M20 50 L40 60 L30 50 L40 40 Z M80 50 L60 60 L70 50 L60 40 Z M50 80 L60 60 L50 70 L40 60 Z'/%3E%3C/g%3E%3C/svg%3E")`
              }}
            >
              <div className="flex justify-center mb-3">
                <div className="bg-[#182229] text-gray-400 text-xs px-3 py-1 rounded-lg">HOJE</div>
              </div>
              <div className="flex justify-center mb-3">
                <div className="bg-[#182229]/80 text-[#ffd279] text-[12px] px-3 py-1.5 rounded-lg max-w-[280px] text-center">
                  🔒 As mensagens são protegidas com criptografia de ponta a ponta.
                </div>
              </div>

              {messages.map((msg) => (
                <MessageBubble key={msg.id} msg={msg} />
              ))}

              {isTyping && (
                <div className="flex justify-start mb-2">
                  <div className="bg-[#202c33] rounded-lg px-4 py-3 shadow-sm">
                    <div className="flex gap-1 items-center">
                      <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
                      <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
                      <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            <div className="bg-[#0b141a] px-2 py-2 pb-4 md:pb-2 relative">
              {showAttach && (
                <div className="absolute bottom-full left-2 mb-2 bg-[#233138] rounded-2xl shadow-xl p-3 grid grid-cols-3 gap-3 z-20">
                  <AttachOption icon="📄" label="Extrato" color="#0284c7" onClick={handleFileUpload} />
                  <AttachOption icon="🧾" label="Recibo" color="#dc2626" onClick={handleFileUpload} />
                  <AttachOption icon="📸" label="Foto NF" color="#ec4899" onClick={handleFileUpload} />
                </div>
              )}
              <div className="flex items-end gap-2">
                <div className="flex-1 bg-[#2a3942] rounded-full flex items-center px-3 py-1.5 gap-2">
                  <button onClick={() => setShowAttach(!showAttach)} className="text-gray-400 hover:text-gray-200 transition-colors">
                    <Paperclip size={22} style={{ transform: 'rotate(-45deg)' }} />
                  </button>
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                    placeholder="Mensagem"
                    className="flex-1 bg-transparent text-white placeholder-gray-500 outline-none py-1.5 text-[15px]"
                  />
                </div>
                <button
                  onClick={() => sendMessage()}
                  disabled={!input.trim()}
                  className="w-11 h-11 rounded-full flex items-center justify-center transition-all disabled:opacity-60"
                  style={{ backgroundColor: '#00a884' }}
                >
                  <Send size={20} className="text-white" style={{ marginLeft: '2px' }} />
                </button>
              </div>
            </div>

            {showDashboard && (
              <Dashboard
                expenses={expenses}
                totalDeductible={totalDeductible}
                totalMonth={totalMonth}
                byCategory={byCategory}
                onClose={() => setShowDashboard(false)}
                onDelete={deleteExpense}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ msg }) {
  const isUser = msg.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-1.5`}>
      <div
        className={`max-w-[78%] rounded-lg px-2 py-1.5 shadow-sm relative ${isUser ? 'rounded-tr-none' : 'rounded-tl-none'}`}
        style={{ backgroundColor: isUser ? '#005c4b' : '#202c33', color: '#e9edef' }}
      >
        {msg.isFile && (
          <div className="bg-black/20 rounded-md p-3 mb-1 flex items-center gap-3 min-w-[200px]">
            <div className="w-10 h-10 bg-red-500/80 rounded flex items-center justify-center">
              <FileText size={20} className="text-white" />
            </div>
            <div className="flex-1 text-[13px]">
              <div className="font-medium">extrato_abril.pdf</div>
              <div className="text-gray-400 text-xs">PDF · 5 transações</div>
            </div>
          </div>
        )}
        <div className="text-[14.5px] whitespace-pre-wrap leading-[1.35] px-1">{msg.text}</div>

        {msg.expense && (
          <div className="mt-1.5 mx-1 bg-black/20 rounded-md p-2 border-l-2" style={{ borderColor: CATEGORY_COLORS[msg.expense.category] || '#6b7280' }}>
            <div className="flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-wide text-gray-400">{msg.expense.category}</div>
              {msg.expense.deductible && (
                <div className="text-[10px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded-full font-medium">✓ Dedutível</div>
              )}
            </div>
            <div className="text-base font-semibold mt-0.5">R$ {msg.expense.amount.toFixed(2).replace('.', ',')}</div>
          </div>
        )}

        <div className="flex items-center justify-end gap-1 mt-0.5 px-1">
          <span className="text-[11px] text-gray-400">{msg.time}</span>
          {isUser && (msg.status === 'read' ? <CheckCheck size={14} className="text-[#53bdeb]" /> : <Check size={14} className="text-gray-400" />)}
        </div>
      </div>
    </div>
  );
}

function AttachOption({ icon, label, color, onClick }) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-1 p-2 hover:bg-white/5 rounded-lg transition-colors">
      <div className="w-12 h-12 rounded-full flex items-center justify-center text-2xl" style={{ backgroundColor: color }}>{icon}</div>
      <span className="text-white text-[11px]">{label}</span>
    </button>
  );
}

function Dashboard({ expenses, totalDeductible, totalMonth, byCategory, onClose, onDelete }) {
  const sortedCategories = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  const potentialRefund = totalDeductible * 0.275;

  return (
    <div className="absolute inset-0 bg-[#0b141a] z-40 flex flex-col overflow-hidden">
      <div className="bg-[#202c33] text-white flex items-center px-3 pt-4 md:pt-10 pb-3 shadow">
        <button onClick={onClose} className="p-2 -ml-2 hover:bg-white/10 rounded-full">
          <ArrowLeft size={22} className="text-gray-200" />
        </button>
        <div className="flex-1 ml-2">
          <div className="font-semibold text-[17px]">Seu Painel Fiscal</div>
          <div className="text-[12px] text-gray-400">{expenses.length} {expenses.length === 1 ? 'lançamento' : 'lançamentos'}</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {expenses.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-6xl mb-4">📊</div>
            <div className="text-white text-lg font-medium mb-2">Sem gastos ainda</div>
            <div className="text-gray-400 text-sm px-8">Volte para o chat e me conte um gasto para começar. Ex: "gastei 150 no dentista"</div>
          </div>
        ) : (
          <>
            <div className="rounded-2xl p-5 mb-4 relative overflow-hidden" style={{ background: 'linear-gradient(135deg, #00a884 0%, #006d54 100%)' }}>
              <div className="absolute top-0 right-0 w-32 h-32 rounded-full bg-white/10 -mr-10 -mt-10"></div>
              <div className="relative">
                <div className="text-emerald-100 text-xs uppercase tracking-wider mb-1">Restituição estimada</div>
                <div className="text-white text-4xl font-bold" style={{ fontFamily: 'Georgia, serif' }}>
                  R$ {potentialRefund.toFixed(2).replace('.', ',')}
                </div>
                <div className="text-emerald-100 text-xs mt-2">Com base em R$ {totalDeductible.toFixed(2).replace('.', ',')} em despesas dedutíveis</div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="bg-[#202c33] rounded-xl p-3">
                <div className="text-gray-400 text-[11px] uppercase tracking-wide">Total gasto</div>
                <div className="text-white text-xl font-semibold mt-1">R$ {totalMonth.toFixed(2).replace('.', ',')}</div>
                <div className="text-gray-500 text-[11px] mt-1">{expenses.length} transações</div>
              </div>
              <div className="bg-[#202c33] rounded-xl p-3">
                <div className="text-gray-400 text-[11px] uppercase tracking-wide">Dedutíveis</div>
                <div className="text-emerald-400 text-xl font-semibold mt-1">R$ {totalDeductible.toFixed(2).replace('.', ',')}</div>
                <div className="text-gray-500 text-[11px] mt-1">{expenses.filter(e => e.deductible).length} transações</div>
              </div>
            </div>

            {totalDeductible > 0 && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 mb-4 flex gap-3">
                <AlertCircle size={20} className="text-amber-400 flex-shrink-0 mt-0.5" />
                <div className="text-[13px] text-amber-100">
                  <div className="font-semibold mb-0.5">Organize seus recibos</div>
                  <div className="text-amber-200/80 text-[12px]">Despesas médicas precisam de recibo com seu CPF para serem aceitas pela Receita.</div>
                </div>
              </div>
            )}

            <div className="mb-4">
              <div className="text-gray-400 text-[11px] uppercase tracking-widest mb-3 font-semibold">Por categoria</div>
              <div className="space-y-2.5">
                {sortedCategories.map(([cat, total]) => {
                  const pct = (total / totalMonth) * 100;
                  return (
                    <div key={cat} className="bg-[#202c33] rounded-lg p-3">
                      <div className="flex justify-between items-center mb-1.5">
                        <div className="flex items-center gap-2">
                          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: CATEGORY_COLORS[cat] }}></div>
                          <span className="text-white text-[14px] font-medium">{cat}</span>
                        </div>
                        <span className="text-white text-[14px] font-semibold">R$ {total.toFixed(2).replace('.', ',')}</span>
                      </div>
                      <div className="h-1.5 bg-black/30 rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: CATEGORY_COLORS[cat] }}></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="text-gray-400 text-[11px] uppercase tracking-widest mb-3 font-semibold">Lançamentos recentes</div>
              <div className="bg-[#202c33] rounded-xl overflow-hidden">
                {expenses.slice(0, 15).map((exp, idx) => (
                  <div key={exp.id} className={`group flex items-center gap-3 p-3 ${idx !== Math.min(14, expenses.length - 1) ? 'border-b border-white/5' : ''}`}>
                    <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm flex-shrink-0" style={{ backgroundColor: (CATEGORY_COLORS[exp.category] || '#6b7280') + '30', color: CATEGORY_COLORS[exp.category] || '#6b7280' }}>
                      <Receipt size={16} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-white text-[14px] truncate">{exp.description}</div>
                      <div className="text-gray-500 text-[11px]">{exp.category} · {exp.date}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-white text-[14px] font-semibold">R$ {exp.amount.toFixed(2).replace('.', ',')}</div>
                      {exp.deductible && <div className="text-emerald-400 text-[10px]">dedutível</div>}
                    </div>
                    <button onClick={() => onDelete(exp.id)} className="opacity-0 group-hover:opacity-100 text-red-400 hover:bg-red-500/10 p-1 rounded transition-all" title="Apagar">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="h-4"></div>
      </div>
    </div>
  );
}
