#!/usr/bin/env node
"use strict";
/* ============================================================================
 * NOTIFIER CLOUD - notificador unificado (WhatsApp + Telegram) para servidor
 * ----------------------------------------------------------------------------
 * Baseado no NOTIFIER local (D:\DOCS\NOTIFIER), adaptado para rodar 24/7 em
 * nuvem (Render) atras de um Persistent Disk OU de um Postgres.
 *
 * O que mudou em relacao ao original:
 *   - porta/host vindos de env (PORT / HOST) - Render injeta PORT
 *   - configuracao por variavel de ambiente (secrets), com fallback em config.json
 *   - sessao do WhatsApp salva em Postgres (DATABASE_URL) ou em disco (SESSION_DIR)
 *   - FILA de mensagens: se o WhatsApp estiver dormindo/desconectado, a mensagem
 *     nao se perde; fica no banco e sai quando a conexao voltar
 *   - /health (para keep-alive), /status, /notify (protegido por x-notifier-key)
 *   - /wa/qr e /wa/pair para parear o WhatsApp sem acesso ao terminal
 *
 * Comandos:
 *   node server.js serve
 *   node server.js send "texto" [--titulo T] [--fonte F]
 *   node server.js test | status | ensure
 *   node server.js wa-qr | wa-pair <numero> | wa-logout
 * ==========================================================================*/

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { spawn } = require("child_process");

const RAIZ = __dirname;
const NA_NUVEM = !!process.env.RENDER || !!process.env.NOTIFIER_CLOUD;

const CONFIG_PADRAO = {
  port: Number(process.env.PORT || 45711),
  host: process.env.HOST || (NA_NUVEM ? "0.0.0.0" : "127.0.0.1"),
  chave: process.env.NOTIFIER_KEY || "",
  telegram: {
    enabled: String(process.env.TELEGRAM_ENABLED || "1") !== "0",
    token: process.env.TELEGRAM_TOKEN || "",
    chatID: process.env.TELEGRAM_CHAT_ID || "",
  },
  whatsapp: {
    enabled: String(process.env.WHATSAPP_ENABLED || "1") !== "0",
    target: process.env.WHATSAPP_TARGET || "",
    sessionDir: process.env.SESSION_DIR || "./wa-session",
  },
  debugEvents: process.env.DEBUG_EVENTS === "1",
};

/* ------------------------------ utilitarios ------------------------------ */

function carregarConfig() {
  const p = path.join(RAIZ, "config.json");
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch { /* sem config.json: usa env */ }
  const final = {
    ...CONFIG_PADRAO,
    ...cfg,
    telegram: { ...CONFIG_PADRAO.telegram, ...(cfg.telegram || {}) },
    whatsapp: { ...CONFIG_PADRAO.whatsapp, ...(cfg.whatsapp || {}) },
  };
  /* env SEMPRE ganha do arquivo (na nuvem o arquivo nem existe) */
  if (process.env.PORT) final.port = Number(process.env.PORT);
  if (process.env.HOST) final.host = process.env.HOST;
  if (process.env.NOTIFIER_KEY) final.chave = process.env.NOTIFIER_KEY;
  if (process.env.TELEGRAM_TOKEN) final.telegram.token = process.env.TELEGRAM_TOKEN;
  if (process.env.TELEGRAM_CHAT_ID) final.telegram.chatID = process.env.TELEGRAM_CHAT_ID;
  if (process.env.TELEGRAM_ENABLED) final.telegram.enabled = process.env.TELEGRAM_ENABLED !== "0";
  if (process.env.WHATSAPP_TARGET) final.whatsapp.target = process.env.WHATSAPP_TARGET;
  if (process.env.WHATSAPP_ENABLED) final.whatsapp.enabled = process.env.WHATSAPP_ENABLED !== "0";
  if (process.env.SESSION_DIR) final.whatsapp.sessionDir = process.env.SESSION_DIR;
  return final;
}

function salvarConfig(cfg) {
  try {
    fs.writeFileSync(path.join(RAIZ, "config.json"), JSON.stringify(cfg, null, 2), "utf8");
  } catch { /* disco read-only: ignora */ }
}

