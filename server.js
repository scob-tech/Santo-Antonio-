// server.js
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const db = require('./db');
const ai = require('./ai');
const authLib = require('./auth');

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
// WEBHOOK (hoje é simulado; no futuro, é aqui que a Z-API vai bater
// toda vez que um cliente mandar mensagem no WhatsApp real).
// Não exige login: é a origem externa que alimenta o sistema.
// ---------------------------------------------------------------
app.post('/webhook/message', (req, res) => {
  const { telefone, nome_cliente, texto, origem } = req.body;

  if (!telefone || !texto) {
    return res.status(400).json({ erro: 'telefone e texto são obrigatórios' });
  }

  // Evita duplicar leads: se esse telefone já tem uma conversa ATIVA
  // (novo ou em_atendimento), a mensagem entra nela. Só cria lead novo
  // se não existir conversa em aberto (ou a anterior já foi encerrada).
  const leadAtivo = db.prepare(`
    SELECT * FROM leads
    WHERE telefone = ? AND status IN ('novo', 'em_atendimento')
    ORDER BY criado_em DESC LIMIT 1
  `).get(telefone);

  if (leadAtivo) {
    // Já existe conversa em aberto: só registra a mensagem do cliente
    db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto) VALUES (?, 'cliente', ?)`)
      .run(leadAtivo.id, texto);

    return res.status(200).json({
      lead_id: leadAtivo.id,
      info: 'mensagem adicionada a conversa existente (lead não duplicado)',
    });
  }

  // IA identifica possível oportunidade (produtos citados) — já guardamos
  // isso no próprio lead pra poder mostrar um "resumo" pra quem não tem
  // acesso à conversa completa (vendedores que não pegaram esse lead).
  const oportunidades = ai.identificarOportunidade(texto);
  const interesse = oportunidades.length > 0 ? oportunidades.join(', ') : null;

  // Cria o lead. "origem" indica de qual número/página do site ele veio
  // (produtos, duvidas, geral, etc) — mas todos caem na MESMA fila,
  // qualquer vendedor disponível pode puxar, independente da origem.
  const insertLead = db.prepare(`
    INSERT INTO leads (telefone, nome_cliente, primeira_mensagem, origem, status, interesse)
    VALUES (?, ?, ?, ?, 'novo', ?)
  `);
  const info = insertLead.run(telefone, nome_cliente || null, texto, origem || 'geral', interesse);
  const leadId = info.lastInsertRowid;

  // Salva a mensagem do cliente
  db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto) VALUES (?, 'cliente', ?)`)
    .run(leadId, texto);

  // IA gera e "envia" a mensagem de boas-vindas automática
  const boasVindas = ai.gerarMensagemBoasVindas(texto, nome_cliente);
  db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto) VALUES (?, 'ia', ?)`)
    .run(leadId, boasVindas);

  res.status(201).json({
    lead_id: leadId,
    mensagem_boas_vindas: boasVindas,
    oportunidades_detectadas: oportunidades,
  });
});

// ---------------------------------------------------------------
// LEADS
// ---------------------------------------------------------------

// Fila completa: leads 'novo' aparecem por inteiro pra todo mundo.
// Leads em atendimento/encerrados só aparecem por inteiro pro dono
// (quem puxou) ou pro admin — pros demais, só um resumo mínimo
// (nome + interesse), sem telefone e sem conversa.
app.get('/api/leads', requireAuth, (req, res) => {
  const { status } = req.query;
  let leads;
  if (status) {
    leads = db.prepare('SELECT * FROM leads WHERE status = ? ORDER BY criado_em DESC').all(status);
  } else {
    leads = db.prepare('SELECT * FROM leads ORDER BY criado_em DESC').all();
  }

  const resultado = leads.map((lead) => {
    const dono = lead.vendedor_id === req.usuario.id;
    const podeVerTudo = req.usuario.role === 'admin' || dono || lead.status === 'novo';

    if (podeVerTudo) {
      const ultima = db.prepare(
        'SELECT remetente, texto, criado_em FROM mensagens WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
      ).get(lead.id);
      return { ...lead, ultima_mensagem: ultima || null, restrito: false, dono };
    }

    // Versão restrita: só dados mínimos
    return {
      id: lead.id,
      nome_cliente: lead.nome_cliente,
      interesse: lead.interesse,
      origem: lead.origem,
      status: lead.status,
      criado_em: lead.criado_em,
      restrito: true,
      dono: false,
    };
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
app.post('/api/leads/:id/mensagens', requireAuth, (req, res) => {
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

  res.status(201).json({ ok: true });
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
const TIPOS_LEMBRETE = ['orcamento', 'catalogo', 'frete', 'pos_venda', 'ligacao', 'objecao', 'outro'];
app.post('/api/lembretes', requireAuth, (req, res) => {
  const { lead_id, titulo, quando, tipo } = req.body;
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

  const info = db.prepare(`
    INSERT INTO lembretes (lead_id, vendedor_id, titulo, quando, tipo)
    VALUES (?, ?, ?, ?, ?)
  `).run(lead_id, req.usuario.id, titulo, quando, tipoFinal);

  res.status(201).json({ ok: true, id: info.lastInsertRowid });
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
});
