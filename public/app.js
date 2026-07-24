const API = '';
let usuarioAtual = null;
let leadsCache = [];
let vendedoresCache = [];
let filtroDataAtual = null; // null = fila ao vivo (padrão); 'AAAA-MM-DD' = revendo um dia específico (só admin)

const LABELS_TIPO = {
  orcamento: 'Orçamento', catalogo: 'Catálogo', frete: 'Frete',
  pos_venda: 'Pós-venda', ligacao: 'Ligação', objecao: 'Objeção',
  oportunidade: 'Oportunidade', outro: 'Outro',
};

const LABELS_ORIGEM = {
  carrinho_abandonado: 'Carrinho abandonado', reativacao: 'Reativação',
  whatsapp: 'WhatsApp', produtos: 'Produtos', duvidas: 'Dúvidas', geral: 'Geral',
};

function fecharModal(id) {
  document.getElementById(id).classList.remove('aberto');
}
function abrirModal(id) {
  document.getElementById(id).classList.add('aberto');
}

async function checarSessao() {
  const res = await fetch(`${API}/api/me`);
  if (!res.ok) {
    window.location.href = '/login.html';
    return false;
  }
  usuarioAtual = await res.json();
  renderizarUserBox();
  return true;
}

function renderizarUserBox() {
  const el = document.getElementById('user-box');
  el.innerHTML = `
    <span class="user-nome">${usuarioAtual.nome}</span>
    <span class="user-role">${usuarioAtual.role === 'admin' ? 'Administrador' : 'Vendedor'}</span>
    <button class="btn-secundario" onclick="sair()">Sair</button>
  `;

  const btnCadastro = document.getElementById('btn-toggle-cadastro');
  if (usuarioAtual.role === 'admin') {
    btnCadastro.style.display = 'inline-block';
    btnCadastro.onclick = () => {
      document.getElementById('cadastro-form').classList.toggle('aberto');
    };
    document.getElementById('btn-rodar-analise').style.display = 'inline-block';
    document.getElementById('btn-toggle-filtro-data').style.display = 'inline-block';
  }
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
  el.innerHTML = vendedores.map(v => `
    <div class="side-card">
      <div class="vendedor-name">${v.nome}${v.role === 'admin' ? ' 👑' : ''}</div>
      <div class="vendedor-count">${v.leads_ativos} atendimento${v.leads_ativos === 1 ? '' : 's'} ativo${v.leads_ativos === 1 ? '' : 's'}</div>
    </div>
  `).join('');
  return vendedores;
}

// ---------------- Filtro por dia (só admin) ----------------
function alternarFiltroData() {
  const bar = document.getElementById('filtro-data-bar');
  const abrindo = bar.style.display === 'none';
  bar.style.display = abrindo ? 'flex' : 'none';
  if (abrindo && !document.getElementById('filtro-data-input').value) {
    document.getElementById('filtro-data-input').value = new Date().toISOString().slice(0, 10);
  }
}

async function aplicarFiltroData() {
  const data = document.getElementById('filtro-data-input').value;
  if (!data) return;
  filtroDataAtual = data;
  document.getElementById('btn-limpar-filtro').style.display = 'inline-block';
  document.getElementById('filtro-data-label').textContent =
    `Mostrando tudo de ${new Date(data + 'T12:00:00').toLocaleDateString('pt-BR')}`;
  await atualizarTudo();
}

async function limparFiltroData() {
  filtroDataAtual = null;
  document.getElementById('btn-limpar-filtro').style.display = 'none';
  document.getElementById('filtro-data-label').textContent = '';
  await atualizarTudo();
}

