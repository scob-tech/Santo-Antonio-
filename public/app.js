const API = '';
// Login da conta "de desenvolvedor" — só ela vê o botão "Limpar demo".
// Contas admin criadas depois (ex: pro cliente final) não têm esse botão.
const LOGIN_DESENVOLVEDOR = 'admin';
let usuarioAtual = null;
let leadsCache = [];
let conversasAtivasCache = [];
let vendedoresCache = [];

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
  renderizarUserBox();
  return true;
}

function renderizarUserBox() {
  const el = document.getElementById('user-box');
  const rotulos = { admin: 'Administrador', supervisor: 'Supervisor', vendedor: 'Vendedor' };
  el.innerHTML = `
    <span class="user-nome">${usuarioAtual.nome}</span>
    <span class="user-role">${rotulos[usuarioAtual.role] || 'Vendedor'}</span>
    ${usuarioAtual.role === 'admin' ? `<button class="btn-secundario" onclick="abrirModalSenha(${usuarioAtual.id}, 'você')">🔑 Minha senha</button>` : ''}
    <button class="btn-secundario" onclick="sair()">Sair</button>
  `;

  const btnCadastro = document.getElementById('btn-toggle-cadastro');
  if (usuarioAtual.role === 'admin') {
    document.getElementById('painel-vendedores').style.display = 'block';
    document.getElementById('filtro-data-fila').style.display = 'inline-block';
    btnCadastro.style.display = 'inline-block';
    btnCadastro.onclick = () => {
      document.getElementById('cadastro-form').classList.toggle('aberto');
    };
  }
  if (ehGestor(usuarioAtual)) {
    document.getElementById('btn-rodar-analise').style.display = 'inline-block';
  }
  // "Limpar demo" fica exclusivo da conta de desenvolvedor (login "admin"),
  // não de qualquer administrador — quando o cliente ganhar a própria conta
  // admin (ex: pra Juliana), esse botão não aparece pra ela.
  if (usuarioAtual.login === LOGIN_DESENVOLVEDOR) {
    document.getElementById('btn-limpar-demo').style.display = 'inline-block';
  }
  if (usuarioAtual.role !== 'supervisor') {
    document.getElementById('btn-relatorio').style.display = 'inline-block';
  }
}

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
  let url = `${API}/api/leads?status=novo`;
  const filtroData = document.getElementById('filtro-data-fila');
  if (usuarioAtual.role === 'admin' && filtroData && filtroData.value) {
    url += `&data=${filtroData.value}`;
  }
  const res = await fetch(url);
  if (res.status === 401) return window.location.href = '/login.html';
  const leads = await res.json();
  leadsCache = leads;
  const el = document.getElementById('leads');

  if (leads.length === 0) {
    el.innerHTML = `<div class="empty-state">Nenhum lead novo esperando. Assim que uma mensagem chegar no WhatsApp, aparece aqui.</div>`;
    return;
  }

  // Ordenados por quem chegou primeiro — a ordem de chegada vira o número da senha (ticket)
  const ordenados = [...leads].sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em));
  const numeroSenha = new Map(ordenados.map((l, i) => [l.id, i + 1]));

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
      <div class="ticket-card ${temGargalo ? 'gargalo' : ''} lead-clicavel" onclick="abrirConversa(${l.id})">
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

function renderizarMidia(m) {
  if (!m.midia_url) return '';
  if (m.midia_tipo === 'imagem') {
    return `<a href="${m.midia_url}" target="_blank" rel="noopener"><img src="${m.midia_url}" style="max-width:100%; border-radius:8px; margin-bottom:6px; display:block;" /></a>`;
  }
  if (m.midia_tipo === 'audio') {
    return `<audio controls src="${m.midia_url}" style="max-width:220px; margin-bottom:6px; display:block;"></audio>`;
  }
  if (m.midia_tipo === 'video') {
    return `<video controls src="${m.midia_url}" style="max-width:100%; border-radius:8px; margin-bottom:6px; display:block;"></video>`;
  }
  if (m.midia_tipo === 'documento') {
    return `<a href="${m.midia_url}" target="_blank" rel="noopener" style="display:block; margin-bottom:6px;">📄 Abrir documento</a>`;
  }
  if (m.midia_tipo === 'sticker') {
    return `<img src="${m.midia_url}" style="max-width:100px; display:block; margin-bottom:4px;" />`;
  }
  return '';
}

