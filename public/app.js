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
const SVG_SETOR = {
  vendas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h2l2.4 12.2a2 2 0 002 1.8h8.4a2 2 0 002-1.6L21 9H6"/><circle cx="9" cy="21" r="1"/><circle cx="18" cy="21" r="1"/></svg>',
  financeiro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>',
  expedicao: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="1" y="7" width="14" height="10"/><path d="M15 10h4l3 3v4h-7z"/><circle cx="6" cy="19" r="2"/><circle cx="17.5" cy="19" r="2"/></svg>',
};
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
      <span class="switch-icon">${SVG_SETOR[s.slug] || ''}</span><span>${escapeHtml(s.nome)}</span>
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

  // Histórico de relatórios (gargalo de negociação) só existe pro
  // Financeiro, e só admin acessa.
  const btnHistoricoRel = document.getElementById('btn-historico-relatorios');
  if (btnHistoricoRel) btnHistoricoRel.style.display = (usuarioAtual.role === 'admin' && setorAtivo === 'financeiro') ? 'inline-block' : 'none';

  // "Contatos" agora é uma lista de verdade (nome + telefone salvos pela
  // equipe), igual pros 3 setores — não precisa mais trocar o rótulo
  // dependendo do setor como antes.
  const labelClientes = document.getElementById('nav-clientes-label');
  if (labelClientes) labelClientes.textContent = 'Contatos';
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
  if (nome === 'clientes') carregarContatos();
  fecharMenuMobile();
}

let buscaContatosTimeout = null;
function filtrarContatos(termo) {
  clearTimeout(buscaContatosTimeout);
  buscaContatosTimeout = setTimeout(() => carregarContatos(termo.trim()), 250);
}

async function carregarContatos(termoBusca) {
  const el = document.getElementById('contatos-lista');
  if (!el) return;
  const url = termoBusca ? `${API}/api/contatos?q=${encodeURIComponent(termoBusca)}` : `${API}/api/contatos`;
  const res = await fetch(url);
  if (res.status === 401) return window.location.href = '/login.html';
  if (!res.ok) return;
  const contatos = await res.json();

  document.getElementById('contatos-titulo').textContent = `Contatos (${contatos.length})`;

  el.innerHTML = contatos.length > 0
    ? contatos.map((c) => `
      <li class="conv-item" onclick="abrirConversaPorTelefone('${c.telefone}', '${escapeHtml(c.nome).replace(/'/g, "\\'")}')">
        <div class="conv-avatar" style="background:${corAvatar(c.id)};">${escapeHtml(iniciais(c.nome))}</div>
        <div class="conv-main">
          <div class="conv-name">${escapeHtml(c.nome)}</div>
          <p class="conv-preview">${escapeHtml(c.telefone)}</p>
        </div>
      </li>
    `).join('')
    : `<li class="empty-state" style="padding:14px; font-size:12px;">${termoBusca ? 'Nenhum contato encontrado.' : 'Nenhum contato salvo ainda. Use "Salvar contato" numa conversa, ou "+ Criar Contato" na tela de Início.'}</li>`;
}

