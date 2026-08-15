// Cria as tabelas (se não existirem) e, na primeira vez, insere dados de
// exemplo realistas da Academia DANDY. Idempotente: só popula se estiver vazio.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { query, temPool } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function initDb({ comSeed = true } = {}) {
  if (!temPool()) {
    console.log('[db] sem DATABASE_URL — pulando criação de tabelas (modo demo).');
    return false;
  }
  const schema = await readFile(join(__dirname, 'schema.sql'), 'utf8');
  await query(schema);
  console.log('[db] tabelas verificadas/criadas.');
  if (comSeed) await seed();
  return true;
}

async function seed() {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM academias');
  if (rows[0].n > 0) {
    console.log('[db] seed já existe — nada a fazer.');
    return;
  }
  console.log('[db] inserindo dados realistas (DANDY)...');

  const ac = await query(`INSERT INTO academias (nome) VALUES ($1) RETURNING id`, ['Academia DANDY']);
  const academiaId = ac.rows[0].id;

  // unidades (índices 0..4)
  const unidadesNomes = ['Patriarca', 'Arthur Alvim', 'Penha', 'Vila Matilde', 'Jardim Popular'];
  const unidadeIds = [];
  for (const nome of unidadesNomes) {
    const u = await query(`INSERT INTO unidades (academia_id, nome) VALUES ($1,$2) RETURNING id`, [academiaId, nome]);
    unidadeIds.push(u.rows[0].id);
  }

  // equipe: gerente + coordenadora + 1 vendedor por unidade (índice do vendedor = índice da unidade)
  await query(
    `INSERT INTO usuarios (academia_id, unidade_id, nome, papel, status) VALUES
      ($1, NULL, 'Maurício', 'gerente', 'disponivel'),
      ($1, $2, 'Juliana', 'coordenador', 'disponivel'),
      ($1, $2, 'Rafael', 'vendedor', 'disponivel'),
      ($1, $3, 'Camila', 'vendedor', 'disponivel'),
      ($1, $4, 'Diego', 'vendedor', 'disponivel'),
      ($1, $5, 'Letícia', 'vendedor', 'pausa'),
      ($1, $6, 'Thiago', 'vendedor', 'disponivel')`,
    [academiaId, ...unidadeIds]
  );
  const vres = await query(`SELECT id, unidade_id FROM usuarios WHERE academia_id=$1 AND papel='vendedor' ORDER BY id`, [academiaId]);
  // vendedor de cada unidade
  const vendPorUni = {};
  for (const v of vres.rows) vendPorUni[v.unidade_id] = v.id;
  const vend = (uni) => vendPorUni[unidadeIds[uni]];

  // respostas rápidas
  await query(
    `INSERT INTO respostas_rapidas (academia_id, atalho, titulo, texto) VALUES
      ($1,'/valores','Valores do plano','Nosso plano único dá acesso a todas as modalidades (musculação, natação, pilates, dança, lutas e bike). Quer que eu te passe as condições da unidade mais perto de você?'),
      ($1,'/horarios','Horário','Funcionamos de segunda a sexta das 6h às 23h, e aos sábados das 8h às 14h.'),
      ($1,'/endereco','Endereço','Me diz qual unidade fica melhor (Patriarca, Arthur Alvim, Penha, Vila Matilde ou Jardim Popular) que te mando o endereço e o mapa.'),
      ($1,'/experimental','Aula experimental','Podemos agendar uma aula experimental gratuita pra você conhecer a estrutura. Qual dia e horário fica melhor?'),
      ($1,'/renovacao','Renovação','Seu plano está próximo do vencimento. Posso já deixar a renovação encaminhada pra você não perder o acesso?'),
      ($1,'/familia','Plano família','Temos condição especial pra família treinar junto: a partir do 2º membro o desconto é progressivo. Quantas pessoas seriam?')`,
    [academiaId]
  );

  // templates aprovados (pro disparo de conversa)
  await query(
    `INSERT INTO templates (academia_id, nome, categoria, corpo, aprovado) VALUES
      ($1,'renovacao_util','utility','Olá, {{1}}! Aqui é da Academia DANDY, unidade {{2}}. Seu plano vence em {{3}}. Para renovar e manter seu acesso ativo, é só responder esta mensagem.', true),
      ($1,'boas_vindas','utility','Olá, {{1}}! Sua matrícula na Academia DANDY (unidade {{2}}) foi confirmada. Seu acesso já está liberado. Bons treinos!', true),
      ($1,'aula_experimental','utility','Olá, {{1}}! Sua aula experimental está agendada para {{2}} na unidade {{3}}. Qualquer coisa, responda por aqui.', true),
      ($1,'promo_mes','marketing','Olá, {{1}}! Temos uma condição especial este mês na Academia DANDY. Quer que eu te conte os detalhes?', true)`,
    [academiaId]
  );

  // metas do mês (todas as unidades)
  const comp = new Date().toISOString().slice(0, 7);
  const metas = [[0, 42, 31], [1, 40, 36], [2, 45, 28], [3, 35, 30], [4, 30, 22]];
  for (const [uni, alvo, real] of metas) {
    await query(`INSERT INTO metas (academia_id, unidade_id, competencia, alvo, realizado) VALUES ($1,$2,$3,$4,$5)`,
      [academiaId, unidadeIds[uni], comp, alvo, real]);
  }

  // helper: cria contato + conversa + mensagens (+ sugestão da IA opcional)
  let tel = 5511970000000;
  async function conv(o) {
    const telefone = String(++tel);
    const ct = await query(
      `INSERT INTO contatos (academia_id, unidade_id, telefone, nome, tipo) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [academiaId, unidadeIds[o.uni], telefone, o.nome, o.tipo || 'lead']
    );
    const dias = o.dias || 0;
    const janela = o.janelaMin != null
      ? `now() + interval '${o.janelaMin} minutes'`
      : (o.status === 'parado' || o.status === 'resolvido' ? `now() - interval '3 hours'` : `now() + interval '20 hours'`);
    const primeira = o.tmpr != null ? `now() - interval '${dias} days' + interval '${o.tmpr} minutes'` : 'NULL';
    const resolvida = o.tma != null ? `now() - interval '${dias} days' + interval '${o.tma} minutes'` : 'NULL';
    const ultima = o.janelaMin != null ? `now() - interval '30 minutes'` : `now() - interval '${dias} days'`;
    const c = await query(
      `INSERT INTO conversas
        (academia_id, contato_id, unidade_id, responsavel_id, status, desfecho,
         janela_expira_em, primeira_resposta_em, resolvida_em, criada_em, ultima_msg_em)
       VALUES ($1,$2,$3,$4,$5,$6, ${janela}, ${primeira}, ${resolvida},
         now() - interval '${dias} days' - interval '1 hours', ${ultima}) RETURNING id`,
      [academiaId, ct.rows[0].id, unidadeIds[o.uni], vend(o.uni), o.status, o.desfecho || null]
    );
    const convId = c.rows[0].id;
    const msgs = o.msgs || [];
    let k = msgs.length;
    for (const m of msgs) {
      await query(
        `INSERT INTO mensagens (conversa_id, direcao, conteudo, categoria, criada_em)
         VALUES ($1,$2,$3,$4, now() - interval '${dias} days' - interval '${k * 4} minutes')`,
        [convId, m[0], m[1], m[2] || null]
      );
      k--;
    }
    if (o.sugestao) {
      await query(
        `INSERT INTO tarefas (academia_id, conversa_id, titulo, detalhe, origem) VALUES ($1,$2,'Sugestão de resposta da IA',$3,'curadoria')`,
        [academiaId, convId, o.sugestao]
      );
    }
    return convId;
  }

  // ---- conversas ATIVAS (janela aberta) ----
  await conv({ nome: 'Ana Souza', uni: 0, status: 'aguardando',
    msgs: [['entrada', 'Oi! Queria saber o valor do plano mensal']],
    sugestao: 'Oi, Ana! Nosso plano único dá acesso a todas as modalidades. Quer que eu te passe as condições da unidade Patriarca?' });
  await conv({ nome: 'Bruno Costa', uni: 1, status: 'em_atendimento',
    msgs: [['entrada', 'Vocês têm natação? E qual o valor?'], ['saida', 'Oi Bruno! Temos sim, a natação está inclusa no plano único. Já te passo os valores 😊', 'texto_livre']],
    sugestao: 'Bruno, o plano único fica R$ 149,90/mês e inclui natação, musculação e todas as modalidades. Quer aproveitar uma aula experimental antes?' });
  await conv({ nome: 'Patrícia Nunes', uni: 2, tipo: 'aluno', status: 'aguardando',
    msgs: [['entrada', 'Meu plano vence semana que vem, quero renovar']],
    sugestao: 'Oi, Patrícia! Já deixo a renovação encaminhada pra você não perder o acesso. Confirma que pode ser no mesmo plano?' });
  await conv({ nome: 'Marcos Vieira', uni: 4, status: 'aguardando',
    msgs: [['entrada', 'Tem plano família? Somos em 3 aqui em casa']] });
  await conv({ nome: 'Sandra Reis', uni: 3, status: 'em_atendimento',
    msgs: [['entrada', 'Quero agendar uma aula experimental'], ['saida', 'Claro, Sandra! Qual dia e horário fica melhor pra você?', 'texto_livre']] });

  // ---- JANELAS de 24h fechando ----
  await conv({ nome: 'Marina Alves', uni: 2, status: 'aguardando', janelaMin: 95,
    msgs: [['entrada', 'Ainda dá tempo de fechar hoje?']] });
  await conv({ nome: 'Roberto Dias', uni: 0, status: 'aguardando', janelaMin: 160,
    msgs: [['entrada', 'Consegue me ligar? Quero fechar o plano anual']] });
  await conv({ nome: 'Cláudia Menezes', uni: 1, status: 'aguardando', janelaMin: 40,
    msgs: [['entrada', 'Deixa eu ver com meu marido e já te aviso']] });

  // ---- PARADAS (janela fechada, sem desfecho) ----
  await conv({ nome: 'Hugo Ferreira', uni: 3, status: 'parado', dias: 1,
    msgs: [['entrada', 'Vocês aceitam Wellhub?'], ['saida', 'Oi Hugo! Trabalhamos com plano próprio, mas tenho uma condição bem bacana pra te mostrar.', 'template']] });
  await conv({ nome: 'Tânia Lopes', uni: 4, status: 'parado', dias: 2,
    msgs: [['entrada', 'Quanto fica o trimestral?']] });

  // ---- RESOLVIDAS com desfecho (alimenta funil e tempos) ----
  const hist = [
    ['Carla Mendes', 0, 'matriculou', 1, 4, 90], ['Gabriela Torres', 1, 'matriculou', 2, 6, 75],
    ['Joana Lima', 2, 'matriculou', 3, 3, 50], ['Pedro Alves', 3, 'matriculou', 4, 9, 110],
    ['Rita Souza', 4, 'matriculou', 5, 5, 65], ['Lucas Dias', 0, 'matriculou', 6, 7, 80],
    ['Fernanda Reis', 1, 'ja_aluno', 2, 10, 40], ['Bruno Almeida', 2, 'ja_aluno', 3, 8, 35],
    ['Elaine Prado', 0, 'vai_pensar', 2, 12, 60], ['Ivo Nogueira', 3, 'vai_pensar', 4, 15, 200],
    ['Felipe Andrade', 2, 'sem_interesse', 2, 30, 45], ['Aline Castro', 4, 'sem_interesse', 3, 20, 30],
    ['Hugo Santos', 3, 'sem_resposta', 3, null, null], ['Vitor Melo', 1, 'sem_resposta', 5, null, null],
  ];
  const primeiraMsg = {
    matriculou: 'Quero fechar o plano!', ja_aluno: 'Já sou aluno, queria trocar de unidade',
    vai_pensar: 'Vou pensar e te falo', sem_interesse: 'Achei caro, obrigado', sem_resposta: 'Oi, tem plano mensal?',
  };
  for (const [nome, uni, desfecho, dias, tmpr, tma] of hist) {
    await conv({
      nome, uni, desfecho, dias, tmpr, tma,
      status: desfecho === 'sem_resposta' ? 'parado' : 'resolvido',
      msgs: [['entrada', primeiraMsg[desfecho]]],
    });
  }

  // ---- tarefas da IA (curadoria de fim de dia) ----
  const tarefas = [
    'Retornar Marcos Vieira — interessado em plano família (Jardim Popular)',
    'Ligar para Roberto Dias — quer fechar plano anual, janela fechando (Patriarca)',
    'Follow-up Elaine Prado — ficou de pensar há 2 dias (Patriarca)',
    'Reativar Tânia Lopes — parou de responder sobre o trimestral (Jardim Popular)',
    'Confirmar renovação da Patrícia Nunes — plano vence semana que vem (Penha)',
  ];
  for (const t of tarefas) {
    await query(`INSERT INTO tarefas (academia_id, titulo, origem) VALUES ($1,$2,'curadoria')`, [academiaId, t]);
  }

  console.log('[db] seed concluído (dados realistas DANDY).');
}

// permite: npm run initdb
if (import.meta.url === `file://${process.argv[1]}`) {
  initDb().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
