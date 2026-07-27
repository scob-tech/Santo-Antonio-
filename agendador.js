// agendador.js
// Roda a análise de fim de dia sozinha, 1x por dia, às 18h (horário de
// Brasília — o Brasil não tem mais horário de verão desde 2019, então
// UTC-3 é fixo o ano todo).
//
// Em vez de sugerir tarefa a cada mensagem (o que gastaria token o dia
// inteiro), a IA só é chamada uma vez por conversa em aberto, no fim do
// dia, pra identificar gargalos e oportunidades de venda complementar —
// e já cria a tarefa na agenda sozinha (o vendedor só confere/conclui).
//
// Limitação: o "já rodou hoje" fica em memória — se o servidor reiniciar
// (redeploy) depois das 18h no mesmo dia, pode rodar de novo e duplicar
// alguma tarefa. Baixo impacto (o vendedor só vê a tarefa 2x), mas fica
// registrado.

const db = require('./db');
const claudeIA = require('./claude');

let ultimaExecucaoData = null;

function agoraBRT() {
  const agora = new Date();
  const brt = new Date(agora.getTime() - 3 * 60 * 60 * 1000); // UTC-3
  return { hora: brt.getUTCHours(), dataISO: brt.toISOString().slice(0, 10) };
}

function amanha8hISO() {
  const { dataISO } = agoraBRT();
  const amanha = new Date(new Date(dataISO + 'T08:00:00-03:00').getTime() + 24 * 60 * 60 * 1000);
  return amanha.toISOString();
}

async function rodarAnaliseDiaria() {
  if (!claudeIA.configurado) {
    console.log('>> Análise diária pulada: IA não configurada (ANTHROPIC_API_KEY ausente).');
    return { rodou: false, motivo: 'ia_nao_configurada' };
  }

  const quando = amanha8hISO();
  let tarefasCriadas = 0;
  let encerradosAnalisados = 0;

  // 0) Conversas ENCERRADAS ainda sem resultado definido: a IA lê e decide
  // sozinha se converteu/perdeu, valor e motivo — sem confirmação humana
  // (decisão explícita do Silvio, com o trade-off já discutido: agiliza o
  // encerramento no dia a dia, mas confia no julgamento da IA pro dado
  // financeiro do relatório).
  const encerradosPendentes = db.prepare(`SELECT * FROM leads WHERE status = 'encerrado' AND resultado IS NULL`).all();
  for (const lead of encerradosPendentes) {
    const mensagens = db.prepare('SELECT * FROM mensagens WHERE lead_id = ? ORDER BY criado_em ASC').all(lead.id);
    if (mensagens.length === 0) continue;

    const analise = await claudeIA.analisarConversa(mensagens);
    encerradosAnalisados++;
    if (!analise || !analise.resultado_sugerido) continue;

    if (analise.resultado_sugerido === 'convertido') {
      db.prepare(`UPDATE leads SET resultado = 'convertido', valor_venda = ? WHERE id = ?`)
        .run(analise.valor_sugerido || 0, lead.id);
      if (lead.vendedor_id) {
        const daqui3dias = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
        db.prepare(`
          INSERT INTO lembretes (lead_id, vendedor_id, titulo, quando, tipo)
          VALUES (?, ?, ?, ?, 'pos_venda')
        `).run(lead.id, lead.vendedor_id, `🤖 Pós-venda — confirmar se ${lead.nome_cliente || lead.telefone} recebeu tudo certo`, daqui3dias);
      }
    } else if (analise.resultado_sugerido === 'perdido') {
      db.prepare(`UPDATE leads SET resultado = 'perdido', motivo_perda = ? WHERE id = ?`)
        .run(analise.motivo_perda_sugerido || 'não identificado pela IA', lead.id);
    } else {
      // "indefinido" — marca assim mesmo, pra não ficar reanalisando pra sempre
      db.prepare(`UPDATE leads SET resultado = 'indefinido' WHERE id = ?`).run(lead.id);
    }
  }

  // 1) Conversas em aberto: IA procura gargalo + oportunidade de complementar
  const leadsAbertos = db.prepare(`SELECT * FROM leads WHERE status = 'em_atendimento'`).all();

  for (const lead of leadsAbertos) {
    const mensagens = db.prepare('SELECT * FROM mensagens WHERE lead_id = ? ORDER BY criado_em ASC').all(lead.id);
    if (mensagens.length === 0 || !lead.vendedor_id) continue;

    const analise = await claudeIA.analisarDiaria(mensagens);
    if (!analise) continue;

    if (analise.gargalo && analise.gargalo.existe && analise.gargalo.titulo) {
      db.prepare(`
        INSERT INTO lembretes (lead_id, vendedor_id, titulo, quando, tipo)
        VALUES (?, ?, ?, ?, ?)
      `).run(lead.id, lead.vendedor_id, `🤖 ${analise.gargalo.titulo}`, quando, analise.gargalo.tipo || 'outro');
      tarefasCriadas++;
    }

    if (analise.oportunidade && analise.oportunidade.existe && analise.oportunidade.titulo) {
      db.prepare(`
        INSERT INTO lembretes (lead_id, vendedor_id, titulo, quando, tipo)
        VALUES (?, ?, ?, ?, 'oportunidade')
      `).run(lead.id, lead.vendedor_id, `🤖 ${analise.oportunidade.titulo}`, quando);
      tarefasCriadas++;
    }
  }

  // 2) Leads 'novo' que ninguém puxou o dia inteiro — vira alerta pro admin
  // (checagem simples, sem IA: se ninguém pegou, não tem conversa pra analisar)
  const admin = db.prepare(`SELECT id FROM vendedores WHERE role = 'admin' LIMIT 1`).get();
  if (admin) {
    const esquecidos = db.prepare(`
      SELECT * FROM leads WHERE status = 'novo' AND datetime(criado_em) <= datetime('now', '-6 hours')
    `).all();
    for (const lead of esquecidos) {
      const jaExiste = db.prepare(`
        SELECT id FROM lembretes WHERE lead_id = ? AND titulo LIKE '🤖 Ninguém puxou%'
      `).get(lead.id);
      if (jaExiste) continue;
      db.prepare(`
        INSERT INTO lembretes (lead_id, vendedor_id, titulo, quando, tipo)
        VALUES (?, ?, ?, ?, 'outro')
      `).run(lead.id, admin.id, `🤖 Ninguém puxou o lead de ${lead.nome_cliente || lead.telefone} ainda — verificar fila`, quando);
      tarefasCriadas++;
    }
  }

  console.log(`>> Análise diária concluída: ${leadsAbertos.length} conversas em aberto revisadas, ${encerradosAnalisados} encerrada(s) classificada(s), ${tarefasCriadas} tarefa(s) criada(s).`);
  return { rodou: true, conversas_revisadas: leadsAbertos.length, encerrados_analisados: encerradosAnalisados, tarefas_criadas: tarefasCriadas };
}

// Verifica a cada 5 minutos se já são 18h (BRT) e ainda não rodou hoje.
function iniciarAgendador() {
  setInterval(async () => {
    const { hora, dataISO } = agoraBRT();
    if (hora === 18 && ultimaExecucaoData !== dataISO) {
      ultimaExecucaoData = dataISO;
      console.log('>> Rodando análise diária automática (18h)...');
      await rodarAnaliseDiaria();
    }
  }, 5 * 60 * 1000);
  console.log('>> Agendador da análise diária ativo (roda sozinho às 18h, horário de Brasília).');
}

module.exports = { iniciarAgendador, rodarAnaliseDiaria };
