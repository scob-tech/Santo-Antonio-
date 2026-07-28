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
app.use(express.json({ limit: '20mb' }));
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

// "Supervisor" tem a mesma visibilidade e ações do admin, EXCETO trocar
// senha e ver relatório (essas duas continuam exclusivas de requireAdmin).
function ehGestor(usuario) {
  return usuario && (usuario.role === 'admin' || usuario.role === 'supervisor');
}
function requireGestor(req, res, next) {
  if (!ehGestor(req.usuario)) {
    return res.status(403).json({ erro: 'ação restrita a administrador ou supervisor' });
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

  // Só um admin de verdade pode criar outro admin ou supervisor — um
  // supervisor cadastrando alguém só consegue criar vendedor comum,
  // pra não dar pra ele mesmo escalar privilégio.
  const rolesPermitidas = req.usuario.role === 'admin' ? ['admin', 'supervisor', 'vendedor'] : ['vendedor'];
  const roleFinal = rolesPermitidas.includes(role) ? role : 'vendedor';
  const senha_hash = authLib.hashSenha(senha);
  const info = db.prepare(`
    INSERT INTO vendedores (nome, login, senha_hash, role, disponivel)
    VALUES (?, ?, ?, ?, 1)
  `).run(nome, login, senha_hash, roleFinal);

  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// Admin redefine a senha de qualquer vendedor — inclusive a própria (é o
// mesmo endpoint: admin passando o próprio id troca a própria senha).
app.post('/api/vendedores/:id/redefinir-senha', requireAuth, requireAdmin, (req, res) => {
  const { senha } = req.body;
  if (!senha || senha.length < 4) {
    return res.status(400).json({ erro: 'senha muito curta (mínimo 4 caracteres)' });
  }

  const vendedor = db.prepare('SELECT id FROM vendedores WHERE id = ?').get(req.params.id);
  if (!vendedor) return res.status(404).json({ erro: 'vendedor não encontrado' });

  const senha_hash = authLib.hashSenha(senha);
  db.prepare('UPDATE vendedores SET senha_hash = ? WHERE id = ?').run(senha_hash, req.params.id);

  res.json({ ok: true });
});

// Admin edita nome, login ou nível de acesso de qualquer conta.
app.patch('/api/vendedores/:id', requireAuth, requireAdmin, (req, res) => {
  const { nome, login, role } = req.body;

  const vendedor = db.prepare('SELECT * FROM vendedores WHERE id = ?').get(req.params.id);
  if (!vendedor) return res.status(404).json({ erro: 'vendedor não encontrado' });

  if (login && login !== vendedor.login) {
    const emUso = db.prepare('SELECT id FROM vendedores WHERE login = ? AND id != ?').get(login, req.params.id);
    if (emUso) return res.status(409).json({ erro: 'esse login já está em uso' });
  }

  const roleFinal = ['admin', 'supervisor', 'vendedor'].includes(role) ? role : vendedor.role;

  db.prepare(`UPDATE vendedores SET nome = ?, login = ?, role = ? WHERE id = ?`)
    .run(nome || vendedor.nome, login || vendedor.login, roleFinal, req.params.id);

  res.json({ ok: true });
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
// Interruptor da mensagem automática de boas-vindas. Desliga só isso —
// o resto do sistema (fila, conversa, envio manual do vendedor) continua
// 100% normal. Pra desligar: variável BOAS_VINDAS_AUTOMATICA=false no Railway.
// Sem a variável (ou qualquer outro valor), fica ligado por padrão.
const BOAS_VINDAS_ATIVA = process.env.BOAS_VINDAS_AUTOMATICA !== 'false';
if (!BOAS_VINDAS_ATIVA) {
  console.log('>> Mensagem automática de boas-vindas DESLIGADA (BOAS_VINDAS_AUTOMATICA=false) — só envio manual do vendedor está ativo.');
}

async function processarMensagemRecebida({ telefone, nome_cliente, texto, origem, midia_url, midia_tipo }) {
  const leadExistente = db.prepare(`
    SELECT * FROM leads WHERE telefone = ? ORDER BY criado_em DESC LIMIT 1
  `).get(telefone);

  if (leadExistente && leadExistente.status !== 'encerrado') {
    // Conversa já em aberto (novo ou em_atendimento) — só adiciona a mensagem
    db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto, midia_url, midia_tipo) VALUES (?, 'cliente', ?, ?, ?)`)
      .run(leadExistente.id, texto, midia_url || null, midia_tipo || null);
    return { lead_id: leadExistente.id, info: 'mensagem adicionada a conversa existente (lead não duplicado)' };
  }

  if (leadExistente && leadExistente.status === 'encerrado') {
    // Cliente que já conversou antes volta a escrever — reabre a conversa
    // antiga (com todo o histórico) em vez de criar um lead do zero.
    // Se já tinha vendedor, volta pra ele; se nunca teve, volta pra fila.
    const novoStatus = leadExistente.vendedor_id ? 'em_atendimento' : 'novo';
    // Quando volta pra fila ('novo'), atualiza criado_em pra AGORA. Sem isso,
    // a fila (que filtra por "date(criado_em) = hoje") nunca mostra esse lead
    // de novo depois de reaberto em outro dia — ele fica escondido no sistema
    // até alguém pensar em ir catar numa data antiga pelo filtro do admin.
    // Leads que voltam direto pra 'em_atendimento' não usam esse filtro de
    // data, então não precisam disso.
    if (novoStatus === 'novo') {
      db.prepare(`UPDATE leads SET status = ?, criado_em = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?`)
        .run(novoStatus, leadExistente.id);
    } else {
      db.prepare(`UPDATE leads SET status = ? WHERE id = ?`).run(novoStatus, leadExistente.id);
    }
    db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto, midia_url, midia_tipo) VALUES (?, 'cliente', ?, ?, ?)`)
      .run(leadExistente.id, texto, midia_url || null, midia_tipo || null);
    return { lead_id: leadExistente.id, info: 'conversa antiga reaberta' };
  }

  const oportunidades = ai.identificarOportunidade(texto);
  let interesse = oportunidades.length > 0 ? oportunidades.join(', ') : null;
  let boasVindas = null;

  if (BOAS_VINDAS_ATIVA) {
    // Tenta gerar boas-vindas + resumo com IA de verdade; se não estiver
    // configurada (ou falhar), cai pro stub de palavra-chave (ai.js).
    const iaResposta = await claudeIA.processarNovaMensagem(texto, nome_cliente);
    if (iaResposta && iaResposta.interesse) interesse = iaResposta.interesse;
    boasVindas = (iaResposta && iaResposta.boas_vindas) || ai.gerarMensagemBoasVindas(texto, nome_cliente);
  }

  const insertLead = db.prepare(`
    INSERT INTO leads (telefone, nome_cliente, primeira_mensagem, origem, status, interesse)
    VALUES (?, ?, ?, ?, 'novo', ?)
  `);
  const info = insertLead.run(telefone, nome_cliente || null, texto, origem || 'geral', interesse);
  const leadId = info.lastInsertRowid;

  db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto, midia_url, midia_tipo) VALUES (?, 'cliente', ?, ?, ?)`)
    .run(leadId, texto, midia_url || null, midia_tipo || null);

  if (boasVindas) {
    db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto) VALUES (?, 'ia', ?)`)
      .run(leadId, boasVindas);
    // Manda a boas-vindas de verdade pro WhatsApp do cliente (se configurado)
    await zapi.enviarMensagemWhatsapp(telefone, boasVindas);
  }

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
  const { telefone, nomeCliente, texto, midiaUrl, midiaTipo, messageId, fromMe } = zapi.interpretarWebhook(req.body);

  // fromMe: true pode ser (a) eco da mensagem que NÓS mandamos pela API,
  // ou (b) o vendedor respondendo manualmente direto no WhatsApp do celular
  // conectado. No caso (b), registramos a mensagem na conversa também —
  // senão ela fica invisível no sistema mesmo tendo sido enviada de verdade.
  if (fromMe) {
    if (zapi.foiEnviadaPorNos(messageId)) {
      return res.status(200).json({ info: 'eco da nossa própria mensagem, ignorado' });
    }
    if (zapi.jaProcessada(`manual-${messageId}`)) {
      return res.status(200).json({ info: 'mensagem manual já processada antes, ignorada' });
    }
    if (telefone && texto) {
      zapi.marcarProcessada(`manual-${messageId}`);
      const leadAtivo = db.prepare(`
        SELECT * FROM leads WHERE telefone = ? AND status = 'em_atendimento' ORDER BY criado_em DESC LIMIT 1
      `).get(telefone);
      if (leadAtivo) {
        db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto, midia_url, midia_tipo) VALUES (?, 'vendedor', ?, ?, ?)`)
          .run(leadAtivo.id, texto, midiaUrl || null, midiaTipo || null);
        return res.status(200).json({ info: 'mensagem manual do vendedor registrada na conversa' });
      }
    }
    return res.status(200).json({ info: 'mensagem enviada por nós (sem lead ativo correspondente), ignorada' });
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
    midia_url: midiaUrl,
    midia_tipo: midiaTipo,
  });
  res.status(200).json(resultado);
});

// ---------------------------------------------------------------
// LEADS
// ---------------------------------------------------------------

// Fila completa: leads 'novo' aparecem por inteiro pra todo mundo.
// Leads em atendimento/encerrados só aparecem por inteiro pro dono
// (quem puxou) ou pro admin — pros demais, só um resumo mínimo
// (nome + interesse), sem telefone e sem conversa.
// Busca por nome/telefone — pra achar conversa antiga (mesmo encerrada) e
// continuar de onde parou. Vendedor só acha as próprias; gestor acha todas.
app.get('/api/leads/buscar', requireAuth, (req, res) => {
  const termo = (req.query.q || '').trim();
  if (termo.length < 2) return res.json([]);

  const todos = db.prepare(`
    SELECT * FROM leads
    WHERE (nome_cliente LIKE ? OR telefone LIKE ?)
    ORDER BY criado_em DESC LIMIT 30
  `).all(`%${termo}%`, `%${termo}%`);

  const visiveis = todos.filter((l) => ehGestor(req.usuario) || l.vendedor_id === req.usuario.id);

  const resultado = visiveis.map((lead) => {
    const ultima = db.prepare(
      'SELECT remetente, texto, criado_em FROM mensagens WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
    ).get(lead.id);
    return { id: lead.id, nome_cliente: lead.nome_cliente, telefone: lead.telefone, status: lead.status, ultima_mensagem: ultima || null };
  });

  res.json(resultado);
});

app.get('/api/leads', requireAuth, (req, res) => {
  const { status, data } = req.query;
  let leads;

  if (status) {
    const statusList = status.split(',').map((s) => s.trim());
    const placeholders = statusList.map(() => '?').join(',');

    if (statusList.length === 1 && statusList[0] === 'novo') {
      // Fila de leads novos: por padrão mostra TODO lead ainda não puxado,
      // de qualquer dia — um lead esperando há 2 dias é mais urgente, não
      // menos, então não faz sentido escondê-lo da fila por padrão.
      // O filtro de data agora é só uma lupa opcional (admin ou vendedor
      // podem usar pra olhar só um dia específico, se quiserem).
      if (data) {
        leads = db.prepare(`
          SELECT * FROM leads WHERE status IN (${placeholders}) AND date(criado_em) = date(?)
          ORDER BY criado_em ASC
        `).all(...statusList, data);
      } else {
        leads = db.prepare(`
          SELECT * FROM leads WHERE status IN (${placeholders})
          ORDER BY criado_em ASC
        `).all(...statusList);
      }
    } else {
      // Conversas ativas (em_atendimento + encerrado): sem filtro de data,
      // acumula tudo tipo WhatsApp — nunca some.
      leads = db.prepare(`SELECT * FROM leads WHERE status IN (${placeholders}) ORDER BY criado_em DESC`).all(...statusList);
    }
  } else {
    leads = db.prepare('SELECT * FROM leads ORDER BY criado_em DESC').all();
  }

  const resultado = leads.map((lead) => {
    const dono = lead.vendedor_id === req.usuario.id;
    const podeVerTudo = ehGestor(req.usuario) || dono || lead.status === 'novo';

    if (podeVerTudo) {
      const ultima = db.prepare(
        'SELECT remetente, texto, criado_em FROM mensagens WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
      ).get(lead.id);
      const vendedor = lead.vendedor_id
        ? db.prepare('SELECT nome FROM vendedores WHERE id = ?').get(lead.vendedor_id)
        : null;
      // Mensagens do cliente desde a última vez que alguém abriu essa conversa
      const naoLidas = lead.visto_em
        ? db.prepare(`SELECT COUNT(*) AS n FROM mensagens WHERE lead_id = ? AND remetente = 'cliente' AND criado_em > ?`).get(lead.id, lead.visto_em).n
        : db.prepare(`SELECT COUNT(*) AS n FROM mensagens WHERE lead_id = ? AND remetente = 'cliente'`).get(lead.id).n;
      return { ...lead, ultima_mensagem: ultima || null, restrito: false, dono, vendedor_nome: vendedor ? vendedor.nome : null, nao_lidas: naoLidas };
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
  const podeVer = ehGestor(req.usuario) || dono || lead.status === 'novo';
  if (!podeVer) {
    return res.status(403).json({ erro: 'este lead já está sendo atendido por outro vendedor' });
  }

  const mensagens = db.prepare('SELECT * FROM mensagens WHERE lead_id = ? ORDER BY criado_em ASC').all(req.params.id);

  // Marca como "visto agora" — zera o badge de não lida pra quem abriu
  if (dono || ehGestor(req.usuario)) {
    db.prepare(`UPDATE leads SET visto_em = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?`).run(req.params.id);
  }

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

// Transferir atendimento pra outro vendedor — dono do lead ou gestor.
// Mantém todo o histórico, só troca quem é responsável.
app.post('/api/leads/:id/transferir', requireAuth, (req, res) => {
  const { novo_vendedor_id } = req.body;
  if (!novo_vendedor_id) return res.status(400).json({ erro: 'informe pra quem transferir' });

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });

  const dono = lead.vendedor_id === req.usuario.id;
  if (!ehGestor(req.usuario) && !dono) {
    return res.status(403).json({ erro: 'só quem está atendendo (ou o admin) pode transferir' });
  }

  const novoVendedor = db.prepare('SELECT id FROM vendedores WHERE id = ?').get(novo_vendedor_id);
  if (!novoVendedor) return res.status(404).json({ erro: 'vendedor de destino não encontrado' });

  db.prepare(`UPDATE leads SET vendedor_id = ?, status = 'em_atendimento' WHERE id = ?`)
    .run(novo_vendedor_id, req.params.id);

  res.json({ ok: true });
});

// Vendedor registra um lead manualmente (cliente que veio por outro canal —
// telefone, presencial). Fica marcado como "nota" — não dispara mensagem
// nenhuma pro WhatsApp sozinho. Se o vendedor quiser mandar mensagem de
// verdade depois, faz isso normalmente pela conversa (decisão dele, com
// o mesmo cuidado de sempre sobre iniciar conversa com número novo).
app.post('/api/leads/manual', requireAuth, (req, res) => {
  const { telefone, nome_cliente, observacao } = req.body;
  if (!telefone) return res.status(400).json({ erro: 'telefone é obrigatório' });

  const existente = db.prepare(`SELECT id FROM leads WHERE telefone = ? AND status != 'encerrado'`).get(telefone);
  if (existente) return res.status(409).json({ erro: 'já existe uma conversa em aberto com esse telefone' });

  const info = db.prepare(`
    INSERT INTO leads (telefone, nome_cliente, primeira_mensagem, origem, status, vendedor_id)
    VALUES (?, ?, ?, 'manual', 'em_atendimento', ?)
  `).run(telefone, nome_cliente || null, observacao || 'Lead cadastrado manualmente', req.usuario.id);

  db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto) VALUES (?, 'nota', ?)`)
    .run(info.lastInsertRowid, observacao || `Lead cadastrado manualmente por ${req.usuario.nome}`);

  res.status(201).json({ ok: true, lead_id: info.lastInsertRowid });
});

