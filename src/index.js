// Ponto de entrada. Sobe o Express, monta o webhook da Meta, a API do painel,
// serve os arquivos estáticos do painel e liga o agendador.
// Regra de ouro: NADA aqui deve quebrar por falta de credencial — sem banco,
// sem Meta ou sem IA, o sistema sobe em modo demo pra você ver a tela.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { config, resumoAmbiente } from './config.js';
import { initDb } from './db/init.js';
import { webhookRouter } from './whatsapp/webhook.js';
import { subscribeToWaba } from './whatsapp/subscribe.js';
import { painelRouter } from './routes/painel.js';
import { login } from './auth/auth.js';
import { iniciarAgendador } from './cron/agendador.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// saúde (o Railway usa pra saber se está no ar)
app.get('/health', (req, res) => res.json({ ok: true, ambiente: resumoAmbiente() }));

// login (devolve o papel escolhido)
app.post('/api/login', (req, res) => {
  const r = login({ senha: req.body?.senha, papel: req.body?.papel });
  if (!r.ok) return res.status(401).json(r);
  res.json(r);
});

// webhook da Meta (só casa com /webhook; senão passa adiante)
app.use('/', webhookRouter);

// arquivos estáticos do painel (index.html, painel.html, app.js, styles.css).
// Vem ANTES da API: assim a home e os assets nunca esbarram no middleware de
// login da API. Se não achar arquivo, segue pra próxima rota.
app.use('/', express.static(join(__dirname, '..', 'public')));

// API do painel (protegida por papel)
app.use('/', painelRouter);

const port = config.port;

(async () => {
  try {
    await initDb(); // cria tabelas + seed se houver banco
  } catch (e) {
    console.error('[boot] initDb falhou (sigo em modo demo):', e.message);
  }

  app.listen(port, () => {
    console.log('==============================================');
    console.log('  scobtech · Atendimento WhatsApp + IA');
    console.log('  no ar em http://localhost:' + port);
    console.log('  ambiente:', JSON.stringify(resumoAmbiente()));
    console.log('==============================================');
  });

  iniciarAgendador();
  subscribeToWaba(); // liga o recebimento das mensagens do número (WABA)
})();
