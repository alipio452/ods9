'use strict';

/* ============================================================
   AgroBot AI — proveedores de IA
   OpenAI (SDK oficial + Responses API) o Anthropic (SDK oficial).
   La clave solo se lee de variables de entorno del servidor.
   ============================================================ */

function createProvider(env = process.env) {
  const name = String(env.AI_PROVIDER || 'openrouter').toLowerCase();
  const maxOut = Math.max(200, Number(env.MAX_OUTPUT_TOKENS) || 1500);
  const timeoutMs = Math.max(5000, Number(env.AI_TIMEOUT_MS) || 60000);

  if (name === 'openai') {
    const apiKey = env.OPENAI_API_KEY;
    const model = env.OPENAI_MODEL || 'gpt-4.1-mini';
    let client = null;
    if (apiKey) {
      const OpenAI = require('openai');
      client = new OpenAI({
        apiKey,
        baseURL: env.OPENAI_BASE_URL || undefined,
        maxRetries: 1,
        timeout: timeoutMs,
      });
    }
    return {
      name,
      model,
      configured: !!client,
      async checkModel() {
        await client.models.retrieve(model);
      },
      async stream({ system, messages, signal, onText }) {
        const stream = await client.responses.create(
          {
            model,
            instructions: system,
            input: messages.map((m) => ({ role: m.role, content: m.content })),
            max_output_tokens: maxOut,
            store: false, // no se conserva la conversación en el proveedor
            stream: true,
          },
          { signal }
        );
        let truncated = false;
        for await (const ev of stream) {
          if (ev.type === 'response.output_text.delta') {
            onText(ev.delta);
          } else if (ev.type === 'response.incomplete') {
            truncated = true;
          } else if (ev.type === 'response.failed') {
            const e = new Error('response.failed');
            e.code = ev.response && ev.response.error && ev.response.error.code;
            throw e;
          } else if (ev.type === 'error') {
            const e = new Error('stream error');
            e.code = ev.code;
            throw e;
          }
        }
        return { truncated };
      },
    };
  }

  if (name === 'openrouter') {
    // OpenRouter es compatible con el SDK de OpenAI (Chat Completions).
    const apiKey = String(env.OPENROUTER_API_KEY || env.AI_API_KEY || '').trim().replace(/^["']|["']$/g, '');
    const model = env.AI_MODEL || 'openrouter/free';
    let client = null;
    if (apiKey) {
      const OpenAI = require('openai');
      client = new OpenAI({
        apiKey,
        baseURL: env.AI_BASE_URL || 'https://openrouter.ai/api/v1',
        maxRetries: 1,
        timeout: timeoutMs,
        defaultHeaders: { 'X-Title': 'AGRO RAIN 3D' },
      });
    }
    return {
      name,
      model,
      configured: !!client,
      async checkModel() {}, // OpenRouter no expone models.retrieve igual que OpenAI
      async stream({ system, messages, signal, onText }) {
        const stream = await client.chat.completions.create(
          {
            model,
            max_tokens: maxOut,
            stream: true,
            messages: [
              { role: 'system', content: system },
              ...messages.map((m) => ({ role: m.role, content: m.content })),
            ],
          },
          { signal }
        );
        let truncated = false;
        for await (const chunk of stream) {
          if (chunk && chunk.error) {
            const e = new Error('stream error');
            e.status = chunk.error.code;
            throw e;
          }
          const choice = chunk.choices && chunk.choices[0];
          if (!choice) continue;
          const t = choice.delta && choice.delta.content;
          if (t) onText(t);
          if (choice.finish_reason === 'length') truncated = true;
        }
        return { truncated };
      },
    };
  }

  if (name === 'anthropic') {
    const apiKey = env.ANTHROPIC_API_KEY;
    const model = env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
    let client = null;
    if (apiKey) {
      const Anthropic = require('@anthropic-ai/sdk');
      client = new Anthropic({
        apiKey,
        baseURL: env.ANTHROPIC_BASE_URL || undefined,
        maxRetries: 1,
        timeout: timeoutMs,
      });
    }
    return {
      name,
      model,
      configured: !!client,
      async checkModel() {
        await client.models.retrieve(model);
      },
      async stream({ system, messages, signal, onText }) {
        const stream = client.messages.stream(
          {
            model,
            max_tokens: maxOut,
            system,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
          },
          { signal }
        );
        stream.on('text', (t) => onText(t));
        const final = await stream.finalMessage();
        return { truncated: final.stop_reason === 'max_tokens' };
      },
    };
  }

  // Proveedor desconocido: queda "sin configurar" y el health lo indica.
  return {
    name,
    model: null,
    configured: false,
    unknown: true,
    async checkModel() {},
    async stream() {
      throw new Error('Proveedor no soportado');
    },
  };
}

/** Traduce errores del proveedor a mensajes seguros (sin filtrar claves ni texto crudo). */
function mapError(e) {
  const status = e && (e.status || e.statusCode);
  const n = e && e.name;
  if (status === 401 || status === 403) {
    return { status: 502, code: 'auth', message: 'El servidor no pudo autenticarse con el proveedor de IA (clave rechazada o sin permisos). Revisa la clave API del servidor.' };
  }
  if (status === 404) {
    return { status: 502, code: 'model_unavailable', message: 'El modelo configurado no está disponible para esta cuenta. Revisa el nombre del modelo en el servidor.' };
  }
  if (status === 429) {
    return { status: 429, code: 'provider_quota', message: 'El proveedor de IA reporta límite de uso o saldo agotado. Inténtalo de nuevo en un momento.' };
  }
  if (status === 400 || status === 422) {
    return { status: 502, code: 'provider_bad_request', message: 'El proveedor de IA rechazó la solicitud. Prueba con una pregunta más corta o nueva conversación.' };
  }
  if (n === 'APIConnectionTimeoutError') {
    return { status: 504, code: 'timeout', message: 'El proveedor de IA tardó demasiado en responder.' };
  }
  if (n === 'APIConnectionError') {
    return { status: 502, code: 'network', message: 'No se pudo conectar con el proveedor de IA.' };
  }
  return { status: 502, code: 'provider_error', message: 'El proveedor de IA devolvió un error. Inténtalo de nuevo.' };
}

module.exports = { createProvider, mapError };