// Encerrar atendimento — só o dono do lead ou o admin. Encerra em 1 clique,
// a análise diária da IA decide resultado/valor/motivo depois, sozinha.
app.post('/api/leads/:id/encerrar', requireAuth, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });

  const dono = lead.vendedor_id === req.usuario.id;
  if (!ehGestor(req.usuario) && !dono) {
    return res.status(403).json({ erro: 'só quem está atendendo (ou o admin) pode encerrar' });
  }

  // Encerra em 1 clique — sem perguntar resultado/valor/motivo aqui.
  // A análise diária da IA lê a conversa depois e preenche isso sozinha
  // (resultado fica null até lá, contando como "aguardando análise").
  db.prepare(`UPDATE leads SET status = 'encerrado' WHERE id = ?`).run(req.params.id);

  res.json({ ok: true });
});

// Reabre manualmente uma conversa encerrada — mesmo dono (ou admin/supervisor)
// que puderam encerrar também podem reabrir. Segue a mesma regra do reabrir
// automático (quando o cliente escreve de novo sozinho): não mexe em
// resultado/valor_venda/motivo_perda já registrados, só volta o status —
// se já tinha uma venda contabilizada, ela continua valendo no relatório.
app.post('/api/leads/:id/reabrir', requireAuth, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });
  if (lead.status !== 'encerrado') {
    return res.status(400).json({ erro: 'esse lead não está encerrado' });
  }

  const dono = lead.vendedor_id === req.usuario.id;
  if (!ehGestor(req.usuario) && !dono) {
    return res.status(403).json({ erro: 'só quem atendeu (ou o admin) pode reabrir essa conversa' });
  }

  // Se o lead nunca teve dono (foi encerrado sem ninguém puxar), quem
  // reabre assume o atendimento — mesma regra do claim normal.
  db.prepare(`UPDATE leads SET status = 'em_atendimento', vendedor_id = ? WHERE id = ?`)
    .run(lead.vendedor_id || req.usuario.id, req.params.id);

  res.json({ ok: true });
});

