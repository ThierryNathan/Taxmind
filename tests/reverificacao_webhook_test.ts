// Teste de integracao do portao de re-verificacao (Fase 7).
//
// Rodar:  deno test --allow-env --allow-net tests/reverificacao_webhook_test.ts
//
// Sobe a whatsapp-webhook REAL (import do index.ts, que chama serve()) e
// intercepta globalThis.fetch antes do import, de modo que:
//   - o PostgREST do Supabase e servido por um mini-PostgREST em memoria aqui;
//   - graph.facebook.com, api.resend.com e os webhooks do n8n sao capturados
//     em vez de chamados.
// Assim o teste exercita o fluxo de verdade — ordem das consultas, unique de
// codigo ativo, contagem de tentativas, carimbo de verificado_em, eventos de
// acesso — e tambem prova que onboarding, roteamento por tipo de mensagem e
// validacao HMAC continuam intactos.
//
// O que este teste NAO cobre: RLS e constraints reais do Postgres (o
// mini-PostgREST so emula a unique parcial de codigo ativo, que a logica usa) e
// entrega real de e-mail. Isso depende de `supabase db push` e de conta Resend.

import { assert, assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";

/** Comparacao insensivel a acento: estas asserssoes cobram CONTEUDO da
 *  mensagem, nao ortografia. Ver o mesmo helper em tests/n8n_fase12_test.ts. */
function semAcento(valor: string): string {
  return valor.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

import { hmacSha256Hex } from "../supabase/functions/_shared/bootstrap_token.ts";
import { hashCodigoVerificacao } from "../supabase/functions/_shared/verificacao.ts";

const APP_SECRET = "segredo_de_app_meta_para_teste";
const SUPABASE_ORIGIN = "http://supabase.test";
const N8N_MIDIA = "http://n8n.test/webhook/receipt-ocr-classification";
const N8N_TEXTO = "http://n8n.test/webhook/consulta-dossie";
const FUNCTION_ORIGIN = "http://localhost:8000";

const WA_ID = "5511999990000";
const TELEFONE = "+5511999990000";
const USUARIO_ID = "11111111-1111-4111-8111-111111111111";
const SESSAO_ID = "22222222-2222-4222-8222-222222222222";

const DIA = 24 * 60 * 60 * 1000;
const MINUTO = 60 * 1000;

Deno.env.set("SUPABASE_URL", SUPABASE_ORIGIN);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service_role_de_teste");
Deno.env.set("WHATSAPP_APP_SECRET", APP_SECRET);
Deno.env.set("WHATSAPP_ACCESS_TOKEN", "token_de_teste");
Deno.env.set("WHATSAPP_PHONE_NUMBER_ID", "1234567890");
Deno.env.set("CPF_HASH_PEPPER", "pepper_de_teste_com_mais_de_32_caracteres_ok");
Deno.env.set("TAXMIND_BOOTSTRAP_SECRET", "bootstrap_de_teste_com_mais_de_32_chars");
Deno.env.set("ONBOARDING_BASE_URL", "http://localhost:5173/onboarding");
Deno.env.set("RESEND_API_KEY", "re_chave_de_teste");
Deno.env.set("RESEND_FROM_EMAIL", "TaxMind <verificacao@taxmind.test>");
Deno.env.set("N8N_WEBHOOK_URL", N8N_MIDIA);
Deno.env.set("N8N_TEXT_WEBHOOK_URL", N8N_TEXTO);

// --- mini-PostgREST em memoria -------------------------------------------

type Linha = Record<string, any>;
const db: Record<string, Linha[]> = {
  usuarios: [],
  sessoes_whatsapp: [],
  codigos_verificacao: [],
  eventos_acesso: [],
};

const capturado = {
  whatsapp: [] as string[],
  emails: [] as string[],
  n8n: [] as Array<{ url: string; payload: any }>,
};

let resendDisponivel = true;

function resetEstado() {
  for (const tabela of Object.keys(db)) db[tabela] = [];
  capturado.whatsapp = [];
  capturado.emails = [];
  capturado.n8n = [];
  resendDisponivel = true;
}

const defaults: Record<string, () => Linha> = {
  sessoes_whatsapp: () => ({ contexto: {}, verificado_em: null, criado_em: agoraIso() }),
  codigos_verificacao: () => ({
    canal: "EMAIL",
    tentativas: 0,
    max_tentativas: 3,
    consumido_em: null,
    invalidado_em: null,
    invalidado_motivo: null,
    criado_em: agoraIso(),
  }),
  eventos_acesso: () => ({ detalhes: {}, criado_em: agoraIso() }),
  usuarios: () => ({ criado_em: agoraIso() }),
};

const agoraIso = () => new Date().toISOString();

function aplicarFiltros(linhas: Linha[], params: URLSearchParams): Linha[] {
  const reservados = new Set(["select", "order", "limit", "offset", "on_conflict"]);
  let resultado = linhas;

  for (const [coluna, expressao] of params) {
    if (reservados.has(coluna)) continue;

    resultado = resultado.filter((linha) => {
      const valor = linha[coluna];
      if (expressao === "is.null") return valor === null || valor === undefined;
      if (expressao === "not.is.null") return valor !== null && valor !== undefined;

      const [operador, ...resto] = expressao.split(".");
      const alvo = resto.join(".");

      switch (operador) {
        case "eq":
          return String(valor) === alvo;
        case "gt":
          return new Date(valor).getTime() > new Date(alvo).getTime();
        case "gte":
          return new Date(valor).getTime() >= new Date(alvo).getTime();
        case "lt":
          return new Date(valor).getTime() < new Date(alvo).getTime();
        default:
          throw new Error(`operador PostgREST nao emulado: ${expressao}`);
      }
    });
  }

  return resultado;
}

function ordenarELimitar(linhas: Linha[], params: URLSearchParams): Linha[] {
  const ordem = params.get("order");
  let resultado = [...linhas];

  if (ordem) {
    const [coluna, direcao] = ordem.split(".");
    const fator = direcao === "desc" ? -1 : 1;
    resultado.sort((a, b) => {
      const esquerda = new Date(a[coluna] ?? 0).getTime();
      const direita = new Date(b[coluna] ?? 0).getTime();
      return (esquerda - direita) * fator;
    });
  }

  const limite = params.get("limit");
  return limite ? resultado.slice(0, Number(limite)) : resultado;
}

function respostaJson(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Unica constraint emulada: idx_codigos_verificacao_ativo_por_usuario. E a que
// a logica da function realmente consulta (trata 23505 como "codigo ja
// enviado"), entao precisa existir aqui para o caminho ser exercitado.
function violaUniqueAtivo(tabela: string, novo: Linha) {
  if (tabela !== "codigos_verificacao") return false;
  return db[tabela].some((linha) =>
    linha.usuario_id === novo.usuario_id &&
    (linha.consumido_em ?? null) === null &&
    (linha.invalidado_em ?? null) === null
  );
}

async function postgrest(url: URL, init?: RequestInit): Promise<Response> {
  const tabela = url.pathname.replace("/rest/v1/", "");
  if (!(tabela in db)) throw new Error(`tabela inesperada no teste: ${tabela}`);

  const metodo = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers ?? {});
  const querObjeto = (headers.get("accept") ?? "").includes("pgrst.object+json");

  if (metodo === "GET") {
    const linhas = ordenarELimitar(aplicarFiltros(db[tabela], url.searchParams), url.searchParams);
    if (querObjeto) {
      return linhas.length === 1
        ? respostaJson(linhas[0])
        : respostaJson({ code: "PGRST116", message: "0 rows" }, 406);
    }
    return respostaJson(linhas);
  }

  if (metodo === "POST") {
    const corpo = JSON.parse(String(init?.body ?? "{}"));
    const registros = Array.isArray(corpo) ? corpo : [corpo];
    const inseridos: Linha[] = [];

    for (const registro of registros) {
      const novo = { id: crypto.randomUUID(), ...(defaults[tabela]?.() ?? {}), ...registro };
      if (violaUniqueAtivo(tabela, novo)) {
        return respostaJson({
          code: "23505",
          message: "duplicate key value violates unique constraint",
          details: "idx_codigos_verificacao_ativo_por_usuario",
        }, 409);
      }
      db[tabela].push(novo);
      inseridos.push(novo);
    }

    if (querObjeto) return respostaJson(inseridos[0], 201);
    return respostaJson(inseridos, 201);
  }

  if (metodo === "PATCH") {
    const alteracoes = JSON.parse(String(init?.body ?? "{}"));
    const alvos = aplicarFiltros(db[tabela], url.searchParams);
    for (const linha of alvos) Object.assign(linha, alteracoes);
    return respostaJson(alvos);
  }

  throw new Error(`metodo nao emulado: ${metodo}`);
}

// --- interceptacao de rede ------------------------------------------------

const fetchReal = globalThis.fetch;

globalThis.fetch = async (input: any, init?: RequestInit): Promise<Response> => {
  const bruto = typeof input === "string" ? input : input?.url ?? String(input);
  const url = new URL(bruto);

  // As chamadas do proprio teste para a function sob teste passam direto.
  if (url.origin === FUNCTION_ORIGIN) return await fetchReal(input, init);

  if (url.origin === SUPABASE_ORIGIN) return await postgrest(url, init);

  if (url.hostname === "graph.facebook.com") {
    const corpo = JSON.parse(String(init?.body ?? "{}"));
    capturado.whatsapp.push(String(corpo?.text?.body ?? ""));
    return respostaJson({ messages: [{ id: "wamid.mock" }] });
  }

  if (url.hostname === "api.resend.com") {
    if (!resendDisponivel) {
      return respostaJson({ name: "validation_error", message: "domain not verified" }, 403);
    }
    const corpo = JSON.parse(String(init?.body ?? "{}"));
    capturado.emails.push(String(corpo?.text ?? ""));
    return respostaJson({ id: "email-mock" });
  }

  if (url.hostname === "n8n.test") {
    capturado.n8n.push({ url: bruto, payload: JSON.parse(String(init?.body ?? "{}")) });
    return respostaJson({ ok: true });
  }

  throw new Error(`fetch inesperado no teste: ${bruto}`);
};

// A function precisa ser importada DEPOIS do stub: o createClient no topo do
// index.ts captura a referencia de fetch no momento do import.
await import("../supabase/functions/whatsapp-webhook/index.ts");

async function aguardarFunction() {
  for (let tentativa = 0; tentativa < 40; tentativa += 1) {
    try {
      await fetchReal(`${FUNCTION_ORIGIN}/?hub.mode=ping`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("whatsapp-webhook nao subiu");
}

// --- helpers de cenario ---------------------------------------------------

function semearUsuario(overrides: Linha = {}) {
  db.usuarios.push({
    id: USUARIO_ID,
    email: "contribuinte@exemplo.test",
    telefone_whatsapp: TELEFONE,
    criado_em: new Date(Date.now() - 200 * DIA).toISOString(),
    ...overrides,
  });
}

function semearSessao(verificadoHaDias: number | null) {
  db.sessoes_whatsapp.push({
    id: SESSAO_ID,
    usuario_id: USUARIO_ID,
    telefone_whatsapp: TELEFONE,
    wa_id: WA_ID,
    status: "ABERTA",
    contexto: {},
    aberta_em: agoraIso(),
    ultima_interacao_em: agoraIso(),
    expira_em: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    criado_em: new Date(Date.now() - 300 * DIA).toISOString(),
    verificado_em: verificadoHaDias === null
      ? null
      : new Date(Date.now() - verificadoHaDias * DIA).toISOString(),
  });
}

function payloadMensagem(
  conteudo: { texto?: string; imagemId?: string },
  idMensagem = `wamid.${crypto.randomUUID()}`,
) {
  const mensagem: Linha = {
    from: WA_ID,
    id: idMensagem,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: conteudo.imagemId ? "image" : "text",
  };
  if (conteudo.imagemId) {
    mensagem.image = { id: conteudo.imagemId, mime_type: "image/jpeg", sha256: "abc" };
  } else {
    mensagem.text = { body: conteudo.texto ?? "" };
  }

  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "entry-1",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: "1234567890" },
          contacts: [{ wa_id: WA_ID, profile: { name: "Contribuinte Teste" } }],
          messages: [mensagem],
        },
      }],
    }],
  };
}

