// Relatório de uso do sistema — rode isso no Console do Railway.
// Não altera nada no banco, só lê e imprime números.
const db = require('./db');

function linha() { console.log('─'.repeat(60)); }
function fmtR$(n) { return 'R$ ' + (n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 }); }

console.log('\n📊 RELATÓRIO DE USO — Depósito Santo Antônio\n');
linha();

// ---- Visão geral, por setor ----
const setores = db.getTodosSetores();
for (const setor of setores) {
  const totalLeads = db.prepare('SELECT COUNT(*) n FROM leads WHERE setor_id = ?').get(setor.id).n;
  if (totalLeads === 0) continue;

  const encerrados = db.prepare(`SELECT COUNT(*) n FROM leads WHERE setor_id = ? AND status = 'encerrado'`).get(setor.id).n;
  const convertidos = db.prepare(`SELECT COUNT(*) n FROM leads WHERE setor_id = ? AND resultado = 'convertido'`).get(setor.id).n;
  const valorTotal = db.prepare(`SELECT COALESCE(SUM(valor_venda),0) v FROM leads WHERE setor_id = ? AND resultado = 'convertido'`).get(setor.id).v;
  const primeiroLead = db.prepare('SELECT MIN(criado_em) d FROM leads WHERE setor_id = ?').get(setor.id).d;
  const totalMsgs = db.prepare(`
    SELECT COUNT(*) n FROM mensagens WHERE lead_id IN (SELECT id FROM leads WHERE setor_id = ?)
  `).get(setor.id).n;

  console.log(`\n🏷️  ${setor.nome.toUpperCase()}`);
  console.log(`   Em operação desde: ${primeiroLead ? primeiroLead.split(' ')[0] : '—'}`);
  console.log(`   Total de conversas atendidas: ${totalLeads}`);
  console.log(`   Conversas encerradas: ${encerrados}`);
  if (setor.slug === 'vendas') {
    console.log(`   Pedidos fechados: ${convertidos} (${totalLeads > 0 ? Math.round(100 * convertidos / totalLeads) : 0}% de conversão sobre o total)`);
    console.log(`   Valor total vendido: ${fmtR$(valorTotal)}`);
  }
  console.log(`   Total de mensagens trocadas: ${totalMsgs}`);
}

linha();

// ---- Tempo médio até a primeira resposta (cliente -> vendedor) ----
console.log('\n⏱️  TEMPO MÉDIO ATÉ A PRIMEIRA RESPOSTA\n');
for (const setor of setores) {
  const leads = db.prepare(`SELECT id FROM leads WHERE setor_id = ? AND is_grupo = 0`).all(setor.id);
  if (leads.length === 0) continue;
  const tempos = [];
  for (const lead of leads) {
    const primeiraCliente = db.prepare(`
      SELECT criado_em FROM mensagens WHERE lead_id = ? AND remetente = 'cliente' ORDER BY criado_em ASC LIMIT 1
    `).get(lead.id);
    if (!primeiraCliente) continue;
    const primeiraResposta = db.prepare(`
      SELECT criado_em FROM mensagens WHERE lead_id = ? AND remetente IN ('vendedor','ia') AND criado_em > ? ORDER BY criado_em ASC LIMIT 1
    `).get(lead.id, primeiraCliente.criado_em);
    if (!primeiraResposta) continue;
    const minutos = (new Date(primeiraResposta.criado_em) - new Date(primeiraCliente.criado_em)) / 60000;
    if (minutos >= 0 && minutos < 60 * 24) tempos.push(minutos); // descarta outliers absurdos (>24h)
  }
  if (tempos.length === 0) continue;
  const media = tempos.reduce((a, b) => a + b, 0) / tempos.length;
  console.log(`   ${setor.nome}: ${media.toFixed(1)} minutos em média (${tempos.length} conversas medidas)`);
}

linha();

// ---- Volume por mês (últimos 6 meses) ----
console.log('\n📈 VOLUME DE ATENDIMENTOS POR MÊS\n');
const porMes = db.prepare(`
  SELECT strftime('%Y-%m', criado_em) AS mes, COUNT(*) AS n
  FROM leads
  WHERE criado_em >= date('now', '-6 months')
  GROUP BY mes ORDER BY mes ASC
`).all();
porMes.forEach((m) => console.log(`   ${m.mes}: ${m.n} conversa(s)`));

linha();
console.log('\n✅ Fim do relatório. Copia tudo isso (desde "RELATÓRIO DE USO") e manda de volta.\n');
