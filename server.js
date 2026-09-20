// server.js - OpenAI to NVIDIA NIM Proxy
// Nemotron 3 Ultra 550B - JanitorAI compatible

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// NVIDIA NIM configuration
const NIM_API_BASE =
  process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';

const NIM_API_KEY = process.env.NIM_API_KEY;

// Force every request to Nemotron 3 Ultra.
const NIM_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';


// --------------------------------------------------
// ROLEPLAY AGENCY FILTER
// --------------------------------------------------

// This is retained from the original proxy.
// It attempts to stop the model from generating a separate
// User/Human/Player turn after its own response.

function stripUserBreakout(text) {
  if (!text) return '';

  const lines = text.split('\n');
  const cleaned = [];
  let dropping = false;

  const userLabels = [
    /^(User|Human|You|Me|Player)\s*[:：]/i,
    /^---+\s*$/,
    /^\*{0,3}\s*(User|Human|You|Me|Player)\s*\*{0,3}\s*[:：]/i
  ];

  for (const line of lines) {
    const trimmed = line.trim();

    if (userLabels.some(pattern => pattern.test(trimmed))) {
      dropping = true;
      continue;
    }

    if (dropping) {
      if (trimmed === '') continue;

      if (trimmed.startsWith('*')) {
        dropping = false;
        cleaned.push(line);
      }

      continue;
    }

    cleaned.push(line);
  }

  const result = cleaned.join('\n');

  const lastUserLabel = result.search(
    /\n(?:User|Human|You|Me|Player)\s*[:：]/i
  );

  if (lastUserLabel !== -1) {
    return result.substring(0, lastUserLabel).trimEnd();
  }

  return result.trimEnd();
}


// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy (Nemotron 3 Ultra)',
    nim_api_configured: !!NIM_API_KEY,
    forced_model: NIM_MODEL
  });
});


// --------------------------------------------------
// ROOT
// --------------------------------------------------

app.get('/', (req, res) => {
  res.json({
    service: 'OpenAI to NVIDIA NIM Proxy',
    version: '3.0-nemotron',
    status: 'running',
    forced_model: NIM_MODEL,
    endpoints: {
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions'
    }
  });
});


// --------------------------------------------------
// OPENAI-COMPATIBLE MODEL LIST
// --------------------------------------------------

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: 'nemotron',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'nvidia',
        nim_model: NIM_MODEL
      },
      {
        id: NIM_MODEL,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'nvidia',
        nim_model: NIM_MODEL
      },
      {
        // Some OpenAI-compatible clients expect a familiar model name.
        // This alias still routes to Nemotron.
        id: 'gpt-4',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'nvidia-proxy',
        nim_model: NIM_MODEL
      }
    ]
  });
});


// --------------------------------------------------
// CHAT COMPLETIONS
// --------------------------------------------------

