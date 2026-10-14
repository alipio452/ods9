'use strict';

/* ============================================================
   AgroBot AI — backend
   - POST /api/agrobot/chat    respuesta de la IA en streaming (SSE)
   - GET  /api/agrobot/health  estado de la configuración (sin secretos)
   Sirve también el frontend (carpeta padre) para publicar todo junto.
   ============================================================ */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const express = require('express');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');
const { createProvider, mapError } = require('./providers');
const { SYSTEM_PROMPT, buildSimContext } = require('./prompt');

const LIMITS = { maxMessages: 30, maxMessageChars: 2000, maxTotalChars: 14000 };

function errBody(code, message) {
  return { error: { code, message } };
}

/** Valida y normaliza el cuerpo de la petición. */
function validateBody(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return { ok: false, message: 'Formato de solicitud no válido.' };
  }
  if (body.messages.length === 0 || body.messages.length > LIMITS.maxMessages) {
    return { ok: false, message: `La conversación debe tener entre 1 y ${LIMITS.maxMessages} mensajes.` };
  }
  const messages = [];
  let total = 0;
  for (const m of body.messages) {
    if (!m || typeof m !== 'object' || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      return { ok: false, message: 'Mensaje no válido en el historial.' };
    }
    // eslint-disable-next-line no-control-regex
    const content = m.content.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
    if (!content) return { ok: false, message: 'No se admiten mensajes vacíos.' };
    if (content.length > LIMITS.maxMessageChars) {
      return { ok: false, message: `Cada mensaje admite hasta ${LIMITS.maxMessageChars} caracteres.` };
    }
    total += content.length;
    messages.push({ role: m.role, content });
  }
  if (total > LIMITS.maxTotalChars) {
    return { ok: false, message: 'El historial es demasiado largo. Inicia una nueva conversación.' };
  }
  if (messages[messages.length - 1].role !== 'user') {
    return { ok: false, message: 'El último mensaje debe ser del usuario.' };
  }
  return { ok: true, messages, context: body.context };
}