async function carregarLeads() {
  const url = filtroDataAtual ? `${API}/api/leads?data=${filtroDataAtual}` : `${API}/api/leads`;
  const res = await fetch(url);
  if (res.status === 401) return window.location.href = '/login.html';
  const leads = await res.json();
  leadsCache = leads;
  const el = document.getElementById('leads');

  if (leads.length === 0) {
    el.innerHTML = `<div class="empty-state">${filtroDataAtual ? 'Nenhum lead nesse dia.' : 'Nenhum cliente na fila. Assim que uma mensagem chegar no WhatsApp, aparece aqui.'}</div>`;
    return;
  }

  // Leads novos primeiro (fila de espera), ordenados por quem espera há mais tempo.

  const ordenados = [...leads].sort((a, b) => {
    if (a.status === 'novo' && b.status !== 'novo') return -1;
    if (a.status !== 'novo' && b.status === 'novo') return 1;
    return new Date(a.criado_em) - new Date(b.criado_em);
  });

  el.innerHTML = ordenados.map(l => {
    const badge = l.status === 'novo'
      ? `<span class="badge badge-novo">Novo</span>`
      : l.status === 'em_atendimento'
        ? `<span class="badge badge-atendimento">Em atendimento${l.dono ? ' (você)' : ''}</span>`
        : `<span class="badge badge-encerrado">Encerrado</span>`;

    let acao = '';
    if (l.status === 'novo') {
      acao = `<button onclick="puxarLead(${l.id})">Pegar lead</button>`;
    } else if (l.status === 'em_atendimento' && l.dono) {
      acao = `<button onclick="encerrarLead(${l.id})">Encerrar atendimento</button>`;
    }

    // Tempo de espera na FILA — destaca se passou de 5 min sem ser puxado (gargalo de fila)
    const minutosEsperando = Math.floor((Date.now() - new Date(l.criado_em + 'Z')) / 60000);
    const gargaloFila = l.status === 'novo' && minutosEsperando >= 5;

    // Gargalo DURANTE o atendimento — cliente já foi pego por um vendedor,
    // mas a última mensagem foi dele (cliente) e o vendedor ainda não respondeu
    let gargaloAtendimento = false;
    let minutosSemResposta = 0;
    if (l.status === 'em_atendimento' && l.ultima_mensagem && l.ultima_mensagem.remetente === 'cliente') {
      minutosSemResposta = Math.floor((Date.now() - new Date(l.ultima_mensagem.criado_em + 'Z')) / 60000);
      gargaloAtendimento = minutosSemResposta >= 5;
    }
    const temGargalo = gargaloFila || gargaloAtendimento;

    // Linha única de metadados — origem + tempo/gargalo, pra não empilhar várias linhas por card
    let metaHtml = `<span>${LABELS_ORIGEM[l.origem] || l.origem}</span>`;
    if (gargaloFila) {
      metaHtml += `<span class="alerta-inline">⚠️ esperando há ${minutosEsperando} min</span>`;
    } else if (gargaloAtendimento) {
      metaHtml += `<span class="alerta-inline">⚠️ cliente sem resposta há ${minutosSemResposta} min</span>`;
    } else if (l.status === 'novo') {
      metaHtml += `<span>· esperando há ${minutosEsperando} min</span>`;
    }

    return `
      <div class="ticket-card ${temGargalo ? 'gargalo' : ''} lead-clicavel" onclick="abrirConversa(${l.id})">
        <div class="ticket-number">${String(l.id).padStart(3, '0')}</div>
        <div class="ticket-body">
          <div class="lead-header">
            <strong>${l.nome_cliente || l.telefone}</strong>
            ${badge}
          </div>
          <div class="texto">${l.primeira_mensagem}</div>
          <div class="meta-linha">${metaHtml}</div>
          <div class="acao" onclick="event.stopPropagation()">${acao}</div>
        </div>
      </div>
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

function renderizarConversa(lead) {
  document.getElementById('conversa-titulo').textContent = lead.nome_cliente || lead.telefone;
  document.getElementById('conversa-subtitulo').textContent = `${lead.telefone} · ${lead.status === 'novo' ? 'Novo' : lead.status === 'em_atendimento' ? 'Em atendimento' : 'Encerrado'}`;

  const msgsEl = document.getElementById('conversa-mensagens');
  msgsEl.innerHTML = lead.mensagens.map(m => {
    const classe = m.remetente === 'cliente' ? 'balao-cliente' : m.remetente === 'ia' ? 'balao-ia' : 'balao-vendedor';
    const hora = new Date(m.criado_em + 'Z').toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<div class="balao ${classe}">${m.texto}<div class="balao-hora">${m.remetente === 'ia' ? 'IA · ' : ''}${hora}</div></div>`;
  }).join('');
  msgsEl.scrollTop = msgsEl.scrollHeight;

  const claimBox = document.getElementById('conversa-acao-claim');
  const respostaBox = document.getElementById('conversa-caixa-resposta');

  if (lead.dono || usuarioAtual.role === 'admin') {
    respostaBox.style.display = lead.status === 'encerrado' ? 'none' : 'flex';
    claimBox.style.display = 'none';
  } else if (lead.status === 'novo') {
    respostaBox.style.display = 'none';
    claimBox.style.display = 'block';
  } else {
    respostaBox.style.display = 'none';
    claimBox.style.display = 'none';
  }
  document.getElementById('conversa-texto').value = '';
  const sugestaoBox = document.getElementById('conversa-sugestao-tarefa');
  sugestaoBox.style.display = 'none';
  sugestaoBox.innerHTML = '';
}