// Clicar num contato salvo tenta achar uma conversa existente com esse
// telefone no setor atual; se não tiver nenhuma ainda, cria uma nova
// (mesmo caminho do "+ Criar Contato", só que sem pedir os dados de novo).
async function abrirConversaPorTelefone(telefone, nome) {
  const res = await fetch(`${API}/api/leads/buscar?q=${encodeURIComponent(telefone)}&setor=${setorAtivo}`);
  if (res.ok) {
    const encontrados = await res.json();
    const existente = encontrados.find((l) => l.telefone === telefone);
    if (existente) { abrirConversa(existente.id); return; }
  }
  const criar = await fetch(`${API}/api/leads/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telefone, nome_cliente: nome, setor: setorAtivo }),
  });
  const data = await criar.json();
  if (!criar.ok) { alert(data.erro || 'Erro ao abrir conversa'); return; }
  atualizarTudo();
  setTimeout(() => abrirConversa(data.lead_id), 200);
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
        <button class="user-dropdown-item" onclick="event.stopPropagation(); document.getElementById('user-dropdown').hidden = true; mudarView('configuracoes');" style="display:flex; align-items:center; gap:8px;">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" fill="none"/></svg>
          Configurações
        </button>
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
    renderizarCheckboxesSetores();
    btnCadastro.style.display = 'inline-block';
    btnCadastro.onclick = () => {
      document.getElementById('cadastro-form').classList.toggle('aberto');
    };
  }
  if (usuarioAtual.role === 'admin') {
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
      <p>Cadastro de funcionários — apenas administradores podem contratar/dar acesso a alguém novo.</p>
      <button class="btn-primary btn-small" style="width:100%;" onclick="document.getElementById('painel-vendedores').scrollIntoView({behavior:'smooth'}); document.getElementById('cadastro-form').classList.add('aberto');">+ Cadastrar funcionário</button>
      <p style="font-size:11.5px; color:var(--muted); margin-top:10px; margin-bottom:0;">A lista da equipe fica logo abaixo, nessa mesma tela. Clientes, fornecedores e parceiros são cadastrados como contato (+ Criar Contato, na tela de Início), não aqui.</p>
    `;
  } else {
    el.innerHTML = `
      <h3>Cadastros</h3>
      <p>Cadastro de funcionários — apenas administradores podem contratar/dar acesso a alguém novo.</p>
      <p style="font-size:12.5px; color:var(--muted); margin-top:10px; margin-bottom:0;">Pra registrar cliente, fornecedor ou parceiro novo, use "+ Criar Contato" na tela de Início.</p>
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
function atualizarPlaceholderMeta() {
  const tipo = document.getElementById('metas-tipo').value;
  const input = document.getElementById('metas-valor');
  const preview = document.getElementById('metas-valor-preview');
  const placeholders = { pedidos: 'Ex: 15', valor: 'Ex: 20000', atendimentos: 'Ex: 30' };
  input.placeholder = placeholders[tipo] || 'Valor da meta';

  if (tipo === 'valor' && input.value) {
    const num = parseFloat(input.value);
    preview.textContent = isNaN(num) ? '' : `= ${num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`;
  } else {
    preview.textContent = '';
  }
}

async function popularSelectVendedoresMetas() {
  const select = document.getElementById('metas-vendedor');
  if (select.dataset.carregado === setorAtivo) return;
  const res = await fetch(`${API}/api/vendedores`);
  if (!res.ok) return;
  const vendedores = await res.json();
  const doSetor = vendedores.filter((v) => v.role === 'vendedor' && (v.setores || []).includes(setorAtivo));
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
  atualizarPlaceholderMeta();
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
  const celebra = document.getElementById('meta-celebra');
  const heroRow = document.getElementById('hero-row');
  if (!card || !usuarioAtual) return;

  if (ehGestor(usuarioAtual)) {
    card.style.display = 'none';
    celebra.style.display = 'none';
    heroRow.className = 'hero-row hero-row--single';
    return;
  }

  const res = await fetch(`${API}/api/metas/${usuarioAtual.id}`);
  if (!res.ok) return;
  const data = await res.json();

  if (!data.meta) {
    card.style.display = 'none';
    celebra.style.display = 'none';
    heroRow.className = 'hero-row hero-row--single';
    return;
  }

  const cfg = LABELS_TIPO_META[data.meta.tipo];
  const bateu = data.percentual >= 100;
  card.style.display = 'block';
  heroRow.className = 'hero-row';

  document.getElementById('meta-titulo').textContent = `🎯 SUA META DA ${data.meta.periodo === 'mes' ? 'MÊS' : 'SEMANA'}`;
  document.getElementById('meta-numeros').textContent = `${cfg.formatar(data.atual)} / ${cfg.formatar(data.meta.valor_meta)}`;
  document.getElementById('meta-falta').innerHTML = bateu
    ? '🎉 Meta batida — mandou bem!'
    : `Faltam <b>${cfg.formatar(data.falta)}</b> pra você bater sua meta!`;

  const fill = document.getElementById('meta-barra-fill');
  fill.style.width = `${data.percentual}%`;
  fill.classList.toggle('meta-batida', bateu);

  // Anel de progresso — circunferência de r=38 é 2*PI*38 ≈ 238.76
  const circunferencia = 238.76;
  const offset = circunferencia * (1 - data.percentual / 100);
  document.getElementById('meta-ring-fill').style.strokeDashoffset = offset;
  document.getElementById('meta-ring-fill').style.stroke = bateu ? '#FFD166' : 'white';
  document.getElementById('meta-ring-texto').textContent = `${data.percentual}%`;

  document.getElementById('meta-mini-conquistado').textContent = cfg.formatar(data.atual);
  document.getElementById('meta-mini-faltam').textContent = bateu ? '🎉' : cfg.formatar(data.falta);
  document.getElementById('meta-mini-dias').textContent = data.diasRestantes === 0 ? 'Último dia!' : `${data.diasRestantes} dias`;

  celebra.style.display = bateu ? 'block' : 'none';

  // Confete só na hora que bate 100% de verdade — não fica repetindo a
  // cada atualização de 3s enquanto a meta continuar batida.
  const chaveMeta = `${data.meta.id}-${data.meta.definida_em}`;
  if (bateu && metaBatidaComemorada !== chaveMeta) {
    metaBatidaComemorada = chaveMeta;
    dispararConfete();
  }
}

let metaBatidaComemorada = null;

function dispararConfete() {
  const cores = ['#2B3990', '#E63329', '#16A34A', '#F5820D', '#FFD166'];
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed; inset:0; pointer-events:none; z-index:200; overflow:hidden;';
  document.body.appendChild(container);

  for (let i = 0; i < 60; i++) {
    const pedaco = document.createElement('div');
    const cor = cores[Math.floor(Math.random() * cores.length)];
    const esquerda = Math.random() * 100;
    const atraso = Math.random() * 0.4;
    const duracao = 2.2 + Math.random() * 1.2;
    const tamanho = 6 + Math.random() * 6;
    pedaco.style.cssText = `
      position:absolute; top:-20px; left:${esquerda}vw; width:${tamanho}px; height:${tamanho * 0.6}px;
      background:${cor}; opacity:.9; border-radius:2px;
      animation: cair-confete ${duracao}s ease-in ${atraso}s forwards;
    `;
    container.appendChild(pedaco);
  }
  setTimeout(() => container.remove(), 4000);
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

  if (setorAtivo === 'financeiro') {
    const res = await fetch(`${API}/api/relatorios-financeiro/gerar-agora?setor=financeiro`, { method: 'POST' });
    const resultado = await res.json();
    btn.disabled = false;
    btn.textContent = '🤖 Gerar Análise';
    if (!res.ok) {
      alert(resultado.erro || 'Não rodou.');
      return;
    }
    abrirHistoricoRelatorios(resultado.data);
    return;
  }

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

async function abrirHistoricoRelatorios(dataParaAbrir) {
  const res = await fetch(`${API}/api/relatorios-financeiro?setor=financeiro`);
  if (!res.ok) { alert('Erro ao carregar histórico'); return; }
  const datas = await res.json();
  const listaEl = document.getElementById('historico-relatorios-lista');

  if (datas.length === 0) {
    listaEl.innerHTML = `<div class="empty-state" style="font-size:12px;">Nenhum relatório gerado ainda.</div>`;
    document.getElementById('historico-relatorios-conteudo').textContent = '';
    abrirModal('modal-historico-relatorios');
    return;
  }

  listaEl.innerHTML = datas.map((d) => `
    <button class="link-mini historico-rel-item" data-data="${d.data}" onclick="carregarConteudoRelatorio('${d.data}')"
      style="display:block; width:100%; text-align:left; padding:7px 8px; border-radius:6px; font-size:12.5px; margin-bottom:2px;">
      ${new Date(d.data + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })}
    </button>
  `).join('');

  abrirModal('modal-historico-relatorios');
  carregarConteudoRelatorio(dataParaAbrir || datas[0].data);
}

async function carregarConteudoRelatorio(data) {
  document.querySelectorAll('.historico-rel-item').forEach((b) => {
    b.style.background = b.dataset.data === data ? 'var(--navy-bg)' : 'none';
    b.style.color = b.dataset.data === data ? 'var(--navy)' : 'inherit';
  });
  const conteudoEl = document.getElementById('historico-relatorios-conteudo');
  conteudoEl.textContent = 'Carregando...';
  const res = await fetch(`${API}/api/relatorios-financeiro/${data}?setor=financeiro`);
  if (!res.ok) { conteudoEl.textContent = 'Relatório não encontrado.'; return; }
  const relatorio = await res.json();
  conteudoEl.textContent = relatorio.conteudo;
}

async function sair() {
  await fetch(`${API}/api/logout`, { method: 'POST' });
  window.location.href = '/login.html';
}

function renderizarCheckboxesSetores() {
  const el = document.getElementById('c-setores');
  if (!el || setoresDisponiveis.length === 0) return;
  const opcoes = setoresDisponiveis.length > 0 ? setoresDisponiveis : [{ slug: 'vendas', nome: 'Vendas' }];
  el.innerHTML = opcoes.map((s) => `
    <label style="display:flex; align-items:center; gap:6px; font-size:13px; font-weight:400;">
      <input type="checkbox" class="c-setor-check" value="${s.slug}" ${s.slug === setorAtivo ? 'checked' : ''} style="width:auto;" />
      ${escapeHtml(s.nome)}
    </label>
  `).join('');
}

async function cadastrarVendedor() {
  const nome = document.getElementById('c-nome').value.trim();
  const login = document.getElementById('c-login').value.trim();
  const senha = document.getElementById('c-senha').value;
  const role = document.getElementById('c-role').value;
  const msgEl = document.getElementById('cadastro-msg');
  const setores = [...document.querySelectorAll('.c-setor-check:checked')].map((c) => c.value);

  const res = await fetch(`${API}/api/vendedores`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome, login, senha, role, setores }),
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
        ${ehAdmin ? `<span style="display:flex; gap:8px;"><button class="link-mini" onclick="abrirEdicaoCadastro(${v.id})">✏️</button><button class="link-mini" onclick="abrirModalSenha(${v.id}, '${v.nome.replace(/'/g, "\\'")}')">🔑</button><button class="link-mini" style="color:var(--red);" onclick="excluirVendedor(${v.id}, '${v.nome.replace(/'/g, "\\'")}')">🗑️</button></span>` : ''}
      </div>
      <div class="vendedor-count">${v.leads_ativos} atendimento${v.leads_ativos === 1 ? '' : 's'} ativo${v.leads_ativos === 1 ? '' : 's'}</div>
    </div>
  `).join('');
  return vendedores;
}

async function excluirVendedor(id, nome) {
  if (!confirm(`Excluir o cadastro de ${nome}? Isso remove o acesso dele ao sistema (o histórico de conversas dele é mantido).`)) return;
  const res = await fetch(`${API}/api/vendedores/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json();
    alert(err.erro || 'Erro ao excluir');
    return;
  }
  carregarVendedores();
}

