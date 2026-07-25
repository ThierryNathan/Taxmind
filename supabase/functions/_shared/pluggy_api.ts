// Cliente REST minimo da API do Pluggy.
//
// Por que nao o pluggy-sdk aqui: a pluggy-webhook precisa responder 2XX em
// menos de 5s (requisito do Pluggy) e o SDK arrasta got + jsonwebtoken, cujo
// custo de boot cai justamente no caminho critico. Estes dois endpoints REST
// resolvem o que o webhook precisa com fetch nativo e zero dependencia. A
// pluggy-connect-token, que nao tem SLA de latencia, usa o SDK oficial.
//
// A pluggy-item-link compartilha este cliente porque so faz um GET /items/{id}.

const PLUGGY_API_BASE = "https://api.pluggy.ai";

const env = (name: string, fallback = "") => Deno.env.get(name) ?? fallback;

export type PluggyItem = {
  id: string;
  clientUserId: string | null;
  status: string;
  executionStatus?: string;
  connector?: { id?: number; name?: string };
  lastUpdatedAt?: string | null;
  error?: { code?: string; message?: string } | null;
};

export type PluggyAccount = {
  id: string;
  itemId: string;
  type: string;
  subtype?: string;
  name?: string;
  currencyCode?: string;
};

export type PluggyTransaction = {
  id: string;
  accountId: string;
  date: string;
  description: string;
  descriptionRaw?: string | null;
  type: "DEBIT" | "CREDIT";
  amount: number;
  currencyCode?: string;
  category?: string | null;
  status?: string;
  merchant?: { name?: string; businessName?: string; cnpj?: string } | null;
};

// A apiKey do Pluggy vale ~2h. Guardar em escopo de modulo evita um POST /auth
// por requisicao enquanto a instancia da function estiver quente; o TTL curto
// (100 min) deixa margem para nao usar chave prestes a expirar.
let cachedApiKey: { value: string; expiresAt: number } | null = null;
const API_KEY_TTL_MS = 100 * 60 * 1000;

export async function getPluggyApiKey(): Promise<string> {
  if (cachedApiKey && cachedApiKey.expiresAt > Date.now()) {
    return cachedApiKey.value;
  }

  const clientId = env("PLUGGY_CLIENT_ID");
  const clientSecret = env("PLUGGY_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("missing_pluggy_credentials");
  }

  const response = await fetch(`${PLUGGY_API_BASE}/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret }),
  });

  if (!response.ok) {
    console.error("pluggy auth failed", response.status, await safeText(response));
    throw new Error("pluggy_auth_failed");
  }

  const data = await response.json() as { apiKey?: string };
  if (!data.apiKey) {
    throw new Error("pluggy_auth_failed");
  }

  cachedApiKey = { value: data.apiKey, expiresAt: Date.now() + API_KEY_TTL_MS };
  return data.apiKey;
}

async function pluggyGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const apiKey = await getPluggyApiKey();
  const url = new URL(`${PLUGGY_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  const response = await fetch(url, { headers: { "X-API-KEY": apiKey } });
  if (!response.ok) {
    console.error("pluggy request failed", path, response.status, await safeText(response));
    throw new Error(`pluggy_request_failed_${response.status}`);
  }

  return await response.json() as T;
}

export function fetchItem(itemId: string): Promise<PluggyItem> {
  return pluggyGet<PluggyItem>(`/items/${itemId}`);
}

export async function fetchAccounts(itemId: string): Promise<PluggyAccount[]> {
  const data = await pluggyGet<{ results?: PluggyAccount[] }>("/accounts", { itemId });
  return data.results ?? [];
}

// Pagina ate o fim: /transactions e paginado e o default do Pluggy corta em
// 20 itens. Uma sincronizacao inicial de 30 dias passa disso com folga, e
// transacao perdida aqui nao reaparece — o proximo webhook usa `from` mais
// recente e pula a janela antiga.
export async function fetchTransactions(
  accountId: string,
  from?: string,
  to?: string,
): Promise<PluggyTransaction[]> {
  const pageSize = 500;
  const transactions: PluggyTransaction[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const data = await pluggyGet<{ results?: PluggyTransaction[]; totalPages?: number }>(
      "/transactions",
      {
        accountId,
        from: from ?? "",
        to: to ?? "",
        page: String(page),
        pageSize: String(pageSize),
      },
    );
    transactions.push(...(data.results ?? []));
    totalPages = data.totalPages ?? 1;
    page += 1;
  } while (page <= totalPages && page <= 20);

  return transactions;
}

async function safeText(response: Response) {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<sem corpo>";
  }
}
