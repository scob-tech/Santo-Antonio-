// server.js
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const db = require('./db');
const ai = require('./ai');
const authLib = require('./auth');
const zapi = require('./zapi');
const claudeIA = require('./claude');
const agendador = require('./agendador');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------
// MIDDLEWARES DE AUTENTICAÇÃO
// ---------------------------------------------------------------
function requireAuth(req, res, next) {
  const token = req.cookies.sessao;
  const usuario = token ? authLib.pegarSessao(token) : null;
  if (!usuario) return res.status(401).json({ erro: 'não autenticado' });
  req.usuario = usuario;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.usuario || req.usuario.role !== 'admin') {
    return res.status(403).json({ erro: 'ação restrita ao administrador' });
  }
  next();
}

// ---------------------------------------------------------------
// LOGIN / LOGOUT / SESSÃO ATUAL
// ---------------------------------------------------------------
app.post('/api/login', (req, res) => {
  const { login, senha } = req.body;
  if (!login || !senha) {
    return res.status(400).json({ erro: 'login e senha são obrigatórios' });
  }

  const vendedor = db.prepare('SELECT * FROM vendedores WHERE login = ?').get(login);
  if (!vendedor || !authLib.verificarSenha(senha, vendedor.senha_hash)) {
    return res.status(401).json({ erro: 'login ou senha inválidos' });
  }

  const token = authLib.criarSessao(vendedor);
  res.cookie('sessao', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true, usuario: { id: vendedor.id, nome: vendedor.nome, role: vendedor.role } });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies.sessao;
  if (token) authLib.destruirSessao(token);
  res.clearCookie('sessao');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json(req.usuario);
});

