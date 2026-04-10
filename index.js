const express = require('express');
const fetch = require('node-fetch');

const app = express();

// CORS
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

const NOVA_PROJECT_ID = process.env.NOVA_PROJECT_ID || '7b4710b9-bda7-4eb5-9f46-97e70e7dcda9';
const NOVA_ENV_ID = process.env.NOVA_ENV_ID || '92d7d13d-1173-4cd0-b6e9-92fdbc1d47ae';

async function graphql(query, variables = {}) {
  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    console.error('Invalid JSON:', text.substring(0, 200));
    throw new Error('Invalid response from Railway API');
  }
  if (json.errors) {
    const errMsg = json.errors.map(e => e.message).join(', ');
    console.error('GraphQL Error:', errMsg);
    throw new Error(errMsg);
  }
  return json.data;
}

// Build Dockerfile with bot code embedded
function buildDockerfile(code, language, botToken) {
  // Replace YOUR_TOKEN placeholder in the code
  const finalCode = code.replace(/['"]YOUR_TOKEN['"]|YOUR_TOKEN/g, botToken);

  if (language === 'python') {
    return `FROM python:3.11-slim
WORKDIR /app
RUN pip install discord.py
COPY <<'BOTCODE' bot.py
${finalCode}
BOTCODE
CMD ["python", "bot.py"]`;
  }

  return `FROM node:20-alpine
WORKDIR /app
RUN npm init -y && npm install discord.js
COPY <<'BOTCODE' bot.js
${finalCode}
BOTCODE
CMD ["node", "bot.js"]`;
}

// Deploy endpoint
app.post('/deploy', async (req, res) => {
  const { botName, botToken, language, code } = req.body;

  if (!botToken || !code || !language) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const serviceName = `bot-${botName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 30)}`;
    console.log(`Creating: ${serviceName}`);

    const imageName = language === 'python' ? 'python:3.11-slim' : 'node:20-alpine';

    // 1. Create service with image source
    const createData = await graphql(`
      mutation($p: String!, $n: String!, $img: String!) {
        serviceCreate(input: { projectId: $p, name: $n, source: { image: $img } }) { id }
      }
    `, { p: NOVA_PROJECT_ID, n: serviceName, img: imageName });

    const serviceId = createData.serviceCreate?.id;
    if (!serviceId) throw new Error('Failed to create service');
    console.log(`Created: ${serviceId}`);

    // 2. Set start command - write code from base64 env var
    const escapedCode = finalCode.replace(/'/g, "'\\''");
    
    const startCmd = language === 'python'
      ? `sh -c 'echo "${Buffer.from(code.replace(/['"]YOUR_TOKEN['"]|YOUR_TOKEN/g, botToken)).toString('base64')}" | base64 -d > /app/bot.py && pip install discord.py > /dev/null 2>&1 && python /app/bot.py'`
      : `sh -c 'npm init -y > /dev/null 2>&1 && npm install discord.js > /dev/null 2>&1 && echo "${Buffer.from(code.replace(/['"]YOUR_TOKEN['"]|YOUR_TOKEN/g, botToken)).toString('base64')}" | base64 -d > /app/bot.js && node /app/bot.js'`;

    // 3. Update instance with startCommand
    await graphql(`
      mutation($sid: String!, $eid: String!, $sc: String!) {
        serviceInstanceUpdate(serviceId: $sid, environmentId: $eid, input: { startCommand: $sc })
      }
    `, { sid: serviceId, eid: NOVA_ENV_ID, sc: startCmd });

    console.log(`Instance updated`);

    // 4. Trigger deploy
    await graphql(`
      mutation($p: String!, $e: String!, $s: String!) {
        environmentTriggersDeploy(input: { projectId: $p, environmentId: $e, serviceId: $s })
      }
    `, { p: NOVA_PROJECT_ID, e: NOVA_ENV_ID, s: serviceId });

    console.log(`Deployed: ${serviceName}`);
    res.json({ success: true, serviceId, serviceName });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Stop endpoint
app.post('/stop', async (req, res) => {
  const { serviceId } = req.body;
  if (!serviceId) return res.status(400).json({ error: 'Missing serviceId' });

  try {
    await graphql(`mutation($id: String!) { serviceDelete(id: $id) }`, { id: serviceId });
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'nova-deploy-proxy' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Proxy running on ${PORT}`));
