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
  // Codigo hierarquico e estavel da categoria (ex.: "18020000" = Pharmacy, sob
  // "18000000" = Healthcare). O `category` acima e o rotulo de exibicao em
  // ingles; quem precisa decidir algo pela categoria deve olhar o id.
  categoryId?: string | null;
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

async function pluggyGetUrl<T>(url: URL): Promise<T> {
  const apiKey = await getPluggyApiKey();

  const response = await fetch(url, { headers: { "X-API-KEY": apiKey } });
  if (!response.ok) {
    console.error("pluggy request failed", url.pathname, response.status, await safeText(response));
    throw new Error(`pluggy_request_failed_${response.status}`);
  }

  return await response.json() as T;
}

function pluggyGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(path, PLUGGY_API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  return pluggyGetUrl<T>(url);
}

export function fetchItem(itemId: string): Promise<PluggyItem> {
  return pluggyGet<PluggyItem>(`/items/${itemId}`);
}

// Sem filtro de `type` de proposito: /accounts devolve conta corrente,
// poupanca e cartao de credito na mesma lista, e a de cartao e justamente a que
// mais rende despesa dedutivel. Confirmado no item sandbox, que responde 3
// contas (BANK/SAVINGS_ACCOUNT, BANK/CHECKING_ACCOUNT, CREDIT/CREDIT_CARD).
export async function fetchAccounts(itemId: string): Promise<PluggyAccount[]> {
  const data = await pluggyGet<{ results?: PluggyAccount[] }>("/accounts", { itemId });
  return data.results ?? [];
}

// Os eventos transactions/* identificam a conta, nao o item: buscar a lista
// inteira so para achar uma conta seria uma consulta a mais por evento.
export function fetchAccount(accountId: string): Promise<PluggyAccount> {
  return pluggyGet<PluggyAccount>(`/accounts/${accountId}`);
}

// Pagina ate o fim.
//
// GET /transactions foi desativado: a API responde 410 ENDPOINT_DEPRECATED
// (confirmado em chamada real contra o sandbox, nao inferido da doc). O
// substituto e /v2/transactions, com duas diferencas que quebram em silencio
// quem so troca o path:
//   - paginacao por cursor, nao por page/pageSize. `pageSize`, `limit`, `size`,
//     `take` e afins sao todos rejeitados com 400 "property X should not exist";
//     a pagina e fixa em 500 e nao da para reduzir.
//   - o filtro de data virou dateFrom/dateTo. Os antigos `from`/`to` tambem
//     levam 400 "property from should not exist".
//
// Envelope: { results, next }. `next` e null quando acabou e, quando ha mais
// pagina, e a query string relativa ja montada pela Pluggy
// (?accountId=...&after=...), resolvida contra a URL da pagina atual.
//
// Ressalva de teste: o item sandbox tem 25 transacoes por conta e a pagina e
// fixa em 500, entao nao ha como fazer o `next` vir preenchido ali. O caminho
// de multiplas paginas so vai ser exercitado por uma conta real com mais de
// 500 transacoes na janela — por isso ele aceita tanto query relativa quanto
// URL absoluta, em vez de assumir um dos dois formatos.
const PAGINAS_MAX = 40;

export async function fetchTransactions(
  accountId: string,
  from?: string,
  to?: string,
  createdAtFrom?: string,
): Promise<PluggyTransaction[]> {
  const transactions: PluggyTransaction[] = [];

  const primeira = new URL("/v2/transactions", PLUGGY_API_BASE);
  primeira.searchParams.set("accountId", accountId);
  if (from) primeira.searchParams.set("dateFrom", from);
  if (to) primeira.searchParams.set("dateTo", to);
  // `createdAtFrom` filtra por quando a transacao entrou na base do Pluggy, nao
  // pela data em que ela aconteceu — e o filtro certo para o evento
  // transactions/created, cujo `transactionsCreatedAtFrom` vem nessa mesma
  // dimensao. Usar `dateFrom` ali perderia compra antiga que so foi
  // disponibilizada pelo banco agora, caso comum em fatura de cartao.
  if (createdAtFrom) primeira.searchParams.set("createdAtFrom", createdAtFrom);

  let url: URL | null = primeira;
  let paginas = 0;

  while (url && paginas < PAGINAS_MAX) {
    const data = await pluggyGetUrl<{ results?: PluggyTransaction[]; next?: string | null }>(url);
    transactions.push(...(data.results ?? []));
    paginas += 1;
    url = proximaPagina(data.next, url);
  }

  // Teto de 40 paginas x 500 = 20 mil transacoes por conta. Estourar isso e
  // anormal, e transacao perdida aqui nao reaparece: a proxima sincronizacao
  // usa um `from` mais recente e pula a janela antiga.
  if (url) {
    console.warn("paginacao de transacoes interrompida no teto de paginas", { accountId, paginas });
  }

  return transactions;
}

function proximaPagina(next: string | null | undefined, atual: URL): URL | null {
  if (!next) return null;

  let proxima: URL;
  try {
    proxima = new URL(next, atual);
  } catch {
    console.warn("cursor `next` do Pluggy nao e uma URL valida; paginacao interrompida");
    return null;
  }

  // O `next` vem do corpo da resposta e a requisicao seguinte carrega o
  // X-API-KEY: aceitar outra origem aqui entregaria a chave a quem controlasse
  // a resposta. Na pratica a Pluggy devolve query string relativa e esta guarda
  // nunca dispara.
  if (proxima.origin !== new URL(PLUGGY_API_BASE).origin) {
    console.warn("cursor `next` aponta para origem inesperada; paginacao interrompida", {
      origem: proxima.origin,
    });
    return null;
  }

  return proxima;
}

// O evento transactions/updated manda `transactionIds`, e nao ha filtro por
// lista de ids em /v2/transactions (`?ids=` responde 400 exigindo accountId).
// Sobra o GET unitario — e aqui vale a distincao que o `410` da colecao
// esconde: `GET /transactions` (lista) esta desativado, mas
// `GET /transactions/{id}` continua respondendo 200 com o objeto completo.
// Verificado contra a API real, nao inferido da doc.
//
// Uma requisicao por id e aceitavel porque o evento e granular: chega com os
// ids que mudaram naquela conta, tipicamente poucos. O teto existe para o caso
// patologico de uma reconciliacao em massa.
const IDS_MAX = 200;

export async function fetchTransactionsByIds(ids: string[]): Promise<PluggyTransaction[]> {
  const unicos = [...new Set(ids.filter(Boolean))].slice(0, IDS_MAX);
  if (unicos.length < ids.length) {
    console.warn("lista de transactionIds truncada ou com repetidos", {
      recebidos: ids.length,
      buscados: unicos.length,
    });
  }

  const transactions: PluggyTransaction[] = [];
  for (const id of unicos) {
    try {
      transactions.push(await pluggyGet<PluggyTransaction>(`/transactions/${id}`));
    } catch (error) {
      // Uma transacao que sumiu (id invalido, apagada entre o evento e a
      // consulta) nao pode derrubar as outras do mesmo lote.
      console.warn("falha ao buscar transacao por id; seguindo com as demais", { id, error });
    }
  }

  return transactions;
}

async function safeText(response: Response) {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<sem corpo>";
  }
}
