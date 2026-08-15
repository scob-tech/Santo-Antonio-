// API que alimenta o painel web. Tudo aqui respeita o "papel" do usuário:
//   - gerente     -> vê a rede toda + relatório da IA
//   - coordenador -> vê a unidade dele + gargalos
//   - vendedor    -> vê só os atendimentos dele + metas
import express from 'express';
import { query, temPool } from '../db/pool.js';
import { exigirPapel } from '../auth/auth.js';
import { detectarGargalos } from '../ia/gargalos.js';
import { curadoriaDoDia } from '../ia/curadoria.js';
import { decidirEnvio, sugerirCategoria, CUSTOS_REF } from '../economia/motor.js';
import { enviarTexto, enviarTemplate } from '../whatsapp/send.js';
import { escolherResponsavel } from '../atendimento/distribuicao.js';

export const painelRouter = express.Router();

// dados demo pra quando não há banco (você vê a tela mesmo sem Postgres)
const DEMO = {
  conversas: [
    { id: 1, contato: 'Ana Souza', unidade: 'Patriarca', status: 'aguardando', ultima: 'Oi, queria saber o valor do plano', tipo: 'lead', janela_aberta: true },
    { id: 2, contato: 'Bruno Lima', unidade: 'Vila Matilde', status: 'parado', ultima: 'Meu contrato vence esse mês, como renovo?', tipo: 'aluno', janela_aberta: false },
  ],
  metas: [
    { unidade: 'Patriarca', alvo: 40, realizado: 27 },
    { unidade: 'Arthur Alvim', alvo: 35, realizado: 31 },
  ],
};

painelRouter.use(exigirPapel);

// resumo do topo (números)
painelRouter.get('/api/resumo', async (req, res) => {
  if (!temPool()) {
    return res.json({
      demo: true,
      aguardando: 1, emAtendimento: 0, parados: 1,
      metas: DEMO.metas,
    });
  }
  const ac = await primeiraAcademia();
  const q = async (sql) => (await query(sql, [ac])).rows[0].n;
  const aguardando = await q(`SELECT COUNT(*)::int n FROM conversas WHERE academia_id=$1 AND status='aguardando'`);
  const emAtendimento = await q(`SELECT COUNT(*)::int n FROM conversas WHERE academia_id=$1 AND status='em_atendimento'`);
  const parados = await q(`SELECT COUNT(*)::int n FROM conversas WHERE academia_id=$1 AND status='parado'`);
  const metas = (await query(
    `SELECT u.nome AS unidade, m.alvo, m.realizado
       FROM metas m LEFT JOIN unidades u ON u.id=m.unidade_id
      WHERE m.academia_id=$1 ORDER BY u.nome`, [ac]
  )).rows;
  res.json({ aguardando, emAtendimento, parados, metas });
});

// lista de conversas (inbox)
painelRouter.get('/api/conversas', async (req, res) => {
  if (!temPool()) return res.json({ demo: true, conversas: DEMO.conversas });
  const ac = await primeiraAcademia();
  const { rows } = await query(
    `SELECT c.id, ct.nome AS contato, ct.tipo, u.nome AS unidade, c.status,
            resp.nome AS responsavel,
            (c.janela_expira_em > now()) AS janela_aberta,
            (SELECT conteudo FROM mensagens m WHERE m.conversa_id=c.id
              ORDER BY m.criada_em DESC LIMIT 1) AS ultima
       FROM conversas c
       JOIN contatos ct ON ct.id=c.contato_id
       LEFT JOIN unidades u ON u.id=c.unidade_id
       LEFT JOIN usuarios resp ON resp.id=c.responsavel_id
      WHERE c.academia_id=$1 AND c.status <> 'resolvido'
      ORDER BY c.ultima_msg_em DESC LIMIT 100`, [ac]
  );
  res.json({ conversas: rows });
});

