// Distribuição automática de conversas (filas).
// Quando um lead novo chega, escolhemos o vendedor que vai atender:
//   - só entre os que estão com status 'disponivel'
//   - o que tiver MENOS conversas abertas no momento (rodízio justo por carga)
// Se ninguém estiver disponível, a conversa fica sem responsável (na fila)
// até alguém pegar.
import { query, temPool } from '../db/pool.js';

export async function escolherResponsavel(academiaId, unidadeId = null) {
  if (!temPool()) return null;

  // vendedores disponíveis, com a contagem de conversas abertas de cada um.
  // Preferimos quem é da mesma unidade; se não houver, qualquer disponível.
  const { rows } = await query(
    `SELECT u.id,
            (SELECT COUNT(*) FROM conversas c
              WHERE c.responsavel_id = u.id
                AND c.status IN ('aguardando','em_atendimento')) AS abertas,
            (u.unidade_id IS NOT DISTINCT FROM $2) AS mesma_unidade
       FROM usuarios u
      WHERE u.academia_id = $1
        AND u.papel = 'vendedor'
        AND u.ativo = true
        AND u.status = 'disponivel'
      ORDER BY mesma_unidade DESC, abertas ASC, u.id ASC
      LIMIT 1`,
    [academiaId, unidadeId]
  );

  return rows[0]?.id ?? null;
}
