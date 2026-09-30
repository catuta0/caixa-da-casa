// Caixa da Casa — servidor.
// Guarda tudo numa base de dados SQLite (pasta DATA_DIR) e as fotos dos talões em DATA_DIR/fotos.
// As permissões são verificadas aqui, no servidor: pendentes não veem nada, membros só registam
// compras (e anulam/juntam talões às suas), tesoureiros fazem o resto, e o admin gere os membros.

import express from "express";
import multer from "multer";
import { OAuth2Client } from "google-auth-library";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "dados"));
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const ADMIN_EMAILS = (process.env.ADMIN_EMAIL || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const NOME_CASA = process.env.NOME_CASA || "Casa comunitária";
const DEV_LOGIN = process.env.DEV_LOGIN === "1";
const COOKIE_SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "1" : process.env.NODE_ENV === "production";
const SESSAO_DIAS = 60;
const COOKIE = "caixa_sessao";

fs.mkdirSync(path.join(DATA_DIR, "fotos"), { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "caixa.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS utilizadores (
    id TEXT PRIMARY KEY,
    google_sub TEXT UNIQUE,
    email TEXT UNIQUE NOT NULL,
    nome TEXT NOT NULL,
    foto TEXT,
    tipo TEXT NOT NULL DEFAULT 'pendente',
    tesoureiro INTEGER NOT NULL DEFAULT 0,
    admin INTEGER NOT NULL DEFAULT 0,
    bloqueado INTEGER NOT NULL DEFAULT 0,
    valor_fixo INTEGER,
    entrada TEXT,
    saida TEXT,
    criado_em TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessoes (
    token_hash TEXT PRIMARY KEY,
    utilizador_id TEXT NOT NULL REFERENCES utilizadores(id) ON DELETE CASCADE,
    expira TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS movimentos (
    id TEXT PRIMARY KEY,
    mes TEXT NOT NULL,
    criado_em TEXT NOT NULL,
    dados TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS config (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fotos (
    id TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    ficheiro TEXT NOT NULL,
    criado_por TEXT,
    criado_em TEXT NOT NULL
  );
`);

/* ---------- utilitários ---------- */
const agora = () => new Date().toISOString();
const novoId = () => crypto.randomBytes(12).toString("base64url");
const hash = t => crypto.createHash("sha256").update(t).digest("hex");
const TIPOS = ["pendente", "visitante", "morador", "comensal", "meio"];
const APROVADOS = ["visitante", "morador", "comensal", "meio"];
const reMes = /^\d{4}-(0[1-9]|1[0-2])$/;
const reData = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const txt = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

class ErroHttp extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const falha = (status, msg) => { throw new ErroHttp(status, msg); };

const eAprovado = u => !!u && !u.bloqueado && (!!u.admin || APROVADOS.includes(u.tipo));
const eTes = u => eAprovado(u) && (!!u.admin || !!u.tesoureiro);

function utilPublico(u, completo) {
  const p = {
    id: u.id, nome: u.nome, foto: u.foto || null, tipo: u.tipo,
    tesoureiro: !!(u.tesoureiro || u.admin), admin: !!u.admin, bloqueado: !!u.bloqueado,
    valorFixo: u.valor_fixo ?? null, entrada: u.entrada || null, saida: u.saida || null,
  };
  if (completo) { p.email = u.email; p.criadoEm = u.criado_em; }
  return p;
}

function lerConfig() {
  const r = db.prepare("SELECT valor FROM config WHERE chave = 'casa'").get();
  return r ? JSON.parse(r.valor) : null;
}
function gravarConfig(c) {
  db.prepare("INSERT INTO config (chave, valor) VALUES ('casa', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor")
    .run(JSON.stringify(c));
}
const utilPorId = id => (typeof id === "string" && id ? db.prepare("SELECT * FROM utilizadores WHERE id = ?").get(id) : undefined);

/* ---------- sessões ---------- */
function lerCookie(req, nome) {
  for (const parte of (req.headers.cookie || "").split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === nome) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}
function definirCookie(res, valor, maxAge) {
  res.setHeader("Set-Cookie", `${COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${COOKIE_SECURE ? "; Secure" : ""}`);
}
function criarSessao(res, utilizadorId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expira = new Date(Date.now() + SESSAO_DIAS * 864e5).toISOString();
  db.prepare("INSERT INTO sessoes (token_hash, utilizador_id, expira) VALUES (?, ?, ?)").run(hash(token), utilizadorId, expira);
  definirCookie(res, token, SESSAO_DIAS * 86400);
}
function autenticar(req, _res, next) {
  const token = lerCookie(req, COOKIE);
  if (token) {
    const u = db.prepare(`SELECT u.* FROM sessoes s JOIN utilizadores u ON u.id = s.utilizador_id
                          WHERE s.token_hash = ? AND s.expira > ?`).get(hash(token), agora());
    if (u && !u.bloqueado) req.user = u;
  }
  next();
}
const precisa = nivel => (req, res, next) => {
  const u = req.user;
  if (!u) return res.status(401).json({ erro: "Precisas de entrar." });
  if (nivel === "aprovado" && !eAprovado(u)) return res.status(403).json({ erro: "A tua conta ainda não foi aprovada." });
  if (nivel === "tesoureiro" && !eTes(u)) return res.status(403).json({ erro: "Só os tesoureiros podem fazer isto." });
  if (nivel === "admin" && !u.admin) return res.status(403).json({ erro: "Só o administrador pode fazer isto." });
  next();
};

/* entra (ou cria) o utilizador que o Google confirmou */
function entrarUtilizador({ sub, email, nome, foto }) {
  email = email.toLowerCase();
  let u = (sub && db.prepare("SELECT * FROM utilizadores WHERE google_sub = ?").get(sub))
       || db.prepare("SELECT * FROM utilizadores WHERE email = ?").get(email);
  const eAdmin = ADMIN_EMAILS.includes(email)
    || (!ADMIN_EMAILS.length && db.prepare("SELECT COUNT(*) AS n FROM utilizadores").get().n === 0);
  if (!u) {
    const id = novoId();
    db.prepare(`INSERT INTO utilizadores (id, google_sub, email, nome, foto, tipo, admin, tesoureiro, criado_em)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, sub || null, email, txt(nome, 80) || email, foto || null, eAdmin ? "visitante" : "pendente", eAdmin ? 1 : 0, eAdmin ? 1 : 0, agora());
    u = utilPorId(id);
    avisar(); // o admin vê logo o pedido novo
  } else {
    db.prepare("UPDATE utilizadores SET google_sub = COALESCE(google_sub, ?), foto = COALESCE(?, foto) WHERE id = ?").run(sub || null, foto || null, u.id);
    if (eAdmin && (!u.admin || u.bloqueado)) db.prepare("UPDATE utilizadores SET admin = 1, tesoureiro = 1, bloqueado = 0, tipo = CASE WHEN tipo = 'pendente' THEN 'visitante' ELSE tipo END WHERE id = ?").run(u.id);
    u = utilPorId(u.id);
  }
  return u;
}

/* ---------- avisos em tempo real (Server-Sent Events) ---------- */
const clientes = new Set();
function avisar() { for (const c of clientes) c.write("data: mudou\n\n"); }
setInterval(() => { for (const c of clientes) c.write(": ping\n\n"); }, 25000).unref();

/* ---------- validação ---------- */
function fotosValidas(lista) {
  if (!Array.isArray(lista)) return [];
  const out = [];
  for (const f of lista.slice(0, 8)) {
    const id = typeof f === "string" ? f : f && f.id;
    const r = typeof id === "string" && db.prepare("SELECT id, mime FROM fotos WHERE id = ?").get(id);
    if (r) out.push({ id: r.id, pdf: r.mime === "application/pdf" });
  }
  return out;
}
function novoMovimento(b, u) {
  const tes = eTes(u);
  const tipo = b.tipo;
  if (!["compra", "conta", "renda", "fundo"].includes(tipo)) falha(400, "Tipo de registo inválido.");
  if (!tes && tipo !== "compra") falha(403, "Só os tesoureiros podem registar isto.");
  if (!Number.isInteger(b.cent) || b.cent <= 0 || b.cent > 1e9) falha(400, "Valor inválido.");
  if (!reMes.test(b.mes || "") || !reData.test(b.data || "")) falha(400, "Data inválida.");
  const m = { tipo, mes: b.mes, data: b.data, cent: b.cent, descricao: txt(b.descricao, 200) };
  if (tipo === "compra" || tipo === "conta") {
    m.pagoPor = b.pagoPor === "fundo" ? "fundo" : "bolso";
    m.reembolsado = false;
    const quem = tes ? utilPorId(b.morador) : u;
    m.morador = quem ? quem.id : "";
    m.moradorNome = quem ? quem.nome : "";
    if (m.pagoPor === "bolso" && !m.morador) falha(400, "Diz quem pagou do bolso.");
    if (tipo === "conta") m.categoria = txt(b.categoria, 60) || "Outra";
  }
  if (tipo === "renda") {
    const quem = utilPorId(b.morador);
    if (!quem) falha(400, "Escolhe a pessoa que pagou.");
    m.morador = quem.id; m.moradorNome = quem.nome;
  }
  if (tipo === "fundo") {
    m.sentido = b.sentido === "saida" ? "saida" : "entrada";
    if (!m.descricao) falha(400, "Escreve uma descrição.");
  }
  m.fotos = fotosValidas(b.fotos);
  m.criadoPor = u.id;
  m.criadoEm = agora();
  m.anulado = false;
  return m;
}
const CHAVES_CONFIG = {
  nome: "string", plafond: "int", fundoInicial: "int", rendasNoFundo: "bool", anoInicio: "intnull",
  plafondMes: "obj", rendaMes: "obj", previsaoMes: "obj", divisaoMes: "obj", ajustesMes: "obj",
  despesas: "arr", comensalLinhas: "arr",
};
function mudancasConfig(b) {
  const out = {};
  for (const [k, v] of Object.entries(b || {})) {
    const t = CHAVES_CONFIG[k];
    if (!t) continue;
    const ok = (t === "string" && typeof v === "string")
      || (t === "int" && Number.isInteger(v) && Math.abs(v) <= 1e10)
      || (t === "intnull" && (v === null || Number.isInteger(v)))
      || (t === "bool" && typeof v === "boolean")
      || (t === "obj" && v && typeof v === "object" && !Array.isArray(v))
      || (t === "arr" && Array.isArray(v));
    if (!ok) falha(400, `Valor inválido em ${k}.`);
    out[k] = t === "string" ? v.slice(0, 80) : v;
  }
  return out;
}
function tipoFicheiro(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ["image/jpeg", "jpg"];
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ["image/png", "png"];
  if (b.subarray(0, 4).toString("latin1") === "GIF8") return ["image/gif", "gif"];
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return ["image/webp", "webp"];
  if (b.subarray(0, 5).toString("latin1") === "%PDF-") return ["application/pdf", "pdf"];
  return null;
}

/* ---------- aplicação ---------- */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY || "loopback, linklocal, uniquelocal");
app.use((_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  });
  next();
});
app.use(express.json({ limit: "2mb" }));
app.use(autenticar);

const loopback = req => {
  const ip = req.socket.remoteAddress || "";
  return !req.headers["x-forwarded-for"] && (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1");
};

app.get("/api/publico", (req, res) => {
  const c = lerConfig();
  res.json({ googleClientId: GOOGLE_CLIENT_ID, nomeCasa: (c && c.nome) || NOME_CASA, devLogin: DEV_LOGIN && loopback(req) });
});

const google = new OAuth2Client(GOOGLE_CLIENT_ID);
app.post("/api/entrar/google", async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(500).json({ erro: "O servidor não tem GOOGLE_CLIENT_ID configurado." });
  const credential = req.body && req.body.credential;
  if (typeof credential !== "string") return res.status(400).json({ erro: "Falta a credencial do Google." });
  let p;
  try {
    const ticket = await google.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    p = ticket.getPayload();
  } catch {
    return res.status(401).json({ erro: "Não foi possível confirmar a conta Google. Tenta outra vez." });
  }
  if (!p || !p.email || !p.email_verified) return res.status(403).json({ erro: "A conta Google não tem um email confirmado." });
  const u = entrarUtilizador({ sub: p.sub, email: p.email, nome: p.name, foto: p.picture });
  if (u.bloqueado) return res.status(403).json({ erro: "Esta conta não tem acesso. Fala com o administrador da casa." });
  criarSessao(res, u.id);
  res.json({ eu: utilPublico(u, true) });
});

// Só para testar no próprio computador (DEV_LOGIN=1): entra sem Google. Nunca ligar em produção.
app.post("/api/entrar/dev", (req, res) => {
  if (!DEV_LOGIN || !loopback(req)) return res.status(404).json({ erro: "Não existe." });
  const email = txt(req.body && req.body.email, 120).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return res.status(400).json({ erro: "Email inválido." });
  const u = entrarUtilizador({ sub: null, email, nome: txt(req.body.nome, 80) || email.split("@")[0], foto: null });
  if (u.bloqueado) return res.status(403).json({ erro: "Esta conta não tem acesso. Fala com o administrador da casa." });
  criarSessao(res, u.id);
  res.json({ eu: utilPublico(u, true) });
});

app.post("/api/sair", (req, res) => {
  const token = lerCookie(req, COOKIE);
  if (token) db.prepare("DELETE FROM sessoes WHERE token_hash = ?").run(hash(token));
  definirCookie(res, "", 0);
  res.json({ ok: true });
});

app.get("/api/eu", precisa("sessao"), (req, res) => {
  res.json({ eu: utilPublico(req.user, true), aprovado: eAprovado(req.user) });
});

app.get("/api/estado", precisa("aprovado"), (req, res) => {
  const admin = !!req.user.admin;
  const users = db.prepare("SELECT * FROM utilizadores ORDER BY nome COLLATE NOCASE").all()
    .filter(u => admin || u.tipo !== "pendente")
    .map(u => utilPublico(u, admin));
  const movimentos = db.prepare("SELECT id, dados FROM movimentos ORDER BY criado_em").all()
    .map(r => Object.assign(JSON.parse(r.dados), { id: r.id }));
  res.json({ eu: utilPublico(req.user, true), config: lerConfig() || {}, utilizadores: users, movimentos });
});

app.get("/api/eventos", precisa("aprovado"), (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 5000\n\n");
  clientes.add(res);
  req.on("close", () => clientes.delete(res));
});

app.post("/api/movimentos", precisa("aprovado"), (req, res) => {
  const m = novoMovimento(req.body || {}, req.user);
  const id = novoId();
  db.prepare("INSERT INTO movimentos (id, mes, criado_em, dados) VALUES (?, ?, ?, ?)").run(id, m.mes, m.criadoEm, JSON.stringify(m));
  avisar();
  res.status(201).json(Object.assign(m, { id }));
});

app.patch("/api/movimentos/:id", precisa("aprovado"), (req, res) => {
  const row = db.prepare("SELECT dados FROM movimentos WHERE id = ?").get(req.params.id);
  if (!row) falha(404, "Registo não encontrado.");
  const m = JSON.parse(row.dados), b = req.body || {}, u = req.user;
  const tes = eTes(u), meuCompra = m.criadoPor === u.id && m.tipo === "compra";
  if (b.anulado === true) {
    if (!tes && !meuCompra) falha(403, "Só podes anular as tuas compras.");
    if (!m.anulado) Object.assign(m, { anulado: true, anuladoPor: u.id, anuladoEm: agora() });
  }
  if (b.reembolsado === true) {
    if (!tes) falha(403, "Só os tesoureiros podem pagar em dinheiro.");
    if (!["compra", "conta"].includes(m.tipo) || m.pagoPor !== "bolso") falha(400, "Este registo não foi pago do bolso.");
    if (!m.reembolsado) Object.assign(m, { reembolsado: true, reembolsadoEm: agora() });
  }
  if (Array.isArray(b.fotosNovas)) {
    if (!tes && !meuCompra) falha(403, "Só podes juntar talões às tuas compras.");
    m.fotos = (m.fotos || []).concat(fotosValidas(b.fotosNovas)).slice(0, 8);
  }
  db.prepare("UPDATE movimentos SET dados = ? WHERE id = ?").run(JSON.stringify(m), req.params.id);
  avisar();
  res.json(Object.assign(m, { id: req.params.id }));
});

app.put("/api/config", precisa("tesoureiro"), (req, res) => {
  const c = Object.assign(lerConfig() || {}, mudancasConfig(req.body));
  if (JSON.stringify(c).length > 1_000_000) falha(413, "As definições ficaram grandes demais.");
  gravarConfig(c);
  avisar();
  res.json(c);
});

app.patch("/api/utilizadores/:id", precisa("admin"), (req, res) => {
  const u = utilPorId(req.params.id);
  if (!u) falha(404, "Pessoa não encontrada.");
  const b = req.body || {}, mud = {};
  if ("nome" in b) { mud.nome = txt(b.nome, 80); if (!mud.nome) falha(400, "O nome não pode ficar vazio."); }
  if ("tipo" in b) {
    if (!TIPOS.includes(b.tipo)) falha(400, "Tipo inválido.");
    if (u.admin && b.tipo === "pendente") falha(400, "O administrador não pode ficar pendente.");
    mud.tipo = b.tipo;
  }
  if ("bloqueado" in b) {
    if (u.admin && b.bloqueado) falha(400, "O administrador não pode ser bloqueado.");
    mud.bloqueado = b.bloqueado ? 1 : 0;
  }
  if ("tesoureiro" in b) mud.tesoureiro = b.tesoureiro ? 1 : 0;
  if ("valorFixo" in b) {
    if (b.valorFixo !== null && (!Number.isInteger(b.valorFixo) || b.valorFixo < 0 || b.valorFixo > 1e8)) falha(400, "Valor fixo inválido.");
    mud.valor_fixo = b.valorFixo;
  }
  for (const k of ["entrada", "saida"]) {
    if (k in b) {
      if (b[k] !== null && !reMes.test(b[k])) falha(400, "Mês inválido.");
      mud[k] = b[k];
    }
  }
  const cols = Object.keys(mud);
  if (cols.length) {
    db.prepare(`UPDATE utilizadores SET ${cols.map(c => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map(c => mud[c]), u.id);
    if (mud.bloqueado) db.prepare("DELETE FROM sessoes WHERE utilizador_id = ?").run(u.id);
    avisar();
  }
  res.json(utilPublico(utilPorId(u.id), true));
});

app.delete("/api/utilizadores/:id", precisa("admin"), (req, res) => {
  const u = utilPorId(req.params.id);
  if (!u) falha(404, "Pessoa não encontrada.");
  if (u.tipo !== "pendente") falha(400, "Só se podem apagar pedidos pendentes. Para tirar o acesso a alguém, bloqueia a conta.");
  db.prepare("DELETE FROM utilizadores WHERE id = ?").run(u.id);
  avisar();
  res.json({ ok: true });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1 } });
app.post("/api/fotos", precisa("aprovado"), upload.single("foto"), (req, res) => {
  if (!req.file) falha(400, "Falta o ficheiro.");
  const t = tipoFicheiro(req.file.buffer);
  if (!t) falha(415, "Esse ficheiro não dá. Usa uma foto (JPG, PNG, WEBP) ou um PDF.");
  const id = crypto.randomBytes(16).toString("hex");
  const ficheiro = `${id}.${t[1]}`;
  fs.writeFileSync(path.join(DATA_DIR, "fotos", ficheiro), req.file.buffer);
  db.prepare("INSERT INTO fotos (id, mime, ficheiro, criado_por, criado_em) VALUES (?, ?, ?, ?, ?)").run(id, t[0], ficheiro, req.user.id, agora());
  res.status(201).json({ id, pdf: t[0] === "application/pdf" });
});

app.get("/api/fotos/:id", precisa("aprovado"), (req, res) => {
  const r = db.prepare("SELECT mime, ficheiro FROM fotos WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).end();
  res.set({ "Content-Type": r.mime, "Cache-Control": "private, max-age=31536000, immutable", "Content-Disposition": "inline" });
  res.sendFile(path.join(DATA_DIR, "fotos", r.ficheiro));
});

// Cópia de segurança da base de dados (não inclui as fotos; essas estão em DATA_DIR/fotos).
app.get("/api/copia-seguranca", precisa("admin"), (_req, res) => {
  const tmp = path.join(DATA_DIR, `copia-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  res.download(tmp, `caixa-da-casa-${agora().slice(0, 10)}.db`, () => fs.rm(tmp, { force: true }, () => {}));
});

app.use("/api", (_req, res) => res.status(404).json({ erro: "Não existe." }));
app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));

app.use((err, _req, res, _next) => {
  if (err instanceof ErroHttp) return res.status(err.status).json({ erro: err.message });
  if (err instanceof multer.MulterError) {
    return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ erro: err.code === "LIMIT_FILE_SIZE" ? "A foto é grande demais (máximo 12 MB)." : "Envio inválido." });
  }
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ erro: "Pedido inválido." });
  console.error(err);
  res.status(500).json({ erro: "Erro no servidor." });
});

// Limpa sessões expiradas uma vez por dia.
setInterval(() => db.prepare("DELETE FROM sessoes WHERE expira < ?").run(agora()), 864e5).unref();

const servidor = app.listen(PORT, () => {
  console.log(`Caixa da Casa a correr na porta ${PORT} (dados em ${DATA_DIR})`);
  if (!GOOGLE_CLIENT_ID) console.warn("Aviso: GOOGLE_CLIENT_ID não está definido; o login com Google não vai funcionar.");
  if (DEV_LOGIN) console.warn("Aviso: DEV_LOGIN=1 — login de teste ligado (só funciona a partir deste computador).");
});
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { servidor.close(); db.close(); process.exit(0); });