// detalhe de uma conversa (mensagens + sugestão da IA + decisão de envio)
painelRouter.get('/api/conversas/:id', async (req, res) => {
  if (!temPool()) {
    return res.json({
      demo: true,
      mensagens: [{ direcao: 'entrada', conteudo: 'Oi, queria saber o valor do plano' }],
      sugestao: '[IA simulada] "Oi! Nosso plano único dá acesso a todas as modalidades. Quer as condições?"',
      envio: { meio: 'texto_livre', motivo: 'Janela de 24h aberta — resposta grátis.' },
    });
  }
  const id = parseInt(req.params.id, 10);
  const conv = (await query(`SELECT * FROM conversas WHERE id=$1`, [id])).rows[0];
  if (!conv) return res.status(404).json({ erro: 'Conversa não encontrada.' });
  const mensagens = (await query(
    `SELECT direcao, conteudo, categoria, criada_em FROM mensagens
      WHERE conversa_id=$1 ORDER BY criada_em ASC`, [id]
  )).rows;
  const sugestaoTarefa = (await query(
    `SELECT detalhe FROM tarefas WHERE conversa_id=$1 AND titulo LIKE 'Sugest%'
      ORDER BY criada_em DESC LIMIT 1`, [id]
  )).rows[0];
  res.json({
    mensagens,
    sugestao: sugestaoTarefa?.detalhe || null,
    envio: decidirEnvio(conv),
    desfecho: conv.desfecho || null,
  });
});

// enviar resposta (o motor decide texto livre vs template)
painelRouter.post('/api/conversas/:id/responder', async (req, res) => {
  const texto = (req.body?.texto || '').trim();
  if (!texto) return res.status(400).json({ erro: 'Texto vazio.' });

  if (!temPool()) {
    const cat = sugerirCategoria(texto);
    return res.json({ demo: true, enviado: true, categoria: cat.categoria, aviso: cat.aviso });
  }
  const id = parseInt(req.params.id, 10);
  const conv = (await query(
    `SELECT c.*, ct.telefone FROM conversas c JOIN contatos ct ON ct.id=c.contato_id
      WHERE c.id=$1`, [id]
  )).rows[0];
  if (!conv) return res.status(404).json({ erro: 'Conversa não encontrada.' });

  const decisao = decidirEnvio(conv);
  let categoria = 'texto_livre';
  try {
    if (decisao.meio === 'texto_livre') {
      await enviarTexto(conv.telefone, texto);
    } else {
      // janela fechada: na prática iria por template aprovado. Aqui registramos
      // a categoria sugerida pra você ver o custo. (Trocar pelo template real.)
      categoria = sugerirCategoria(texto).categoria;
      // await enviarTemplate(conv.telefone, 'seu_template', 'pt_BR', [...]);
    }
    await query(
      `INSERT INTO mensagens (conversa_id, direcao, conteudo, categoria)
         VALUES ($1,'saida',$2,$3)`, [id, texto, categoria]
    );
    // marca a 1ª resposta (para o TMPR) só na primeira vez
    await query(
      `UPDATE conversas
          SET status='em_atendimento', ultima_msg_em=now(),
              primeira_resposta_em = COALESCE(primeira_resposta_em, now())
        WHERE id=$1`, [id]
    );
    res.json({ enviado: true, meio: decisao.meio, categoria, custo: CUSTOS_REF[categoria] ?? 0 });
  } catch (e) {
    res.status(502).json({ erro: e.message });
  }
});

