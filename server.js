// Caixa da Casa — servidor.
// Guarda tudo numa base de dados SQLite (pasta DATA_DIR) e as fotos dos talões em DATA_DIR/fotos.
//
// Quem tem o link vê tudo e regista compras, sem conta (cada aparelho fica identificado por um
// cookie, para poder anular ou juntar talões às compras que registou). Só os tesoureiros entram
// com Google; um tesoureiro novo fica à espera até outro tesoureiro o aprovar, a não ser que ainda
// não haja nenhum. As permissões são verificadas aqui, no servidor.

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
// Emails aprovados logo como tesoureiros (opcional). ADMIN_EMAIL é o nome antigo.
const TESOUREIROS_EMAILS = (process.env.TESOUREIRO_EMAIL || process.env.ADMIN_EMAIL || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const NOME_CASA = process.env.NOME_CASA || "Casa comunitária";
const DEV_LOGIN = process.env.DEV_LOGIN === "1";
const COOKIE_SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "1" : process.env.NODE_ENV === "production";
const SESSAO_DIAS = 60;
const COOKIE = "caixa_sessao";
const COOKIE_DISP = "caixa_disp";

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
    estado TEXT NOT NULL DEFAULT 'pendente',
    aprovado_por TEXT,
    criado_em TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pessoas (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'morador',
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

// Migração da versão anterior (em que toda a gente tinha conta e um tipo):
// os moradores/comensais passam para a tabela "pessoas" com o mesmo id, e os
// administradores/tesoureiros ficam tesoureiros ativos.
{
  const cols = db.prepare("PRAGMA table_info(utilizadores)").all().map(c => c.name);
  if (!cols.includes("estado")) db.exec("ALTER TABLE utilizadores ADD COLUMN estado TEXT NOT NULL DEFAULT 'pendente'");
  if (!cols.includes("aprovado_por")) db.exec("ALTER TABLE utilizadores ADD COLUMN aprovado_por TEXT");
  if (cols.includes("tipo")) {
    db.exec(`
      INSERT OR IGNORE INTO pessoas (id, nome, tipo, valor_fixo, entrada, saida, criado_em)
        SELECT id, nome, tipo, valor_fixo, entrada, saida, criado_em FROM utilizadores
        WHERE tipo IN ('morador','comensal','meio');
      UPDATE utilizadores SET estado = CASE
        WHEN bloqueado = 1 THEN 'bloqueado'
        WHEN admin = 1 OR tesoureiro = 1 THEN 'ativo'
        ELSE 'pendente' END
      WHERE estado = 'pendente';
    `);
    db.exec("DELETE FROM utilizadores WHERE estado = 'pendente' AND id IN (SELECT id FROM pessoas)");
    for (const c of ["tipo", "tesoureiro", "admin", "bloqueado", "valor_fixo", "entrada", "saida"]) {
      try { db.exec(`ALTER TABLE utilizadores DROP COLUMN ${c}`); } catch { /* versões antigas do SQLite: fica a coluna, não faz mal */ }
    }
  }
}

/* ---------- utilitários ---------- */
const agora = () => new Date().toISOString();
const novoId = () => crypto.randomBytes(12).toString("base64url");
const hash = t => crypto.createHash("sha256").update(t).digest("hex");
const TIPOS_PESSOA = ["morador", "comensal", "meio"];
const reMes = /^\d{4}-(0[1-9]|1[0-2])$/;
const reData = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const txt = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

class ErroHttp extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const falha = (status, msg) => { throw new ErroHttp(status, msg); };

const eTes = u => !!u && u.estado === "ativo";
const nAtivos = () => db.prepare("SELECT COUNT(*) AS n FROM utilizadores WHERE estado = 'ativo'").get().n;

function tesPublico(u, completo) {
  const p = { id: u.id, nome: u.nome, foto: u.foto || null, estado: u.estado };
  if (completo) { p.email = u.email; p.criadoEm = u.criado_em; }
  return p;
}
const pessoaPublica = p => ({ id: p.id, nome: p.nome, tipo: p.tipo, valorFixo: p.valor_fixo ?? null, entrada: p.entrada || null, saida: p.saida || null });

function lerConfig() {
  const r = db.prepare("SELECT valor FROM config WHERE chave = 'casa'").get();
  return r ? JSON.parse(r.valor) : null;
}
function gravarConfig(c) {
  db.prepare("INSERT INTO config (chave, valor) VALUES ('casa', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor")
    .run(JSON.stringify(c));
}
const utilPorId = id => (typeof id === "string" && id ? db.prepare("SELECT * FROM utilizadores WHERE id = ?").get(id) : undefined);
const pessoaPorId = id => (typeof id === "string" && id ? db.prepare("SELECT * FROM pessoas WHERE id = ?").get(id) : undefined);

/* ---------- cookies, sessões e aparelhos ---------- */
function lerCookie(req, nome) {
  for (const parte of (req.headers.cookie || "").split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === nome) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}
function definirCookie(res, nome, valor, maxAge) {
  res.append("Set-Cookie", `${nome}=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${COOKIE_SECURE ? "; Secure" : ""}`);
}
function criarSessao(res, utilizadorId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expira = new Date(Date.now() + SESSAO_DIAS * 864e5).toISOString();
  db.prepare("INSERT INTO sessoes (token_hash, utilizador_id, expira) VALUES (?, ?, ?)").run(hash(token), utilizadorId, expira);
  definirCookie(res, COOKIE, token, SESSAO_DIAS * 86400);
}
function identificar(req, res, next) {
  // aparelho: identifica quem registou uma compra sem conta (para a poder anular ou juntar talões)
  let d = lerCookie(req, COOKIE_DISP);
  if (!d || !/^[A-Za-z0-9_-]{20,64}$/.test(d)) {
    d = crypto.randomBytes(18).toString("base64url");
    definirCookie(res, COOKIE_DISP, d, 2 * 365 * 86400);
  }
  req.disp = "d:" + hash(d).slice(0, 20);
  const token = lerCookie(req, COOKIE);
  if (token) {
    const u = db.prepare(`SELECT u.* FROM sessoes s JOIN utilizadores u ON u.id = s.utilizador_id
                          WHERE s.token_hash = ? AND s.expira > ?`).get(hash(token), agora());
    if (u && u.estado !== "bloqueado") req.user = u;
  }
  req.tes = eTes(req.user);
  req.autor = req.user ? req.user.id : req.disp;
  next();
}
const soTesoureiro = (req, res, next) => {
  if (!req.user) return res.status(401).json({ erro: "Entra como tesoureiro." });
  if (!req.tes) return res.status(403).json({ erro: "Só os tesoureiros aprovados podem fazer isto." });
  next();
};

/* entra (ou regista) um tesoureiro que o Google confirmou */
function entrarUtilizador({ sub, email, nome, foto }) {
  email = email.toLowerCase();
  let u = (sub && db.prepare("SELECT * FROM utilizadores WHERE google_sub = ?").get(sub))
       || db.prepare("SELECT * FROM utilizadores WHERE email = ?").get(email);
  const automatico = TESOUREIROS_EMAILS.includes(email) || nAtivos() === 0;
  if (!u) {
    const id = novoId();
    db.prepare(`INSERT INTO utilizadores (id, google_sub, email, nome, foto, estado, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, sub || null, email, txt(nome, 80) || email, foto || null, automatico ? "ativo" : "pendente", agora());
    u = utilPorId(id);
    avisar(); // os outros tesoureiros veem logo o pedido
  } else {
    db.prepare("UPDATE utilizadores SET google_sub = COALESCE(google_sub, ?), foto = COALESCE(?, foto) WHERE id = ?").run(sub || null, foto || null, u.id);
    if (u.estado === "pendente" && automatico) {
      db.prepare("UPDATE utilizadores SET estado = 'ativo' WHERE id = ?").run(u.id);
      avisar();
    }
    u = utilPorId(u.id);
  }
  return u;
}

/* ---------- avisos em tempo real (Server-Sent Events) ---------- */
const clientes = new Set();
function avisar() { for (const c of clientes) c.write("data: mudou\n\n"); }
setInterval(() => { for (const c of clientes) c.write(": ping\n\n"); }, 25000).unref();

/* ---------- limite de pedidos para quem não tem conta ---------- */
const limites = new Map();
const limitar = (nome, max, janelaMs) => (req, res, next) => {
  if (req.tes) return next();
  const k = nome + ":" + req.ip, t = Date.now();
  let e = limites.get(k);
  if (!e || e.inicio + janelaMs < t) { e = { inicio: t, n: 0 }; limites.set(k, e); }
  if (++e.n > max) return res.status(429).json({ erro: "Demasiados pedidos seguidos. Espera um bocado e tenta outra vez." });
  next();
};
setInterval(() => { const t = Date.now(); for (const [k, e] of limites) if (e.inicio + 36e5 < t) limites.delete(k); }, 6e5).unref();

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
function novoMovimento(b, req) {
  const tes = req.tes;
  const tipo = b.tipo;
  if (!["compra", "conta", "renda", "fundo"].includes(tipo)) falha(400, "Tipo de registo inválido.");
  if (!tes && tipo !== "compra") falha(403, "Só os tesoureiros podem registar isto.");
  if (!Number.isInteger(b.cent) || b.cent <= 0 || b.cent > 1e9) falha(400, "Valor inválido.");
  if (!reMes.test(b.mes || "") || !reData.test(b.data || "")) falha(400, "Data inválida.");
  const m = { tipo, mes: b.mes, data: b.data, cent: b.cent, descricao: txt(b.descricao, 200) };
  if (tipo === "compra" || tipo === "conta") {
    m.pagoPor = b.pagoPor === "fundo" ? "fundo" : "bolso";
    m.reembolsado = false;
    const quem = pessoaPorId(b.morador);
    m.morador = quem ? quem.id : "";
    m.moradorNome = quem ? quem.nome : "";
    if (m.pagoPor === "bolso" && !m.morador) falha(400, "Diz quem pagou do bolso.");
    if (tipo === "conta") m.categoria = txt(b.categoria, 60) || "Outra";
  }
  if (tipo === "renda") {
    const quem = pessoaPorId(b.morador);
    if (!quem) falha(400, "Escolhe a pessoa que pagou.");
    m.morador = quem.id; m.moradorNome = quem.nome;
  }
  if (tipo === "fundo") {
    m.sentido = b.sentido === "saida" ? "saida" : "entrada";
    if (!m.descricao) falha(400, "Escreve uma descrição.");
  }
  m.fotos = fotosValidas(b.fotos);
  m.criadoPor = req.autor;
  m.criadoEm = agora();
  m.anulado = false;
  return m;
}
function dadosPessoa(b, parcial) {
  const out = {};
  if (!parcial || "nome" in b) { out.nome = txt(b.nome, 80); if (!out.nome) falha(400, "Escreve o nome."); }
  if (!parcial || "tipo" in b) { if (!TIPOS_PESSOA.includes(b.tipo)) falha(400, "Tipo inválido."); out.tipo = b.tipo; }
  if (!parcial || "valorFixo" in b) {
    const v = b.valorFixo ?? null;
    if (v !== null && (!Number.isInteger(v) || v < 0 || v > 1e8)) falha(400, "Valor fixo inválido.");
    out.valor_fixo = v;
  }
  for (const k of ["entrada", "saida"]) {
    if (!parcial || k in b) {
      const v = b[k] ?? null;
      if (v !== null && !reMes.test(v)) falha(400, "Mês inválido.");
      out[k] = v;
    }
  }
  return out;
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
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow",
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  });
  next();
});
app.use(express.json({ limit: "2mb" }));
app.use(identificar);

const loopback = req => {
  const ip = req.socket.remoteAddress || "";
  return !req.headers["x-forwarded-for"] && (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1");
};

app.get("/robots.txt", (_req, res) => res.type("text/plain").send("User-agent: *\nDisallow: /\n"));

app.get("/api/publico", (req, res) => {
  const c = lerConfig();
  res.json({ googleClientId: GOOGLE_CLIENT_ID, nomeCasa: (c && c.nome) || NOME_CASA, devLogin: DEV_LOGIN && loopback(req) });
});

const google = new OAuth2Client(GOOGLE_CLIENT_ID);
app.post("/api/entrar/google", limitar("entrar", 30, 36e5), async (req, res) => {
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
  if (u.estado === "bloqueado") return res.status(403).json({ erro: "Esta conta não pode ser tesoureira. Fala com outro tesoureiro." });
  criarSessao(res, u.id);
  res.json({ eu: tesPublico(u, true) });
});

// Só para testar no próprio computador (DEV_LOGIN=1): entra sem Google. Nunca ligar em produção.
app.post("/api/entrar/dev", (req, res) => {
  if (!DEV_LOGIN || !loopback(req)) return res.status(404).json({ erro: "Não existe." });
  const email = txt(req.body && req.body.email, 120).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return res.status(400).json({ erro: "Email inválido." });
  const u = entrarUtilizador({ sub: null, email, nome: txt(req.body.nome, 80) || email.split("@")[0], foto: null });
  if (u.estado === "bloqueado") return res.status(403).json({ erro: "Esta conta não pode ser tesoureira." });
  criarSessao(res, u.id);
  res.json({ eu: tesPublico(u, true) });
});

app.post("/api/sair", (req, res) => {
  const token = lerCookie(req, COOKIE);
  if (token) db.prepare("DELETE FROM sessoes WHERE token_hash = ?").run(hash(token));
  definirCookie(res, COOKIE, "", 0);
  res.json({ ok: true });
});

app.get("/api/estado", (req, res) => {
  const tes = req.tes;
  const tesoureiros = db.prepare("SELECT * FROM utilizadores ORDER BY nome COLLATE NOCASE").all()
    .filter(u => tes || u.estado === "ativo")
    .map(u => tesPublico(u, tes));
  const pessoas = db.prepare("SELECT * FROM pessoas ORDER BY nome COLLATE NOCASE").all().map(pessoaPublica);
  const movimentos = db.prepare("SELECT id, dados FROM movimentos ORDER BY criado_em").all()
    .map(r => Object.assign(JSON.parse(r.dados), { id: r.id }));
  res.json({
    eu: req.user ? tesPublico(req.user, true) : null,
    autor: req.autor,
    config: lerConfig() || {},
    pessoas, tesoureiros, movimentos,
  });
});

app.get("/api/eventos", (req, res) => {
  if (clientes.size > 500) return res.status(503).end();
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

app.post("/api/movimentos", limitar("registar", 120, 36e5), (req, res) => {
  const m = novoMovimento(req.body || {}, req);
  const id = novoId();
  db.prepare("INSERT INTO movimentos (id, mes, criado_em, dados) VALUES (?, ?, ?, ?)").run(id, m.mes, m.criadoEm, JSON.stringify(m));
  avisar();
  res.status(201).json(Object.assign(m, { id }));
});

app.patch("/api/movimentos/:id", limitar("registar", 120, 36e5), (req, res) => {
  const row = db.prepare("SELECT dados FROM movimentos WHERE id = ?").get(req.params.id);
  if (!row) falha(404, "Registo não encontrado.");
  const m = JSON.parse(row.dados), b = req.body || {};
  const tes = req.tes, minhaCompra = m.criadoPor === req.autor && m.tipo === "compra";
  if (b.anulado === true) {
    if (!tes && !minhaCompra) falha(403, "Só podes anular as compras que registaste neste aparelho.");
    if (!m.anulado) Object.assign(m, { anulado: true, anuladoPor: req.autor, anuladoEm: agora() });
  }
  if (b.reembolsado === true) {
    if (!tes) falha(403, "Só os tesoureiros podem pagar em dinheiro.");
    if (!["compra", "conta"].includes(m.tipo) || m.pagoPor !== "bolso") falha(400, "Este registo não foi pago do bolso.");
    if (!m.reembolsado) Object.assign(m, { reembolsado: true, reembolsadoEm: agora() });
  }
  if (Array.isArray(b.fotosNovas)) {
    if (!tes && !minhaCompra) falha(403, "Só podes juntar talões às compras que registaste neste aparelho.");
    m.fotos = (m.fotos || []).concat(fotosValidas(b.fotosNovas)).slice(0, 8);
  }
  db.prepare("UPDATE movimentos SET dados = ? WHERE id = ?").run(JSON.stringify(m), req.params.id);
  avisar();
  res.json(Object.assign(m, { id: req.params.id }));
});

app.put("/api/config", soTesoureiro, (req, res) => {
  const c = Object.assign(lerConfig() || {}, mudancasConfig(req.body));
  if (JSON.stringify(c).length > 1_000_000) falha(413, "As definições ficaram grandes demais.");
  gravarConfig(c);
  avisar();
  res.json(c);
});

/* pessoas da casa (moradores, comensais, meios comensais): só os tesoureiros mexem */
app.post("/api/pessoas", soTesoureiro, (req, res) => {
  const d = dadosPessoa(req.body || {}, false), id = novoId();
  db.prepare("INSERT INTO pessoas (id, nome, tipo, valor_fixo, entrada, saida, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, d.nome, d.tipo, d.valor_fixo, d.entrada, d.saida, agora());
  avisar();
  res.status(201).json(pessoaPublica(pessoaPorId(id)));
});
app.patch("/api/pessoas/:id", soTesoureiro, (req, res) => {
  const p = pessoaPorId(req.params.id);
  if (!p) falha(404, "Pessoa não encontrada.");
  const d = dadosPessoa(req.body || {}, true), cols = Object.keys(d);
  if (cols.length) {
    db.prepare(`UPDATE pessoas SET ${cols.map(c => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map(c => d[c]), p.id);
    avisar();
  }
  res.json(pessoaPublica(pessoaPorId(p.id)));
});
app.delete("/api/pessoas/:id", soTesoureiro, (req, res) => {
  const p = pessoaPorId(req.params.id);
  if (!p) falha(404, "Pessoa não encontrada.");
  const usada = db.prepare("SELECT 1 FROM movimentos WHERE json_extract(dados, '$.morador') = ? LIMIT 1").get(p.id);
  if (usada) falha(400, "Esta pessoa já tem registos. Em vez de a apagar, marca o mês em que saiu.");
  db.prepare("DELETE FROM pessoas WHERE id = ?").run(p.id);
  avisar();
  res.json({ ok: true });
});

/* tesoureiros: um tesoureiro ativo aprova, bloqueia ou recusa os outros */
app.patch("/api/tesoureiros/:id", soTesoureiro, (req, res) => {
  const u = utilPorId(req.params.id);
  if (!u) falha(404, "Tesoureiro não encontrado.");
  const estado = req.body && req.body.estado;
  if (!["ativo", "bloqueado"].includes(estado)) falha(400, "Estado inválido.");
  if (estado === "bloqueado" && u.estado === "ativo" && nAtivos() <= 1) falha(400, "Tem de ficar pelo menos um tesoureiro.");
  db.prepare("UPDATE utilizadores SET estado = ?, aprovado_por = CASE WHEN ? = 'ativo' THEN ? ELSE aprovado_por END WHERE id = ?")
    .run(estado, estado, req.user.id, u.id);
  if (estado === "bloqueado") db.prepare("DELETE FROM sessoes WHERE utilizador_id = ?").run(u.id);
  avisar();
  res.json(tesPublico(utilPorId(u.id), true));
});
app.delete("/api/tesoureiros/:id", soTesoureiro, (req, res) => {
  const u = utilPorId(req.params.id);
  if (!u) falha(404, "Tesoureiro não encontrado.");
  if (u.estado !== "pendente") falha(400, "Só se podem recusar pedidos pendentes.");
  db.prepare("DELETE FROM utilizadores WHERE id = ?").run(u.id);
  avisar();
  res.json({ ok: true });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1 } });
app.post("/api/fotos", limitar("fotos", 60, 36e5), upload.single("foto"), (req, res) => {
  if (!req.file) falha(400, "Falta o ficheiro.");
  const t = tipoFicheiro(req.file.buffer);
  if (!t) falha(415, "Esse ficheiro não dá. Usa uma foto (JPG, PNG, WEBP) ou um PDF.");
  const id = crypto.randomBytes(16).toString("hex");
  const ficheiro = `${id}.${t[1]}`;
  fs.writeFileSync(path.join(DATA_DIR, "fotos", ficheiro), req.file.buffer);
  db.prepare("INSERT INTO fotos (id, mime, ficheiro, criado_por, criado_em) VALUES (?, ?, ?, ?, ?)").run(id, t[0], ficheiro, req.autor, agora());
  res.status(201).json({ id, pdf: t[0] === "application/pdf" });
});

app.get("/api/fotos/:id", (req, res) => {
  const r = db.prepare("SELECT mime, ficheiro FROM fotos WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).end();
  res.set({ "Content-Type": r.mime, "Cache-Control": "private, max-age=31536000, immutable", "Content-Disposition": "inline" });
  res.sendFile(path.join(DATA_DIR, "fotos", r.ficheiro));
});

// Cópia de segurança da base de dados (não inclui as fotos; essas estão em DATA_DIR/fotos).
app.get("/api/copia-seguranca", soTesoureiro, (_req, res) => {
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
  if (!GOOGLE_CLIENT_ID) console.warn("Aviso: GOOGLE_CLIENT_ID não está definido; os tesoureiros não vão conseguir entrar com Google.");
  if (DEV_LOGIN) console.warn("Aviso: DEV_LOGIN=1 — login de teste ligado (só funciona a partir deste computador).");
});
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { servidor.close(); db.close(); process.exit(0); });