// ---------------------------------------------------------------
// CADASTRO DE VENDEDOR (só admin)
// ---------------------------------------------------------------
app.post('/api/vendedores', requireAuth, requireAdmin, (req, res) => {
  const { nome, login, senha, role } = req.body;
  if (!nome || !login || !senha) {
    return res.status(400).json({ erro: 'nome, login e senha são obrigatórios' });
  }
  if (senha.length < 4) {
    return res.status(400).json({ erro: 'senha muito curta (mínimo 4 caracteres)' });
  }

  const existente = db.prepare('SELECT id FROM vendedores WHERE login = ?').get(login);
  if (existente) {
    return res.status(409).json({ erro: 'esse login já está em uso' });
  }

  const roleFinal = role === 'admin' ? 'admin' : 'vendedor';
  const senha_hash = authLib.hashSenha(senha);
  const info = db.prepare(`
    INSERT INTO vendedores (nome, login, senha_hash, role, disponivel)
    VALUES (?, ?, ?, ?, 1)
  `).run(nome, login, senha_hash, roleFinal);

  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// ---------------------------------------------------------------
// WEBHOOKS — dois pontos de entrada:
//   /webhook/message  → simulado (usado pelo scripts/simulate-*.js e testes)
//   /webhook/zapi     → mensagens reais do WhatsApp via Z-API
// Ambos convergem na mesma função de processamento, então a lógica de
// negócio (anti-duplicação, IA, criação de lead) só existe uma vez.
// Nenhum dos dois exige login: são origens externas alimentando o sistema.
// ---------------------------------------------------------------

// Processa uma mensagem recebida (de onde quer que tenha vindo) e retorna
// o resultado. Envia a boas-vindas automática de volta pro WhatsApp de
// verdade quando a Z-API estiver configurada (enviarMensagemWhatsapp vira
// no-op silencioso se não estiver — ver zapi.js).
async function processarMensagemRecebida({ telefone, nome_cliente, texto, origem }) {
  const leadAtivo = db.prepare(`
    SELECT * FROM leads
    WHERE telefone = ? AND status IN ('novo', 'em_atendimento')
    ORDER BY criado_em DESC LIMIT 1
  `).get(telefone);

  if (leadAtivo) {
    db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto) VALUES (?, 'cliente', ?)`)
      .run(leadAtivo.id, texto);
    return { lead_id: leadAtivo.id, info: 'mensagem adicionada a conversa existente (lead não duplicado)' };
  }

  const oportunidades = ai.identificarOportunidade(texto);

  // Tenta gerar boas-vindas + resumo com IA de verdade; se não estiver
  // configurada (ou falhar), cai pro stub de palavra-chave (ai.js).
  const iaResposta = await claudeIA.processarNovaMensagem(texto, nome_cliente);
  const interesse = (iaResposta && iaResposta.interesse) || (oportunidades.length > 0 ? oportunidades.join(', ') : null);
  const boasVindas = (iaResposta && iaResposta.boas_vindas) || ai.gerarMensagemBoasVindas(texto, nome_cliente);

  const insertLead = db.prepare(`
    INSERT INTO leads (telefone, nome_cliente, primeira_mensagem, origem, status, interesse)
    VALUES (?, ?, ?, ?, 'novo', ?)
  `);
  const info = insertLead.run(telefone, nome_cliente || null, texto, origem || 'geral', interesse);
  const leadId = info.lastInsertRowid;

  db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto) VALUES (?, 'cliente', ?)`)
    .run(leadId, texto);

  db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto) VALUES (?, 'ia', ?)`)
    .run(leadId, boasVindas);

  // Manda a boas-vindas de verdade pro WhatsApp do cliente (se configurado)
  await zapi.enviarMensagemWhatsapp(telefone, boasVindas);

  return { lead_id: leadId, mensagem_boas_vindas: boasVindas, oportunidades_detectadas: oportunidades };
}

app.post('/webhook/message', async (req, res) => {
  const { telefone, nome_cliente, texto, origem } = req.body;
  if (!telefone || !texto) {
    return res.status(400).json({ erro: 'telefone e texto são obrigatórios' });
  }
  const resultado = await processarMensagemRecebida({ telefone, nome_cliente, texto, origem });
  res.status(resultado.mensagem_boas_vindas ? 201 : 200).json(resultado);
});

// Webhook real da Z-API — configure essa URL no painel da instância em
// "Webhooks" → "Ao receber" (ReceivedCallback): https://SEU-DOMINIO/webhook/zapi
app.post('/webhook/zapi', async (req, res) => {
  const { telefone, nomeCliente, texto, messageId, fromMe } = zapi.interpretarWebhook(req.body);

  // Sempre responde 200 rápido pra Z-API não ficar reenviando —
  // qualquer motivo de "ignorar" ainda assim é uma resposta de sucesso.
  if (fromMe) {
    return res.status(200).json({ info: 'mensagem enviada por nós mesmos, ignorada' });
  }
  if (zapi.jaProcessada(messageId)) {
    return res.status(200).json({ info: 'mensagem já processada antes (duplicada), ignorada' });
  }
  if (!telefone || !texto) {
    return res.status(200).json({ info: 'payload sem telefone/texto reconhecível, ignorado' });
  }

  zapi.marcarProcessada(messageId);
  const resultado = await processarMensagemRecebida({
    telefone,
    nome_cliente: nomeCliente,
    texto,
    origem: 'whatsapp',
  });
  res.status(200).json(resultado);
});

// ---------------------------------------------------------------
// LEADS
// ---------------------------------------------------------------

// Fila: cada pessoa só recebe o que faz sentido pra ela ver, direto do banco —
// não é mais "manda tudo e restringe no front". Isso resolve dois problemas
// de uma vez: a fila não fica gigante com histórico de dias passados, e um
// lead que outro vendedor pegou simplesmente não aparece mais pros demais.
app.get('/api/leads', requireAuth, (req, res) => {
  // Admin pode pedir um dia específico do histórico (?data=2026-07-22) — nesse
  // caso mostra TUDO daquele dia, sem o filtro de "ainda ativo" da fila normal.
  // Sem esse parâmetro, cai no comportamento padrão (fila ao vivo, sem acumular).
  const dataFiltro = req.usuario.role === 'admin' ? req.query.data : null;
  let leads;

  if (req.usuario.role === 'admin') {
    if (dataFiltro) {
      leads = db.prepare(`
        SELECT * FROM leads WHERE date(criado_em) = date(?) ORDER BY criado_em DESC
      `).all(dataFiltro);
    } else {
      // Vê tudo que ainda está ativo (não importa quando chegou — um lead em
      // atendimento nunca some sozinho) + os encerrados só de hoje, pra ter o
      // retrato do dia sem acumular semanas de histórico na fila.
      leads = db.prepare(`
        SELECT * FROM leads
        WHERE status != 'encerrado' OR date(criado_em) = date('now')
        ORDER BY criado_em DESC
      `).all();
    }
  } else {
    // Vendedor só vê o que pode pegar (novo, pra todo mundo) e o que já é
    // dele em atendimento. Assim que ele encerra, ou outro vendedor pega
    // um lead que era novo, esse lead simplesmente some da tela dele.
    leads = db.prepare(`
      SELECT * FROM leads
      WHERE status = 'novo' OR (status = 'em_atendimento' AND vendedor_id = ?)
      ORDER BY criado_em DESC
    `).all(req.usuario.id);
  }

  const resultado = leads.map((lead) => {
    const dono = lead.vendedor_id === req.usuario.id;
    const ultima = db.prepare(
      'SELECT remetente, texto, criado_em FROM mensagens WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
    ).get(lead.id);
    return { ...lead, ultima_mensagem: ultima || null, dono };
  });

  res.json(resultado);
});

app.get('/api/leads/:id', requireAuth, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });

  const dono = lead.vendedor_id === req.usuario.id;
  const podeVer = req.usuario.role === 'admin' || dono || lead.status === 'novo';
  if (!podeVer) {
    return res.status(403).json({ erro: 'este lead já está sendo atendido por outro vendedor' });
  }

  const mensagens = db.prepare('SELECT * FROM mensagens WHERE lead_id = ? ORDER BY criado_em ASC').all(req.params.id);
  res.json({ ...lead, mensagens, dono });
});

// Vendedor logado "puxa" o lead pra si (não seleciona mais quem — é sempre quem está logado)
app.post('/api/leads/:id/claim', requireAuth, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });

  if (lead.vendedor_id) {
    return res.status(409).json({ erro: 'lead já foi puxado por outro vendedor' });
  }

  const vendedorId = req.usuario.id;
  db.prepare(`UPDATE leads SET status = 'em_atendimento', vendedor_id = ? WHERE id = ?`)
    .run(vendedorId, req.params.id);

  // Cria automaticamente um lembrete de follow-up daqui a 2 dias
  const daqui2dias = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO lembretes (lead_id, vendedor_id, titulo, quando, tipo)
    VALUES (?, ?, ?, ?, 'ligacao')
  `).run(req.params.id, vendedorId, `Verificar se ${lead.nome_cliente || lead.telefone} fechou o pedido`, daqui2dias);

  res.json({ ok: true });
});

