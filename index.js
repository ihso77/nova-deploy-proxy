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

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Proxy OK'));