async function carregarLeads() {
  if (!setorAtivo) return;
  const url = `${API}/api/leads?status=novo&setor=${setorAtivo}`;
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
  cancelarResposta();
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
    const nome = m.midia_nome || 'documento';
    return `<a href="${url}" download="${escapeHtml(nome)}" style="display:block; margin-bottom:6px;">📄 Baixar ${escapeHtml(nome)}</a>`;
  }
  if (m.midia_tipo === 'sticker') {
    return `<img src="${url}" style="max-width:100px; display:block; margin-bottom:4px;" />`;
  }
  return '';
}

// O prefixo "*Nome:*" que a gente manda pro WhatsApp (Financeiro/Expedição/
// grupo) usa a formatação de negrito do próprio WhatsApp (asterisco).
// Aqui dentro do nosso sistema isso deve aparecer em negrito de verdade,
// sem os asteriscos literais — só cosmético, não muda o texto salvo.
function formatarTextoMensagem(texto) {
  const escapado = escapeHtml(texto);
  const semPrefixo = escapado.replace(/^\*(.+?):\*\n/, '<strong>$1:</strong><br>');
  // Destaca @Menção em negrito — só cosmético, não muda o texto salvo.
  // Sem cor fixa de propósito: o balão do vendedor tem fundo navy com
  // texto branco, uma cor fixa ficaria ilegível nesse caso.
  return semPrefixo.replace(/(^|\s)(@[a-zA-ZÀ-ÿ0-9_]+(?:\s[A-ZÀ-Ÿ][a-zA-ZÀ-ÿ]*)*)(?=[\s,.!?]|$)/g, (m, espaco, mencao) =>
    `${espaco}<span style="font-weight:800; text-decoration:underline;">${mencao}</span>`
  );
}

