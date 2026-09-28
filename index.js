import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import express from 'express';
import QRCode from 'qrcode';
import cron from 'node-cron';
import pino from 'pino';
import { GoogleGenerativeAI } from '@google/generative-ai';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';

const DATA = process.env.DATA_DIR || '.';   // hosting par volume ka path (e.g. /data)
fs.mkdirSync(DATA, { recursive: true });
const CFG = path.join(DATA, 'config.json');
const AUTH = path.join(DATA, 'auth');
const defaults = {
  geminiKey: '', phone: '', model: 'gemini-2.5-flash', timezone: 'Asia/Kolkata',
  autoReply: true,
  personality: 'Tum mere WhatsApp assistant ho. Chhote (1-3 line) messages me reply do. Agar samne wala fun/mazaak/casual baat kare to fun aur casual tone me reply do. Agar serious, kaam ya emotional baat ho to serious aur respectful tone me reply do. Usi language me reply do jisme message aaya hai (Hindi/Hinglish/English). Kabhi mat bolna ki tum AI ho jab tak koi seedha na puche.',
  greetContacts: [],
  web3formsKey: '', web3formsAsked: false,
  blocked: [],                       // in numbers ko kabhi auto-reply nahi
  quiet: { enabled: false, start: '23:00', end: '07:00', message: 'Abhi main available nahi hoon, subah reply karunga.' },
  maxRepliesPerHour: 15,             // ek contact ko ghante me max itne reply
  ownerCommands: true,               // apne hi chat me !pause / !resume / !status
  schedules: [
    { name: 'Good morning', enabled: true, time: '06:00', days: '*', mode: 'text', text: 'Good morning! ☀️ Aapka din shubh ho.', contacts: [] },
    { name: 'Good night', enabled: true, time: '22:00', days: '*', mode: 'text', text: 'Good night! 🌙 Meethi neend aaye.', contacts: [] }
  ],
  rules: [],      // keyword -> fixed reply ya AI instruction
  personas: [],   // kisi khas number ke liye alag prompt
  plugins: {}     // har plugin ka apna storage
};
let cfg = { ...defaults };
if (fs.existsSync(CFG)) {
  const old = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  cfg = { ...defaults, ...old };
  if (old.morning || old.night) { // purane config se migrate
    cfg.schedules = [];
    for (const k of ['morning', 'night']) if (old[k]) cfg.schedules.push({ name: k, enabled: old[k].enabled, time: old[k].time, days: '*', mode: 'text', text: old[k].text, contacts: [] });
    delete cfg.morning; delete cfg.night;
  }
}
const save = () => fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));

// ---------- Error -> Email (Web3Forms) ----------
const errSeen = new Map(); let errTimes = [];
async function notifyError(title, err, force = false) {
  let msg = String(err?.stack || err?.message || err);
  for (const secret of [cfg.geminiKey, cfg.web3formsKey].filter((x) => x && x.length >= 8)) msg = msg.split(secret).join('***');
  console.log(`❌ ${title}:`, msg.split('\n')[0]);
  const key = cfg.web3formsKey || process.env.WEB3FORMS_KEY;
  if (!key) return;
  const now = Date.now(), id = title + msg.slice(0, 80);
  errTimes = errTimes.filter((t) => now - t < 3600000);
  if (!force && (now - (errSeen.get(id) || 0) < 600000 || errTimes.length >= 10)) return; // spam roko
  errSeen.set(id, now); errTimes.push(now);
  try {
    const r = await fetch('https://api.web3forms.com/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ access_key: key, subject: `WhatsApp Bot Error: ${title}`, from_name: 'WA Gemini Bot', message: `${title}\n\nTime: ${new Date().toISOString()}\n\n${msg}` })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) console.log('Email bhejna fail:', j.message || r.status);
    else console.log('📧 Error email bhej diya');
  } catch (e) { console.log('Email bhejna fail:', e.message); }
}
process.on('uncaughtException', (e) => notifyError('Uncaught exception', e));
process.on('unhandledRejection', (e) => notifyError('Unhandled rejection', e));

const ask = (q) => new Promise((res) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); res(a.trim()); });
});
const digits = (s) => String(s || '').replace(/\D/g, '');