// Vendedor envia mensagem pro cliente — só o dono do lead ou o admin
app.post('/api/leads/:id/mensagens', requireAuth, async (req, res) => {
  const { texto, midia_base64, midia_tipo, midia_nome } = req.body;
  if (!texto && !midia_base64) {
    return res.status(400).json({ erro: 'texto ou anexo é obrigatório' });
  }

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });

  const dono = lead.vendedor_id === req.usuario.id;
  if (!ehGestor(req.usuario) && !dono) {
    return res.status(403).json({ erro: 'só quem está atendendo (ou o admin) pode responder' });
  }

  const rotulos = { imagem: '[Imagem]', audio: '[Áudio]', video: '[Vídeo]', documento: '[Documento]' };
  const textoFinal = texto || `${rotulos[midia_tipo] || '[Anexo]'}${midia_nome ? ' ' + midia_nome : ''}`;

  // Se achou essa conversa pela busca (encerrada) e decidiu escrever de
  // novo, reabre automaticamente — sem precisar de nenhum passo extra.
  if (lead.status === 'encerrado') {
    db.prepare(`UPDATE leads SET status = 'em_atendimento', vendedor_id = ? WHERE id = ?`)
      .run(lead.vendedor_id || req.usuario.id, req.params.id);
  }

  db.prepare(`INSERT INTO mensagens (lead_id, remetente, texto, midia_url, midia_tipo) VALUES (?, 'vendedor', ?, ?, ?)`)
    .run(req.params.id, textoFinal, midia_base64 || null, midia_tipo || null);

  const envio = midia_base64
    ? await zapi.enviarMidiaWhatsapp(lead.telefone, midia_tipo, midia_base64, midia_nome, texto)
    : await zapi.enviarMensagemWhatsapp(lead.telefone, texto);

  res.status(201).json({ ok: true, enviado_whatsapp: envio.enviado });
});

