import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CHAT_DB, deleteChat, fileResponse, getChat, listChats, send, summarize, uploadFile } from "./chat.ts";

const PORT = Number(process.env.PORT ?? 4747);
const URL_BASE = `http://127.0.0.1:${PORT}`;
const OPENROUTER = "https://openrouter.ai/api/v1";
const CACHE_TTL = 5 * 60_000;
const IDLE_MINUTES = Number(process.env.IDLE_MINUTES ?? 30); // 0 = nigdy się nie wyłączaj
const DEFAULT_KEYS = ["model", "small_model"];
const MODEL_ID = /^[\w.:~-]+\/[\w.:~-]+$/;

const CONFIG_PATH = process.env.OPENCODE_CONFIG ?? findConfig();

function findConfig() {
  const dir = join(homedir(), ".config", "opencode");
  const files = ["opencode.jsonc", "opencode.json"].map((f) => join(dir, f));
  return files.find((f) => existsSync(f)) ?? files[0];
}

// --- OpenRouter (publiczne API, cache w pamięci) ---

const cache = new Map<string, { at: number; data: unknown }>();

async function openrouter(path: string) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;
  const res = await fetch(OPENROUTER + path);
  if (!res.ok) throw new Error(`OpenRouter ${res.status} dla ${path}`);
  const { data } = (await res.json()) as { data: unknown };
  cache.set(path, { at: Date.now(), data });
  return data;
}

// --- Config OpenCode (JSONC, edycje punktowe z zachowaniem komentarzy) ---

type Edit = [path: string[], value: unknown];

async function readConfig() {
  const file = Bun.file(CONFIG_PATH);
  const text = (await file.exists())
    ? await file.text()
    : `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`;
  const errors: ParseError[] = [];
  const json = parse(text, errors, { allowTrailingComma: true }) ?? {};
  if (errors.length) {
    const line = text.slice(0, errors[0].offset).split("\n").length;
    throw new Error(`Nie mogę odczytać ${CONFIG_PATH}: błąd składni w linii ${line}`);
  }
  return { text, json };
}

async function configView() {
  const { json } = await readConfig();
  return {
    path: CONFIG_PATH,
    model: json.model ?? null,
    small_model: json.small_model ?? null,
    models: json.provider?.openrouter?.models ?? {},
  };
}

async function applyAction(body: any) {
  let { text, json } = await readConfig();
  for (const [path, value] of editsFor(body, json)) {
    text = applyEdits(text, modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  }
  if (existsSync(CONFIG_PATH)) copyFileSync(CONFIG_PATH, CONFIG_PATH + ".bak");
  else mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  await Bun.write(CONFIG_PATH, text);
}

const modelPath = (id: string) => ["provider", "openrouter", "models", id];

function checkId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !MODEL_ID.test(id)) throw new Error(`Niepoprawne id modelu: ${id}`);
}

function editsFor(body: any, json: any): Edit[] {
  switch (body?.action) {
    case "save": {
      checkId(body.id);
      const p = modelPath(body.id);
      const e = body.entry;
      // Bez przypiętych providerów usuń options.provider, a puste options w całości.
      const options = json.provider?.openrouter?.models?.[body.id]?.options ?? {};
      const keepOptions = e.provider || Object.keys(options).some((k) => k !== "provider");
      const edits: Edit[] = [
        [[...p, "name"], e.name],
        [[...p, "limit"], e.limit],
        [[...p, "cost"], e.cost], // brak = usuń
        keepOptions ? [[...p, "options", "provider"], e.provider] : [[...p, "options"], undefined],
      ];
      for (const key of body.defaults ?? []) edits.push(defaultEdit(key, body.id));
      return edits;
    }
    case "remove":
      checkId(body.id);
      return [[modelPath(body.id), undefined]];
    // Cofnięcie usunięcia: zapisuje cały poprzedni wpis.
    case "restore":
      checkId(body.id);
      if (!body.entry || typeof body.entry !== "object") throw new Error("Brak wpisu do przywrócenia");
      return [[modelPath(body.id), body.entry]];
    // Hurtowa aktualizacja cen zapisanych modeli: { costs: { id: cost } }.
    case "costs":
      return Object.entries(body.costs ?? {}).map(([id, cost]): Edit => {
        checkId(id);
        if (!json.provider?.openrouter?.models?.[id]) throw new Error(`Modelu ${id} nie ma w configu`);
        return [[...modelPath(id), "cost"], cost];
      });
    case "default":
      // `value` przywraca dokładną poprzednią wartość (także spoza OpenRoutera), `id` ustawia model OpenRoutera.
      if ("value" in body) {
        if (body.value !== null && typeof body.value !== "string") throw new Error("Niepoprawna wartość roli");
        return [[defaultEdit(body.key, null)[0], body.value ?? undefined]];
      }
      if (body.id !== null) checkId(body.id);
      return [defaultEdit(body.key, body.id)];
    default:
      throw new Error(`Nieznana akcja: ${body?.action}`);
  }
}

