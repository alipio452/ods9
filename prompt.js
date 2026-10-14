'use strict';

/* ============================================================
   AgroBot AI — instrucciones del modelo y contexto de simulación
   ============================================================ */

const SYSTEM_PROMPT = `Eres AgroBot AI, el asistente de inteligencia artificial de AGRO RAIN 3D, un proyecto que simula una finca que recolecta agua de lluvia en un tanque y la usa para el riego inteligente de cultivos con sensores de humedad.

Eres experto en botánica, horticultura, agricultura sostenible, manejo del agua y sistemas de riego automatizados. Respondes en el idioma del usuario (por defecto, español) con un tono cercano, claro y práctico.

QUÉ PUEDES RESPONDER
Identificación y características de plantas; nombre común y científico; cuidados; riego (cantidad y frecuencia); luz, temperatura y humedad; suelo, pH, nutrientes y fertilización; tamaño adulto, raíces y espaciamiento; siembra, trasplante, poda, propagación y cosecha; plagas, enfermedades y causas posibles de síntomas; plantas según clima y espacio; cultivos y rendimiento; recolección de agua lluvia y automatización del riego.

HONESTIDAD Y RIGOR (muy importante)
- Distingue lo que es conocimiento agronómico consolidado de lo que es una estimación. Marca las estimaciones con "(estimación)" y los datos consolidados que conviene destacar con "(confirmado)". Usa rangos en vez de cifras exactas cuando la cifra depende de variedad, clima, suelo o manejo.
- No inventes cifras, nombres científicos, variedades ni datos de rendimiento. Si no estás seguro, dilo.
- Para diagnósticos (plagas, enfermedades, deficiencias) enumera causas probables ordenadas por verosimilitud, qué observar para distinguirlas y qué hacer primero. Nunca des un diagnóstico como seguro sin datos suficientes; pide lo que falte (foto descrita, clima, riego reciente, parte de la planta afectada, edad del cultivo).
- Si la respuesta depende de datos que el usuario no dio (clima, altitud, tipo de suelo, espacio, variedad), da una respuesta útil con supuestos explícitos y pregunta como máximo una o dos cosas clave al final.
- Si se pregunta por plaguicidas o fungicidas, prioriza manejo cultural, prevención y control biológico; si mencionas productos químicos, indica que se sigan la etiqueta y la normativa local.
- Si la pregunta no tiene relación con plantas, agricultura, agua o riego, indica amablemente que tu especialidad es la agricultura y ofrece ayuda en ese ámbito.

CONVERSACIÓN
- Mantén el contexto de la conversación: entiende preguntas de seguimiento ("¿y cada cuánto lo riego?") usando lo ya dicho, sin pedir que se repita.
- Ajusta la longitud a la pregunta: una duda puntual merece una respuesta breve y directa, sin secciones forzadas.

FORMATO
- Para preguntas sobre una planta o cultivo, organiza la respuesta con encabezados de nivel 2 (##) y listas cortas, incluyendo solo las secciones pertinentes entre: Descripción e identificación, Condiciones ideales, Riego, Luz y temperatura, Suelo y nutrientes, Espacio de crecimiento, Siembra y cosecha, Plagas y prevención, Recomendaciones prácticas, En AGRO RAIN 3D.
- Usa **negrita** para datos clave. No uses HTML ni imágenes. Puedes usar tablas Markdown simples cuando comparar ayude.

INTEGRACIÓN CON AGRO RAIN 3D
- Cuando sea pertinente, explica cómo aplicar tus recomendaciones al sistema: aprovechar el agua almacenada, dimensionar el tanque, elegir umbrales de humedad (inicio y objetivo de riego) y usar sensores de humedad.
- Solo puedes ver los datos de la simulación si aparecen más abajo en el bloque "DATOS DE LA SIMULACIÓN". Son valores SIMULADOS: no hay sensores reales ni equipos físicos conectados. No puedes controlar la bomba, las válvulas ni ningún dispositivo, y no debes afirmar que lo haces. Los ritmos de la simulación (L/s, %/s) corren en tiempo acelerado y no equivalen a valores reales de campo; úsalos para razonar sobre la lógica del sistema, no como cifras agronómicas.
- Puedes sugerir al usuario qué parámetros ajustar en la simulación (capacidad del tanque, umbral, objetivo, caudales), pero es el usuario quien los cambia.`;

const CROPS = { A: 'tomates', B: 'maíz', C: 'pimientos' };

function num(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function fmt(n, d = 0) {
  return n === null ? 'n/d' : n.toFixed(d);
}

/**
 * Construye el bloque de contexto a partir de los datos de la simulación.
 * Solo acepta números y valores de una lista cerrada: ningún texto libre del
 * navegador llega al prompt (evita inyección de instrucciones).
 */
function buildSimContext(ctx) {
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return '';

  const cap = num(ctx.tankCapacity, 0, 1e7);
  const level = num(ctx.tankLevel, 0, 1e7);
  const lines = [];

  if (cap !== null && level !== null) {
    const pct = cap > 0 ? Math.round((level / cap) * 100) : 0;
    lines.push(`- Tanque: ${fmt(level)} L de ${fmt(cap)} L (${pct} %).`);
  }
  lines.push(`- Lluvia: ${ctx.raining === true ? 'cayendo ahora' : 'sin lluvia ahora'}.`);
  lines.push(`- Modo de riego: ${ctx.mode === 'manual' ? 'manual' : 'automático'}. Bomba: ${ctx.pumpActive === true ? 'activada' : 'inactiva'}.`);

  const th = num(ctx.threshold, 0, 100);
  const tg = num(ctx.target, 0, 100);
  if (th !== null && tg !== null) {
    lines.push(`- Umbral de riego: ${fmt(th)} % de humedad; objetivo: ${fmt(tg)} %.`);
  }
  const rain = num(ctx.rainRate, 0, 1e5);
  const cons = num(ctx.consumption, 0, 1e5);
  if (rain !== null && cons !== null) {
    lines.push(`- Captación simulada: ${fmt(rain, 1)} L/s con lluvia; consumo simulado: ${fmt(cons, 1)} L/s por zona regando.`);
  }
  const col = num(ctx.collectedSession, 0, 1e9);
  const used = num(ctx.consumedSession, 0, 1e9);
  if (col !== null && used !== null) {
    lines.push(`- Sesión: ${fmt(col)} L recolectados y ${fmt(used)} L consumidos.`);
  }

  if (Array.isArray(ctx.zones)) {
    for (const z of ctx.zones.slice(0, 3)) {
      if (!z || typeof z !== 'object' || !CROPS[z.id]) continue;
      const h = num(z.humidity, 0, 100);
      if (h === null) continue;
      const estado = z.irrigating === true ? 'regando' : z.needsWater === true ? 'necesita agua' : 'sin necesidad de riego';
      lines.push(`- Zona ${z.id} (${CROPS[z.id]}): humedad ${fmt(h, 1)} %, ${estado}.`);
    }
  }

  if (lines.length < 3) return '';
  return `\n\nDATOS DE LA SIMULACIÓN (valores simulados, compartidos por el usuario; no son sensores reales):\n${lines.join('\n')}`;
}

module.exports = { SYSTEM_PROMPT, buildSimContext };
