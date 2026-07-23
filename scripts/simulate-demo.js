// scripts/simulate-demo.js
// Roda uma simulação completa da operação: clientes chegando, vendedores
// puxando e respondendo, vendas fechadas, vendas perdidas, um lead ainda
// em atendimento e outro ainda esperando na fila — pra você abrir o
// dashboard e ver tudo funcionando de verdade, do ponto de vista do
// admin e de cada vendedor.
//
// PRÉ-REQUISITO: o servidor precisa estar rodando antes de rodar este script.
// Por padrão aponta pro localhost. Pra rodar contra o sistema hospedado, use:
//   BASE_URL=https://seu-endereco.up.railway.app node scripts/simulate-demo.js
//
// Uso: node scripts/simulate-demo.js  (ou: npm run simulate-demo)

const BASE = process.env.BASE_URL || 'http://localhost:3000';

function cookieJar() {
  let cookie = '';
  return {
    headers() { return cookie ? { Cookie: cookie } : {}; },
    capture(res) {
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
    },
  };
}

async function login(loginId, senha) {
  const jar = cookieJar();
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: loginId, senha }),
  });
  jar.capture(res);
  const data = await res.json();
  if (!res.ok) throw new Error(`login falhou (${loginId}): ${data.erro}`);
  return { jar, usuario: data.usuario };
}

async function cadastrarVendedor(adminJar, nome, loginId, senha) {
  const res = await fetch(`${BASE}/api/vendedores`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...adminJar.headers() },
    body: JSON.stringify({ nome, login: loginId, senha, role: 'vendedor' }),
  });
  const data = await res.json();
  if (!res.ok && res.status !== 409) throw new Error(`cadastro falhou (${loginId}): ${data.erro}`);
}

async function criarLead({ telefone, nome_cliente, texto, origem }) {
  const res = await fetch(`${BASE}/webhook/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telefone, nome_cliente, texto, origem }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`webhook falhou (${telefone}): ${JSON.stringify(data)}`);
  return data.lead_id;
}

async function puxar(jar, leadId) {
  const res = await fetch(`${BASE}/api/leads/${leadId}/claim`, { method: 'POST', headers: jar.headers() });
  const data = await res.json();
  if (!res.ok) throw new Error(`claim falhou (lead ${leadId}): ${data.erro}`);
}

async function responder(jar, leadId, texto) {
  const res = await fetch(`${BASE}/api/leads/${leadId}/mensagens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...jar.headers() },
    body: JSON.stringify({ texto }),
  });
  if (!res.ok) { const d = await res.json(); throw new Error(`mensagem falhou: ${d.erro}`); }
}

async function encerrar(jar, leadId, body) {
  const res = await fetch(`${BASE}/api/leads/${leadId}/encerrar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...jar.headers() },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`encerrar falhou (lead ${leadId}): ${data.erro}`);
}

async function criarTarefa(jar, lead_id, titulo, tipo, diasNoFuturo) {
  const quando = new Date(Date.now() + diasNoFuturo * 24 * 60 * 60 * 1000).toISOString();
  const res = await fetch(`${BASE}/api/lembretes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...jar.headers() },
    body: JSON.stringify({ lead_id, titulo, tipo, quando }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`tarefa falhou: ${data.erro}`);
}