function renderizarConversa(lead) {
  const nome = lead.nome_cliente || lead.telefone;
  document.getElementById('conversa-titulo').textContent = nome;
  document.getElementById('conversa-avatar').textContent = iniciais(nome);
  document.getElementById('conversa-subtitulo').textContent = `${lead.telefone} · ${lead.status === 'novo' ? 'Novo' : lead.status === 'em_atendimento' ? 'Em atendimento' : 'Encerrado'}`;
  document.getElementById('btn-salvar-contato').style.display = lead.contato_salvo ? 'none' : 'inline-block';

  const msgsEl = document.getElementById('conversa-mensagens');
  const porId = {};
  lead.mensagens.forEach((m) => { porId[m.id] = m; });

  msgsEl.innerHTML = lead.mensagens.map(m => {
    const classe = m.remetente === 'cliente' ? 'balao-cliente' : m.remetente === 'ia' ? 'balao-ia' : 'balao-vendedor';
    const hora = new Date(m.criado_em + 'Z').toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

    let citacaoHtml = '';
    const original = m.responde_a ? porId[m.responde_a] : null;
    if (original) {
      const autorOriginal = original.remetente === 'cliente' ? (lead.nome_cliente || lead.telefone) : original.remetente === 'ia' ? 'IA' : 'Você';
      citacaoHtml = `<span class="balao-citacao" onclick="irParaMensagem(${original.id})">
        <span class="balao-citacao-autor">${escapeHtml(autorOriginal)}</span>
        <span class="balao-citacao-texto">${escapeHtml(original.texto.replace(/^\*(.+?):\*\n/, '$1: '))}</span>
      </span>`;
    }

    const podeEditarApagar = m.remetente === 'vendedor' && !m.apagada;
    const acoesHtml = `<span class="balao-acoes">
        <span class="balao-btn-responder" onclick="iniciarResposta(${m.id})" title="Responder">↩</span>
        ${podeEditarApagar ? `<span class="balao-btn-responder" onclick="abrirEditarMensagem(${m.id})" title="Editar">✏️</span>` : ''}
        ${podeEditarApagar ? `<span class="balao-btn-responder" onclick="apagarMensagem(${m.id})" title="Apagar">🗑️</span>` : ''}
      </span>`;
    const marcaEditada = m.editada && !m.apagada ? '<span style="opacity:.6; font-size:10px;"> (editada)</span>' : '';

    return `<div class="balao ${classe} ${m.apagada ? 'balao-apagada' : ''}" id="msg-${m.id}">
        ${acoesHtml}
        ${citacaoHtml}${renderizarMidia(m)}${formatarTextoMensagem(m.texto)}${marcaEditada}<div class="balao-hora">${m.remetente === 'ia' ? 'IA · ' : ''}${hora}</div>
      </div>`;
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

let anexosSelecionados = []; // [{ dataUri, tipo, nome }]

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

function renderizarPreviewAnexos() {
  const preview = document.getElementById('conversa-anexo-preview');
  if (anexosSelecionados.length === 0) {
    preview.style.display = 'none';
    preview.innerHTML = '';
    return;
  }
  preview.style.display = 'flex';
  preview.style.flexWrap = 'wrap';
  preview.innerHTML = anexosSelecionados.map((a, i) => `
    <span style="display:inline-flex; align-items:center; gap:4px; background:var(--card); border:1px solid var(--border); border-radius:14px; padding:2px 8px;">
      📎 ${escapeHtml(a.nome)} <button class="link-mini" onclick="removerAnexo(${i})" style="padding:0;">✕</button>
    </span>
  `).join('') + (anexosSelecionados.length > 1 ? `<span style="color:var(--muted); font-size:11px;">${anexosSelecionados.length} arquivos — cada um vira uma mensagem separada</span>` : '');
}

async function processarUmArquivo(arquivo) {
  if (arquivo.size > 15 * 1024 * 1024) {
    alert(`"${arquivo.name}" é muito grande (máximo 15MB) — não foi anexado.`);
    return;
  }
  // Só JPEG tem o problema de rotação por EXIF (é o formato que toda
  // câmera de celular usa). PNG (prints de tela, catálogo etc) não passa
  // por essa correção.
  const ehJpeg = arquivo.type === 'image/jpeg' || arquivo.type === 'image/jpg';
  if (ehJpeg) {
    const dataUriCorrigido = await corrigirOrientacaoImagem(arquivo);
    if (dataUriCorrigido) {
      anexosSelecionados.push({ dataUri: dataUriCorrigido, tipo: 'imagem', nome: arquivo.name });
      renderizarPreviewAnexos();
      return;
    }
    // createImageBitmap falhou — cai pro caminho antigo abaixo
  }
  await new Promise((resolve) => {
    const leitor = new FileReader();
    leitor.onload = () => {
      anexosSelecionados.push({ dataUri: leitor.result, tipo: tipoDoArquivo(arquivo.type), nome: arquivo.name });
      renderizarPreviewAnexos();
      resolve();
    };
    leitor.readAsDataURL(arquivo);
  });
}

async function selecionarAnexo(event) {
  const arquivos = [...event.target.files];
  if (arquivos.length === 0) return;
  const preview = document.getElementById('conversa-anexo-preview');
  preview.style.display = 'flex';
  preview.innerHTML = `📎 Processando ${arquivos.length} arquivo(s)...`;
  for (const arquivo of arquivos) {
    await processarUmArquivo(arquivo);
  }
  event.target.value = '';
}

function removerAnexo(indice) {
  if (indice === undefined) {
    anexosSelecionados = [];
  } else {
    anexosSelecionados.splice(indice, 1);
  }
  document.getElementById('conversa-arquivo').value = '';
  renderizarPreviewAnexos();
}

async function enviarMensagemConversa() {
  const campoTexto = document.getElementById('conversa-texto');
  const texto = campoTexto.value.trim();
  if (!texto && anexosSelecionados.length === 0) return;
  if (!leadConversaAtual) return;

  const respondeAId = respondendoA ? respondendoA.id : null;
  let algumEnvioFalhou = false;

  // Texto (se tiver) vai como mensagem própria, carregando a citação de
  // resposta se houver uma ativa.
  if (texto) {
    const res = await fetch(`${API}/api/leads/${leadConversaAtual.id}/mensagens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto, ...(respondeAId ? { responde_a: respondeAId } : {}) }),
    });
    if (!res.ok) { const err = await res.json(); alert(err.erro || 'Erro ao enviar mensagem'); algumEnvioFalhou = true; }
  }

  // Cada anexo vira uma mensagem própria — é assim que o WhatsApp
  // realmente entrega quando manda vários arquivos de uma vez.
  for (const anexo of anexosSelecionados) {
    const res = await fetch(`${API}/api/leads/${leadConversaAtual.id}/mensagens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ midia_base64: anexo.dataUri, midia_tipo: anexo.tipo, midia_nome: anexo.nome }),
    });
    if (!res.ok) { algumEnvioFalhou = true; }
  }
  if (algumEnvioFalhou) alert('Uma ou mais mensagens não foram enviadas — confere a conversa.');

  campoTexto.value = '';
  campoTexto.style.height = 'auto';
  removerAnexo();
  cancelarResposta();
  const atualizado = await (await fetch(`${API}/api/leads/${leadConversaAtual.id}`)).json();
  leadConversaAtual = atualizado;
  renderizarConversa(atualizado);
  carregarLeads();
}