function pastaLogs() {
  const p = path.join(RAIZ, "logs");
  try { fs.mkdirSync(p, { recursive: true }); } catch { /* ok */ }
  return p;
}

function registrarLog(linha) {
  const texto = `[${new Date().toLocaleString("pt-BR")}] ${linha}`;
  console.log(texto);
  try {
    const dia = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(pastaLogs(), `daemon-${dia}.log`), texto + "\n", "utf8");
  } catch { /* em nuvem sem disco o log vai so pro stdout */ }
}

/* ---------------------------- banco (opcional) ---------------------------- */
/* Se DATABASE_URL existir: guarda a sessao do WhatsApp e a fila de mensagens
   no Postgres. Sem ela: usa apenas arquivos (comportamento local).            */

const pg = { pool: null, pronto: false };

async function dbConectar() {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  try {
    const { Pool } = require("pg");
    pg.pool = new Pool({
      connectionString: url,
      ssl: url.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 4,
      idleTimeoutMillis: 10000,
    });
    await pg.pool.query(`
      CREATE TABLE IF NOT EXISTS notifier_auth (
        chave TEXT PRIMARY KEY,
        valor TEXT NOT NULL,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS notifier_fila (
        id BIGSERIAL PRIMARY KEY,
        titulo TEXT,
        mensagem TEXT,
        fonte TEXT,
        tentativas INT NOT NULL DEFAULT 0,
        ultimo_erro TEXT,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
        enviado_em TIMESTAMPTZ
      );
    `);
    pg.pronto = true;
    registrarLog("Postgres conectado (sessao + fila ligadas).");
    return true;
  } catch (e) {
    pg.pronto = false;
    registrarLog("ERRO Postgres: " + (e.message || e));
    return false;
  }
}

async function dbGet(chave) {
  if (!pg.pronto) return null;
  const r = await pg.pool.query("SELECT valor FROM notifier_auth WHERE chave=$1", [chave]);
  return r.rows.length ? r.rows[0].valor : null;
}

async function dbGetVarios(chaves) {
  if (!pg.pronto || !chaves.length) return [];
  const r = await pg.pool.query(
    "SELECT chave, valor FROM notifier_auth WHERE chave = ANY($1::text[])",
    [chaves]
  );
  return r.rows;
}

async function dbSetVarios(pares) {
  if (!pg.pronto || !pares.length) return;
  const chaves = pares.map((p) => p[0]);
  const valores = pares.map((p) => p[1]);
  await pg.pool.query(
    `INSERT INTO notifier_auth (chave, valor, atualizado_em)
     SELECT u.chave, u.valor, now()
     FROM UNNEST($1::text[], $2::text[]) AS u(chave, valor)
     ON CONFLICT (chave) DO UPDATE SET valor=EXCLUDED.valor, atualizado_em=now()`,
    [chaves, valores]
  );
}

async function dbDelVarios(chaves) {
  if (!pg.pronto || !chaves.length) return;
  await pg.pool.query("DELETE FROM notifier_auth WHERE chave = ANY($1::text[])", [chaves]);
}

async function dbSet(chave, valor) {
  if (!pg.pronto) return;
  await pg.pool.query(
    `INSERT INTO notifier_auth (chave, valor, atualizado_em) VALUES ($1,$2,now())
     ON CONFLICT (chave) DO UPDATE SET valor=EXCLUDED.valor, atualizado_em=now()`,
    [chave, valor]
  );
}

async function dbDel(chave) {
  if (!pg.pronto) return;
  await pg.pool.query("DELETE FROM notifier_auth WHERE chave=$1", [chave]);
}

async function filaAdicionar(item) {
  if (!pg.pronto) return false;
  await pg.pool.query(
    "INSERT INTO notifier_fila (titulo, mensagem, fonte) VALUES ($1,$2,$3)",
    [item.titulo || "", item.mensagem || "", item.fonte || "?"]
  );
  return true;
}