function renderizarConversa(lead) {
  document.getElementById('conversa-titulo').textContent = lead.nome_cliente || lead.telefone;
  document.getElementById('conversa-subtitulo').textContent = `${lead.telefone} · ${lead.status === 'novo' ? 'Novo' : lead.status === 'em_atendimento' ? 'Em atendimento' : 'Encerrado'}`;

  const msgsEl = document.getElementById('conversa-mensagens');
  msgsEl.innerHTML = lead.mensagens.map(m => {
    const classe = m.remetente === 'cliente' ? 'balao-cliente' : m.remetente === 'ia' ? 'balao-ia' : 'balao-vendedor';
    const hora = new Date(m.criado_em + 'Z').toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<div class="balao ${classe}">${renderizarMidia(m)}${m.texto}<div class="balao-hora">${m.remetente === 'ia' ? 'IA · ' : ''}${hora}</div></div>`;
  }).join('');
  msgsEl.scrollTop = msgsEl.scrollHeight;

  const claimBox = document.getElementById('conversa-acao-claim');
  const respostaBox = document.getElementById('conversa-caixa-resposta');

  if (lead.dono || ehGestor(usuarioAtual)) {
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

function selecionarAnexo(event) {
  const arquivo = event.target.files[0];
  if (!arquivo) return;

  if (arquivo.size > 15 * 1024 * 1024) {
    alert('Arquivo muito grande (máximo 15MB).');
    event.target.value = '';
    return;
  }

  const leitor = new FileReader();
  leitor.onload = () => {
    anexoSelecionado = { dataUri: leitor.result, tipo: tipoDoArquivo(arquivo.type), nome: arquivo.name };
    const preview = document.getElementById('conversa-anexo-preview');
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

// Encerrar agora é 1 clique só — a IA lê a conversa na análise diária e
// decide sozinha se converteu/perdeu, sem perguntar nada aqui.
async function encerrarLeadDaConversa() {
  if (!leadConversaAtual) return;
  if (!confirm(`Encerrar o atendimento de ${leadConversaAtual.nome_cliente || leadConversaAtual.telefone}?`)) return;

  const res = await fetch(`${API}/api/leads/${leadConversaAtual.id}/encerrar`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json();
    alert(err.erro || 'Erro ao encerrar');
    return;
  }

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
    body: JSON.stringify({ telefone, nome_cliente, observacao }),
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

async function carregarConversasAtivas(termoBusca) {
  let leads;
  if (termoBusca && termoBusca.length >= 2) {
    const res = await fetch(`${API}/api/leads/buscar?q=${encodeURIComponent(termoBusca)}`);
    if (res.status === 401) return window.location.href = '/login.html';
    leads = await res.json();
  } else {
    const res = await fetch(`${API}/api/leads?status=em_atendimento,encerrado`);
    if (res.status === 401) return window.location.href = '/login.html';
    const todos = await res.json();
    leads = todos.filter(l => !l.restrito);
  }

  conversasAtivasCache = leads.filter(l => l.status !== 'encerrado');

  const el = document.getElementById('conversas-ativas');
  if (leads.length === 0) {
    el.innerHTML = `<div class="empty-state" style="padding:14px; font-size:12px;">${termoBusca ? 'Nenhuma conversa encontrada.' : 'Nenhuma conversa ativa no momento.'}</div>`;
    return;
  }

  const ordenadas = [...leads].sort((a, b) => {
    const ta = a.ultima_mensagem ? new Date(a.ultima_mensagem.criado_em) : new Date(a.criado_em);
    const tb = b.ultima_mensagem ? new Date(b.ultima_mensagem.criado_em) : new Date(b.criado_em);
    return tb - ta;
  });

  el.innerHTML = ordenadas.map(l => {
    const nome = l.nome_cliente || l.telefone;
    const preview = l.ultima_mensagem ? l.ultima_mensagem.texto : l.primeira_mensagem;
    const tagVendedor = ehGestor(usuarioAtual) && l.vendedor_nome ? `<span class="conversa-vendedor-tag">${l.vendedor_nome}</span>` : '';
    const naoLidas = l.nao_lidas || 0;
    const badge = naoLidas > 0 ? `<span class="conversa-badge">${naoLidas > 9 ? '9+' : naoLidas}</span>` : '';
    const encerradaTag = l.status === 'encerrado' ? `<span class="conversa-vendedor-tag" style="color:var(--muted);">Encerrado</span>` : '';
    return `
      <div class="conversa-item ${naoLidas > 0 ? 'nao-lida' : ''} ${l.status === 'encerrado' ? 'encerrada' : ''}" onclick="abrirConversa(${l.id})">
        <div class="conversa-avatar">${iniciais(nome)}</div>
        <div class="conversa-info">
          <div class="conversa-nome"><span>${nome}</span>${tagVendedor}${encerradaTag}</div>
          <div class="conversa-preview">${preview}</div>
        </div>
        ${badge}
      </div>
    `;
  }).join('');
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
  await atualizarConversaAberta();
}

(async function iniciar() {
  const logado = await checarSessao();
  if (!logado) return;
  atualizarTudo();
  setInterval(atualizarTudo, 3000); // atualiza sozinho a cada 3s (depois trocamos por realtime)
})();
