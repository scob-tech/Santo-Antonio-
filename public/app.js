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
    <button class="btn-secundario" id="btn-notificacoes" onclick="alternarNotificacoes()">🔔 Notificações</button>
    ${usuarioAtual.role === 'admin' ? `<button class="btn-secundario" onclick="abrirModalSenha(${usuarioAtual.id}, 'você')">🔑 Minha senha</button>` : ''}
    <button class="btn-secundario" onclick="sair()">Sair</button>
  `;
  atualizarBotaoNotificacoes();

  const btnCadastro = document.getElementById('btn-toggle-cadastro');
  if (usuarioAtual.role === 'admin') {
    document.getElementById('painel-vendedores').style.display = 'block';
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

  renderizarResultadoAnalise(resultado);
  carregarLembretes();
}

function renderizarResultadoAnalise(r) {
  const modalId = 'modal-analise-resultado';
  let html = `
    <div class="relatorio-grid">
      <div class="relatorio-metric"><div class="valor">${r.conversas_revisadas}</div><div class="label">Conversas revisadas</div></div>
      <div class="relatorio-metric"><div class="valor">${r.encerrados_analisados}</div><div class="label">Encerradas classificadas</div></div>
      <div class="relatorio-metric"><div class="valor">${r.tarefas_criadas_total}</div><div class="label">Tarefas criadas</div></div>
    </div>
  `;

  if (r.encerrados_classificados && r.encerrados_classificados.length > 0) {
    html += `<div class="panel-title" style="font-size:11px; margin-top:14px;">Conversas classificadas pela IA</div>`;
    html += r.encerrados_classificados.map(e => {
      const nome = escapeHtml(e.nome_cliente) || escapeHtml(e.telefone);
      const badge = e.resultado === 'convertido'
        ? `<span class="badge badge-atendimento" style="background:var(--green-bg); color:var(--green);">Convertido — R$ ${(e.valor_venda || 0).toLocaleString('pt-BR')}</span>`
        : e.resultado === 'perdido'
          ? `<span class="badge badge-encerrado">Perdido — ${escapeHtml(e.motivo_perda)}</span>`
          : `<span class="badge badge-restrito">Indefinido</span>`;
      return `
        <div class="relatorio-vendedor-row tarefa-clicavel" onclick="irParaConversa(${e.lead_id}, '${modalId}')" style="cursor:pointer; flex-direction:column; align-items:flex-start; gap:4px;">
          <div style="display:flex; justify-content:space-between; width:100%;"><strong style="font-size:13px;">${nome}</strong>${badge}</div>
          ${e.resumo ? `<div style="font-size:12px; color:var(--muted);">${escapeHtml(e.resumo)}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  const tarefas = r.tarefas_criadas || [];
  if (tarefas.length > 0) {
    html += `<div class="panel-title" style="font-size:11px; margin-top:14px;">Tarefas criadas — clique pra resolver</div>`;
    html += tarefas.map(t => tarefaClicavelHtml(t, modalId)).join('');
  }

  if (r.encerrados_classificados.length === 0 && r.tarefas_criadas.length === 0) {
    html += `<div class="empty-state" style="padding:14px; font-size:12px;">Nada novo pra analisar hoje — tudo em dia.</div>`;
  }

  document.getElementById('analise-resultado-conteudo').innerHTML = html;
  abrirModal(modalId);
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
  if (filtroData && filtroData.value) {
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
              <strong>${escapeHtml(l.nome_cliente) || 'Cliente'}</strong>
              <span class="badge badge-restrito">Em atendimento</span>
            </div>
            <div class="texto">${l.interesse ? `Interesse: ${escapeHtml(l.interesse)}` : 'Sem produto identificado'}</div>
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

    // Tempo de espera na FILA — destaca se passou de 5 min sem ser puxado (gargalo de fila).
    // Formatado em min/h/dias porque agora a fila mostra lead de qualquer
    // dia, não só hoje — "esperando há 2880 min" seria ilegível.
    const minutosEsperando = Math.floor((Date.now() - new Date(l.criado_em + 'Z')) / 60000);
    let tempoHtml = '';
    if (l.status === 'novo') {
      const alerta = minutosEsperando >= 5;
      let tempoTexto;
      if (minutosEsperando < 60) {
        tempoTexto = `${minutosEsperando} min`;
      } else if (minutosEsperando < 60 * 24) {
        tempoTexto = `${Math.floor(minutosEsperando / 60)} h`;
      } else {
        const dias = Math.floor(minutosEsperando / (60 * 24));
        tempoTexto = `${dias} dia${dias === 1 ? '' : 's'}`;
      }
      tempoHtml = `<div class="${alerta ? 'alerta' : ''}" style="${alerta ? '' : 'font-size:12px; color:var(--muted); margin-top:6px;'}">
        ${alerta ? '⚠️ ' : ''}Esperando há ${tempoTexto}${alerta ? ' — gargalo de fila' : ''}
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

    const origemHtml = `<span class="origem-tag">Origem: ${escapeHtml(l.origem)}</span>`;
    const temGargalo = (l.status === 'novo' && minutosEsperando >= 5) || gargaloAtendimentoHtml !== '';

    return `
      <div class="ticket-card ${temGargalo ? 'gargalo' : ''} lead-clicavel" onclick="abrirConversa(${l.id})">
        <div class="ticket-number">${String(numeroSenha.get(l.id)).padStart(3, '0')}</div>
        <div class="ticket-body">
          <div class="lead-header">
            <strong>${escapeHtml(l.nome_cliente) || escapeHtml(l.telefone)}</strong>
            ${badge}
          </div>
          <div class="texto">${escapeHtml(l.primeira_mensagem)}</div>
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
  document.getElementById('conversa-titulo').textContent = lead.nome_cliente || lead.telefone;
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

  const podeAgir = lead.dono || ehGestor(usuarioAtual);
  reabrirBox.style.display = (lead.status === 'encerrado' && podeAgir) ? 'block' : 'none';

  if (podeAgir) {
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

  // Prioridade visual: 1) não lida primeiro (o que precisa de atenção agora),
  // 2) em atendimento sem pendência, por atividade mais recente,
  // 3) encerrada sempre no fim da lista, não importa quando foi a última msg.
  const ordenadas = [...leads].sort((a, b) => {
    const grupo = (l) => (l.nao_lidas || 0) > 0 ? 0 : (l.status === 'encerrado' ? 2 : 1);
    const grupoA = grupo(a);
    const grupoB = grupo(b);
    if (grupoA !== grupoB) return grupoA - grupoB;
    const ta = a.ultima_mensagem ? new Date(a.ultima_mensagem.criado_em) : new Date(a.criado_em);
    const tb = b.ultima_mensagem ? new Date(b.ultima_mensagem.criado_em) : new Date(b.criado_em);
    return tb - ta;
  });

  el.innerHTML = ordenadas.map(l => {
    const nome = l.nome_cliente || l.telefone;
    const preview = l.ultima_mensagem ? l.ultima_mensagem.texto : l.primeira_mensagem;
    const tagVendedor = ehGestor(usuarioAtual) && l.vendedor_nome ? `<span class="conversa-vendedor-tag">${escapeHtml(l.vendedor_nome)}</span>` : '';
    const naoLidas = l.nao_lidas || 0;
    const badge = naoLidas > 0 ? `<span class="conversa-badge">${naoLidas > 9 ? '9+' : naoLidas}</span>` : '';
    const encerradaTag = l.status === 'encerrado' ? `<span class="conversa-vendedor-tag" style="color:var(--muted);">Encerrado</span>` : '';
    return `
      <div class="conversa-item ${naoLidas > 0 ? 'nao-lida' : ''} ${l.status === 'encerrado' ? 'encerrada' : ''}" onclick="abrirConversa(${l.id})">
        <div class="conversa-avatar">${escapeHtml(iniciais(nome))}</div>
        <div class="conversa-info">
          <div class="conversa-nome"><span>${escapeHtml(nome)}</span>${tagVendedor}${encerradaTag}</div>
          <div class="conversa-preview">${escapeHtml(preview)}</div>
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

// ---------------- Helper compartilhado: item de tarefa clicável ----------------
// Usado tanto no relatório quanto na tela de resultado da análise diária —
// clicar em qualquer tarefa (gargalo, oportunidade, pós-venda, esquecido)
// fecha o modal atual e vai direto pra conversa do cliente.
const ICONE_CATEGORIA = {
  gargalo: '⚠️', oportunidade: '💡', pos_venda: '📦', esquecido: '🔍',
};

function irParaConversa(leadId, modalOrigemId) {
  if (modalOrigemId) fecharModal(modalOrigemId);
  abrirConversa(leadId);
}

function tarefaClicavelHtml(t, modalOrigemId, categoria) {
  const nome = escapeHtml(t.nome_cliente) || escapeHtml(t.telefone);
  const tituloSemEmoji = escapeHtml((t.titulo || '').replace(/^🤖\s*/, ''));
  const icone = ICONE_CATEGORIA[categoria || t.categoria] || '📋';
  const feito = t.feito ? 'opacity:0.55; text-decoration:line-through;' : '';
  return `
    <div class="relatorio-vendedor-row tarefa-clicavel" onclick="irParaConversa(${t.lead_id}, '${modalOrigemId}')" style="cursor:pointer; align-items:flex-start; ${feito}">
      <span>${icone} ${tituloSemEmoji}<br><span style="font-size:11px; color:var(--muted);">${nome}</span></span>
      <span style="font-size:11px; color:var(--navy); white-space:nowrap;">Abrir →</span>
    </div>
  `;
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

  if (r.tarefas_ia && r.tarefas_ia.length > 0) {
    const pendentes = r.tarefas_ia.filter(t => !t.feito).length;
    html += `<div class="panel-title" style="font-size:11px; margin-top:16px;">🤖 Sinalizado pela análise da IA ${pendentes > 0 ? `(${pendentes} pendente${pendentes > 1 ? 's' : ''})` : '(tudo resolvido)'}</div>`;
    html += r.tarefas_ia.map(t => tarefaClicavelHtml(t, 'modal-relatorio')).join('');
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
    <div class="side-card lembrete-clicavel" onclick="abrirConversa(${l.lead_id})" style="cursor:pointer;">
      <div class="tipo-badge tipo-${l.tipo || 'outro'}">${LABELS_TIPO[l.tipo] || 'Outro'}</div>
      <div class="lembrete-titulo">${escapeHtml(l.titulo)}</div>
      <div style="font-size:11px; color:var(--muted); margin-top:2px;">${escapeHtml(l.nome_cliente) || escapeHtml(l.telefone)}</div>
      <div class="lembrete-quando">${new Date(l.quando).toLocaleString('pt-BR')}</div>
      <button onclick="event.stopPropagation(); concluirLembrete(${l.id})">Concluído</button>
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
  const btn = document.getElementById('btn-notificacoes');
  if (!btn) return;

  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    btn.textContent = '🔕 Notificação indisponível';
    btn.disabled = true;
    btn.title = 'Esse navegador não suporta notificação. No iPhone, use "Adicionar à Tela de Início" pelo Safari primeiro.';
    return;
  }

  if (Notification.permission === 'denied') {
    btn.textContent = '🚫 Notificação bloqueada';
    btn.title = 'Você bloqueou a notificação pra esse site — pra reativar, muda isso nas configurações do navegador.';
    return;
  }

  const inscricao = await inscricaoAtual();
  if (inscricao) {
    btn.textContent = '🔔 Notificações ativadas';
    btn.title = 'Clique pra desativar';
  } else {
    btn.textContent = '🔕 Ativar notificações';
    btn.title = 'Receba aviso de lead novo ou mensagem mesmo com o app fechado';
  }
}

async function alternarNotificacoes() {
  const btn = document.getElementById('btn-notificacoes');
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
  if (btn) btn.textContent = '⏳ Ativando...';
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

(async function iniciar() {
  const logado = await checarSessao();
  if (!logado) return;
  registrarServiceWorker();
  atualizarTudo();
  abrirLeadDaUrlSeTiver();
  setInterval(atualizarTudo, 3000); // atualiza sozinho a cada 3s (depois trocamos por realtime)
})();