async function main() {
  console.log('== Simulação completa: Depósito Santo Antônio ==\n');

  const { jar: adminJar } = await login('admin', 'admin123');
  console.log('✓ Login admin ok');

  await cadastrarVendedor(adminJar, 'Bruno (demo)', 'bruno_demo', 'demo1234');
  await cadastrarVendedor(adminJar, 'Pedro (demo)', 'pedro_demo', 'demo1234');
  console.log('✓ Vendedores demo cadastrados (ou já existiam)');

  const { jar: brunoJar } = await login('bruno_demo', 'demo1234');
  const { jar: pedroJar } = await login('pedro_demo', 'demo1234');
  console.log('✓ Login dos vendedores demo ok\n');

  const leadA = await criarLead({ telefone: '11991110001', nome_cliente: 'Marcos Andrade', texto: 'Bom dia, quero cimento e areia pra laje de 40m²', origem: 'produtos' });
  const leadB = await criarLead({ telefone: '11991110002', nome_cliente: 'Fernanda Lima', texto: 'Preciso de tijolo urgente, vocês entregam hoje?', origem: 'duvidas' });
  const leadC = await criarLead({ telefone: '11991110003', nome_cliente: 'Roberto Costa', texto: 'Qual o preço da brita nº 1?', origem: 'geral' });
  const leadD = await criarLead({ telefone: '11991110004', nome_cliente: 'Juliana Prado', texto: 'Vocês entregam bloco estrutural na Zona Leste?', origem: 'produtos' });
  const leadE = await criarLead({ telefone: '11991110005', nome_cliente: 'Carlos Eduardo', texto: 'Quero orçamento de cal e cimento pra reforma', origem: 'produtos' });
  const leadF = await criarLead({ telefone: '11991110006', nome_cliente: 'Patrícia Nunes', texto: 'Bom dia, gostaria de saber sobre argamassa colante', origem: 'duvidas' });
  console.log(`✓ 6 leads criados (fila) — ids: ${leadA}, ${leadB}, ${leadC}, ${leadD}, ${leadE}, ${leadF}`);

  await puxar(brunoJar, leadA);
  await responder(brunoJar, leadA, 'Oi Marcos! Pra 40m² de laje eu recomendo 15 sacos de cimento e 3m³ de areia. Consigo fechar por R$1.850 com entrega inclusa.');
  await puxar(pedroJar, leadB);
  await responder(pedroJar, leadB, 'Oi Fernanda! Temos tijolo em estoque, dá pra entregar ainda hoje até 18h. Quantos milheiros você precisa?');
  await puxar(brunoJar, leadC);
  await responder(brunoJar, leadC, 'Bom dia Roberto! A brita nº1 está R$89 o m³ hoje.');
  await puxar(pedroJar, leadD);
  await responder(pedroJar, leadD, 'Oi Juliana, entregamos sim na Zona Leste, taxa de R$60.');
  await puxar(brunoJar, leadF);
  await responder(brunoJar, leadF, 'Oi Patrícia! Temos argamassa colante AC-I e AC-II, qual sua necessidade?');
  // leadE fica sem puxar de propósito — mostra a fila viva no dashboard
  console.log('✓ Vendedores puxaram e responderam (lead de Carlos Eduardo ficou livre na fila de propósito)\n');

  await encerrar(brunoJar, leadA, { resultado: 'convertido', valor_venda: 1850 });
  await encerrar(pedroJar, leadB, { resultado: 'convertido', valor_venda: 940 });
  await encerrar(brunoJar, leadC, { resultado: 'perdido', motivo_perda: 'preco' });
  await encerrar(pedroJar, leadD, { resultado: 'perdido', motivo_perda: 'sem_retorno' });
  // leadF fica em_atendimento (Bruno ainda não fechou) — mostra atendimento ativo
  console.log('✓ 2 vendas fechadas, 2 perdidas, 1 ainda em atendimento, 1 ainda na fila\n');

  await criarTarefa(brunoJar, leadF, 'Mandar orçamento da argamassa colante pra Patrícia', 'orcamento', 1);
  console.log('✓ Tarefa manual criada na agenda do Bruno\n');

  console.log('== Simulação concluída ==\n');
  console.log('Abra http://localhost:3000 e entre com:');
  console.log('  Admin:  login "admin"       senha "admin123"   -> fila completa + relatório geral com quebra por vendedor');
  console.log('  Bruno:  login "bruno_demo"  senha "demo1234"   -> 3 leads dele completos + relatório só dele (1 venda, 1 perda, 1 em atendimento)');
  console.log('  Pedro:  login "pedro_demo"  senha "demo1234"   -> 2 leads dele completos + relatório só dele (1 venda, 1 perda)');
  console.log('\nRepare: logado como Bruno ou Pedro, os leads do outro vendedor aparecem na fila só com nome + interesse (versão restrita).');
}

main().catch((err) => {
  console.error('Erro na simulação:', err.message);
  console.error('(confere se o servidor está rodando: npm start em outro terminal)');
  process.exit(1);
});
