const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json({ limit: '5mb' }));

const RAILWAY_API = 'https://graphql.railway.app/v2/graphql';
const RAILWAY_TOKEN = process.env.RAILWAY_API_TOKEN || '';

const HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${RAILWAY_TOKEN}`,
};

// Cache for project IDs
const projectCache = {};

async function graphql(query, variables = {}) {
  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    console.error('GraphQL Error:', JSON.stringify(json.errors));
    throw new Error(json.errors[0]?.message || 'GraphQL error');
  }
  return json.data;
}

// Get or create a project for a user
async function ensureProject(userId) {
  if (projectCache[userId]) return projectCache[userId];

  const projectName = `nova-bot-${userId.slice(0, 8)}`;

  try {
    const data = await graphql(`
      mutation($name: String!) {
        projectCreate(input: { name: $name }) {
          id
          name
        }
      }
    `, { name: projectName });

    const project = data.projectCreate;
    if (project?.id) {
      projectCache[userId] = project.id;
      return project.id;
    }
  } catch (err) {
    console.log('Project might already exist, listing...');
  }

  // Try to find existing project
  const data = await graphql(`
    query {
      me {
        projects {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }
  `);

  const projects = data.me?.projects?.edges?.map(e => e.node) || [];
  const existing = projects.find(p => p.name.includes('nova-bot'));

  if (existing) {
    projectCache[userId] = existing.id;
    return existing.id;
  }

  throw new Error('Failed to create or find project');
}

// Deploy endpoint
app.post('/deploy', async (req, res) => {
  const { botName, botToken, language, code, userId } = req.body;

  if (!botToken || !code || !language) {
    return res.status(400).json({ error: 'Missing required fields: botToken, code, language' });
  }

  try {
    const uid = userId || 'default';
    const projectId = await ensureProject(uid);

    // Create service
    console.log(`Creating service: ${botName} in project: ${projectId}`);

    const serviceName = botName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);
    const createData = await graphql(`
      mutation($projectId: ID!, $name: String!) {
        serviceCreate(input: { projectId: $projectId, name: $name }) {
          id
        }
      }
    `, { projectId, name: serviceName });

    const serviceId = createData.serviceCreate?.id;
    if (!serviceId) {
      throw new Error('Failed to create service');
    }
    console.log(`Service created: ${serviceId}`);

    // Set environment variables
    await graphql(`
      mutation($serviceId: ID!, $name: String!, $value: String!) {
        serviceVariableCreate(input: { serviceId: $serviceId, name: $name, value: $value }) {
          id
        }
      }
    `, { serviceId, name: 'DISCORD_TOKEN', value: botToken });

    // Set the bot code as env var
    await graphql(`
      mutation($serviceId: ID!, $name: String!, $value: String!) {
        serviceVariableCreate(input: { serviceId: $serviceId, name: $name, value: $value }) {
          id
        }
      }
    `, { serviceId, name: 'BOT_CODE', value: code });

    // Set language
    await graphql(`
      mutation($serviceId: ID!, $name: String!, $value: String!) {
        serviceVariableCreate(input: { serviceId: $serviceId, name: $name, value: $value }) {
          id
        }
      }
    `, { serviceId, name: 'BOT_LANGUAGE', value: language });

    // Create deployment with Dockerfile that runs the bot
    const dockerfile = language === 'python'
      ? `FROM python:3.11-slim
WORKDIR /app
RUN pip install discord.py
RUN echo "$BOT_CODE" > bot.py
CMD ["python", "bot.py"]`
      : `FROM node:20-alpine
WORKDIR /app
RUN npm init -y && npm install discord.js
RUN echo "$BOT_CODE" > bot.js
CMD ["node", "bot.js"]`;

    console.log('Creating deployment...');

    const deployData = await graphql(`
      mutation($serviceId: ID!, $dockerfile: String!) {
        deploymentCreate(input: {
          serviceId: $serviceId,
          dockerfile: $dockerfile
        }) {
          id
        }
      }
    `, { serviceId, dockerfile });

    console.log(`Deployment created: ${deployData.deploymentCreate?.id}`);

    res.json({
      success: true,
      serviceId,
      deploymentId: deployData.deploymentCreate?.id,
      message: 'Bot deployed successfully',
    });

  } catch (err) {
    console.error('Deploy error:', err);
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
      mutation($id: ID!) {
        serviceDelete(input: { id: $id }) {
          id
        }
      }
    `, { id: serviceId });

    res.json({ success: true, message: 'Service deleted' });
  } catch (err) {
    console.error('Stop error:', err);
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
