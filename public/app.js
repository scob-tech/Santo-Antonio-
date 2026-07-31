const API = '';
// Login da conta "de desenvolvedor" — só ela vê o botão "Limpar demo".
// Contas admin criadas depois (ex: pro cliente final) não têm esse botão.
const LOGIN_DESENVOLVEDOR = 'admin';

// Escapa texto vindo de fora (nome do WhatsApp, mensagem do cliente, etc)
// antes de jogar em innerHTML — sem isso, qualquer pessoa que manda
// mensagem pro WhatsApp da loja pode injetar HTML/JS que roda na tela
// de quem for abrir a conversa (vendedor, supervisor, admin logado).
function escapeHtml(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Só deixa passar URL de mídia http(s)/data — bloqueia esquema tipo
// "javascript:" que poderia rodar código ao clicar/carregar.
function urlMidiaSegura(url) {
  if (!url) return null;
  try {
    const u = new URL(url, window.location.origin);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'data:') return escapeHtml(url);
  } catch {
    return null;
  }
  return null;
}
let usuarioAtual = null;
let leadsCache = [];
let conversasAtivasCache = [];
let vendedoresCache = [];
// Setor que está sendo exibido no momento (Vendas, Financeiro, Expedição).
// A maioria das contas só tem 1 setor mesmo — isso só vira um seletor de
// verdade na tela pra quem acessa mais de um (hoje, só admin).
let setorAtivo = null;
let setoresDisponiveis = [];
// Provisório: enquanto não existe uma tela própria pra histórico de encerradas,
// a lista de conversas mostra só 2 encerradas por padrão pra não poluir o
// dashboard, com botão "Ver mais" pra expandir sob demanda.
let mostrarTodasEncerradas = false;

const LABELS_TIPO = {
  orcamento: 'Orçamento', catalogo: 'Catálogo', frete: 'Frete',
  pos_venda: 'Pós-venda', ligacao: 'Ligação', objecao: 'Objeção',
  oportunidade: 'Oportunidade', outro: 'Outro',
};

function fecharModal(id) {
  document.getElementById(id).classList.remove('aberto');
}
function abrirModal(id) {
  document.getElementById(id).classList.add('aberto');
}
function ehGestor(usuario) {
  return usuario && (usuario.role === 'admin' || usuario.role === 'supervisor');
}

async function checarSessao() {
  const res = await fetch(`${API}/api/me`);
  if (!res.ok) {
    window.location.href = '/login.html';
    return false;
  }
  usuarioAtual = await res.json();

  const resSetores = await fetch(`${API}/api/setores`);
  setoresDisponiveis = resSetores.ok ? await resSetores.json() : [];

  // Lembra a última escolha (só importa pra quem tem mais de 1 setor).
  // Se o setor salvo não existir mais entre os disponíveis, ignora e usa
  // o primeiro — evita ficar preso a uma escolha que não faz mais sentido.
  const salvo = localStorage.getItem('setorAtivo');
  const salvoValido = setoresDisponiveis.some((s) => s.slug === salvo);
  setorAtivo = salvoValido ? salvo : (setoresDisponiveis[0] ? setoresDisponiveis[0].slug : null);

  renderizarUserBox();
  renderizarSeletorSetor();
  atualizarPainelTitulo();
  carregarMinhaMeta();
  return true;
}

// Só desenha alguma coisa na tela quando a conta acessa mais de 1 setor —
// quem só tem Vendas (a imensa maioria hoje) não vê nenhuma mudança visual.
const EMOJI_SETOR = { vendas: '🛒', financeiro: '💰', expedicao: '🚚' };
function renderizarSeletorSetor() {
  const el = document.getElementById('seletor-setor');
  if (!el) return;
  if (setoresDisponiveis.length <= 1) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  el.style.display = 'flex';
  el.className = 'seletor-setor sidebar-switcher';
  el.innerHTML = setoresDisponiveis.map((s) => `
    <button class="switch-item ${s.slug === setorAtivo ? 'is-active' : ''}" onclick="mudarSetor('${s.slug}')" title="${escapeHtml(s.nome)}">
      <span class="switch-emoji">${EMOJI_SETOR[s.slug] || '🏷️'}</span><span>${escapeHtml(s.nome)}</span>
    </button>
  `).join('');
}

const NOMES_SETOR = { vendas: 'Vendas', financeiro: 'Financeiro', expedicao: 'Expedição' };
function saudacaoPorHorario() {
  const hora = new Date().getHours();
  if (hora < 12) return 'Bom dia';
  if (hora < 18) return 'Boa tarde';
  return 'Boa noite';
}

function atualizarPainelTitulo() {
  const el = document.getElementById('painel-titulo');
  const subEl = document.getElementById('painel-subtitulo');
  const acoesEl = document.getElementById('painel-acoes-admin');
  if (!el || !usuarioAtual) return;
  const nome = NOMES_SETOR[setorAtivo];

  if (ehGestor(usuarioAtual)) {
    el.textContent = nome ? `Painel de ${nome}` : 'Painel';
    subEl.textContent = 'Visão geral de todos os atendimentos.';
    acoesEl.style.display = 'flex';
  } else {
    el.textContent = `${saudacaoPorHorario()}, ${usuarioAtual.nome.split(' ')[0]}! 👋`;
    subEl.textContent = 'Vamos juntos fazer mais um dia incrível de conquistas.';
    acoesEl.style.display = 'none';
  }

  // Progresso só existe pra Vendas — Financeiro e Expedição não têm meta
  // nem comparativo de vendas, então o item some do menu pra eles.
  const navProgresso = document.getElementById('nav-item-progresso');
  if (navProgresso) navProgresso.style.display = setorAtivo === 'vendas' ? 'flex' : 'none';

  // "Clientes" em Vendas é cadastro de cliente de verdade; em Financeiro/
  // Expedição é só um jeito de começar uma conversa nova com alguém —
  // por isso o nome muda.
  const labelClientes = document.getElementById('nav-clientes-label');
  const placeholderClientes = document.getElementById('placeholder-clientes');
  if (labelClientes) {
    const ehVendas = setorAtivo === 'vendas';
    labelClientes.textContent = ehVendas ? 'Clientes' : 'Cadastrar novo contato';
    if (placeholderClientes) {
      placeholderClientes.innerHTML = ehVendas
        ? '<strong>Clientes</strong>Cadastro de clientes ainda não existe nesse sistema — em construção.'
        : '<strong>Cadastrar novo contato</strong>Em construção — por enquanto, use "+ Novo Lead" na tela de Início pra começar uma conversa nova.';
    }
  }
}

function mudarSetor(slug) {
  if (slug === setorAtivo) return;
  setorAtivo = slug;
  localStorage.setItem('setorAtivo', slug);
  renderizarSeletorSetor();
  atualizarPainelTitulo();
  carregarMinhaMeta();
  mostrarTodasEncerradas = false; // volta ao padrão ao trocar de setor
  carregarLeads();
  carregarConversasAtivas();
  carregarLembretes();
  if (ehGestor(usuarioAtual)) carregarVendedores();
  fecharMenuMobile();
}

// Troca qual "view" aparece na área principal (Início, Agenda, Clientes,
// Histórico, Progresso, Configurações) — só troca o que está visível,
// não recarrega dado nenhum. Hoje só "Início" tem conteúdo de verdade;
// as outras são placeholders até ganharem tela própria.
const TITULOS_VIEW = {
  inicio: 'Início',
  agenda: 'Agenda',
  clientes: 'Clientes',
  historico: 'Histórico',
  progresso: 'Progresso',
  configuracoes: 'Configurações',
};
function mudarView(nome) {
  document.querySelectorAll('.view').forEach((el) => { el.hidden = el.id !== `view-${nome}`; });
  document.querySelectorAll('.side-item').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.view === nome);
  });
  document.getElementById('view-title').textContent = TITULOS_VIEW[nome] || '';
  if (nome === 'progresso') carregarProgresso();
  fecharMenuMobile();
}

let progressoPeriodo = 'semana';
let progressoGranularidade = 'diario';
let progressoPeriodoCustom = null; // { inicio, fim } ou null (usa o preset)

function mudarProgresso(campo, valor) {
  if (campo === 'periodo') {
    progressoPeriodo = valor;
    progressoPeriodoCustom = null; // escolher um preset cancela o período customizado
    document.getElementById('progresso-periodo-custom').style.display = 'none';
  } else {
    progressoGranularidade = valor;
  }
  const containerId = campo === 'periodo' ? 'progresso-periodo' : 'progresso-granularidade';
  document.querySelectorAll(`#${containerId} .filter-chip`).forEach((b) => {
    b.classList.toggle('is-active', b.dataset[campo] === valor);
  });
  carregarProgresso();
}

// Botão de calendário — abre/fecha os dois campos de data pra um período
// específico, escolhido à mão (em vez dos presets de sempre).
function alternarSeletorPeriodo() {
  const box = document.getElementById('progresso-periodo-custom');
  box.style.display = box.style.display === 'none' ? 'flex' : 'none';
}
function aplicarPeriodoCustom() {
  const inicio = document.getElementById('progresso-data-inicio').value;
  const fim = document.getElementById('progresso-data-fim').value;
  if (!inicio || !fim) return;
  progressoPeriodoCustom = { inicio, fim };
  document.querySelectorAll('#progresso-periodo .filter-chip').forEach((b) => b.classList.remove('is-active'));
  carregarProgresso();
}