// id === null usuwa klucz z configu.
function defaultEdit(key: string, id: string | null): Edit {
  if (!DEFAULT_KEYS.includes(key)) throw new Error(`Niepoprawny klucz: ${key}`);
  return [[key], id ? `openrouter/${id}` : undefined];
}

// --- HTTP ---

async function respond(fn: () => unknown) {
  try {
    return Response.json(await fn());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

// Tylko strona tej aplikacji może zmieniać dane (ochrona przed CSRF z innych kart).
// Wymagany content-type wymusza preflight CORS, którego obce strony nie przejdą.
function isLocalRequest(req: Request, type = "application/json") {
  const origin = req.headers.get("origin");
  const fromApp = !origin || origin === URL_BASE || origin === `http://localhost:${PORT}`;
  return fromApp && req.headers.get("content-type")?.startsWith(type);
}

const forbidden = () => new Response("Forbidden", { status: 403 });

// Czat używa modeli z configu razem z przypiętymi tam providerami.
async function providerFor(model: unknown) {
  checkId(model);
  const { json } = await readConfig();
  const entry = json.provider?.openrouter?.models?.[model];
  if (!entry) throw new Error(`Modelu ${model} nie ma w configu. Dodaj go w „Twoich modelach”.`);
  return entry.options?.provider;
}

async function chatResponse(req: Request) {
  const body = await req.json();
  const provider = await providerFor(body?.model);
  return new Response(send(body, provider, req.signal), {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}

// Odpowiedzi modelu mogą zawierać cokolwiek, więc strona czatu nie może niczego ładować spoza aplikacji.
const CHAT_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
  + "img-src 'self' blob: data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'";

const asset = (path: string, type: string) => () =>
  new Response(Bun.file(join(import.meta.dir, path)), { headers: { "content-type": type } });

// Każde zapytanie odsuwa automatyczne wyłączenie serwera.
let lastRequest = Date.now();
const tracked = <T extends unknown[], R>(handler: (...args: T) => R) => (...args: T) => {
  lastRequest = Date.now();
  return handler(...args);
};

try {
  Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    routes: {
      "/": tracked(() => new Response(Bun.file(join(import.meta.dir, "index.html")))),
      "/api/models": tracked(() => respond(() => openrouter("/models"))),
      "/api/endpoints": tracked((req: Request) =>
        respond(() => {
          const id = new URL(req.url).searchParams.get("id") ?? "";
          if (!MODEL_ID.test(id)) throw new Error(`Niepoprawne id modelu: ${id}`);
          return openrouter(`/models/${id}/endpoints`);
        })),
      "/api/config": {
        GET: tracked(() => respond(configView)),
        POST: tracked(async (req: Request) => {
          if (!isLocalRequest(req)) return forbidden();
          return respond(async () => {
            await applyAction(await req.json());
            return configView();
          });
        }),
      },
      "/chat": tracked(() => new Response(Bun.file(join(import.meta.dir, "chat.html")), {
        headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CHAT_CSP },
      })),
      "/vendor/marked.js": asset("node_modules/marked/lib/marked.esm.js", "text/javascript"),
      "/vendor/purify.js": asset("node_modules/dompurify/dist/purify.es.mjs", "text/javascript"),
      "/api/chats": tracked(() => respond(listChats)),
      "/api/chats/:id": {
        GET: tracked((req: Request & { params: { id: string } }) => respond(() => getChat(req.params.id))),
        DELETE: tracked((req: Request & { params: { id: string } }) =>
          isLocalRequest(req) ? respond(() => deleteChat(req.params.id)) : forbidden()),
      },
      "/api/chats/:id/summarize": {
        POST: tracked(async (req: Request & { params: { id: string } }) => {
          if (!isLocalRequest(req)) return forbidden();
          return respond(async () => {
            const { model } = await req.json();
            return summarize(req.params.id, model, await providerFor(model));
          });
        }),
      },
      "/api/chat": {
        POST: tracked(async (req: Request) => {
          if (!isLocalRequest(req)) return forbidden();
          try {
            return await chatResponse(req);
          } catch (e) {
            return Response.json({ error: (e as Error).message }, { status: 500 });
          }
        }),
      },
      "/api/files": {
        POST: tracked((req: Request) =>
          isLocalRequest(req, "application/octet-stream") ? respond(() => uploadFile(req)) : forbidden()),
      },
      "/api/files/:id": tracked((req: Request & { params: { id: string } }) => fileResponse(req.params.id)),
    },
  });
  console.log(`OpenCode config → ${URL_BASE}\nPlik: ${CONFIG_PATH}\nCzat: ${URL_BASE}/chat (rozmowy w ${CHAT_DB})`);
  if (IDLE_MINUTES > 0) {
    setInterval(() => {
      if (Date.now() - lastRequest < IDLE_MINUTES * 60_000) return;
      console.log(`Brak aktywności przez ${IDLE_MINUTES} min — wyłączam serwer.`);
      process.exit(0);
    }, 60_000);
  }
} catch (e) {
  if ((e as { code?: string }).code !== "EADDRINUSE") throw e;
  console.log(`Już działa na ${URL_BASE}`);
}

if (!process.argv.includes("--no-open")) Bun.spawn(["open", URL_BASE]);
