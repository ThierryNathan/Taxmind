// Deriva do repositorio o que precisa ser redeployado, e confere contra o que
// esta publicado de verdade.
//
// Rodar:  deno test --allow-env --allow-net --allow-read tests/deploy_drift_test.ts
//
// POR QUE ESTE ARQUIVO EXISTE
//
// Em 2026-08-09 a Fase 15 foi para producao pela metade: migration aplicada,
// workflows do n8n importados, followup-resolve e generate-dossier deployadas —
// e a whatsapp-webhook nao. Duas pendencias reais morreram por causa disso, e a
// suite inteira passava, porque toda ela testa o REPOSITORIO, e o repositorio
// estava certo.
//
// A causa da omissao e estrutural, nao descuido: supabase/functions/
// whatsapp-webhook/index.ts NAO mudou na Fase 15. O que mudou foi o
// _shared/followup.ts que ela importa. Qualquer deploy guiado por "quais
// arquivos de function mudaram" pula exatamente esse caso, e vai continuar
// pulando enquanto ninguem olhar para a fronteira do bundle.
//
// COMO A COMPARACAO FUNCIONA
//
// O bundle publicado guarda o codigo TRANSPILADO (tipos apagados, formatacao
// reescrita), entao comparar bytes nao serve. O que sobrevive a transpilacao, e
// e o que este arquivo compara:
//
//   - nomes de declaracoes de topo, exportadas ou nao (o Deno nao minifica);
//   - literais de string do codigo;
//   - literais numericos de const de topo.
//
// Limite conhecido e aceito: uma mudanca puramente de operador dentro de um
// corpo de funcao (trocar > por >=) nao muda nenhum desses e passaria batido.
// Isso nao invalida o teste — o caso que aconteceu de verdade, e a forma de
// quase toda evolucao deste codigo, e acrescentar constante, funcao ou texto.
//
// Sem credencial da Management API os testes sao IGNORADOS, nao falham: o token
// vive em ~/.supabase/access-token e nao existe na CI. Com credencial, erro de
// API falha de proposito — um "verde" por indisponibilidade seria pior do que
// vermelho, ja que a unica razao de ser deste arquivo e afirmar algo sobre
// producao.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const RAIZ_FUNCTIONS = "supabase/functions";
const COMPARTILHADO = "_shared";

// --- credenciais ----------------------------------------------------------

async function lerToken(): Promise<string> {
  const doAmbiente = Deno.env.get("SUPABASE_ACCESS_TOKEN");
  if (doAmbiente) return doAmbiente.trim();

  const lar = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  try {
    return (await Deno.readTextFile(`${lar}/.supabase/access-token`)).trim();
  } catch {
    return "";
  }
}

async function lerProjectRef(): Promise<string> {
  try {
    const env = await Deno.readTextFile(".env");
    const linha = env.split("\n").find((l) => l.startsWith("SUPABASE_URL="));
    const url = linha?.slice("SUPABASE_URL=".length).trim() ?? "";
    return new URL(url).hostname.split(".")[0];
  } catch {
    return "";
  }
}

const TOKEN = await lerToken();
const PROJECT_REF = await lerProjectRef();
const TEM_CREDENCIAL = Boolean(TOKEN && PROJECT_REF);

// --- grafo de dependencia lido do repositorio -----------------------------

/** Modulos de _shared que este arquivo importa como VALOR.
 *
 *  Import type puro nao entra: ele e apagado na transpilacao e o modulo nem
 *  chega ao bundle, entao cobrar a presenca dele seria falso positivo. */
function importsDeValor(fonte: string): string[] {
  const encontrados = new Set<string>();

  // import { ... } from "<caminho>"  /  import "<caminho>"
  const padrao = /import\s+(type\s+)?([\s\S]*?)\s*from\s*["'](\.[^"']+\.ts)["']/g;
  for (const achado of fonte.matchAll(padrao)) {
    const [, tipoNoTopo, especificadores, caminho] = achado;
    if (tipoNoTopo) continue;

    const chaves = especificadores.match(/\{([\s\S]*)\}/);
    if (chaves) {
      const itens = chaves[1].split(",").map((i) => i.trim()).filter(Boolean);
      // Todos os especificadores sao `type X`: nada sobra depois da transpilacao.
      if (itens.length > 0 && itens.every((i) => i.startsWith("type "))) continue;
    }
    encontrados.add(caminho);
  }

  return [...encontrados];
}

