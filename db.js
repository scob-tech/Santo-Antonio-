// db.js
// Banco local em SQLite, usando o módulo node:sqlite que já vem
// EMBUTIDO no Node.js (desde a v22) — não precisa instalar nada, não
// precisa compilar código, não precisa de Python nem build tools.
// Quando formos integrar de verdade, migramos essas mesmas tabelas
// para o Supabase (Postgres) sem mudar a lógica do app.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const auth = require('./auth');

// Em produção (Railway), DATA_DIR aponta pro Volume permanente conectado
// ao serviço — sem isso, o banco vive no disco do container e some a
// cada redeploy. Localmente, sem a variável, continua salvando do lado
// do server.js como sempre foi.
const dataDir = process.env.DATA_DIR || __dirname;
const db = new DatabaseSync(path.join(dataDir, 'data.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS vendedores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    disponivel INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefone TEXT NOT NULL,
    nome_cliente TEXT,
    primeira_mensagem TEXT NOT NULL,
    origem TEXT NOT NULL DEFAULT 'geral',       -- de qual ícone/página do site veio: produtos | duvidas | geral | ...
    status TEXT NOT NULL DEFAULT 'novo',      -- novo | em_atendimento | encerrado
    vendedor_id INTEGER,                       -- null até alguem puxar
    criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    FOREIGN KEY (vendedor_id) REFERENCES vendedores(id)
  );

  CREATE TABLE IF NOT EXISTS mensagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    remetente TEXT NOT NULL,   -- 'cliente' | 'vendedor' | 'ia'
    texto TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  );

  CREATE TABLE IF NOT EXISTS lembretes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    vendedor_id INTEGER,
    titulo TEXT NOT NULL,
    quando TEXT NOT NULL,
    feito INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  );

  -- Um "endereço" de notificação por navegador/aparelho em que o vendedor
  -- ativou. Uma pessoa pode ter mais de um (celular + computador), por
  -- isso não é uma coluna na tabela vendedores, é tabela própria.
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendedor_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    FOREIGN KEY (vendedor_id) REFERENCES vendedores(id)
  );

  -- Identidade do servidor pra poder mandar push (protocolo VAPID).
  -- Gerada sozinha na primeira vez que o servidor sobe (ver getOuCriarChavesVapid
  -- abaixo) e guardada aqui, no Volume persistente — assim não precisa
  -- configurar nenhuma variável manual no Railway pra isso funcionar.
  CREATE TABLE IF NOT EXISTS vapid_keys (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL
  );
`);

// ---------------------------------------------------------------
// MIGRAÇÕES: adiciona colunas novas em bancos que já existiam antes
// do sistema de login (sem apagar nenhum dado existente).
// ---------------------------------------------------------------
function colunaExiste(tabela, coluna) {
  const info = db.prepare(`PRAGMA table_info(${tabela})`).all();
  return info.some((c) => c.name === coluna);
}

if (!colunaExiste('vendedores', 'login')) {
  db.exec(`ALTER TABLE vendedores ADD COLUMN login TEXT`);
}
if (!colunaExiste('vendedores', 'senha_hash')) {
  db.exec(`ALTER TABLE vendedores ADD COLUMN senha_hash TEXT`);
}
if (!colunaExiste('vendedores', 'role')) {
  db.exec(`ALTER TABLE vendedores ADD COLUMN role TEXT NOT NULL DEFAULT 'vendedor'`);
}
if (!colunaExiste('leads', 'interesse')) {
  db.exec(`ALTER TABLE leads ADD COLUMN interesse TEXT`);
}
// resultado do atendimento — preenchido obrigatoriamente ao encerrar
if (!colunaExiste('leads', 'resultado')) {
  db.exec(`ALTER TABLE leads ADD COLUMN resultado TEXT`); // 'convertido' | 'perdido'
}
if (!colunaExiste('leads', 'valor_venda')) {
  db.exec(`ALTER TABLE leads ADD COLUMN valor_venda REAL`);
}
if (!colunaExiste('leads', 'motivo_perda')) {
  db.exec(`ALTER TABLE leads ADD COLUMN motivo_perda TEXT`);
}
// tipo de ação do lembrete — alimenta a "agenda do dia seguinte"
if (!colunaExiste('lembretes', 'tipo')) {
  db.exec(`ALTER TABLE lembretes ADD COLUMN tipo TEXT NOT NULL DEFAULT 'outro'`);
}
// mídia recebida (imagem, áudio, vídeo, documento, sticker) — guardamos a URL
// e o tipo pra poder exibir direto no chat, sem precisar abrir o WhatsApp
if (!colunaExiste('mensagens', 'midia_url')) {
  db.exec(`ALTER TABLE mensagens ADD COLUMN midia_url TEXT`);
}
if (!colunaExiste('mensagens', 'midia_tipo')) {
  db.exec(`ALTER TABLE mensagens ADD COLUMN midia_tipo TEXT`);
}
// marca quando o dono (ou gestor) abriu a conversa pela última vez —
// alimenta o badge de "mensagem não lida" nas Conversas Ativas
if (!colunaExiste('leads', 'visto_em')) {
  db.exec(`ALTER TABLE leads ADD COLUMN visto_em TEXT`);
}

// ---------------------------------------------------------------
// Garante que sempre existe pelo menos 1 administrador.
// Login: admin / Senha: admin123 — TROCAR depois do primeiro acesso
// (ainda não existe tela de troca de senha; se precisar mudar, me avisa).
// ---------------------------------------------------------------
const existeAdmin = db.prepare(`SELECT id FROM vendedores WHERE role = 'admin'`).get();
if (!existeAdmin) {
  const senha_hash = auth.hashSenha('admin123');
  db.prepare(`
    INSERT INTO vendedores (nome, login, senha_hash, role, disponivel)
    VALUES ('Administrador', 'admin', ?, 'admin', 1)
  `).run(senha_hash);
  console.log('>> Conta admin criada — login: admin | senha: admin123 (troque assim que possível)');
}

// ---------------------------------------------------------------
// Chaves VAPID pra notificação push — gera na primeira vez que o servidor
// sobe e guarda no banco (Volume persistente), pra sempre usar as MESMAS
// chaves depois disso. Trocar a chave pública invalidaria toda inscrição
// de notificação que os vendedores já tivessem ativado.
// ---------------------------------------------------------------
function getOuCriarChavesVapid() {
  const existente = db.prepare(`SELECT public_key, private_key FROM vapid_keys WHERE id = 1`).get();
  if (existente) return { publicKey: existente.public_key, privateKey: existente.private_key };

  const webpush = require('web-push');
  const chaves = webpush.generateVAPIDKeys();
  db.prepare(`INSERT INTO vapid_keys (id, public_key, private_key) VALUES (1, ?, ?)`)
    .run(chaves.publicKey, chaves.privateKey);
  console.log('>> Chaves VAPID geradas e salvas (primeira vez) — notificação push pronta pra uso.');
  return { publicKey: chaves.publicKey, privateKey: chaves.privateKey };
}

module.exports = db;
module.exports.getOuCriarChavesVapid = getOuCriarChavesVapid;