// Só gestor (admin/supervisor) vê esse filtro — vendedor comum só
// acompanha o próprio progresso mesmo, não precisa escolher ninguém.
async function popularFiltroVendedorProgresso() {
  const wrap = document.getElementById('progresso-filtro-vendedor-wrap');
  if (!ehGestor(usuarioAtual)) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  const select = document.getElementById('progresso-filtro-vendedor');
  if (select.dataset.carregado === setorAtivo) return; // já carregou pra esse setor
  const res = await fetch(`${API}/api/vendedores`);
  if (!res.ok) return;
  const vendedores = await res.json();
  const doSetor = vendedores.filter((v) => v.role === 'admin' || (v.setores || []).includes(setorAtivo));
  select.innerHTML = '<option value="">Todo o setor (todos os vendedores)</option>' +
    doSetor.filter((v) => v.role !== 'admin').map((v) => `<option value="${v.id}">${escapeHtml(v.nome)}</option>`).join('');
  select.dataset.carregado = setorAtivo;
}

async function carregarProgresso() {
  if (!setorAtivo) return;
  if (ehGestor(usuarioAtual)) await popularFiltroVendedorProgresso();

  let url = `${API}/api/relatorio/progresso?granularidade=${progressoGranularidade}&setor=${setorAtivo}`;
  url += progressoPeriodoCustom
    ? `&data_inicio=${progressoPeriodoCustom.inicio}&data_fim=${progressoPeriodoCustom.fim}`
    : `&periodo=${progressoPeriodo}`;
  const vendedorSelect = document.getElementById('progresso-filtro-vendedor');
  if (ehGestor(usuarioAtual) && vendedorSelect && vendedorSelect.value) {
    url += `&vendedor_id=${vendedorSelect.value}`;
  }

  const res = await fetch(url);
  if (res.status === 401) return window.location.href = '/login.html';
  if (!res.ok) return;
  const dados = await res.json();

  document.getElementById('progresso-total').textContent = `${dados.total} pedido${dados.total === 1 ? '' : 's'}`;
  document.getElementById('progresso-media').textContent = dados.mediaPorDia;

  const compEl = document.getElementById('progresso-comparacao');
  const sinal = dados.comparacao > 0 ? '▲ +' : dados.comparacao < 0 ? '▼ ' : '';
  compEl.textContent = `${sinal}${dados.comparacao}% vs período anterior`;
  compEl.style.color = dados.comparacao > 0 ? 'var(--green)' : dados.comparacao < 0 ? 'var(--red)' : 'var(--muted)';

  const rotuloGranularidade = { diario: 'DIÁRIA', semanal: 'SEMANAL', mensal: 'MENSAL' }[progressoGranularidade];
  document.getElementById('progresso-grafico-titulo').textContent = `VENDAS · ${rotuloGranularidade}`;

  const grafico = document.getElementById('progresso-grafico');
  if (dados.buckets.length === 0) {
    grafico.innerHTML = `<div class="empty-state" style="width:100%;">Nenhuma venda registrada nesse período ainda.</div>`;
    return;
  }
  const maiorValor = Math.max(...dados.buckets.map((b) => b.value), 1);
  grafico.innerHTML = dados.buckets.map((b) => `
    <div class="progresso-barra-col">
      <span class="progresso-barra-valor">${b.value}</span>
      <div class="progresso-barra" style="height:${Math.max((b.value / maiorValor) * 180, 3)}px;"></div>
      <span class="progresso-barra-label">${b.label}</span>
    </div>
  `).join('');
}

function renderizarUserBox() {
  const el = document.getElementById('user-box');
  const rotulos = { admin: 'Admin', supervisor: 'Supervisor', vendedor: 'Vendedor' };
  const iniciaisUsuario = iniciais(usuarioAtual.nome);

  el.innerHTML = `
    <div class="user-chip" onclick="toggleUserDropdown(event)">
      <div class="avatar">${escapeHtml(iniciaisUsuario)}</div>
      <div class="user-text">
        <span class="user-name">${escapeHtml(usuarioAtual.nome)}</span>
        <span class="user-role">${rotulos[usuarioAtual.role] || 'Vendedor'}</span>
      </div>
      <span class="chevron">▾</span>
      <div class="user-dropdown" id="user-dropdown" hidden>
        <button class="user-dropdown-item" onclick="event.stopPropagation(); document.getElementById('user-dropdown').hidden = true; mudarView('configuracoes');">⚙️ Configurações</button>
        <div class="user-dropdown-divider"></div>
        <button class="user-dropdown-item user-dropdown-item--danger" onclick="sair()">🚪 Sair</button>
      </div>
    </div>
  `;
  renderizarConfiguracoes();

  const btnCadastro = document.getElementById('btn-toggle-cadastro');
  if (usuarioAtual.role === 'admin') {
    document.getElementById('painel-vendedores').style.display = 'block';
    document.getElementById('config-metas').style.display = 'block';
    popularSelectVendedoresMetas();
    btnCadastro.style.display = 'inline-block';
    btnCadastro.onclick = () => {
      document.getElementById('cadastro-form').classList.toggle('aberto');
    };
  }
  if (ehGestor(usuarioAtual)) {
    document.getElementById('btn-rodar-analise').style.display = 'inline-block';
  }
  if (usuarioAtual.role !== 'supervisor') {
    document.getElementById('btn-relatorio').style.display = 'inline-block';
  }
}

// Card "Cadastros" da tela de Configurações — conteúdo muda conforme o
// papel. Cadastro de vendedor continua exclusivo de admin (o formulário
// de verdade fica na seção "Equipe", abaixo); cadastro de clientes ainda
// não existe como tela própria — quando existir, entra aqui pro vendedor.
function renderizarConfiguracoes() {
  const el = document.getElementById('config-cadastros');
  if (!el) return;
  if (usuarioAtual.role === 'admin') {
    el.innerHTML = `
      <h3>Cadastros</h3>
      <p>Cadastrar novo vendedor no sistema.</p>
      <button class="btn-primary btn-small" style="width:100%;" onclick="document.getElementById('painel-vendedores').scrollIntoView({behavior:'smooth'}); document.getElementById('cadastro-form').classList.add('aberto');">+ Cadastrar vendedor</button>
      <p style="font-size:11.5px; color:var(--muted); margin-top:10px; margin-bottom:0;">A lista da equipe fica logo abaixo, nessa mesma tela.</p>
    `;
  } else {
    el.innerHTML = `
      <h3>Cadastros</h3>
      <p>Cadastrar novo vendedor no sistema.</p>
      <p style="font-size:12.5px; color:var(--muted); margin-top:10px; margin-bottom:0;">Somente administradores podem cadastrar novos usuários.</p>
    `;
  }
}

// Tema claro/escuro — só visual, guardado no navegador (não é por conta,
// é por dispositivo mesmo).
function alternarTema() {
  const escuro = document.getElementById('toggle-tema').checked;
  document.body.classList.toggle('tema-escuro', escuro);
  document.getElementById('tema-label-texto').textContent = escuro ? 'Tema escuro' : 'Tema claro';
  localStorage.setItem('temaEscuro', escuro ? '1' : '0');
}
function aplicarTemaSalvo() {
  const escuro = localStorage.getItem('temaEscuro') === '1';
  document.body.classList.toggle('tema-escuro', escuro);
  const toggle = document.getElementById('toggle-tema');
  const label = document.getElementById('tema-label-texto');
  if (toggle) toggle.checked = escuro;
  if (label) label.textContent = escuro ? 'Tema escuro' : 'Tema claro';
}

async function salvarSenhaConfig() {
  const senha_atual = document.getElementById('senha-atual-config').value;
  const senha_nova = document.getElementById('senha-nova-config').value;
  const msgEl = document.getElementById('senha-config-msg');
  msgEl.textContent = '';
  msgEl.className = 'msg';

  const res = await fetch(`${API}/api/me/senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha_atual, senha_nova }),
  });
  const data = await res.json();
  if (res.ok) {
    msgEl.textContent = 'Senha alterada com sucesso.';
    msgEl.className = 'msg ok';
    document.getElementById('senha-atual-config').value = '';
    document.getElementById('senha-nova-config').value = '';
  } else {
    msgEl.textContent = data.erro || 'Erro ao trocar a senha';
    msgEl.className = 'msg erro';
  }
}

// ---------------- Metas (admin define, vendedor acompanha) ----------------
async function popularSelectVendedoresMetas() {
  const select = document.getElementById('metas-vendedor');
  if (select.dataset.carregado === setorAtivo) return;
  const res = await fetch(`${API}/api/vendedores`);
  if (!res.ok) return;
  const vendedores = await res.json();
  const doSetor = vendedores.filter((v) => v.role !== 'admin' && (v.setores || []).includes(setorAtivo));
  select.innerHTML = '<option value="">Selecione um vendedor...</option>' +
    doSetor.map((v) => `<option value="${v.id}">${escapeHtml(v.nome)}</option>`).join('');
  select.dataset.carregado = setorAtivo;
  document.getElementById('config-metas').style.display = doSetor.length > 0 ? 'block' : 'none';
}

async function carregarMetaParaEdicao() {
  const vendedorId = document.getElementById('metas-vendedor').value;
  const removerBtn = document.getElementById('metas-remover-btn');
  document.getElementById('metas-msg').textContent = '';
  if (!vendedorId) {
    document.getElementById('metas-valor').value = '';
    removerBtn.style.display = 'none';
    return;
  }
  const res = await fetch(`${API}/api/metas/${vendedorId}`);
  if (!res.ok) return;
  const data = await res.json();
  if (data.meta) {
    document.getElementById('metas-tipo').value = data.meta.tipo;
    document.getElementById('metas-valor').value = data.meta.valor_meta;
    document.getElementById('metas-periodo').value = data.meta.periodo;
    removerBtn.style.display = 'inline-block';
  } else {
    document.getElementById('metas-valor').value = '';
    removerBtn.style.display = 'none';
  }
}

async function salvarMeta() {
  const vendedorId = document.getElementById('metas-vendedor').value;
  const msgEl = document.getElementById('metas-msg');
  msgEl.className = 'msg';
  if (!vendedorId) {
    msgEl.textContent = 'Escolha um vendedor primeiro.';
    msgEl.className = 'msg erro';
    return;
  }
  const tipo = document.getElementById('metas-tipo').value;
  const valor_meta = document.getElementById('metas-valor').value;
  const periodo = document.getElementById('metas-periodo').value;

  const res = await fetch(`${API}/api/metas/${vendedorId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tipo, valor_meta, periodo }),
  });
  const data = await res.json();
  if (res.ok) {
    msgEl.textContent = 'Meta salva.';
    msgEl.className = 'msg ok';
    document.getElementById('metas-remover-btn').style.display = 'inline-block';
  } else {
    msgEl.textContent = data.erro || 'Erro ao salvar meta';
    msgEl.className = 'msg erro';
  }
}