app.post('/v1/chat/completions', async (req, res) => {
  try {

    if (!NIM_API_KEY) {
      return res.status(500).json({
        error: {
          message:
            'NIM_API_KEY is not configured. Add your NVIDIA API key to the Render environment variables.',
          type: 'configuration_error',
          code: 500
        }
      });
    }

    const {
      messages,
      temperature,
      max_tokens,
      stream
    } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({
        error: {
          message: 'messages is required and must be an array',
          type: 'invalid_request_error',
          code: 400
        }
      });
    }

    // IMPORTANT:
    // We deliberately DO NOT inject another system prompt here.
    //
    // Janitor's existing system prompt, character definition,
    // advanced prompt, chat history, etc. are passed through unchanged.

    const nimRequest = {
      model: NIM_MODEL,
      messages: messages,
      temperature: temperature ?? 1,
      max_tokens: max_tokens ?? 12000,
      stream: stream ?? false
    };

    console.log(
      `➡️ Request → ${NIM_MODEL} | messages: ${messages.length} | stream: ${!!stream}`
    );

    const response = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      nimRequest,
      {
        headers: {
          Authorization: `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: stream ? 'stream' : 'json'
      }
    );


    // --------------------------------------------------
    // STREAMING RESPONSE
    // --------------------------------------------------

    if (stream) {

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '';
      let contentAccumulator = '';
      let flushedUpTo = 0;

      // Hold a small amount of text so the agency filter has
      // enough context to catch an unwanted User: continuation.
      const LOOKAHEAD = 200;

      response.data.on('data', chunk => {

        buffer += chunk.toString();

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {

          if (!line.startsWith('data: ')) {
            continue;
          }

          if (line.includes('[DONE]')) {

            if (contentAccumulator.length > flushedUpTo) {

              const remaining = stripUserBreakout(
                contentAccumulator.substring(flushedUpTo)
              );

              if (remaining.length > 0) {

                const finalChunk = {
                  choices: [
                    {
                      delta: {
                        content: remaining
                      },
                      index: 0
                    }
                  ]
                };

                res.write(
                  `data: ${JSON.stringify(finalChunk)}\n\n`
                );
              }
            }

            res.write('data: [DONE]\n\n');
            continue;
          }

          try {

            const data = JSON.parse(line.slice(6));

            const content =
              data.choices?.[0]?.delta?.content || '';

            if (content) {

              contentAccumulator += content;

              const filtered =
                stripUserBreakout(contentAccumulator);

              const safeEnd = Math.max(
                flushedUpTo,
                filtered.length - LOOKAHEAD
              );

              if (safeEnd > flushedUpTo) {

                const toSend =
                  filtered.substring(flushedUpTo, safeEnd);

                flushedUpTo = safeEnd;

                data.choices[0].delta.content = toSend;

                res.write(
                  `data: ${JSON.stringify(data)}\n\n`
                );
              }

            } else {

              // Preserve OpenAI-compatible metadata chunks.
              res.write(
                `data: ${JSON.stringify(data)}\n\n`
              );
            }

          } catch (error) {

            console.warn(
              'Could not parse streaming chunk:',
              error.message
            );
          }
        }
      });

      response.data.on('end', () => {
        res.end();
      });

      response.data.on('error', error => {
        console.error('NVIDIA stream error:', error.message);

        if (!res.writableEnded) {
          res.end();
        }
      });

      return;
    }


    // --------------------------------------------------
    // NON-STREAMING RESPONSE
    // --------------------------------------------------

    const choices = (response.data.choices || []).map(choice => {

      const content =
        stripUserBreakout(choice.message?.content || '');

      return {
        index: choice.index ?? 0,
        message: {
          role: choice.message?.role || 'assistant',
          content: content
        },
        finish_reason: choice.finish_reason || null
      };
    });

    res.json({
      id: response.data.id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created:
        response.data.created ||
        Math.floor(Date.now() / 1000),
      model: NIM_MODEL,
      choices: choices,
      usage: response.data.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    });

  } catch (error) {

    console.error(
      '❌ NVIDIA proxy error:',
      error.response?.data || error.message
    );

    const status =
      error.response?.status || 500;

    let errorMessage =
      error.response?.data?.error?.message ||
      error.response?.data?.detail ||
      error.message ||
      'Internal proxy error';

    if (status === 401) {
      errorMessage =
        'NVIDIA rejected the API key. Check NIM_API_KEY in Render.';
    }

    if (status === 429) {
      errorMessage =
        'NVIDIA/Nemotron is currently rate limited. Try again shortly.';

      res.setHeader(
        'Retry-After',
        error.response?.headers?.['retry-after'] || '60'
      );
    }

    res.status(status).json({
      error: {
        message: errorMessage,
        type: 'invalid_request_error',
        code: status
      }
    });
  }
});


// --------------------------------------------------
// UNSUPPORTED ENDPOINTS
// --------------------------------------------------

app.all('*', (req, res) => {

  res.status(404).json({
    error: {
      message:
        `Endpoint ${req.path} not found. ` +
        'Available endpoints: /health, /v1/models, /v1/chat/completions',
      type: 'invalid_request_error',
      code: 404
    }
  });

});


// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, '0.0.0.0', () => {

  console.log('════════════════════════════════════════════');
  console.log('🚀 NVIDIA NIM → OpenAI Proxy');
  console.log('🎯 Nemotron 3 Ultra 550B');
  console.log('════════════════════════════════════════════');
  console.log(`📡 Port: ${PORT}`);
  console.log(`🤖 Model: ${NIM_MODEL}`);
  console.log(
    `🔑 NVIDIA API key: ${
      NIM_API_KEY ? 'Configured' : 'MISSING'
    }`
  );
  console.log('🧠 Extra RP prompt injection: DISABLED');
  console.log('════════════════════════════════════════════');

});
