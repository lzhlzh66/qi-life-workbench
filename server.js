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
  return writeQ;
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
});
