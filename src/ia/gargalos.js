// Detecção de gargalos: uma varredura por regras (rápida e barata, sem IA)
// que aponta onde o atendimento está travando. Vira cartão no painel e,
// opcionalmente, tarefa.
import { query, temPool } from '../db/pool.js';

export async function detectarGargalos(academiaId) {
  if (!temPool()) {
    return [
      { tipo: 'sem_resposta', titulo: '3 leads sem resposta (demo)', gravidade: 'alta' },
      { tipo: 'parado', titulo: '2 conversas paradas há +24h (demo)', gravidade: 'media' },
    ];
  }

  const gargalos = [];

  // 1) leads aguardando resposta há mais de 30 min
  const semResposta = await query(
    `SELECT COUNT(*)::int AS n FROM conversas
      WHERE academia_id=$1 AND status='aguardando'
        AND ultima_msg_em < now() - interval '30 minutes'`,
    [academiaId]
  );
  if (semResposta.rows[0].n > 0) {
    gargalos.push({
      tipo: 'sem_resposta',
      titulo: `${semResposta.rows[0].n} conversa(s) esperando resposta há +30min`,
      gravidade: semResposta.rows[0].n >= 5 ? 'alta' : 'media',
    });
  }

  // 2) conversas paradas (sem movimento) há mais de 24h
  const paradas = await query(
    `SELECT COUNT(*)::int AS n FROM conversas
      WHERE academia_id=$1 AND status IN ('em_atendimento','parado')
        AND ultima_msg_em < now() - interval '24 hours'`,
    [academiaId]
  );
  if (paradas.rows[0].n > 0) {
    gargalos.push({
      tipo: 'parado',
      titulo: `${paradas.rows[0].n} conversa(s) paradas há +24h`,
      gravidade: 'media',
    });
  }

  // 3) janelas de 24h prestes a fechar com conversa ainda aberta
  const janelaFechando = await query(
    `SELECT COUNT(*)::int AS n FROM conversas
      WHERE academia_id=$1 AND status IN ('aguardando','em_atendimento')
        AND janela_expira_em BETWEEN now() AND now() + interval '2 hours'`,
    [academiaId]
  );
  if (janelaFechando.rows[0].n > 0) {
    gargalos.push({
      tipo: 'janela',
      titulo: `${janelaFechando.rows[0].n} conversa(s) com janela de 24h fechando (responda já pra não pagar template)`,
      gravidade: 'alta',
    });
  }

  return gargalos;
}