async function removerMeta() {
  const vendedorId = document.getElementById('metas-vendedor').value;
  if (!vendedorId) return;
  await fetch(`${API}/api/metas/${vendedorId}`, { method: 'DELETE' });
  document.getElementById('metas-valor').value = '';
  document.getElementById('metas-remover-btn').style.display = 'none';
  document.getElementById('metas-msg').textContent = 'Meta removida.';
  document.getElementById('metas-msg').className = 'msg ok';
}

const LABELS_TIPO_META = {
  valor: { titulo: 'META DE VENDAS', formatar: (n) => `R$ ${Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}` },
  pedidos: { titulo: 'META DE PEDIDOS', formatar: (n) => `${n}` },
  atendimentos: { titulo: 'META DE ATENDIMENTOS', formatar: (n) => `${n}` },
};

// Painel de meta no Início do vendedor — some inteiro se ele não tem
// meta ativa, ou se for admin/supervisor (gestor não tem meta pessoal).
async function carregarMinhaMeta() {
  const card = document.getElementById('meta-card');
  const heroRow = document.getElementById('hero-row');
  if (!card || !usuarioAtual) return;

  if (ehGestor(usuarioAtual)) {
    card.style.display = 'none';
    heroRow.className = 'hero-row hero-row--single';
    return;
  }

  const res = await fetch(`${API}/api/metas/${usuarioAtual.id}`);
  if (!res.ok) return;
  const data = await res.json();

  if (!data.meta) {
    card.style.display = 'none';
    heroRow.className = 'hero-row hero-row--single';
    return;
  }

  const cfg = LABELS_TIPO_META[data.meta.tipo];
  card.style.display = 'block';
  heroRow.className = 'hero-row';
  document.getElementById('meta-titulo').textContent = `META DA ${data.meta.periodo === 'mes' ? 'MÊS' : 'SEMANA'}`;
  document.getElementById('meta-numeros').textContent = `${cfg.formatar(data.atual)} / ${cfg.formatar(data.meta.valor_meta)}`;
  const fill = document.getElementById('meta-barra-fill');
  fill.style.width = `${data.percentual}%`;
  fill.classList.toggle('meta-batida', data.percentual >= 100);
  document.getElementById('meta-status').textContent = data.percentual >= 100
    ? '🎉 Meta batida! Parabéns!'
    : `${data.percentual}% da meta`;
}

// Abre/fecha o menu do usuário (chip no topo). Fecha sozinho se a pessoa
// clicar em qualquer outro lugar da tela.
function toggleUserDropdown(evento) {
  evento.stopPropagation();
  const dropdown = document.getElementById('user-dropdown');
  dropdown.hidden = !dropdown.hidden;
}
document.addEventListener('click', () => {
  const dropdown = document.getElementById('user-dropdown');
  if (dropdown) dropdown.hidden = true;
});

async function limparDadosDemo() {
  if (!confirm('Isso apaga todos os leads e vendedores criados pela simulação de demonstração (bruno_demo, pedro_demo, e os leads deles). Dados reais não são afetados. Confirma?')) return;

  const res = await fetch(`${API}/api/admin/limpar-demo`, { method: 'POST' });
  const resultado = await res.json();

  if (!res.ok) {
    alert(resultado.erro || 'Erro ao limpar dados de demonstração');
    return;
  }

  alert(`Limpo: ${resultado.leads_apagados} lead(s) e ${resultado.vendedores_demo_apagados} vendedor(es) demo removidos.`);
  atualizarTudo();
}

async function excluirLeadAtual() {
  if (!leadConversaAtual) return;
  const nome = leadConversaAtual.nome_cliente || leadConversaAtual.telefone;

  if (!confirm(`Excluir permanentemente o lead de ${nome}? Isso apaga toda a conversa e não pode ser desfeito.`)) return;
  if (!confirm(`Confirma DE NOVO: excluir ${nome} pra sempre? Não tem como recuperar depois.`)) return;

  const res = await fetch(`${API}/api/leads/${leadConversaAtual.id}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json();
    alert(err.erro || 'Erro ao excluir lead');
    return;
  }

  fecharModal('modal-conversa');
  atualizarTudo();
}

let vendedorEmRedefinicao = null;

function abrirModalSenha(vendedorId, nome) {
  vendedorEmRedefinicao = vendedorId;
  document.getElementById('senha-titulo').textContent = `Redefinir senha de ${nome}`;
  document.getElementById('senha-nova').value = '';
  document.getElementById('senha-erro').style.display = 'none';
  abrirModal('modal-senha');
}

async function confirmarRedefinirSenha() {
  const senha = document.getElementById('senha-nova').value;
  const erroEl = document.getElementById('senha-erro');
  erroEl.style.display = 'none';

  if (!senha || senha.length < 4) {
    erroEl.textContent = 'Senha muito curta (mínimo 4 caracteres).';
    erroEl.style.display = 'block';
    return;
  }

  const res = await fetch(`${API}/api/vendedores/${vendedorEmRedefinicao}/redefinir-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha }),
  });

  if (!res.ok) {
    const err = await res.json();
    erroEl.textContent = err.erro || 'Erro ao redefinir senha';
    erroEl.style.display = 'block';
    return;
  }

  fecharModal('modal-senha');
  alert('Senha atualizada com sucesso.');
}

async function rodarAnaliseDiariaAgora() {
  const btn = document.getElementById('btn-rodar-analise');
  btn.disabled = true;
  btn.textContent = '🤖 Rodando...';

  const res = await fetch(`${API}/api/admin/rodar-analise-diaria`, { method: 'POST' });
  const resultado = await res.json();

  btn.disabled = false;
  btn.textContent = '🤖 Rodar análise diária';

  if (!res.ok || !resultado.rodou) {
    alert(resultado.erro || (resultado.motivo === 'ia_nao_configurada' ? 'IA não configurada ainda nesse servidor.' : 'Não rodou.'));
    return;
  }
  alert(`Análise concluída: ${resultado.conversas_revisadas} conversa(s) revisada(s), ${resultado.tarefas_criadas} tarefa(s) criada(s).`);
  carregarLembretes();
}

async function sair() {
  await fetch(`${API}/api/logout`, { method: 'POST' });
  window.location.href = '/login.html';
}

async function cadastrarVendedor() {
  const nome = document.getElementById('c-nome').value.trim();
  const login = document.getElementById('c-login').value.trim();
  const senha = document.getElementById('c-senha').value;
  const role = document.getElementById('c-role').value;
  const msgEl = document.getElementById('cadastro-msg');

  const res = await fetch(`${API}/api/vendedores`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome, login, senha, role }),
  });
  const data = await res.json();

  if (res.ok) {
    msgEl.textContent = `Vendedor "${nome}" cadastrado. Passe o login e a senha pra ele.`;
    msgEl.className = 'msg ok';
    document.getElementById('c-nome').value = '';
    document.getElementById('c-login').value = '';
    document.getElementById('c-senha').value = '';
    carregarVendedores();
  } else {
    msgEl.textContent = data.erro || 'Erro ao cadastrar';
    msgEl.className = 'msg erro';
  }
}