async function enviarMensagem(
  conteudo: { texto?: string; imagemId?: string },
  opcoes: { assinaturaValida?: boolean } = {},
) {
  const corpo = JSON.stringify(payloadMensagem(conteudo));
  const assinatura = opcoes.assinaturaValida === false
    ? "sha256=0000000000000000000000000000000000000000000000000000000000000000"
    : `sha256=${await hmacSha256Hex(APP_SECRET, corpo)}`;

  return await fetchReal(FUNCTION_ORIGIN, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": assinatura },
    body: corpo,
  });
}

const ultimaMensagemWhatsApp = () => capturado.whatsapp.at(-1) ?? "";
const codigoDoUltimoEmail = () => {
  const encontrado = (capturado.emails.at(-1) ?? "").match(/(\d{6})/);
  assert(encontrado, "nenhum codigo de 6 digitos no e-mail capturado");
  return encontrado[1];
};
const eventos = (tipo: string) => db.eventos_acesso.filter((linha) => linha.tipo_evento === tipo);

// --- cenarios -------------------------------------------------------------

Deno.test({
  name: "portao de re-verificacao por e-mail",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    await aguardarFunction();

    await t.step("dentro da janela de 30 dias: nada muda, mensagem segue para o n8n", async () => {
      resetEstado();
      semearUsuario();
      semearSessao(5);

      const resposta = await enviarMensagem({ texto: "gastei 120 reais em material de escritorio" });
      await resposta.body?.cancel();

      assertEquals(resposta.status, 200);
      assertEquals(capturado.n8n.length, 1);
      assertEquals(capturado.n8n[0].url, N8N_TEXTO);
      assertEquals(capturado.emails.length, 0);
      assertEquals(capturado.whatsapp.length, 0);
      assertEquals(db.codigos_verificacao.length, 0);
    });

    await t.step("midia dentro da janela continua indo para o workflow de OCR", async () => {
      resetEstado();
      semearUsuario();
      semearSessao(5);

      await (await enviarMensagem({ imagemId: "media-123" })).body?.cancel();

      assertEquals(capturado.n8n.length, 1);
      assertEquals(capturado.n8n[0].url, N8N_MIDIA);
    });

    await t.step("passados 30 dias: gera codigo, envia e-mail e NAO encaminha", async () => {
      resetEstado();
      semearUsuario();
      semearSessao(45);

      await (await enviarMensagem({ texto: "gastei 300 no dentista" })).body?.cancel();

      assertEquals(capturado.n8n.length, 0, "mensagem nao pode ir para o n8n antes da verificacao");
      assertEquals(capturado.emails.length, 1);
      assertEquals(db.codigos_verificacao.length, 1);

      const codigo = codigoDoUltimoEmail();
      const registro = db.codigos_verificacao[0];

      // O codigo em claro nao pode estar no banco.
      assertEquals(registro.codigo_hash, await hashCodigoVerificacao(codigo));
      assert(!JSON.stringify(registro).includes(codigo));
      assertEquals(registro.tentativas, 0);
      assertEquals(registro.max_tentativas, 3);
      assertEquals(registro.destino_mascarado, "c***e@exemplo.test");

      // 15 minutos de validade, com folga de 2s para o tempo de execucao.
      const validade = new Date(registro.expira_em).getTime() - Date.now();
      assert(validade > 14 * MINUTO && validade <= 15 * MINUTO + 2000, `validade: ${validade}ms`);

      assertMatch(semAcento(ultimaMensagemWhatsApp()), /codigo de 6 digitos/);
      assertMatch(ultimaMensagemWhatsApp(), /c\*\*\*e@exemplo\.test/);
      // O e-mail mascarado tambem protege o WhatsApp de entregar o endereco.
      assert(!ultimaMensagemWhatsApp().includes("contribuinte@exemplo.test"));
      assertEquals(eventos("CODIGO_VERIFICACAO_GERADO").length, 1);

      // Nenhum evento pode carregar o codigo em claro.
      assert(!JSON.stringify(db.eventos_acesso).includes(codigo));
    });

    await t.step("mensagem comum durante a verificacao relembra sem gastar novo e-mail", async () => {
      await (await enviarMensagem({ texto: "bom dia, ta funcionando?" })).body?.cancel();

      assertEquals(capturado.emails.length, 1, "nao pode disparar segundo e-mail");
      assertEquals(db.codigos_verificacao.length, 1);
      assertEquals(capturado.n8n.length, 0);
      assertMatch(semAcento(ultimaMensagemWhatsApp()), /Digite so o codigo/);
      assertEquals(db.codigos_verificacao[0].tentativas, 0, "nao pode consumir tentativa");
    });

    await t.step("texto com numero de 6 digitos nao e lido como palpite", async () => {
      await (await enviarMensagem({ texto: "paguei 123456 no boleto" })).body?.cancel();

      assertEquals(db.codigos_verificacao[0].tentativas, 0);
      assertMatch(semAcento(ultimaMensagemWhatsApp()), /Digite so o codigo/);
    });

    await t.step("codigo errado consome tentativa e informa o saldo", async () => {
      const codigoCorreto = codigoDoUltimoEmail();
      const errado = codigoCorreto === "000000" ? "111111" : "000000";

      await (await enviarMensagem({ texto: errado })).body?.cancel();
      assertEquals(db.codigos_verificacao[0].tentativas, 1);
      assertMatch(ultimaMensagemWhatsApp(), /2 tentativa\(s\) restante\(s\)/);

      await (await enviarMensagem({ texto: errado })).body?.cancel();
      assertEquals(db.codigos_verificacao[0].tentativas, 2);
      assertMatch(ultimaMensagemWhatsApp(), /1 tentativa\(s\) restante\(s\)/);

      assertEquals(eventos("VERIFICACAO_FALHA").length, 2);
      assertEquals(capturado.n8n.length, 0);
      assertEquals(db.sessoes_whatsapp[0].verificado_em !== null, true);
      assert(
        Date.now() - new Date(db.sessoes_whatsapp[0].verificado_em).getTime() > 40 * DIA,
        "verificado_em nao pode ser carimbado por tentativa errada",
      );
    });

    await t.step("terceira tentativa errada bloqueia o codigo", async () => {
      const errado = codigoDoUltimoEmail() === "000000" ? "111111" : "000000";
      await (await enviarMensagem({ texto: errado })).body?.cancel();

      const registro = db.codigos_verificacao[0];
      assertEquals(registro.invalidado_motivo, "TENTATIVAS_ESGOTADAS");
      assert(registro.invalidado_em);
      assertEquals(eventos("VERIFICACAO_FALHA").length, 3);
      assertMatch(ultimaMensagemWhatsApp(), /bloqueado por excesso de tentativas/);
      // Nao gera codigo novo sozinho: chute em rajada nao pode renovar codigo
      // nem encher a caixa de entrada do dono.
      assertEquals(capturado.emails.length, 1);
    });

    await t.step("mensagem seguinte gera um codigo novo", async () => {
      await (await enviarMensagem({ texto: "quero continuar" })).body?.cancel();

      assertEquals(capturado.emails.length, 2);
      assertEquals(db.codigos_verificacao.length, 2);
      const ativos = db.codigos_verificacao.filter((linha) =>
        !linha.consumido_em && !linha.invalidado_em
      );
      assertEquals(ativos.length, 1, "so pode existir um codigo ativo por usuario");
      assertEquals(capturado.n8n.length, 0);
    });

    await t.step("codigo correto carimba verificado_em e nao reprocessa a mensagem", async () => {
      const codigo = codigoDoUltimoEmail();
      await (await enviarMensagem({ texto: codigo })).body?.cancel();

      const ativo = db.codigos_verificacao.find((linha) => linha.consumido_em);
      assert(ativo, "codigo correto deveria ter sido consumido");

      const carimbo = new Date(db.sessoes_whatsapp[0].verificado_em).getTime();
      assert(Date.now() - carimbo < 5000, "verificado_em deveria ser de agora");

      assertEquals(eventos("VERIFICACAO_SUCESSO").length, 1);
      assertMatch(ultimaMensagemWhatsApp(), /Identidade confirmada/);
      // A mensagem que traz o codigo nao e despesa: nada vai para o n8n.
      assertEquals(capturado.n8n.length, 0);
    });

    await t.step("proxima mensagem volta ao fluxo normal", async () => {
      await (await enviarMensagem({ texto: "gastei 89 em software" })).body?.cancel();

      assertEquals(capturado.n8n.length, 1);
      assertEquals(capturado.n8n[0].url, N8N_TEXTO);
      assertEquals(capturado.emails.length, 2, "nao pode pedir verificacao de novo");
    });

    await t.step("codigo expirado e substituido por um novo na hora", async () => {
      resetEstado();
      semearUsuario();
      semearSessao(45);

      const codigo = "424242";
      db.codigos_verificacao.push({
        id: crypto.randomUUID(),
        usuario_id: USUARIO_ID,
        sessao_whatsapp_id: SESSAO_ID,
        canal: "EMAIL",
        codigo_hash: await hashCodigoVerificacao(codigo),
        destino_mascarado: "c***e@exemplo.test",
        tentativas: 0,
        max_tentativas: 3,
        // Vencido ha 1 minuto.
        expira_em: new Date(Date.now() - MINUTO).toISOString(),
        consumido_em: null,
        invalidado_em: null,
        criado_em: new Date(Date.now() - 16 * MINUTO).toISOString(),
      });

      await (await enviarMensagem({ texto: codigo })).body?.cancel();

      const expirado = db.codigos_verificacao[0];
      assertEquals(expirado.invalidado_motivo, "EXPIRADO");
      assertEquals(expirado.tentativas, 0, "codigo vencido nao consome tentativa");
      assertEquals(db.codigos_verificacao.length, 2, "deveria ter gerado um codigo novo");
      assertEquals(capturado.emails.length, 1);
      assertEquals(capturado.n8n.length, 0);
      assertMatch(capturado.whatsapp[0], /expirou/);
    });

    await t.step("codigo certo depois de expirado nao vale mais", async () => {
      // O usuario digitou o codigo antigo de novo: o novo codigo e outro, e o
      // antigo esta invalidado. Nao pode passar.
      await (await enviarMensagem({ texto: "424242" })).body?.cancel();

      const novo = db.codigos_verificacao[1];
      assertEquals(novo.tentativas, 1);
      assert(!novo.consumido_em);
      assertEquals(capturado.n8n.length, 0);
      assert(
        Date.now() - new Date(db.sessoes_whatsapp[0].verificado_em).getTime() > 40 * DIA,
        "verificado_em nao pode ter sido carimbado",
      );
    });

    await t.step("falha no envio do e-mail invalida o codigo e avisa o usuario", async () => {
      resetEstado();
      semearUsuario();
      semearSessao(45);
      resendDisponivel = false;

      await (await enviarMensagem({ texto: "gastei 45 em transporte" })).body?.cancel();

      assertEquals(db.codigos_verificacao.length, 1);
      assertEquals(db.codigos_verificacao[0].invalidado_motivo, "ENVIO_FALHOU");
      assertEquals(eventos("CODIGO_VERIFICACAO_ENVIO_FALHOU").length, 1);
      assertMatch(semAcento(ultimaMensagemWhatsApp()), /nao consegui enviar o codigo/);
      assertEquals(capturado.n8n.length, 0);

      // Codigo invalidado libera a proxima geracao (a unique parcial nao barra).
      resendDisponivel = true;
      await (await enviarMensagem({ texto: "tentando de novo" })).body?.cancel();
      assertEquals(capturado.emails.length, 1);
      assertEquals(db.codigos_verificacao.length, 2);
    });

    await t.step("usuario sem e-mail cadastrado: libera e registra o evento", async () => {
      resetEstado();
      semearUsuario({ email: null });
      semearSessao(45);

      await (await enviarMensagem({ texto: "gastei 60 em internet" })).body?.cancel();

      // Fail open: bloquear deixaria a conta sem saida pelo WhatsApp.
      assertEquals(capturado.n8n.length, 1);
      assertEquals(capturado.emails.length, 0);
      assertEquals(eventos("VERIFICACAO_INDISPONIVEL").length, 1);
      assertEquals(db.codigos_verificacao.length, 0);
    });

    await t.step("sessao nova de usuario verificado nao dispara re-verificacao", async () => {
      // Cenario que quebraria se a janela fosse lida da sessao atual: o usuario
      // verificou 3 dias atras, ficou dois dias sem falar, a sessao de 24h
      // expirou e uma nova nasce com verificado_em null.
      resetEstado();
      semearUsuario();
      semearSessao(3);
      db.sessoes_whatsapp[0].status = "EXPIRADA";
      db.sessoes_whatsapp[0].expira_em = new Date(Date.now() - DIA).toISOString();

      await (await enviarMensagem({ texto: "gastei 20 no uber" })).body?.cancel();

      assertEquals(db.sessoes_whatsapp.length, 2, "deveria ter aberto uma sessao nova");
      assertEquals(db.sessoes_whatsapp[1].verificado_em, null);
      assertEquals(capturado.emails.length, 0, "nao pode pedir verificacao");
      assertEquals(capturado.n8n.length, 1);
    });

    await t.step("usuario recem-cadastrado sem carimbo usa usuarios.criado_em", async () => {
      resetEstado();
      semearUsuario({ criado_em: new Date(Date.now() - 2 * DIA).toISOString() });
      semearSessao(null);

      await (await enviarMensagem({ texto: "gastei 15 em cafe" })).body?.cancel();

      assertEquals(capturado.emails.length, 0);
      assertEquals(capturado.n8n.length, 1);
    });

    await t.step("cadastro antigo sem carimbo nenhum cai em re-verificacao", async () => {
      resetEstado();
      semearUsuario({ criado_em: new Date(Date.now() - 400 * DIA).toISOString() });
      semearSessao(null);

      await (await enviarMensagem({ texto: "gastei 15 em cafe" })).body?.cancel();

      assertEquals(capturado.emails.length, 1);
      assertEquals(capturado.n8n.length, 0);
    });

    await t.step("onboarding de usuario nao cadastrado segue intacto", async () => {
      resetEstado();

      await (await enviarMensagem({ texto: "oi" })).body?.cancel();

      assertEquals(capturado.n8n.length, 0);
      assertEquals(capturado.emails.length, 0);
      assertEquals(db.codigos_verificacao.length, 0);
      assertMatch(ultimaMensagemWhatsApp(), /localhost:5173\/onboarding\?token=/);
      assertMatch(ultimaMensagemWhatsApp(), /Sou o TaxMind/);
    });

    await t.step("assinatura HMAC invalida continua sendo rejeitada", async () => {
      resetEstado();
      semearUsuario();
      semearSessao(45);

      const resposta = await enviarMensagem({ texto: "qualquer coisa" }, {
        assinaturaValida: false,
      });
      await resposta.body?.cancel();

      assertEquals(resposta.status, 401);
      assertEquals(capturado.emails.length, 0);
      assertEquals(capturado.n8n.length, 0);
      assertEquals(db.codigos_verificacao.length, 0);
    });
  },
});
