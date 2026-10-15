/**
 * Evolve 服务端（Cloudflare Worker）
 *
 * 阶段 0：邮箱验证码
 * 阶段 1+：联机账本（贸易 / PvP），见 MULTIPLAYER.md
 *
 * 路由约定：静态资源由 assets 层优先服务，所以 /api/* 会落到这里。
 * 注意：_headers 对 Worker 生成的响应不生效，所有响应头都在本文件里设。
 */

const CODE_TTL = 10 * 60;             // 验证码有效期（秒）
const REQUEST_COOLDOWN = 60;          // 同邮箱两次请求最小间隔（秒）
const MAX_REQ_PER_HOUR = 5;           // 同邮箱每小时请求上限
const MAX_ATTEMPTS = 5;               // 单个码最多试错次数
const VERIFIED_TTL = 30 * 60;         // 验证通过后 token 有效期（秒）

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const now = () => Math.floor(Date.now() / 1000);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomCode() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(100000 + (a[0] % 900000));
}

function normalizeEmail(v) {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  if (e.length < 6 || e.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * 发验证码邮件。走 Resend 的 REST API。
 * DEV_RETURN_CODE=1 时不发信，把码打进日志并在响应里返回（**只能本地调试用**）。
 */
async function sendCodeEmail(env, email, code) {
  if (env.DEV_RETURN_CODE === '1') {
    console.log(`[dev] verification code for ${email} = ${code}`);
    return { dev: true };
  }
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY 未配置');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'noreply@example.com',
      to: [email],
      subject: `Evolve 邮箱验证码：${code}`,
      text:
        `你的验证码是 ${code}\n\n` +
        `10 分钟内有效。如果不是你本人操作，忽略这封邮件即可。\n` +
        `请不要把验证码告诉任何人。`,
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Resend ${res.status}: ${detail}`);
  }
  return { dev: false };
}

/** POST /api/verify/request  { email } */
async function handleVerifyRequest(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body && body.email);
  if (!email) return json({ error: '邮箱格式不正确' }, 400);
  if (!env.DB) return json({ error: '服务端未配置数据库' }, 500);

  const t = now();
  const hourWindow = Math.floor(t / 3600);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';

  // 限流状态放在独立的表里（verify_rate / verify_ip_rate），不能放在 verify_codes：
  // 验证成功后 verify_codes 那行会被删掉，限流计数跟着消失 → 可以无限发信。
  // 这是本地实测发现的漏洞，别再合并回去。
  const rate = await env.DB.prepare('SELECT * FROM verify_rate WHERE email = ?1').bind(email).first();
  if (rate) {
    if (t - rate.last_request_at < REQUEST_COOLDOWN) {
      return json({ error: `请求太频繁，请等 ${REQUEST_COOLDOWN - (t - rate.last_request_at)} 秒后再试` }, 429);
    }
    const used = rate.hour_window === hourWindow ? rate.hour_count : 0;
    if (used >= MAX_REQ_PER_HOUR) {
      return json({ error: '这个邮箱请求次数太多，请过一小时再来' }, 429);
    }
  }
  const ipRate = await env.DB.prepare('SELECT * FROM verify_ip_rate WHERE ip = ?1').bind(ip).first();
  if (ipRate && ipRate.hour_window === hourWindow && ipRate.hour_count >= MAX_REQ_PER_HOUR * 4) {
    return json({ error: '当前网络请求次数太多，请过一小时再来' }, 429);
  }

  const code = randomCode();
  const salt = randomHex(8);
  const codeHash = await sha256Hex(`${code}:${salt}:${email}`);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO verify_codes (email, code_hash, salt, expires_at, attempts)
       VALUES (?1, ?2, ?3, ?4, 0)
       ON CONFLICT(email) DO UPDATE SET code_hash = ?2, salt = ?3, expires_at = ?4, attempts = 0`
    ).bind(email, codeHash, salt, t + CODE_TTL),
    env.DB.prepare(
      `INSERT INTO verify_rate (email, last_request_at, hour_window, hour_count)
       VALUES (?1, ?2, ?3, 1)
       ON CONFLICT(email) DO UPDATE SET
         last_request_at = ?2,
         hour_count = CASE WHEN hour_window = ?3 THEN hour_count + 1 ELSE 1 END,
         hour_window = ?3`
    ).bind(email, t, hourWindow),
    env.DB.prepare(
      `INSERT INTO verify_ip_rate (ip, hour_window, hour_count)
       VALUES (?1, ?2, 1)
       ON CONFLICT(ip) DO UPDATE SET
         hour_count = CASE WHEN hour_window = ?2 THEN hour_count + 1 ELSE 1 END,
         hour_window = ?2`
    ).bind(ip, hourWindow),
  ]);

  try {
    const sent = await sendCodeEmail(env, email, code);
    const out = { ok: true, expiresIn: CODE_TTL };
    if (sent.dev) out.devCode = code;   // 仅 DEV_RETURN_CODE=1 时出现
    return json(out);
  } catch (e) {
    return json({ error: '验证码发送失败，请稍后重试', detail: String(e.message || e).slice(0, 200) }, 502);
  }
}