// enviar um template aprovado DENTRO de uma conversa já aberta
// (necessário quando a janela de 24h fechou — só template entrega)
painelRouter.post('/api/conversas/:id/enviar-template', async (req, res) => {
  const { templateId, variaveis } = req.body || {};
  if (!templateId) return res.status(400).json({ erro: 'Escolha um template.' });

  if (!temPool()) {
    return res.json({ demo: true, enviado: true, categoria: 'utility',
      aviso: 'Modo demo: em produção o template é enviado pela Meta.' });
  }
  const id = parseInt(req.params.id, 10);
  const conv = (await query(
    `SELECT c.*, ct.telefone FROM conversas c JOIN contatos ct ON ct.id=c.contato_id
      WHERE c.id=$1`, [id]
  )).rows[0];
  if (!conv) return res.status(404).json({ erro: 'Conversa não encontrada.' });

  const tpl = (await query(
    `SELECT * FROM templates WHERE id=$1 AND academia_id=$2`, [templateId, conv.academia_id]
  )).rows[0];
  if (!tpl) return res.status(404).json({ erro: 'Template não encontrado.' });

  const vars = Array.isArray(variaveis) ? variaveis : [];
  const texto = tpl.corpo.replace(/\{\{(\d+)\}\}/g, (_, n) => vars[Number(n) - 1] || `{{${n}}}`);

  let enviado = false, aviso = null;
  try {
    const comps = vars.length
      ? [{ type: 'body', parameters: vars.map((v) => ({ type: 'text', text: String(v) })) }] : [];
    await enviarTemplate(conv.telefone, tpl.nome, 'pt_BR', comps);
    enviado = true;
  } catch (e) {
    aviso = 'Registrado no painel, mas o envio pela Meta falhou: ' + e.message;
  }
  await query(
    `INSERT INTO mensagens (conversa_id, direcao, conteudo, categoria) VALUES ($1,'saida',$2,$3)`,
    [id, texto, tpl.categoria]
  );
  await query(
    `UPDATE conversas
        SET status='em_atendimento', ultima_msg_em=now(),
            primeira_resposta_em = COALESCE(primeira_resposta_em, now())
      WHERE id=$1`, [id]
  );
  res.json({ ok: true, enviado, aviso, categoria: tpl.categoria, custo: CUSTOS_REF[tpl.categoria] ?? 0 });
});

// gargalos (coordenador/gerente)
painelRouter.get('/api/gargalos', async (req, res) => {
  const ac = temPool() ? await primeiraAcademia() : null;
  const lista = await detectarGargalos(ac);
  res.json({ gargalos: lista });
});

// dispara curadoria manualmente (botão no painel do gerente)
painelRouter.post('/api/curadoria', async (req, res) => {
  const ac = temPool() ? await primeiraAcademia() : null;
  const r = await curadoriaDoDia(ac);
  res.json(r);
});

// tarefas do dia
painelRouter.get('/api/tarefas', async (req, res) => {
  if (!temPool()) {
    return res.json({ demo: true, tarefas: [
      { titulo: 'Retornar Ana Souza (lead sem resposta)', origem: 'curadoria', feita: false },
      { titulo: 'Renovação Bruno Lima (contrato vencendo)', origem: 'curadoria', feita: false },
    ]});
  }
  const ac = await primeiraAcademia();
  const { rows } = await query(
    `SELECT id, titulo, detalhe, origem, feita FROM tarefas
      WHERE academia_id=$1 AND feita=false AND titulo NOT LIKE 'Sugest%'
      ORDER BY criada_em DESC LIMIT 50`, [ac]
  );
  res.json({ tarefas: rows });
});

