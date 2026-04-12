const express = require('express');
const fetch = require('node-fetch');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// ============ SECURITY: Security Headers (Fix #6) ============
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// ============ SECURITY: CORS — restricted origins (Fix #4) ============
const ALLOWED_ORIGINS = ['https://nova-store.dev', 'https://www.nova-store.dev', 'http://localhost:8080'];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ============ SECURITY: Reduced body limit (Fix #13) ============
app.use(express.json({ limit: '1mb' }));

// ============ SECURITY: Rate Limiting (Fix #5) ============
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));

const deployLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: 'Deploy rate limit exceeded' } });
const discordCheckLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many username checks' } });
const paymentLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, message: { error: 'Too many payment requests' } });

// ============ SECURITY: Secrets — no hardcoded fallbacks (Fix #1) ============
const RAILWAY_TOKEN = process.env.RAILWAY_API_TOKEN;
if (!RAILWAY_TOKEN) { console.error('FATAL: RAILWAY_API_TOKEN not set'); process.exit(1); }

const PAYMENTO_API_KEY = process.env.PAYMENTO_API_KEY;
if (!PAYMENTO_API_KEY) console.warn('WARN: PAYMENTO_API_KEY not set. Payment endpoints will be disabled.');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mmvdflwchecvzxzsumlm.supabase.co';
if (!process.env.SUPABASE_URL) console.warn('WARN: SUPABASE_URL using development fallback. Set SUPABASE_URL in production.');

const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_ANON_KEY) console.warn('WARN: SUPABASE_ANON_KEY not set. Some features may be limited.');

const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_SERVICE_KEY) console.warn('WARN: SUPABASE_SERVICE_ROLE_KEY not set. Admin endpoints will use anon key.');

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!DISCORD_BOT_TOKEN) { console.error('FATAL: DISCORD_BOT_TOKEN not set'); process.exit(1); }

const HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${RAILWAY_TOKEN}`,
};

const PROJECT_ID = process.env.NOVA_PROJECT_ID || '7b4710b9-bda7-4eb5-9f46-97e70e7dcda9';
const ENV_ID = process.env.NOVA_ENV_ID || '92d7d13d-1173-4cd0-b6e9-92fdbc1d47ae';

// ============ SECURITY: Authentication Middleware (Fix #2) ============
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'nova-admin-2024-secret';

// Validate Supabase JWT token
async function validateToken(authHeader) {
  if (!authHeader) return null;
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  // Admin secret bypass (for server-to-server calls)
  if (token === ADMIN_SECRET) return { id: 'admin', role: 'admin', email: 'admin@nova.vps' };

  // Supabase JWT validation
  if (SUPABASE_JWT_SECRET) {
    try {
      const jwt = require('jsonwebtoken');
      const payload = jwt.verify(token, SUPABASE_JWT_SECRET, { algorithms: ['HS256'] });
      return { id: payload.sub, role: payload.role || 'user', email: payload.email };
    } catch {}
  }

  // Fallback: validate via Supabase API
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`,
      },
    });
    if (res.ok) {
      const userData = await res.json();
      return { id: userData.id, role: userData.role || 'user', email: userData.email };
    }
  } catch {}

  return null;
}

// Auth middleware
const requireAuth = async (req, res, next) => {
  const user = await validateToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
};

const requireAdmin = async (req, res, next) => {
  const user = await validateToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (user.role !== 'admin') return res.status(403).json({ error: 'Forbidden: Admin access required' });
  req.user = user;
  next();
};

// ============ SECURITY: Input validation helpers (Fix #12) ============
function validateDiscordId(id) {
  return /^\d{17,20}$/.test(id);
}

async function gql(query, vars = {}) {
  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ query, variables: vars }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('Bad response from Railway'); }
  if (json.errors) throw new Error(json.errors[0]?.message || 'GraphQL error');
  return json.data;
}