async function filaPendentes(limite = 20) {
  if (!pg.pronto) return [];
  const r = await pg.pool.query(
    `SELECT * FROM notifier_fila WHERE enviado_em IS NULL AND tentativas < 20
     ORDER BY id LIMIT $1`, [limite]
  );
  return r.rows;
}

async function filaMarcar(id, erro) {
  if (!pg.pronto) return;
  if (erro) {
    await pg.pool.query(
      "UPDATE notifier_fila SET tentativas=tentativas+1, ultimo_erro=$2 WHERE id=$1",
      [id, String(erro).slice(0, 500)]
    );
  } else {
    await pg.pool.query("UPDATE notifier_fila SET enviado_em=now(), ultimo_erro=NULL WHERE id=$1", [id]);
  }
}

async function filaPendenteCount() {
  if (!pg.pronto) return 0;
  const r = await pg.pool.query("SELECT count(*)::int AS n FROM notifier_fila WHERE enviado_em IS NULL");
  return r.rows[0].n;
}

/* ------------------------------- Telegram -------------------------------- */

async function enviarTelegram(cfg, texto) {
  const t = cfg.telegram || {};
  if (!t.enabled) return { canal: "telegram", ok: false, erro: "desativado" };
  if (!t.token || !t.chatID) return { canal: "telegram", ok: false, erro: "token/chatID nao configurados" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${t.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: t.chatID, text: texto, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (j.ok) return { canal: "telegram", ok: true };
    return { canal: "telegram", ok: false, erro: j.description || `HTTP ${r.status}` };
  } catch (e) {
    return { canal: "telegram", ok: false, erro: String(e.message || e) };
  }
}

/* -------------------------------- WhatsApp ------------------------------- */

const wa = {
  sock: null,
  estado: "desativado",
  ultimoErro: null,
  reconectando: false,
  cfg: null,
  qr: null,          // dataURL do ultimo QR
  qrEm: 0,
  parCode: null,     // codigo de pareamento (texto)
  enviando: false,
};

async function waCarregarBaileys() {
  try {
    return await import("baileys");
  } catch {
    throw new Error("Pacote 'baileys' nao instalado. Rode: npm install");
  }
}

function waEscolherSocket(B) {
  if (typeof B.makeWASocket === "function") return B.makeWASocket;
  if (typeof B.default === "function") return B.default;
  return B;
}

/* Sessao em Postgres (se DATABASE_URL) ou em arquivos (SESSION_DIR). */
async function waAuthState(B) {
  const dirSessao = path.isAbsolute(wa.cfg.whatsapp.sessionDir)
    ? wa.cfg.whatsapp.sessionDir
    : path.join(RAIZ, wa.cfg.whatsapp.sessionDir || "wa-session");
  try { fs.mkdirSync(dirSessao, { recursive: true }); } catch { /* ok */ }

  const { BufferJSON, initAuthCreds } = B;
  const usarDb = pg.pronto;

  if (!usarDb) {
    /* fallback: multi-file (igual ao notifier local) */
    return await B.useMultiFileAuthState(dirSessao);
  }

  const serializar = (o) => JSON.stringify(o, BufferJSON.replacer);
  const desserializar = (s) => JSON.parse(s, BufferJSON.reviver);

  const credsSalvos = await dbGet("creds");
  let creds = credsSalvos ? desserializar(credsSalvos) : initAuthCreds();

  const keys = {
    get: async (tipo, ids) => {
      const out = {};
      if (!ids || ids.length === 0) return out;
      const chaves = ids.map((id) => `k:${tipo}:${id}`);
      const linhas = await dbGetVarios(chaves);
      const mapa = new Map(linhas.map((l) => [l.chave, l.valor]));
      for (const id of ids) {
        const v = mapa.get(`k:${tipo}:${id}`);
        if (v != null) out[id] = desserializar(v);
      }
      return out;
    },
    set: async (data) => {
      const inserir = [];
      const apagar = [];
      for (const tipo of Object.keys(data || {})) {
        for (const id of Object.keys(data[tipo] || {})) {
          const valor = data[tipo][id];
          const chave = `k:${tipo}:${id}`;
          if (valor == null) apagar.push(chave);
          else inserir.push([chave, serializar(valor)]);
        }
      }
      if (apagar.length) await dbDelVarios(apagar);
      if (inserir.length) await dbSetVarios(inserir);
    },
    transaction: async (fn) => { await fn(); },
  };

  const saveCreds = async () => {
    try { await dbSet("creds", serializar(creds)); } catch { /* ignora */ }
  };

  return { state: { creds, keys }, saveCreds };
}

async function waIniciar(cfg) {
  wa.cfg = cfg;
  if (!cfg.whatsapp.enabled) { wa.estado = "desativado"; return; }
  let B;
  try {
    B = await waCarregarBaileys();
  } catch (e) {
    wa.estado = "baileys ausente";
    wa.ultimoErro = e.message;
    return;
  }
  const makeWASocket = waEscolherSocket(B);
  const { DisconnectReason, fetchLatestBaileysVersion } = B;

  try {
    const { state, saveCreds } = await waAuthState(B);
    let versao = [];
    try { versao = (await fetchLatestBaileysVersion()).version; } catch { /* usa padrao */ }

    wa.estado = "conectando...";
    const sock = makeWASocket({
      auth: state,
      version: versao.length ? versao : undefined,
      printQRInTerminal: false,
      logger: (await import("pino")).default({ level: "silent" }),
      browser: ["NOTIFIER Cloud", "Chrome", "1.2.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 20000,
    });
    wa.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (u) => {
      if (u.qr) {
        wa.estado = "aguardando pareamento";
        try {
          const QR = await import("qrcode");
          wa.qr = await QR.toDataURL(u.qr, { width: 480, margin: 1 });
          wa.qrEm = Date.now();
        } catch { /* sem qrcode instalado */ }
        registrarLog("QR de pareamento gerado.");
      }
      if (u.connection === "open") {
        wa.estado = "conectado";
        wa.ultimoErro = null;
        wa.qr = null;
        registrarLog("WhatsApp conectado.");
        setTimeout(() => { drenarFila().catch(() => {}); }, 2000);
      }
      if (u.connection === "close") {
        const codigo = u.lastDisconnect?.error?.output?.statusCode;
        const saiu = codigo === DisconnectReason.loggedOut;
        wa.sock = null;
        if (saiu) {
          wa.estado = "desconectado (precisa parear de novo)";
          registrarLog("WhatsApp deslogado. Use /wa/qr para parear novamente.");
        } else {
          wa.estado = "reconectando...";
          if (!wa.reconectando) {
            wa.reconectando = true;
            setTimeout(() => { wa.reconectando = false; waIniciar(cfg).catch(() => {}); }, 5000);
          }
        }
      }
    });
  } catch (e) {
    wa.estado = "erro";
    wa.ultimoErro = String(e.message || e);
    registrarLog("ERRO WhatsApp: " + (e.message || e));
  }
}

async function waEnviar(cfg, texto, esperaMs = 20000) {
  if (!cfg.whatsapp.enabled) return { canal: "whatsapp", ok: false, erro: "desativado" };
  if (!cfg.whatsapp.target) return { canal: "whatsapp", ok: false, erro: "destino nao configurado" };
  const limite = Date.now() + esperaMs;
  while (wa.estado !== "conectado" && Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 700));
  }
  if (!wa.sock || wa.estado !== "conectado") {
    return { canal: "whatsapp", ok: false, erro: `sem conexao (${wa.estado})`, enfileiravel: true };
  }
  try {
    const jid = String(cfg.whatsapp.target).replace(/[^0-9]/g, "") + "@s.whatsapp.net";
    await wa.sock.sendMessage(jid, { text: texto });
    return { canal: "whatsapp", ok: true };
  } catch (e) {
    return { canal: "whatsapp", ok: false, erro: String(e.message || e), enfileiravel: true };
  }
}

