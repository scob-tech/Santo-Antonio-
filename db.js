// db.js
// Banco local em SQLite, usando o módulo node:sqlite que já vem
// EMBUTIDO no Node.js (desde a v22) — não precisa instalar nada, não
// precisa compilar código, não precisa de Python nem build tools.
// Quando formos integrar de verdade, migramos essas mesmas tabelas
// para o Supabase (Postgres) sem mudar a lógica do app.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const auth = require('./auth');

const db = new DatabaseSync(path.join(__dirname, 'data.sqlite'));

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
    criado_em TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (vendedor_id) REFERENCES vendedores(id)
  );

  CREATE TABLE IF NOT EXISTS mensagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    remetente TEXT NOT NULL,   -- 'cliente' | 'vendedor' | 'ia'
    texto TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT (datetime('now')),
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

module.exports = db;