// ==========================================================================
//  Dashboard: números + séries pros gráficos da "Visão geral".
//  Em modo demo devolve dados de exemplo pra você ver as telas.
// ==========================================================================
painelRouter.get('/api/dashboard', async (req, res) => {
  if (!temPool()) return res.json(dashboardDemo());

  const ac = await primeiraAcademia();

  // KPIs
  const kpi = async (sql) => (await query(sql, [ac])).rows[0].n;
  const aguardando = await kpi(`SELECT COUNT(*)::int n FROM conversas WHERE academia_id=$1 AND status='aguardando'`);
  const emAtendimento = await kpi(`SELECT COUNT(*)::int n FROM conversas WHERE academia_id=$1 AND status='em_atendimento'`);
  const parados = await kpi(`SELECT COUNT(*)::int n FROM conversas WHERE academia_id=$1 AND status='parado'`);
  const resolvidos = await kpi(`SELECT COUNT(*)::int n FROM conversas WHERE academia_id=$1 AND status='resolvido'`);
  const tarefas = await kpi(`SELECT COUNT(*)::int n FROM tarefas WHERE academia_id=$1 AND feita=false`);

  // conversas (mensagens de entrada) por dia — últimos 7 dias
  const porDia = (await query(
    `SELECT to_char(d::date,'DD/MM') AS dia,
            COALESCE(e.entradas,0) AS entradas,
            COALESCE(s.saidas,0)  AS saidas
       FROM generate_series(now()::date - interval '6 days', now()::date, interval '1 day') d
       LEFT JOIN (
         SELECT date_trunc('day', m.criada_em) dd, COUNT(*) entradas
           FROM mensagens m JOIN conversas c ON c.id=m.conversa_id
          WHERE c.academia_id=$1 AND m.direcao='entrada'
            AND m.criada_em > now() - interval '7 days'
          GROUP BY 1) e ON e.dd = d
       LEFT JOIN (
         SELECT date_trunc('day', m.criada_em) dd, COUNT(*) saidas
           FROM mensagens m JOIN conversas c ON c.id=m.conversa_id
          WHERE c.academia_id=$1 AND m.direcao='saida'
            AND m.criada_em > now() - interval '7 days'
          GROUP BY 1) s ON s.dd = d
      ORDER BY d`, [ac]
  )).rows;

  // distribuição de status
  const statusDist = (await query(
    `SELECT status, COUNT(*)::int n FROM conversas WHERE academia_id=$1 GROUP BY status`, [ac]
  )).rows;

  // economia: contagem de saídas por categoria
  const cats = (await query(
    `SELECT COALESCE(categoria,'texto_livre') categoria, COUNT(*)::int n
       FROM mensagens m JOIN conversas c ON c.id=m.conversa_id
      WHERE c.academia_id=$1 AND m.direcao='saida'
      GROUP BY 1`, [ac]
  )).rows;
  const economia = calcularEconomia(cats);

  // metas
  const metas = (await query(
    `SELECT u.nome AS unidade, m.alvo, m.realizado
       FROM metas m LEFT JOIN unidades u ON u.id=m.unidade_id
      WHERE m.academia_id=$1 ORDER BY u.nome`, [ac]
  )).rows;

  const tempos = await calcularTempos(ac);

  res.json({
    kpis: { aguardando, emAtendimento, parados, resolvidos, tarefas },
    porDia, statusDist, economia, metas, tempos,
  });
});

// custo por categoria (referência Meta Brasil). Economia = quanto você
// deixaria de gastar mandando tudo como marketing.
function calcularEconomia(cats) {
  const custoUnit = { texto_livre: 0, utility: 0.035, authentication: 0.035, template: 0.035, marketing: 0.3217 };
  let totalMsgs = 0, custoReal = 0;
  const porCategoria = {};
  for (const { categoria, n } of cats) {
    totalMsgs += n;
    custoReal += (custoUnit[categoria] ?? 0) * n;
    porCategoria[categoria] = n;
  }
  const custoSeTudoMarketing = totalMsgs * custoUnit.marketing;
  return {
    totalMsgs,
    porCategoria,
    custoReal: +custoReal.toFixed(2),
    custoSeTudoMarketing: +custoSeTudoMarketing.toFixed(2),
    economia: +(custoSeTudoMarketing - custoReal).toFixed(2),
  };
}

