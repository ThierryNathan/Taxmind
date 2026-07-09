# 🧾 TaxMind — Protótipo

Copiloto fiscal no estilo WhatsApp. O usuário registra gastos conversando naturalmente,
a IA categoriza e identifica o que é dedutível no Imposto de Renda, e um painel mostra
a restituição estimada.

---

## ✅ Pré-requisitos

Antes de começar, você precisa ter o **Node.js** instalado (versão 20.19+ ou 22.12+).

1. Baixe em https://nodejs.org (versão **LTS**)
2. Instale (next, next, finish)
3. Confirme abrindo o terminal e digitando: `node --version`

---

## 🚀 Como rodar (passo a passo)

### 1. Abra a pasta no VS Code
Abra esta pasta `taxmind` no Visual Studio Code.

### 2. Abra o terminal
No VS Code: menu **Terminal → New Terminal** (ou `Ctrl + '`)

### 3. Instale as dependências
```bash
npm install
```
Aguarde 1-3 minutos (baixa React, Vite, Tailwind, etc).

### 4. Configure a chave da IA (gratuita)

Este projeto usa o **Google Gemini**, que é gratuito e não exige cartão de crédito.

a) Obtenha sua chave em: https://aistudio.google.com/apikey
   - Faça login com conta Google
   - Clique em "Create API key"
   - Copie a chave (começa com `AIza...`)

b) Na pasta do projeto, encontre o arquivo `.env.example`
   - Faça uma cópia dele
   - Renomeie a cópia para `.env` (sem o `.example`)
   - Abra e cole sua chave:
     ```
     VITE_GEMINI_API_KEY=AIza-sua-chave-aqui
     ```

### 5. Rode o projeto
```bash
npm run dev
```

Vai aparecer algo como `Local: http://localhost:5173/`
Abra esse endereço no navegador. Pronto! 🎉

---

## 📱 Como usar

1. Na primeira tela, informe nome e perfil fiscal
2. No chat, digite gastos naturalmente. Exemplos:
   - "paguei 380 no dentista hoje"
   - "gastei 1200 na mensalidade da faculdade"
   - "comprei 450 de mercado"
3. Clique no ícone de **gráfico** (canto superior direito) para ver o painel fiscal
4. Clique no **clipe** (📎) para simular envio de extrato bancário
5. Três pontinhos → "Resetar dados" para limpar tudo e recomeçar

---

## ⚠️ Notas importantes

- **Limite gratuito:** 250 mensagens por dia no Gemini. Mais que suficiente para testar.
- **Dados:** ficam salvos apenas no navegador (localStorage). Não vão para servidor nenhum,
  exceto as mensagens de chat que são enviadas à IA do Google para gerar resposta.
- **Use dados fictícios:** no tier gratuito, o Google pode usar conversas para treino.
  Não coloque CPFs, valores ou extratos reais de pessoas reais.
- A chave no arquivo `.env` é só para desenvolvimento local. Para colocar no ar (produção),
  ela precisa ficar protegida num backend.

---

## 🛠️ Tecnologias

- **React 18** + **Vite** (interface)
- **Tailwind CSS v4** (estilo)
- **lucide-react** (ícones)
- **Google Gemini 2.5 Flash** (IA)

---

## ❓ Problemas comuns

| Erro | Solução |
|------|---------|
| `command not found: npm` | Node.js não instalado corretamente, reinstale |
| Vite pede versão mais nova do Node | Atualize o Node.js para a versão LTS |
| Tela branca | Abra o console do navegador (F12) e veja o erro |
| "chave da IA não está configurada" | Verifique se criou o arquivo `.env` corretamente |
| Erro 400/403 da IA | Chave errada, confira o `.env` e reinicie (`npm run dev`) |
| Erro 429 da IA | Atingiu o limite por minuto, espere 1 minuto |

---

Feito com TaxMind 💚