async function enviarMensagemConversa() {
  const texto = document.getElementById('conversa-texto').value.trim();
  if (!texto || !leadConversaAtual) return;

  const res = await fetch(`${API}/api/leads/${leadConversaAtual.id}/mensagens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texto }),
  });
  if (!res.ok) {
    const err = await res.json();
    alert(err.erro || 'Erro ao enviar mensagem');
    return;
  }

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

async function sugerirEncerramentoIA() {
  if (!leadEmEncerramento) return;
  const statusEl = document.getElementById('enc-ia-status');
  statusEl.style.display = 'block';
  statusEl.style.color = 'var(--navy)';
  statusEl.textContent = 'Lendo a conversa...';

  const res = await fetch(`${API}/api/leads/${leadEmEncerramento}/sugestao-encerramento`);
  const sugestao = await res.json();

  if (!res.ok) {
    statusEl.style.color = 'var(--red)';
    statusEl.textContent = sugestao.erro || 'Não consegui sugerir agora.';
    return;
  }

  if (sugestao.resultado_sugerido === 'convertido' || sugestao.resultado_sugerido === 'perdido') {
    document.getElementById('enc-resultado').value = sugestao.resultado_sugerido;
    alternarCamposEncerrar();
    if (sugestao.resultado_sugerido === 'convertido' && sugestao.valor_sugerido) {
      document.getElementById('enc-valor').value = sugestao.valor_sugerido;
    }
    if (sugestao.resultado_sugerido === 'perdido' && sugestao.motivo_perda_sugerido) {
      document.getElementById('enc-motivo').value = 'outro';
      document.getElementById('enc-motivo-outro-box').style.display = 'block';
      document.getElementById('enc-motivo-outro').value = sugestao.motivo_perda_sugerido;
    }
  }

  const confiancaLabel = { alta: 'confiança alta', media: 'confiança média', baixa: 'confiança baixa' }[sugestao.confianca] || '';
  statusEl.style.color = 'var(--navy)';
  statusEl.textContent = `🤖 ${sugestao.resumo || 'Sugestão aplicada'} (${confiancaLabel || 'confira antes de confirmar'})`;
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

  box.innerHTML = `🤖 Sugestão: <strong>${sugestao.titulo}</strong> <button class="link-mini" style="margin-left:6px;" onclick='usarSugestaoTarefa(${JSON.stringify(sugestao).replace(/'/g, "&apos;")})'>Criar essa tarefa</button>`;
}

function usarSugestaoTarefa(sugestao) {
  fecharModal('modal-conversa');
  abrirNovaTarefa();
  document.getElementById('tarefa-lead').value = leadConversaAtual.id;
  document.getElementById('tarefa-titulo').value = sugestao.titulo || '';
  if (sugestao.tipo) document.getElementById('tarefa-tipo').value = sugestao.tipo;
}

let leadEmEncerramento = null;

function encerrarLead(leadId) {
  leadEmEncerramento = leadId;
  document.getElementById('enc-resultado').value = '';
  document.getElementById('enc-valor').value = '';
  document.getElementById('enc-motivo-outro').value = '';
  document.getElementById('enc-campo-valor').style.display = 'none';
  document.getElementById('enc-campo-motivo').style.display = 'none';
  document.getElementById('enc-erro').style.display = 'none';
  document.getElementById('enc-ia-status').style.display = 'none';
  abrirModal('modal-encerrar');
}

function alternarCamposEncerrar() {
  const resultado = document.getElementById('enc-resultado').value;
  document.getElementById('enc-campo-valor').style.display = resultado === 'convertido' ? 'block' : 'none';
  document.getElementById('enc-campo-motivo').style.display = resultado === 'perdido' ? 'block' : 'none';
}

document.addEventListener('DOMContentLoaded', () => {
  const motivoSel = document.getElementById('enc-motivo');
  if (motivoSel) {
    motivoSel.addEventListener('change', () => {
      document.getElementById('enc-motivo-outro-box').style.display = motivoSel.value === 'outro' ? 'block' : 'none';
    });
  }
});

