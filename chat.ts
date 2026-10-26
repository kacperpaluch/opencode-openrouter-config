import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Czat przez OpenRoutera: rozmowy i załączniki w lokalnej bazie SQLite, odpowiedzi strumieniowane do przeglądarki.

const OPENROUTER = "https://openrouter.ai/api/v1";
const DB_PATH = process.env.CHAT_DB ?? join(homedir(), "Library", "Application Support", "OpenCode Models", "chat.db");
const MAX_FILE = 20 * 1024 * 1024;
const MAX_TEXT_FILE = 2 * 1024 * 1024; // tekst idzie do modelu w całości, więc limit jest niższy
const PDF_ENGINES = ["cloudflare-ai", "mistral-ocr", "native"];
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const TEXT_EXT = /\.(csv|tsv|txt|md|json|xml|log)$/i;

const SYSTEM_PROMPT = `Jesteś pomocnym asystentem. Odpowiadasz w języku użytkownika, rzeczowo i zwięźle.
Gdy coś liczysz, pokazujesz obliczenia i podajesz założenia wprost.
Gdy brakuje danych albo informacja mogła się zdezaktualizować, mówisz o tym zamiast zgadywać.
Do porównań używasz tabel w Markdownie.`;

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH, { create: true });
db.run("PRAGMA foreign_keys = ON");
db.run("PRAGMA journal_mode = WAL");
db.run(`CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
db.run(`CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', reasoning TEXT, files TEXT, annotations TEXT,
  model TEXT, provider TEXT, usage TEXT, cost REAL, status TEXT NOT NULL DEFAULT 'ok', error TEXT,
  created INTEGER NOT NULL)`);
db.run("CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id, created)");
db.run(`CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
  name TEXT NOT NULL, mime TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL,
  created INTEGER NOT NULL)`);
// Rozmowa założona ze streszczenia pamięta, z której powstała.
const chatColumns = (db.query("PRAGMA table_info(chats)").all() as { name: string }[]).map((c) => c.name);
if (!chatColumns.includes("parent_id")) db.run("ALTER TABLE chats ADD COLUMN parent_id TEXT");
// Pliki dodane do pola wiadomości, ale nigdy niewysłane.
db.run("DELETE FROM files WHERE chat_id IS NULL AND created < ?", [Date.now() - 24 * 3600_000]);

export const CHAT_DB = DB_PATH;

// --- Klucz API ---

// Klucz z OPENROUTER_API_KEY albo ten, który zapisał OpenCode. Zostaje na serwerze.
async function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const dataDir = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const auth = Bun.file(join(dataDir, "opencode", "auth.json"));
  const key = (await auth.exists()) ? (await auth.json()).openrouter?.key : null;
  if (!key) throw new Error("Brak klucza OpenRoutera. Ustaw OPENROUTER_API_KEY albo zaloguj się w OpenCode (opencode auth login).");
  return key as string;
}

const completions = async (request: object, signal?: AbortSignal) => fetch(OPENROUTER + "/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${await apiKey()}`, "content-type": "application/json" },
  body: JSON.stringify(request),
  signal,
});

async function errorText(res: Response) {
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  return `OpenRouter ${res.status}: ${json.error?.message ?? res.statusText}`;
}

// --- Rozmowy ---

type MessageRow = {
  id: string; chat_id: string; role: "user" | "assistant" | "summary"; text: string; reasoning: string | null;
  files: string | null; annotations: string | null; model: string | null; provider: string | null;
  usage: string | null; cost: number | null; status: "ok" | "aborted" | "error"; error: string | null; created: number;
};

const fileMeta = db.query("SELECT id, name, mime, kind, size FROM files WHERE id = ?");

function messageView(m: MessageRow) {
  const ids: string[] = JSON.parse(m.files ?? "[]");
  return {
    id: m.id, role: m.role, text: m.text, reasoning: m.reasoning, model: m.model, provider: m.provider,
    usage: m.usage ? JSON.parse(m.usage) : null, cost: m.cost, status: m.status, error: m.error, created: m.created,
    files: ids.map((id) => fileMeta.get(id)).filter(Boolean),
  };
}