// Encerrar atendimento — só o dono do lead ou o admin.
// Agora exige resultado (convertido/perdido) pra alimentar o relatório do dia.
app.post('/api/leads/:id/encerrar', requireAuth, (req, res) => {
  const { resultado, valor_venda, motivo_perda } = req.body;

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });

  const dono = lead.vendedor_id === req.usuario.id;
  if (req.usuario.role !== 'admin' && !dono) {
    return res.status(403).json({ erro: 'só quem está atendendo (ou o admin) pode encerrar' });
  }

  if (resultado !== 'convertido' && resultado !== 'perdido') {
    return res.status(400).json({ erro: 'informe o resultado: convertido ou perdido' });
  }
  if (resultado === 'convertido' && (valor_venda === undefined || valor_venda === null || valor_venda === '')) {
    return res.status(400).json({ erro: 'informe o valor da venda' });
  }
  if (resultado === 'perdido' && !motivo_perda) {
    return res.status(400).json({ erro: 'informe o motivo da perda' });
  }

  db.prepare(`
    UPDATE leads SET status = 'encerrado', resultado = ?, valor_venda = ?, motivo_perda = ?
    WHERE id = ?
  `).run(resultado, resultado === 'convertido' ? Number(valor_venda) : null, resultado === 'perdido' ? motivo_perda : null, req.params.id);

  // Se converteu, já cria automaticamente o lembrete de pós-venda daqui a 3 dias
  if (resultado === 'convertido') {
    const daqui3dias = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO lembretes (lead_id, vendedor_id, titulo, quando, tipo)
      VALUES (?, ?, ?, ?, 'pos_venda')
    `).run(req.params.id, req.usuario.id, `Pós-venda — confirmar se ${lead.nome_cliente || lead.telefone} recebeu tudo certo`, daqui3dias);
  }

  res.json({ ok: true });
});

// Vendedor envia mensagem pro cliente — só o dono do lead ou o admin
app.post('/api/leads/:id/mensagens', requireAuth, async (req, res) => {
  const { texto } = req.body;
  if (!texto) return res.status(400).json({ erro: 'texto é obrigatório' });

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });

  const dono = lead.vendedor_id === req.usuario.id;
  if (req.usuario.role !== 'admin' && !dono) {
    return res.status(403).json({ erro: 'só quem está atendendo (ou o admin) pode responder' });
  }

  db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto) VALUES (?, 'vendedor', ?)`)
    .run(req.params.id, texto);

  const envio = await zapi.enviarMensagemWhatsapp(lead.telefone, texto);

  res.status(201).json({ ok: true, enviado_whatsapp: envio.enviado });
});