async function carregarVendedores() {
  const res = await fetch(`${API}/api/vendedores`);
  if (res.status === 401) return window.location.href = '/login.html';
  const vendedores = await res.json();
  vendedoresCache = vendedores;
  const el = document.getElementById('vendedores');
  const ehAdmin = usuarioAtual && usuarioAtual.role === 'admin';
  el.innerHTML = vendedores.map(v => `
    <div class="side-card">
      <div class="vendedor-name" style="display:flex; justify-content:space-between; align-items:center;">
        <span>${v.nome}${v.role === 'admin' ? ' 👑' : v.role === 'supervisor' ? ' 🛡️' : ''}</span>
        ${ehAdmin ? `<span style="display:flex; gap:8px;"><button class="link-mini" onclick="abrirEdicaoCadastro(${v.id})">✏️</button><button class="link-mini" onclick="abrirModalSenha(${v.id}, '${v.nome.replace(/'/g, "\\'")}')">🔑</button></span>` : ''}
      </div>
      <div class="vendedor-count">${v.leads_ativos} atendimento${v.leads_ativos === 1 ? '' : 's'} ativo${v.leads_ativos === 1 ? '' : 's'}</div>
    </div>
  `).join('');
  return vendedores;
}

async function carregarLeads() {
  if (!setorAtivo) return;
  let url = `${API}/api/leads?status=novo&setor=${setorAtivo}`;
  const filtroData = document.getElementById('filtro-data-fila');
  if (filtroData && filtroData.value) {
    url += `&data=${filtroData.value}`;
  }
  const res = await fetch(url);
  if (res.status === 401) return window.location.href = '/login.html';
  const leads = await res.json();
  leadsCache = leads;
  const el = document.getElementById('leads');
  const contagemEl = document.getElementById('leads-count');
  if (contagemEl) contagemEl.textContent = leads.length;

  if (leads.length === 0) {
    el.innerHTML = `<li class="empty-state">Nenhum lead novo esperando. Assim que uma mensagem chegar no WhatsApp, aparece aqui.</li>`;
    return;
  }

  // Limite de 5 conversas simultâneas por vendedor, só em Vendas — depois
  // de bater o limite, os leads novos ficam cinza (ainda visíveis, mas
  // sem poder abrir) até o vendedor fechar alguma conversa.
  const noLimite = setorAtivo === 'vendas' && !ehGestor(usuarioAtual)
    && conversasAtivasCache.filter((l) => l.vendedor_id === usuarioAtual.id).length >= 5;

  const avisoLimite = noLimite
    ? `<li class="empty-state" style="background:var(--orange-bg); color:var(--text); border-radius:8px; margin-bottom:8px;">⚠️ Você está com 5 conversas ativas — feche alguma antes de pegar um novo lead.</li>`
    : '';

  // Ordenados por quem chegou primeiro
  const ordenados = [...leads].sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em));

  el.innerHTML = avisoLimite + ordenados.map(l => {
    const nome = l.nome_cliente || l.telefone;

    // Tempo de espera — destaca com ⚠️ se passou de 5 min sem ser puxado
    // (gargalo de fila). Formatado em min/h/dias porque a fila mostra lead
    // de qualquer dia, não só hoje.
    const minutosEsperando = Math.floor((Date.now() - new Date(l.criado_em + 'Z')) / 60000);
    const alerta = minutosEsperando >= 5;
    let tempoTexto;
    if (minutosEsperando < 60) tempoTexto = `${minutosEsperando} min`;
    else if (minutosEsperando < 60 * 24) tempoTexto = `${Math.floor(minutosEsperando / 60)} h`;
    else { const dias = Math.floor(minutosEsperando / (60 * 24)); tempoTexto = `${dias} dia${dias === 1 ? '' : 's'}`; }

    const tags = [l.interesse, l.origem && l.origem !== 'geral' ? l.origem : null].filter(Boolean);
    const tagsHtml = tags.length ? `<div class="lead-tags">${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : '';

    return `
      <li class="lead-item ${noLimite ? 'lead-item--bloqueado' : ''}" onclick="${noLimite ? '' : `abrirConversa(${l.id})`}">
        <div class="lead-avatar">${escapeHtml(iniciais(nome))}</div>
        <div class="lead-main">
          <div class="lead-top">
            <span class="lead-name">${escapeHtml(nome)}</span>
            <span class="lead-time">${alerta ? '⚠️ ' : ''}há ${tempoTexto}</span>
          </div>
          ${tagsHtml}
          <p class="lead-preview">${escapeHtml(l.primeira_mensagem)}</p>
        </div>
      </li>
    `;
  }).join('');
}

// ---------------- Conversa completa (estilo WhatsApp) ----------------
let leadConversaAtual = null;

async function abrirConversa(leadId) {
  const res = await fetch(`${API}/api/leads/${leadId}`);
  if (res.status === 401) return window.location.href = '/login.html';
  if (res.status === 403) {
    alert('Este lead já está sendo atendido por outro vendedor — sem acesso à conversa.');
    return;
  }
  const lead = await res.json();
  leadConversaAtual = lead;
  renderizarConversa(lead);
  abrirModal('modal-conversa');
}

function renderizarMidia(m) {
  if (!m.midia_url) return '';
  // urlMidiaSegura já escapa e recusa qualquer esquema que não seja
  // http(s)/data — se vier nula, a URL era suspeita (ex: "javascript:")
  // e a mídia simplesmente não é renderizada.
  const url = urlMidiaSegura(m.midia_url);
  if (!url) return '';
  if (m.midia_tipo === 'imagem') {
    return `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" style="max-width:100%; border-radius:8px; margin-bottom:6px; display:block;" /></a>`;
  }
  if (m.midia_tipo === 'audio') {
    return `<audio controls src="${url}" style="max-width:220px; margin-bottom:6px; display:block;"></audio>`;
  }
  if (m.midia_tipo === 'video') {
    return `<video controls src="${url}" style="max-width:100%; border-radius:8px; margin-bottom:6px; display:block;"></video>`;
  }
  if (m.midia_tipo === 'documento') {
    return `<a href="${url}" target="_blank" rel="noopener" style="display:block; margin-bottom:6px;">📄 Abrir documento</a>`;
  }
  if (m.midia_tipo === 'sticker') {
    return `<img src="${url}" style="max-width:100px; display:block; margin-bottom:4px;" />`;
  }
  return '';
}