/* --------------------------------- envio --------------------------------- */

function formatarTexto(cfg, { titulo, mensagem, fonte }) {
  const partes = [];
  partes.push(`${NA_NUVEM ? "☁️" : "🖥"} ${fonte || "notifier"}`);
  if (titulo) partes.push(titulo);
  if (mensagem) partes.push(mensagem);
  return partes.filter(Boolean).join("\n");
}

async function notificar(cfg, payload, { esperaMs = 20000 } = {}) {
  const texto = formatarTexto(cfg, payload);
  const resultados = [];
  resultados.push(await enviarTelegram(cfg, texto));
  if (cfg.whatsapp.enabled) {
    const r = await waEnviar(cfg, texto, esperaMs);
    if (!r.ok && r.enfileiravel) {
      const ok = await filaAdicionar(payload);
      r.fila = ok;
    }
    resultados.push(r);
  }
  return { texto, resultados };
}

async function drenarFila() {
  if (wa.estado !== "conectado" || !pg.pronto || wa.enviando) return;
  wa.enviando = true;
  try {
    const pendentes = await filaPendentes(20);
    for (const item of pendentes) {
      const texto = formatarTexto(wa.cfg, item);
      const r = await waEnviar(wa.cfg, texto, 5000);
      if (r.ok) await filaMarcar(item.id, null);
      else { await filaMarcar(item.id, r.erro); break; }
    }
    if (pendentes.length) registrarLog(`fila: ${pendentes.length} processadas.`);
  } catch (e) {
    registrarLog("ERRO fila: " + (e.message || e));
  } finally {
    wa.enviando = false;
  }
}