function resolver(deQual: string, relativo: string): string {
  const partes = deQual.split("/").slice(0, -1);
  for (const pedaco of relativo.split("/")) {
    if (pedaco === ".") continue;
    if (pedaco === "..") partes.pop();
    else partes.push(pedaco);
  }
  return partes.join("/");
}

/** Fecho transitivo de _shared alcancado por uma function. */
async function dependenciasDe(caminhoIndex: string): Promise<string[]> {
  const vistos = new Set<string>();
  const fila = [caminhoIndex];

  while (fila.length > 0) {
    const atual = fila.shift()!;
    let fonte: string;
    try {
      fonte = await Deno.readTextFile(atual);
    } catch {
      continue;
    }

    for (const relativo of importsDeValor(fonte)) {
      const alvo = resolver(atual, relativo);
      if (!alvo.includes(`/${COMPARTILHADO}/`) || vistos.has(alvo)) continue;
      vistos.add(alvo);
      fila.push(alvo);
    }
  }

  return [...vistos].sort();
}

async function listarFunctions(): Promise<string[]> {
  const nomes: string[] = [];
  for await (const item of Deno.readDir(RAIZ_FUNCTIONS)) {
    if (!item.isDirectory || item.name === COMPARTILHADO) continue;
    try {
      await Deno.stat(`${RAIZ_FUNCTIONS}/${item.name}/index.ts`);
      nomes.push(item.name);
    } catch {
      // Diretorio sem entrypoint nao e uma function deployavel.
    }
  }
  return nomes.sort();
}

// --- impressao digital ----------------------------------------------------

