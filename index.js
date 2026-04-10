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
    const image = language === 'python' ? 'python:3.11-slim' : 'node:20-alpine';
    console.log(`Deploy: ${name} (${language})`);

    // Replace YOUR_TOKEN with real token in code
    const finalCode = code.replace(/['"]YOUR_TOKEN['"]|YOUR_TOKEN/g, botToken);
    const codeB64 = Buffer.from(finalCode).toString('base64');

    // Build start command
    let startCmd;
    if (language === 'python') {
      startCmd = `sh -c 'pip install discord.py 2>/dev/null && echo "${codeB64}" | base64 -d > bot.py && python bot.py'`;
    } else {
      startCmd = `sh -c 'npm init -y 2>/dev/null && npm install discord.js 2>/dev/null && echo "${codeB64}" | base64 -d > bot.js && node bot.js'`;
    }

    // 1. Create service
    const d = await gql(`
      mutation($p: String!, $n: String!, $i: String!) {
        s: serviceCreate(input: { projectId: $p, name: $n, source: { image: $i } }) { id }
      }
    `, { p: PROJECT_ID, n: name, i: image });
    const serviceId = d.s?.id;
    if (!serviceId) throw new Error('Failed to create service');
    console.log(`Service: ${serviceId}`);

    // 2. Set startCommand
    await gql(`
      mutation($s: String!, $e: String!, $c: String!) {
        u: serviceInstanceUpdate(serviceId: $s, environmentId: $e, input: { startCommand: $c })
      }
    `, { s: serviceId, e: ENV_ID, c: startCmd });

    // 3. Trigger deploy
    await gql(`
      mutation($p: String!, $e: String!, $s: String!) {
        d: environmentTriggersDeploy(input: { projectId: $p, environmentId: $e, serviceId: $s })
      }
    `, { p: PROJECT_ID, e: ENV_ID, s: serviceId });

    console.log(`Done: ${name}`);
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

app.get('/', (req, res) => res.json({ status: 'ok' }));

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('OK'));
