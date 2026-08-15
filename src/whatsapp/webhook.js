// Webhook da WhatsApp Cloud API.
//  - GET  /webhook  -> a Meta valida o endpoint (verify token)
//  - POST /webhook  -> a Meta entrega cada mensagem recebida
// Ao receber, o sistema: acha/cria o contato e a conversa, salva a mensagem,
// renova a janela de 24h, marca "aguardando" e pede uma sugestão à IA.
import express from 'express';
import { config } from '../config.js';
import { query, temPool } from '../db/pool.js';
import { novaExpiracaoJanela } from '../economia/motor.js';
import { sugerirResposta } from '../ia/sugestao.js';
import { escolherResponsavel } from '../atendimento/distribuicao.js';

export const webhookRouter = express.Router();

// 1) Verificação do endpoint (a Meta chama isso uma vez ao configurar)
webhookRouter.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    console.log('[webhook] verificado pela Meta.');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 2) Recebimento de mensagens
webhookRouter.post('/webhook', async (req, res) => {
  // Responde 200 rápido (a Meta reenvia se demorar). Processa depois.
  res.sendStatus(200);
  // log de diagnóstico: confirma que QUALQUER evento da Meta chegou aqui
  console.log('[webhook] POST recebido da Meta.');
  try {
    await processarEntrada(req.body);
  } catch (e) {
    console.error('[webhook] erro ao processar:', e.message);
  }
});

async function processarEntrada(body) {
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0]?.value;

  // status de entrega das mensagens que NÓS enviamos (sent/delivered/read/failed).
  // É aqui que a Meta conta se a entrega falhou e por quê.
  const status = change?.statuses?.[0];
  if (status) {
    if (status.status === 'failed' || status.errors) {
      console.error(`[webhook] ✗ ENTREGA FALHOU (${status.status}) para ${status.recipient_id}:`,
        JSON.stringify(status.errors || {}));
    } else {
      console.log(`[webhook] status: ${status.status} → ${status.recipient_id}`);
    }
    return;
  }

  const msg = change?.messages?.[0];
  if (!msg) return; // outro tipo de evento, ignora

  const telefone = msg.from;
  const texto = msg.text?.body || `[${msg.type}]`;
  const nomeContato = change?.contacts?.[0]?.profile?.name || null;
  const waId = msg.id;

  console.log(`[webhook] entrada de ${telefone}: ${texto}`);

  if (!temPool()) return; // modo demo: só logou

  // por ora, tudo cai na primeira academia cadastrada (Fase 1 = 1 número).
  // Multi-academia: mapear pelo phone_number_id de change.metadata.
  const ac = await query(`SELECT id FROM academias ORDER BY id LIMIT 1`);
  if (ac.rows.length === 0) return;
  const academiaId = ac.rows[0].id;

  // contato (cria se não existe)
  const ct = await query(
    `INSERT INTO contatos (academia_id, telefone, nome)
       VALUES ($1,$2,$3)
     ON CONFLICT (academia_id, telefone)
       DO UPDATE SET nome = COALESCE(contatos.nome, EXCLUDED.nome)
     RETURNING id`,
    [academiaId, telefone, nomeContato]
  );
  const contatoId = ct.rows[0].id;

  // conversa aberta mais recente, ou cria nova
  let conv = await query(
    `SELECT id FROM conversas
      WHERE academia_id=$1 AND contato_id=$2 AND status <> 'resolvido'
      ORDER BY ultima_msg_em DESC LIMIT 1`,
    [academiaId, contatoId]
  );
  let conversaId;
  if (conv.rows.length === 0) {
    // distribuição automática: escolhe um vendedor disponível pra esse lead
    const unidadeContato = (await query(
      `SELECT unidade_id FROM contatos WHERE id=$1`, [contatoId]
    )).rows[0]?.unidade_id ?? null;
    const responsavel = await escolherResponsavel(academiaId, unidadeContato);
    const nova = await query(
      `INSERT INTO conversas (academia_id, contato_id, unidade_id, responsavel_id, status, janela_expira_em, ultima_msg_em)
         VALUES ($1,$2,$3,$4,'aguardando',$5, now()) RETURNING id`,
      [academiaId, contatoId, unidadeContato, responsavel, novaExpiracaoJanela()]
    );
    conversaId = nova.rows[0].id;
  } else {
    conversaId = conv.rows[0].id;
    // mensagem do cliente renova a janela de 24h e volta pra "aguardando"
    await query(
      `UPDATE conversas
          SET status='aguardando', janela_expira_em=$2, ultima_msg_em=now()
        WHERE id=$1`,
      [conversaId, novaExpiracaoJanela()]
    );
  }

  // salva a mensagem
  await query(
    `INSERT INTO mensagens (conversa_id, direcao, conteudo, wa_message_id)
       VALUES ($1,'entrada',$2,$3)`,
    [conversaId, texto, waId]
  );

  // pede uma sugestão à IA e guarda como tarefa "rascunho" (o atendente vê no painel)
  try {
    const hist = await query(
      `SELECT direcao, conteudo FROM mensagens
        WHERE conversa_id=$1 ORDER BY criada_em ASC`,
      [conversaId]
    );
    const sugestao = await sugerirResposta({
      contatoNome: nomeContato,
      historico: hist.rows,
    });
    await query(
      `INSERT INTO tarefas (academia_id, conversa_id, titulo, detalhe, origem)
         VALUES ($1,$2,$3,$4,'curadoria')`,
      [academiaId, conversaId, 'Sugestão de resposta da IA', sugestao]
    );
  } catch (e) {
    console.error('[webhook] IA falhou (segue sem sugestão):', e.message);
  }
}
