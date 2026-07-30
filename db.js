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

  -- Setores da loja (Vendas, Financeiro, Expedição, ...). Cada setor vai
  -- ter seu próprio número de WhatsApp no futuro; por enquanto isso aqui
  -- é só a estrutura de dados + controle de acesso.
  CREATE TABLE IF NOT EXISTS setores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,   -- 'vendas' | 'financeiro' | 'expedicao'
    nome TEXT NOT NULL           -- rótulo bonito pra exibir na tela
  );

  -- Quem tem acesso a qual setor. Vendedor de Financeiro só aparece aqui
  -- ligado a 'financeiro', por exemplo — sem essa linha, sem acesso.
  -- Admin não precisa de linha aqui: acesso total já vem do role.
  CREATE TABLE IF NOT EXISTS vendedor_setores (
    vendedor_id INTEGER NOT NULL,
    setor_id INTEGER NOT NULL,
    PRIMARY KEY (vendedor_id, setor_id),
    FOREIGN KEY (vendedor_id) REFERENCES vendedores(id),
    FOREIGN KEY (setor_id) REFERENCES setores(id)
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
// resumo da análise da IA — guardado pra poder mostrar na tela de
// resultado da análise diária e no relatório, sem precisar chamar a IA
// de novo só pra reexibir o que ela já disse uma vez
if (!colunaExiste('leads', 'resumo_ia')) {
  db.exec(`ALTER TABLE leads ADD COLUMN resumo_ia TEXT`);
}
// quando o lembrete foi criado — precisa pra filtrar "tarefas que a IA
// criou HOJE" no relatório do dia (lembretes antigas não tinham essa coluna)
if (!colunaExiste('lembretes', 'criado_em')) {
  // SQLite não deixa usar função (strftime) como valor padrão direto no
  // ADD COLUMN quando é NOT NULL numa tabela que já existe — só aceita
  // valor constante nesse caso (diferente de CREATE TABLE, onde funciona).
  // Por isso em 2 passos: adiciona a coluna sem default, depois preenche
  // as linhas existentes manualmente.
  db.exec(`ALTER TABLE lembretes ADD COLUMN criado_em TEXT`);
  db.exec(`UPDATE lembretes SET criado_em = strftime('%Y-%m-%d %H:%M:%f','now') WHERE criado_em IS NULL`);
}
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
// a qual setor esse lead pertence (Vendas, Financeiro, Expedição...).
// Todo lead que já existia antes dos setores existirem vai pro setor
// "vendas" — é o único que já existia até aqui, então nada muda pra
// ninguém que já está usando o sistema.
if (!colunaExiste('leads', 'setor_id')) {
  db.exec(`ALTER TABLE leads ADD COLUMN setor_id INTEGER`);
}

// ---------------------------------------------------------------
// SETORES: cria os 3 setores padrão (se ainda não existirem) e faz o
// backfill pra tudo que já existia antes desse conceito existir —
// sem isso, todo lead e vendedor antigo ficaria "sem setor" e sumiria
// das telas assim que a lógica de setor entrar em uso de verdade.
// ---------------------------------------------------------------
const SETORES_PADRAO = [
  { slug: 'vendas', nome: 'Vendas' },
  { slug: 'financeiro', nome: 'Financeiro' },
  { slug: 'expedicao', nome: 'Expedição' },
];
for (const s of SETORES_PADRAO) {
  const existe = db.prepare(`SELECT id FROM setores WHERE slug = ?`).get(s.slug);
  if (!existe) {
    db.prepare(`INSERT INTO setores (slug, nome) VALUES (?, ?)`).run(s.slug, s.nome);
  }
}
const setorVendas = db.prepare(`SELECT id FROM setores WHERE slug = 'vendas'`).get();

// Todo lead sem setor definido (ou seja, criado antes desse recurso
// existir) é automaticamente um lead de Vendas — é o único setor que
// existia até agora.
db.prepare(`UPDATE leads SET setor_id = ? WHERE setor_id IS NULL`).run(setorVendas.id);

// Todo vendedor (exceto admin, que já tem acesso total pelo role) que
// ainda não tem NENHUM setor atribuído recebe acesso a Vendas — preserva
// o acesso que ele já tinha, sem sobrescrever se um admin já tiver
// configurado esse vendedor manualmente pra outro setor no meio tempo.
const vendedoresSemSetor = db.prepare(`
  SELECT id FROM vendedores
  WHERE role != 'admin' AND id NOT IN (SELECT DISTINCT vendedor_id FROM vendedor_setores)
`).all();
const concederAcessoVendas = db.prepare(
  `INSERT OR IGNORE INTO vendedor_setores (vendedor_id, setor_id) VALUES (?, ?)`
);
for (const v of vendedoresSemSetor) concederAcessoVendas.run(v.id, setorVendas.id);

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

// Setores que esse vendedor pode acessar — [{ id, slug, nome }]. Não
// inclui verificação de admin aqui de propósito: quem decide "admin vê
// tudo" é a camada de cima (server.js), essa função só reflete o que
// está na tabela vendedor_setores.
module.exports.getSetoresPermitidos = function (vendedorId) {
  return db.prepare(`
    SELECT setores.id, setores.slug, setores.nome
    FROM vendedor_setores
    JOIN setores ON setores.id = vendedor_setores.setor_id
    WHERE vendedor_setores.vendedor_id = ?
    ORDER BY setores.id ASC
  `).all(vendedorId);
};

module.exports.getTodosSetores = function () {
  return db.prepare(`SELECT id, slug, nome FROM setores ORDER BY id ASC`).all();
};

module.exports.getSetorPorSlug = function (slug) {
  return db.prepare(`SELECT id, slug, nome FROM setores WHERE slug = ?`).get(slug);
};
