const express = require('express');
const fetch = require('node-fetch');

const app = express();

// CORS - allow all origins
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
    console.error('Invalid JSON response:', text.substring(0, 200));
    throw new Error('Invalid response from Railway API');
  }
  if (json.errors) {
    const errMsg = json.errors.map(e => e.message).join(', ');
    console.error('GraphQL Error:', errMsg);
    throw new Error(errMsg);
  }
  return json.data;
}

// Deploy endpoint
app.post('/deploy', async (req, res) => {
  const { botName, botToken, language, code } = req.body;

  if (!botToken || !code || !language) {
    return res.status(400).json({ error: 'Missing required fields: botToken, code, language' });
  }

  try {
    // Create service with image source
    const serviceName = `bot-${botName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 30)}`;
    console.log(`[v3] Creating service: ${serviceName}`);

    const imageName = language === 'python' ? 'python:3.11-slim' : 'node:20-alpine';

    const createData = await graphql(`
      mutation($projectId: String!, $name: String!, $image: String!) {
        serviceCreate(input: {
          projectId: $projectId,
          name: $name,
          source: { image: $image }
        }) {
          id
        }
      }
    `, { projectId: NOVA_PROJECT_ID, name: serviceName, image: imageName });

    const serviceId = createData.serviceCreate?.id;
    if (!serviceId) {
      throw new Error('Failed to create service');
    }
    console.log(`[v3] Service created: ${serviceId}`);
    console.log(`[v3] Setting env vars...`);

    // Encode bot code as base64
    const codeB64 = Buffer.from(code).toString('base64');

    // Set environment variables
    await graphql(`
      mutation($projectId: String!, $environmentId: String!, $serviceId: String!, $name: String!, $value: String!) {
        variableUpsert(input: {
          projectId: $projectId,
          environmentId: $environmentId,
          serviceId: $serviceId,
          name: $name,
          value: $value,
          skipDeploys: true
        })
      }
    `, { projectId: NOVA_PROJECT_ID, environmentId: NOVA_ENV_ID, serviceId, name: 'DISCORD_TOKEN', value: botToken });

    await graphql(`
      mutation($projectId: String!, $environmentId: String!, $serviceId: String!, $name: String!, $value: String!) {
        variableUpsert(input: {
          projectId: $projectId,
          environmentId: $environmentId,
          serviceId: $serviceId,
          name: $name,
          value: $value,
          skipDeploys: true
        })
      }
    `, { projectId: NOVA_PROJECT_ID, environmentId: NOVA_ENV_ID, serviceId, name: 'BOT_CODE_B64', value: codeB64 });

    // Set start command based on language
    const startCmd = language === 'python'
      ? 'sh -c \'echo "$BOT_CODE_B64" | base64 -d > bot.py && pip install discord.py -q && python bot.py\''
      : 'sh -c \'echo "$BOT_CODE_B64" | base64 -d > bot.js && npm init -y -q 2>/dev/null && npm install discord.js -q 2>/dev/null && node bot.js\'';

    console.log(`[v3] Env vars set. Updating service instance with startCommand...`);
    console.log(`[v3] startCommand: ${startCmd.substring(0, 60)}...`);

    // Update service instance with start command
    const updateResult = await graphql(`
      mutation($serviceId: String!, $environmentId: String!, $startCommand: String!) {
        serviceInstanceUpdate(
          serviceId: $serviceId,
          environmentId: $environmentId,
          input: {
            startCommand: $startCommand
          }
        )
      }
    `, { serviceId, environmentId: NOVA_ENV_ID, startCommand: startCmd });
    console.log(`[v3] Service instance update result:`, updateResult);
    res.json({
      success: true,
      serviceId,
      message: 'Bot deployed to Railway',
      serviceName,
    });

  } catch (err) {
    console.error('Deploy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Stop endpoint
app.post('/stop', async (req, res) => {
  const { serviceId } = req.body;

  if (!serviceId) {
    return res.status(400).json({ error: 'Missing serviceId' });
  }

  try {
    await graphql(`
      mutation($id: String!) {
        serviceDelete(id: $id)
      }
    `, { id: serviceId });

    res.json({ success: true, message: 'Bot service deleted' });
  } catch (err) {
    console.error('Stop error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'nova-deploy-proxy' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Nova Deploy Proxy running on port ${PORT}`);
});
