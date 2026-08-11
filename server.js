/*
 * 栖 · 生活工作台 — 多用户一体化服务端（零依赖，仅用 Node 内置模块）
 * 一个进程同时做两件事：
 *   1) 托管 PWA 前端（public/ 目录）
 *   2) 提供多用户 API：账号密码登录 + 邀请码小圈子 + 私人空间 + 公共空间
 *
 * 数据模型（JSON 文件，小圈子量级足够，免装数据库）：
 *   store = {
 *     users:   { [id]: {id, username, salt, hash, groupId, data:{}, updatedAt:0} },   // data = 私人空间
 *     groups:  { [id]: {id, inviteCode, creatorId, members:[uid], shareData:{}, shareUpdatedAt:0} }, // shareData = 公共空间
 *     sessions:{ [token]: uid }
 *   }
 * 环境变量：PORT（默认 3000）、DATA_DIR、PUBLIC_DIR
 */
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
const STORE = path.join(DATA_DIR, 'store.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// ---------- 数据库 ----------
let store = load();
let writeQ = Promise.resolve();
function load() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); }
  catch { return { users: {}, groups: {}, sessions: {} }; }
}
function persist() {
  writeQ = writeQ.then(() => fs.promises.writeFile(STORE, JSON.stringify(store)).catch(e => console.error('写入失败', e)));
  scheduleBackup();
  return writeQ;
}

// ---------- 加密云端备份（可选） ----------
// 配置 GIST_BACKUP_TOKEN(有 gist 权限的 GitHub 令牌) + GIST_BACKUP_PASS(加密口令) 后，
// 把 {users,groups} 用 AES-256-GCM(PBKDF2 派生密钥) 加密后存到 GitHub Gist。
// 这样即使免费云主机磁盘是临时的（重启/重新部署会清空），数据也能从加密备份恢复。
// 明文只在服务器内存里，GitHub 上只见密文；没有口令谁也解不开。
const GIST_TOKEN = process.env.GIST_BACKUP_TOKEN || '';
const GIST_PASS  = process.env.GIST_BACKUP_PASS || '';
const GIST_FILE  = 'qi-life-backup.json';
const GIST_DESC  = 'qi-life-workbench backup (encrypted)';
let gistId = '';
let backupTimer = null;