function dashboardDemo() {
  const dias = ['05/08','06/08','07/08','08/08','09/08','10/08','11/08'];
  return {
    demo: true,
    kpis: { aguardando: 4, emAtendimento: 7, parados: 3, resolvidos: 28, tarefas: 9 },
    porDia: dias.map((dia, i) => ({
      dia,
      entradas: [22, 31, 28, 35, 40, 18, 26][i],
      saidas:   [20, 29, 27, 33, 38, 16, 24][i],
    })),
    statusDist: [
      { status: 'aguardando', n: 4 },
      { status: 'em_atendimento', n: 7 },
      { status: 'parado', n: 3 },
      { status: 'resolvido', n: 28 },
    ],
    economia: {
      totalMsgs: 187,
      porCategoria: { texto_livre: 150, utility: 30, marketing: 7 },
      custoReal: +(30 * 0.035 + 7 * 0.3217).toFixed(2),
      custoSeTudoMarketing: +(187 * 0.3217).toFixed(2),
      economia: +(187 * 0.3217 - (30 * 0.035 + 7 * 0.3217)).toFixed(2),
    },
    metas: [
      { unidade: 'Patriarca', alvo: 40, realizado: 27 },
      { unidade: 'Arthur Alvim', alvo: 35, realizado: 31 },
      { unidade: 'Penha', alvo: 38, realizado: 22 },
      { unidade: 'Vila Matilde', alvo: 30, realizado: 25 },
      { unidade: 'Jardim Popular', alvo: 28, realizado: 19 },
    ],
    tempos: { tmpr: '7min', tma: '1h12' },
  };
}

// ==========================================================================
//  RESPOSTAS RÁPIDAS (atalhos de mensagem)
// ==========================================================================
const RESPOSTAS_DEMO = [
  { atalho: '/valores', titulo: 'Valores do plano', texto: 'Nosso plano único dá acesso a todas as modalidades. Quer que eu te passe as condições da unidade mais perto de você?' },
  { atalho: '/horarios', titulo: 'Horário de funcionamento', texto: 'Funcionamos de segunda a sexta das 6h às 23h, e aos sábados das 8h às 14h.' },
  { atalho: '/experimental', titulo: 'Aula experimental', texto: 'Podemos agendar uma aula experimental gratuita. Qual dia e horário fica melhor?' },
];

painelRouter.get('/api/respostas', async (req, res) => {
  if (!temPool()) return res.json({ demo: true, respostas: RESPOSTAS_DEMO });
  const ac = await primeiraAcademia();
  const { rows } = await query(
    `SELECT id, atalho, titulo, texto FROM respostas_rapidas
      WHERE academia_id=$1 ORDER BY atalho`, [ac]
  );
  res.json({ respostas: rows });
});

painelRouter.post('/api/respostas', async (req, res) => {
  const { atalho, titulo, texto } = req.body || {};
  if (!atalho || !titulo || !texto) return res.status(400).json({ erro: 'Preencha atalho, título e texto.' });
  if (!temPool()) return res.json({ demo: true, ok: true });
  const ac = await primeiraAcademia();
  const at = atalho.startsWith('/') ? atalho : '/' + atalho;
  await query(
    `INSERT INTO respostas_rapidas (academia_id, atalho, titulo, texto) VALUES ($1,$2,$3,$4)`,
    [ac, at, titulo, texto]
  );
  res.json({ ok: true });
});

// ==========================================================================
//  DISPARO — iniciar conversa mandando um template aprovado
// ==========================================================================
painelRouter.get('/api/templates', async (req, res) => {
  if (!temPool()) {
    return res.json({ demo: true, templates: [
      { id: 1, nome: 'renovacao_util', categoria: 'utility', corpo: 'Olá, {{1}}! Aqui é da Academia DANDY, unidade {{2}}. Seu plano vence em {{3}}. Para renovar, responda esta mensagem.' },
      { id: 2, nome: 'boas_vindas', categoria: 'utility', corpo: 'Olá, {{1}}! Sua matrícula na Academia DANDY (unidade {{2}}) foi confirmada. Bons treinos!' },
      { id: 3, nome: 'promo_mes', categoria: 'marketing', corpo: 'Olá, {{1}}! Temos uma condição especial este mês. Quer saber os detalhes?' },
    ]});
  }
  const ac = await primeiraAcademia();
  const { rows } = await query(
    `SELECT id, nome, categoria, corpo FROM templates WHERE academia_id=$1 AND aprovado=true ORDER BY categoria, nome`, [ac]
  );
  res.json({ templates: rows });
});