function semComentarios(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ")
    .replace(/([^:"'`\\])\/\/.*$/gm, "$1 ");
}

/**
 * O que precisa estar no bundle para ele ser desta versao do modulo.
 *
 * `export type` e `interface` ficam de fora porque somem na transpilacao.
 */
function marcadores(fonte: string): string[] {
  const codigo = semComentarios(fonte);
  const itens = new Set<string>();

  // Declaracoes de topo, exportadas ou nao: o Deno transpila sem minificar,
  // entao os nomes locais tambem sobrevivem e ampliam bastante a cobertura.
  for (const m of codigo.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)) {
    itens.add(`function ${m[1]}`);
  }
  for (const m of codigo.matchAll(/^(?:export\s+)?const\s+(\w+)\s*[=:]/gm)) {
    itens.add(`const ${m[1]}`);
  }

  // Literais de string. Guarda-se o maior trecho sem aspas nem barra invertida:
  // a transpilacao pode trocar o estilo das aspas e reescrever escapes, mas nao
  // mexe no conteudo entre eles.
  for (const m of codigo.matchAll(/(["'])((?:[^"'\\\n])+)\1/g)) {
    const nucleo = m[2].trim();
    if (nucleo.length >= 12) itens.add(nucleo);
  }

  // Numeros de const de topo: TTL, orcamento, limites. Nenhum nome novo aparece
  // quando so o valor muda, e essa e justamente a mudanca silenciosa.
  for (const m of codigo.matchAll(/^(?:export\s+)?const\s+\w+\s*=\s*([\d.]+)/gm)) {
    itens.add(`numero ${m[1]}`);
  }

  return [...itens];
}

/**
 * Marcadores do arquivo que NAO estao no bundle.
 *
 * Extraida do laco de proposito: e ela que decide se ha drift, e um detector que
 * responde "em dia" para tudo transformaria esta suite inteira em verde vazio —
 * a mesma classe de falha que o incidente expos. Os dois testes offline logo
 * abaixo a exercitam nos dois sentidos.
 */
function marcadoresAusentes(fonte: string, bundle: string): string[] {
  const marcas = marcadores(fonte);
  if (marcas.length === 0) {
    throw new Error("impressao digital vazia: a comparacao nao afirmaria nada");
  }
  return marcas.filter((marca) =>
    !bundle.includes(marca.replace(/^(function|const|numero) /, ""))
  );
}

// --- Management API -------------------------------------------------------

const bundles = new Map<string, string>();

async function bundlePublicado(slug: string): Promise<string | null> {
  if (bundles.has(slug)) return bundles.get(slug)!;

  const resposta = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/functions/${slug}/body`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  );

  if (resposta.status === 404) {
    await resposta.body?.cancel();
    return null;
  }
  assert(
    resposta.ok,
    `Management API respondeu ${resposta.status} para ${slug}. Com credencial ` +
      `presente, isto falha de proposito: um verde por indisponibilidade nao ` +
      `diria nada sobre producao.`,
  );

  const corpo = await resposta.text();
  bundles.set(slug, corpo);
  return corpo;
}

async function metadados(): Promise<Record<string, { version: number; updated_at: number }>> {
  const resposta = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/functions`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  assert(resposta.ok, `Management API respondeu ${resposta.status} ao listar functions`);

  const lista = await resposta.json() as Array<Record<string, any>>;
  return Object.fromEntries(
    lista.map((f) => [f.slug, { version: f.version, updated_at: f.updated_at }]),
  );
}

// --- testes ---------------------------------------------------------------

Deno.test("o grafo de dependencia enxerga _shared alem do index.ts", async () => {
  // Este roda sempre, sem rede: se a leitura do grafo quebrar, os testes de
  // drift viram verde vazio — checariam um conjunto vazio de dependencias.
  const functions = await listarFunctions();
  assert(functions.includes("whatsapp-webhook"), functions.join(", "));

  const deps = await dependenciasDe(`${RAIZ_FUNCTIONS}/whatsapp-webhook/index.ts`);
  assert(
    deps.includes(`${RAIZ_FUNCTIONS}/${COMPARTILHADO}/followup.ts`),
    `whatsapp-webhook deveria depender de _shared/followup.ts; achei: ${deps.join(", ")}`,
  );

  // O caso do incidente, dito em uma linha: o index.ts nao muda, a dependencia
  // muda, e o deploy por arquivo alterado nao ve nada.
  const marcas = marcadores(
    await Deno.readTextFile(`${RAIZ_FUNCTIONS}/${COMPARTILHADO}/followup.ts`),
  );
  assert(marcas.includes("const CAMPO_REEMBOLSO"), "impressao digital nao pegou o campo novo");
  assert(marcas.length > 40, `impressao digital rasa demais: ${marcas.length} marcadores`);
});

Deno.test("o detector acusa drift, e nao acusa quando nao ha", async () => {
  // Sem este par, a suite toda poderia ficar verde por um detector quebrado —
  // exatamente o modo de falha que o incidente revelou. Roda offline, sobre o
  // arquivo real que causou o incidente.
  const caminho = `${RAIZ_FUNCTIONS}/${COMPARTILHADO}/followup.ts`;
  const fonte = await Deno.readTextFile(caminho);

  // Verde: um "bundle" que contem a fonte atual nao tem nada faltando. E o que
  // prova que o teste consegue passar depois do redeploy.
  assertEquals(marcadoresAusentes(fonte, fonte), []);

  // Vermelho: um bundle que nao conhece os simbolos da Fase 15. Simular pela
  // AUSENCIA DO TOKEN, e nao recortando um trecho por posicao: o recorte deixa
  // os usos do simbolo mais abaixo no arquivo, e ai a busca por substring ainda
  // acha o nome — o "bundle antigo" nao seria antigo, e o teste passaria por
  // acidente. (Foi o que aconteceu na primeira versao deste teste.)
  const tokensDaFase15 = [
    "CAMPO_REEMBOLSO",
    "valor_reembolso",
    "extrairRespostaDeReembolso",
    "derivarCampoFollowup",
    "deveperguntarReembolso",
    "destinoSeSemReembolso",
  ];
  let antigo = fonte;
  for (const token of tokensDaFase15) antigo = antigo.replaceAll(token, "OMITIDO");

  const ausentes = marcadoresAusentes(fonte, antigo);
  for (const token of ["CAMPO_REEMBOLSO", "extrairRespostaDeReembolso", "derivarCampoFollowup"]) {
    assert(
      ausentes.some((a) => a.includes(token)),
      `o detector nao viu ${token} faltando: ${ausentes.slice(0, 5).join(" | ")}`,
    );
  }
  assert(ausentes.length >= 5, `deteccao rasa demais: ${ausentes.length} marcador(es)`);

  // E a impressao digital vazia e erro, nao "nada faltando".
  let recusou = false;
  try {
    marcadoresAusentes("// so um comentario\n", "");
  } catch {
    recusou = true;
  }
  assert(recusou, "arquivo sem marcador nenhum passaria como em dia");
});

Deno.test("import type puro nao vira dependencia de bundle", () => {
  // Sem isto o teste cobraria a presenca de um modulo que a transpilacao apaga,
  // e falharia com a producao correta.
  assertEquals(importsDeValor(`import type { X } from "../_shared/a.ts";`), []);
  assertEquals(importsDeValor(`import { type X, type Y } from "../_shared/a.ts";`), []);
  assertEquals(importsDeValor(`import { type X, f } from "../_shared/a.ts";`), [
    "../_shared/a.ts",
  ]);
  assertEquals(importsDeValor(`import { f } from "../_shared/a.ts";`), ["../_shared/a.ts"]);
});

Deno.test({
  name: "o codigo publicado esta em dia com o repositorio",
  ignore: !TEM_CREDENCIAL,
  fn: async () => {
    const versoes = await metadados();
    const desatualizadas: string[] = [];
    const relatorio: string[] = [];

    for (const slug of await listarFunctions()) {
      const bundle = await bundlePublicado(slug);
      if (bundle === null) {
        relatorio.push(`  ${slug}: nao deployada (ignorada)`);
        continue;
      }

      const alvos = [
        `${RAIZ_FUNCTIONS}/${slug}/index.ts`,
        ...await dependenciasDe(`${RAIZ_FUNCTIONS}/${slug}/index.ts`),
      ];

      const faltando: string[] = [];
      for (const arquivo of alvos) {
        const ausentes = marcadoresAusentes(await Deno.readTextFile(arquivo), bundle);
        if (ausentes.length > 0) {
          faltando.push(
            `      ${arquivo}: ${ausentes.length} marcador(es) ausente(s) — ` +
              ausentes.slice(0, 4).join(" | "),
          );
        }
      }

      const meta = versoes[slug];
      const quando = meta ? new Date(meta.updated_at).toISOString() : "?";
      if (faltando.length > 0) {
        desatualizadas.push(slug);
        relatorio.push(`  ${slug}: DESATUALIZADA (v${meta?.version}, ${quando})`);
        relatorio.push(...faltando);
      } else {
        relatorio.push(`  ${slug}: em dia (v${meta?.version}, ${quando})`);
      }
    }

    console.log(`\nfronteira do bundle publicado (${PROJECT_REF}):\n${relatorio.join("\n")}\n`);

    assertEquals(
      desatualizadas,
      [],
      "\n\nO codigo publicado nao e o do repositorio. Redeploy necessario:\n\n" +
        desatualizadas.map((s) => `    supabase functions deploy ${s}`).join("\n") +
        "\n\nAtencao ao motivo: uma function entra nesta lista mesmo sem o proprio\n" +
        "index.ts ter mudado, quando um modulo de _shared que ela importa mudou.\n" +
        "Foi exatamente assim que a Fase 15 foi para producao pela metade.\n" +
        relatorio.join("\n") + "\n",
    );
  },
});

Deno.test({
  name: "toda function do repositorio existe no projeto",
  ignore: !TEM_CREDENCIAL,
  fn: async () => {
    // O PONTO CEGO QUE ISTO FECHA
    //
    // Os dois testes abaixo comparam o bundle publicado com o repositorio, e os
    // dois fazem `continue` quando a function nunca foi deployada — sem bundle
    // nao ha o que comparar. O efeito colateral e que criar a pasta da function,
    // escrever o index.ts e esquecer o deploy passava com a suite inteira VERDE,
    // que e o mesmo desfecho do incidente da Fase 15 (docs/09) por outro
    // caminho: codigo no repositorio, comportamento ausente em producao.
    //
    // Aqui a ausencia e o proprio erro, e o nome da function sai na mensagem.
    const publicadas = new Set(Object.keys(await metadados()));
    const faltando = (await listarFunctions()).filter((slug) => !publicadas.has(slug));

    assertEquals(
      faltando,
      [],
      "Function existe no repositorio e nao no projeto. Deploy necessario:\n\n" +
        faltando.map((slug) => `    supabase functions deploy ${slug}`).join("\n"),
    );
  },
});

Deno.test({
  name: "toda function que importa _shared tem o modulo dentro do bundle",
  ignore: !TEM_CREDENCIAL,
  fn: async () => {
    // Rede de seguranca do teste acima: se um modulo de _shared sumisse do
    // bundle por inteiro, a comparacao marcador a marcador acusaria centenas de
    // ausencias e o diagnostico ficaria ilegivel. Aqui a falha e nomeada.
    for (const slug of await listarFunctions()) {
      const bundle = await bundlePublicado(slug);
      if (bundle === null) continue;

      for (const dep of await dependenciasDe(`${RAIZ_FUNCTIONS}/${slug}/index.ts`)) {
        const nome = dep.split("/").pop();
        assert(
          bundle.includes(`${COMPARTILHADO}/${nome}`) || bundle.includes(String(nome)),
          `${slug} importa ${dep} mas o bundle publicado nao carrega o modulo. ` +
            `Ou a function esta muito atrasada, ou o import deixou de existir.`,
        );
      }
    }
  },
});