function renderizarConversa(lead) {
  const nome = lead.nome_cliente || lead.telefone;
  document.getElementById('conversa-titulo').textContent = nome;
  document.getElementById('conversa-avatar').textContent = iniciais(nome);
  document.getElementById('conversa-subtitulo').textContent = `${lead.telefone} · ${lead.status === 'novo' ? 'Novo' : lead.status === 'em_atendimento' ? 'Em atendimento' : 'Encerrado'}`;

  const msgsEl = document.getElementById('conversa-mensagens');
  msgsEl.innerHTML = lead.mensagens.map(m => {
    const classe = m.remetente === 'cliente' ? 'balao-cliente' : m.remetente === 'ia' ? 'balao-ia' : 'balao-vendedor';
    const hora = new Date(m.criado_em + 'Z').toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<div class="balao ${classe}">${renderizarMidia(m)}${escapeHtml(m.texto)}<div class="balao-hora">${m.remetente === 'ia' ? 'IA · ' : ''}${hora}</div></div>`;
  }).join('');
  msgsEl.scrollTop = msgsEl.scrollHeight;

  const claimBox = document.getElementById('conversa-acao-claim');
  const respostaBox = document.getElementById('conversa-caixa-resposta');
  const reabrirBox = document.getElementById('conversa-acao-reabrir');
  const headerAcoes = document.getElementById('conversa-header-acoes');

  const podeAgir = lead.dono || ehGestor(usuarioAtual);
  reabrirBox.style.display = (lead.status === 'encerrado' && podeAgir) ? 'block' : 'none';

  if (podeAgir) {
    const mostraResposta = lead.status !== 'encerrado';
    respostaBox.style.display = mostraResposta ? 'flex' : 'none';
    headerAcoes.style.display = mostraResposta ? 'flex' : 'none';
    claimBox.style.display = 'none';
  } else if (lead.status === 'novo') {
    respostaBox.style.display = 'none';
    headerAcoes.style.display = 'none';
    claimBox.style.display = 'block';
  } else {
    respostaBox.style.display = 'none';
    headerAcoes.style.display = 'none';
    claimBox.style.display = 'none';
  }
  document.getElementById('conversa-texto').value = '';
  const sugestaoBox = document.getElementById('conversa-sugestao-tarefa');
  sugestaoBox.style.display = 'none';
  sugestaoBox.innerHTML = '';
  document.getElementById('btn-excluir-lead').style.display = usuarioAtual.role === 'admin' ? 'inline-block' : 'none';
  removerAnexo();
}

let gravador = null;
let pedacosAudio = [];
let gravando = false;

async function alternarGravacaoAudio() {
  const btn = document.getElementById('btn-audio');

  if (gravando) {
    gravador.stop();
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Seu navegador não suporta gravação de áudio.');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    pedacosAudio = [];
    gravador = new MediaRecorder(stream);

    gravador.ondataavailable = (e) => pedacosAudio.push(e.data);
    gravador.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(pedacosAudio, { type: 'audio/webm' });
      const leitor = new FileReader();
      leitor.onload = () => {
        anexoSelecionado = { dataUri: leitor.result, tipo: 'audio', nome: 'audio.webm' };
        const preview = document.getElementById('conversa-anexo-preview');
        preview.style.display = 'flex';
        preview.innerHTML = `🎤 Áudio gravado <button class="link-mini" onclick="removerAnexo()" style="margin-left:auto;">Remover</button>`;
      };
      leitor.readAsDataURL(blob);
      gravando = false;
      btn.textContent = '🎤';
      btn.style.background = '';
    };

    gravador.start();
    gravando = true;
    btn.textContent = '⏹';
    btn.style.background = 'var(--red)';
  } catch (err) {
    alert('Não consegui acessar o microfone. Confere se você deu permissão pro navegador.');
  }
}

let anexoSelecionado = null; // { dataUri, tipo, nome }

function tipoDoArquivo(mime) {
  if (mime.startsWith('image/')) return 'imagem';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'documento';
}

// Fotos de celular guardam a orientação certa só como metadado EXIF —
// o pixel bruto fica "deitado" e um marcador diz "gire 90° pra exibir".
// O navegador do vendedor respeita esse marcador (por isso a prévia aparece
// certa), mas a Z-API/WhatsApp não respeita ao reprocessar a imagem pra
// entregar pro cliente, e ela chega de lado. Corrigimos "queimando" a
// rotação certa direto nos pixels antes de enviar, via canvas — assim a
// imagem final já nasce correta e não depende de mais ninguém respeitar
// EXIF. Se o navegador não suportar (bem raro hoje em dia), cai de volta
// pro comportamento antigo (manda o arquivo original sem mexer).
async function corrigirOrientacaoImagem(arquivo) {
  try {
    const bitmap = await createImageBitmap(arquivo, { imageOrientation: 'from-image' });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.92);
  } catch (err) {
    console.warn('Não deu pra corrigir orientação da imagem, enviando original:', err);
    return null;
  }
}

async function selecionarAnexo(event) {
  const arquivo = event.target.files[0];
  if (!arquivo) return;

  if (arquivo.size > 15 * 1024 * 1024) {
    alert('Arquivo muito grande (máximo 15MB).');
    event.target.value = '';
    return;
  }

  const preview = document.getElementById('conversa-anexo-preview');

  // Só JPEG tem esse problema de rotação por EXIF (é o formato que toda
  // câmera de celular usa). PNG (prints de tela, catálogo, etc) não passa
  // por essa correção — reencodar mudaria o formato à toa e poderia perder
  // transparência sem necessidade nenhuma, já que PNG não sofre desse bug.
  const ehJpeg = arquivo.type === 'image/jpeg' || arquivo.type === 'image/jpg';

  if (ehJpeg) {
    preview.style.display = 'flex';
    preview.innerHTML = `📎 ${arquivo.name} (ajustando orientação...)`;
    const dataUriCorrigido = await corrigirOrientacaoImagem(arquivo);
    if (dataUriCorrigido) {
      anexoSelecionado = { dataUri: dataUriCorrigido, tipo: 'imagem', nome: arquivo.name };
      preview.innerHTML = `📎 ${arquivo.name} <button class="link-mini" onclick="removerAnexo()" style="margin-left:auto;">Remover</button>`;
      return;
    }
    // createImageBitmap falhou — cai pro caminho antigo abaixo
  }

  const leitor = new FileReader();
  leitor.onload = () => {
    anexoSelecionado = { dataUri: leitor.result, tipo: tipoDoArquivo(arquivo.type), nome: arquivo.name };
    preview.style.display = 'flex';
    preview.innerHTML = `📎 ${arquivo.name} <button class="link-mini" onclick="removerAnexo()" style="margin-left:auto;">Remover</button>`;
  };
  leitor.readAsDataURL(arquivo);
}

function removerAnexo() {
  anexoSelecionado = null;
  document.getElementById('conversa-arquivo').value = '';
  const preview = document.getElementById('conversa-anexo-preview');
  preview.style.display = 'none';
  preview.innerHTML = '';
}

async function enviarMensagemConversa() {
  const texto = document.getElementById('conversa-texto').value.trim();
  if (!texto && !anexoSelecionado) return;
  if (!leadConversaAtual) return;

  const corpo = { texto };
  if (anexoSelecionado) {
    corpo.midia_base64 = anexoSelecionado.dataUri;
    corpo.midia_tipo = anexoSelecionado.tipo;
    corpo.midia_nome = anexoSelecionado.nome;
  }

  const res = await fetch(`${API}/api/leads/${leadConversaAtual.id}/mensagens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  if (!res.ok) {
    const err = await res.json();
    alert(err.erro || 'Erro ao enviar mensagem');
    return;
  }

  removerAnexo();
  const atualizado = await (await fetch(`${API}/api/leads/${leadConversaAtual.id}`)).json();
  leadConversaAtual = atualizado;
  renderizarConversa(atualizado);
  carregarLeads();
}

async function puxarLeadDaConversa() {
  if (!leadConversaAtual) return;
  const res = await fetch(`${API}/api/leads/${leadConversaAtual.id}/claim`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json();
    alert(err.erro || 'Erro ao puxar lead');
    return;
  }
  const atualizado = await (await fetch(`${API}/api/leads/${leadConversaAtual.id}`)).json();
  leadConversaAtual = atualizado;
  renderizarConversa(atualizado);
  atualizarTudo();
}

async function reabrirLeadDaConversa() {
  if (!leadConversaAtual) return;
  const res = await fetch(`${API}/api/leads/${leadConversaAtual.id}/reabrir`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json();
    alert(err.erro || 'Erro ao reabrir conversa');
    return;
  }
  const atualizado = await (await fetch(`${API}/api/leads/${leadConversaAtual.id}`)).json();
  leadConversaAtual = atualizado;
  renderizarConversa(atualizado);
  atualizarTudo();
}

async function sugerirTarefaIA() {
  if (!leadConversaAtual) return;
  const box = document.getElementById('conversa-sugestao-tarefa');
  box.style.display = 'block';
  box.textContent = '🤖 Lendo a conversa...';

  const res = await fetch(`${API}/api/leads/${leadConversaAtual.id}/sugestao-tarefa`);
  const sugestao = await res.json();

  if (!res.ok) {
    box.textContent = sugestao.erro || 'Não consegui sugerir agora.';
    return;
  }

  if (!sugestao.sugerir) {
    box.textContent = '🤖 Não achei nenhuma ação pendente óbvia nessa conversa.';
    return;
  }

  box.innerHTML = `🤖 Sugestão: <strong>${escapeHtml(sugestao.titulo)}</strong> <button class="link-mini" style="margin-left:6px;" onclick='usarSugestaoTarefa(${JSON.stringify(sugestao).replace(/'/g, "&apos;")})'>Criar essa tarefa</button>`;
}

function usarSugestaoTarefa(sugestao) {
  fecharModal('modal-conversa');
  abrirNovaTarefa();
  document.getElementById('tarefa-lead').value = leadConversaAtual.id;
  document.getElementById('tarefa-titulo').value = sugestao.titulo || '';
  if (sugestao.tipo) document.getElementById('tarefa-tipo').value = sugestao.tipo;
}

// Encerrar agora é 1 clique só — a IA lê a conversa na análise diária e
// decide sozinha se converteu/perdeu, sem perguntar nada aqui.
let resultadoEscolhidoEncerrar = null; // true = fechou, false = não fechou, null = não informado

function encerrarLeadDaConversa() {
  if (!leadConversaAtual) return;
  resultadoEscolhidoEncerrar = null;
  document.getElementById('enc-campo-valor').style.display = 'none';
  document.getElementById('enc-valor').value = '';
  document.getElementById('enc-erro').textContent = '';
  document.getElementById('enc-btn-confirmar').style.display = 'none';
  document.getElementById('enc-btn-pular').style.display = 'inline-block';
  abrirModal('modal-encerrar');
}

function escolherResultadoEncerrar(fechou) {
  resultadoEscolhidoEncerrar = fechou;
  document.getElementById('enc-campo-valor').style.display = fechou ? 'block' : 'none';
  document.getElementById('enc-btn-confirmar').style.display = 'inline-block';
  document.getElementById('enc-btn-pular').style.display = 'none';
}

async function confirmarEncerrar() {
  if (!leadConversaAtual) return;
  const erroEl = document.getElementById('enc-erro');
  erroEl.textContent = '';

  const body = {};
  if (resultadoEscolhidoEncerrar === true) {
    const valor = parseFloat(document.getElementById('enc-valor').value);
    body.fechou_pedido = true;
    body.valor_venda = isNaN(valor) ? 0 : valor;
  } else if (resultadoEscolhidoEncerrar === false) {
    body.fechou_pedido = false;
  }

  const res = await fetch(`${API}/api/leads/${leadConversaAtual.id}/encerrar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json();
    erroEl.textContent = err.erro || 'Erro ao encerrar';
    return;
  }

  fecharModal('modal-encerrar');
  fecharModal('modal-conversa');
  atualizarTudo();
}

// ---------------- Novo lead manual ----------------
function abrirNovoLeadManual() {
  document.getElementById('nl-nome').value = '';
  document.getElementById('nl-telefone').value = '';
  document.getElementById('nl-observacao').value = '';
  document.getElementById('nl-erro').style.display = 'none';
  abrirModal('modal-novo-lead');
}

async function confirmarNovoLeadManual() {
  const nome_cliente = document.getElementById('nl-nome').value.trim();
  const telefone = document.getElementById('nl-telefone').value.trim();
  const observacao = document.getElementById('nl-observacao').value.trim();
  const erroEl = document.getElementById('nl-erro');
  erroEl.style.display = 'none';

  if (!telefone) {
    erroEl.textContent = 'Informe o telefone.';
    erroEl.style.display = 'block';
    return;
  }

  const res = await fetch(`${API}/api/leads/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telefone, nome_cliente, observacao, setor: setorAtivo }),
  });

  if (!res.ok) {
    const err = await res.json();
    erroEl.textContent = err.erro || 'Erro ao salvar';
    erroEl.style.display = 'block';
    return;
  }

  fecharModal('modal-novo-lead');
  atualizarTudo();
}

