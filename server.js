// Ponte da Cora: o painel chama aqui e a ponte fala com a Cora usando o certificado (mTLS).
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const BASE = "matls-clients.api.cora.com.br";
const { CORA_CLIENT_ID, BRIDGE_TOKEN, PORT = 10000 } = process.env;

// Aceita o PEM em várias linhas, em uma linha com \n, ou em base64.
function pem(raw) {
  let s = String(raw || "").trim().replace(/^["']|["']$/g, "").replace(/\\n/g, "\n").replace(/\r/g, "");
  if (!s.includes("-----BEGIN")) { try { s = Buffer.from(s, "base64").toString("utf8"); } catch {} }
  const m = s.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) return s;
  const body = m[2].replace(/\s+/g, "").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${m[1]}-----\n${body}\n-----END ${m[1]}-----\n`;
}
const agent = new https.Agent({ cert: pem(process.env.CORA_CERT), key: pem(process.env.CORA_KEY), keepAlive: true });

function req(method, path, { body, headers = {}, form } = {}) {
  return new Promise((resolve, reject) => {
    const data = form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : null;
    const r = https.request({ host: BASE, path, method, agent, headers: {
      ...(data ? { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
      ...headers } }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => { let j; try { j = JSON.parse(buf); } catch { j = { raw: buf }; } resolve({ status: res.statusCode, json: j }); });
    });
    r.on("error", reject); r.setTimeout(45000, () => r.destroy(new Error("timeout")));
    if (data) r.write(data); r.end();
  });
}

let tok = null, tokExp = 0;
async function token() {
  if (tok && Date.now() < tokExp) return tok;
  const r = await req("POST", "/token", { form: { grant_type: "client_credentials", client_id: CORA_CLIENT_ID } });
  if (r.status !== 200) throw Object.assign(new Error("Falha no login da Cora"), { detalhe: r.json, status: 502 });
  tok = r.json.access_token; tokExp = Date.now() + ((r.json.expires_in || 3600) - 120) * 1000;
  return tok;
}
const api = async (method, path, opts = {}) => req(method, path, { ...opts, headers: { Authorization: `Bearer ${await token()}`, ...(opts.headers || {}) } });

const send = (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const readBody = (r) => new Promise((ok) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } }); });
const authed = (r) => { const h = r.headers.authorization || ""; const t = Buffer.from(h.replace(/^Bearer /, "")); const e = Buffer.from(BRIDGE_TOKEN || "-"); return t.length === e.length && crypto.timingSafeEqual(t, e); };

function slim(inv) {
  const bs = (inv.payment_options && inv.payment_options.bank_slip) || {};
  const pay = (inv.payments || []).find((p) => p.finalized_at) || {};
  return { id: inv.id, status: inv.status, digitable: bs.digitable || null, url: bs.url || null, paid_at: pay.finalized_at || inv.paid_at || null, total_paid: inv.total_paid || null };
}

http.createServer(async (r, res) => {
  try {
    const u = new URL(r.url, "http://x");
    if (u.pathname === "/" || u.pathname === "/health") return send(res, 200, { ok: true, cert: !!process.env.CORA_CERT, key: !!process.env.CORA_KEY });
    if (!authed(r)) return send(res, 401, { error: "Token da ponte inválido" });

    if (r.method === "GET" && u.pathname === "/teste") { await token(); return send(res, 200, { ok: true, login: "Cora OK" }); }

    if (r.method === "POST" && u.pathname === "/emitir") {
      const b = await readBody(r);
      const out = await api("POST", "/v2/invoices", { body: b.invoice, headers: { "Idempotency-Key": b.idempotencyKey || crypto.randomUUID() } });
      if (out.status >= 300) return send(res, out.status, { error: out.json.message || "Cora recusou", detalhe: out.json.errors || out.json });
      return send(res, 200, slim(out.json));
    }

    if (r.method === "GET" && u.pathname.startsWith("/cobranca/")) {
      const out = await api("GET", `/v2/invoices/${encodeURIComponent(u.pathname.split("/")[2])}`);
      if (out.status >= 300) return send(res, out.status, { error: "Cora recusou", detalhe: out.json });
      return send(res, 200, slim(out.json));
    }

    if (r.method === "GET" && u.pathname === "/pagos") {
      const items = [];
      for (let page = 1; page <= 20; page++) {
        const q = new URLSearchParams({ state: "PAID", start: u.searchParams.get("start"), end: u.searchParams.get("end"), page: String(page), perPage: "200" });
        const out = await api("GET", `/v2/invoices?${q}`);
        if (out.status >= 300) return send(res, out.status, { error: "Cora recusou", detalhe: out.json });
        const list = out.json.items || [];
        for (const i of list) items.push({ id: i.id, paid_at: i.paid_at || i.occurrence_date || null, total_paid: i.total_paid || i.total_amount || null });
        if (list.length < 200) break;
      }
      return send(res, 200, { items });
    }

    if (r.method === "DELETE" && u.pathname.startsWith("/cobranca/")) {
      const out = await api("DELETE", `/v2/invoices/${encodeURIComponent(u.pathname.split("/")[2])}`);
      return send(res, out.status < 300 ? 200 : out.status, out.status < 300 ? { ok: true } : { error: "Cora recusou", detalhe: out.json });
    }
    send(res, 404, { error: "Rota não encontrada" });
  } catch (e) { send(res, e.status || 500, { error: e.message, detalhe: e.detalhe }); }
}).listen(PORT, () => console.log("Ponte Cora na porta", PORT));
