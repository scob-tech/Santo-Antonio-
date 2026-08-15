// Curadoria de fim de dia: a IA lê as conversas do dia, resume e gera uma
// lista de tarefas (follow-ups) pra cada responsável. Roda pelo agendador.
import { completar } from './client.js';
import { query, temPool } from '../db/pool.js';

const SISTEMA = `Você organiza o fim de dia de uma equipe de vendas de academia.
Recebe um resumo das conversas do dia e devolve uma lista objetiva de tarefas de
follow-up (uma por linha, começando com "- "). Priorize: leads sem resposta,
contratos a vencer, e conversas paradas. Seja específico e curto. Responda só a lista.`;

export async function curadoriaDoDia(academiaId) {
  if (!temPool()) {
    return { resumo: '[demo] sem banco — curadoria simulada.', tarefasCriadas: 0 };
  }

  // pega conversas movimentadas nas últimas 24h
  const { rows: convs } = await query(
    `SELECT c.id, c.status, ct.nome AS contato, ct.tipo,
            (SELECT conteudo FROM mensagens m WHERE m.conversa_id=c.id
             ORDER BY m.criada_em DESC LIMIT 1) AS ultima
       FROM conversas c
       JOIN contatos ct ON ct.id = c.contato_id
      WHERE c.academia_id = $1
        AND c.ultima_msg_em > now() - interval '24 hours'
      ORDER BY c.ultima_msg_em DESC
      LIMIT 50`,
    [academiaId]
  );

  if (convs.length === 0) {
    return { resumo: 'Sem movimento nas últimas 24h.', tarefasCriadas: 0 };
  }

  const resumoConversas = convs
    .map((c) => `#${c.id} [${c.status}] ${c.contato} (${c.tipo}): "${c.ultima || ''}"`)
    .join('\n');

  const texto = await completar({
    sistema: SISTEMA,
    usuario: `Conversas do dia:\n${resumoConversas}\n\nGere as tarefas de follow-up.`,
    maxTokens: 600,
  });

  // transforma cada linha "- ..." em uma tarefa
  const linhas = texto
    .split('\n')
    .map((l) => l.replace(/^[-•\d.)\s]+/, '').trim())
    .filter((l) => l.length > 3);

  let criadas = 0;
  for (const titulo of linhas.slice(0, 30)) {
    await query(
      `INSERT INTO tarefas (academia_id, titulo, origem) VALUES ($1,$2,'curadoria')`,
      [academiaId, titulo]
    );
    criadas++;
  }

  return { resumo: texto, tarefasCriadas: criadas };
}