// ---------------- Transferir atendimento ----------------
function abrirTransferir() {
  if (!leadConversaAtual) return;
  const sel = document.getElementById('tr-vendedor');
  const outros = vendedoresCache.filter(v => v.id !== usuarioAtual.id && v.role !== 'admin');
  sel.innerHTML = outros.length > 0
    ? outros.map(v => `<option value="${v.id}">${v.nome}</option>`).join('')
    : `<option value="">Nenhum outro vendedor cadastrado</option>`;
  document.getElementById('tr-erro').style.display = 'none';
  abrirModal('modal-transferir');
}

async function confirmarTransferencia() {
  const novo_vendedor_id = document.getElementById('tr-vendedor').value;
  const erroEl = document.getElementById('tr-erro');
  if (!novo_vendedor_id) {
    erroEl.textContent = 'Selecione pra quem transferir.';
    erroEl.style.display = 'block';
    return;
  }

  const res = await fetch(`${API}/api/leads/${leadConversaAtual.id}/transferir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ novo_vendedor_id }),
  });

  if (!res.ok) {
    const err = await res.json();
    erroEl.textContent = err.erro || 'Erro ao transferir';
    erroEl.style.display = 'block';
    return;
  }

  fecharModal('modal-transferir');
  fecharModal('modal-conversa');
  atualizarTudo();
}

// ---------------- Busca de conversas ----------------
let buscaTimeout = null;
function filtrarConversas(termo) {
  clearTimeout(buscaTimeout);
  buscaTimeout = setTimeout(() => carregarConversasAtivas(termo.trim()), 300);
}

// ---------------- Editar cadastro (admin) ----------------
let vendedorEmEdicao = null;
function abrirEdicaoCadastro(vendedorId) {
  const v = vendedoresCache.find(x => x.id === vendedorId);
  if (!v) return;
  vendedorEmEdicao = vendedorId;
  document.getElementById('ec-nome').value = v.nome;
  document.getElementById('ec-login').value = v.login || '';
  document.getElementById('ec-role').value = v.role;
  document.getElementById('ec-erro').style.display = 'none';
  abrirModal('modal-editar-cadastro');
}

async function confirmarEdicaoCadastro() {
  const nome = document.getElementById('ec-nome').value.trim();
  const login = document.getElementById('ec-login').value.trim();
  const role = document.getElementById('ec-role').value;
  const erroEl = document.getElementById('ec-erro');

  const res = await fetch(`${API}/api/vendedores/${vendedorEmEdicao}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome, login, role }),
  });

  if (!res.ok) {
    const err = await res.json();
    erroEl.textContent = err.erro || 'Erro ao salvar';
    erroEl.style.display = 'block';
    return;
  }

  fecharModal('modal-editar-cadastro');
  carregarVendedores();
}

function iniciais(nome) {
  if (!nome) return '?';
  const partes = nome.trim().split(/\s+/);
  return (partes[0][0] + (partes[1] ? partes[1][0] : '')).toUpperCase();
}

// Verdadeiro quando: o vendedor já visualizou a conversa (visto_em >= última
// mensagem do cliente, ou seja não está mais "não lida"), a última mensagem
// segue sendo do cliente (ninguém respondeu depois) e já passou de 3min desde
// que ele visualizou. Conversa encerrada nunca entra nessa regra.
function precisaResposta(l) {
  if (l.status === 'encerrado') return false;
  if (!l.ultima_mensagem || l.ultima_mensagem.remetente !== 'cliente') return false;
  if ((l.nao_lidas || 0) > 0) return false; // ainda nem foi vista, isso já é o badge verde
  if (!l.visto_em) return false;
  const desdeQueViu = new Date(l.visto_em + 'Z').getTime();
  return (Date.now() - desdeQueViu) > 3 * 60 * 1000;
}