// ---------------- Textarea: Shift+Enter quebra linha, Enter envia ----------------
function ajustarAlturaTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 220) + 'px';
}

function aoTeclarMensagem(event) {
  const dropdown = document.getElementById('conversa-mencoes-dropdown');
  const dropdownAberto = dropdown.style.display === 'block';

  if (dropdownAberto && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === 'Escape')) {
    navegarMencoes(event);
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    enviarMensagemConversa();
  }
}

function aoDigitarMensagem(el) {
  ajustarAlturaTextarea(el);
  detectarMencao(el);
}

// ---------------- Menções com @ (pra direcionar em conversa de grupo) ----------------
let mencaoIndiceAtivo = 0;
let mencaoOpcoesAtuais = [];

function detectarMencao(el) {
  const valor = el.value;
  const cursor = el.selectionStart;
  const antesCursor = valor.slice(0, cursor);
  const match = antesCursor.match(/(?:^|\s)@([a-zA-ZÀ-ÿ0-9_]*)$/);
  const dropdown = document.getElementById('conversa-mencoes-dropdown');
  if (!match) {
    dropdown.style.display = 'none';
    return;
  }
  const fragmento = match[1].toLowerCase();
  const candidatos = (vendedoresCache || []).filter((v) =>
    (v.setores || []).includes(setorAtivo) && v.nome.toLowerCase().includes(fragmento)
  );
  if (candidatos.length === 0) {
    dropdown.style.display = 'none';
    return;
  }
  mencaoOpcoesAtuais = candidatos.slice(0, 6);
  mencaoIndiceAtivo = 0;
  renderizarDropdownMencoes();
}