// 1 Enter = aage badho, 2 Enter (jaldi jaldi) = menu
function enterChoice() {
  return new Promise((resolve) => {
    console.log('\n[Enter] = aage badho   |   [Enter Enter] (2 baar jaldi) = Advanced menu');
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    let count = 0, timer;
    const onKey = (_s, key) => {
      if (key?.ctrl && key.name === 'c') process.exit();
      if (key?.name !== 'return') return;
      count++;
      clearTimeout(timer);
      if (count >= 2) return done(true);
      timer = setTimeout(() => done(false), 900);
    };
    const done = (menu) => {
      process.stdin.off('keypress', onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(menu);
    };
    process.stdin.on('keypress', onKey);
  });
}

// ---------- Generic add / edit / delete manager (kuch bhi naya add karo) ----------
async function fill(it, f, edit) {
  const cur = it[f.key];
  const hint = [f.hint, edit && cur !== undefined ? `abhi: ${Array.isArray(cur) ? cur.join(',') : cur}` : '', edit ? 'khali=same, -=clear' : ''].filter(Boolean).join(' | ');
  const v = await ask(`${f.label}${hint ? ` (${hint})` : ''}: `);
  if (v === '') { if (it[f.key] === undefined) it[f.key] = f.def; return; }
  if (v === '-') { it[f.key] = f.def; return; }
  it[f.key] = f.type === 'list' ? v.split(',').map(digits).filter(Boolean) : v;
}
async function crud(title, arr, fields, show) {
  while (true) {
    console.log(`\n--- ${title} ---`);
    if (!arr.length) console.log('(abhi khali)');
    arr.forEach((it, i) => console.log(`${i + 1}. ${show(it)}`));
    const c = (await ask('a = naya add | e <no> = edit | d <no> = delete | t <no> = on/off | Enter = wapas: ')).toLowerCase();
    if (!c) return;
    const [op, n] = c.split(/\s+/); const i = Number(n) - 1;
    if (op === 'a') { const it = { enabled: true }; for (const f of fields) await fill(it, f, false); arr.push(it); }
    else if (op === 'e' && arr[i]) for (const f of fields) await fill(arr[i], f, true);
    else if (op === 'd' && arr[i]) arr.splice(i, 1);
    else if (op === 't' && arr[i]) arr[i].enabled = !arr[i].enabled;
    save();
  }
}

const scheduleFields = [
  { key: 'name', label: 'Naam', def: 'New message' },
  { key: 'time', label: 'Time', hint: 'HH:MM, 24-hour, e.g. 06:00', def: '06:00' },
  { key: 'days', label: 'Din', hint: '* = roz, ya 0-6 (0=Sunday) e.g. 1,2,3,4,5', def: '*' },
  { key: 'mode', label: 'Mode', hint: 'text = fixed message | ai = Gemini khud likhe', def: 'text' },
  { key: 'text', label: 'Message ya AI instruction', def: '' },
  { key: 'contacts', label: 'Kin numbers ko', type: 'list', hint: 'comma se alag, khali = default greeting list', def: [] }
];
const ruleFields = [
  { key: 'keyword', label: 'Keyword (jab message me ye ho)', def: '' },
  { key: 'match', label: 'Match', hint: 'contains | exact', def: 'contains' },
  { key: 'mode', label: 'Mode', hint: 'text = fixed reply | ai = Gemini ko instruction', def: 'text' },
  { key: 'reply', label: 'Reply ya AI instruction', def: '' }
];
const personaFields = [
  { key: 'number', label: 'Number (country code ke saath)', def: '' },
  { key: 'prompt', label: 'Is number ke liye alag prompt/tone', def: '' }
];

// ---------- Plugins ----------
const plugins = [];
async function loadPlugins() {
  if (!fs.existsSync('plugins')) return;
  for (const f of fs.readdirSync('plugins').filter((x) => x.endsWith('.js'))) {
    try {
      const p = (await import(`./plugins/${f}`)).default;
      if (p?.name) { cfg.plugins[p.name] ??= {}; plugins.push(p); }
    } catch (e) { console.log(`Plugin ${f} load fail:`, e.message); }
  }
}
const pluginCtx = (p) => ({ ask, cfg, save, store: cfg.plugins[p.name], ai: geminiOnce, digits, send: (n, t) => sock.sendMessage(`${digits(n)}@s.whatsapp.net`, { text: t }) });
async function pluginsMenu() {
  while (true) {
    console.log('\n--- PLUGINS (plugins/ folder me .js file daalo) ---');
    if (!plugins.length) console.log('(koi plugin nahi)');
    plugins.forEach((p, i) => console.log(`${i + 1}. ${p.name} ${p.description ? '- ' + p.description : ''} ${p.menu ? '' : '(menu nahi)'}`));
    const c = await ask('Plugin number kholo (Enter = wapas): ');
    const p = plugins[Number(c) - 1];
    if (!c) return;
    if (p?.menu) { await p.menu(pluginCtx(p)); save(); }
  }
}

async function safetyMenu() {
  while (true) {
    console.log(`
--- SAFETY / ADVANCED ---
1. Blocked numbers (${cfg.blocked.length}): ${cfg.blocked.join(', ') || '-'}
2. Quiet hours: ${cfg.quiet.enabled ? 'ON' : 'OFF'} ${cfg.quiet.start}-${cfg.quiet.end}
3. Max reply per contact/ghanta: ${cfg.maxRepliesPerHour}
4. Owner commands (!pause !resume !status apne chat me): ${cfg.ownerCommands ? 'ON' : 'OFF'}
0. Wapas`);
    const c = await ask('Choice: ');
    if (!c || c === '0') return;
    if (c === '1') {
      const [op, num] = (await ask('a <number> add / r <number> remove: ')).split(/\s+/);
      const n = digits(num);
      if (op === 'a' && n && !cfg.blocked.includes(n)) cfg.blocked.push(n);
      if (op === 'r') cfg.blocked = cfg.blocked.filter((x) => x !== n);
    }
    if (c === '2') {
      cfg.quiet.enabled = (await ask('ON karein? (y/n): ')).toLowerCase().startsWith('y');
      const st = await ask(`Start HH:MM (khali = ${cfg.quiet.start}): `); if (/^\d{1,2}:\d{2}$/.test(st)) cfg.quiet.start = st.padStart(5, '0');
      const en = await ask(`End HH:MM (khali = ${cfg.quiet.end}): `); if (/^\d{1,2}:\d{2}$/.test(en)) cfg.quiet.end = en.padStart(5, '0');
      const m = await ask('Quiet time ka message (khali = same, - = koi message nahi): ');
      if (m === '-') cfg.quiet.message = ''; else if (m) cfg.quiet.message = m;
    }
    if (c === '3') { const n = Number(await ask('Max replies/ghanta: ')); if (n > 0) cfg.maxRepliesPerHour = n; }
    if (c === '4') cfg.ownerCommands = !cfg.ownerCommands;
    save(); console.log('Saved ✅');
  }
}

async function menu() {
  while (true) {
    console.log(`
===== ADVANCED MENU =====
1. Gemini API key badlo
2. Phone number badlo (${cfg.phone})
3. Default reply personality/prompt
4. Scheduled messages (${cfg.schedules.length}) - kitne bhi add/edit/delete
5. Keyword rules (${cfg.rules.length}) - kisi word par khas reply
6. Khas numbers ke liye alag tone (${cfg.personas.length})
7. Default greeting contacts (${cfg.greetContacts.length})
8. Auto-reply ON/OFF (abhi: ${cfg.autoReply ? 'ON' : 'OFF'})
9. Gemini model (${cfg.model}) / Timezone (${cfg.timezone})
10. Plugins (${plugins.length}) - apna naya feature jodo
11. Error email (Web3Forms) ${cfg.web3formsKey || process.env.WEB3FORMS_KEY ? '✅' : '(set nahi)'}
12. Safety: blocked numbers, quiet hours, reply limit, owner commands
0. Start karo
`);
    const c = await ask('Choice: ');
    if (c === '0' || c === '') break;
    if (c === '1') cfg.geminiKey = (await ask('Naya Gemini API key: ')) || cfg.geminiKey;
    if (c === '2') cfg.phone = digits(await ask('Number (country code ke saath): ')) || cfg.phone;
    if (c === '3') { console.log('Abhi:', cfg.personality); const p = await ask('Naya prompt (khali = same): '); if (p) cfg.personality = p; }
    if (c === '4') await crud('SCHEDULED MESSAGES', cfg.schedules, scheduleFields, (s) => `${s.enabled ? '✅' : '⏸'} ${s.name} | ${s.time} | din:${s.days} | ${s.mode} | ${s.contacts?.length ? s.contacts.length + ' numbers' : 'default list'}`);
    if (c === '5') await crud('KEYWORD RULES', cfg.rules, ruleFields, (r) => `${r.enabled ? '✅' : '⏸'} "${r.keyword}" (${r.match}) -> [${r.mode}] ${String(r.reply).slice(0, 40)}`);
    if (c === '6') await crud('KHAS NUMBERS KI TONE', cfg.personas, personaFields, (p) => `${p.enabled ? '✅' : '⏸'} ${p.number}: ${String(p.prompt).slice(0, 50)}`);
    if (c === '7') {
      console.log('Abhi:', cfg.greetContacts.join(', ') || '(koi nahi)');
      const [op, num] = (await ask('a <number> add / r <number> remove: ')).split(/\s+/);
      const n = digits(num);
      if (op === 'a' && n && !cfg.greetContacts.includes(n)) cfg.greetContacts.push(n);
      if (op === 'r') cfg.greetContacts = cfg.greetContacts.filter((x) => x !== n);
    }
    if (c === '8') cfg.autoReply = !cfg.autoReply;
    if (c === '9') { cfg.model = (await ask(`Model (khali = ${cfg.model}): `)) || cfg.model; cfg.timezone = (await ask(`Timezone (khali = ${cfg.timezone}): `)) || cfg.timezone; }
    if (c === '10') await pluginsMenu();
    if (c === '11') {
      const k = await ask('Web3Forms access key (khali = same, - = hatao): ');
      if (k === '-') cfg.web3formsKey = ''; else if (k) cfg.web3formsKey = k;
      save();
      if ((await ask('Test email bhejein? (y/n): ')).toLowerCase() === 'y') await notifyError('Test (menu se)', new Error('Ye sirf test email hai.'), true);
    }
    if (c === '12') await safetyMenu();
    save();
    if (!['4', '5', '6', '10'].includes(c)) console.log('Saved ✅');
  }
}

// ---------- Gemini ----------
const history = new Map();
async function geminiReply(jid, text, extra = '') {
  const num = digits(jid.split('@')[0]);
  const persona = cfg.personas.find((p) => p.enabled && digits(p.number) === num);
  const sys = [cfg.personality, persona?.prompt, extra].filter(Boolean).join('\n\n');
  const model = new GoogleGenerativeAI(cfg.geminiKey).getGenerativeModel({ model: cfg.model, systemInstruction: sys });
  const h = history.get(jid) || [];
  const r = await model.startChat({ history: h }).sendMessage(text);
  const out = r.response.text().trim();
  h.push({ role: 'user', parts: [{ text }] }, { role: 'model', parts: [{ text: out }] });
  history.set(jid, h.slice(-20));
  return out;
}
async function geminiOnce(prompt) {
  const model = new GoogleGenerativeAI(cfg.geminiKey).getGenerativeModel({ model: cfg.model, systemInstruction: cfg.personality });
  return (await model.generateContent(prompt)).response.text().trim();
}

async function decideReply(jid, text) {
  for (const p of plugins) {
    if (!p.onMessage) continue;
    try { const r = await p.onMessage({ ...pluginCtx(p), jid, text }); if (r) return r; } catch (e) { notifyError(`Plugin ${p.name} error`, e); }
  }
  const t = text.toLowerCase();
  for (const r of cfg.rules) {
    if (!r.enabled || !r.keyword) continue;
    const k = r.keyword.toLowerCase();
    if (r.match === 'exact' ? t.trim() === k : t.includes(k)) return r.mode === 'ai' ? geminiReply(jid, text, r.reply) : r.reply;
  }
  return geminiReply(jid, text);
}

// ---------- Web page (QR + pairing code) ----------
let latestQR = null, connected = false;
let code = { value: null, at: 0 }, codePending = null;
const CODE_MAX_AGE = 90000; // itne se purana code refresh par naya banega

async function freshPairingCode() {
  if (connected) return { connected: true };
  if (!cfg.phone) return { error: 'Phone number set nahi hai (menu > 2)' };
  if (!sock || !latestQR) return { wait: true }; // socket abhi ready nahi
  if (sock.authState.creds.registered) return { wait: true };
  if (code.value && Date.now() - code.at < CODE_MAX_AGE) return { code: code.value, age: Date.now() - code.at };
  if (!codePending) {
    codePending = sock.requestPairingCode(cfg.phone)
      .then((c) => { code = { value: c.match(/.{1,4}/g).join('-'), at: Date.now() }; console.log('Pairing code:', code.value); })
      .catch((e) => console.log('Pairing code fail:', e.message))
      .finally(() => { codePending = null; });
  }
  await codePending;
  return code.value ? { code: code.value, age: Date.now() - code.at } : { wait: true };
}

const app = express();
app.get('/api/status', async (_req, res) => {
  res.json({ connected, qr: !connected && latestQR ? await QRCode.toDataURL(latestQR, { width: 300 }) : null });
});
app.get('/api/code', async (_req, res) => res.json(await freshPairingCode()));
app.get('/', (_req, res) => {
  res.send(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<body style="font-family:sans-serif;text-align:center;padding:20px">
<div id=ok style="display:none;padding:40px 10px">
  <div style="font-size:70px">✅</div>
  <h1 style="color:#1a7f37">Connect to WhatsApp successful</h1>
  <p>Ab bot chalu hai. Ye page band kar sakte ho.</p>
</div>
<div id=pending>
  <h2>WhatsApp &gt; Linked devices &gt; Link a device</h2>
  <div id=qr style="min-height:300px">QR aa raha hai...</div>
  <h3>Ya "Link with phone number" me ye code dalo:</h3>
  <div id=code style="font-size:40px;letter-spacing:6px;font-weight:bold">...</div>
  <p id=note style="color:#666"></p>
</div>
<script>
let codeAt = 0;
const $ = (id) => document.getElementById(id);
function showOK() { $('pending').style.display = 'none'; $('ok').style.display = 'block'; }
async function loadCode() {
  try {
    const r = await (await fetch('/api/code')).json();
    if (r.connected) return showOK();
    if (r.code) { $('code').textContent = r.code; codeAt = Date.now() - r.age; }
    else if (r.error) $('code').textContent = r.error;
    else setTimeout(loadCode, 2000);
  } catch (e) { setTimeout(loadCode, 3000); }
}
async function poll() {
  try {
    const r = await (await fetch('/api/status')).json();
    if (r.connected) return showOK();
    if (r.qr) $('qr').innerHTML = '<img src="' + r.qr + '" width=300>';
  } catch (e) {}
  if (codeAt) {
    const left = Math.max(0, 120 - Math.round((Date.now() - codeAt) / 1000));
    $('note').textContent = left > 0 ? 'Code lagbhag ' + left + 's tak valid. Expire ho jaye to page refresh karo.' : 'Code expire ho sakta hai - page refresh karo.';
  }
  setTimeout(poll, 3000);
}
loadCode(); poll();
</script></body>`);
});
app.get('/health', (_req, res) => res.json({ ok: true, connected }));

// ---- Admin panel (hosting par terminal menu ki jagah). ADMIN_PASSWORD env zaruri ----
const adminAuth = (req, res, next) => {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return res.status(403).send('ADMIN_PASSWORD env set karo, tab /admin chalega.');
  const given = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString().split(':').slice(1).join(':');
  const h = (x) => crypto.createHash('sha256').update(x).digest();
  if (crypto.timingSafeEqual(h(given), h(pw))) return next();
  res.set('WWW-Authenticate', 'Basic realm="admin"').status(401).send('Login chahiye');
};
app.get('/admin', adminAuth, (_req, res) => {
  const j = JSON.stringify(cfg, null, 2).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  res.send(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<body style="font-family:sans-serif;padding:12px"><h2>Bot settings (JSON)</h2>
<p>Schedules, rules, keys, quiet hours... sab yahin badlo. Save karte hi lagu ho jata hai.</p>
<textarea id=t style="width:100%;height:65vh;font-family:monospace">${j}</textarea><br>
<button onclick="save()" style="padding:10px 20px;font-size:16px">Save</button> <span id=m></span>
<script>async function save(){const r=await fetch('/admin',{method:'POST',headers:{'Content-Type':'text/plain'},body:document.getElementById('t').value});document.getElementById('m').textContent=await r.text();}</script></body>`);
});
app.post('/admin', adminAuth, express.text({ type: '*/*', limit: '1mb' }), (req, res) => {
  try {
    const n = JSON.parse(req.body);
    for (const k of Object.keys(cfg)) delete cfg[k];
    Object.assign(cfg, { ...defaults, ...n });
    save(); scheduleGreetings();
    res.send('Saved ✅');
  } catch (e) { res.status(400).send('JSON galat hai: ' + e.message); }
});
app.listen(process.env.PORT || 3000);

const linkURL = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : process.env.RENDER_EXTERNAL_URL ? process.env.RENDER_EXTERNAL_URL
  : process.env.CODESPACE_NAME
  ? `https://${process.env.CODESPACE_NAME}-3000.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`
  : 'http://localhost:3000';

// ---------- WhatsApp ----------
const startedAt = Math.floor(Date.now() / 1000);
let paused = false;
const quietNotified = new Set();
const sentLog = new Map();
const rateOK = (jid) => {
  const now = Date.now(), arr = (sentLog.get(jid) || []).filter((t) => now - t < 3600000);
  sentLog.set(jid, arr);
  if (arr.length >= cfg.maxRepliesPerHour) return false;
  arr.push(now); return true;
};
const inQuiet = () => {
  if (!cfg.quiet.enabled) return false;
  const now = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: cfg.timezone }).format(new Date());
  const { start, end } = cfg.quiet;
  return start <= end ? now >= start && now < end : now >= start || now < end;
};

