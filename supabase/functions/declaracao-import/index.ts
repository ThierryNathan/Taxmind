// Import do PDF da declaracao de IRPF do ano anterior (Fase 17).
//
// Chamada pelo n8n (receipt-ocr-classification) quando chega um DOCUMENTO e a
// whatsapp-webhook anotou uma pendencia aberta de campo_alvo
// 'declaracao_anterior'. Recebe o arquivo ja em base64 (o n8n baixa a midia da
// Graph API, que e onde o token do WhatsApp vive) e devolve a mensagem pronta.
//
// TRES DESFECHOS, e o do meio e o que torna a feature segura:
//
//   IMPORTADA        - era declaracao, os campos foram gravados e a pendencia
//                      fechou;
//   NAO_E_DECLARACAO - o documento nao e declaracao. NAO grava nada, NAO fecha a
//                      pendencia, e devolve `seguir_como_recibo: true` para o
//                      workflow mandar o arquivo pelo fluxo normal de despesa.
//                      Sem isto, uma pendencia aberta sequestraria a foto do
//                      cupom que a pessoa mandou no meio do caminho;
//   FALHA            - extracao invalida ou erro de infraestrutura. A pendencia
//                      continua aberta para a pessoa tentar de novo.
//
// O PDF nao e persistido em lugar nenhum: entra na memoria da function, vai
// para o Gemini e sai daqui como hash. Ele carrega renda, dependentes e bens —
// muito alem dos campos que o produto usa.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { timingSafeEqual } from "../_shared/bootstrap_token.ts";
import {
  CAMPO_DECLARACAO,
  interpretarExtracao,
  mensagemDeclaracaoImportada,
  MENSAGEM_NAO_E_DECLARACAO,
  PROMPT_EXTRACAO_DECLARACAO,
  VERSAO_PROMPT_DECLARACAO,
} from "../_shared/declaracao_anterior.ts";

type ImportRequest = {
  /** Um dos dois basta. O n8n manda session_id porque no fluxo de midia o dono
   *  so e resolvido depois da classificacao, e a regra do projeto e resolver o
   *  usuario por session_id contra sessoes_whatsapp.id (AGENTS.md). */
  usuario_id?: string;
  session_id?: string;
  followup_id?: string;
  arquivo_base64?: string;
  mime_type?: string;
  arquivo_nome?: string;
};

const jsonHeaders = { "content-type": "application/json" };
const env = (name: string, fallback = "") => Deno.env.get(name) ?? fallback;

const MODELO_GEMINI = "gemini-3-flash-preview";

// Teto do inline_data da API do Gemini e 20MB de REQUEST, e base64 infla ~33%.
// 12MB de arquivo deixa folga para o prompt e para o envelope JSON.
const LIMITE_ARQUIVO_BYTES = 12 * 1024 * 1024;