async function confirmarEncerrar() {
  const resultado = document.getElementById('enc-resultado').value;
  const erroEl = document.getElementById('enc-erro');
  erroEl.style.display = 'none';

  if (!resultado) {
    erroEl.textContent = 'Selecione o resultado.';
    erroEl.style.display = 'block';
    return;
  }

  const body = { resultado };
  if (resultado === 'convertido') {
    const valor = document.getElementById('enc-valor').value;
    if (!valor) {
      erroEl.textContent = 'Informe o valor da venda.';
      erroEl.style.display = 'block';
      return;
    }
    body.valor_venda = valor;
  } else {
    const motivoSel = document.getElementById('enc-motivo').value;
    const motivo = motivoSel === 'outro' ? document.getElementById('enc-motivo-outro').value.trim() : motivoSel;
    if (!motivo) {
      erroEl.textContent = 'Descreva o motivo da perda.';
      erroEl.style.display = 'block';
      return;
    }
    body.motivo_perda = motivo;
  }

  const res = await fetch(`${API}/api/leads/${leadEmEncerramento}/encerrar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json();
    erroEl.textContent = err.erro || 'Erro ao encerrar';
    erroEl.style.display = 'block';
    return;
  }

  fecharModal('modal-encerrar');
  atualizarTudo();
}

// ---------------- Nova tarefa (agenda) ----------------
function abrirNovaTarefa() {
  const selLead = document.getElementById('tarefa-lead');
  const campoVendedor = document.getElementById('tarefa-campo-vendedor');
  const selVendedor = document.getElementById('tarefa-vendedor');

  const ehAdmin = usuarioAtual.role === 'admin';
  // Admin pode criar tarefa em cima de qualquer lead em atendimento (não só os que ele mesmo puxou)
  const leadsDisponiveis = ehAdmin
    ? leadsCache.filter(l => l.status === 'em_atendimento')
    : leadsCache.filter(l => l.dono && l.status !== 'encerrado');

  if (leadsDisponiveis.length === 0) {
    selLead.innerHTML = `<option value="">Nenhum lead em atendimento no momento</option>`;
  } else {
    selLead.innerHTML = leadsDisponiveis.map(l => `<option value="${l.id}">${l.nome_cliente || l.telefone}</option>`).join('');
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
  const vendedor_id = usuarioAtual.role === 'admin' ? document.getElementById('tarefa-vendedor').value : undefined;

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
  const url = filtroDataAtual ? `${API}/api/relatorio?data=${filtroDataAtual}` : `${API}/api/relatorio`;
  const res = await fetch(url);
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

async function carregarLembretes() {
  const res = await fetch(`${API}/api/lembretes`);
  if (res.status === 401) return window.location.href = '/login.html';
  const lembretes = await res.json();
  const el = document.getElementById('lembretes');
  if (!el) return;

  if (lembretes.length === 0) {
    el.innerHTML = `<div class="empty-state" style="padding:14px; font-size:12px;">Nenhum lembrete pendente.</div>`;
    return;
  }

  el.innerHTML = lembretes.map(l => `
    <div class="side-card">
      <div class="tipo-badge tipo-${l.tipo || 'outro'}">${LABELS_TIPO[l.tipo] || 'Outro'}</div>
      <div class="lembrete-titulo">${l.titulo}</div>
      <div class="lembrete-quando">${new Date(l.quando).toLocaleString('pt-BR')}</div>
      <button onclick="concluirLembrete(${l.id})">Concluído</button>
    </div>
  `).join('');
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

// ---------------- Novo lead manual (carrinho abandonado / reativação) ----------------
function abrirLeadManual() {
  document.getElementById('lm-nome').value = '';
  document.getElementById('lm-telefone').value = '';
  document.getElementById('lm-interesse').value = '';
  document.getElementById('lm-origem').value = 'carrinho_abandonado';
  document.getElementById('lm-erro').style.display = 'none';
  abrirModal('modal-lead-manual');
}

async function confirmarLeadManual() {
  const erroEl = document.getElementById('lm-erro');
  erroEl.style.display = 'none';

  const nome_cliente = document.getElementById('lm-nome').value.trim();
  const telefone = document.getElementById('lm-telefone').value.trim();
  const interesse = document.getElementById('lm-interesse').value.trim();
  const origem = document.getElementById('lm-origem').value;

  if (!nome_cliente || !telefone || !interesse) {
    erroEl.textContent = 'Preencha nome, telefone e intenção de compra.';
    erroEl.style.display = 'block';
    return;
  }

  const res = await fetch(`${API}/api/leads/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome_cliente, telefone, interesse, origem }),
  });

  if (!res.ok) {
    const err = await res.json();
    erroEl.textContent = err.erro || 'Erro ao criar lead';
    erroEl.style.display = 'block';
    return;
  }

  fecharModal('modal-lead-manual');
  atualizarTudo();
}

async function atualizarTudo() {
  await carregarVendedores();
  await carregarLeads();
  await carregarLembretes();
}

(async function iniciar() {
  const logado = await checarSessao();
  if (!logado) return;
  atualizarTudo();
  setInterval(atualizarTudo, 3000); // atualiza sozinho a cada 3s (depois trocamos por realtime)
})();