// dispara um template pra um número e abre a conversa no painel
painelRouter.post('/api/iniciar-conversa', async (req, res) => {
  const { nome, telefone, templateId, variaveis } = req.body || {};
  const tel = String(telefone || '').replace(/\D/g, '');
  if (!tel || !templateId) return res.status(400).json({ erro: 'Informe o número e o template.' });

  if (!temPool()) return res.json({ demo: true, ok: true, aviso: 'Modo demo: em produção, o template é enviado pela Meta.' });

  const ac = await primeiraAcademia();
  const tpl = (await query(`SELECT * FROM templates WHERE id=$1 AND academia_id=$2`, [templateId, ac])).rows[0];
  if (!tpl) return res.status(404).json({ erro: 'Template não encontrado.' });

  // monta o texto preenchendo {{1}},{{2}}... com as variáveis
  const vars = Array.isArray(variaveis) ? variaveis : [];
  const texto = tpl.corpo.replace(/\{\{(\d+)\}\}/g, (_, n) => vars[Number(n) - 1] || `{{${n}}}`);

  // contato + conversa
  const ct = await query(
    `INSERT INTO contatos (academia_id, telefone, nome) VALUES ($1,$2,$3)
     ON CONFLICT (academia_id, telefone) DO UPDATE SET nome=COALESCE(contatos.nome, EXCLUDED.nome) RETURNING id`,
    [ac, tel, nome || null]
  );
  const responsavel = await escolherResponsavel(ac, null);
  const conv = await query(
    `INSERT INTO conversas (academia_id, contato_id, responsavel_id, status, ultima_msg_em, primeira_resposta_em)
     VALUES ($1,$2,$3,'em_atendimento', now(), now()) RETURNING id`,
    [ac, ct.rows[0].id, responsavel]
  );
  const convId = conv.rows[0].id;

  // envia o template (real se tiver credencial; senão registra em modo demo)
  let enviado = false, aviso = null;
  try {
    const comps = vars.length
      ? [{ type: 'body', parameters: vars.map((v) => ({ type: 'text', text: String(v) })) }] : [];
    await enviarTemplate(tel, tpl.nome, 'pt_BR', comps);
    enviado = true;
  } catch (e) {
    aviso = 'Registrado no painel, mas o envio pela Meta falhou: ' + e.message;
  }
  await query(
    `INSERT INTO mensagens (conversa_id, direcao, conteudo, categoria) VALUES ($1,'saida',$2,$3)`,
    [convId, texto, tpl.categoria]
  );
  res.json({ ok: true, enviado, aviso, conversaId: convId, custo: CUSTOS_REF[tpl.categoria] ?? 0 });
});

// ==========================================================================
//  DESFECHO (tabulação de venda) — alimenta o funil
// ==========================================================================
const DESFECHOS = ['matriculou', 'ja_aluno', 'vai_pensar', 'sem_interesse', 'sem_resposta'];

painelRouter.post('/api/conversas/:id/desfecho', async (req, res) => {
  const desfecho = req.body?.desfecho;
  if (!DESFECHOS.includes(desfecho)) return res.status(400).json({ erro: 'Desfecho inválido.' });
  if (!temPool()) return res.json({ demo: true, ok: true });
  const id = parseInt(req.params.id, 10);
  const novoStatus = desfecho === 'sem_resposta' ? 'parado' : 'resolvido';
  const r = await query(
    `UPDATE conversas
        SET desfecho=$2, status=$3,
            resolvida_em = CASE WHEN $3='resolvido' THEN now() ELSE resolvida_em END,
            ultima_msg_em = now()
      WHERE id=$1 RETURNING id`, [id, desfecho, novoStatus]
  );
  if (!r.rows.length) return res.status(404).json({ erro: 'Conversa não encontrada.' });
  res.json({ ok: true, desfecho, status: novoStatus });
});