function createApp(env = process.env) {
  const app = express();
  const provider = createProvider(env);

  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', Number(env.TRUST_PROXY) || env.TRUST_PROXY);

  const allowedOrigins = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const MAX_CONCURRENT = Math.max(1, Number(env.MAX_CONCURRENT) || 8);
  const DAILY_GLOBAL_CAP = Math.max(1, Number(env.DAILY_GLOBAL_CAP) || 1000);
  let active = 0;
  let budgetDay = new Date().toISOString().slice(0, 10);
  let budgetCount = 0;
  function takeBudget() {
    const d = new Date().toISOString().slice(0, 10);
    if (d !== budgetDay) {
      budgetDay = d;
      budgetCount = 0;
    }
    if (budgetCount >= DAILY_GLOBAL_CAP) return false;
    budgetCount++;
    return true;
  }

  /* ---------- Cabeceras básicas ---------- */
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  /* ---------- API: origen permitido + CORS restrictivo ---------- */
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) return next();
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === req.headers.host;
    } catch (_) { /* origen inválido */ }
    if (!sameOrigin && !allowedOrigins.includes(origin)) {
      return res.status(403).json(errBody('origin_not_allowed', 'Origen no permitido.'));
    }
    next();
  });
  app.use(
    '/api',
    cors({
      origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type'],
      maxAge: 600,
    })
  );
  app.use('/api', express.json({ limit: '32kb' }));

  /* ---------- Límites de uso ---------- */
  const tooMany = (message) => (req, res) => res.status(429).json(errBody('rate_limited', message));
  const perMinute = rateLimit({
    windowMs: 60 * 1000,
    limit: Math.max(1, Number(env.RATE_PER_MIN) || 10),
    standardHeaders: true,
    legacyHeaders: false,
    handler: tooMany('Demasiadas preguntas seguidas. Espera un momento e inténtalo de nuevo.'),
  });
  const perDay = rateLimit({
    windowMs: 24 * 60 * 60 * 1000,
    limit: Math.max(1, Number(env.RATE_PER_DAY) || 150),
    standardHeaders: true,
    legacyHeaders: false,
    handler: tooMany('Alcanzaste el límite diario de preguntas. Vuelve mañana.'),
  });
  const healthLimit = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    handler: tooMany('Demasiadas comprobaciones de estado.'),
  });

  /* ---------- Estado / disponibilidad del modelo ---------- */
  const modelStatus = { available: null, checkedAt: 0, checking: null };
  async function refreshModelStatus(force) {
    if (!provider.configured) return;
    if (!force && Date.now() - modelStatus.checkedAt < 10 * 60 * 1000) return;
    if (modelStatus.checking) return modelStatus.checking;
    modelStatus.checking = (async () => {
      try {
        await provider.checkModel();
        modelStatus.available = true;
      } catch (e) {
        const status = e && e.status;
        // Solo marcamos "no disponible" ante 404; otros fallos dejan el estado en desconocido.
        modelStatus.available = status === 404 ? false : null;
        console.warn('[AgroBot] No se pudo verificar el modelo:', status || (e && e.name) || 'error');
      } finally {
        modelStatus.checkedAt = Date.now();
        modelStatus.checking = null;
      }
    })();
    return modelStatus.checking;
  }

  app.get('/api/agrobot/health', healthLimit, async (req, res) => {
    await refreshModelStatus(false);
    res.json({
      ok: true,
      provider: provider.name,
      configured: provider.configured,
      model: provider.model,
      modelAvailable: provider.configured ? modelStatus.available : null,
    });
  });

  /* ---------- Chat en streaming ---------- */
  app.post('/api/agrobot/chat', perMinute, perDay, async (req, res) => {
    const v = validateBody(req.body);
    if (!v.ok) return res.status(400).json(errBody('invalid_request', v.message));

    if (!provider.configured) {
      return res.status(503).json(errBody('not_configured', 'AgroBot AI no está configurado en el servidor (falta la clave API).'));
    }
    if (active >= MAX_CONCURRENT) {
      return res.status(503).json(errBody('busy', 'AgroBot AI está atendiendo muchas consultas. Inténtalo en unos segundos.'));
    }
    if (!takeBudget()) {
      return res.status(429).json(errBody('budget', 'Se alcanzó el límite diario de consultas del servicio.'));
    }

    active++;
    const ac = new AbortController();
    let started = false;
    let finished = false;
    res.on('close', () => {
      if (!finished) ac.abort(); // el usuario canceló o cerró la página
    });

    const send = (event, data) => {
      if (!started) {
        started = true;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        if (res.flushHeaders) res.flushHeaders();
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const system = SYSTEM_PROMPT + buildSimContext(v.context);
      const result = await provider.stream({
        system,
        messages: v.messages,
        signal: ac.signal,
        onText: (text) => {
          if (text) send('delta', { text });
        },
      });
      if (!started) send('delta', { text: '' });
      send('done', { truncated: !!(result && result.truncated) });
    } catch (e) {
      if (!ac.signal.aborted) {
        const m = mapError(e);
        // Solo estado y código: nunca el contenido de la conversación ni claves.
        console.error('[AgroBot] Error del proveedor:', e && (e.status || e.code || e.name));
        if (!started) {
          finished = true;
          res.status(m.status).json(errBody(m.code, m.message));
        } else {
          send('error', { code: m.code, message: m.message });
        }
      }
    } finally {
      active--;
      finished = true;
      if (!res.writableEnded) res.end();
    }
  });

  app.use('/api', (req, res) => res.status(404).json(errBody('not_found', 'Ruta no encontrada.')));

  /* ---------- Frontend estático (sin exponer /server ni archivos ocultos) ---------- */
  // Busca automáticamente la carpeta que contiene index.html (estructura con /server o plana).
  const fs = require('fs');
  const candidates = [env.STATIC_DIR, path.join(__dirname, '..'), __dirname, process.cwd()]
    .filter(Boolean)
    .map((d) => path.resolve(d));
  const staticRoot = candidates.find((d) => fs.existsSync(path.join(d, 'index.html'))) || candidates[0];
  const PRIVATE_FILES = new Set(['/server.js', '/providers.js', '/prompt.js', '/package.json', '/package-lock.json']);
  app.use((req, res, next) => {
    let p;
    try {
      p = decodeURIComponent(req.path).toLowerCase();
    } catch (_) {
      return res.status(400).end();
    }
    if (p.startsWith('/server') || p.startsWith('/node_modules') || p.startsWith('/test') || PRIVATE_FILES.has(p) || p.split('/').some((s) => s.startsWith('.'))) {
      return res.status(404).end();
    }
    next();
  });
  app.use(express.static(staticRoot, { dotfiles: 'ignore', index: 'index.html' }));

  app.locals.provider = provider;
  app.locals.refreshModelStatus = refreshModelStatus;
  return app;
}

module.exports = { createApp, validateBody, LIMITS };

if (require.main === module) {
  const app = createApp(process.env);
  const provider = app.locals.provider;
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`AGRO RAIN 3D + AgroBot AI en http://localhost:${port}`);
    if (provider.unknown) {
      console.warn(`[AgroBot] AI_PROVIDER="${provider.name}" no es válido. Usa "openai" o "anthropic".`);
    } else if (!provider.configured) {
      console.warn(`[AgroBot] Falta la clave API de ${provider.name} (variable de entorno). El chat responderá "no configurado".`);
    } else {
      console.log(`[AgroBot] Proveedor: ${provider.name} · modelo: ${provider.model}`);
      app.locals.refreshModelStatus(true).then(() => {
        console.log('[AgroBot] Verificación del modelo terminada. Consulta /api/agrobot/health.');
      });
    }
  });
}
