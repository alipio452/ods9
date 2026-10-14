/* ============================================================
   AGRO RAIN 3D — AgroBot AI (frontend)
   Cliente de la IA agrícola real. Se comunica con el backend
   (/api/agrobot/chat) por streaming; la clave API nunca llega
   al navegador. Es independiente del bucle de render 3D: solo
   usa fetch asíncrono y actualiza el DOM del panel.

   Montaje:
   - Si existe #agrobot-section (o #agrobot, #agrobot-ai,
     [data-agrobot]) se incrusta ahí, reemplazando su contenido.
   - Si no, aparece un botón flotante que abre un panel lateral.

   Configuración opcional (antes de cargar este script):
     window.AGRO_BOT_CONFIG = { apiUrl: 'https://mi-backend.com' };
   ============================================================ */

window.AGRO = window.AGRO || {};

AGRO.Bot = (function () {
  'use strict';

  const CFG = Object.assign({ apiUrl: '', maxHistory: 12, maxChars: 2000 }, window.AGRO_BOT_CONFIG || {});
  const API = String(CFG.apiUrl || '').replace(/\/+$/, '');
  const HOST_SELECTORS = ['#agrobot-section', '#agrobot', '#agrobot-ai', '#agrobot-panel', '[data-agrobot]'];

  const SUGGESTIONS = [
    { icon: '🍅', text: '¿Cómo cultivo tomates? Cuéntame riego, luz y suelo.' },
    { icon: '🌽', text: 'Las hojas de mi maíz se están poniendo amarillas, ¿qué puede ser?' },
    { icon: '🌧️', text: '¿Cuánta agua de lluvia puedo recolectar con un techo de 40 m²?' },
    { icon: '🛰️', text: 'Analiza el estado actual de mi simulación y dime qué ajustarías.' },
  ];

  let root = null;
  let launcher = null;
  let refs = {};
  let messages = []; // historial real enviado al modelo: { role, content }
  let busy = false;
  let controller = null;
  let stick = true;
  let healthChecked = false;
  let inline = false;

  /* ---------- Utilidades ---------- */
  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------- Markdown seguro (escapa primero, luego formatea) ---------- */
  function inlineMd(s) {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');
    t = t.replace(/\((estimaci[oó]n|dato estimado|confirmado|dato confirmado)\)/gi, (m, w) => {
      const est = /estim/i.test(w);
      return '<span class="ab-tag ' + (est ? 'est' : 'ok') + '">' + (est ? 'estimación' : 'confirmado') + '</span>';
    });
    return t;
  }

  const CARD_ICONS = [
    [/en agro rain|simulaci|tanque|sensor|automatiz|sistema/i, '🛰️'],
    [/plaga|enfermed|s[ií]ntoma|prevenci|diagn[oó]st|causa/i, '🐛'],
    [/riego|agua|hidr/i, '💧'],
    [/luz|temperatura|clima|sol\b/i, '☀️'],
    [/suelo|nutrient|fertiliz|abono|ph\b/i, '🪴'],
    [/espacio|crecimiento|tama[ñn]o|ra[ií]c|distancia/i, '📏'],
    [/siembra|cosecha|poda|propag|trasplante/i, '🧺'],
    [/recomend|pr[aá]ctic|consejo|resumen|pasos/i, '✅'],
    [/descripci|identific|caracter[ií]stic|cient[ií]fic/i, '🌱'],
  ];

  function cardIcon(title) {
    for (const [re, ic] of CARD_ICONS) if (re.test(title)) return ic;
    return '🌿';
  }

  function renderMarkdown(src) {
    const lines = String(src).replace(/\r/g, '').split('\n');
    const hasTop = /^#{1,2}\s+\S/m.test(src);
    const cardLevel = hasTop ? 2 : 3;
    const sections = [{ title: null, html: '' }];
    let cur = sections[0];
    let para = [];
    let list = null; // { tag, items }
    let table = null;
    let code = null;

    const flushPara = () => {
      if (para.length) cur.html += '<p>' + para.map(inlineMd).join('<br>') + '</p>';
      para = [];
    };
    const flushList = () => {
      if (list) cur.html += '<' + list.tag + '>' + list.items.map((i) => '<li>' + inlineMd(i) + '</li>').join('') + '</' + list.tag + '>';
      list = null;
    };
    const flushTable = () => {
      if (!table) return;
      const rows = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      if (rows.length) {
        const head = rows[0].map((c) => '<th>' + inlineMd(c) + '</th>').join('');
        const body = rows.slice(1).map((r) => '<tr>' + r.map((c) => '<td>' + inlineMd(c) + '</td>').join('') + '</tr>').join('');
        cur.html += '<div class="ab-tablewrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
      }
      table = null;
    };
    const flushAll = () => { flushPara(); flushList(); flushTable(); };

    for (const raw of lines) {
      if (code !== null) {
        if (/^\s*```/.test(raw)) { cur.html += '<pre><code>' + esc(code.join('\n')) + '</code></pre>'; code = null; }
        else code.push(raw);
        continue;
      }
      if (/^\s*```/.test(raw)) { flushAll(); code = []; continue; }

      const h = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(raw);
      if (h) {
        flushAll();
        if (h[1].length <= cardLevel) {
          cur = { title: h[2].replace(/\*\*/g, ''), html: '' };
          sections.push(cur);
        } else {
          cur.html += '<h5>' + inlineMd(h[2]) + '</h5>';
        }
        continue;
      }
      if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) { flushAll(); continue; }
      if (/^\s*\|/.test(raw)) { flushPara(); flushList(); (table = table || []).push(raw); continue; }
      flushTable();

      const li = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(raw);
      if (li) {
        flushPara();
        const tag = li[1] ? 'ol' : 'ul';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push(li[2]);
        continue;
      }
      if (!raw.trim()) { flushPara(); flushList(); continue; }
      if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += ' ' + raw.trim(); continue; }
      flushList();
      para.push(raw.trim());
    }
    if (code !== null) cur.html += '<pre><code>' + esc(code.join('\n')) + '</code></pre>';
    flushAll();

    return sections.map((s) => {
      if (s.title === null) return s.html ? '<div class="ab-text">' + s.html + '</div>' : '';
      return '<section class="ab-card"><h4><span class="ab-ic" aria-hidden="true">' + cardIcon(s.title) + '</span><span>' + inlineMd(s.title) + '</span></h4><div class="ab-card-body">' + s.html + '</div></section>';
    }).join('');
  }

  /* ---------- Estilos (inyectados, con prefijo ab-) ---------- */
  const CSS = `
.ab-root{--ab-green:#2e7d32;--ab-green-d:#1b5e20;--ab-soft:#eef6ee;--ab-line:#dbe7dc;--ab-ink:#1b2a1f;--ab-mute:#5f7164;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ab-ink);background:#fff;display:flex;flex-direction:column;min-height:0;box-sizing:border-box;font-size:15px;line-height:1.5}
.ab-root *{box-sizing:border-box}
.ab-drawer{position:fixed;top:0;right:0;bottom:0;height:100vh;height:100dvh;width:clamp(420px,42vw,640px);z-index:2000;box-shadow:-12px 0 40px rgba(0,0,0,.25);transition:transform .25s ease,visibility .25s;transform:translateX(105%);visibility:hidden}
.ab-drawer.open{transform:none;visibility:visible}
.ab-inline{height:min(80vh,820px);border:1px solid var(--ab-line);border-radius:16px;overflow:hidden}
.ab-launcher{position:fixed;right:18px;bottom:18px;z-index:1900;border:0;border-radius:999px;padding:12px 18px;font:600 15px system-ui,sans-serif;color:#fff;background:linear-gradient(135deg,#43a047,#1b5e20);box-shadow:0 6px 20px rgba(0,0,0,.3);cursor:pointer;display:flex;gap:8px;align-items:center}
.ab-launcher:hover{filter:brightness(1.08)}
.ab-head{display:flex;align-items:center;gap:10px;padding:12px 14px;background:linear-gradient(135deg,#2e7d32,#1b5e20);color:#fff}
.ab-logo{font-size:26px}
.ab-title{flex:1;min-width:0}
.ab-title h2{margin:0;font-size:17px;font-weight:700;color:#fff}
.ab-status{margin:0;font-size:12px;opacity:.95;display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ab-dot{width:8px;height:8px;border-radius:50%;background:#bbb;flex:none}
.ab-dot.ok{background:#69f0ae}.ab-dot.warn{background:#ffd54f}.ab-dot.off{background:#ff8a80}.ab-dot.checking{background:#b0bec5}
.ab-hbtn{border:1px solid rgba(255,255,255,.45);background:rgba(255,255,255,.12);color:#fff;border-radius:10px;padding:7px 10px;font-size:13px;cursor:pointer}
.ab-hbtn:hover{background:rgba(255,255,255,.25)}
.ab-log{flex:1;min-height:0;overflow-y:auto;padding:14px;background:#f7faf7;scroll-behavior:smooth}
.ab-empty{text-align:center;padding:18px 6px}
.ab-empty h3{margin:6px 0 4px;font-size:19px}
.ab-empty p{margin:0 auto 14px;max-width:420px;color:var(--ab-mute);font-size:14px}
.ab-chips{display:grid;grid-template-columns:1fr 1fr;gap:8px;max-width:520px;margin:0 auto}
.ab-chip{display:flex;gap:8px;align-items:flex-start;text-align:left;border:1px solid var(--ab-line);background:#fff;border-radius:12px;padding:10px;font:inherit;font-size:13px;color:var(--ab-ink);cursor:pointer}
.ab-chip:hover{border-color:var(--ab-green);background:var(--ab-soft)}
.ab-msg{display:flex;gap:8px;margin:0 0 14px;align-items:flex-start}
.ab-msg.ab-user{justify-content:flex-end}
.ab-bubble{max-width:86%;background:var(--ab-green);color:#fff;border-radius:16px 16px 4px 16px;padding:9px 13px;white-space:pre-wrap;overflow-wrap:anywhere}
.ab-avatar{flex:none;width:30px;height:30px;border-radius:50%;background:var(--ab-soft);border:1px solid var(--ab-line);display:flex;align-items:center;justify-content:center;font-size:16px}
.ab-body{min-width:0;flex:1}
.ab-text,.ab-card{background:#fff;border:1px solid var(--ab-line);border-radius:14px;padding:10px 13px;margin:0 0 9px;overflow-wrap:anywhere}
.ab-card{border-left:4px solid var(--ab-green)}
.ab-card h4{margin:0 0 6px;font-size:14px;display:flex;gap:7px;align-items:center;color:var(--ab-green-d)}
.ab-body p{margin:0 0 7px}.ab-body p:last-child{margin-bottom:0}
.ab-body ul,.ab-body ol{margin:4px 0 6px;padding-left:20px}.ab-body li{margin:2px 0}
.ab-body h5{margin:8px 0 3px;font-size:13px;color:var(--ab-mute);text-transform:uppercase;letter-spacing:.03em}
.ab-body code{background:#eef2ee;border-radius:5px;padding:1px 5px;font-size:13px}
.ab-body pre{background:#1e2a22;color:#e8f5e9;border-radius:10px;padding:10px;overflow-x:auto;font-size:13px}
.ab-body pre code{background:none;padding:0;color:inherit}
.ab-tablewrap{overflow-x:auto;margin:4px 0}
.ab-body table{border-collapse:collapse;font-size:13px;min-width:100%}
.ab-body th,.ab-body td{border:1px solid var(--ab-line);padding:5px 8px;text-align:left}
.ab-body th{background:var(--ab-soft)}
.ab-tag{display:inline-block;font-size:11px;font-weight:600;border-radius:999px;padding:0 7px;margin:0 2px;vertical-align:1px}
.ab-tag.est{background:#fff3e0;color:#b45309;border:1px solid #ffcc80}
.ab-tag.ok{background:#e8f5e9;color:#1b5e20;border:1px solid #a5d6a7}
.ab-caret{display:inline-block;width:8px;height:15px;background:var(--ab-green);margin-left:2px;vertical-align:-2px;animation:ab-blink 1s steps(2) infinite}
@keyframes ab-blink{50%{opacity:0}}
.ab-thinking{display:flex;gap:5px;align-items:center;padding:10px 4px;color:var(--ab-mute);font-size:13px}
.ab-thinking i{width:7px;height:7px;border-radius:50%;background:var(--ab-green);animation:ab-bounce 1.2s infinite ease-in-out}
.ab-thinking i:nth-child(2){animation-delay:.15s}.ab-thinking i:nth-child(3){animation-delay:.3s}
@keyframes ab-bounce{0%,80%,100%{transform:scale(.5);opacity:.5}40%{transform:scale(1);opacity:1}}
.ab-note{font-size:12.5px;color:var(--ab-mute);margin:2px 0 8px}
.ab-error{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#fdecea;border:1px solid #f5b5ae;color:#8a1c12;border-radius:12px;padding:9px 12px;font-size:13.5px;margin-top:4px}
.ab-error span{flex:1;min-width:160px}
.ab-retry{border:1px solid #c62828;background:#fff;color:#c62828;border-radius:9px;padding:5px 12px;font:600 13px system-ui;cursor:pointer}
.ab-retry:hover{background:#c62828;color:#fff}
.ab-foot{border-top:1px solid var(--ab-line);background:#fff;padding:8px 12px 10px}
.ab-share{display:flex;gap:7px;align-items:center;font-size:12.5px;color:var(--ab-mute);margin:0 0 7px;cursor:pointer}
.ab-composer{display:flex;gap:8px;align-items:flex-end}
.ab-input{flex:1;resize:none;border:1px solid var(--ab-line);border-radius:12px;padding:9px 12px;font:inherit;max-height:140px;min-height:42px;background:#fff;color:var(--ab-ink)}
.ab-input:focus{outline:2px solid #a5d6a7;border-color:var(--ab-green)}
.ab-send{flex:none;height:42px;min-width:84px;border:0;border-radius:12px;background:var(--ab-green);color:#fff;font:600 14px system-ui;cursor:pointer;padding:0 14px}
.ab-send:hover{background:var(--ab-green-d)}
.ab-send.stop{background:#c62828}
.ab-send:disabled{opacity:.5;cursor:not-allowed}
.ab-meta{display:flex;justify-content:space-between;font-size:11.5px;color:var(--ab-mute);margin-top:5px}
@media(max-width:720px){
 .ab-drawer{width:100%}
 .ab-chips{grid-template-columns:1fr}
 .ab-bubble{max-width:92%}
 .ab-inline{height:82vh;border-radius:12px}
 .ab-input{font-size:16px}
}`;

  function injectCSS() {
    if (document.getElementById('ab-style')) return;
    const s = el('style');
    s.id = 'ab-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* ---------- Construcción de la interfaz ---------- */
  function build() {
    root = el('div', 'ab-root');
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'AgroBot AI');
    root.innerHTML =
      '<div class="ab-head">' +
        '<span class="ab-logo" aria-hidden="true">🌱</span>' +
        '<div class="ab-title"><h2>AgroBot AI</h2><p class="ab-status"><span class="ab-dot checking"></span><span class="ab-status-text">Comprobando conexión…</span></p></div>' +
        '<button type="button" class="ab-hbtn ab-new" title="Iniciar una conversación nueva">＋ Nueva</button>' +
        '<button type="button" class="ab-hbtn ab-close" aria-label="Cerrar AgroBot AI">✕</button>' +
      '</div>' +
      '<div class="ab-log" role="log" aria-live="polite"></div>' +
      '<div class="ab-foot">' +
        '<label class="ab-share"><input type="checkbox" class="ab-share-cb" checked> Compartir con la IA los datos de la simulación (tanque, zonas, parámetros)</label>' +
        '<div class="ab-composer">' +
          '<textarea class="ab-input" rows="1" maxlength="' + CFG.maxChars + '" placeholder="Pregunta sobre plantas, cultivos, riego o tu simulación…" aria-label="Escribe tu pregunta"></textarea>' +
          '<button type="button" class="ab-send">Enviar</button>' +
        '</div>' +
        '<div class="ab-meta"><span>Enter envía · Shift+Enter nueva línea</span><span class="ab-count"></span></div>' +
      '</div>';

    refs = {
      log: root.querySelector('.ab-log'),
      input: root.querySelector('.ab-input'),
      send: root.querySelector('.ab-send'),
      newBtn: root.querySelector('.ab-new'),
      close: root.querySelector('.ab-close'),
      dot: root.querySelector('.ab-dot'),
      statusText: root.querySelector('.ab-status-text'),
      share: root.querySelector('.ab-share-cb'),
      count: root.querySelector('.ab-count'),
    };

    refs.send.addEventListener('click', onSendClick);
    refs.newBtn.addEventListener('click', newConversation);
    refs.close.addEventListener('click', close);
    refs.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        onSendClick();
      }
    });
    refs.input.addEventListener('input', () => {
      refs.input.style.height = 'auto';
      refs.input.style.height = Math.min(refs.input.scrollHeight, 140) + 'px';
      const n = refs.input.value.length;
      refs.count.textContent = n > CFG.maxChars * 0.8 ? n + ' / ' + CFG.maxChars : '';
    });
    refs.log.addEventListener('scroll', () => {
      stick = refs.log.scrollHeight - refs.log.scrollTop - refs.log.clientHeight < 80;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !inline && root.classList.contains('open')) close();
    });
    renderEmpty();
  }

  function renderEmpty() {
    refs.log.innerHTML = '';
    const box = el('div', 'ab-empty');
    box.innerHTML = '<div style="font-size:42px" aria-hidden="true">🌾</div><h3>Hola, soy AgroBot AI</h3>' +
      '<p>Una IA especializada en plantas, cultivos y riego con agua de lluvia. Pregúntame lo que quieras y respondo con razonamiento propio, no con respuestas fijas.</p>';
    const chips = el('div', 'ab-chips');
    for (const s of SUGGESTIONS) {
      const b = el('button', 'ab-chip');
      b.type = 'button';
      b.innerHTML = '<span aria-hidden="true">' + s.icon + '</span><span>' + esc(s.text) + '</span>';
      b.addEventListener('click', () => submit(s.text));
      chips.appendChild(b);
    }
    box.appendChild(chips);
    refs.log.appendChild(box);
  }

  /* ---------- Estado de conexión ---------- */
  function setStatus(kind, text) {
    refs.dot.className = 'ab-dot ' + kind;
    refs.statusText.textContent = text;
  }

  async function checkHealth() {
    healthChecked = true;
    setStatus('checking', 'Comprobando conexión…');
    try {
      const r = await fetch(API + '/api/agrobot/health', { cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      const h = await r.json();
      if (!h.configured) setStatus('warn', 'IA sin configurar en el servidor (falta la clave API)');
      else if (h.modelAvailable === false) setStatus('warn', 'Modelo no disponible para esta cuenta: ' + h.model);
      else setStatus('ok', 'Conectado · ' + h.model);
    } catch (e) {
      setStatus('off', location.protocol === 'file:' ? 'Abre el proyecto desde el servidor, no como archivo' : 'Servidor de AgroBot no disponible');
    }
  }

  /* ---------- Mensajes en pantalla ---------- */
  function clearEmpty() {
    const e = refs.log.querySelector('.ab-empty');
    if (e) e.remove();
  }

  function scrollDown(force) {
    if (force || stick) refs.log.scrollTop = refs.log.scrollHeight;
  }

  function addUserView(text) {
    clearEmpty();
    const m = el('div', 'ab-msg ab-user');
    const b = el('div', 'ab-bubble');
    b.textContent = text;
    m.appendChild(b);
    refs.log.appendChild(m);
    stick = true;
    scrollDown(true);
  }

  function addAssistantView() {
    const m = el('div', 'ab-msg ab-bot');
    m.appendChild(el('div', 'ab-avatar', '🌱'));
    const body = el('div', 'ab-body');
    body.innerHTML = '<div class="ab-thinking" aria-label="AgroBot está procesando"><i></i><i></i><i></i><span>Procesando tu pregunta…</span></div>';
    m.appendChild(body);
    refs.log.appendChild(m);
    scrollDown();
    return { el: m, body, pending: false };
  }

  function paint(view, text, streaming) {
    view.body.innerHTML = renderMarkdown(text) + (streaming ? '<span class="ab-caret"></span>' : '');
    scrollDown();
  }

  function scheduleRender(view, msg) {
    if (view.pending) return;
    view.pending = true;
    requestAnimationFrame(() => {
      view.pending = false;
      if (view.done) return;
      paint(view, msg.content, true);
    });
  }

  function addNote(view, text) {
    view.body.appendChild(el('div', 'ab-note', esc(text)));
    scrollDown();
  }

  function addError(view, message) {
    const box = el('div', 'ab-error');
    box.setAttribute('role', 'alert');
    box.innerHTML = '<span>⚠️ ' + esc(message) + '</span>';
    const btn = el('button', 'ab-retry', 'Reintentar');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (busy) return;
      view.el.remove();
      run();
    });
    box.appendChild(btn);
    view.body.appendChild(box);
    scrollDown(true);
  }

  /* ---------- Envío ---------- */
  function buildPayload() {
    // Une mensajes consecutivos del mismo rol y limita el historial enviado.
    const merged = [];
    for (const m of messages) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role) last.content += '\n\n' + m.content;
      else merged.push({ role: m.role, content: m.content });
    }
    let recent = merged.slice(-CFG.maxHistory);
    while (recent.length && recent[0].role !== 'user') recent.shift();
    const payload = { messages: recent };
    if (refs.share.checked && AGRO.Sim && typeof AGRO.Sim.snapshot === 'function') {
      payload.context = AGRO.Sim.snapshot();
    }
    return payload;
  }

  function onSendClick() {
    if (busy) {
      if (controller) controller.abort();
      return;
    }
    submit(refs.input.value);
  }

  function submit(raw) {
    const text = String(raw || '').trim();
    if (!text || busy) return;
    if (text.length > CFG.maxChars) return;
    messages.push({ role: 'user', content: text });
    addUserView(text);
    refs.input.value = '';
    refs.input.style.height = 'auto';
    refs.count.textContent = '';
    run();
  }

  function setBusy(v) {
    busy = v;
    refs.send.textContent = v ? 'Detener' : 'Enviar';
    refs.send.classList.toggle('stop', v);
    refs.send.setAttribute('aria-label', v ? 'Cancelar la respuesta' : 'Enviar pregunta');
    refs.newBtn.disabled = false;
    refs.log.setAttribute('aria-busy', v ? 'true' : 'false');
  }

  async function readError(res) {
    try {
      const j = await res.json();
      if (j && j.error && j.error.message) return j.error.message;
    } catch (_) { /* sin cuerpo JSON */ }
    return 'El servidor respondió con un error (' + res.status + ').';
  }

  async function readSSE(res, onEvent) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let ev = 'message';
        const data = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (!data.length) continue;
        try { onEvent(ev, JSON.parse(data.join('\n'))); } catch (_) { /* fragmento inválido */ }
      }
    }
  }

  async function run() {
    if (busy) return;
    setBusy(true);
    const msg = { role: 'assistant', content: '' };
    const view = addAssistantView();
    controller = new AbortController();
    const ctl = controller;
    let userAborted = false;
    let gotDone = false;
    let truncated = false;
    let errMsg = null;

    ctl.signal.addEventListener('abort', () => { userAborted = true; });

    try {
      const res = await fetch(API + '/api/agrobot/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
        signal: ctl.signal,
      });
      if (!res.ok) {
        errMsg = await readError(res);
      } else {
        await readSSE(res, (ev, data) => {
          if (ev === 'delta' && data.text) {
            msg.content += data.text;
            scheduleRender(view, msg);
          } else if (ev === 'done') {
            gotDone = true;
            truncated = !!data.truncated;
          } else if (ev === 'error') {
            errMsg = data.message || 'La IA devolvió un error.';
          }
        });
        if (!errMsg && !gotDone && !userAborted) errMsg = 'La conexión se interrumpió antes de terminar la respuesta.';
      }
    } catch (e) {
      if (!userAborted) {
        errMsg = location.protocol === 'file:'
          ? 'Abriste el proyecto como archivo. Inicia el servidor (npm start) y abre http://localhost:3000.'
          : 'No se pudo conectar con el servidor de AgroBot AI. Revisa que esté en marcha y tu conexión.';
      }
    }

    view.done = true;
    controller = null;
    setBusy(false);

    if (userAborted) {
      if (msg.content) {
        paint(view, msg.content, false);
        addNote(view, 'Respuesta detenida por ti.');
        messages.push(msg);
      } else {
        view.body.innerHTML = '';
        addError(view, 'Solicitud cancelada.');
      }
      return;
    }
    if (!errMsg && !msg.content) errMsg = 'La IA no devolvió texto. Intenta de nuevo.';
    if (errMsg) {
      if (msg.content) paint(view, msg.content, false);
      else view.body.innerHTML = '';
      addError(view, errMsg); // la respuesta parcial no entra al historial
      if (healthChecked) checkHealth();
      return;
    }
    paint(view, msg.content, false);
    if (truncated) addNote(view, 'La respuesta se cortó por el límite de longitud. Escribe "continúa" para seguir.');
    messages.push(msg);
  }

  function newConversation() {
    if (controller) controller.abort();
    messages = [];
    renderEmpty();
    refs.input.focus();
  }

  /* ---------- Apertura / cierre (modo panel flotante) ---------- */
  function open() {
    if (!root) return;
    if (!inline) root.classList.add('open');
    if (!healthChecked) checkHealth();
    setTimeout(() => refs.input.focus(), 50);
  }

  function close() {
    if (!inline && root) root.classList.remove('open');
  }

  function ask(text) {
    open();
    submit(text);
  }

  /* ---------- Inicialización ---------- */
  function init() {
    if (root) return;
    injectCSS();
    build();

    let host = null;
    for (const sel of HOST_SELECTORS) {
      host = document.querySelector(sel);
      if (host) break;
    }

    if (host) {
      inline = true;
      host.innerHTML = '';
      host.appendChild(root);
      root.classList.add('ab-inline');
      refs.close.style.display = 'none';
      checkHealth();
    } else {
      root.classList.add('ab-drawer');
      launcher = el('button', 'ab-launcher', '<span aria-hidden="true">🌱</span> AgroBot AI');
      launcher.type = 'button';
      launcher.setAttribute('aria-label', 'Abrir AgroBot AI');
      launcher.addEventListener('click', open);
      document.body.appendChild(launcher);
      document.body.appendChild(root);
    }
  }

  return { init, open, close, ask, newConversation, _renderMarkdown: renderMarkdown };
})();