// ---------------------------------------------------------------
// LEAD MANUAL — pra contato proativo fora do fluxo automático de
// WhatsApp (ex: carrinho abandonado, reativação de cliente antigo).
// O vendedor já iniciou essa conversa por fora do sistema (WhatsApp
// pessoal, pra não arriscar o número oficial). Aqui ele só faz o
// pré-cadastro: o lead nasce direto em "em_atendimento", atribuído a
// quem criou, e segue o mesmo fluxo de encerramento de qualquer outro
// lead — assim entra certinho no relatório do dia e no ticket médio.
// ---------------------------------------------------------------
const ORIGENS_MANUAIS = ['carrinho_abandonado', 'reativacao', 'outro'];
app.post('/api/leads/manual', requireAuth, (req, res) => {
  const { nome_cliente, telefone, interesse, origem, vendedor_id } = req.body;
  if (!nome_cliente || !telefone || !interesse) {
    return res.status(400).json({ erro: 'nome, telefone e intenção de compra são obrigatórios' });
  }

  // Evita duplicar lead se já existe um atendimento em aberto pra esse telefone
  const jaAberto = db.prepare(`
    SELECT id FROM leads WHERE telefone = ? AND status IN ('novo', 'em_atendimento')
  `).get(telefone);
  if (jaAberto) {
    return res.status(409).json({ erro: 'já existe um atendimento em aberto pra esse telefone', lead_id: jaAberto.id });
  }

  const origemFinal = ORIGENS_MANUAIS.includes(origem) ? origem : 'outro';
  // Só admin pode criar o lead já atribuído a outro vendedor; qualquer outro caso, é pra si mesmo
  const vendedorDestino = req.usuario.role === 'admin' && vendedor_id ? vendedor_id : req.usuario.id;

  const info = db.prepare(`
    INSERT INTO leads (telefone, nome_cliente, primeira_mensagem, origem, status, interesse, vendedor_id)
    VALUES (?, ?, ?, ?, 'em_atendimento', ?, ?)
  `).run(telefone, nome_cliente, interesse, origemFinal, interesse, vendedorDestino);

  const leadId = info.lastInsertRowid;
  db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto) VALUES (?, 'vendedor', ?)`)
    .run(leadId, `Lead cadastrado manualmente. Intenção: ${interesse}`);

  res.status(201).json({ ok: true, id: leadId });
});

// ---------------------------------------------------------------
// VENDEDORES
// ---------------------------------------------------------------
app.get('/api/vendedores', requireAuth, (req, res) => {
  const vendedores = db.prepare('SELECT id, nome, role FROM vendedores ORDER BY nome ASC').all();
  const comContagem = vendedores.map((v) => {
    const leadsAtivos = db.prepare(
      `SELECT COUNT(*) AS n FROM leads WHERE vendedor_id = ? AND status = 'em_atendimento'`
    ).get(v.id).n;
    return { ...v, leads_ativos: leadsAtivos };
  });
  res.json(comContagem);
});

// ---------------------------------------------------------------
// LEMBRETES — cada vendedor só vê os seus; admin vê todos
// ---------------------------------------------------------------
app.get('/api/lembretes', requireAuth, (req, res) => {
  let lembretes;
  if (req.usuario.role === 'admin') {
    lembretes = db.prepare(`
      SELECT lembretes.*, leads.nome_cliente, leads.telefone
      FROM lembretes
      JOIN leads ON leads.id = lembretes.lead_id
      WHERE lembretes.feito = 0
      ORDER BY lembretes.quando ASC
    `).all();
  } else {
    lembretes = db.prepare(`
      SELECT lembretes.*, leads.nome_cliente, leads.telefone
      FROM lembretes
      JOIN leads ON leads.id = lembretes.lead_id
      WHERE lembretes.feito = 0 AND lembretes.vendedor_id = ?
      ORDER BY lembretes.quando ASC
    `).all(req.usuario.id);
  }
  res.json(lembretes);
});

app.post('/api/lembretes/:id/concluir', requireAuth, (req, res) => {
  db.prepare('UPDATE lembretes SET feito = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Criação manual de lembrete/tarefa — vendedor monta a própria agenda
// (ex: "mandar orçamento", "calcular frete") em cima de um lead que já é dele.
// Admin também pode criar tarefa PRA outro vendedor (ex: revisar atendimento).
const TIPOS_LEMBRETE = ['orcamento', 'catalogo', 'frete', 'pos_venda', 'ligacao', 'objecao', 'oportunidade', 'outro'];
app.post('/api/lembretes', requireAuth, (req, res) => {
  const { lead_id, titulo, quando, tipo, vendedor_id } = req.body;
  if (!lead_id || !titulo || !quando) {
    return res.status(400).json({ erro: 'lead_id, titulo e quando são obrigatórios' });
  }
  const tipoFinal = TIPOS_LEMBRETE.includes(tipo) ? tipo : 'outro';

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead_id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });

  const dono = lead.vendedor_id === req.usuario.id;
  if (req.usuario.role !== 'admin' && !dono) {
    return res.status(403).json({ erro: 'só quem está atendendo (ou o admin) pode criar tarefa nesse lead' });
  }

  // Só admin pode atribuir a tarefa a outro vendedor; qualquer outro caso, é pra si mesmo
  const vendedorDestino = req.usuario.role === 'admin' && vendedor_id ? vendedor_id : req.usuario.id;

  const info = db.prepare(`
    INSERT INTO lembretes (lead_id, vendedor_id, titulo, quando, tipo)
    VALUES (?, ?, ?, ?, ?)
  `).run(lead_id, vendedorDestino, titulo, quando, tipoFinal);

  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// Disparo manual da análise diária (útil pra testar sem esperar 18h, ou se
// o servidor esteve fora do ar na hora automática) — só admin.
app.post('/api/admin/rodar-analise-diaria', requireAuth, requireAdmin, async (req, res) => {
  const resultado = await agendador.rodarAnaliseDiaria();
  res.json(resultado);
});

// ---------------------------------------------------------------
// SUGESTÕES DA IA — a IA lê a conversa e sugere, mas nunca grava
// nada sozinha. O vendedor (ou admin) sempre confirma com um clique.
// ---------------------------------------------------------------
app.get('/api/leads/:id/sugestao-encerramento', requireAuth, async (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });

  const dono = lead.vendedor_id === req.usuario.id;
  if (req.usuario.role !== 'admin' && !dono) {
    return res.status(403).json({ erro: 'sem permissão pra esse lead' });
  }
  if (!claudeIA.configurado) {
    return res.status(503).json({ erro: 'IA ainda não configurada nesse servidor (falta ANTHROPIC_API_KEY)' });
  }

  const mensagens = db.prepare('SELECT * FROM mensagens WHERE lead_id = ? ORDER BY criado_em ASC').all(req.params.id);
  const sugestao = await claudeIA.analisarConversa(mensagens);
  if (!sugestao) return res.status(502).json({ erro: 'IA não conseguiu analisar agora, tenta de novo em instantes' });
  res.json(sugestao);
});

app.get('/api/leads/:id/sugestao-tarefa', requireAuth, async (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });

  const dono = lead.vendedor_id === req.usuario.id;
  if (req.usuario.role !== 'admin' && !dono) {
    return res.status(403).json({ erro: 'sem permissão pra esse lead' });
  }
  if (!claudeIA.configurado) {
    return res.status(503).json({ erro: 'IA ainda não configurada nesse servidor (falta ANTHROPIC_API_KEY)' });
  }

  const mensagens = db.prepare('SELECT * FROM mensagens WHERE lead_id = ? ORDER BY criado_em ASC').all(req.params.id);
  const sugestao = await claudeIA.sugerirTarefa(mensagens);
  if (!sugestao) return res.status(502).json({ erro: 'IA não conseguiu analisar agora, tenta de novo em instantes' });
  res.json(sugestao);
});

// ---------------------------------------------------------------
// RELATÓRIO DO DIA
// Admin: números gerais + quebra por vendedor.
// Vendedor: só o próprio desempenho.
// ---------------------------------------------------------------
function calcularRelatorio(dataISO, filtroVendedorId) {
  // criado_em é salvo em UTC pelo SQLite (datetime('now')); comparamos por prefixo de data.
  const leadsDoDia = db.prepare(`SELECT * FROM leads WHERE date(criado_em) = date(?)`).all(dataISO);

  const encerradosHoje = db.prepare(`
    SELECT * FROM leads WHERE date(criado_em) = date(?) AND status = 'encerrado'
  `).all(dataISO);

  function metricasDe(leads) {
    const recebidos = leads.length;
    const convertidos = leads.filter(l => l.resultado === 'convertido');
    const perdidos = leads.filter(l => l.resultado === 'perdido');
    const valorTotal = convertidos.reduce((soma, l) => soma + (l.valor_venda || 0), 0);
    const ticketMedio = convertidos.length > 0 ? valorTotal / convertidos.length : 0;

    // Distribuição de motivos de perda (objeções)
    const objecoes = {};
    perdidos.forEach(l => {
      const motivo = l.motivo_perda || 'não informado';
      objecoes[motivo] = (objecoes[motivo] || 0) + 1;
    });

    // Tempo até ser puxado (criação -> primeira mudança pra em_atendimento).
    // Como não guardamos histórico de status, aproximamos usando a criação do lembrete
    // automático (criado no momento do claim) como proxy do instante do claim.
    let temposAteClaim = [];
    let temposAtePrimeiraResposta = [];
    let gargalos = 0;

    leads.forEach(l => {
      const mensagens = db.prepare('SELECT * FROM mensagens WHERE lead_id = ? ORDER BY id ASC').all(l.id);
      const primeiraMsgCliente = mensagens.find(m => m.remetente === 'cliente');
      const primeiraRespostaVendedor = mensagens.find(m => m.remetente === 'vendedor');
      if (primeiraMsgCliente && primeiraRespostaVendedor) {
        const minutos = (new Date(primeiraRespostaVendedor.criado_em + 'Z') - new Date(primeiraMsgCliente.criado_em + 'Z')) / 60000;
        if (minutos >= 0) temposAtePrimeiraResposta.push(minutos);
      }
      // Gargalo: qualquer intervalo >= 5min entre uma mensagem do cliente e a próxima resposta (ia não conta)
      for (let i = 0; i < mensagens.length; i++) {
        if (mensagens[i].remetente === 'cliente') {
          const proxima = mensagens.slice(i + 1).find(m => m.remetente === 'vendedor');
          if (proxima) {
            const gap = (new Date(proxima.criado_em + 'Z') - new Date(mensagens[i].criado_em + 'Z')) / 60000;
            if (gap >= 5) { gargalos++; break; }
          } else if (l.status !== 'encerrado') {
            gargalos++; break; // ainda esperando resposta
          }
        }
      }
    });

    const media = (arr) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

    return {
      leads_recebidos: recebidos,
      convertidos: convertidos.length,
      perdidos: perdidos.length,
      ainda_em_aberto: recebidos - convertidos.length - perdidos.length,
      taxa_conversao: recebidos > 0 ? Math.round((convertidos.length / recebidos) * 1000) / 10 : 0,
      ticket_medio: Math.round(ticketMedio * 100) / 100,
      valor_total_vendido: Math.round(valorTotal * 100) / 100,
      tempo_medio_primeira_resposta_min: media(temposAtePrimeiraResposta) !== null ? Math.round(media(temposAtePrimeiraResposta)) : null,
      leads_com_gargalo: gargalos,
      objecoes,
    };
  }

  if (filtroVendedorId) {
    const meus = leadsDoDia.filter(l => l.vendedor_id === filtroVendedorId);
    return { data: dataISO, escopo: 'proprio', ...metricasDe(meus) };
  }

  const geral = metricasDe(leadsDoDia);
  const vendedores = db.prepare(`SELECT id, nome FROM vendedores`).all();
  const porVendedor = vendedores.map(v => {
    const meus = leadsDoDia.filter(l => l.vendedor_id === v.id);
    if (meus.length === 0) return null;
    return { vendedor: v.nome, ...metricasDe(meus) };
  }).filter(Boolean);

  return { data: dataISO, escopo: 'geral', ...geral, por_vendedor: porVendedor };
}

app.get('/api/relatorio', requireAuth, (req, res) => {
  const dataISO = req.query.data || new Date().toISOString().slice(0, 10);
  if (req.usuario.role === 'admin') {
    res.json(calcularRelatorio(dataISO, null));
  } else {
    res.json(calcularRelatorio(dataISO, req.usuario.id));
  }
});

// ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  agendador.iniciarAgendador();
});