// ==========================================================================
//  JANELAS DE 24h FECHANDO — conversas que vão perder a janela grátis
//  Ajuda o consultor a responder antes de virar template pago.
// ==========================================================================
painelRouter.get('/api/janelas', async (req, res) => {
  if (!temPool()) {
    return res.json({ demo: true, janelas: [
      { id: 1, contato: 'Ana Souza', unidade: 'Patriarca', responsavel: 'Rafael', minutos: 48 },
      { id: 7, contato: 'Marina Alves', unidade: 'Penha', responsavel: 'Camila', minutos: 95 },
      { id: 9, contato: 'Roberto Dias', unidade: 'Patriarca', responsavel: 'Rafael', minutos: 160 },
    ] });
  }
  const ac = await primeiraAcademia();
  // conversas abertas cuja janela expira nas próximas 6 horas
  const { rows } = await query(
    `SELECT c.id, ct.nome AS contato, un.nome AS unidade, resp.nome AS responsavel,
            GREATEST(0, ROUND(EXTRACT(EPOCH FROM (c.janela_expira_em - now()))/60))::int AS minutos
       FROM conversas c
       JOIN contatos ct ON ct.id = c.contato_id
       LEFT JOIN unidades un ON un.id = c.unidade_id
       LEFT JOIN usuarios resp ON resp.id = c.responsavel_id
      WHERE c.academia_id = $1
        AND c.status IN ('aguardando','em_atendimento')
        AND c.janela_expira_em BETWEEN now() AND now() + interval '6 hours'
      ORDER BY c.janela_expira_em ASC
      LIMIT 30`, [ac]
  );
  res.json({ janelas: rows });
});