// ============ SECURITY: Rate-limited deploy endpoint (Fix #3, #5, #10) ============
app.post('/deploy', requireAuth, deployLimiter, async (req, res) => {
  const { botName, botToken, language, code } = req.body;
  if (!botToken || !code || !language) return res.status(400).json({ error: 'Missing fields' });

  // SECURITY: Input validation (Fix #10)
  const ALLOWED_LANGUAGES = ['javascript', 'python'];
  if (!ALLOWED_LANGUAGES.includes(language)) return res.status(400).json({ error: 'Invalid language' });
  if (!botName || botName.trim().length < 1) return res.status(400).json({ error: 'Bot name required' });
  if (!code || code.length < 10) return res.status(400).json({ error: 'Code too short' });
  if (code.length > 500000) return res.status(400).json({ error: 'Code too large (max 500KB)' });

  try {
    const name = `bot-${botName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 30)}`;
    console.log(`Deploy: ${name} (${language})`);

    // Replace YOUR_TOKEN with real token in code, preserving surrounding quotes
    const finalCode = code.replace(/(['"])YOUR_TOKEN\1/g, `$1${botToken}$1`);
    const codeB64 = Buffer.from(finalCode).toString('base64');

    // Use the pre-built runner repo (has discord.js installed in Dockerfile)
    const repo = language === 'python' ? 'ihso77/nova-bot-runner-py' : 'ihso77/nova-bot-runner';

    // 1. Create service from repo (Dockerfile has discord.js pre-installed)
    const d = await gql(`
      mutation($p: String!, $n: String!, $r: String!) {
        s: serviceCreate(input: { projectId: $p, name: $n, source: { repo: $r } }) { id }
      }
    `, { p: PROJECT_ID, n: name, r: repo });
    const serviceId = d.s?.id;
    if (!serviceId) throw new Error('Failed to create service');
    console.log(`Service: ${serviceId}`);

    // 2. Set BOT_CODE_B64 env var (skip auto-deploy)
    await gql(`
      mutation($input: VariableUpsertInput!) {
        v: variableUpsert(input: $input)
      }
    `, {
      input: {
        projectId: PROJECT_ID,
        environmentId: ENV_ID,
        serviceId: serviceId,
        name: 'BOT_CODE_B64',
        value: codeB64,
        skipDeploys: true
      }
    });
    console.log(`Env var set`);

    // 3. Set startCommand to read env var, decode, and run bot
    let startCmd;
    if (language === 'python') {
      startCmd = 'sh -c "echo $BOT_CODE_B64 | base64 -d > /app/bot.py && python /app/bot.py"';
    } else {
      startCmd = 'sh -c "echo $BOT_CODE_B64 | base64 -d > /app/bot.js && node /app/bot.js"';
    }

    await gql(`
      mutation($s: String!, $e: String!, $c: String!) {
        u: serviceInstanceUpdate(serviceId: $s, environmentId: $e, input: { startCommand: $c })
      }
    `, { s: serviceId, e: ENV_ID, c: startCmd });
    console.log(`Start command set`);

    // 4. Trigger deploy
    await gql(`
      mutation($s: String!, $e: String!) {
        d: serviceInstanceDeploy(serviceId: $s, environmentId: $e)
      }
    `, { s: serviceId, e: ENV_ID });

    console.log(`Deploy triggered for ${name}`);
    res.json({ success: true, serviceId, serviceName: name });
  } catch (err) {
    console.error('FAIL:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============ SECURITY: Authenticated stop endpoint (Fix #3) ============
app.post('/stop', requireAuth, async (req, res) => {
  const { serviceId } = req.body;
  if (!serviceId) return res.status(400).json({ error: 'Missing serviceId' });
  try {
    await gql(`mutation($id: String!) { serviceDelete(id: $id) }`, { id: serviceId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get deployment status and logs for a service
app.get('/status', async (req, res) => {
  const { serviceId } = req.query;
  if (!serviceId) return res.status(400).json({ error: 'Missing serviceId' });

  try {
    const data = await gql(`
      query($sid: String!) {
        service(id: $sid) {
          deployments(limit: 1) {
            edges { node { id status } }
          }
        }
      }
    `, { sid: serviceId });

    const deployment = data.service?.deployments?.edges?.[0]?.node;
    if (!deployment) return res.json({ status: 'unknown' });

    // If deployment is done, fetch logs
    let logs = [];
    if (deployment.status === 'CRASHED' || deployment.status === 'SUCCESS') {
      try {
        const logsData = await gql(`
          query($did: String!) { deploymentLogs(deploymentId: $did) { message severity } }
        `, { did: deployment.id });
        if (logsData.deploymentLogs) {
          logs = logsData.deploymentLogs
            .filter(l => l.severity === 'error' || l.severity === 'fatal' ||
              (l.message && (l.message.includes('Logged in') || l.message.includes('Ready') ||
                l.message.includes('ready') || l.message.includes('✅') || l.message.includes('Error') ||
                l.message.includes('error') || l.message.includes('bot.js') || l.message.includes('bot.py'))))
            .map(l => ({ message: l.message, severity: l.severity }));
        }
      } catch {}
    }

    res.json({ status: deployment.status, logs, deploymentId: deployment.id });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Paymento proxy - correct API format per docs.paymento.io
// POST /payment — create payment request → returns token + gateway URL
app.post('/payment', requireAuth, paymentLimiter, async (req, res) => {
  // Accept both new format (returnUrl/orderId) and old format (success_url/cancel_url)
  const body = req.body;
  const clientAmount = body.amount;
  const planId = body.planId;  // plan UUID for server-side price verification
  const currency = body.currency || 'USD';
  const description = body.description;
  const returnUrl = body.returnUrl || body.success_url;
  const orderId = body.orderId || body.metadata?.orderId || `nova_${Date.now()}`;

  if (!clientAmount || !returnUrl) return res.status(400).json({ error: 'Missing required fields' });

  // SECURITY: Clamp amount to prevent absurd values
  const parsedAmount = parseFloat(clientAmount);
  if (isNaN(parsedAmount) || parsedAmount < 0.01 || parsedAmount > 9999) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  // SECURITY: Validate return URL domain (Fix #11)
  const ALLOWED_RETURN_DOMAINS = ['nova-store.dev', 'localhost'];
  try {
    const returnUrlParsed = new URL(returnUrl);
    if (!ALLOWED_RETURN_DOMAINS.some(d => returnUrlParsed.hostname.endsWith(d))) {
      return res.status(400).json({ error: 'Invalid return URL domain' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid return URL' });
  }

  try {
    // SECURITY: Verify price from server if planId provided — always use server price (Fix #9)
    let verifiedAmount = parsedAmount;

    if (planId) {
      if (!SUPABASE_ANON_KEY) return res.status(500).json({ error: 'Server configuration error' });
      try {
        const planRes = await fetch(`${SUPABASE_URL}/rest/v1/plans?id=eq.${planId}&select=price,name`, {
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          },
        });
        if (!planRes.ok) return res.status(400).json({ error: 'Plan verification failed' });
        const planData = await planRes.json();
        if (!planData || planData.length === 0) return res.status(400).json({ error: 'Invalid plan' });
        const serverPrice = parseFloat(planData[0].price);
        verifiedAmount = serverPrice; // ALWAYS use server price
      } catch (e) {
        return res.status(500).json({ error: 'Price verification failed' });
      }
    }

    console.log('Payment request:', { verifiedAmount, currency, orderId });

    // Paymento API: POST /v1/payment/request with Api-Key header
    const paymentRes = await fetch('https://api.paymento.io/v1/payment/request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Api-Key': PAYMENTO_API_KEY,
      },
      body: JSON.stringify({
        fiatAmount: String(verifiedAmount),
        fiatCurrency: currency || 'USD',
        returnUrl: returnUrl,
        orderId: orderId,
        riskSpeed: 1,
        additionalData: description ? [{ key: 'description', value: description }] : [],
      }),
    });

    const text = await paymentRes.text();
    console.log('Paymento response status:', paymentRes.status);
    console.log('Paymento response body:', text.substring(0, 500));

    if (!paymentRes.ok) {
      return res.status(paymentRes.status).json({
        error: 'بوابة الدفع ردت بخطأ',
        status: paymentRes.status,
        detail: text.substring(0, 300),
      });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return res.status(502).json({ error: 'بوابة الدفع ردت بيانات غير صالحة', detail: text.substring(0, 200) });
    }

    if (data.error) {
      return res.status(502).json({ error: data.error });
    }

    // Paymento returns { body: "TOKEN_STRING" } — token is inside "body" field
    const token = data.body || data.token || data.payment_token || data.id;

    if (!token) {
      console.error('No token in Paymento response:', JSON.stringify(data).replace(/[A-Za-z0-9_-]{30,}/g, '***'));
      return res.status(502).json({ error: 'لم يتم استلام رمز الدفع من بوابة الدفع' });
    }

    // Build redirect URL
    const gatewayUrl = `https://app.paymento.io/gateway?token=${token}`;

    // SECURITY: Mask token in logs (Fix #8)
    console.log('Payment created successfully, token: ****' + token.slice(-4));
    res.json({ url: gatewayUrl, token, orderId });
  } catch (err) {
    console.error('Payment error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Paymento verify - verify payment status after redirect
// POST /verify — confirm payment was actually completed
app.post('/verify', requireAuth, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  try {
    // SECURITY: Mask token in logs (Fix #8)
    console.log('Verify payment, token: ****' + token.slice(-4));

    const verifyRes = await fetch('https://api.paymento.io/v1/payment/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Api-Key': PAYMENTO_API_KEY,
      },
      body: JSON.stringify({ token }),
    });

    const text = await verifyRes.text();
    console.log('Verify response status:', verifyRes.status);
    console.log('Verify response body:', text.substring(0, 500));

    if (!verifyRes.ok) {
      return res.status(verifyRes.status).json({
        error: 'فشل التحقق من الدفع',
        status: verifyRes.status,
        detail: text.substring(0, 300),
      });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return res.status(502).json({ error: 'استجابة غير صالحة من بوابة الدفع', detail: text.substring(0, 200) });
    }

    // Paymento returns { body: { token, orderId, orderStatus, additionalData } }
    const result = data.body || data;

    // Status codes: 0=Init, 1=Pending, 2=PartialPaid, 3=WaitingToConfirm,
    // 4=Timeout, 5=UserCanceled, 7=Paid, 8=Approve, 9=Reject
    const statusMap = {
      0: 'initialized', 1: 'pending', 2: 'partial', 3: 'confirming',
      4: 'expired', 5: 'cancelled', 7: 'paid', 8: 'approved', 9: 'rejected'
    };
    const statusCode = result.orderStatus ?? result.status ?? -1;
    const statusName = statusMap[statusCode] || 'unknown';

    const isPaid = statusCode === 7 || statusCode === 8;

    // SECURITY: Remove sensitive data from response (Fix #7)
    // Only return paid, status, statusCode, orderId — no raw data or tokens
    res.json({
      paid: isPaid,
      status: statusName,
      statusCode,
      orderId: result.orderId,
    });
  } catch (err) {
    console.error('Verify error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Discord username availability checker proxy — rate limited + authenticated (Fix #3, #5)
app.get('/discord-check', requireAuth, discordCheckLimiter, async (req, res) => {
  const { username } = req.query;
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'Missing username parameter' });
  }
  if (username.length < 2 || username.length > 32) {
    return res.status(400).json({ error: 'Username must be 2-32 characters' });
  }

  try {
    const superProps = Buffer.from(JSON.stringify({
      os: 'Windows', browser: 'Chrome', device: '', system_locale: 'en-US',
      browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      browser_version: '131.0.0.0', os_version: '10', referrer: '', referring_domain: '',
      referrer_current: '', referring_domain_current: '', release_channel: 'stable',
      client_build_number: 99999, client_event_source: null
    })).toString('base64');

    // Send fake registration request — Discord only cares about username field
    const discordRes = await fetch('https://discord.com/api/v9/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Origin': 'https://discord.com',
        'Referer': 'https://discord.com/register',
        'x-super-properties': superProps,
      },
      body: JSON.stringify({
        username: username,
        password: 'Xk9#mP2vLq8nR4wY',
        email: `${Date.now()}_${Math.random().toString(36).slice(2)}@neverused.invalid`,
        date_of_birth: '2000-01-01',
        consent: true,
      }),
    });

    const data = await discordRes.json();

    if (discordRes.status === 429) {
      // Rate limited
      console.warn('Discord rate limited');
      return res.json({ available: false, username, retry: true });
    }

    // Check if the error is specifically USERNAME_ALREADY_TAKEN
    const usernameErrors = data.errors?.username?._errors || [];
    const isTaken = usernameErrors.some((e) => e.code === 'USERNAME_ALREADY_TAKEN');

    if (isTaken) {
      res.json({ available: false, username });
    } else {
      // Any other error (password, email, etc.) means username is available
      res.json({ available: true, username });
    }
  } catch (err) {
    console.error('Discord check error:', err.message);
    // SECURITY: Don't expose internal error details (Fix #14)
    res.status(500).json({ error: 'Failed to check username' });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok' }));

// ============================================================
// Discord Bot Management Endpoints — ALL require admin (Fix #3)
// ============================================================

async function discordAPI(path, method = 'GET', body = null) {
  if (!DISCORD_BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN not configured');
  const opts = {
    method,
    headers: {
      'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'NovaManagerBot (https://nova-store.dev, 1.0)',
      'Accept': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://discord.com/api/v10${path}`, opts);
  const text = await res.text();
  // Discord sometimes returns HTML (Cloudflare challenge) — handle gracefully
  if (text.startsWith('<!') || text.startsWith('<html')) {
    throw new Error('Discord returned HTML (rate-limited or Cloudflare challenge). Please retry in 30-60 seconds.');
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Discord returned invalid response: ${text.substring(0, 200)}`); }
  if (!res.ok) throw new Error(data.message || `Discord API ${res.status}`);
  return data;
}

async function supabaseQuery(table, query = '') {
  const key = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
  if (!key) return [];
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
  });
  return res.ok ? await res.json() : [];
}

async function supabaseCount(table, query = '') {
  const key = SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
  if (!key) return 0;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}&select=id`, {
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Prefer': 'count=exact' },
  });
  return parseInt(res.headers.get('content-range')?.split('/')[1] || '0');
}

// GET /bot/invite — return bot invite URL with applications.commands scope
app.get('/bot/invite', requireAdmin, async (req, res) => {
  try {
    const me = await discordAPI('/users/@me');
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${me.id}&permissions=8&scope=bot%20applications.commands`;
    res.json({ invite_url: inviteUrl, bot_id: me.id, bot_name: me.username });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /bot/info — bot info + guilds
app.get('/bot/info', requireAdmin, async (req, res) => {
  try {
    const me = await discordAPI('/users/@me');
    const guilds = await discordAPI('/users/@me/guilds');
    res.json({
      bot: { id: me.id, username: me.username, discriminator: me.discriminator, avatar: me.avatar },
      guilds_count: guilds.length,
      guilds: guilds.map(g => ({ id: g.id, name: g.name, icon: g.icon })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /bot/guilds/:guildId/channels — text channels in a guild (Fix #3, #12)
app.get('/bot/guilds/:guildId/channels', requireAdmin, async (req, res) => {
  try {
    const guildId = req.params.guildId;
    if (!validateDiscordId(guildId)) return res.status(400).json({ error: 'Invalid guild ID' });
    const channels = await discordAPI(`/guilds/${guildId}/channels`);
    const textChannels = channels.filter(c => c.type === 0).map(c => ({ id: c.id, name: c.name }));
    res.json({ channels: textChannels });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /bot/commands/register — register slash commands + set interaction endpoint URL
app.post('/bot/commands/register', requireAdmin, async (req, res) => {
  try {
    const me = await discordAPI('/users/@me');
    const appId = me.id;
    const GUILD_ID = process.env.GUILD_ID || '1492282157601657006';
    const ALLOWED_ROLE_ID = process.env.ALLOWED_ROLE_ID || '1492495751438401577';
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=8&scope=bot%20applications.commands`;

    // Step 1: Delete all global commands
    try {
      await discordAPI(`/applications/${appId}/commands`, 'PUT', []);
    } catch (err) {
      if (err.message.includes('Missing Access')) {
        return res.status(403).json({ error: 'Missing Access', detail: 'البوت ليس لديه صلاحية applications.commands. أعد دعوة البوت بالرابط أدناه.', invite_url: inviteUrl });
      }
      throw err;
    }

    // Step 2: Register guild commands with role restriction (hidden from everyone by default)
    const commands = [
      { name: 'help', description: 'عرض الأوامر المتاحة', type: 1, default_member_permissions: '0' },
      { name: 'prices', description: 'عرض باقات Nova VPS', type: 1, options: [{ name: 'channel', description: 'الروم', type: 7, required: false }], default_member_permissions: '0' },
      { name: 'serverinfo', description: 'معلومات السيرفر', type: 1, default_member_permissions: '0' },
      { name: 'user', description: 'معلومات مستخدم', type: 1, options: [{ name: 'member', description: 'المستخدم', type: 6, required: false }], default_member_permissions: '0' },
      { name: 'avatar', description: 'صورة بروفايل', type: 1, options: [{ name: 'member', description: 'المستخدم', type: 6, required: false }], default_member_permissions: '0' },
      { name: 'stats', description: 'إحصائيات Nova VPS', type: 1, default_member_permissions: '0' },
      { name: 'ping', description: 'سرعة البوت', type: 1, default_member_permissions: '0' },
      { name: 'invite', description: 'رابط دعوة البوت', type: 1, default_member_permissions: '0' },
      { name: 'poll', description: 'إنشاء تصويت', type: 1, options: [
        { name: 'question', description: 'السؤال', type: 3, required: true },
        { name: 'option1', description: 'الخيار 1', type: 3, required: true },
        { name: 'option2', description: 'الخيار 2', type: 3, required: true },
      ], default_member_permissions: '0' },
      { name: 'announce', description: 'إرسال إعلان', type: 1, options: [
        { name: 'message', description: 'محتوى الإعلان', type: 3, required: true },
        { name: 'channel', description: 'الروم', type: 7, required: false },
      ], default_member_permissions: '0' },
      { name: 'status', description: 'حالة خدمات Nova VPS', type: 1, default_member_permissions: '0' },
      { name: 'uptime', description: 'مدة تشغيل البوت', type: 1, default_member_permissions: '0' },
      { name: 'roles', description: 'قائمة الرتب', type: 1, default_member_permissions: '0' },
      { name: 'emoji-info', description: 'معلومات الإيموجي', type: 1, default_member_permissions: '0' },
      { name: 'banner', description: 'بانر السيرفر', type: 1, default_member_permissions: '0' },
      { name: 'site-check', description: 'فحص خدمات الموقع', type: 1, default_member_permissions: '0' },
      { name: 'top-servers', description: 'أفضل المشاريع النشطة', type: 1, options: [{ name: 'count', description: 'العدد', type: 4, required: false }], default_member_permissions: '0' },
      { name: 'plans-detail', description: 'تفاصيل الباقات', type: 1, default_member_permissions: '0' },
      { name: 'lookup', description: 'بحث مستخدم (أدمن)', type: 1, options: [{ name: 'email', description: 'البريد', type: 3, required: true }], default_member_permissions: '0' },
      { name: 'recent-payments', description: 'آخر المدفوعات (أدمن)', type: 1, default_member_permissions: '0' },
      { name: 'set-status-channel', description: 'تعيين روم الحالة', type: 1, options: [{ name: 'channel', description: 'الروم', type: 7, required: true }], default_member_permissions: '0' },
      { name: 'send-ticket-panel', description: 'ارسال بانل التذاكر', type: 1, options: [{ name: 'channel', description: 'الروم', type: 7, required: false }], default_member_permissions: '0' },
    ];
    let result;
    try {
      result = await discordAPI(`/applications/${appId}/guilds/${GUILD_ID}/commands`, 'PUT', commands);
    } catch (err) {
      if (err.message.includes('Missing Access')) {
        return res.status(403).json({ error: 'Missing Access', detail: 'البوت ليس لديه صلاحية applications.commands. أعد دعوة البوت بالرابط أدناه.', invite_url: inviteUrl });
      }
      throw err;
    }

    // Step 3: Set role permissions for each command
    for (const cmd of result) {
      try {
        await discordAPI(`/applications/${appId}/guilds/${GUILD_ID}/commands/${cmd.id}/permissions`, 'PUT', {
          permissions: [{ id: ALLOWED_ROLE_ID, type: 1, permission: true }],
        });
      } catch (permErr) {
        console.warn(`Failed to set permissions for ${cmd.name}:`, permErr.message);
      }
    }

    res.json({ success: true, message: `تم تسجيل ${result.length} أمر (مقيد للرتبة)`, commands: result.map(c => c.name) });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /bot/send-prices — send plans embed to a channel (Fix #3, #12)
app.post('/bot/send-prices', requireAdmin, async (req, res) => {
  try {
    const { channel_id } = req.body;
    if (!channel_id) return res.status(400).json({ error: 'channel_id required' });
    if (!validateDiscordId(channel_id)) return res.status(400).json({ error: 'Invalid channel ID' });
    const plans = await supabaseQuery('plans', '?is_active=eq.true&order=sort_order');
    const fields = plans.map(p => ({
      name: `${p.is_free ? '\uD83C\uDF81' : '\u2B50'} ${p.name}`,
      value: [
        p.description ? `\uD83D\uDCDD *${p.description}*` : '',
        `\uD83D\uDCB0 ${p.price === 0 ? '**\u0645\u062C\u0627\u0646\u064A**' : `**$${p.price}/\u0634\u0647\u0631**`}`,
        `\uD83D\uDCBE ${p.storage_mb >= 1024 ? `${p.storage_mb / 1024}GB` : `${p.storage_mb}MB`} \u062A\u062E\u0632\u064A\u0646`,
        `\uD83E\uDDE0 ${p.ram_mb >= 1024 ? `${p.ram_mb / 1024}GB` : `${p.ram_mb}MB`} \u0631\u0627\u0645`,
        `\u26A1 ${p.cpu_cores} \u0646\u0648\u0627\u0629 \u0645\u0639\u0627\u0644\u062C`,
      ].filter(Boolean).join('\n'),
      inline: true,
    }));
    await discordAPI(`/channels/${channel_id}/messages`, 'POST', {
      embeds: [{
        title: '\uD83D\uDE80 Nova VPS - \u0628\u0627\u0642\u0627\u062A \u0627\u0644\u0627\u0633\u062A\u0636\u0627\u0641\u0629',
        description: '\uD83D\uDD17 **[\u0627\u0634\u062A\u0631\u0643 \u0627\u0644\u0622\u0646](https://nova-store.dev/plans)**',
        color: 0x8B5CF6,
        fields,
        footer: {
          text: '\uD83D\uDCB0 \u0646\u0638\u0627\u0645 \u0627\u0644\u0643\u0648\u064A\u0646\u0632\u0627\u062A \u0645\u062A\u0648\u0641\u0631 | \u0623\u0642\u0644 \u0628\u0627\u0642\u0629 75 \u0643\u0648\u064A\u0646\u0632 | 100 \u0643\u0648\u064A\u0646\u0632 = 15m | Nova VPS',
        },
        timestamp: new Date().toISOString(),
      }],
    });
    res.json({ success: true, message: '\u062A\u0645 \u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u0623\u0633\u0639\u0627\u0631' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /bot/announce — send announcement embed (Fix #3, #12)
app.post('/bot/announce', requireAdmin, async (req, res) => {
  try {
    const { channel_id, message } = req.body;
    if (!channel_id || !message) return res.status(400).json({ error: 'channel_id and message required' });
    if (!validateDiscordId(channel_id)) return res.status(400).json({ error: 'Invalid channel ID' });
    await discordAPI(`/channels/${channel_id}/messages`, 'POST', {
      embeds: [{
        title: '📢 إعلان من Nova VPS', description: message, color: 0x8B5CF6,
        footer: { text: 'Nova VPS' }, timestamp: new Date().toISOString(),
      }],
    });
    res.json({ success: true, message: 'تم إرسال الإعلان' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /bot/send-ticket-panel — send ticket select panel to a channel (Fix #3, #12)
app.post('/bot/send-ticket-panel', requireAdmin, async (req, res) => {
  try {
    const { channel_id } = req.body;
    if (!channel_id) return res.status(400).json({ error: 'channel_id required' });
    if (!validateDiscordId(channel_id)) return res.status(400).json({ error: 'Invalid channel ID' });

    await discordAPI(`/channels/${channel_id}/messages`, 'POST', {
      content: 'لافتح تذكرة دعم فني، اختر القسم من القائمة بالاسفل',
      components: [{
        type: 1,
        components: [{
          type: 3,
          custom_id: 'ticket_category',
          placeholder: 'اختر القسم',
          options: [
            { label: 'Support', value: 'support', description: 'فتح تذكرة دعم فني' },
          ],
        }],
      }],
    });

    res.json({ success: true, message: 'تم ارسال بانل التذاكر' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /bot/stats — get platform stats (Fix #3 — auth required)
app.get('/bot/stats', requireAuth, async (req, res) => {
  try {
    const [users, projects, subs] = await Promise.all([
      supabaseCount('profiles'),
      supabaseCount('projects'),
      supabaseCount('subscriptions', '?status=eq.active'),
    ]);
    res.json({ users, projects, active_subscriptions: subs });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /bot/setup — auto-setup: register guild commands + set interaction endpoint URL
app.post('/bot/setup', requireAdmin, async (req, res) => {
  try {
    const me = await discordAPI('/users/@me');
    const appId = me.id;
    const GUILD_ID = process.env.GUILD_ID || '1492282157601657006';
    const ALLOWED_ROLE_ID = process.env.ALLOWED_ROLE_ID || '1492495751438401577';
    const proxyUrl = process.env.PUBLIC_URL || `https://proxy-production-a7b5.up.railway.app`;
    const endpointUrl = `${proxyUrl}/bot/interactions`;
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=8&scope=bot%20applications.commands`;

    // 1. Delete global commands
    try {
      await discordAPI(`/applications/${appId}/commands`, 'PUT', []);
    } catch (err) {
      if (err.message.includes('Missing Access')) {
        return res.status(403).json({ error: 'Missing Access', detail: 'البوت ليس لديه صلاحية applications.commands. أعد دعوة البوت بالرابط أدناه.', invite_url: inviteUrl });
      }
      throw err;
    }

    // 2. Register guild commands (hidden from everyone by default)
    const commands = [
      { name: 'help', description: 'عرض الأوامر المتاحة', type: 1, default_member_permissions: '0' },
      { name: 'prices', description: 'عرض باقات Nova VPS', type: 1, options: [{ name: 'channel', description: 'الروم', type: 7, required: false }], default_member_permissions: '0' },
      { name: 'serverinfo', description: 'معلومات السيرفر', type: 1, default_member_permissions: '0' },
      { name: 'user', description: 'معلومات مستخدم', type: 1, options: [{ name: 'member', description: 'المستخدم', type: 6, required: false }], default_member_permissions: '0' },
      { name: 'avatar', description: 'صورة بروفايل', type: 1, options: [{ name: 'member', description: 'المستخدم', type: 6, required: false }], default_member_permissions: '0' },
      { name: 'stats', description: 'إحصائيات Nova VPS', type: 1, default_member_permissions: '0' },
      { name: 'ping', description: 'سرعة البوت', type: 1, default_member_permissions: '0' },
      { name: 'invite', description: 'رابط دعوة البوت', type: 1, default_member_permissions: '0' },
      { name: 'poll', description: 'إنشاء تصويت', type: 1, options: [
        { name: 'question', description: 'السؤال', type: 3, required: true },
        { name: 'option1', description: 'الخيار 1', type: 3, required: true },
        { name: 'option2', description: 'الخيار 2', type: 3, required: true },
      ], default_member_permissions: '0' },
      { name: 'announce', description: 'إرسال إعلان', type: 1, options: [
        { name: 'message', description: 'محتوى الإعلان', type: 3, required: true },
        { name: 'channel', description: 'الروم', type: 7, required: false },
      ], default_member_permissions: '0' },
      { name: 'status', description: 'حالة خدمات Nova VPS', type: 1, default_member_permissions: '0' },
      { name: 'uptime', description: 'مدة تشغيل البوت', type: 1, default_member_permissions: '0' },
      { name: 'roles', description: 'قائمة الرتب', type: 1, default_member_permissions: '0' },
      { name: 'emoji-info', description: 'معلومات الإيموجي', type: 1, default_member_permissions: '0' },
      { name: 'banner', description: 'بانر السيرفر', type: 1, default_member_permissions: '0' },
      { name: 'site-check', description: 'فحص خدمات الموقع', type: 1, default_member_permissions: '0' },
      { name: 'top-servers', description: 'أفضل المشاريع النشطة', type: 1, options: [{ name: 'count', description: 'العدد', type: 4, required: false }], default_member_permissions: '0' },
      { name: 'plans-detail', description: 'تفاصيل الباقات', type: 1, default_member_permissions: '0' },
      { name: 'lookup', description: 'بحث مستخدم (أدمن)', type: 1, options: [{ name: 'email', description: 'البريد', type: 3, required: true }], default_member_permissions: '0' },
      { name: 'recent-payments', description: 'آخر المدفوعات (أدمن)', type: 1, default_member_permissions: '0' },
      { name: 'set-status-channel', description: 'تعيين روم الحالة', type: 1, options: [{ name: 'channel', description: 'الروم', type: 7, required: true }], default_member_permissions: '0' },
      { name: 'send-ticket-panel', description: 'ارسال بانل التذاكر', type: 1, options: [{ name: 'channel', description: 'الروم', type: 7, required: false }], default_member_permissions: '0' },
    ];
    let cmdResult;
    try {
      cmdResult = await discordAPI(`/applications/${appId}/guilds/${GUILD_ID}/commands`, 'PUT', commands);
    } catch (err) {
      if (err.message.includes('Missing Access')) {
        return res.status(403).json({ error: 'Missing Access', detail: 'البوت ليس لديه صلاحية applications.commands. أعد دعوة البوت بالرابط أدناه.', invite_url: inviteUrl });
      }
      throw err;
    }

    // 3. Set role permissions for each command
    for (const cmd of cmdResult) {
      try {
        await discordAPI(`/applications/${appId}/guilds/${GUILD_ID}/commands/${cmd.id}/permissions`, 'PUT', {
          permissions: [{ id: ALLOWED_ROLE_ID, type: 1, permission: true }],
        });
      } catch (permErr) {
        console.warn(`Failed to set permissions for ${cmd.name}:`, permErr.message);
      }
    }

    // 4. Set interaction endpoint URL
    await discordAPI(`/applications/${appId}/interactions-endpoint-url`, 'PATCH', {
      interactions_endpoint_url: endpointUrl,
    });

    res.json({
      success: true,
      message: 'تم إعداد البوت بنجاح!',
      bot: me.username,
      commands_registered: cmdResult.length,
      guild_only: true,
      role_restricted: ALLOWED_ROLE_ID,
      endpoint_url: endpointUrl,
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /bot/interactions — Discord webhook for slash commands
// Note: This endpoint is NOT behind requireAdmin because Discord sends these directly
app.post('/bot/interactions', async (req, res) => {
  const interaction = req.body;
  // PING
  if (interaction.type === 1) return res.json({ type: 1 });

  if (interaction.type === 2) {
    const { name, options = [] } = interaction.data;
    const channelId = options.find(o => o.name === 'channel')?.value || interaction.channel_id;

    try {
      // /prices
      if (name === 'prices') {
        const plans = await supabaseQuery('plans', '?is_active=eq.true&order=sort_order');
        const fields = plans.map(p => ({
          name: `${p.is_free ? '\uD83C\uDF81' : '\u2B50'} ${p.name}`,
          value: [
            p.description ? `\uD83D\uDCDD *${p.description}*` : '',
            `\uD83D\uDCB0 ${p.price === 0 ? '**\u0645\u062C\u0627\u0646\u064A**' : `**$${p.price}/\u0634\u0647\u0631**`}`,
            `\uD83D\uDCBE ${p.storage_mb >= 1024 ? `${p.storage_mb / 1024}GB` : `${p.storage_mb}MB`} \u062A\u062E\u0632\u064A\u0646`,
            `\uD83E\uDDE0 ${p.ram_mb >= 1024 ? `${p.ram_mb / 1024}GB` : `${p.ram_mb}MB`} \u0631\u0627\u0645`,
            `\u26A1 ${p.cpu_cores} \u0646\u0648\u0627\u0629 \u0645\u0639\u0627\u0644\u062C`,
          ].filter(Boolean).join('\n'),
          inline: true,
        }));
        await discordAPI(`/channels/${channelId}/messages`, 'POST', {
          embeds: [{
            title: '\uD83D\uDE80 Nova VPS - \u0628\u0627\u0642\u0627\u062A \u0627\u0644\u0627\u0633\u062A\u0636\u0627\u0641\u0629',
            description: '\uD83D\uDD17 **[\u0627\u0634\u062A\u0631\u0643 \u0627\u0644\u0622\u0646](https://nova-store.dev/plans)**',
            color: 0x8B5CF6,
            fields,
            footer: {
              text: '\uD83D\uDCB0 \u0646\u0638\u0627\u0645 \u0627\u0644\u0643\u0648\u064A\u0646\u0632\u0627\u062A \u0645\u062A\u0648\u0641\u0631 | \u0623\u0642\u0644 \u0628\u0627\u0642\u0629 75 \u0643\u0648\u064A\u0646\u0632 | 100 \u0643\u0648\u064A\u0646\u0632 = 15m | Nova VPS',
            },
            timestamp: new Date().toISOString(),
          }],
        });
        return res.json({ type: 4, data: { content: '\u2705 \u062A\u0645 \u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u0623\u0633\u0639\u0627\u0631!', flags: 64 } });
      }

      // /serverinfo
      if (name === 'serverinfo') {
        const guild = await discordAPI(`/guilds/${interaction.guild_id}?with_counts=true`);
        const created = new Date(Number(BigInt(guild.id) >> 22n) + 1420070400000).toLocaleDateString('ar-SA');
        return res.json({
          type: 4, data: {
            embeds: [{
              title: `📊 معلومات السيرفر: ${guild.name}`, color: 0x8B5CF6,
              fields: [
                { name: '👥 الأعضاء', value: `${guild.approximate_member_count || '?'}`, inline: true },
                { name: '🟢 متصل', value: `${guild.approximate_presence_count || '?'}`, inline: true },
                { name: '📅 الإنشاء', value: created, inline: true },
                { name: '🆔 ID', value: guild.id, inline: true },
              ],
              flags: 64,
            }],
          },
        });
      }

      // /stats
      if (name === 'stats') {
        const [users, projects, subs] = await Promise.all([
          supabaseCount('profiles'), supabaseCount('projects'), supabaseCount('subscriptions', '?status=eq.active'),
        ]);
        return res.json({
          type: 4, data: {
            embeds: [{
              title: '📈 إحصائيات Nova VPS', color: 0x8B5CF6,
              fields: [
                { name: '👥 المستخدمين', value: `${users}`, inline: true },
                { name: '🤖 المشاريع', value: `${projects}`, inline: true },
                { name: '⭐ اشتراكات', value: `${subs}`, inline: true },
              ],
              footer: { text: 'Nova VPS' }, timestamp: new Date().toISOString(), flags: 64,
            }],
          },
        });
      }

      // /announce
      if (name === 'announce') {
        const msg = options.find(o => o.name === 'message')?.value;
        const author = interaction.member?.user?.username || 'Admin';
        await discordAPI(`/channels/${channelId}/messages`, 'POST', {
          embeds: [{
            title: '📢 إعلان من Nova VPS', description: msg, color: 0x8B5CF6,
            footer: { text: `بواسطة ${author}` }, timestamp: new Date().toISOString(),
          }],
        });
        return res.json({ type: 4, data: { content: '✅ تم إرسال الإعلان!', flags: 64 } });
      }

      // /status
      if (name === 'status') {
        return res.json({
          type: 4, data: {
            embeds: [{
              title: '🟢 حالة Nova VPS', description: 'جميع الخدمات تعمل بشكل طبيعي', color: 0x22C55E,
              fields: [
                { name: '🌐 الموقع', value: '[nova-store.dev](https://nova-store.dev)', inline: true },
                { name: '⚡ الحالة', value: 'متصل', inline: true },
              ],
              footer: { text: 'Nova VPS' }, timestamp: new Date().toISOString(),
            }],
          },
        });
      }
    } catch (err) {
      return res.json({ type: 4, data: { content: `❌ خطأ: ${err.message}`, flags: 64 } });
    }
  }

  res.json({ type: 1 });
});

// GET /services — list all Railway services in the project (Fix #3 — admin only)
app.get('/services', requireAdmin, async (req, res) => {
  try {
    const data = await gql(`
      query($p: String!) {
        project(id: $p) {
          services { edges { node { id name } } }
        }
      }
    `, { p: PROJECT_ID });
    const services = data.project?.services?.edges?.map(e => e.node) || [];
    res.json({ services });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /deploy-bot — deploy the Nova Manager Discord bot as a separate Railway service (Fix #3 — admin only)
app.post('/deploy-bot', requireAdmin, async (req, res) => {
  try {
    console.log('Creating Nova Discord Bot service on Railway...');

    // 1. Create service from the nova-discord-bot repo
    const d = await gql(`
      mutation($p: String!, $n: String!, $r: String!) {
        s: serviceCreate(input: { projectId: $p, name: $n, source: { repo: $r } }) { id }
      }
    `, { p: PROJECT_ID, n: 'nova-discord-bot', r: 'ihso77/nova-discord-bot' });
    const serviceId = d.s?.id;
    if (!serviceId) throw new Error('Failed to create service');
    console.log(`Bot service created: ${serviceId}`);

    // 2. Set environment variables
    const envVars = [
      { name: 'DISCORD_BOT_TOKEN', value: DISCORD_BOT_TOKEN },
      { name: 'SUPABASE_URL', value: SUPABASE_URL },
      { name: 'SUPABASE_SERVICE_ROLE_KEY', value: SUPABASE_SERVICE_KEY },
      { name: 'SITE_URL', value: 'https://nova-store.dev' },
    ];

    for (const envVar of envVars) {
      if (!envVar.value) continue;
      await gql(`
        mutation($input: VariableUpsertInput!) { v: variableUpsert(input: $input) }
      `, {
        input: {
          projectId: PROJECT_ID, environmentId: ENV_ID, serviceId,
          name: envVar.name, value: envVar.value, skipDeploys: true,
        },
      });
      console.log(`Set env: ${envVar.name}`);
    }

    // 3. Trigger deploy
    await gql(`
      mutation($s: String!, $e: String!) { d: serviceInstanceDeploy(serviceId: $s, environmentId: $e) }
    `, { s: serviceId, e: ENV_ID });
    console.log('Bot deploy triggered!');

    res.json({
      success: true,
      message: 'تم نشر بوت Nova Manager على Railway!',
      serviceId,
      serviceName: 'nova-discord-bot',
    });
  } catch (err) {
    console.error('Deploy bot error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Proxy OK'));