let sock, cronStarted = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), browser: ['Ubuntu', 'Chrome', '120.0'] });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) latestQR = qr;
    if (connection === 'open') {
      connected = true; latestQR = null;
      console.log('✅ WhatsApp connected');
      if (!cronStarted) { cronStarted = true; scheduleGreetings(); }
    }
    if (connection === 'close') {
      connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) { // tumne phone se unlink kiya
        fs.rmSync(AUTH, { recursive: true, force: true });
        await notifyError('WhatsApp unlink ho gaya', new Error('Device unlink hua. Session hata diya, restart ke baad naya QR milega.'), true);
        process.exit(0);
      }
      code = { value: null, at: 0 }; latestQR = null;
      setTimeout(startWA, 2000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        const jid = m.key.remoteJid;
        if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) continue;
        const text = m.message?.conversation || m.message?.extendedTextMessage?.text;
        if (!text) continue;
        let ts = m.messageTimestamp; ts = typeof ts === 'object' ? ts?.toNumber?.() : Number(ts);
        if (ts && ts < startedAt - 30) continue; // purane (offline) messages ko reply nahi
        const num = digits(jid.split('@')[0]);

        if (m.key.fromMe) { // owner commands: apne hi chat me
          const own = digits((sock.user?.id || '').split(':')[0].split('@')[0]);
          if (cfg.ownerCommands && num === own && text.startsWith('!')) {
            const cmd = text.trim().toLowerCase();
            let out = null;
            if (cmd === '!pause') { paused = true; out = '⏸ Auto-reply band kar diya.'; }
            else if (cmd === '!resume') { paused = false; out = '▶️ Auto-reply chalu kar diya.'; }
            else if (cmd === '!status') out = `📊 Auto-reply: ${paused || !cfg.autoReply ? 'OFF' : 'ON'} | Quiet: ${inQuiet() ? 'haan' : 'nahi'} | Rules: ${cfg.rules.length} | Schedules: ${cfg.schedules.length}`;
            if (out) await sock.sendMessage(jid, { text: out });
          }
          continue;
        }

        if (paused || !cfg.autoReply) continue;
        if (cfg.blocked.includes(num)) continue;
        if (inQuiet()) {
          if (cfg.quiet.message && !quietNotified.has(jid)) { quietNotified.add(jid); await sock.sendMessage(jid, { text: cfg.quiet.message }); }
          continue;
        }
        quietNotified.clear();
        if (!rateOK(jid)) { console.log('Rate limit: reply skip', num); continue; }

        await sock.readMessages([m.key]);
        await sock.sendPresenceUpdate('composing', jid);
        let reply;
        try { reply = await decideReply(jid, text); }
        catch (e) { await sleep(3000); reply = await decideReply(jid, text); } // ek retry
        await sleep(2000 + Math.random() * 3000);
        await sock.sendMessage(jid, { text: reply });
      } catch (e) { notifyError('Auto-reply fail', e); }
    }
  });
}

