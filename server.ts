import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PORT = Number(process.env.PORT ?? 4747);
const URL_BASE = `http://127.0.0.1:${PORT}`;
const OPENROUTER = "https://openrouter.ai/api/v1";
const CACHE_TTL = 5 * 60_000;
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
  if (errors.length) throw new Error(`Nie mogę sparsować ${CONFIG_PATH} (offset ${errors[0].offset})`);
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
    case "default":
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

// Tylko strona tej aplikacji może zmieniać config (ochrona przed CSRF z innych kart).
function isLocalRequest(req: Request) {
  const origin = req.headers.get("origin");
  const fromApp = !origin || origin === URL_BASE || origin === `http://localhost:${PORT}`;
  return fromApp && req.headers.get("content-type")?.startsWith("application/json");
}

try {
  Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    routes: {
      "/": () => new Response(Bun.file(join(import.meta.dir, "index.html"))),
      "/api/models": () => respond(() => openrouter("/models")),
      "/api/endpoints": (req) =>
        respond(() => {
          const id = new URL(req.url).searchParams.get("id") ?? "";
          if (!MODEL_ID.test(id)) throw new Error(`Niepoprawne id modelu: ${id}`);
          return openrouter(`/models/${id}/endpoints`);
        }),
      "/api/config": {
        GET: () => respond(configView),
        POST: async (req) => {
          if (!isLocalRequest(req)) return new Response("Forbidden", { status: 403 });
          return respond(async () => {
            await applyAction(await req.json());
            return configView();
          });
        },
      },
    },
  });
  console.log(`OpenCode config → ${URL_BASE}\nPlik: ${CONFIG_PATH}`);
} catch (e) {
  if ((e as { code?: string }).code !== "EADDRINUSE") throw e;
  console.log(`Już działa na ${URL_BASE}`);
}

if (!process.argv.includes("--no-open")) Bun.spawn(["open", URL_BASE]);