const messageById = (id: string) => messageView(db.query("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow);

export const listChats = () => db.query(`
  SELECT c.id, c.title, c.model, c.updated, (SELECT SUM(cost) FROM messages WHERE chat_id = c.id) AS cost
  FROM chats c ORDER BY c.updated DESC`).all();

export function getChat(id: string) {
  const chat = db.query(`SELECT c.id, c.title, c.model, c.created, c.updated, c.parent_id,
    (SELECT title FROM chats p WHERE p.id = c.parent_id) AS parent_title FROM chats c WHERE c.id = ?`).get(id);
  if (!chat) throw new Error("Nie ma takiej rozmowy");
  const rows = db.query("SELECT * FROM messages WHERE chat_id = ? ORDER BY created, rowid").all(id) as MessageRow[];
  return { chat, messages: rows.map(messageView) };
}

export function deleteChat(id: string) {
  db.run("DELETE FROM chats WHERE id = ?", [id]);
  return { ok: true };
}

// --- Pliki ---

function kindOf(name: string, mime: string) {
  if (IMAGE_TYPES.includes(mime)) return "image";
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (mime.startsWith("text/") || mime === "application/json" || TEXT_EXT.test(name)) return "text";
  return null;
}

export async function uploadFile(req: Request) {
  const name = decodeURIComponent(req.headers.get("x-file-name") ?? "plik").slice(0, 200);
  const mime = req.headers.get("x-file-type") || "application/octet-stream";
  const kind = kindOf(name, mime);
  if (!kind) throw new Error(`Nieobsługiwany typ pliku: ${name}. Można dodać obrazki (PNG, JPG, WebP, GIF), PDF i pliki tekstowe (CSV, TXT, MD, JSON).`);
  const data = new Uint8Array(await req.arrayBuffer());
  const limit = kind === "text" ? MAX_TEXT_FILE : MAX_FILE;
  if (data.byteLength > limit) throw new Error(`${name} jest za duży (limit ${limit / 1024 / 1024} MB).`);
  const id = crypto.randomUUID();
  db.run("INSERT INTO files (id, name, mime, kind, size, data, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, name, kind === "pdf" ? "application/pdf" : mime, kind, data.byteLength, data, Date.now()]);
  return { id, name, mime, kind, size: data.byteLength };
}

export function fileResponse(id: string) {
  const f = db.query("SELECT name, mime, kind, data FROM files WHERE id = ?").get(id) as any;
  if (!f) return new Response("Nie ma takiego pliku", { status: 404 });
  const text = f.kind === "text";
  return new Response(text ? decodeText(f.data) : f.data, {
    headers: {
      // Tekst zawsze jako zwykły tekst w izolacji, żeby przeglądarka niczego z pliku nie uruchomiła.
      // PDF bez `sandbox`, bo blokuje wbudowaną przeglądarkę PDF-ów.
      "content-type": text ? "text/plain; charset=utf-8" : f.mime,
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      "x-content-type-options": "nosniff",
      ...(text ? { "content-security-policy": "sandbox" } : {}),
    },
  });
}

// Polskie banki często eksportują CSV w Windows-1250, a nie w UTF-8.
// Nigdy nie rzuca: plik, którego nie da się odczytać, nie może zablokować całej rozmowy.
function decodeText(data: Uint8Array) {
  for (const label of ["utf-8", "windows-1250"]) {
    try {
      return new TextDecoder(label, { fatal: true }).decode(data);
    } catch {}
  }
  return new TextDecoder("utf-8").decode(data);
}

const fileData = db.query("SELECT name, mime, kind, data FROM files WHERE id = ?");

function filePart(id: string) {
  const f = fileData.get(id) as { name: string; mime: string; kind: string; data: Uint8Array } | null;
  if (!f) return { type: "text", text: "[Załącznik został usunięty]" };
  if (f.kind === "text") return { type: "text", text: `Załącznik ${f.name}:\n\n${decodeText(f.data)}` };
  const url = `data:${f.mime};base64,${Buffer.from(f.data).toString("base64")}`;
  if (f.kind === "image") return { type: "image_url", image_url: { url } };
  return { type: "file", file: { filename: f.name, file_data: url } };
}

// Historia w formacie OpenRoutera. Adnotacje z rozpoznanych PDF-ów wracają przy odpowiedziach,
// dzięki czemu OpenRouter nie rozpoznaje tego samego pliku drugi raz.
function history(chatId: string) {
  const rows = db.query("SELECT * FROM messages WHERE chat_id = ? AND status != 'error' ORDER BY created, rowid")
    .all(chatId) as MessageRow[];
  const today = new Date().toISOString().slice(0, 10);
  const out: any[] = [{ role: "system", content: `${SYSTEM_PROMPT}\nDzisiejsza data: ${today}.` }];
  let pdf = false;
  for (const m of rows) {
    // Rozmowa założona ze streszczenia: streszczenie jest częścią instrukcji, a nie wiadomością.
    if (m.role === "summary") {
      out[0].content += `\n\nTo kontynuacja wcześniejszej rozmowy. Jej streszczenie:\n\n${m.text}`;
      continue;
    }
    if (m.role === "assistant") {
      // Odpowiedź przerwana przed pierwszym tokenem jest pusta, a część providerów (np. Anthropic) odrzuca puste wiadomości.
      if (!m.text.trim()) continue;
      out.push({ role: "assistant", content: m.text, ...(m.annotations ? { annotations: JSON.parse(m.annotations) } : {}) });
      continue;
    }
    const ids: string[] = JSON.parse(m.files ?? "[]");
    if (!ids.length) {
      out.push({ role: "user", content: m.text });
      continue;
    }
    const parts = ids.map(filePart);
    pdf ||= parts.some((p) => p.type === "file");
    out.push({ role: "user", content: [...(m.text ? [{ type: "text", text: m.text }] : []), ...parts] });
  }
  return { messages: out, pdf };
}

// --- Wysyłanie wiadomości ---

type SendBody = { chatId?: string; model: string; text?: string; files?: string[]; pdfEngine?: string; retry?: boolean };

const now = () => Date.now();

function prepare(body: SendBody) {
  const text = (body.text ?? "").trim();
  const files = (body.files ?? []).filter((id) => typeof id === "string");
  let chatId = body.chatId;
  if (chatId && !db.query("SELECT 1 FROM chats WHERE id = ?").get(chatId)) throw new Error("Nie ma takiej rozmowy");
  if (body.retry) {
    if (!chatId) throw new Error("Brak rozmowy do ponowienia");
    // Usuwa nieudaną odpowiedź po ostatniej wiadomości użytkownika.
    db.run(`DELETE FROM messages WHERE chat_id = ? AND role = 'assistant' AND created >=
      (SELECT MAX(created) FROM messages WHERE chat_id = ? AND role = 'user')`, [chatId, chatId]);
    return { chatId, user: null };
  }
  if (!text && !files.length) throw new Error("Pusta wiadomość");
  if (!chatId) {
    const firstFile = files.length ? (fileMeta.get(files[0]) as { name: string } | null)?.name : null;
    const title = (text.split("\n")[0] || firstFile || "Nowa rozmowa").slice(0, 80);
    chatId = crypto.randomUUID();
    db.run("INSERT INTO chats (id, title, model, created, updated) VALUES (?, ?, ?, ?, ?)", [chatId, title, body.model, now(), now()]);
  }
  const userId = crypto.randomUUID();
  db.run("INSERT INTO messages (id, chat_id, role, text, files, created) VALUES (?, ?, 'user', ?, ?, ?)",
    [userId, chatId, text, JSON.stringify(files), now()]);
  for (const id of files) db.run("UPDATE files SET chat_id = ? WHERE id = ? AND chat_id IS NULL", [chatId, id]);
  return { chatId, user: userId };
}

// Odpowiedź do przeglądarki to NDJSON: jedna linia = jedno zdarzenie (chat, user, meta, reasoning, content, done).
export function send(body: SendBody, provider: unknown, signal: AbortSignal) {
  // Jeśli zbudowanie zapytania się nie uda, wiadomość użytkownika nie zostaje w bazie.
  const { chatId, user, messages, pdf } = db.transaction(() => {
    const { chatId, user } = prepare(body);
    db.run("UPDATE chats SET model = ?, updated = ? WHERE id = ?", [body.model, now(), chatId]);
    return { chatId, user, ...history(chatId) };
  })();
  const engine = PDF_ENGINES.includes(body.pdfEngine ?? "") ? body.pdfEngine : "cloudflare-ai";
  const request = {
    model: body.model,
    messages,
    stream: true,
    ...(provider ? { provider } : {}),
    ...(pdf ? { plugins: [{ id: "file-parser", pdf: { engine } }] } : {}),
  };

  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const emit = (event: object) => {
        try {
          controller.enqueue(enc.encode(JSON.stringify(event) + "\n"));
        } catch {} // przeglądarka mogła już zamknąć połączenie
      };
      emit({ type: "chat", chat: db.query("SELECT id, title, model, updated FROM chats WHERE id = ?").get(chatId) });
      if (user) emit({ type: "user", message: messageById(user) });

      const out = { text: "", reasoning: "", provider: null as string | null, usage: null as any, annotations: [] as any[] };
      let status: MessageRow["status"] = "ok";
      let error: string | null = null;
      try {
        await stream(request, signal, out, emit);
      } catch (e) {
        if (signal.aborted) status = "aborted";
        else {
          status = "error";
          error = (e as Error).message;
        }
      }
      const id = crypto.randomUUID();
      db.run(`INSERT INTO messages (id, chat_id, role, text, reasoning, annotations, model, provider, usage, cost, status, error, created)
        VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id, chatId, out.text, out.reasoning || null, out.annotations.length ? JSON.stringify(out.annotations) : null,
        body.model, out.provider, out.usage ? JSON.stringify(out.usage) : null, out.usage?.cost ?? null, status, error, now(),
      ]);
      db.run("UPDATE chats SET updated = ? WHERE id = ?", [now(), chatId]);
      emit({ type: "done", message: messageById(id) });
      try {
        controller.close();
      } catch {}
    },
  });
}

// --- Streszczanie długiej rozmowy do nowej ---

const SUMMARY_PROMPT = `Streść całą tę rozmowę tak, żeby dało się ją kontynuować w nowej rozmowie bez dostępu do starej.
Zachowaj: cel rozmowy, wszystkie ustalenia i decyzje, ważne liczby, kwoty, daty i założenia oraz otwarte pytania.
Wymień załączniki z nazwy razem z najważniejszymi danymi z nich.
Pisz zwięźle, w punktach, w języku rozmowy. Nie dodawaj niczego, czego nie było w rozmowie.`;

// Streszczenie zostaje zapisane jako pierwszy element nowej rozmowy; stara zostaje bez zmian.
export async function summarize(chatId: string, model: string, provider: unknown, signal?: AbortSignal) {
  const source = db.query("SELECT title FROM chats WHERE id = ?").get(chatId) as { title: string } | null;
  if (!source) throw new Error("Nie ma takiej rozmowy");
  const { messages, pdf } = history(chatId);
  if (!messages.some((m) => m.role === "assistant")) throw new Error("Rozmowa nie ma jeszcze odpowiedzi do streszczenia");
  messages.push({ role: "user", content: SUMMARY_PROMPT });
  const res = await completions({
    model, messages,
    ...(provider ? { provider } : {}),
    // PDF-y są już rozpoznane (adnotacje w historii), więc silnik nie ma znaczenia dla kosztu.
    ...(pdf ? { plugins: [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }] } : {}),
  }, signal);
  if (!res.ok) throw new Error(await errorText(res));
  const json = (await res.json()) as any;
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Model nie zwrócił streszczenia. Spróbuj ponownie.");

  const id = crypto.randomUUID();
  const title = `${source.title.replace(/ \(cd\.\)$/, "")} (cd.)`.slice(0, 80);
  db.transaction(() => {
    db.run("INSERT INTO chats (id, title, model, created, updated, parent_id) VALUES (?, ?, ?, ?, ?, ?)",
      [id, title, model, now(), now(), chatId]);
    db.run(`INSERT INTO messages (id, chat_id, role, text, model, provider, usage, cost, created)
      VALUES (?, ?, 'summary', ?, ?, ?, ?, ?, ?)`, [
      crypto.randomUUID(), id, text, model, json.provider ?? null,
      json.usage ? JSON.stringify(json.usage) : null, json.usage?.cost ?? null, now(),
    ]);
  })();
  return db.query("SELECT id, title, model, updated FROM chats WHERE id = ?").get(id);
}

async function stream(request: object, signal: AbortSignal, out: any, emit: (e: object) => void) {
  const res = await completions(request, signal);
  if (!res.ok || !res.body) throw new Error(await errorText(res));
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      // Linie zaczynające się od „:” to komentarze SSE (np. „OPENROUTER PROCESSING” przy rozpoznawaniu PDF-u).
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      const c = JSON.parse(data);
      if (c.error) throw new Error(c.error.message ?? "Błąd providera");
      if (c.provider && !out.provider) {
        out.provider = c.provider;
        emit({ type: "meta", provider: c.provider });
      }
      if (c.usage) out.usage = c.usage;
      const d = c.choices?.[0]?.delta ?? {};
      if (d.reasoning) {
        out.reasoning += d.reasoning;
        emit({ type: "reasoning", text: d.reasoning });
      }
      if (d.content) {
        out.text += d.content;
        emit({ type: "content", text: d.content });
      }
      for (const a of d.annotations ?? []) {
        if (a?.type === "file" && !out.annotations.some((b: any) => b.file?.hash === a.file?.hash)) out.annotations.push(a);
      }
    }
  }
}