const supabase = createClient(
  env("SUPABASE_URL"),
  env("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

serve(async (request) => {
  try {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    // Mesma postura da generate-dossier e da followup-resolve: a anon key e
    // publica e esta function grava baseline fiscal. Server-to-server exige a
    // service_role.
    if (!isServiceRoleCaller(request)) return json({ error: "unauthorized" }, 401);

    const body = await request.json() as ImportRequest;
    const base64 = body?.arquivo_base64?.trim();
    const usuarioId = body?.usuario_id?.trim() ||
      await resolverUsuarioPorSessao(body?.session_id?.trim());

    if (!usuarioId) return json({ error: "missing_usuario_id" }, 400);
    if (!base64) return json({ error: "missing_arquivo" }, 400);

    const bytes = decodificar(base64);
    if (!bytes) return json({ error: "base64_invalido" }, 400);
    if (bytes.length > LIMITE_ARQUIVO_BYTES) {
      return json({
        desfecho: "FALHA" as const,
        motivo: "ARQUIVO_GRANDE_DEMAIS",
        mensagem:
          "Esse arquivo é grande demais para eu ler por aqui. Tenta enviar só o PDF da declaração, sem anexos.",
      });
    }

    const hash = await sha256Hex(bytes);

    const extracao = await extrairComGemini(base64, body.mime_type ?? "application/pdf");
    if (extracao.status === "erro") {
      return json({
        desfecho: "FALHA" as const,
        motivo: extracao.motivo,
        mensagem:
          "Não consegui ler esse arquivo agora. Tenta de novo em alguns minutos — a solicitação continua de pé.",
      });
    }

    const resultado = interpretarExtracao(extracao.texto);

    if (resultado.status === "nao_e_declaracao") {
      // A pendencia NAO e consumida: quem mandou o arquivo errado ainda pode
      // mandar o certo dentro da janela.
      return json({
        desfecho: "NAO_E_DECLARACAO" as const,
        seguir_como_recibo: true,
        mensagem: MENSAGEM_NAO_E_DECLARACAO,
      });
    }

    if (resultado.status === "invalida") {
      return json({
        desfecho: "FALHA" as const,
        motivo: resultado.motivo,
        mensagem:
          "Recebi o arquivo, mas não consegui identificar o ano e o tipo da declaração nele. " +
          "Confere se é o PDF de *Documentos e Arquivos (Cópia da Declaração)* e me manda de novo.",
      });
    }

    const dados = resultado.dados;

    // Upsert por (usuario_id, ano_calendario): reimportar o mesmo ano substitui,
    // porque o arquivo mais novo e a verdade mais nova (migration 011).
    const { error: upsertError } = await supabase
      .from("declaracoes_anteriores")
      .upsert({
        usuario_id: usuarioId,
        ano_calendario: dados.ano_calendario,
        modelo: dados.modelo,
        aliquota_efetiva: dados.aliquota_efetiva,
        imposto_devido: dados.imposto_devido,
        base_calculo: dados.base_calculo,
        rendimentos_tributaveis: dados.rendimentos_tributaveis,
        categorias_pagamentos: dados.categorias_pagamentos,
        pagamentos_detalhados: dados.pagamentos_detalhados,
        confianca: dados.confianca,
        motivos_revisao: dados.motivos_revisao,
        arquivo_hash_sha256: hash,
        arquivo_nome: body.arquivo_nome ?? null,
        versao_prompt: VERSAO_PROMPT_DECLARACAO,
        extraido_em: new Date().toISOString(),
      }, { onConflict: "usuario_id,ano_calendario" });

    if (upsertError) {
      console.error("failed to upsert declaracao anterior", upsertError);
      return json({
        desfecho: "FALHA" as const,
        motivo: "PERSISTENCIA",
        mensagem:
          "Li sua declaração, mas não consegui gravar agora. Tenta de novo em alguns minutos.",
      });
    }

    // A pendencia so fecha DEPOIS de a linha existir: fechar antes deixaria o
    // usuario sem pendencia e sem baseline se o insert falhasse.
    await resolverPendencia(body.followup_id, usuarioId);

    return json({
      desfecho: "IMPORTADA" as const,
      ano_calendario: dados.ano_calendario,
      modelo: dados.modelo,
      aliquota_efetiva: dados.aliquota_efetiva,
      categorias_pagamentos: dados.categorias_pagamentos,
      mensagem: mensagemDeclaracaoImportada(dados),
    });
  } catch (error) {
    console.error("declaracao-import error", error);
    return json({ error: "internal_error" }, 500);
  }
});

/** Dono da sessao. Mesma resolucao que os workflows fazem: por session_id
 *  contra sessoes_whatsapp.id, e nunca por wa_id (AGENTS.md). */
async function resolverUsuarioPorSessao(sessionId: string | undefined): Promise<string | null> {
  if (!sessionId) return null;

  const { data, error } = await supabase
    .from("sessoes_whatsapp")
    .select("usuario_id")
    .eq("id", sessionId)
    .maybeSingle();

  if (error) {
    console.error("failed to resolve usuario by session", error);
    return null;
  }
  return data?.usuario_id ?? null;
}

function isServiceRoleCaller(request: Request) {
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) {
    console.error("SUPABASE_SERVICE_ROLE_KEY not configured; refusing request");
    return false;
  }
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  return timingSafeEqual(token, serviceRoleKey);
}

function decodificar(base64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binario = atob(base64);
    const bytes = new Uint8Array(new ArrayBuffer(binario.length));
    for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Hash do arquivo recebido. E o unico rastro do PDF que sobrevive a esta
 *  requisicao: prova de qual arquivo gerou a linha, sem reter o documento. */
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type RespostaGemini =
  | { status: "ok"; texto: string }
  | { status: "erro"; motivo: string };

/**
 * Extracao pelo Gemini, com o PDF direto em inline_data.
 *
 * Nao ha conversao de pagina em imagem: a API aceita application/pdf e le o
 * documento inteiro (medido — duas paginas transcritas, 9/9 de acerto nos
 * campos alvo). O thinkingLevel fica em "low" e o maxOutputTokens com folga
 * porque o Gemini 3 Flash nao permite desligar thinking, e com teto apertado a
 * resposta volta VAZIA (AGENTS.md).
 */
async function extrairComGemini(base64: string, mimeType: string): Promise<RespostaGemini> {
  const chave = env("GEMINI_API_KEY");
  if (!chave) {
    console.error("GEMINI_API_KEY nao configurada; import de declaracao indisponivel");
    return { status: "erro", motivo: "SEM_CHAVE_GEMINI" };
  }

  try {
    const resposta = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_GEMINI}:generateContent?key=${chave}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { inline_data: { mime_type: mimeType || "application/pdf", data: base64 } },
              { text: PROMPT_EXTRACAO_DECLARACAO },
            ],
          }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 8192,
            thinkingConfig: { thinkingLevel: "low" },
          },
        }),
      },
    );

    if (!resposta.ok) {
      console.error("gemini respondeu erro no import de declaracao", {
        status: resposta.status,
        corpo: (await resposta.text()).slice(0, 300),
      });
      return { status: "erro", motivo: `GEMINI_${resposta.status}` };
    }

    const corpo = await resposta.json();
    const texto = corpo?.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p.text ?? "")
      .join("") ?? "";

    if (!texto.trim()) return { status: "erro", motivo: "RESPOSTA_VAZIA" };
    return { status: "ok", texto };
  } catch (error) {
    console.error("chamada ao gemini falhou no import de declaracao", error);
    return { status: "erro", motivo: "REDE" };
  }
}

/**
 * Fecha a pendencia.
 *
 * Mesma exclusao mutua da followup-resolve: o UPDATE condicionado a
 * respondida_em/descartada_em nulos e reavaliado pelo Postgres no READ
 * COMMITTED, entao duas execucoes concorrentes nao fecham as duas.
 *
 * Falha aqui nao derruba o import: a linha ja existe, e a pendencia expira
 * sozinha em uma hora. Perder o baseline por causa da limpeza seria pior.
 */
async function resolverPendencia(followupId: string | undefined, usuarioId: string) {
  if (!followupId) return;

  const { error } = await supabase
    .from("followups_pendentes")
    .update({ respondida_em: new Date().toISOString(), resolucao: "DECLARACAO_IMPORTADA" })
    .eq("id", followupId)
    .eq("usuario_id", usuarioId)
    .eq("campo_alvo", CAMPO_DECLARACAO)
    .is("respondida_em", null)
    .is("descartada_em", null);

  if (error) console.error("failed to resolve declaracao pendency", error);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}