function renderizarDropdownMencoes() {
  const dropdown = document.getElementById('conversa-mencoes-dropdown');
  dropdown.innerHTML = mencaoOpcoesAtuais.map((v, i) => `
    <div onclick="selecionarMencao('${escapeHtml(v.nome).replace(/'/g, "\\'")}')"
      style="padding:8px 12px; cursor:pointer; font-size:13px; ${i === mencaoIndiceAtivo ? 'background:var(--navy-bg); color:var(--navy);' : ''}">
      @${escapeHtml(v.nome)}
    </div>
  `).join('');
  dropdown.style.display = 'block';
}

function navegarMencoes(event) {
  const dropdown = document.getElementById('conversa-mencoes-dropdown');
  if (event.key === 'Escape') { dropdown.style.display = 'none'; event.preventDefault(); return; }
  if (event.key === 'ArrowDown') { mencaoIndiceAtivo = Math.min(mencaoIndiceAtivo + 1, mencaoOpcoesAtuais.length - 1); renderizarDropdownMencoes(); event.preventDefault(); return; }
  if (event.key === 'ArrowUp') { mencaoIndiceAtivo = Math.max(mencaoIndiceAtivo - 1, 0); renderizarDropdownMencoes(); event.preventDefault(); return; }
  if (event.key === 'Enter') { event.preventDefault(); selecionarMencao(mencaoOpcoesAtuais[mencaoIndiceAtivo].nome); }
}

