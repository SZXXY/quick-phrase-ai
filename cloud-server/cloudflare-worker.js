// cloudflare-worker.js — Quick Phrase AI 云存档免费部署模板
// 基于 Cloudflare Workers + KV，实现与本地 server.js 一致的接口：
//   GET  /api/health      健康检查
//   POST /api/register    注册 {username,password} -> {token}
//   POST /api/login       登录  {username,password} -> {token}
//   GET  /api/save        获取存档（Authorization: Bearer <token>）
//   PUT  /api/save        保存存档（Authorization: Bearer <token>，body 存档 JSON，≤5MB）
//
// 部署步骤见 cloud-server/README.md：
//   1) 在 Cloudflare 免费账号创建 Worker，粘贴本文件并 Deploy；
//   2) 创建 KV namespace，并在 Worker 设置中绑定变量 CLOUD_SAVE；
//   3) 重新 Deploy 后，把扩展「服务器地址」改为 https://<你的worker>.workers.dev
//
// 注意：Workers 无 scrypt，这里使用 Web Crypto SHA-256 + 随机盐哈希；
//       本地 server.js 使用 scrypt，两套服务数据不互通，请二选一使用。
//
// KV 数据结构：键 'users' -> { [username]: { username, salt, hash, token, save } }

const KV_KEY = 'users';
const MAX_BODY = 5 * 1024 * 1024; // 5MB

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;

    // CORS 头（免费模板放开所有来源；如需收紧可改为具体 origin）
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    };

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 工具：读写 KV 中的用户表
    const getUsers = async () => {
      const raw = await env.CLOUD_SAVE.get(KV_KEY, { type: 'json' });
      return (raw && typeof raw === 'object') ? raw : {};
    };
    const putUsers = (users) => env.CLOUD_SAVE.put(KV_KEY, JSON.stringify(users));

    const sendJson = (status, obj) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders }
      });

    const hashPassword = async (password, salt) => {
      const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(salt + ':' + password), { name: 'PBKDF2' }, false, ['deriveBits']
      );
      const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt: new TextEncoder().encode(salt) }, key, 256);
      return Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, '0')).join('');
    };
    const randomHex = (len) => {
      const bytes = crypto.getRandomValues(new Uint8Array(len));
      return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    };
    const extractToken = (request) => {
      const auth = request.headers.get('Authorization') || '';
      const m = auth.match(/^Bearer\s+(.+)$/i);
      return m ? m[1].trim() : null;
    };
    const findByToken = (users, token) => {
      if (!token) return null;
      return Object.values(users).find((u) => u && u.token === token) || null;
    };
    const readJson = async (request) => {
      const text = await request.text();
      if (text.length > MAX_BODY) throw new Error('请求体过大（超过 5MB）');
      try { return JSON.parse(text || '{}'); } catch (e) { throw new Error('JSON 格式无效'); }
    };

    // ===== 健康检查 =====
    if (pathname === '/api/health' && method === 'GET') {
      return sendJson(200, { ok: true, service: 'quick-phrase-ai-cloud', version: 1, time: new Date().toISOString() });
    }

    // ===== 注册 =====
    if (pathname === '/api/register' && method === 'POST') {
      try {
        const body = await readJson(request);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        if (!/^[\w.-]{2,32}$/.test(username)) return sendJson(400, { ok: false, error: '用户名需为 2~32 位字母/数字/._-' });
        if (password.length < 6) return sendJson(400, { ok: false, error: '密码长度至少 6 位' });

        const users = await getUsers();
        if (users[username]) return sendJson(409, { ok: false, error: '用户名已存在' });

        const salt = randomHex(16);
        const token = randomHex(24);
        users[username] = { username, salt, hash: await hashPassword(password, salt), token, save: null };
        await putUsers(users);
        return sendJson(200, { ok: true, username, token });
      } catch (e) {
        return sendJson(400, { ok: false, error: e.message });
      }
    }

    // ===== 登录 =====
    if (pathname === '/api/login' && method === 'POST') {
      try {
        const body = await readJson(request);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');

        const users = await getUsers();
        const user = users[username];
        if (!user) return sendJson(404, { ok: false, error: '用户不存在' });
        if (user.hash !== await hashPassword(password, user.salt)) return sendJson(401, { ok: false, error: '密码错误' });

        if (!user.token) user.token = randomHex(24);
        await putUsers(users);
        return sendJson(200, { ok: true, username, token: user.token });
      } catch (e) {
        return sendJson(400, { ok: false, error: e.message });
      }
    }

    // ===== 获取存档 =====
    if (pathname === '/api/save' && method === 'GET') {
      const users = await getUsers();
      const user = findByToken(users, extractToken(request));
      if (!user) return sendJson(401, { ok: false, error: 'token 无效或已过期' });
      return sendJson(200, { ok: true, username: user.username, save: user.save || null });
    }

    // ===== 保存存档 =====
    if (pathname === '/api/save' && method === 'PUT') {
      try {
        const users = await getUsers();
        const user = findByToken(users, extractToken(request));
        if (!user) return sendJson(401, { ok: false, error: 'token 无效或已过期' });

        const save = await readJson(request);
        if (save === null || typeof save !== 'object' || Array.isArray(save)) {
          return sendJson(400, { ok: false, error: '存档必须为 JSON 对象' });
        }
        user.save = save;
        await putUsers(users);
        return sendJson(200, { ok: true, username: user.username });
      } catch (e) {
        return sendJson(400, { ok: false, error: e.message });
      }
    }

    return sendJson(404, { ok: false, error: '接口不存在' });
  }
};