// ==========================================================================
//  FUNIL DE VENDAS (a partir dos desfechos)
// ==========================================================================
painelRouter.get('/api/funil', async (req, res) => {
  if (!temPool()) return res.json(funilDemo());
  const ac = await primeiraAcademia();

  const totais = (await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status='aguardando')::int AS aguardando,
       COUNT(*) FILTER (WHERE status='em_atendimento')::int AS em_atendimento,
       COUNT(*) FILTER (WHERE desfecho='matriculou')::int AS matriculou,
       COUNT(*) FILTER (WHERE desfecho='ja_aluno')::int AS ja_aluno,
       COUNT(*) FILTER (WHERE desfecho='vai_pensar')::int AS vai_pensar,
       COUNT(*) FILTER (WHERE desfecho='sem_interesse')::int AS sem_interesse,
       COUNT(*) FILTER (WHERE desfecho='sem_resposta')::int AS sem_resposta,
       COUNT(*) FILTER (WHERE desfecho IS NOT NULL)::int AS com_desfecho
     FROM conversas WHERE academia_id=$1`, [ac]
  )).rows[0];

  const conversao = totais.com_desfecho > 0
    ? Math.round((totais.matriculou / totais.com_desfecho) * 100) : 0;

  // conversão por vendedor
  const porVendedor = (await query(
    `SELECT u.nome,
            COUNT(*) FILTER (WHERE c.desfecho IS NOT NULL)::int AS atendimentos,
            COUNT(*) FILTER (WHERE c.desfecho='matriculou')::int AS matriculas
       FROM usuarios u
       LEFT JOIN conversas c ON c.responsavel_id=u.id AND c.academia_id=$1
      WHERE u.academia_id=$1 AND u.papel='vendedor'
      GROUP BY u.id, u.nome
      ORDER BY matriculas DESC`, [ac]
  )).rows.map((v) => ({
    ...v,
    conversao: v.atendimentos > 0 ? Math.round((v.matriculas / v.atendimentos) * 100) : 0,
  }));

  res.json({ totais, conversao, porVendedor });
});

// ==========================================================================
//  EQUIPE (presença + carga + tempos TMA/TMPR)
// ==========================================================================
painelRouter.get('/api/equipe', async (req, res) => {
  if (!temPool()) return res.json(equipeDemo());
  const ac = await primeiraAcademia();

  const equipe = (await query(
    `SELECT u.id, u.nome, u.papel, u.status, un.nome AS unidade,
            (SELECT COUNT(*) FROM conversas c
              WHERE c.responsavel_id=u.id AND c.status IN ('aguardando','em_atendimento'))::int AS abertas
       FROM usuarios u
       LEFT JOIN unidades un ON un.id=u.unidade_id
      WHERE u.academia_id=$1 AND u.papel IN ('vendedor','coordenador')
      ORDER BY (u.status='disponivel') DESC, u.nome`, [ac]
  )).rows;

  const tempos = await calcularTempos(ac);
  res.json({ equipe, tempos });
});

// muda a presença de um usuário (Disponível / Pausa / Indisponível)
painelRouter.post('/api/status', async (req, res) => {
  const { usuarioId, status } = req.body || {};
  const validos = ['disponivel', 'pausa', 'indisponivel'];
  if (!validos.includes(status)) return res.status(400).json({ erro: 'Status inválido.' });
  if (!temPool()) return res.json({ demo: true, ok: true });
  await query(`UPDATE usuarios SET status=$2 WHERE id=$1`, [parseInt(usuarioId, 10), status]);
  res.json({ ok: true });
});

// TMA (tempo médio até resolver) e TMPR (tempo médio até a 1ª resposta)
async function calcularTempos(ac) {
  const r = (await query(
    `SELECT
       AVG(EXTRACT(EPOCH FROM (primeira_resposta_em - criada_em)))
         FILTER (WHERE primeira_resposta_em IS NOT NULL) AS tmpr_s,
       AVG(EXTRACT(EPOCH FROM (resolvida_em - criada_em)))
         FILTER (WHERE resolvida_em IS NOT NULL) AS tma_s
     FROM conversas WHERE academia_id=$1`, [ac]
  )).rows[0];
  return { tmpr: fmtDuracao(r.tmpr_s), tma: fmtDuracao(r.tma_s) };
}
function fmtDuracao(seg) {
  if (seg == null) return '—';
  const s = Math.round(Number(seg));
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
  return `${m}min`;
}

function funilDemo() {
  return {
    demo: true,
    totais: { total: 42, aguardando: 4, em_atendimento: 7, matriculou: 18,
      ja_aluno: 5, vai_pensar: 8, sem_interesse: 3, sem_resposta: 2, com_desfecho: 36 },
    conversao: 58,
    porVendedor: [
      { nome: 'Rafael', atendimentos: 14, matriculas: 9, conversao: 64 },
      { nome: 'Camila', atendimentos: 12, matriculas: 7, conversao: 58 },
      { nome: 'Diego', atendimentos: 5, matriculas: 2, conversao: 40 },
    ],
  };
}
function equipeDemo() {
  return {
    demo: true,
    equipe: [
      { id: 1, nome: 'Rafael', papel: 'vendedor', status: 'disponivel', unidade: 'Patriarca', abertas: 3 },
      { id: 2, nome: 'Camila', papel: 'vendedor', status: 'disponivel', unidade: 'Arthur Alvim', abertas: 2 },
      { id: 3, nome: 'Diego', papel: 'vendedor', status: 'pausa', unidade: 'Patriarca', abertas: 0 },
      { id: 4, nome: 'Juliana (Coord.)', papel: 'coordenador', status: 'disponivel', unidade: 'Arthur Alvim', abertas: 1 },
    ],
    tempos: { tmpr: '7min', tma: '1h12' },
  };
}

async function primeiraAcademia() {
  const { rows } = await query(`SELECT id FROM academias ORDER BY id LIMIT 1`);
  return rows[0]?.id;
}