function selecionarMencao(nome) {
  const el = document.getElementById('conversa-texto');
  const valor = el.value;
  const cursor = el.selectionStart;
  const antesCursor = valor.slice(0, cursor);
  const depoisCursor = valor.slice(cursor);
  const novoAntes = antesCursor.replace(/(?:^|\s)@([a-zA-ZÀ-ÿ0-9_]*)$/, (m) => (m.startsWith(' ') ? ' ' : '') + '@' + nome + ' ');
  el.value = novoAntes + depoisCursor;
  const novaPosicao = novoAntes.length;
  el.focus();
  el.setSelectionRange(novaPosicao, novaPosicao);
  document.getElementById('conversa-mencoes-dropdown').style.display = 'none';
  ajustarAlturaTextarea(el);
}

// ---------------- Responder mensagem específica (estilo WhatsApp) ----------------
let respondendoA = null; // { id, autor, texto }

function iniciarResposta(msgId) {
  if (!leadConversaAtual) return;
  const msg = leadConversaAtual.mensagens.find((m) => m.id === msgId);
  if (!msg) return;
  const autor = msg.remetente === 'cliente' ? (leadConversaAtual.nome_cliente || leadConversaAtual.telefone) : msg.remetente === 'ia' ? 'IA' : 'Você';
  respondendoA = { id: msg.id, autor, texto: msg.texto };
  document.getElementById('conversa-respondendo-autor').textContent = autor;
  document.getElementById('conversa-respondendo-texto').textContent = msg.texto.replace(/^\*(.+?):\*\n/, '$1: ');
  document.getElementById('conversa-respondendo-preview').style.display = 'flex';
  document.getElementById('conversa-texto').focus();
}

function cancelarResposta() {
  respondendoA = null;
  document.getElementById('conversa-respondendo-preview').style.display = 'none';
}

// Clicar numa citação (dentro de um balão) pula pra mensagem original —
// mesmo comportamento do WhatsApp.
function irParaMensagem(msgId) {
  const el = document.getElementById(`msg-${msgId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.style.outline = '2px solid var(--navy)';
  setTimeout(() => { el.style.outline = 'none'; }, 900);
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
function encerrarLeadDaConversa() {
  if (!leadConversaAtual) return;

  // Fechou/não fechou pedido é conceito de VENDA — Financeiro e Expedição
  // não têm isso, então só perguntam uma vez, direto.
  if (setorAtivo !== 'vendas') {
    if (confirm('Encerrar essa conversa?')) confirmarEncerrar(null);
    return;
  }

  document.getElementById('enc-erro').textContent = '';
  abrirModal('modal-encerrar');
}

let msgEmEdicao = null;

function abrirEditarMensagem(msgId) {
  if (!leadConversaAtual) return;
  const msg = leadConversaAtual.mensagens.find((m) => m.id === msgId);
  if (!msg) return;
  msgEmEdicao = msgId;
  document.getElementById('em-texto').value = msg.texto.replace(/^\*(.+?):\*\n/, '');
  document.getElementById('em-erro').textContent = '';
  abrirModal('modal-editar-mensagem');
}

async function confirmarEditarMensagem() {
  if (!leadConversaAtual || !msgEmEdicao) return;
  const texto = document.getElementById('em-texto').value.trim();
  const erroEl = document.getElementById('em-erro');
  if (!texto) { erroEl.textContent = 'Não pode ficar em branco.'; return; }

  const res = await fetch(`${API}/api/leads/${leadConversaAtual.id}/mensagens/${msgEmEdicao}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texto }),
  });
  if (!res.ok) {
    const err = await res.json();
    erroEl.textContent = err.erro || 'Erro ao editar';
    return;
  }
  fecharModal('modal-editar-mensagem');
  const atualizado = await (await fetch(`${API}/api/leads/${leadConversaAtual.id}`)).json();
  leadConversaAtual = atualizado;
  renderizarConversa(atualizado);
}

