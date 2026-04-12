const express = require('express');
const fetch = require('node-fetch');

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '5mb' }));

const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';
const RAILWAY_TOKEN = process.env.RAILWAY_API_TOKEN || '';

const HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${RAILWAY_TOKEN}`,
};

const PROJECT_ID = process.env.NOVA_PROJECT_ID || '7b4710b9-bda7-4eb5-9f46-97e70e7dcda9';
const ENV_ID = process.env.NOVA_ENV_ID || '92d7d13d-1173-4cd0-b6e9-92fdbc1d47ae';

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

app.post('/deploy', async (req, res) => {
  const { botName, botToken, language, code } = req.body;
  if (!botToken || !code || !language) return res.status(400).json({ error: 'Missing fields' });

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
    res.status(500).json({ error: err.message });
  }
});

app.post('/stop', async (req, res) => {
  const { serviceId } = req.body;
  if (!serviceId) return res.status(400).json({ error: 'Missing serviceId' });
  try {
    await gql(`mutation($id: String!) { serviceDelete(id: $id) }`, { id: serviceId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// Paymento proxy - correct API format per docs.paymento.io
// POST /payment — create payment request → returns token + gateway URL
app.post('/payment', async (req, res) => {
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

  const PAYMENTO_API_KEY = process.env.PAYMENTO_API_KEY || 'MzFCRUEzMTk0MzVCQzRDMDg2N0ZCREFCMzQ5OTc4QzI=';
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mmvdflwchecvzxzsumlm.supabase.co';
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

  try {
    // SECURITY: Verify price from server if planId provided
    let verifiedAmount = parsedAmount;

    if (planId && SUPABASE_ANON_KEY) {
      try {
        const planRes = await fetch(`${SUPABASE_URL}/rest/v1/plans?id=eq.${planId}&select=price,name`, {
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          },
        });
        if (planRes.ok) {
          const planData = await planRes.json();
          if (planData && planData.length > 0) {
            const serverPrice = parseFloat(planData[0].price);
            if (Math.abs(serverPrice - parsedAmount) > 0.01) {
              // Client sent wrong price — use server price
              console.warn('Price mismatch: client sent', parsedAmount, 'server has', serverPrice);
              verifiedAmount = serverPrice;
            }
          }
        }
      } catch (e) {
        // If plan lookup fails, continue with client amount
        console.warn('Plan price lookup failed, using client amount:', e.message);
      }
    }

    console.log('Payment request:', { verifiedAmount, currency, orderId, returnUrl });

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
      console.error('No token in Paymento response:', JSON.stringify(data));
      return res.status(502).json({ error: 'لم يتم استلام رمز الدفع من بوابة الدفع', raw: data });
    }

    // Build redirect URL
    const gatewayUrl = `https://app.paymento.io/gateway?token=${token}`;

    console.log('Payment created successfully, token:', token);
    res.json({ url: gatewayUrl, token, orderId });
  } catch (err) {
    console.error('Payment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Paymento verify - verify payment status after redirect
// POST /verify — confirm payment was actually completed
app.post('/verify', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const PAYMENTO_API_KEY = process.env.PAYMENTO_API_KEY || 'MzFCRUEzMTk0MzVCQzRDMDg2N0ZCREFCMzQ5OTc4QzI=';

  try {
    console.log('Verify payment, token:', token);

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

    res.json({
      paid: isPaid,
      status: statusName,
      statusCode,
      orderId: result.orderId,
      token: result.token || token,
      raw: result,
    });
  } catch (err) {
    console.error('Verify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Discord username availability checker proxy
// Uses Discord's registration endpoint to check usernames without auth
// Logic: if register returns USERNAME_ALREADY_TAKEN → unavailable, otherwise → available
app.get('/discord-check', async (req, res) => {
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
    res.status(500).json({ error: 'Failed to check username', details: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok' }));

// ============================================================
// Discord Bot Management Endpoints
// ============================================================
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mmvdflwchecvzxzsumlm.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

async function discordAPI(path, method = 'GET', body = null) {
  if (!DISCORD_BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN not configured');
  const opts = {
    method,
    headers: {
      'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'NovaManagerBot (https://novavps.app, 1.0)',
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

// GET /bot/info — bot info + guilds
app.get('/bot/info', async (req, res) => {
  try {
    const me = await discordAPI('/users/@me');
    const guilds = await discordAPI('/users/@me/guilds');
    res.json({
      bot: { id: me.id, username: me.username, discriminator: me.discriminator, avatar: me.avatar },
      guilds_count: guilds.length,
      guilds: guilds.map(g => ({ id: g.id, name: g.name, icon: g.icon })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /bot/guilds/:guildId/channels — text channels in a guild
app.get('/bot/guilds/:guildId/channels', async (req, res) => {
  try {
    const channels = await discordAPI(`/guilds/${req.params.guildId}/channels`);
    const textChannels = channels.filter(c => c.type === 0).map(c => ({ id: c.id, name: c.name }));
    res.json({ channels: textChannels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /bot/commands/register — register slash commands + set interaction endpoint URL
app.post('/bot/commands/register', async (req, res) => {
  try {
    const me = await discordAPI('/users/@me');
    const appId = me.id;
    const commands = [
      {
        name: 'prices', description: 'عرض باقات Nova VPS', type: 1,
        options: [{ name: 'channel', description: 'الروم (افتراضي: الحالي)', type: 7, required: false }],
      },
      { name: 'serverinfo', description: 'معلومات السيرفر', type: 1 },
      { name: 'stats', description: 'إحصائيات Nova VPS', type: 1 },
      {
        name: 'announce', description: 'إرسال إعلان', type: 1,
        options: [
          { name: 'message', description: 'محتوى الإعلان', type: 3, required: true },
          { name: 'channel', description: 'الروم (افتراضي: الحالي)', type: 7, required: false },
        ],
      },
      { name: 'status', description: 'حالة خدمات Nova VPS', type: 1 },
    ];
    const result = await discordAPI(`/applications/${appId}/commands`, 'PUT', commands);

    // Also set the interaction endpoint URL so Discord forwards slash commands here
    const proxyUrl = process.env.PUBLIC_URL || `https://proxy-production-a7b5.up.railway.app`;
    try {
      await discordAPI(`/applications/${appId}/interactions-endpoint-url`, 'PATCH', {
        interactions_endpoint_url: `${proxyUrl}/bot/interactions`,
      });
    } catch (urlErr) {
      console.warn('Failed to set interaction URL:', urlErr.message);
      // Don't fail the whole request — commands are still registered
    }

    res.json({ success: true, message: `تم تسجيل ${result.length} أمر`, commands: result.map(c => c.name) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /bot/send-prices — send plans embed to a channel
app.post('/bot/send-prices', async (req, res) => {
  try {
    const { channel_id } = req.body;
    if (!channel_id) return res.status(400).json({ error: 'channel_id required' });
    const plans = await supabaseQuery('plans', '?is_active=eq.true&order=sort_order');
    const fields = plans.map(p => ({
      name: `${p.is_free ? '🎁' : '⭐'} ${p.name}`,
      value: [
        `💰 ${p.price === 0 ? '**مجاني**' : `**$${p.price}/شهر**`}`,
        `💾 ${p.storage_mb >= 1024 ? `${p.storage_mb / 1024}GB` : `${p.storage_mb}MB`}`,
        `🧠 ${p.ram_mb >= 1024 ? `${p.ram_mb / 1024}GB` : `${p.ram_mb}MB`}`,
        `⚡ ${p.cpu_cores} نواة`,
      ].join('\n'),
      inline: true,
    }));
    await discordAPI(`/channels/${channel_id}/messages`, 'POST', {
      embeds: [{
        title: '🚀 Nova VPS - باقات الاستضافة',
        description: '🔗 **[اشترك الآن](https://novavps.app/plans)**',
        color: 0x8B5CF6, fields, footer: { text: 'Nova VPS' }, timestamp: new Date().toISOString(),
      }],
    });
    res.json({ success: true, message: 'تم إرسال الأسعار' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /bot/announce — send announcement embed
app.post('/bot/announce', async (req, res) => {
  try {
    const { channel_id, message } = req.body;
    if (!channel_id || !message) return res.status(400).json({ error: 'channel_id and message required' });
    await discordAPI(`/channels/${channel_id}/messages`, 'POST', {
      embeds: [{
        title: '📢 إعلان من Nova VPS', description: message, color: 0x8B5CF6,
        footer: { text: 'Nova VPS' }, timestamp: new Date().toISOString(),
      }],
    });
    res.json({ success: true, message: 'تم إرسال الإعلان' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /bot/stats — get platform stats
app.get('/bot/stats', async (req, res) => {
  try {
    const [users, projects, subs] = await Promise.all([
      supabaseCount('profiles'),
      supabaseCount('projects'),
      supabaseCount('subscriptions', '?status=eq.active'),
    ]);
    res.json({ users, projects, active_subscriptions: subs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /bot/setup — auto-setup: register commands + set interaction endpoint URL
app.post('/bot/setup', async (req, res) => {
  try {
    const me = await discordAPI('/users/@me');
    const appId = me.id;
    const proxyUrl = process.env.PUBLIC_URL || `https://proxy-production-a7b5.up.railway.app`;
    const endpointUrl = `${proxyUrl}/bot/interactions`;

    // 1. Register slash commands
    const commands = [
      {
        name: 'prices', description: 'عرض باقات Nova VPS', type: 1,
        options: [{ name: 'channel', description: 'الروم (افتراضي: الحالي)', type: 7, required: false }],
      },
      { name: 'serverinfo', description: 'معلومات السيرفر', type: 1 },
      { name: 'stats', description: 'إحصائيات Nova VPS', type: 1 },
      {
        name: 'announce', description: 'إرسال إعلان', type: 1,
        options: [
          { name: 'message', description: 'محتوى الإعلان', type: 3, required: true },
          { name: 'channel', description: 'الروم (افتراضي: الحالي)', type: 7, required: false },
        ],
      },
      { name: 'status', description: 'حالة خدمات Nova VPS', type: 1 },
    ];
    const cmdResult = await discordAPI(`/applications/${appId}/commands`, 'PUT', commands);

    // 2. Set interaction endpoint URL
    await discordAPI(`/applications/${appId}/interactions-endpoint-url`, 'PATCH', {
      interactions_endpoint_url: endpointUrl,
    });

    res.json({
      success: true,
      message: 'تم إعداد البوت بنجاح!',
      bot: me.username,
      commands_registered: cmdResult.length,
      endpoint_url: endpointUrl,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /bot/interactions — Discord webhook for slash commands
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
        await discordAPI(`/channels/${channelId}/messages`, 'POST', {
          embeds: [{
            title: '🚀 Nova VPS - باقات الاستضافة',
            description: '🔗 **[اشترك الآن](https://novavps.app/plans)**',
            color: 0x8B5CF6,
            fields: [
              { name: '🎁 مجاني', value: '💾 500MB\n🧠 256MB\n⚡ 1 نواة', inline: true },
              { name: '⭐ بيزك', value: '💰 $2/شهر\n💾 2GB\n🧠 512MB', inline: true },
              { name: '💎 برو', value: '💰 $5/شهر\n💾 5GB\n🧠 1GB', inline: true },
            ],
            footer: { text: 'Nova VPS' }, timestamp: new Date().toISOString(),
          }],
        });
        return res.json({ type: 4, data: { content: '✅ تم إرسال الأسعار!', flags: 64 } });
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
                { name: '🌐 الموقع', value: '[novavps.app](https://novavps.app)', inline: true },
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

// POST /deploy-bot — deploy the Nova Manager Discord bot as a separate Railway service
app.post('/deploy-bot', async (req, res) => {
  try {
    if (!RAILWAY_TOKEN) return res.status(500).json({ error: 'Railway token not configured' });
    if (!DISCORD_BOT_TOKEN) return res.status(500).json({ error: 'Discord bot token not configured' });

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
      { name: 'SITE_URL', value: 'https://novavps.app' },
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
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Proxy OK'));