function resumoResultados(resultados) {
  const ok = resultados.filter((r) => r.ok).map((r) => r.canal);
  const falha = resultados.filter((r) => !r.ok && r.erro !== "desativado").map((r) => `${r.canal}: ${r.erro}`);
  if (ok.length === 0 && falha.length === 0) return "nenhum canal configurado";
  return `${ok.length ? "enviado p/ " + ok.join(", ") : ""}${falha.length ? (ok.length ? " | " : "") + "falhou -> " + falha.join("; ") : ""}`;
}

/* ------------------------------- HTTP API -------------------------------- */

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function autorizado(req, cfg) {
  if (!cfg.chave) return true; // sem chave configurada: aberto (nao recomendado)
  const h = req.headers["x-notifier-key"] || "";
  const q = new URL(req.url, "http://x").searchParams.get("key") || "";
  return h === cfg.chave || q === cfg.chave;
}

function lerCorpo(req) {
  return new Promise((resolve) => {
    let corpo = "";
    req.on("data", (d) => { corpo += d; if (corpo.length > 1_000_000) req.destroy(); });
    req.on("end", () => resolve(corpo));
  });
}

function iniciarServidor(cfg) {
  const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const rota = url.pathname;

    /* health: aberto, sem auth, para keep-alive/cron */
    if (req.method === "GET" && (rota === "/health" || rota === "/")) {
      return json(res, 200, { ok: true, servico: "notifier", hora: new Date().toISOString() });
    }

    if (!autorizado(req, cfg)) return json(res, 401, { erro: "chave invalida" });

    if (req.method === "GET" && rota === "/status") {
      let fila = 0;
      try { fila = await filaPendenteCount(); } catch { /* ok */ }
      return json(res, 200, {
        ok: true,
        host: os.hostname(),
        cloud: NA_NUVEM,
        banco: pg.pronto,
        telegram: { enabled: cfg.telegram.enabled, configurado: !!(cfg.telegram.token && cfg.telegram.chatID) },
        whatsapp: { enabled: cfg.whatsapp.enabled, estado: wa.estado, destino: cfg.whatsapp.target || null },
        fila_pendente: fila,
      });
    }

    if (req.method === "POST" && rota === "/notify") {
      try {
        const p = JSON.parse((await lerCorpo(req)) || "{}");
        if (!p.mensagem && !p.titulo) return json(res, 400, { erro: "informe titulo e/ou mensagem" });
        const { texto, resultados } = await notificar(cfg, p, { esperaMs: p.espera_ms || 20000 });
        const whats = resultados.find((r) => r.canal === "whatsapp");
        const entregue = resultados.some((r) => r.ok);
        registrarLog(`envio (${p.fonte || "?"}) -> ${resumoResultados(resultados)}`);
        return json(res, entregue ? 200 : 202, {
          ok: entregue,
          enfileirado: !!(whats && whats.fila),
          resultados,
          texto,
        });
      } catch (e) {
        return json(res, 500, { erro: String(e.message || e) });
      }
    }

    /* pagina amigavel para parear: abre no navegador e mostra o QR sempre atual */
    if (req.method === "GET" && (rota === "/wa" || rota === "/wa/")) {
      const k = url.searchParams.get("key") || "";
      const conectado = wa.estado === "conectado";
      const corpo = conectado
        ? `<h1>✅ WhatsApp conectado</h1><p>Destino: ${cfg.whatsapp.target || "-"}</p>`
        : wa.qr
          ? `<h1>Parear WhatsApp</h1>
             <p>Abra no celular: <b>WhatsApp → Aparelhos conectados → Conectar aparelho</b> e escaneie:</p>
             <img src="${wa.qr}" alt="QR de pareamento" style="width:320px;height:320px;image-rendering:pixelated;border:8px solid #111;border-radius:8px">
             <p style="color:#666">O código acima se renova sozinho a cada poucos segundos.</p>`
          : `<h1>Gerando QR...</h1><p>Estado: ${wa.estado}</p>`;
      const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
        <meta http-equiv="refresh" content="5;url=/wa?key=${encodeURIComponent(k)}">
        <title>NOTIFIER — pareamento</title>
        <style>body{font-family:system-ui,Segoe UI,Arial;background:#0f172a;color:#e2e8f0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}h1{font-size:22px}</style>
        </head><body>${corpo}<p style="color:#64748b;font-size:12px">Atualiza sozinho a cada 5s • estado: ${wa.estado}</p></body></html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    if (req.method === "GET" && rota === "/wa/qr") {
      if (wa.estado === "conectado") return json(res, 200, { estado: wa.estado });
      if (!wa.qr) return json(res, 404, { estado: wa.estado, erro: "QR ainda nao gerado, tente em alguns segundos" });
      return json(res, 200, { estado: wa.estado, qr: wa.qr });
    }

    if (req.method === "POST" && rota === "/wa/pair") {
      try {
        const p = JSON.parse((await lerCorpo(req)) || "{}");
        const numero = String(p.numero || cfg.whatsapp.target || "").replace(/[^0-9]/g, "");
        if (numero.length < 10) return json(res, 400, { erro: "informe numero com DDI+DDD" });
        if (!wa.sock) return json(res, 503, { erro: "socket nao iniciado", estado: wa.estado });
        const codigo = await wa.sock.requestPairingCode(numero);
        wa.parCode = codigo;
        return json(res, 200, { ok: true, numero, codigo });
      } catch (e) {
        return json(res, 500, { erro: String(e.message || e) });
      }
    }

    if (req.method === "POST" && rota === "/wa/logout") {
      try {
        const dir = path.isAbsolute(cfg.whatsapp.sessionDir) ? cfg.whatsapp.sessionDir : path.join(RAIZ, cfg.whatsapp.sessionDir);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
        if (pg.pronto) await pg.pool.query("DELETE FROM notifier_auth");
        try { wa.sock?.logout?.(); } catch { /* ok */ }
        wa.estado = "deslogado (aguardando /wa/qr)";
        setTimeout(() => waIniciar(cfg).catch(() => {}), 2000);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 500, { erro: String(e.message || e) });
      }
    }

    return json(res, 404, { erro: "rota nao encontrada" });
  });

  servidor.listen(cfg.port, cfg.host, () => {
    registrarLog(`daemon ouvindo em http://${cfg.host}:${cfg.port} (host: ${os.hostname()})`);
  });
  servidor.on("error", (e) => {
    registrarLog("ERRO servidor: " + e.message);
    process.exit(1);
  });
  return servidor;
}

