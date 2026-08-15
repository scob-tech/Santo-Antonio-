// Agendador simples, sem dependência externa. Roda a curadoria + gargalos
// uma vez por dia (por volta das 20h no fuso configurado) e também a cada
// hora só a varredura de gargalos (barata).
// Obs.: como o Railway pode reiniciar o processo, isto é "best-effort".
// Pra produção pesada dá pra trocar por um cron externo batendo numa rota.
import { curadoriaDoDia } from '../ia/curadoria.js';
import { detectarGargalos } from '../ia/gargalos.js';
import { query, temPool } from '../db/pool.js';
import { config } from '../config.js';

async function academiasAtivas() {
  if (!temPool()) return [];
  const { rows } = await query(`SELECT id FROM academias`);
  return rows.map((r) => r.id);
}

let ultimaCuradoria = null; // 'AAAA-MM-DD' já rodado

// hora local no fuso configurado
function horaLocal() {
  const s = new Intl.DateTimeFormat('pt-BR', {
    timeZone: config.tz,
    hour: '2-digit',
    hour12: false,
  }).format(new Date());
  return parseInt(s, 10);
}
function diaLocal() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.tz }).format(new Date());
}

async function tick() {
  try {
    const ids = await academiasAtivas();
    for (const id of ids) {
      // gargalos toda hora
      await detectarGargalos(id);
    }

    // curadoria: uma vez por dia, a partir das 20h
    const hoje = diaLocal();
    if (horaLocal() >= 20 && ultimaCuradoria !== hoje) {
      for (const id of ids) {
        const r = await curadoriaDoDia(id);
        console.log(`[cron] curadoria academia ${id}: ${r.tarefasCriadas} tarefa(s).`);
      }
      ultimaCuradoria = hoje;
    }
  } catch (e) {
    console.error('[cron] erro no tick:', e.message);
  }
}

export function iniciarAgendador() {
  // roda 1 min após subir e depois a cada 30 min
  setTimeout(tick, 60 * 1000);
  setInterval(tick, 30 * 60 * 1000);
  console.log('[cron] agendador iniciado (gargalos a cada 30min, curadoria após 20h).');
}
