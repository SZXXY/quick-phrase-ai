// server.js — Quick Phrase AI 云存档服务器（零 npm 依赖，Node >= 16 可直接运行）
// 职责：注册 / 登录 / 存档读写（REST API），密码 scrypt 加盐哈希，token 认证，
//       数据持久化到 data/users.json，CORS 允许扩展页面与 localhost。
// 启动：node server.js   （默认监听 127.0.0.1:8787，可用 PORT / HOST 环境变量覆盖）

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 5 * 1024 * 1024; // 请求体上限 5MB

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'users.json');

// CORS：默认允许所有来源（服务仅监听本机/内网）；如需收紧，用 ALLOW_ORIGINS=origin1,origin2
const allowOrigins = process.env.ALLOW_ORIGINS
  ? process.env.ALLOW_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : ['*'];

// ========== 数据持久化 ==========
// users: { [username]: { username, salt, hash, token, save } }
let users = {};

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    users = (parsed && parsed.users && typeof parsed.users === 'object') ? parsed.users : {};
  } catch (e) {
    users = {};
  }
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({ users }, null, 2), 'utf8');
  } catch (e) {
    console.error('[cloud-server] persist failed:', e.message);
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

loadData();

// ========== HTTP 工具 ==========

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  let allowOrigin = '*';
  if (!allowOrigins.includes('*') && origin && allowOrigins.includes(origin)) {
    allowOrigin = origin;
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

/** 读取请求体（超过 MAX_BODY 报错），返回 Promise<string> */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;

    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) {
        done = true;
        reject(new Error('请求体过大（超过 5MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

/** 校验用户名 / 密码基本格式 */
function validateCredential(username, password) {
  if (!username || !/^[\w.-]{2,32}$/.test(username)) {
    return { ok: false, error: '用户名需为 2~32 位字母/数字/._-' };
  }
  if (!password || String(password).length < 6) {
    return { ok: false, error: '密码长度至少 6 位' };
  }
  return { ok: true };
}

/** 从 Authorization: Bearer <token> 提取 token */
function extractToken(req) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** 按 token 查找用户 */
function findByToken(token) {
  if (!token) return null;
  for (const u of Object.values(users)) {
    if (u && u.token === token) return u;
  }
  return null;
}

// ========== 接口实现 ==========

function handleRegister(req, res) {
  readBody(req).then((raw) => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { /* 默认空对象 */ }

    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const check = validateCredential(username, password);
    if (!check.ok) return sendJson(res, 400, { ok: false, error: check.error });

    if (users[username]) return sendJson(res, 409, { ok: false, error: '用户名已存在' });

    const salt = crypto.randomBytes(16).toString('hex');
    const token = makeToken();
    users[username] = {
      username,
      salt,
      hash: hashPassword(password, salt),
      token,
      save: null
    };
    persist();
    sendJson(res, 200, { ok: true, username, token });
  }).catch((err) => sendJson(res, 413, { ok: false, error: err.message }));
}

function handleLogin(req, res) {
  readBody(req).then((raw) => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { /* 默认空对象 */ }

    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const user = users[username];
    if (!user) return sendJson(res, 404, { ok: false, error: '用户不存在' });

    const hash = hashPassword(password, user.salt);
    if (hash !== user.hash) return sendJson(res, 401, { ok: false, error: '密码错误' });

    // 复用已有 token（重启后无 token 时补发）
    if (!user.token) user.token = makeToken();
    persist();
    sendJson(res, 200, { ok: true, username, token: user.token });
  }).catch((err) => sendJson(res, 413, { ok: false, error: err.message }));
}

function handleGetSave(req, res) {
  const user = findByToken(extractToken(req));
  if (!user) return sendJson(res, 401, { ok: false, error: 'token 无效或已过期' });
  sendJson(res, 200, { ok: true, username: user.username, save: user.save || null });
}

function handlePutSave(req, res) {
  readBody(req).then((raw) => {
    const user = findByToken(extractToken(req));
    if (!user) return sendJson(res, 401, { ok: false, error: 'token 无效或已过期' });

    let save = null;
    try {
      save = JSON.parse(raw || '{}');
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: '存档 JSON 格式无效' });
    }
    if (save === null || typeof save !== 'object' || Array.isArray(save)) {
      return sendJson(res, 400, { ok: false, error: '存档必须为 JSON 对象' });
    }

    user.save = save;
    persist();
    sendJson(res, 200, { ok: true, username: user.username });
  }).catch((err) => sendJson(res, 413, { ok: false, error: err.message }));
}

// ========== 路由 ==========

const server = http.createServer((req, res) => {
  // 所有响应附加 CORS 头
  const cors = corsHeaders(req);
  const setHeaders = () => Object.keys(cors).forEach((k) => res.setHeader(k, cors[k]));

  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || HOST + ':' + PORT));
    const pathname = url.pathname;
    const method = req.method;

    // OPTIONS 预检
    if (method === 'OPTIONS') {
      setHeaders();
      res.writeHead(204);
      res.end();
      return;
    }

    // 健康检查
    if (pathname === '/api/health' && method === 'GET') {
      setHeaders();
      sendJson(res, 200, { ok: true, service: 'quick-phrase-ai-cloud', version: 1, time: new Date().toISOString() });
      return;
    }

    if (pathname === '/api/register' && method === 'POST') {
      setHeaders();
      handleRegister(req, res);
      return;
    }

    if (pathname === '/api/login' && method === 'POST') {
      setHeaders();
      handleLogin(req, res);
      return;
    }

    if (pathname === '/api/save' && method === 'GET') {
      setHeaders();
      handleGetSave(req, res);
      return;
    }

    if (pathname === '/api/save' && method === 'PUT') {
      setHeaders();
      handlePutSave(req, res);
      return;
    }

    setHeaders();
    sendJson(res, 404, { ok: false, error: '接口不存在' });
  } catch (e) {
    setHeaders();
    sendJson(res, 500, { ok: false, error: '服务器内部错误：' + String(e && e.message) });
  }
});

server.listen(PORT, HOST, () => {
  console.log('[quick-phrase-ai-cloud] listening on http://' + HOST + ':' + PORT);
  console.log('  GET  /api/health      健康检查');
  console.log('  POST /api/register    注册 {username,password} -> {token}');
  console.log('  POST /api/login       登录  {username,password} -> {token}');
  console.log('  GET  /api/save        获取存档（Authorization: Bearer <token>）');
  console.log('  PUT  /api/save        保存存档（Authorization: Bearer <token>，body 为存档 JSON，上限 5MB）');
});