/* ------------------------------ envio CLI -------------------------------- */

async function enviarViaCli(cfg, payload) {
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.port}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cfg.chave ? { "x-notifier-key": cfg.chave } : {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json();
    console.log(resumoResultados(j.resultados || []));
    return;
  } catch { /* daemon offline -> direto */ }
  const { resultados } = await notificar(cfg, payload, { esperaMs: 25000 });
  console.log(`(daemon offline, envio direto) ${resumoResultados(resultados)}`);
}

/* --------------------------------- main ---------------------------------- */

(async () => {
  const [comando, ...resto] = process.argv.slice(2);
  const cfg = carregarConfig();

  switch (comando) {
    case "serve": {
      await dbConectar();
      await waIniciar(cfg);
      iniciarServidor(cfg);
      setInterval(() => { drenarFila().catch(() => {}); }, 30000);
      setInterval(() => {}, 1 << 30);
      break;
    }
    case "send": {
      const args = [...resto];
      let titulo = "", fonte = "";
      const limpar = (flag) => {
        const i = args.indexOf(flag);
        if (i >= 0 && args[i + 1] !== undefined) { const v = args[i + 1]; args.splice(i, 2); return v; }
        return "";
      };
      titulo = limpar("--titulo");
      fonte = limpar("--fonte");
      const mensagem = args.join(" ").trim();
      if (!mensagem && !titulo) { console.error('Uso: node server.js send "mensagem" [--titulo T] [--fonte F]'); process.exit(1); }
      await dbConectar();
      await enviarViaCli(cfg, { titulo, mensagem, fonte: fonte || "manual" });
      process.exit(0);
      break;
    }
    case "test": {
      await dbConectar();
      await waIniciar(cfg);
      await enviarViaCli(cfg, { titulo: "🧪 Teste do NOTIFIER", mensagem: `Se você recebeu isso, está tudo funcionando.\nHost: ${os.hostname()}`, fonte: "teste" });
      process.exit(0);
      break;
    }
    case "status": {
      const r = await fetch(`http://127.0.0.1:${cfg.port}/status`, { headers: cfg.chave ? { "x-notifier-key": cfg.chave } : {}, signal: AbortSignal.timeout(5000) }).then((x) => x.json()).catch(() => null);
      console.log(JSON.stringify(r || { daemon: "OFFLINE" }, null, 2));
      break;
    }
    case "ensure": {
      let noAr = false;
      try {
        const r = await fetch(`http://127.0.0.1:${cfg.port}/health`, { signal: AbortSignal.timeout(3000) });
        noAr = r.ok;
      } catch { /* morto */ }
      if (!noAr) {
        const filho = spawn(process.execPath, [path.join(RAIZ, "server.js"), "serve"], { windowsHide: true, detached: true, stdio: "ignore" });
        filho.unref();
        console.log("daemon iniciado em background");
      } else console.log("daemon ja esta no ar");
      break;
    }
    case "wa-qr": {
      await dbConectar();
      await waIniciar(cfg);
      iniciarServidor(cfg);
      console.log("Aguardando QR... consulte http://127.0.0.1:" + cfg.port + "/wa/qr");
      break;
    }
    case "wa-pair": {
      await dbConectar();
      await waIniciar(cfg);
      iniciarServidor(cfg);
      const numero = String(resto[0] || "").replace(/[^0-9]/g, "");
      await new Promise((r) => setTimeout(r, 6000));
      const codigo = await wa.sock.requestPairingCode(numero);
      console.log("CODIGO: " + codigo);
      break;
    }
    case "wa-logout": {
      await dbConectar();
      const dir = path.isAbsolute(cfg.whatsapp.sessionDir) ? cfg.whatsapp.sessionDir : path.join(RAIZ, cfg.whatsapp.sessionDir);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
      if (pg.pronto) await pg.pool.query("DELETE FROM notifier_auth");
      console.log("Sessao apagada.");
      break;
    }
    default:
      console.log("Comandos: serve | send \"msg\" | test | status | ensure | wa-qr | wa-pair <numero> | wa-logout");
  }
})().catch((e) => { console.error("[notifier] erro fatal:", e); process.exit(1); });