// Formata a hora da última mensagem no estilo WhatsApp: hoje mostra só
// "HH:MM", ontem mostra "Ontem", qualquer coisa mais antiga mostra "DD/MM".
function formatarHoraConversa(dataStr) {
  if (!dataStr) return '';
  const data = new Date(dataStr + 'Z');
  const agora = new Date();
  const hoje = agora.toDateString() === data.toDateString();
  if (hoje) {
    return data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  const ontem = new Date(agora);
  ontem.setDate(ontem.getDate() - 1);
  if (ontem.toDateString() === data.toDateString()) return 'Ontem';
  return data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

// Prioridade visual: não lida primeiro, depois por atividade mais recente.
function ordenarConversasPorAtividade(lista) {
  return [...lista].sort((a, b) => {
    const grupo = (l) => (l.nao_lidas || 0) > 0 ? 0 : 1;
    const grupoA = grupo(a);
    const grupoB = grupo(b);
    if (grupoA !== grupoB) return grupoA - grupoB;
    const ta = a.ultima_mensagem ? new Date(a.ultima_mensagem.criado_em) : new Date(a.criado_em);
    const tb = b.ultima_mensagem ? new Date(b.ultima_mensagem.criado_em) : new Date(b.criado_em);
    return tb - ta;
  });
}

function renderizarItemConversa(l) {
  const nome = l.nome_cliente || l.telefone;
  const preview = l.ultima_mensagem ? l.ultima_mensagem.texto : l.primeira_mensagem;
  const tagVendedor = ehGestor(usuarioAtual) && l.vendedor_nome ? `<span class="setor-tag">${escapeHtml(l.vendedor_nome)}</span>` : '';
  const naoLidas = l.nao_lidas || 0;
  const semResposta = precisaResposta(l);
  const hora = l.ultima_mensagem ? formatarHoraConversa(l.ultima_mensagem.criado_em) : '';
  let ladoDireito = `<span class="conv-time">${hora}</span>`;
  if (naoLidas > 0) ladoDireito += `<span class="conv-unread-badge">${naoLidas > 9 ? '9+' : naoLidas}</span>`;
  else if (semResposta) ladoDireito += `<span class="conv-waiting-label">Aguardando resposta</span>`;
  return `
    <li class="conv-item ${naoLidas > 0 ? 'conv-item--nao-lida' : ''} ${semResposta ? 'conv-item--aguardando' : ''}" onclick="abrirConversa(${l.id})">
      <div class="conv-avatar" style="background:${corAvatar(l.id)};">${escapeHtml(iniciais(nome))}</div>
      <div class="conv-main">
        <div class="conv-name">${escapeHtml(nome)} ${tagVendedor}</div>
        <p class="conv-preview">${escapeHtml(preview)}</p>
      </div>
      <div class="conv-side">${ladoDireito}</div>
    </li>
  `;
}

async function carregarConversasAtivas(termoBusca) {
  if (!setorAtivo) return;
  let leads;
  if (termoBusca && termoBusca.length >= 2) {
    const res = await fetch(`${API}/api/leads/buscar?q=${encodeURIComponent(termoBusca)}&setor=${setorAtivo}`);
    if (res.status === 401) return window.location.href = '/login.html';
    leads = await res.json();
  } else {
    const res = await fetch(`${API}/api/leads?status=em_atendimento,encerrado&setor=${setorAtivo}`);
    if (res.status === 401) return window.location.href = '/login.html';
    const todos = await res.json();
    leads = todos.filter(l => !l.restrito);
  }

  conversasAtivasCache = leads.filter(l => l.status !== 'encerrado');

  // --- Card "Conversas em Andamento" (Início): só em_atendimento ---
  const ativas = ordenarConversasPorAtividade(leads.filter((l) => l.status !== 'encerrado'));
  const elAtivas = document.getElementById('conversas-ativas');
  const contagemEl = document.getElementById('conv-count');
  if (contagemEl) contagemEl.textContent = ativas.length;
  elAtivas.innerHTML = ativas.length > 0
    ? ativas.map(renderizarItemConversa).join('')
    : `<li class="empty-state" style="padding:14px; font-size:12px;">${termoBusca ? 'Nenhuma conversa encontrada.' : 'Nenhuma conversa ativa no momento.'}</li>`;

  // --- Aba "Histórico": só encerrado (a não ser que a busca do Histórico
  // esteja em uso — nesse caso quem manda é filtrarHistorico, não aqui) ---
  const buscaHistoricoEl = document.getElementById('busca-historico');
  if (buscaHistoricoEl && buscaHistoricoEl.value.trim().length >= 2) return;
  const elHistorico = document.getElementById('historico-lista');
  if (elHistorico) {
    const encerradas = ordenarConversasPorAtividade(leads.filter((l) => l.status === 'encerrado'));
    elHistorico.innerHTML = encerradas.length > 0
      ? encerradas.map(renderizarItemConversa).join('')
      : `<li class="empty-state" style="padding:14px; font-size:12px;">Nenhuma conversa encerrada ainda.</li>`;
  }
}

// Busca dedicada da aba Histórico — não mexe no card de "Conversas em
// Andamento" do Início, só na lista de encerradas.
let buscaHistoricoTimeout = null;
function filtrarHistorico(termo) {
  clearTimeout(buscaHistoricoTimeout);
  buscaHistoricoTimeout = setTimeout(() => carregarHistorico(termo.trim()), 300);
}
async function carregarHistorico(termoBusca) {
  if (!setorAtivo) return;
  const elHistorico = document.getElementById('historico-lista');
  if (!elHistorico) return;

  if (!termoBusca || termoBusca.length < 2) {
    return carregarConversasAtivas(); // sem termo de busca, volta ao normal
  }

  const res = await fetch(`${API}/api/leads/buscar?q=${encodeURIComponent(termoBusca)}&setor=${setorAtivo}`);
  if (res.status === 401) return window.location.href = '/login.html';
  const leads = await res.json();
  const encerradas = ordenarConversasPorAtividade(leads.filter((l) => l.status === 'encerrado'));
  elHistorico.innerHTML = encerradas.length > 0
    ? encerradas.map(renderizarItemConversa).join('')
    : `<li class="empty-state" style="padding:14px; font-size:12px;">Nenhuma conversa encerrada encontrada.</li>`;
}

// Cor consistente por conversa (mesmo lead sempre com a mesma cor de
// avatar), só pra dar variedade visual — sem significado nenhum.
const CORES_AVATAR = ['#2B3990', '#16A34A', '#D97706', '#7C3AED', '#DB2777', '#0891B2'];
function corAvatar(id) {
  return CORES_AVATAR[id % CORES_AVATAR.length];
}

// ---------------- Nova tarefa (agenda) ----------------
function abrirNovaTarefa() {
  const selLead = document.getElementById('tarefa-lead');
  const campoVendedor = document.getElementById('tarefa-campo-vendedor');
  const selVendedor = document.getElementById('tarefa-vendedor');

  const ehAdmin = ehGestor(usuarioAtual);
  // Admin/supervisor podem criar tarefa em cima de qualquer lead em atendimento (não só os que puxaram)
  const leadsDisponiveis = ehAdmin
    ? conversasAtivasCache
    : conversasAtivasCache.filter(l => l.dono);

  if (leadsDisponiveis.length === 0) {
    selLead.innerHTML = `<option value="">Nenhum lead em atendimento no momento</option>`;
  } else {
    selLead.innerHTML = leadsDisponiveis.map(l => `<option value="${l.id}">${escapeHtml(l.nome_cliente) || escapeHtml(l.telefone)}</option>`).join('');
  }

  if (ehAdmin) {
    campoVendedor.style.display = 'block';
    const vendedores = vendedoresCache.filter(v => v.role === 'vendedor');
    selVendedor.innerHTML = vendedores.length > 0
      ? vendedores.map(v => `<option value="${v.id}">${v.nome}</option>`).join('')
      : `<option value="${usuarioAtual.id}">Eu mesmo (Administrador)</option>`;
  } else {
    campoVendedor.style.display = 'none';
  }

  document.getElementById('tarefa-titulo').value = '';
  document.getElementById('tarefa-erro').style.display = 'none';
  // padrão: amanhã, mesmo horário
  const amanha = new Date(Date.now() + 24 * 60 * 60 * 1000);
  document.getElementById('tarefa-quando').value = amanha.toISOString().slice(0, 16);
  abrirModal('modal-tarefa');
}

async function confirmarTarefa() {
  const erroEl = document.getElementById('tarefa-erro');
  erroEl.style.display = 'none';

  const lead_id = document.getElementById('tarefa-lead').value;
  const titulo = document.getElementById('tarefa-titulo').value.trim();
  const tipo = document.getElementById('tarefa-tipo').value;
  const quandoLocal = document.getElementById('tarefa-quando').value;
  const vendedor_id = ehGestor(usuarioAtual) ? document.getElementById('tarefa-vendedor').value : undefined;

  if (!lead_id || !titulo || !quandoLocal) {
    erroEl.textContent = 'Preencha lead, o que fazer e quando.';
    erroEl.style.display = 'block';
    return;
  }

  const res = await fetch(`${API}/api/lembretes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lead_id, titulo, tipo, quando: new Date(quandoLocal).toISOString(), vendedor_id }),
  });

  if (!res.ok) {
    const err = await res.json();
    erroEl.textContent = err.erro || 'Erro ao criar tarefa';
    erroEl.style.display = 'block';
    return;
  }

  fecharModal('modal-tarefa');
  carregarLembretes();
}

// ---------------- Relatório do dia ----------------
function metricasHtml(m) {
  return `
    <div class="relatorio-grid">
      <div class="relatorio-metric"><div class="valor">${m.leads_recebidos}</div><div class="label">Recebidos</div></div>
      <div class="relatorio-metric"><div class="valor">${m.convertidos}</div><div class="label">Convertidos</div></div>
      <div class="relatorio-metric"><div class="valor">${m.perdidos}</div><div class="label">Perdidos</div></div>
      <div class="relatorio-metric"><div class="valor">${m.taxa_conversao}%</div><div class="label">Conversão</div></div>
      <div class="relatorio-metric"><div class="valor">R$ ${m.ticket_medio.toLocaleString('pt-BR')}</div><div class="label">Ticket médio</div></div>
      <div class="relatorio-metric"><div class="valor">${m.leads_com_gargalo}</div><div class="label">Com gargalo</div></div>
    </div>
    <div style="font-size:13px; color:var(--muted); margin-bottom:10px;">
      Valor total vendido: <strong style="color:var(--text);">R$ ${m.valor_total_vendido.toLocaleString('pt-BR')}</strong><br>
      Tempo médio até 1ª resposta: <strong style="color:var(--text);">${m.tempo_medio_primeira_resposta_min !== null ? m.tempo_medio_primeira_resposta_min + ' min' : '—'}</strong>
    </div>
    ${Object.keys(m.objecoes).length > 0 ? `
      <div class="panel-title" style="font-size:11px; margin-top:14px;">Motivos de perda</div>
      ${Object.entries(m.objecoes).map(([motivo, n]) => `
        <div class="relatorio-vendedor-row"><span>${motivo}</span><span>${n}</span></div>
      `).join('')}
    ` : ''}
  `;
}

async function abrirRelatorio() {
  const res = await fetch(`${API}/api/relatorio`);
  if (res.status === 401) return window.location.href = '/login.html';
  const r = await res.json();

  document.getElementById('relatorio-titulo').textContent = `Relatório — ${new Date(r.data + 'T12:00:00').toLocaleDateString('pt-BR')}`;

  let html = metricasHtml(r);
  if (r.escopo === 'geral' && r.por_vendedor && r.por_vendedor.length > 0) {
    html += `<div class="panel-title" style="font-size:11px; margin-top:16px;">Por vendedor</div>`;
    html += r.por_vendedor.map(v => `
      <div class="relatorio-vendedor-row">
        <span>${v.vendedor}</span>
        <span>${v.convertidos} convertidos · ${v.perdidos} perdidos · R$ ${v.valor_total_vendido.toLocaleString('pt-BR')}</span>
      </div>
    `).join('');
  }

  document.getElementById('relatorio-conteudo').innerHTML = html;
  abrirModal('modal-relatorio');
}

let abaAgendaAtual = 'pendentes';

// Badge vermelho no ícone da Agenda, na sidebar — sempre mostra quantas
// tarefas estão PENDENTES, não importa qual aba da Agenda está aberta.
function atualizarBadgeAgenda(quantidade) {
  const badge = document.getElementById('nav-agenda-badge');
  if (!badge) return;
  badge.textContent = quantidade > 9 ? '9+' : quantidade;
  badge.hidden = quantidade === 0;
}
async function atualizarContadorPendentesAgenda() {
  if (!setorAtivo) return;
  const res = await fetch(`${API}/api/lembretes?status=pendentes&setor=${setorAtivo}`);
  if (!res.ok) return;
  const pendentes = await res.json();
  atualizarBadgeAgenda(pendentes.length);
}

function mudarAbaAgenda(status) {
  abaAgendaAtual = status;
  document.querySelectorAll('#agenda-abas .filter-chip').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.status === status);
  });
  carregarLembretes();
}

// Categoriza o lembrete pra mostrar a tag certa (Gargalo/Oportunidade/Pós-venda/Manual).
// A tabela não guarda essa categoria direto — mas todo lembrete criado
// pela IA tem o título prefixado com "🤖 " (ver agendador.js), e dentro
// desse grupo o campo `tipo` já diferencia oportunidade/pós-venda do resto.
function categoriaLembrete(l) {
  const daIA = l.titulo && l.titulo.startsWith('🤖');
  if (!daIA) return { label: 'Manual', classe: 'tag-manual' };
  if (l.tipo === 'oportunidade') return { label: 'Oportunidade', classe: 'tag-oportunidade' };
  if (l.tipo === 'pos_venda') return { label: 'Pós-venda', classe: 'tag-manual' };
  return { label: 'Gargalo', classe: 'tag-gargalo' };
}

function formatarQuandoAgenda(dataStr) {
  const data = new Date(dataStr);
  const agora = new Date();
  const hora = data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (agora.toDateString() === data.toDateString()) return `hoje, ${hora}`;
  const ontem = new Date(agora);
  ontem.setDate(ontem.getDate() - 1);
  if (ontem.toDateString() === data.toDateString()) return `ontem, ${hora}`;
  return `${data.toLocaleDateString('pt-BR')}, ${hora}`;
}

async function carregarLembretes() {
  if (!setorAtivo) return;
  const res = await fetch(`${API}/api/lembretes?status=${abaAgendaAtual}&setor=${setorAtivo}`);
  if (res.status === 401) return window.location.href = '/login.html';
  const lembretes = await res.json();
  const el = document.getElementById('lembretes');
  if (!el) return;

  const subtituloEl = document.getElementById('agenda-subtitulo');
  if (subtituloEl) {
    const rotulo = { pendentes: 'pendentes', concluidas: 'concluídas', todas: 'no total' }[abaAgendaAtual];
    subtituloEl.textContent = `${lembretes.length} tarefa${lembretes.length === 1 ? '' : 's'} ${rotulo}.`;
  }
  if (abaAgendaAtual === 'pendentes') {
    atualizarBadgeAgenda(lembretes.length);
  }

  if (lembretes.length === 0) {
    const vazio = { pendentes: 'Nenhuma tarefa pendente.', concluidas: 'Nenhuma tarefa concluída ainda.', todas: 'Nenhuma tarefa ainda.' }[abaAgendaAtual];
    el.innerHTML = `<div class="empty-state">${vazio}</div>`;
    return;
  }

  el.innerHTML = lembretes.map((l) => {
    const cat = categoriaLembrete(l);
    const tituloLimpo = escapeHtml((l.titulo || '').replace(/^🤖\s*/, ''));
    const nome = l.nome_cliente || l.telefone;
    return `
      <div class="task-card ${l.feito ? 'task-card--feito' : ''}">
        <button class="task-check" onclick="event.stopPropagation(); ${l.feito ? '' : `concluirLembrete(${l.id})`}" title="${l.feito ? 'Concluída' : 'Marcar como concluída'}">${l.feito ? '✓' : ''}</button>
        <div class="task-main">
          <div class="task-top">
            <span class="task-titulo">${tituloLimpo}</span>
            <span class="tag ${cat.classe}">${cat.label}</span>
          </div>
          <div class="task-sub">
            ${formatarQuandoAgenda(l.quando)} · <a href="#" onclick="event.preventDefault(); abrirConversa(${l.lead_id})">Abrir conversa com ${escapeHtml(nome)} →</a>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function concluirLembrete(id) {
  await fetch(`${API}/api/lembretes/${id}/concluir`, { method: 'POST' });
  carregarLembretes();
}

async function puxarLead(leadId) {
  const res = await fetch(`${API}/api/leads/${leadId}/claim`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json();
    alert(err.erro || 'Erro ao puxar lead');
  }
  atualizarTudo();
}

async function atualizarConversaAberta() {
  const modal = document.getElementById('modal-conversa');
  if (!modal.classList.contains('aberto') || !leadConversaAtual) return;

  const res = await fetch(`${API}/api/leads/${leadConversaAtual.id}`);
  if (!res.ok) return;
  const atualizado = await res.json();

  // Só re-renderiza se realmente chegou mensagem nova — evita apagar o que
  // o vendedor está digitando na caixa de resposta a cada 3 segundos
  const tinhaAntes = leadConversaAtual.mensagens ? leadConversaAtual.mensagens.length : 0;
  const temAgora = atualizado.mensagens ? atualizado.mensagens.length : 0;
  if (temAgora !== tinhaAntes || atualizado.status !== leadConversaAtual.status) {
    const rascunho = document.getElementById('conversa-texto').value;
    const anexoAtual = anexoSelecionado;
    const previewAtual = document.getElementById('conversa-anexo-preview').innerHTML;
    leadConversaAtual = atualizado;
    renderizarConversa(atualizado);
    document.getElementById('conversa-texto').value = rascunho;
    if (anexoAtual) {
      anexoSelecionado = anexoAtual;
      const preview = document.getElementById('conversa-anexo-preview');
      preview.style.display = 'flex';
      preview.innerHTML = previewAtual;
    }
  }
}

async function atualizarTudo() {
  await carregarVendedores();
  await carregarLeads();
  await carregarConversasAtivas();
  await carregarLembretes();
  await carregarMinhaMeta();
  if (abaAgendaAtual !== 'pendentes') await atualizarContadorPendentesAgenda();
  await atualizarConversaAberta();
}

// ---------------- Notificação push ----------------
// Converte a chave pública VAPID (texto base64url) pro formato de bytes
// que o navegador espera em pushManager.subscribe. É sempre essa mesma
// conversão padrão, documentada em todo tutorial de Web Push.
function base64UrlParaUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const bruto = atob(base64);
  const bytes = new Uint8Array(bruto.length);
  for (let i = 0; i < bruto.length; i++) bytes[i] = bruto.charCodeAt(i);
  return bytes;
}

async function registrarServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.warn('Não deu pra registrar o service worker:', err);
    return null;
  }
}

async function inscricaoAtual() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const registro = await navigator.serviceWorker.ready;
  return registro.pushManager.getSubscription();
}