let jobs = [];
function scheduleGreetings() {
  jobs.forEach((j) => j.stop()); jobs = [];
  for (const s of cfg.schedules) {
    if (!s.enabled || !/^\d{1,2}:\d{2}$/.test(s.time || '')) continue;
    const [h, mi] = s.time.split(':').map(Number);
    const days = !s.days || s.days === '*' ? '*' : s.days.replace(/\s/g, '');
    jobs.push(cron.schedule(`${mi} ${h} * * ${days}`, async () => {
      const targets = s.contacts?.length ? s.contacts : cfg.greetContacts;
      let text = s.text;
      try { if (s.mode === 'ai') text = await geminiOnce(s.text); } catch (e) { notifyError('AI schedule fail: ' + s.name, e); return; }
      for (const n of targets) {
        try { await sock.sendMessage(`${n}@s.whatsapp.net`, { text }); } catch (e) { notifyError('Scheduled send fail: ' + s.name, e); }
        await sleep(8000 + Math.random() * 7000);
      }
    }, { timezone: cfg.timezone }));
  }
}

// ---------- main ----------
const interactive = !!process.stdin.isTTY && !process.env.HEADLESS;
if (interactive) console.clear();
console.log('=== WhatsApp x Gemini Auto-Reply Bot ===');
console.log(`Data folder: ${path.resolve(DATA)}`);
cfg.geminiKey ||= process.env.GEMINI_API_KEY || '';
cfg.phone ||= digits(process.env.PHONE_NUMBER);
await loadPlugins();
if (interactive) {
  if (!cfg.geminiKey) { cfg.geminiKey = await ask('Gemini API key: '); save(); }
  if (!cfg.phone) { cfg.phone = digits(await ask('Phone number (country code ke saath, e.g. 919876543210): ')); save(); }
  if (!cfg.web3formsKey && !cfg.web3formsAsked) { cfg.web3formsKey = await ask('Web3Forms access key (error email ke liye, skip = Enter): '); cfg.web3formsAsked = true; save(); }
  if (await enterChoice()) await menu();
} else {
  save();
  if (!cfg.geminiKey || !cfg.phone) console.log('⚠️ GEMINI_API_KEY / PHONE_NUMBER env set nahi hain. /admin se ya env se set karo.');
}
scheduleGreetings();
console.log(`\n🔗 Ye link Chrome me kholo (QR + pairing code milega):\n   ${linkURL}\n`);
await startWA();
for (const p of plugins) if (p.onStart) p.onStart(pluginCtx(p)).catch((e) => notifyError(`Plugin ${p.name} onStart`, e));