function bkDeriveKey(pass, salt) { return crypto.pbkdf2Sync(pass, salt, 100000, 32, 'sha256'); }
function bkEncrypt(obj, pass) {
  const salt = crypto.randomBytes(16);
  const key = bkDeriveKey(pass, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'ENC:' + Buffer.concat([salt, iv, tag, enc]).toString('base64');
}
function bkDecrypt(payload, pass) {
  if (!payload || !payload.startsWith('ENC:')) return null;
  try {
    const buf = Buffer.from(payload.slice(4), 'base64');
    const salt = buf.slice(0, 16), iv = buf.slice(16, 28), tag = buf.slice(28, 44), enc = buf.slice(44);
    const key = bkDeriveKey(pass, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const data = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(data.toString('utf8'));
  } catch (e) { console.error('备份解密失败', e.message); return null; }
}
const ghHeaders = () => ({
  'Authorization': 'Bearer ' + GIST_TOKEN, 'Accept': 'application/vnd.github+json',
  'Content-Type': 'application/json', 'User-Agent': 'qi-life-backup'
});
async function findBackupGist() {
  try {
    const r = await fetch('https://api.github.com/gists?per_page=100', { headers: ghHeaders() });
    if (!r.ok) return '';
    const list = await r.json();
    for (const g of list) if (g.files && g.files[GIST_FILE]) return g.id;
  } catch (e) { console.error('查找备份 Gist 失败', e.message); }
  return '';
}
async function gistRestore() {
  if (!GIST_TOKEN || !GIST_PASS || !gistId) return;
  try {
    const r = await fetch('https://api.github.com/gists/' + gistId, { headers: ghHeaders() });
    if (!r.ok) return;
    const j = await r.json();
    const f = j.files && j.files[GIST_FILE];
    if (f && f.content) {
      const obj = bkDecrypt(f.content, GIST_PASS);
      if (obj) { store.users = obj.users || {}; store.groups = obj.groups || {}; store.sessions = {}; console.log('已从加密备份恢复数据'); }
    }
  } catch (e) { console.error('恢复备份失败', e.message); }
}
async function gistPush() {
  if (!GIST_TOKEN || !GIST_PASS) return;
  try {
    const payload = bkEncrypt({ users: store.users, groups: store.groups }, GIST_PASS);
    if (!gistId) gistId = await findBackupGist();
    if (!gistId) {
      const r = await fetch('https://api.github.com/gists', {
        method: 'POST', headers: ghHeaders(),
        body: JSON.stringify({ public: false, description: GIST_DESC, files: { [GIST_FILE]: { content: payload } } })
      });
      if (r.ok) { const j = await r.json(); gistId = j.id; console.log('已创建加密备份 Gist'); }
    } else {
      const r = await fetch('https://api.github.com/gists/' + gistId, {
        method: 'PATCH', headers: ghHeaders(),
        body: JSON.stringify({ files: { [GIST_FILE]: { content: payload } } })
      });
      if (r.ok) console.log('已推送加密备份');
    }
  } catch (e) { console.error('推送备份失败', e.message); }
}
function scheduleBackup() {
  if (!GIST_TOKEN || !GIST_PASS || backupTimer) return;
  backupTimer = setTimeout(() => { backupTimer = null; gistPush(); }, 30000); // 改动后 30 秒兜底推送
}

// ---------- 密码与令牌 ----------
function pwHash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return { salt, hash };
}
function pwVerify(pw, salt, hash) {
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
}
const newToken = () => crypto.randomBytes(24).toString('hex');
const newId = () => crypto.randomBytes(8).toString('hex');
function genInvite() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混 0/O/1/I
  let c;
  do {
    c = '';
    for (let i = 0; i < 6; i++) c += chars[crypto.randomInt(0, chars.length)];
  } while (Object.values(store.groups).some(g => g.inviteCode === c));
  return c;
}

// ---------- 工具 ----------
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((ok, err) => {
    let d = ''; req.on('data', c => d += c);
    req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { err(e); } });
  });
}
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}
function auth(req) {
  const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  return store.sessions[m[1]] || null;
}

