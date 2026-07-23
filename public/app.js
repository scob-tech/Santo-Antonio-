const API = '';
let usuarioAtual = null;
let leadsCache = [];

const LABELS_TIPO = {
  orcamento: 'Orçamento', catalogo: 'Catálogo', frete: 'Frete',
  pos_venda: 'Pós-venda', ligacao: 'Ligação', objecao: 'Objeção', outro: 'Outro',
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
  }
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
  const el = document.getElementById('vendedores');
  el.innerHTML = vendedores.map(v => `
    <div class="side-card">
      <div class="vendedor-name">${v.nome}${v.role === 'admin' ? ' 👑' : ''}</div>
      <div class="vendedor-count">${v.leads_ativos} atendimento${v.leads_ativos === 1 ? '' : 's'} ativo${v.leads_ativos === 1 ? '' : 's'}</div>
    </div>
  `).join('');
  return vendedores;
}

async function carregarLeads() {
  const res = await fetch(`${API}/api/leads`);
  if (res.status === 401) return window.location.href = '/login.html';
  const leads = await res.json();
  leadsCache = leads;
  const el = document.getElementById('leads');

  if (leads.length === 0) {
    el.innerHTML = `<div class="empty-state">Nenhum cliente na fila. Assim que uma mensagem chegar no WhatsApp, aparece aqui.</div>`;
    return;
  }

  // Leads novos primeiro (fila de espera), ordenados por quem espera há mais tempo.
  // A ordem de chegada também vira o número da senha (ticket).
  const porChegada = [...leads].sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em));
  const numeroSenha = new Map(porChegada.map((l, i) => [l.id, i + 1]));

  const ordenados = [...leads].sort((a, b) => {
    if (a.status === 'novo' && b.status !== 'novo') return -1;
    if (a.status !== 'novo' && b.status === 'novo') return 1;
    return new Date(a.criado_em) - new Date(b.criado_em);
  });

  el.innerHTML = ordenados.map(l => {
    // Lead restrito: outro vendedor já pegou, só mostramos o mínimo
    if (l.restrito) {
      return `
        <div class="ticket-card restrito">
          <div class="ticket-number">${String(numeroSenha.get(l.id)).padStart(3, '0')}</div>
          <div class="ticket-body">
            <div class="lead-header">
              <strong>${l.nome_cliente || 'Cliente'}</strong>
              <span class="badge badge-restrito">Em atendimento</span>
            </div>
            <div class="texto">${l.interesse ? `Interesse: ${l.interesse}` : 'Sem produto identificado'}</div>
            <div style="font-size:11px; color:var(--muted); margin-top:4px;">Já está sendo atendido por outro vendedor</div>
          </div>
        </div>
      `;
    }

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
    let tempoHtml = '';
    if (l.status === 'novo') {
      const alerta = minutosEsperando >= 5;
      tempoHtml = `<div class="${alerta ? 'alerta' : ''}" style="${alerta ? '' : 'font-size:12px; color:var(--muted); margin-top:6px;'}">
        ${alerta ? '⚠️ ' : ''}Esperando há ${minutosEsperando} min${alerta ? ' — gargalo de fila' : ''}
      </div>`;
    }

    // Gargalo DURANTE o atendimento — cliente já foi pego por um vendedor,
    // mas a última mensagem foi dele (cliente) e o vendedor ainda não respondeu
    let gargaloAtendimentoHtml = '';
    if (l.status === 'em_atendimento' && l.ultima_mensagem && l.ultima_mensagem.remetente === 'cliente') {
      const minutosSemResposta = Math.floor((Date.now() - new Date(l.ultima_mensagem.criado_em + 'Z')) / 60000);
      if (minutosSemResposta >= 5) {
        gargaloAtendimentoHtml = `<div class="alerta">⚠️ Cliente esperando resposta há ${minutosSemResposta} min — gargalo de atendimento</div>`;
      }
    }

    const origemHtml = `<span class="origem-tag">Origem: ${l.origem}</span>`;
    const temGargalo = (l.status === 'novo' && minutosEsperando >= 5) || gargaloAtendimentoHtml !== '';

    return `
      <div class="ticket-card ${temGargalo ? 'gargalo' : ''}">
        <div class="ticket-number">${String(numeroSenha.get(l.id)).padStart(3, '0')}</div>
        <div class="ticket-body">
          <div class="lead-header">
            <strong>${l.nome_cliente || l.telefone}</strong>
            ${badge}
          </div>
          <div class="texto">${l.primeira_mensagem}</div>
          ${origemHtml}
          ${tempoHtml}
          ${gargaloAtendimentoHtml}
          <div class="acao">${acao}</div>
        </div>
      </div>
    `;
  }).join('');
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
  const meusLeads = leadsCache.filter(l => l.dono && l.status !== 'encerrado');
  if (meusLeads.length === 0) {
    selLead.innerHTML = `<option value="">Você não tem leads em atendimento</option>`;
  } else {
    selLead.innerHTML = meusLeads.map(l => `<option value="${l.id}">${l.nome_cliente || l.telefone}</option>`).join('');
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

  if (!lead_id || !titulo || !quandoLocal) {
    erroEl.textContent = 'Preencha lead, o que fazer e quando.';
    erroEl.style.display = 'block';
    return;
  }

  const res = await fetch(`${API}/api/lembretes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lead_id, titulo, tipo, quando: new Date(quandoLocal).toISOString() }),
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