// ---------------------------------------------------------------
// VENDEDORES
// ---------------------------------------------------------------
app.get('/api/vendedores', requireAuth, (req, res) => {
  const vendedores = db.prepare('SELECT id, nome, login, role FROM vendedores ORDER BY nome ASC').all();
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
  if (ehGestor(req.usuario)) {
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
  if (!ehGestor(req.usuario) && !dono) {
    return res.status(403).json({ erro: 'só quem está atendendo (ou o admin) pode criar tarefa nesse lead' });
  }

  // Só admin pode atribuir a tarefa a outro vendedor; qualquer outro caso, é pra si mesmo
  const vendedorDestino = ehGestor(req.usuario) && vendedor_id ? vendedor_id : req.usuario.id;

  const info = db.prepare(`
    INSERT INTO lembretes (lead_id, vendedor_id, titulo, quando, tipo)
    VALUES (?, ?, ?, ?, ?)
  `).run(lead_id, vendedorDestino, titulo, quando, tipoFinal);

  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// Disparo manual da análise diária (útil pra testar sem esperar 18h, ou se
// o servidor esteve fora do ar na hora automática) — só admin.
app.post('/api/admin/rodar-analise-diaria', requireAuth, requireGestor, async (req, res) => {
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
  if (!ehGestor(req.usuario) && !dono) {
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
  if (!ehGestor(req.usuario) && !dono) {
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
    const indefinidos = leads.filter(l => l.resultado === 'indefinido').length;
    const encerradosPendentes = leads.filter(l => l.status === 'encerrado' && !l.resultado).length;

    return {
      leads_recebidos: recebidos,
      convertidos: convertidos.length,
      perdidos: perdidos.length,
      indefinidos,
      encerrados_aguardando_analise: encerradosPendentes,
      ainda_em_aberto: recebidos - convertidos.length - perdidos.length - indefinidos - encerradosPendentes,
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

// Excluir um lead (e tudo ligado a ele) — só admin. Útil pra limpar dado de
// teste/demonstração, ou remover um lead criado por engano.
app.delete('/api/leads/:id', requireAuth, requireAdmin, (req, res) => {
  const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ erro: 'lead não encontrado' });

  db.prepare('DELETE FROM mensagens WHERE lead_id = ?').run(req.params.id);
  db.prepare('DELETE FROM lembretes WHERE lead_id = ?').run(req.params.id);
  db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);

  res.json({ ok: true });
});

// Limpa de uma vez todos os dados criados pela simulação de demonstração
// (scripts/simulate-demo.js) — leads dos vendedores "*_demo" e os próprios
// vendedores demo. Não mexe em nenhum dado real. Só admin.
app.post('/api/admin/limpar-demo', requireAuth, requireGestor, (req, res) => {
  if (req.usuario.login !== 'admin') {
    return res.status(403).json({ erro: 'ação restrita à conta de desenvolvedor' });
  }
  const vendedoresDemo = db.prepare(`SELECT id FROM vendedores WHERE login LIKE '%\\_demo' ESCAPE '\\'`).all();
  const idsVendedoresDemo = vendedoresDemo.map((v) => v.id);

  const leadsParaApagar = db.prepare(`
    SELECT id FROM leads WHERE telefone LIKE '1199111%' ${idsVendedoresDemo.length > 0 ? `OR vendedor_id IN (${idsVendedoresDemo.join(',')})` : ''}
  `).all();

  let leadsApagados = 0;
  for (const lead of leadsParaApagar) {
    db.prepare('DELETE FROM mensagens WHERE lead_id = ?').run(lead.id);
    db.prepare('DELETE FROM lembretes WHERE lead_id = ?').run(lead.id);
    db.prepare('DELETE FROM leads WHERE id = ?').run(lead.id);
    leadsApagados++;
  }

  let vendedoresApagados = 0;
  for (const id of idsVendedoresDemo) {
    db.prepare('DELETE FROM lembretes WHERE vendedor_id = ?').run(id);
    db.prepare('DELETE FROM vendedores WHERE id = ?').run(id);
    vendedoresApagados++;
  }

  res.json({ ok: true, leads_apagados: leadsApagados, vendedores_demo_apagados: vendedoresApagados });
});

app.get('/api/relatorio', requireAuth, (req, res) => {
  if (req.usuario.role === 'supervisor') {
    return res.status(403).json({ erro: 'relatório não disponível pra esse nível de acesso' });
  }
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