// ---------- 静态文件托管 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
function serveStatic(req, res, pathname) {
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let rel = safe === '/' || safe === '' ? 'index.html' : safe.replace(/^\/+/, '');
  let file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400'
    });
    res.end(buf);
  });
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  cors(req, res);
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/.well-known/assetlinks.json') {
    const fp = process.env.ASSETLINKS_FP || '55:06:DF:4D:7E:AC:01:A7:08:ED:B4:DE:DF:7A:A0:12:03:B1:37:A5:B1:5C:4C:CB:22:44:95:C1:49:03:86:20';
    const pkg = process.env.ASSETLINKS_PKG || 'com.onrender.qi_life_workbench.twa';
    const al = [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: [fp] } }];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(al, null, 2));
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (p.startsWith('/api/')) {
      // 注册（可带邀请码加入已有圈子，否则自建圈子）
      if (req.method === 'POST' && p === '/api/register') {
        const b = await readBody(req);
        if (!b.username || !b.password) return send(res, 400, { error: '用户名和密码必填' });
        if (String(b.password).length < 6) return send(res, 400, { error: '密码至少 6 位' });
        if (Object.values(store.users).some(u => u.username === b.username))
          return send(res, 409, { error: '用户名已存在' });
        const id = newId();
        const { salt, hash } = pwHash(String(b.password));
        let groupId, isCreator;
        if (b.inviteCode) {
          const g = Object.values(store.groups).find(g => g.inviteCode === String(b.inviteCode).toUpperCase());
          if (!g) return send(res, 400, { error: '邀请码无效或已失效' });
          groupId = g.id; isCreator = false;
        } else {
          groupId = newId();
          store.groups[groupId] = { id: groupId, inviteCode: genInvite(), creatorId: id, members: [], shareData: {}, shareUpdatedAt: 0 };
          isCreator = true;
        }
        store.users[id] = { id, username: b.username, salt, hash, groupId, data: {}, updatedAt: 0 };
        store.groups[groupId].members.push(id);
        const token = newToken(); store.sessions[token] = id; persist();
        return send(res, 200, { token, groupId, inviteCode: store.groups[groupId].inviteCode, isCreator });
      }
      // 登录
      if (req.method === 'POST' && p === '/api/login') {
        const b = await readBody(req);
        const user = Object.values(store.users).find(u => u.username === b.username);
        if (!user || !pwVerify(String(b.password), user.salt, user.hash))
          return send(res, 401, { error: '用户名或密码错误' });
        const token = newToken(); store.sessions[token] = user.id; persist();
        return send(res, 200, { token });
      }
      // 登出
      if (req.method === 'POST' && p === '/api/logout') {
        const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/);
        if (m) { delete store.sessions[m[1]]; persist(); }
        return send(res, 200, { ok: true });
      }
      // 当前用户信息 + 圈子成员 + 邀请码
      if (req.method === 'GET' && p === '/api/me') {
        const uid = auth(req); if (!uid) return send(res, 401, { error: '未登录' });
        const user = store.users[uid]; const g = store.groups[user.groupId];
        return send(res, 200, {
          username: user.username, groupId: user.groupId, inviteCode: g.inviteCode,
          isCreator: g.creatorId === uid,
          members: g.members.map(mid => { const u = store.users[mid]; return u ? { username: u.username, isCreator: g.creatorId === mid } : null; }).filter(Boolean)
        });
      }
      // 私人空间（仅自己读写）；/api/data 为兼容别名
      if (p === '/api/private' || p === '/api/data') {
        const uid = auth(req); if (!uid) return send(res, 401, { error: '未登录' });
        const user = store.users[uid];
        if (req.method === 'GET') return send(res, 200, { data: user.data || {}, updatedAt: user.updatedAt || 0 });
        if (req.method === 'PUT') {
          const b = await readBody(req);
          if (typeof b.data === 'undefined') return send(res, 400, { error: '缺少 data' });
          const base = Number(b.baseUpdatedAt) || 0;
          if ((user.updatedAt || 0) !== base)
            return send(res, 409, { serverData: user.data || {}, serverUpdatedAt: user.updatedAt || 0, error: '冲突' });
          user.data = b.data; user.updatedAt = Date.now(); persist();
          return send(res, 200, { updatedAt: user.updatedAt });
        }
      }
      // 公共空间（圈子内任何人可读写）
      if (p === '/api/share') {
        const uid = auth(req); if (!uid) return send(res, 401, { error: '未登录' });
        const g = store.groups[store.users[uid].groupId];
        if (req.method === 'GET') return send(res, 200, { data: g.shareData || {}, updatedAt: g.shareUpdatedAt || 0 });
        if (req.method === 'PUT') {
          const b = await readBody(req);
          if (typeof b.data === 'undefined') return send(res, 400, { error: '缺少 data' });
          const base = Number(b.baseUpdatedAt) || 0;
          if ((g.shareUpdatedAt || 0) !== base)
            return send(res, 409, { serverData: g.shareData || {}, serverUpdatedAt: g.shareUpdatedAt || 0, error: '冲突' });
          g.shareData = b.data; g.shareUpdatedAt = Date.now(); persist();
          return send(res, 200, { updatedAt: g.shareUpdatedAt });
        }
      }
      return send(res, 404, { error: 'not found' });
    }
    serveStatic(req, res, p);
  } catch (e) {
    send(res, 500, { error: 'server error' });
  }
});

server.listen(PORT, () => {
  console.log('栖 · 多用户一体化服务已启动');
  console.log('  前端 + 多用户API: http://localhost:' + PORT);
  console.log('  数据目录: ' + DATA_DIR);
  if (GIST_TOKEN && GIST_PASS) {
    (async () => {
      gistId = await findBackupGist();
      await gistRestore();
      await gistPush();                       // 立刻备一次，确保 Gist 存在
      setInterval(gistPush, 5 * 60 * 1000);   // 之后每 5 分钟再备
      console.log('加密云端备份已启用（GitHub Gist）');
    })();
  } else {
    console.log('未配置 GIST_BACKUP_TOKEN/GIST_BACKUP_PASS，跳过云端备份（本地/NAS 模式无需）');
  }
});