async function apagarMensagem(msgId) {
  if (!leadConversaAtual) return;
  if (!confirm('Apagar essa mensagem? Isso só apaga aqui no sistema — se já foi entregue no WhatsApp do cliente, continua lá.')) return;
  const res = await fetch(`${API}/api/leads/${leadConversaAtual.id}/mensagens/${msgId}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json();
    alert(err.erro || 'Erro ao apagar');
    return;
  }
  const atualizado = await (await fetch(`${API}/api/leads/${leadConversaAtual.id}`)).json();
  leadConversaAtual = atualizado;
  renderizarConversa(atualizado);
}

async function marcarComoNaoLida() {
  if (!leadConversaAtual) return;
  const res = await fetch(`${API}/api/leads/${leadConversaAtual.id}/marcar-nao-lida`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json();
    alert(err.erro || 'Erro ao marcar como não lida');
    return;
  }
  fecharModal('modal-conversa');
  atualizarTudo();
}

function abrirSalvarContato() {
  if (!leadConversaAtual) return;
  document.getElementById('sc-nome').value = leadConversaAtual.nome_cliente || '';
  document.getElementById('sc-erro').textContent = '';
  abrirModal('modal-salvar-contato');
}

async function confirmarSalvarContato() {
  if (!leadConversaAtual) return;
  const nome = document.getElementById('sc-nome').value.trim();
  const erroEl = document.getElementById('sc-erro');
  if (!nome) {
    erroEl.textContent = 'Digite um nome.';
    return;
  }
  const res = await fetch(`${API}/api/contatos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telefone: leadConversaAtual.telefone, nome }),
  });
  if (!res.ok) {
    const err = await res.json();
    erroEl.textContent = err.erro || 'Erro ao salvar';
    return;
  }
  fecharModal('modal-salvar-contato');
  leadConversaAtual.contato_salvo = true;
  leadConversaAtual.nome_cliente = nome;
  document.getElementById('conversa-titulo').textContent = nome;
  document.getElementById('btn-salvar-contato').style.display = 'none';
  atualizarTudo();
}

// fechou: true = fechou pedido | false = não fechou | null = não informar (IA decide depois)
async function confirmarEncerrar(fechou) {
  if (!leadConversaAtual) return;
  const erroEl = document.getElementById('enc-erro');
  erroEl.textContent = '';

  const body = {};
  if (fechou === true) body.fechou_pedido = true;
  else if (fechou === false) body.fechou_pedido = false;

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
  const resultado = await res.json();

  // Já salva como contato de verdade também, se um nome foi informado —
  // é exatamente o que esse botão promete fazer.
  if (nome_cliente) {
    fetch(`${API}/api/contatos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telefone, nome: nome_cliente }),
    }).catch(() => {});
  }

  fecharModal('modal-novo-lead');
  atualizarTudo();

  // Esse telefone já tinha conversa (aberta ou encerrada) — não criou
  // nada novo, só atualizou o nome. Avisa isso claramente, senão parece
  // que não aconteceu nada.
  if (resultado.ja_existia) {
    alert(`Esse número já tinha conversa registrada — só atualizei o nome pra "${nome_cliente}". Nenhuma conversa nova foi criada.`);
  }
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
  const previewBruto = l.ultima_mensagem ? l.ultima_mensagem.texto : l.primeira_mensagem;
  const preview = previewBruto.replace(/^\*(.+?):\*\n/, '$1: ');
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

  // --- Aba "Histórico": só encerrado, últimas 24h (a busca cobre o resto
  // — a não ser que ela esteja em uso, nesse caso quem manda é
  // filtrarHistorico, não aqui) ---
  const buscaHistoricoEl = document.getElementById('busca-historico');
  if (buscaHistoricoEl && buscaHistoricoEl.value.trim().length >= 2) return;
  const elHistorico = document.getElementById('historico-lista');
  if (elHistorico) {
    const ha24h = Date.now() - 24 * 60 * 60 * 1000;
    const encerradasRecentes = leads.filter((l) => l.status === 'encerrado' && l.encerrado_em && new Date(l.encerrado_em + 'Z').getTime() >= ha24h);
    const encerradas = ordenarConversasPorAtividade(encerradasRecentes);
    elHistorico.innerHTML = encerradas.length > 0
      ? encerradas.map(renderizarItemConversa).join('')
      : `<li class="empty-state" style="padding:14px; font-size:12px;">Nenhuma conversa encerrada nas últimas 24h. Use a busca acima pra achar conversas mais antigas.</li>`;
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
  ['busca-conversas', 'busca-historico', 'busca-contatos'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  atualizarTudo();
  abrirLeadDaUrlSeTiver();
  setInterval(atualizarTudo, 3000); // atualiza sozinho a cada 3s (depois trocamos por realtime)
})();
