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

// Paymento proxy - uses correct Paymento API (token-based flow)
app.post('/payment', async (req, res) => {
  const { amount, currency, description, success_url, cancel_url, metadata } = req.body;
  if (!amount || !success_url) return res.status(400).json({ error: 'Missing fields' });

  const PAYMENTO_API_KEY = process.env.PAYMENTO_API_KEY || 'MzFCRUEzMTk0MzVCQzRDMDg2N0ZCREFCMzQ5OTc4QzI=';
  const PAYMENTO_SECRET_KEY = process.env.PAYMENTO_SECRET_KEY || 'MzE1NERFQjM3MzcyQUREMkEwOEI2ODJGODc4RjFFQzY=';

  try {
    console.log('Payment request:', { amount, success_url });

    // Step 1: Create payment request → get token
    const paymentRes = await fetch('https://api.paymento.io/v1/payment_request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PAYMENTO_API_KEY}`,
        'X-Secret-Key': PAYMENTO_SECRET_KEY,
      },
      body: JSON.stringify({
        amount: Math.round(amount * 100), // Paymento expects amount in cents
        currency: currency || 'USD',
        description: description || 'Nova VPS subscription',
        success_url,
        cancel_url,
        metadata,
      }),
    });

    const text = await paymentRes.text();
    console.log('Paymento response status:', paymentRes.status);
    console.log('Paymento response body:', text.substring(0, 500));

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return res.status(502).json({ error: 'بوابة الدفع ردت بيانات غير صالحة', detail: text.substring(0, 200) });
    }

    if (data.error) {
      return res.status(502).json({ error: data.error });
    }

    // Paymento returns a token → redirect URL is https://app.paymento.io/gateway?token=TOKEN
    const token = data.token || data.payment_token || data.id;
    if (token) {
      const gatewayUrl = data.redirect_url || data.url || `https://app.paymento.io/gateway?token=${token}`;
      return res.json({ paymentUrl: gatewayUrl, token, raw: data });
    }

    // Fallback: maybe they returned a URL directly
    if (data.url || data.redirect_url || data.payment_url) {
      return res.json({ paymentUrl: data.url || data.redirect_url || data.payment_url, raw: data });
    }

    // Return raw response so frontend can handle it
    res.json(data);
  } catch (err) {
    console.error('Payment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok' }));

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Proxy OK'));
