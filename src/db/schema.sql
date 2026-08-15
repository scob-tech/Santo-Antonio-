-- ==========================================================================
--  scobtech · Atendimento WhatsApp + IA — modelo de dados (Fase 1)
--  Multi-academia: cada academia é um "inquilino" (tenant). Uma base só.
--  Rodar: npm run initdb  (ou automático no boot se as tabelas não existirem)
-- ==========================================================================

CREATE TABLE IF NOT EXISTS academias (
  id            SERIAL PRIMARY KEY,
  nome          TEXT NOT NULL,
  -- credenciais WhatsApp de cada academia (na Fase 1 pode ser uma só)
  phone_number_id TEXT,
  whatsapp_token  TEXT,
  criada_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unidades (
  id            SERIAL PRIMARY KEY,
  academia_id   INTEGER NOT NULL REFERENCES academias(id) ON DELETE CASCADE,
  nome          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usuarios (
  id            SERIAL PRIMARY KEY,
  academia_id   INTEGER NOT NULL REFERENCES academias(id) ON DELETE CASCADE,
  unidade_id    INTEGER REFERENCES unidades(id) ON DELETE SET NULL,
  nome          TEXT NOT NULL,
  papel         TEXT NOT NULL CHECK (papel IN ('gerente','coordenador','vendedor')),
  ativo         BOOLEAN NOT NULL DEFAULT true,
  -- presença do atendente (para a distribuição e o painel de equipe)
  status        TEXT NOT NULL DEFAULT 'disponivel'
                 CHECK (status IN ('disponivel','pausa','indisponivel'))
);

CREATE TABLE IF NOT EXISTS contatos (
  id            SERIAL PRIMARY KEY,
  academia_id   INTEGER NOT NULL REFERENCES academias(id) ON DELETE CASCADE,
  unidade_id    INTEGER REFERENCES unidades(id) ON DELETE SET NULL,
  telefone      TEXT NOT NULL,          -- formato E.164, ex: 5511999999999
  nome          TEXT,
  tipo          TEXT NOT NULL DEFAULT 'lead' CHECK (tipo IN ('lead','aluno')),
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (academia_id, telefone)
);

CREATE TABLE IF NOT EXISTS conversas (
  id              SERIAL PRIMARY KEY,
  academia_id     INTEGER NOT NULL REFERENCES academias(id) ON DELETE CASCADE,
  contato_id      INTEGER NOT NULL REFERENCES contatos(id) ON DELETE CASCADE,
  unidade_id      INTEGER REFERENCES unidades(id) ON DELETE SET NULL,
  responsavel_id  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'aguardando'
                   CHECK (status IN ('aguardando','em_atendimento','resolvido','parado')),
  -- desfecho de venda (tabulação) — alimenta o funil. Texto livre (validado no app)
  -- pra facilitar adicionar novas opções sem migração de banco.
  desfecho        TEXT,
  -- fim da janela gratuita de 24h da Meta. Depois disso, só template.
  janela_expira_em TIMESTAMPTZ,
  -- carimbos para medir TMPR (1ª resposta) e TMA (até resolver)
  primeira_resposta_em TIMESTAMPTZ,
  resolvida_em    TIMESTAMPTZ,
  ultima_msg_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  criada_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mensagens (
  id            SERIAL PRIMARY KEY,
  conversa_id   INTEGER NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
  direcao       TEXT NOT NULL CHECK (direcao IN ('entrada','saida')),
  conteudo      TEXT,
  -- para saídas: 'texto_livre' (grátis, dentro da janela) ou 'template'
  categoria     TEXT,
  wa_message_id TEXT,
  criada_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tarefas (
  id            SERIAL PRIMARY KEY,
  academia_id   INTEGER NOT NULL REFERENCES academias(id) ON DELETE CASCADE,
  conversa_id   INTEGER REFERENCES conversas(id) ON DELETE SET NULL,
  responsavel_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  titulo        TEXT NOT NULL,
  detalhe       TEXT,
  origem        TEXT NOT NULL DEFAULT 'curadoria'
                   CHECK (origem IN ('curadoria','gargalo','manual')),
  feita         BOOLEAN NOT NULL DEFAULT false,
  criada_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS templates (
  id            SERIAL PRIMARY KEY,
  academia_id   INTEGER NOT NULL REFERENCES academias(id) ON DELETE CASCADE,
  nome          TEXT NOT NULL,          -- nome aprovado na Meta
  categoria     TEXT NOT NULL DEFAULT 'utility'
                   CHECK (categoria IN ('utility','marketing','authentication')),
  corpo         TEXT NOT NULL,
  aprovado      BOOLEAN NOT NULL DEFAULT false
);

-- metas de vendas: guarda a meta e deixa a apuração pro painel/consulta
CREATE TABLE IF NOT EXISTS metas (
  id            SERIAL PRIMARY KEY,
  academia_id   INTEGER NOT NULL REFERENCES academias(id) ON DELETE CASCADE,
  usuario_id    INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
  unidade_id    INTEGER REFERENCES unidades(id) ON DELETE SET NULL,
  competencia   TEXT NOT NULL,          -- 'AAAA-MM'
  alvo          INTEGER NOT NULL DEFAULT 0,
  realizado     INTEGER NOT NULL DEFAULT 0
);

-- respostas rápidas (atalhos de mensagem pronta para o atendente)
CREATE TABLE IF NOT EXISTS respostas_rapidas (
  id            SERIAL PRIMARY KEY,
  academia_id   INTEGER NOT NULL REFERENCES academias(id) ON DELETE CASCADE,
  atalho        TEXT NOT NULL,          -- ex: /valores
  titulo        TEXT NOT NULL,          -- ex: Valores do plano
  texto         TEXT NOT NULL
);

-- ALTERs idempotentes: garantem as colunas novas em bancos já criados antes
ALTER TABLE usuarios  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'disponivel';
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS desfecho TEXT;
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS primeira_resposta_em TIMESTAMPTZ;
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS resolvida_em TIMESTAMPTZ;
-- remove a restrição antiga de desfecho (bancos criados antes), pra aceitar
-- novas opções como 'ja_aluno' sem quebrar
ALTER TABLE conversas DROP CONSTRAINT IF EXISTS conversas_desfecho_check;

-- índices que ajudam nas consultas mais comuns
CREATE INDEX IF NOT EXISTS idx_conversas_academia ON conversas(academia_id, status);
CREATE INDEX IF NOT EXISTS idx_conversas_resp ON conversas(responsavel_id, status);
CREATE INDEX IF NOT EXISTS idx_conversas_ultima ON conversas(ultima_msg_em);
CREATE INDEX IF NOT EXISTS idx_mensagens_conversa ON mensagens(conversa_id, criada_em);
CREATE INDEX IF NOT EXISTS idx_contatos_tel ON contatos(academia_id, telefone);