/** POST /api/verify/confirm  { email, code } */
async function handleVerifyConfirm(request, env) {
  const body = await readJson(request);
  const email = normalizeEmail(body && body.email);
  const code = body && typeof body.code === 'string' ? body.code.trim() : '';
  if (!email) return json({ error: '邮箱格式不正确' }, 400);
  if (!/^\d{6}$/.test(code)) return json({ error: '验证码应为 6 位数字' }, 400);
  if (!env.DB) return json({ error: '服务端未配置数据库' }, 500);

  const t = now();
  const row = await env.DB.prepare('SELECT * FROM verify_codes WHERE email = ?1').bind(email).first();
  if (!row) return json({ error: '请先获取验证码' }, 400);
  if (row.expires_at < t) return json({ error: '验证码已过期，请重新获取' }, 400);
  if (row.attempts >= MAX_ATTEMPTS) return json({ error: '试错次数过多，请重新获取验证码' }, 429);

  const codeHash = await sha256Hex(`${code}:${row.salt}:${email}`);
  if (codeHash !== row.code_hash) {
    await env.DB.prepare('UPDATE verify_codes SET attempts = attempts + 1 WHERE email = ?1').bind(email).run();
    return json({ error: `验证码不正确（还剩 ${MAX_ATTEMPTS - row.attempts - 1} 次机会）` }, 400);
  }

  const token = randomHex(24);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM verify_codes WHERE email = ?1').bind(email),
    env.DB.prepare(
      `INSERT INTO verified_emails (email, verified_at, token, token_expires_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(email) DO UPDATE SET verified_at = ?2, token = ?3, token_expires_at = ?4`
    ).bind(email, t, token, t + VERIFIED_TTL),
  ]);

  return json({ ok: true, verifiedToken: token, expiresIn: VERIFIED_TTL });
}

/** 路由分发 */
async function route(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/health') {
      return json({ ok: true, ts: now(), hasDb: !!env.DB, dev: env.DEV_RETURN_CODE === '1' });
    }
    if (path === '/api/verify/request' && request.method === 'POST') {
      return handleVerifyRequest(request, env);
    }
    if (path === '/api/verify/confirm' && request.method === 'POST') {
      return handleVerifyConfirm(request, env);
    }
    if (path.startsWith('/api/')) {
      return json({ error: 'not found', path }, 404);
    }

    // 非 /api/* 的请求交给静态资源层（正常情况下 assets 会先匹配，走不到这里）
    return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: 'not found' }, 404);
}

/**
 * 统一入口：兜住所有未捕获异常，返回可读的 JSON，而不是 Cloudflare 的空白 500。
 * 这样"表还没建"这类问题会直接告诉你怎么修。
 */
export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      const detail = String((e && e.message) || e).slice(0, 300);
      const hint = /no such table/i.test(detail)
        ? 'D1 里还没建表：去 D1 的 SQL 编辑器执行 deploy/schema.sql'
        : undefined;
      return json({ error: '服务端内部错误', detail, hint }, 500);
    }
  },
};
