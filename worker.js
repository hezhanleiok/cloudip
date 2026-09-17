/**
 * CloudIP 1.2.0
 * Cloudflare Worker / Pages Functions single-file runtime.
 *
 * Deployment modes:
 * 1) Nahan-style installer: installer/index.html calls Cloudflare API, creates D1,
 *    generates ADMIN_ROUTE + MASTER_KEY, injects them into this file and deploys.
 * 2) Manual Worker: paste this file into Workers. Bind a D1 database as IOT_DB.
 *    If MASTER_KEY is "__MASTER_KEY__", first visit /__ADMIN_ROUTE__/setup to bootstrap.
 * 3) Cloudflare Pages: copy this file to functions/_worker.js and bind IOT_DB.
 *
 * No KV is required. D1 is the persistent store.
 * The runtime creates/repairs its schema automatically on first request.
 *
 * This project intentionally keeps internal resource pools hidden from the admin UI.
 * The UI exposes only "Built-in / Automatic" or an explicit "Custom" override.
 */

const VERSION = "1.2.0";
const DEFAULT_ADMIN_ROUTE = "__ADMIN_ROUTE__";
const DEFAULT_MASTER_KEY = "__MASTER_KEY__";

const BUILTIN = Object.freeze({
  proxyDomains: [
    "bpb.yousef.isegaro.com",
    "proxyip.cmliussss.net",
    "bpb.radically.pro"
  ],
  nat64Prefixes: [
    "2a02:898:146:64::",
    "2602:fc59:b0:64::",
    "2602:fc59:11:64::"
  ],
  preferredSources: [
    "https://raw.githubusercontent.com/byJoey/cfnew-ipdb/main/index.json"
  ],
  preferredCountryBase:
    "https://raw.githubusercontent.com/byJoey/cfnew-ipdb/main/country/",
  preferredColoBase:
    "https://raw.githubusercontent.com/byJoey/cfnew-ipdb/main/colo/",
  nodeSources: [
    "https://raw.githubusercontent.com/freefq/free/master/v2"
  ],
  ports: {
    https: [443, 8443, 2053, 2083, 2087, 2096],
    http: [80, 8080, 2052, 2082, 2086, 2095, 8880]
  }
});

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer"
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...HEADERS, ...extra }
  });
}
function text(data, status = 200, extra = {}) {
  return new Response(data, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra
    }
  });
}
function html(data, status = 200) {
  return new Response(data, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer"
    }
  });
}
function now() { return new Date().toISOString(); }
function uid(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map(x => x.toString(16).padStart(2, "0")).join("");
}
function uuid() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  a[6] = (a[6] & 0x0f) | 0x40;
  a[8] = (a[8] & 0x3f) | 0x80;
  const h = [...a].map(x => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function randomToken() {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return b64url(a);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
function parseBool(v, d=false) {
  if (v === undefined || v === null || v === "") return d;
  return ["1","true","yes","on"].includes(String(v).toLowerCase());
}
function clamp(n, min, max) {
  n = Number(n);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}
function safePath(v) {
  v = String(v || "").trim();
  if (!v) return "";
  if (!v.startsWith("/")) v = "/" + v;
  return "/" + v.split("/").filter(Boolean).map(x => x.replace(/[^A-Za-z0-9._~-]/g, "")).filter(Boolean).join("/");
}
function ipLiteral(host) {
  return /^[0-9.]+$/.test(host) || /^\[[0-9a-f:]+\]$/i.test(host);
}
function base64Decode(s) {
  s = s.replace(/\s+/g, "");
  try {
    return atob(s);
  } catch {
    const pad = "=".repeat((4 - s.length % 4) % 4);
    return atob(s + pad);
  }
}
function parseHostPort(s, fallbackPort=443) {
  s = String(s || "").trim();
  if (s.startsWith("[")) {
    const i = s.indexOf("]");
    if (i > 0) return {host:s.slice(1,i), port:Number(s.slice(i+1).replace(/^:/,"")) || fallbackPort};
  }
  const parts = s.split(":");
  if (parts.length === 2 && /^\d+$/.test(parts[1])) return {host:parts[0], port:Number(parts[1])};
  return {host:s, port:fallbackPort};
}
async function getRuntimeConfig(env) {
  const route = env.ADMIN_ROUTE || (env.IOT_DB ? await metaGet(env, "manual_admin_route", DEFAULT_ADMIN_ROUTE) : DEFAULT_ADMIN_ROUTE);
  const master = env.MASTER_KEY || (env.IOT_DB ? await metaGet(env, "manual_master_key", DEFAULT_MASTER_KEY) : DEFAULT_MASTER_KEY);
  return { route: route || DEFAULT_ADMIN_ROUTE, master: master || DEFAULT_MASTER_KEY };
}

/* -------------------------------------------------------------------------- */
/* D1: schema is self-initializing; no SQL migration is required.             */
/* -------------------------------------------------------------------------- */

const SCHEMA = [
`CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  uuid TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  traffic_limit INTEGER NOT NULL DEFAULT 0,
  traffic_used INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  port_mode TEXT NOT NULL DEFAULT 'auto',
  custom_ports TEXT NOT NULL DEFAULT '[]',
  path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  address TEXT NOT NULL,
  port INTEGER NOT NULL,
  tls INTEGER NOT NULL DEFAULT 1,
  host TEXT,
  path TEXT,
  sni TEXT,
  alpn TEXT,
  fingerprint TEXT,
  public_key TEXT,
  short_id TEXT,
  password TEXT,
  source_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  latency INTEGER,
  last_ok INTEGER NOT NULL DEFAULT 0,
  last_test TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL DEFAULT 'auto',
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  last_sync TEXT,
  last_ok INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  node_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  label TEXT,
  source TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  healthy INTEGER NOT NULL DEFAULT 0,
  latency INTEGER,
  last_test TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(kind,value)
)`,
`CREATE TABLE IF NOT EXISTS health (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  ok INTEGER NOT NULL,
  latency INTEGER,
  status INTEGER,
  error TEXT,
  tested_at TEXT NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
)`,
`CREATE INDEX IF NOT EXISTS idx_users_token ON users(token)`,
`CREATE INDEX IF NOT EXISTS idx_nodes_enabled ON nodes(enabled)`,
`CREATE INDEX IF NOT EXISTS idx_resources_kind ON resources(kind)`,
`CREATE INDEX IF NOT EXISTS idx_health_target ON health(target)`
];

async function initDb(env) {
  if (!env?.IOT_DB) return false;
  try {
    await env.IOT_DB.batch(SCHEMA.map(sql => env.IOT_DB.prepare(sql)));
    const seed = [
      ["version", VERSION],
      ["resource_mode", "builtin"],
      ["preferred_country", "auto"],
      ["preferred_colo", "auto"],
      ["preferred_count", "10"],
      ["proxy_fail_threshold", "2"],
      ["health_ttl", "900"],
      ["node_sync_ttl", "900"]
    ];
    for (const [k,v] of seed) {
      await env.IOT_DB.prepare(
        `INSERT INTO meta(key,value,updated_at) VALUES(?,?,?)
         ON CONFLICT(key) DO NOTHING`
      ).bind(k,v,now()).run();
    }
    await seedResources(env);
    return true;
  } catch (e) {
    return false;
  }
}
async function seedResources(env) {
  const t = now();
  const stmts = [];
  for (const v of BUILTIN.proxyDomains) {
    stmts.push(env.IOT_DB.prepare(
      `INSERT INTO resources(id,kind,value,label,source,enabled,healthy,updated_at)
       VALUES(?,?,?,?,?,1,0,?)
       ON CONFLICT(kind,value) DO NOTHING`
    ).bind(uid(), "proxyip", v, "内置 ProxyIP", "CloudIP/BPB/EdgeTunnel", t));
  }
  for (const v of BUILTIN.nat64Prefixes) {
    stmts.push(env.IOT_DB.prepare(
      `INSERT INTO resources(id,kind,value,label,source,enabled,healthy,updated_at)
       VALUES(?,?,?,?,?,1,0,?)
       ON CONFLICT(kind,value) DO NOTHING`
    ).bind(uid(), "nat64", v, "内置 NAT64", "BPB", t));
  }
  for (const v of BUILTIN.preferredSources) {
    stmts.push(env.IOT_DB.prepare(
      `INSERT INTO resources(id,kind,value,label,source,enabled,healthy,updated_at)
       VALUES(?,?,?,?,?,1,0,?)
       ON CONFLICT(kind,value) DO NOTHING`
    ).bind(uid(), "preferred-source", v, "CFnew IPDB", "CFnew", t));
  }
  for (const v of BUILTIN.nodeSources) {
    stmts.push(env.IOT_DB.prepare(
      `INSERT INTO sources(id,name,url,format,enabled,priority,created_at,updated_at)
       VALUES(?,?,?,?,1,50,?,?)
       ON CONFLICT(url) DO NOTHING`
    ).bind(uid(), "内置节点源", v, "auto", t, t));
  }
  if (stmts.length) {
    try { await env.IOT_DB.batch(stmts); } catch {}
  }
}
async function metaGet(env,key,def=null) {
  const r = await env.IOT_DB.prepare(`SELECT value FROM meta WHERE key=?`).bind(key).first();
  return r?.value ?? def;
}
async function metaSet(env,key,value) {
  await env.IOT_DB.prepare(
    `INSERT INTO meta(key,value,updated_at) VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`
  ).bind(key,String(value),now()).run();
}
async function log(env,level,action,detail="") {
  try { await env.IOT_DB.prepare(
    `INSERT INTO logs(level,action,detail,created_at) VALUES(?,?,?,?)`
  ).bind(level,action,detail,now()).run(); } catch {}
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

async function digestHex(s) {
  const b = new TextEncoder().encode(s);
  const h = await crypto.subtle.digest("SHA-256", b);
  return [...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function constantTime(a,b) {
  const x = await digestHex(a);
  const y = await digestHex(b);
  let n = x.length ^ y.length;
  for (let i=0;i<Math.min(x.length,y.length);i++) n |= x.charCodeAt(i)^y.charCodeAt(i);
  return n === 0;
}
function cookie(req,name) {
  const raw = req.headers.get("cookie") || "";
  const m = raw.match(new RegExp("(?:^|;\\s*)"+name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}
async function isAdmin(req,env) {
  const token = cookie(req,"cloudip_admin");
  if (!token || !env.IOT_DB) return false;
  const row = await env.IOT_DB.prepare(
    `SELECT value FROM meta WHERE key='session:'||?`
  ).bind(token).first().catch(()=>null);
  if (!row) return false;
  return new Date(row.value).getTime() > Date.now();
}
async function requireAdmin(req,env) {
  if (!(await isAdmin(req,env))) throw new Response("Unauthorized",{status:401});
}
async function login(req,env) {
  const body = await req.json().catch(()=>({}));
  const cfg = await getRuntimeConfig(env);
  if (cfg.master === DEFAULT_MASTER_KEY) {
    return json({ok:false,bootstrap:true,message:"尚未初始化管理员密钥，请访问 /setup"},503);
  }
  if (!body.password || !(await constantTime(String(body.password),String(cfg.master)))) {
    await log(env,"warn","login_failed","invalid master key");
    return json({ok:false,message:"管理员密钥错误"},401);
  }
  const token = randomToken();
  await metaSet(env,`session:${token}`,new Date(Date.now()+7*86400000).toISOString());
  return json({ok:true},200,{
    "set-cookie":`cloudip_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`
  });
}
async function logout(req,env) {
  const token=cookie(req,"cloudip_admin");
  if (token) await env.IOT_DB.prepare(`DELETE FROM meta WHERE key=?`).bind(`session:${token}`).run().catch(()=>{});
  return json({ok:true},200,{"set-cookie":"cloudip_admin=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict"});
}
async function setup(req,env) {
  const cfg=await getRuntimeConfig(env);
  if (cfg.master !== DEFAULT_MASTER_KEY) return json({ok:false,message:"已初始化"},409);
  const body=await req.json().catch(()=>({}));
  const password=String(body.password||"");
  if (password.length < 12) return json({ok:false,message:"管理员密钥至少 12 位"},400);
  const route=String(body.route||"").replace(/^\/+/,"").replace(/[^A-Za-z0-9_-]/g,"").slice(0,48) || uid(12);
  await metaSet(env,"manual_admin_route",route);
  await metaSet(env,"manual_master_key",password);
  await log(env,"info","manual_setup","administrator initialized");
  return json({ok:true,route});
}

/* -------------------------------------------------------------------------- */
/* Resource selection / health                                                */
/* -------------------------------------------------------------------------- */

async function fetchTimeout(url,opts={},ms=6500) {
  const c=new AbortController();
  const t=setTimeout(()=>c.abort(),ms);
  try { return await fetch(url,{...opts,signal:c.signal,redirect:"follow"}); }
  finally { clearTimeout(t); }
}
async function testProxyDomain(host) {
  const started=Date.now();
  try {
    const r=await fetchTimeout(`https://${host}/cdn-cgi/trace`,{
      headers:{"user-agent":"CloudIP-Health/1.2"}
    },5000);
    const ok=r.status>=200&&r.status<500;
    return {ok,latency:Date.now()-started,status:r.status,error:ok?"":`HTTP ${r.status}`};
  } catch(e) {
    return {ok:false,latency:Date.now()-started,status:0,error:String(e?.message||e)};
  }
}
async function testHttpIp(ip) {
  const started=Date.now();
  const host=ip.includes(":") ? `[${ip}]` : ip;
  try {
    const r=await fetchTimeout(`http://${host}/cdn-cgi/trace`,{
      headers:{"user-agent":"CloudIP-PreferredIP/1.2","host":"cloudflare.com"}
    },4500);
    const ok=r.status>=200&&r.status<500;
    return {ok,latency:Date.now()-started,status:r.status,error:ok?"":`HTTP ${r.status}`};
  } catch(e) {
    return {ok:false,latency:Date.now()-started,status:0,error:String(e?.message||e)};
  }
}
async function testResource(env,id,kind,value) {
  let r;
  if (kind==="proxyip") r=await testProxyDomain(value);
  else if (kind==="preferred-ip") r=await testHttpIp(value);
  else r={ok:true,latency:0,status:200,error:""};
  await env.IOT_DB.prepare(
    `UPDATE resources SET healthy=?,latency=?,last_test=?,failures=CASE WHEN ? THEN 0 ELSE failures+1 END,updated_at=? WHERE id=?`
  ).bind(r.ok?1:0,r.latency,now(),r.ok?1:0,now(),id).run();
  await env.IOT_DB.prepare(
    `INSERT INTO health(id,kind,target,ok,latency,status,error,tested_at) VALUES(?,?,?,?,?,?,?,?)`
  ).bind(uid(),"resource",value,r.ok?1:0,r.latency,r.status,r.error,now()).run();
  return r;
}
async function getResources(env,kind) {
  return (await env.IOT_DB.prepare(
    `SELECT id,kind,value,label,source,enabled,healthy,latency,failures,last_test
     FROM resources WHERE kind=? AND enabled=1 ORDER BY healthy DESC, latency ASC, updated_at DESC`
  ).bind(kind).all()).results || [];
}
async function syncPreferredIndex(env) {
  const url=BUILTIN.preferredSources[0];
  const r=await fetchTimeout(url,{headers:{"user-agent":"CloudIP/1.2"}},10000);
  if (!r.ok) throw new Error(`CFnew IPDB ${r.status}`);
  const data=await r.json();
  const entries=[];
  if (Array.isArray(data)) entries.push(...data);
  else if (Array.isArray(data?.data)) entries.push(...data.data);
  else if (data && typeof data==="object") {
    for (const [colo,v] of Object.entries(data)) {
      if (Array.isArray(v)) for (const x of v) entries.push({...x,colo});
      else if (v && Array.isArray(v.ips)) for (const ip of v.ips) entries.push({...v,ip,colo});
    }
  }
  let n=0;
  for (const x of entries.slice(0,5000)) {
    const ip=String(x.ip||x.address||x.host||"").trim();
    if (!ip) continue;
    const label=[x.country||x.cc||"",x.colo||"",x.city||""].filter(Boolean).join("-");
    await env.IOT_DB.prepare(
      `INSERT INTO resources(id,kind,value,label,source,enabled,healthy,latency,last_test,updated_at)
       VALUES(?,?,?,?,?,1,0,?,?,?)
       ON CONFLICT(kind,value) DO UPDATE SET label=excluded.label,source=excluded.source,updated_at=excluded.updated_at`
    ).bind(uid(),"preferred-ip",ip,label||"CFnew 优选 IP","CFnew IPDB",null,null,now()).run().catch(()=>{});
    n++;
  }
  return n;
}
async function healthPreferred(env,limit=20) {
  const rows=await env.IOT_DB.prepare(
    `SELECT id,value FROM resources WHERE kind='preferred-ip' AND enabled=1
     ORDER BY CASE WHEN healthy=1 THEN 0 ELSE 1 END, COALESCE(latency,999999) ASC LIMIT ?`
  ).bind(clamp(limit,1,50)).all();
  const out=[];
  for (const r of rows.results||[]) out.push(await testResource(env,r.id,"preferred-ip",r.value));
  return out;
}
async function healthProxyPool(env) {
  const rows=await env.IOT_DB.prepare(
    `SELECT id,value FROM resources WHERE kind='proxyip' AND enabled=1 ORDER BY failures ASC,updated_at ASC`
  ).all();
  const out=[];
  for (const r of rows.results||[]) out.push(await testResource(env,r.id,"proxyip",r.value));
  return out;
}
async function resourceSummary(env) {
  const kinds=["proxyip","nat64","preferred-ip"];
  const result={};
  for (const k of kinds) {
    const r=await env.IOT_DB.prepare(
      `SELECT COUNT(*) c,SUM(healthy) h,MIN(latency) min_latency FROM resources WHERE kind=? AND enabled=1`
    ).bind(k).first();
    result[k]={count:Number(r?.c||0),healthy:Number(r?.h||0),minLatency:r?.min_latency??null};
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Node parsing and subscription                                               */
/* -------------------------------------------------------------------------- */

function parseKv(s) {
  const o={};
  for(const p of String(s||"").split("&")){
    if(!p)continue;
    const i=p.indexOf("=");
    if(i<0)o[decodeURIComponent(p)]="";
    else o[decodeURIComponent(p.slice(0,i))]=decodeURIComponent(p.slice(i+1));
  }
  return o;
}
function parseVless(line,sourceId=null) {
  try {
    const u=new URL(line.trim());
    if(u.protocol!=="vless:")return null;
    const uuidv=u.username;
    if(!isUuid(uuidv))return null;
    const q=u.searchParams;
    const port=Number(u.port||443);
    return {
      id:uid(),name:decodeURIComponent(u.hash.slice(1))||`VLESS-${u.hostname}`,
      protocol:"vless",address:u.hostname,port,tls:q.get("security")==="tls"||port===443?1:0,
      host:q.get("host")||null,path:q.get("path")||"/",sni:q.get("sni")||u.hostname,
      alpn:q.get("alpn")||null,fingerprint:q.get("fp")||null,public_key:q.get("pbk")||null,
      short_id:q.get("sid")||null,password:uuidv,source_id:sourceId
    };
  } catch { return null; }
}
function parseTrojan(line,sourceId=null) {
  try {
    const u=new URL(line.trim());
    if(u.protocol!=="trojan:")return null;
    const password=decodeURIComponent(u.username);
    if(!password||!u.hostname)return null;
    const q=u.searchParams;
    return {
      id:uid(),name:decodeURIComponent(u.hash.slice(1))||`Trojan-${u.hostname}`,
      protocol:"trojan",address:u.hostname,port:Number(u.port||443),tls:1,
      host:q.get("host")||null,path:q.get("path")||"/",sni:q.get("sni")||u.hostname,
      alpn:q.get("alpn")||null,password,source_id:sourceId
    };
  } catch { return null; }
}
function parseNodeLine(line,sourceId) {
  line=String(line||"").trim();
  if(!line)return null;
  if(line.startsWith("vless://"))return parseVless(line,sourceId);
  if(line.startsWith("trojan://"))return parseTrojan(line,sourceId);
  return null;
}
function vlessUri(n,hostOverride=null,portOverride=null) {
  const host=hostOverride||n.address;
  const port=portOverride||n.port;
  const q=new URLSearchParams();
  q.set("encryption","none");
  q.set("type","ws");
  q.set("path",n.path||"/");
  if(n.host)q.set("host",n.host);
  if(n.tls) {
    q.set("security","tls");
    q.set("sni",n.sni||n.address);
    if(n.fingerprint)q.set("fp",n.fingerprint);
    if(n.public_key){q.set("pbk",n.public_key);if(n.short_id)q.set("sid",n.short_id);}
  } else q.set("security","none");
  return `vless://${encodeURIComponent(n.password)}@${host.includes(":")?`[${host}]`:host}:${port}?${q}#${encodeURIComponent(n.name)}`;
}
function trojanUri(n,hostOverride=null,portOverride=null) {
  const host=hostOverride||n.address,port=portOverride||n.port;
  const q=new URLSearchParams({security:"tls",type:"ws",path:n.path||"/",sni:n.sni||n.address});
  if(n.host)q.set("host",n.host);
  return `trojan://${encodeURIComponent(n.password)}@${host.includes(":")?`[${host}]`:host}:${port}?${q}#${encodeURIComponent(n.name)}`;
}
function clashProxy(n,hostOverride=null,portOverride=null) {
  const host=hostOverride||n.address,port=portOverride||n.port;
  if(n.protocol==="vless") return {
    name:n.name,type:"vless",server:host,port,
    uuid:n.password,udp:true,tls:!!n.tls,
    servername:n.sni||n.address,network:"ws",
    "ws-opts":{path:n.path||"/",headers:n.host?{Host:n.host}:{}}
  };
  return {
    name:n.name,type:"trojan",server:host,port,password:n.password,udp:true,
    sni:n.sni||n.address,network:"ws",
    "ws-opts":{path:n.path||"/",headers:n.host?{Host:n.host}:{}}
  };
}
function singboxOutbound(n,hostOverride=null,portOverride=null) {
  const host=hostOverride||n.address,port=portOverride||n.port;
  const o={type:n.protocol,tag:n.name,server:host,server_port:port};
  if(n.protocol==="vless"){o.uuid=n.password;o.flow="";}else{o.password=n.password;}
  o.tls={enabled:!!n.tls,server_name:n.sni||n.address};
  o.transport={type:"ws",path:n.path||"/",headers:n.host?{Host:n.host}:{}};
  return o;
}
function dedupeNodes(nodes) {
  const m=new Map();
  for(const n of nodes){
    const k=[n.protocol,n.address,n.port,n.password,n.path,n.sni].join("|");
    if(!m.has(k))m.set(k,n);
  }
  return [...m.values()];
}
async function syncSource(env,src) {
  const started=Date.now();
  try {
    const r=await fetchTimeout(src.url,{headers:{"user-agent":"ClashMeta/1.19.0 CloudIP/1.2"}},12000);
    if(!r.ok)throw new Error(`HTTP ${r.status}`);
    let body=await r.text();
    if(!body.includes("://")) {
      try { body=base64Decode(body); } catch {}
    }
    const lines=body.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    const parsed=[];
    for(const line of lines) {
      const n=parseNodeLine(line,src.id);
      if(n)parsed.push(n);
      if(parsed.length>=500)break;
    }
    for(const n of parsed) {
      await env.IOT_DB.prepare(
        `INSERT INTO nodes(id,name,protocol,address,port,tls,host,path,sni,alpn,fingerprint,public_key,short_id,password,source_id,enabled,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at`
      ).bind(n.id,n.name,n.protocol,n.address,n.port,n.tls,n.host,n.path,n.sni,n.alpn,n.fingerprint,n.public_key,n.short_id,n.password,n.source_id,1,now(),now()).run().catch(()=>{});
    }
    await env.IOT_DB.prepare(
      `UPDATE sources SET last_sync=?,last_ok=1,last_error=NULL,node_count=?,updated_at=? WHERE id=?`
    ).bind(now(),parsed.length,now(),src.id).run();
    await log(env,"info","source_sync",`${src.name}: ${parsed.length} nodes in ${Date.now()-started}ms`);
    return {ok:true,count:parsed.length};
  } catch(e) {
    await env.IOT_DB.prepare(
      `UPDATE sources SET last_sync=?,last_ok=0,last_error=?,updated_at=? WHERE id=?`
    ).bind(now(),String(e?.message||e).slice(0,500),now(),src.id).run().catch(()=>{});
    return {ok:false,error:String(e?.message||e)};
  }
}
async function syncSources(env) {
  const rows=await env.IOT_DB.prepare(
    `SELECT * FROM sources WHERE enabled=1 ORDER BY priority ASC`
  ).all();
  const out=[];
  for(const s of rows.results||[])out.push(await syncSource(env,s));
  return out;
}

/* -------------------------------------------------------------------------- */
/* Subscription builders                                                       */
/* -------------------------------------------------------------------------- */

function getBaseUrl(req) {
  const u=new URL(req.url);
  return `${u.protocol}//${u.host}`;
}
function userActive(u) {
  if(!u?.enabled)return false;
  if(u.expires_at && new Date(u.expires_at).getTime()<Date.now())return false;
  if(Number(u.traffic_limit)>0 && Number(u.traffic_used)>=Number(u.traffic_limit))return false;
  return true;
}
async function choosePreferred(env) {
  const rows=await env.IOT_DB.prepare(
    `SELECT value,label,latency FROM resources
     WHERE kind='preferred-ip' AND enabled=1 AND healthy=1
     ORDER BY latency ASC LIMIT 12`
  ).all();
  return rows.results||[];
}
async function chooseProxy(env) {
  const rows=await env.IOT_DB.prepare(
    `SELECT value,latency FROM resources WHERE kind='proxyip' AND enabled=1 AND healthy=1
     ORDER BY failures ASC,latency ASC LIMIT 8`
  ).all();
  if(rows.results?.length)return rows.results;
  const all=await env.IOT_DB.prepare(
    `SELECT value,latency FROM resources WHERE kind='proxyip' AND enabled=1 ORDER BY failures ASC,latency ASC LIMIT 8`
  ).all();
  return all.results||[];
}

function gatewayVlessUri(req,user,host,port){
  const origin=new URL(req.url);
  const isIp=ipLiteral(host);
  const q=new URLSearchParams({encryption:"none",type:"ws",path:`/ws/${user.token}`,security:"tls",sni:origin.hostname});
  q.set("host",origin.hostname);
  return `vless://${user.uuid}@${host.includes(":")?`[${host}]`:host}:${port}?${q}#${encodeURIComponent(`CloudIP-${host}`)}`;
}
function gatewayTrojanUri(req,user,host,port){
  const origin=new URL(req.url);
  const q=new URLSearchParams({security:"tls",type:"ws",path:`/ws/${user.token}`,sni:origin.hostname,host:origin.hostname});
  return `trojan://${encodeURIComponent(user.uuid)}@${host.includes(":")?`[${host}]`:host}:${port}?${q}#${encodeURIComponent(`CloudIP-${host}`)}`;
}
function gatewayClash(req,user,host,port,protocol="vless"){
  const origin=new URL(req.url);
  const name=`CloudIP-${host}-${port}-${protocol}`;
  if(protocol==="vless")return {name,type:"vless",server:host,port,uuid:user.uuid,udp:true,tls:true,servername:origin.hostname,network:"ws","ws-opts":{path:`/ws/${user.token}`,headers:{Host:origin.hostname}}};
  return {name,type:"trojan",server:host,port,password:user.uuid,udp:true,sni:origin.hostname,network:"ws","ws-opts":{path:`/ws/${user.token}`,headers:{Host:origin.hostname}}};
}
function gatewaySingbox(req,user,host,port,protocol="vless"){
  const origin=new URL(req.url),tag=`CloudIP-${host}-${port}-${protocol}`;
  const o={type:protocol,tag,server:host,server_port:port,tls:{enabled:true,server_name:origin.hostname},transport:{type:"ws",path:`/ws/${user.token}`,headers:{Host:origin.hostname}}};
  if(protocol==="vless")o.uuid=user.uuid;else o.password=user.uuid;
  return o;
}

async function buildSubscription(req,env,user,format="vless") {
  const preferred=await choosePreferred(env);
  const proxies=await chooseProxy(env);
  const selectedPorts=user.port_mode==="custom"
    ? JSON.parse(user.custom_ports||"[]").filter(Number.isInteger)
    : (user.port_mode==="https"?BUILTIN.ports.https:BUILTIN.ports.https.slice(0,3));
  const ports=selectedPorts.length?selectedPorts:[443];
  const hosts=[];
  const origin=new URL(req.url).hostname;
  hosts.push({value:origin,label:"官方域名"});
  for(const p of preferred.slice(0,10))hosts.push({value:p.value,label:p.label||"优选IP"});
  for(const p of proxies.slice(0,4))hosts.push({value:p.value,label:"ProxyIP"});
  const uniq=[];const seen=new Set();
  for(const h of hosts){const k=h.value;if(!seen.has(k)){seen.add(k);uniq.push(h)}}
  const v=[],t=[],cl=[],sb=[];
  for(const h of uniq)for(const port of ports){
    v.push(gatewayVlessUri(req,user,h.value,port));
    t.push(gatewayTrojanUri(req,user,h.value,port));
    cl.push(gatewayClash(req,user,h.value,port,"vless"));
    cl.push(gatewayClash(req,user,h.value,port,"trojan"));
    sb.push(gatewaySingbox(req,user,h.value,port,"vless"));
    sb.push(gatewaySingbox(req,user,h.value,port,"trojan"));
  }
  if(format==="clash")return JSON.stringify({
    "mixed-port":7890,"mode":"rule","allow-lan":false,
    proxies:cl,
    "proxy-groups":[
      {name:"CloudIP 自动选择",type:"url-test",proxies:cl.map(x=>x.name),url:"https://www.gstatic.com/generate_204",interval:300},
      {name:"CloudIP 节点",type:"select",proxies:cl.map(x=>x.name)}
    ],
    rules:["MATCH,CloudIP 自动选择"]
  },null,2);
  if(format==="singbox")return JSON.stringify({
    log:{level:"warn"},outbounds:[...sb,{type:"direct",tag:"direct"}],
    route:{final:sb[0]?.tag||"direct"}
  },null,2);
  const lines=[...v,...t];
  if(!lines.length)return "# CloudIP: 暂无健康资源，请稍后重试";
  if(format==="base64")return btoa(unescape(encodeURIComponent(lines.join("\n"))));
  return lines.join("\n")+"\n";
}

/* -------------------------------------------------------------------------- */
/* VLESS/Trojan WebSocket server                                               */
/* -------------------------------------------------------------------------- */

const textDecoder = new TextDecoder();
function readU16(a,i){return (a[i]<<8)|a[i+1];}
function readU8(a,i){return a[i];}
function concatBytes(a,b){
  const o=new Uint8Array(a.length+b.length);o.set(a);o.set(b,a.length);return o;
}
async function parseVlessHeader(buf) {
  const a=new Uint8Array(buf);
  if(a.length<24)throw new Error("short vless header");
  const version=a[0];
  const uuidBytes=a.slice(1,17);
  const port=readU16(a,18);
  const at=a[17];
  let off=19;
  const addrType=a[off++];
  let host="";
  if(addrType===1){host=[a[off++],a[off++],a[off++],a[off++]].join(".");}
  else if(addrType===2){const l=a[off++];host=textDecoder.decode(a.slice(off,off+l));off+=l;}
  else if(addrType===3){
    const parts=[];for(let i=0;i<8;i++){parts.push(readU16(a,off).toString(16));off+=2;}host=parts.join(":");
  } else throw new Error("unknown address type");
  if(a.length<off+1)throw new Error("missing command");
  const command=a[off++];
  const optLen=at;
  off+=optLen;
  if(a.length<off)throw new Error("bad option");
  return {version,uuid:bytesToUuid(uuidBytes),port,host,command,data:a.slice(off)};
}
function bytesToUuid(a){
  const h=[...a].map(x=>x.toString(16).padStart(2,"0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
async function connectTcp(host,port) {
  if(typeof connect!=="function")throw new Error("Cloudflare connect() unavailable in this runtime");
  return await connect({hostname:host,port});
}
async function pipeWsToTcp(ws,socket,initial) {
  const writer=socket.writable.getWriter();
  const reader=socket.readable.getReader();
  if(initial?.length)await writer.write(initial);
  ws.binaryType="arraybuffer";
  const readLoop=(async()=>{
    try {
      while(true){
        const {value,done}=await reader.read();
        if(done)break;
        if(value)ws.send(value);
      }
    } catch {}
    try{ws.close();}catch{}
  })();
  ws.addEventListener("message",async e=>{
    try {
      if(typeof e.data==="string")return;
      await writer.write(new Uint8Array(e.data));
    } catch { try{ws.close();}catch{} }
  });
  ws.addEventListener("close",async()=>{try{await writer.close();}catch{}});
  await readLoop;
}
async function handleWs(req,env,user) {
  const up=req.headers.get("Upgrade");
  if(String(up||"").toLowerCase()!=="websocket")return text("WebSocket required",426);
  const pair=new WebSocketPair();
  const [client,server]=Object.values(pair);
  server.accept();
  let first=true,buf=new Uint8Array(0),socket=null,mode="";
  const startPipe=async(head)=>{
    socket=await connectTcp(head.host,head.port);
    const w=socket.writable.getWriter();
    if(head.data?.length)await w.write(head.data);
    w.releaseLock();
    const reader=socket.readable.getReader();
    (async()=>{try{while(true){const {value,done}=await reader.read();if(done)break;if(value)server.send(value)}}catch{}try{server.close()}catch{}})();
  };
  server.addEventListener("message",async e=>{
    try{
      if(typeof e.data==="string")return;
      const chunk=new Uint8Array(e.data);
      if(first){
        buf=concatBytes(buf,chunk);
        if(buf.length<24)return;
        if(looksTrojan(buf)){
          if(buf.length<70)return;
          const th=parseTrojanHeader(buf);
          const expected=sha224Hex(user.password||user.uuid);
          if(!(await constantTime(th.passwordHash,expected)))throw new Error("invalid trojan password");
          mode="trojan";first=false;await startPipe(th);
        } else {
          const head=await parseVlessHeader(buf);
          if(head.uuid!==user.uuid)throw new Error("invalid uuid");
          if(head.command!==1)throw new Error("only TCP is supported");
          mode="vless";first=false;await startPipe(head);
        }
      } else if(socket){
        const wr=socket.writable.getWriter();await wr.write(chunk);wr.releaseLock();
      }
    }catch(err){try{server.close(1011,String(err?.message||err).slice(0,120));}catch{}}
  });
  server.addEventListener("close",()=>{try{socket?.close()}catch{}});
  return new Response(null,{status:101,webSocket:client});
}

/* -------------------------------------------------------------------------- */
/* Admin UI                                                                   */
/* -------------------------------------------------------------------------- */

const ADMIN_CSS = `
:root{--bg:#f5f7fb;--card:#fff;--text:#152033;--muted:#718096;--blue:#2563eb;--line:#e5e7eb;--green:#16a34a;--red:#dc2626}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
button,input,select,textarea{font:inherit}button{cursor:pointer;border:0}.app{display:flex;min-height:100vh}.side{width:235px;background:#fff;border-right:1px solid var(--line);padding:24px 14px;position:sticky;top:0;height:100vh}
.logo{font-size:24px;font-weight:800;padding:0 14px 24px;color:#2563eb}.nav button{width:100%;padding:11px 13px;text-align:left;background:transparent;border-radius:10px;color:#425066;margin:2px 0}.nav button.active,.nav button:hover{background:#eef4ff;color:#2563eb}
.main{flex:1;padding:30px;max-width:1500px;margin:auto;width:100%}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}.title{font-size:25px;font-weight:800}.sub{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px}.metric{font-size:28px;font-weight:800}.metric small{font-size:13px;font-weight:500;color:var(--muted)}
table{width:100%;border-collapse:collapse}th,td{padding:11px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:#65748b;font-weight:600}
.btn{padding:9px 13px;border-radius:9px;background:#eef2f7;color:#24344d}.primary{background:var(--blue);color:#fff}.danger{background:#fff0f0;color:var(--red)}.success{background:#ecfdf3;color:var(--green)}
.actions{display:flex;gap:8px;flex-wrap:wrap}.form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.field{display:flex;flex-direction:column;gap:6px}.field.full{grid-column:1/-1}.field input,.field select,.field textarea{border:1px solid var(--line);border-radius:9px;padding:10px;background:#fff;outline:none}.field input:focus,.field select:focus,.field textarea:focus{border-color:#8bb0ff;box-shadow:0 0 0 3px #edf3ff}
.badge{display:inline-block;padding:3px 8px;border-radius:99px;font-size:12px;background:#edf2f7}.ok{background:#ecfdf3;color:#15803d}.bad{background:#fff1f2;color:#be123c}.hidden{display:none}.toast{position:fixed;right:20px;bottom:20px;background:#152033;color:#fff;padding:12px 16px;border-radius:10px;z-index:99}
@media(max-width:900px){.side{width:68px}.logo{font-size:0}.logo:after{content:'C';font-size:24px}.nav button{font-size:0;text-align:center}.nav button:before{content:'•';font-size:20px}.grid{grid-template-columns:repeat(2,1fr)}.main{padding:18px}.form{grid-template-columns:1fr}}
@media(max-width:560px){.grid{grid-template-columns:1fr}.side{display:none}.main{padding:12px}.top{align-items:flex-start}.title{font-size:20px}}
`;

const ADMIN_JS = `
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
let state={tab:'dashboard',user:null};
async function api(path,opt={}){const r=await fetch(path,{...opt,headers:{'content-type':'application/json',...(opt.headers||{})}});const t=await r.text();let d={};try{d=JSON.parse(t)}catch{d={raw:t}}if(!r.ok)throw new Error(d.message||d.raw||'请求失败');return d}
function toast(s){const x=document.createElement('div');x.className='toast';x.textContent=s;document.body.append(x);setTimeout(()=>x.remove(),2800)}
function layout(){document.body.innerHTML='<div class="app"><aside class="side"><div class="logo">CloudIP</div><nav class="nav">'+
['dashboard:仪表盘','users:用户管理','nodes:节点管理','resources:资源中心','tests:节点测试','settings:系统设置','logs:系统日志'].map(x=>{let [a,b]=x.split(':');return '<button data-tab="'+a+'">'+b+'</button>'}).join('')+
'<button id="logout">退出登录</button></nav></aside><main class="main"><div class="top"><div><div class="title">CloudIP 管理后台</div><div class="sub">Worker + D1 · 内置资源自动检测与故障切换</div></div><div class="actions"><button class="btn" id="refresh">刷新</button></div></div><section id="view"></section></main></div>';
$$('[data-tab]').forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;render()});$('#logout').onclick=async()=>{await api('/api/admin/logout',{method:'POST'});location.reload()};$('#refresh').onclick=render;render()}
async function render(){try{if(state.tab==='dashboard')return dashboard();if(state.tab==='users')return users();if(state.tab==='nodes')return nodes();if(state.tab==='resources')return resources();if(state.tab==='tests')return tests();if(state.tab==='settings')return settings();if(state.tab==='logs')return logs()}catch(e){toast(e.message)}}
async function dashboard(){const d=await api('/api/admin/dashboard');$('#view').innerHTML='<div class="grid">'+
[['用户',d.users],['节点',d.nodes],['在线节点',d.online],['今日日志',d.logs]].map(x=>'<div class="card"><div class="sub">'+x[0]+'</div><div class="metric">'+x[1]+'</div></div>').join('')+
'</div><div class="card"><h3>内置资源状态</h3><div class="grid">'+Object.entries(d.resources).map(([k,v])=>'<div><b>'+k+'</b><div>'+v.healthy+' / '+v.count+' 健康</div><div class="sub">最低延迟 '+(v.minLatency??'-')+' ms</div></div>').join('')+'</div></div>'+
'<div class="card"><h3>自动任务</h3><div class="actions"><button class="btn primary" onclick="job(\\'health\\')">立即检测资源</button><button class="btn primary" onclick="job(\\'preferred\\')">同步优选 IP</button><button class="btn primary" onclick="job(\\'nodes\\')">同步节点</button></div><p class="sub">默认内置资源不会在这里展开显示；只有执行自定义操作时才会显示输入界面。</p></div>'}
async function job(k){try{const d=await api('/api/admin/job',{method:'POST',body:JSON.stringify({job:k})});toast(d.message||'完成');render()}catch(e){toast(e.message)}}
async function users(){const d=await api('/api/admin/users');$('#view').innerHTML='<div class="card"><div class="top"><h3>用户管理</h3><button class="btn primary" onclick="newUser()">新增用户</button></div><table><thead><tr><th>名称</th><th>UUID</th><th>状态</th><th>流量</th><th>到期</th><th>订阅</th><th>操作</th></tr></thead><tbody>'+d.items.map(u=>'<tr><td>'+u.name+'</td><td><code>'+u.uuid+'</code></td><td><span class="badge '+(u.enabled?'ok':'bad')+'">'+(u.enabled?'启用':'禁用')+'</span></td><td>'+fmt(u.traffic_used)+' / '+fmt(u.traffic_limit)+'</td><td>'+(u.expires_at||'不限')+'</td><td><button class="btn" onclick="sub(\\''+u.token+'\\')">获取订阅</button></td><td><button class="btn" onclick="toggleUser(\\''+u.id+'\\')">切换</button> <button class="btn danger" onclick="delUser(\\''+u.id+'\\')">删除</button></td></tr>').join('')+'</tbody></table></div>'}
function fmt(n){n=Number(n||0);if(!n)return'不限';const u=['B','KB','MB','GB','TB'];let i=0;while(n>=1024&&i<4){n/=1024;i++}return n.toFixed(i?1:0)+' '+u[i]}
async function newUser(){const name=prompt('用户名称','用户-'+Date.now());if(!name)return;const mode=prompt('端口模式：auto / https / custom','auto')||'auto';let ports=[];if(mode==='custom'){ports=prompt('自定义端口，逗号分隔','443,8443')?.split(',').map(x=>Number(x.trim())).filter(x=>x>=1&&x<=65535)||[]}const limit=prompt('流量上限（GB，0=不限）','0')||'0';const d=await api('/api/admin/users',{method:'POST',body:JSON.stringify({name,port_mode:mode,custom_ports:ports,traffic_limit:Math.floor(Number(limit)*1024*1024*1024)||0})});toast('创建成功，订阅 Token：'+d.token);users()}
async function sub(t){const d=await api('/api/admin/subscription/'+t);prompt('复制订阅链接',d.url)}
async function toggleUser(id){await api('/api/admin/users/'+id,{method:'PATCH',body:JSON.stringify({toggle:true})});users()}
async function delUser(id){if(confirm('确认删除？')){await api('/api/admin/users/'+id,{method:'DELETE'});users()}}
async function nodes(){const d=await api('/api/admin/nodes');$('#view').innerHTML='<div class="card"><div class="top"><h3>节点管理</h3><div class="actions"><button class="btn primary" onclick="job(\\'nodes\\')">同步来源</button><button class="btn" onclick="job(\\'node-test\\')">检测节点</button></div></div><table><thead><tr><th>名称</th><th>协议</th><th>地址</th><th>端口</th><th>状态</th><th>延迟</th></tr></thead><tbody>'+d.items.map(n=>'<tr><td>'+n.name+'</td><td>'+n.protocol+'</td><td>'+n.address+'</td><td>'+n.port+'</td><td><span class="badge '+(n.last_ok?'ok':'bad')+'">'+(n.last_ok?'可用':'未验证')+'</span></td><td>'+(n.latency??'-')+'</td></tr>').join('')+'</tbody></table></div>'}
async function resources(){const d=await api('/api/admin/resources');$('#view').innerHTML='<div class="card"><h3>资源中心</h3><p>内置模式默认隐藏具体资源地址，并自动轮换。点击“自定义”才显示输入框。</p><div class="grid">'+
['proxyip','nat64','preferred-ip'].map(k=>'<div class="card"><b>'+k+'</b><p>'+d.summary[k].healthy+' / '+d.summary[k].count+' 健康</p><button class="btn" onclick="custom(\\''+k+'\\')">自定义</button><button class="btn primary" onclick="check(\\''+k+'\\')">立即检测</button></div>').join('')+'</div></div>'}
async function custom(k){const v=prompt('输入自定义 '+k+'，多个值用逗号分隔；留空恢复内置');await api('/api/admin/resources/custom',{method:'POST',body:JSON.stringify({kind:k,value:v||''})});toast('已保存');resources()}
async function check(k){const d=await api('/api/admin/resources/check',{method:'POST',body:JSON.stringify({kind:k})});toast(d.message||'完成');resources()}
async function tests(){const d=await api('/api/admin/tests');$('#view').innerHTML='<div class="card"><h3>节点测试</h3><p>这里执行实际 HTTP/TLS/WS 可达性测试，不以 ping 结果冒充节点可用性。</p><button class="btn primary" onclick="job(\\'node-test\\')">开始测试</button><pre>'+esc(JSON.stringify(d,null,2))+'</pre></div>'}
function esc(x){return String(x).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
async function settings(){const d=await api('/api/admin/settings');$('#view').innerHTML='<div class="card"><h3>系统设置</h3><div class="form"><div class="field"><label>优选 IP 数量</label><input id="pc" value="'+d.preferred_count+'"></div><div class="field"><label>节点同步间隔（秒）</label><input id="nt" value="'+d.node_sync_ttl+'"></div><div class="field full"><label>说明</label><textarea readonly>ProxyIP、NAT64、优选 IP 默认使用内置维护源。用户不填写自定义值时自动使用内置池；健康检测失败的资源会降低优先级并自动切换。</textarea></div></div><button class="btn primary" onclick="saveSettings()">保存</button></div>'}
async function saveSettings(){await api('/api/admin/settings',{method:'POST',body:JSON.stringify({preferred_count:$('#pc').value,node_sync_ttl:$('#nt').value})});toast('已保存')}
async function logs(){const d=await api('/api/admin/logs');$('#view').innerHTML='<div class="card"><h3>系统日志</h3><table><thead><tr><th>时间</th><th>级别</th><th>动作</th><th>详情</th></tr></thead><tbody>'+d.items.map(x=>'<tr><td>'+x.created_at+'</td><td>'+x.level+'</td><td>'+x.action+'</td><td>'+x.detail+'</td></tr>').join('')+'</tbody></table></div>'}
async function start(){try{await api('/api/admin/me');layout()}catch{document.body.innerHTML='<div style="max-width:420px;margin:12vh auto;padding:28px;background:#fff;border:1px solid #e5e7eb;border-radius:16px;font-family:system-ui"><h1>CloudIP 管理后台</h1><p>请输入管理员密钥</p><input id="pw" type="password" style="width:100%;padding:12px;border:1px solid #ddd;border-radius:9px"><button id="go" style="width:100%;margin-top:12px;padding:12px;background:#2563eb;color:#fff;border:0;border-radius:9px">登录</button><p id="msg"></p></div>';$('#go').onclick=async()=>{try{await api('/api/admin/login',{method:'POST',body:JSON.stringify({password:$('#pw').value})});location.reload()}catch(e){$('#msg').textContent=e.message}}}}
start();
`;

function adminPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CloudIP 管理后台</title><style>${ADMIN_CSS}</style></head><body><script>${ADMIN_JS}</script></body></html>`;
}
function setupPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CloudIP 初始化</title><style>body{font-family:system-ui;background:#f5f7fb}.box{max-width:460px;margin:10vh auto;background:white;padding:28px;border-radius:16px;border:1px solid #ddd}input,button{width:100%;padding:12px;margin-top:10px}button{background:#2563eb;color:white;border:0;border-radius:8px}</style><div class="box"><h2>CloudIP 首次初始化</h2><p>设置管理员密钥和后台随机访问路径。</p><input id="p" type="password" placeholder="至少12位管理员密钥"><input id="r" placeholder="后台路径，例如 admin-8x2k（留空自动生成）"><button onclick="go()">初始化</button><pre id="m"></pre></div><script>async function go(){const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:p.value,route:r.value})});const d=await r.json();m.textContent=d.ok?'初始化完成，请访问 /'+d.route+'/admin':d.message}</script>`;
}

/* -------------------------------------------------------------------------- */
/* Admin API                                                                   */
/* -------------------------------------------------------------------------- */

async function adminApi(req,env,path) {
  await requireAdmin(req,env);
  if(path==="/api/admin/me")return json({ok:true,version:VERSION});
  if(path==="/api/admin/logout"&&req.method==="POST")return logout(req,env);
  if(path==="/api/admin/dashboard"){
    const [u,n,l,r,o]=await Promise.all([
      env.IOT_DB.prepare(`SELECT COUNT(*) c FROM users`).first(),
      env.IOT_DB.prepare(`SELECT COUNT(*) c FROM nodes WHERE enabled=1`).first(),
      env.IOT_DB.prepare(`SELECT COUNT(*) c FROM logs WHERE created_at>=date('now')`).first(),
      resourceSummary(env),
      env.IOT_DB.prepare(`SELECT COUNT(*) c FROM nodes WHERE enabled=1 AND last_ok=1`).first()
    ]);
    return json({version:VERSION,users:Number(u?.c||0),nodes:Number(n?.c||0),logs:Number(l?.c||0),online:Number(o?.c||0),resources:r});
  }
  if(path==="/api/admin/users"&&req.method==="GET"){
    return json({items:(await env.IOT_DB.prepare(`SELECT * FROM users ORDER BY created_at DESC LIMIT 500`).all()).results||[]});
  }
  if(path==="/api/admin/users"&&req.method==="POST"){
    const b=await req.json().catch(()=>({}));const u={id:uid(),name:String(b.name||"用户"),uuid:uuid(),token:randomToken(),port_mode:["auto","https","custom"].includes(b.port_mode)?b.port_mode:"auto",custom_ports:JSON.stringify(Array.isArray(b.custom_ports)?b.custom_ports.map(Number).filter(x=>x>=1&&x<=65535).slice(0,20):[]),traffic_limit:Number(b.traffic_limit||0),created_at:now(),updated_at:now()};
    await env.IOT_DB.prepare(`INSERT INTO users(id,name,uuid,token,port_mode,custom_ports,traffic_limit,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`).bind(u.id,u.name,u.uuid,u.token,u.port_mode,u.custom_ports,u.traffic_limit,u.created_at,u.updated_at).run();
    return json(u,201);
  }
  if(path.startsWith("/api/admin/users/")){
    const id=path.split("/").pop();
    if(req.method==="PATCH"){
      const b=await req.json().catch(()=>({}));
      if(b.toggle)await env.IOT_DB.prepare(`UPDATE users SET enabled=CASE enabled WHEN 1 THEN 0 ELSE 1 END,updated_at=? WHERE id=?`).bind(now(),id).run();
      return json({ok:true});
    }
    if(req.method==="DELETE"){await env.IOT_DB.prepare(`DELETE FROM users WHERE id=?`).bind(id).run();return json({ok:true});}
  }
  if(path==="/api/admin/subscription/"){
    return json({ok:false},404);
  }
  if(path.startsWith("/api/admin/subscription/")){
    const t=path.split("/").pop();const u=await env.IOT_DB.prepare(`SELECT * FROM users WHERE token=?`).bind(t).first();
    if(!u)return json({ok:false},404);
    return json({url:`${getBaseUrl(req)}/sub/${u.token}`});
  }
  if(path==="/api/admin/nodes")return json({items:(await env.IOT_DB.prepare(`SELECT * FROM nodes ORDER BY COALESCE(latency,999999) ASC LIMIT 500`).all()).results||[]});
  if(path==="/api/admin/resources")return json({summary:await resourceSummary(env)});
  if(path==="/api/admin/resources/custom"&&req.method==="POST"){
    const b=await req.json().catch(()=>({}));const kind=String(b.kind||"");
    if(!["proxyip","nat64","preferred-ip"].includes(kind))return json({ok:false},400);
    await env.IOT_DB.prepare(`DELETE FROM resources WHERE kind=? AND source='custom'`).bind(kind).run();
    const vals=String(b.value||"").split(/[,\\n]/).map(x=>x.trim()).filter(Boolean).slice(0,100);
    for(const v of vals)await env.IOT_DB.prepare(`INSERT INTO resources(id,kind,value,label,source,enabled,healthy,updated_at) VALUES(?,?,?,?, 'custom',1,0,?)`).bind(uid(),kind,v,"自定义",now()).run();
    return json({ok:true,count:vals.length});
  }
  if(path==="/api/admin/resources/check"&&req.method==="POST"){
    const b=await req.json().catch(()=>({}));const kind=String(b.kind||"");
    if(kind==="proxyip")await healthProxyPool(env);
    if(kind==="preferred-ip")await healthPreferred(env,20);
    return json({ok:true,message:"检测完成"});
  }
  if(path==="/api/admin/job"&&req.method==="POST"){
    const b=await req.json().catch(()=>({}));const j=String(b.job||"");
    if(j==="health"){await healthProxyPool(env);await healthPreferred(env,20);return json({ok:true,message:"资源检测完成"});}
    if(j==="preferred"){const n=await syncPreferredIndex(env);await healthPreferred(env,20);return json({ok:true,message:`优选 IP 同步 ${n} 条`});}
    if(j==="nodes"){const r=await syncSources(env);return json({ok:true,message:`节点源同步完成 ${r.length} 个来源`});}
    if(j==="node-test"){const rows=await env.IOT_DB.prepare(`SELECT id,address FROM nodes WHERE enabled=1 LIMIT 40`).all();let ok=0;for(const n of rows.results||[]){const t=Date.now();try{const r=await fetchTimeout(`https://${n.address}/`,{},4000);await env.IOT_DB.prepare(`UPDATE nodes SET last_ok=?,latency=?,last_test=?,updated_at=? WHERE id=?`).bind(r.ok?1:0,Date.now()-t,now(),now(),n.id).run();if(r.ok)ok++;}catch{await env.IOT_DB.prepare(`UPDATE nodes SET last_ok=0,last_test=?,updated_at=? WHERE id=?`).bind(now(),now(),n.id).run()}}return json({ok:true,message:`实际测试完成，可用 ${ok} 个`});}
  }
  if(path==="/api/admin/tests")return json({summary:await resourceSummary(env)});
  if(path==="/api/admin/settings"&&req.method==="GET")return json({preferred_count:await metaGet(env,"preferred_count","10"),node_sync_ttl:await metaGet(env,"node_sync_ttl","900")});
  if(path==="/api/admin/settings"&&req.method==="POST"){const b=await req.json().catch(()=>({}));if(b.preferred_count!=null)await metaSet(env,"preferred_count",clamp(b.preferred_count,1,50));if(b.node_sync_ttl!=null)await metaSet(env,"node_sync_ttl",clamp(b.node_sync_ttl,60,86400));return json({ok:true});}
  if(path==="/api/admin/logs")return json({items:(await env.IOT_DB.prepare(`SELECT * FROM logs ORDER BY id DESC LIMIT 300`).all()).results||[]});
  return json({message:"Not found"},404);
}

/* -------------------------------------------------------------------------- */
/* Public routing                                                              */
/* -------------------------------------------------------------------------- */

async function publicSubscription(req,env,token,format) {
  const u=await env.IOT_DB.prepare(`SELECT * FROM users WHERE token=?`).bind(token).first();
  if(!u||!userActive(u))return text("subscription disabled or expired",403);
  if(format==="clash")return new Response(await buildSubscription(req,env,u,"clash"),{headers:{"content-type":"text/yaml; charset=utf-8","cache-control":"no-store"}});
  if(format==="singbox")return new Response(await buildSubscription(req,env,u,"singbox"),{headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
  if(format==="base64")return new Response(await buildSubscription(req,env,u,"base64"),{headers:{"content-type":"text/plain; charset=utf-8","cache-control":"no-store"}});
  return new Response(await buildSubscription(req,env,u,"raw"),{headers:{"content-type":"text/plain; charset=utf-8","cache-control":"no-store"}});
}
async function publicWs(req,env,token) {
  const u=await env.IOT_DB.prepare(`SELECT * FROM users WHERE token=?`).bind(token).first();
  if(!u||!userActive(u))return text("disabled",403);
  return handleWs(req,env,u);
}

async function scheduled(env) {
  await initDb(env);
  try { await syncPreferredIndex(env); } catch {}
  try { await healthProxyPool(env); } catch {}
  try { await healthPreferred(env,20); } catch {}
  try { await syncSources(env); } catch {}
  await log(env,"info","scheduled","automatic maintenance completed");
}

async function fetchHandler(req,env,ctx) {
  await initDb(env);
  const u=new URL(req.url);
  const cfg=await getRuntimeConfig(env);
  const p=u.pathname;
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:{"access-control-allow-origin":"*","access-control-allow-methods":"GET,POST,PATCH,DELETE,OPTIONS","access-control-allow-headers":"content-type"}});
  if(p==="/health")return json({ok:true,version:VERSION,db:!!env.IOT_DB});
  if(p==="/robots.txt")return text("User-agent: *\\nDisallow: /");
  if(cfg.master===DEFAULT_MASTER_KEY && (p==="/setup" || p===`/${cfg.route}/setup`)){
    if(req.method==="POST")return setup(req,env);
    return html(setupPage());
  }
  if(p===`/${cfg.route}`||p===`/${cfg.route}/`||p===`/${cfg.route}/admin`||p===`/${cfg.route}/admin/`){
    return html(adminPage());
  }
  if(p.startsWith(`/${cfg.route}/api/`))return adminApi(req,env,p.slice(cfg.route.length));
  if(p==="/api/admin/login"&&req.method==="POST")return login(req,env);
  if(p==="/api/admin/logout"&&req.method==="POST")return logout(req,env);
  if(p.startsWith("/sub/")){
    const token=p.split("/")[2]||"";
    const fmt=u.searchParams.get("format")||u.searchParams.get("type")||"raw";
    return publicSubscription(req,env,token,fmt);
  }
  if(p.startsWith("/ws/")){
    const token=p.split("/")[2]||"";
    return publicWs(req,env,token);
  }
  if(p.startsWith("/clash/")){
    const token=p.split("/")[2]||"";
    return publicSubscription(req,env,token,"clash");
  }
  if(p.startsWith("/singbox/")){
    const token=p.split("/")[2]||"";
    return publicSubscription(req,env,token,"singbox");
  }
  if(p.startsWith("/base64/")){
    const token=p.split("/")[2]||"";
    return publicSubscription(req,env,token,"base64");
  }
  if(p==="/"||p==="/index.html")return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CloudIP</title><style>body{font-family:system-ui;background:#f5f7fb;text-align:center;padding:15vh 20px}main{max-width:680px;margin:auto;background:#fff;padding:40px;border-radius:18px}a{color:#2563eb}</style><main><h1>CloudIP</h1><p>服务运行正常</p><p><a href="/${esc(cfg.route)}/admin">进入管理后台</a></p></main>`);
  return text("Not Found",404);
}

export default {
  async fetch(req,env,ctx){return fetchHandler(req,env,ctx);},
  async scheduled(controller,env,ctx){ctx.waitUntil(scheduled(env));}
};