async function atualizarBotaoNotificacoes() {
  const btns = document.querySelectorAll('.btn-notificacoes-el');
  if (btns.length === 0) return;

  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    btns.forEach((btn) => {
      btn.textContent = '🔕 Notificação indisponível';
      btn.disabled = true;
      btn.title = 'Esse navegador não suporta notificação. No iPhone, use "Adicionar à Tela de Início" pelo Safari primeiro.';
    });
    return;
  }

  if (Notification.permission === 'denied') {
    btns.forEach((btn) => {
      btn.textContent = '🚫 Notificação bloqueada';
      btn.title = 'Você bloqueou a notificação pra esse site — pra reativar, muda isso nas configurações do navegador.';
    });
    return;
  }

  const inscricao = await inscricaoAtual();
  btns.forEach((btn) => {
    if (inscricao) {
      btn.textContent = '🔔 Notificações ativadas';
      btn.title = 'Clique pra desativar';
    } else {
      btn.textContent = '🔕 Ativar notificações';
      btn.title = 'Receba aviso de lead novo ou mensagem mesmo com o app fechado';
    }
  });
}

async function alternarNotificacoes() {
  const btns = document.querySelectorAll('.btn-notificacoes-el');
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('Esse navegador não suporta notificação. No iPhone: abra pelo Safari, toque em Compartilhar → "Adicionar à Tela de Início", e acesse o sistema por esse ícone instalado.');
    return;
  }

  const inscricaoExistente = await inscricaoAtual();

  if (inscricaoExistente) {
    // Desativar
    try {
      await fetch(`${API}/api/push/unsubscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: inscricaoExistente.endpoint }),
      });
      await inscricaoExistente.unsubscribe();
    } catch (err) {
      console.warn('Erro ao desativar notificação:', err);
    }
    await atualizarBotaoNotificacoes();
    return;
  }

  // Ativar
  btns.forEach((btn) => { btn.textContent = '⏳ Ativando...'; });
  const permissao = await Notification.requestPermission();
  if (permissao !== 'granted') {
    alert('Sem permissão de notificação, não dá pra te avisar de lead novo com o app fechado. Você pode mudar isso depois nas configurações do navegador.');
    await atualizarBotaoNotificacoes();
    return;
  }

  try {
    const registro = await navigator.serviceWorker.ready;
    const { publicKey } = await (await fetch(`${API}/api/push/public-key`)).json();
    const novaInscricao = await registro.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlParaUint8Array(publicKey),
    });
    await fetch(`${API}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(novaInscricao.toJSON()),
    });
  } catch (err) {
    console.error('Erro ao ativar notificação:', err);
    alert('Não consegui ativar a notificação. Tenta de novo, ou confere se o site está sendo acessado por https.');
  }
  await atualizarBotaoNotificacoes();
}

// Quando o vendedor clica na notificação, o sw.js manda essa mensagem pra
// aba já aberta (se tiver) pedindo pra abrir a conversa certa direto.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.tipo === 'abrir_lead' && event.data.leadId) {
      abrirConversa(event.data.leadId);
    }
  });
}

// Se o sistema foi aberto numa aba NOVA a partir da notificação (não tinha
// nenhuma aba aberta antes), o link vem com ?abrir_lead=ID — abre direto.
function abrirLeadDaUrlSeTiver() {
  const params = new URLSearchParams(window.location.search);
  const leadId = params.get('abrir_lead');
  if (leadId) {
    abrirConversa(Number(leadId));
    history.replaceState({}, '', window.location.pathname);
  }
}

function configurarSidebarRetratil() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  sidebar.addEventListener('mouseenter', () => sidebar.classList.add('is-expanded'));
  sidebar.addEventListener('mouseleave', () => sidebar.classList.remove('is-expanded'));
}

// Menu hambúrguer (mobile) — sidebar vira um menu deslizante por cima do
// conteúdo, com um fundo escurecido atrás. Fecha sozinho ao escolher
// qualquer item (view ou setor), sem precisar tocar no X ou no fundo.
function abrirMenuMobile() {
  document.getElementById('sidebar').classList.add('mobile-aberta');
  document.getElementById('mobile-overlay').classList.add('aberto');
}
function fecharMenuMobile() {
  document.getElementById('sidebar').classList.remove('mobile-aberta');
  document.getElementById('mobile-overlay').classList.remove('aberto');
}

(async function iniciar() {
  aplicarTemaSalvo();
  configurarSidebarRetratil();
  const logado = await checarSessao();
  if (!logado) return;
  registrarServiceWorker();
  atualizarTudo();
  abrirLeadDaUrlSeTiver();
  setInterval(atualizarTudo, 3000); // atualiza sozinho a cada 3s (depois trocamos por realtime)
})();
