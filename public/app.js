// Front do painel. Lê o papel salvo no login, pede os dados à API mandando
// o header x-papel, controla a navegação (topbar), desenha os gráficos com
// Chart.js e monta o banner da IA.
const papel = sessionStorage.getItem('papel');
if (!papel) location.href = '/';

const H = { 'content-type': 'application/json', 'x-papel': papel };
let convAberta = null;
const charts = {};

const ROTULO_PAPEL = { gerente: 'Gerente Geral', coordenador: 'Coordenador', vendedor: 'Vendedor' };
const AVATAR = { gerente: 'GG', coordenador: 'CO', vendedor: 'VE' };
document.getElementById('papelLabel').textContent = ROTULO_PAPEL[papel] || papel;
document.getElementById('tagPapel').textContent = ROTULO_PAPEL[papel] || papel;
document.getElementById('avatar').textContent = AVATAR[papel] || '·';

const BRL = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// visibilidade por papel: elementos com classe role-X só aparecem pro papel X
function aplicarPapel() {
  document.querySelectorAll('[class*="role-"]').forEach((el) => {
    const permitidos = [...el.classList].filter((c) => c.startsWith('role-')).map((c) => c.slice(5));
    if (permitidos.length) el.classList.toggle('hide', !permitidos.includes(papel));
  });
}

// navegação (topbar)
document.querySelectorAll('#nav button').forEach((b) => {
  b.onclick = () => irPara(b.dataset.pane, b);
});
function irPara(pane, btn) {
  const alvo = btn || document.querySelector(`#nav button[data-pane="${pane}"]`);
  if (!alvo || alvo.classList.contains('hide')) return;
  document.querySelectorAll('#nav button').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.pane').forEach((x) => x.classList.remove('sel'));
  alvo.classList.add('active');
  document.getElementById('pane-' + pane).classList.add('sel');
}

let RESPOSTAS = [];
let convNome = '';
async function carregar() {
  aplicarPapel();
  carregarRespostas();
  await Promise.all([dashboard(), conversas(), gargalos(), tarefas(), funil(), equipe(), janelas()]);
}

// Enter envia a resposta; Shift+Enter quebra linha
const _ta = document.getElementById('respTexto');
if (_ta) _ta.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); responder(); }
});

// ---------------- Janelas de 24h fechando ----------------
async function janelas() {
  const el = document.getElementById('listaJanelas'); if (!el) return;
  const d = await (await fetch('/api/janelas', { headers: H })).json();
  const j = d.janelas || [];
  el.innerHTML = j.length
    ? j.map((x) => {
        const h = Math.floor(x.minutos / 60), m = x.minutos % 60;
        const txt = h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}min`;
        const cls = x.minutos <= 60 ? 'urg' : 'ok';
        return `<div class="janela-row" onclick="abrir(${x.id}, '${(x.contato || '').replace(/'/g, '')}')">
          <div>
            <div class="jn">${x.contato || 'Contato'}</div>
            <div class="js">${x.unidade || ''}${x.responsavel ? ' · ' + x.responsavel : ''}</div>
          </div>
          <div class="jt"><span class="rest ${cls}">${txt}</span><small>restantes</small></div>
        </div>`;
      }).join('')
    : '<p class="muted">Nenhuma janela perto de fechar. 👍</p>';
}

async function carregarRespostas() {
  try { RESPOSTAS = (await (await fetch('/api/respostas', { headers: H })).json()).respostas || []; }
  catch { RESPOSTAS = []; }
}

// ---------------- Templates (helpers compartilhados) ----------------
let TEMPLATES = [];
async function carregarTemplates() {
  if (TEMPLATES.length) return TEMPLATES;
  try { TEMPLATES = (await (await fetch('/api/templates', { headers: H })).json()).templates || []; }
  catch { TEMPLATES = []; }
  return TEMPLATES;
}
function extrairVars(corpo) {
  return [...new Set([...(corpo || '').matchAll(/\{\{(\d+)\}\}/g)].map((m) => +m[1]))].sort((a, b) => a - b);
}
function preencher(corpo, vals) {
  return (corpo || '').replace(/\{\{(\d+)\}\}/g, (_, n) => vals[n] || `{{${n}}}`);
}
function catLabel(cat) {
  return cat === 'utility' ? 'utilidade (barato)'
    : cat === 'marketing' ? 'marketing (mais caro)'
    : cat === 'authentication' ? 'autenticação' : cat;
}

// ---------------- Disparo (iniciar conversa por template) ----------------
async function abrirDisparo() {
  await carregarTemplates();
  const sel = document.getElementById('dTpl');
  sel.innerHTML = TEMPLATES.map((t, i) => `<option value="${i}">${t.nome} (${t.categoria === 'utility' ? 'utilidade' : t.categoria})</option>`).join('');
  document.getElementById('dNome').value = '';
  document.getElementById('dTel').value = '';
  document.getElementById('dErro').textContent = '';
  montarVars();
  document.getElementById('modalDisparo').classList.add('open');
}
function fecharDisparo() { document.getElementById('modalDisparo').classList.remove('open'); }

function montarVars() {
  const t = TEMPLATES[document.getElementById('dTpl').value];
  const wrap = document.getElementById('dVars');
  if (!t) { wrap.innerHTML = ''; document.getElementById('dPreview').textContent = '—'; return; }
  const nums = extrairVars(t.corpo);
  // {{1}} costuma ser o nome — já preenche
  wrap.innerHTML = nums.map((n) => {
    const val = n === 1 ? (document.getElementById('dNome').value || '') : '';
    return `<label class="campo"><span>Variável {{${n}}}</span><input data-var="${n}" value="${val.replace(/"/g, '')}" oninput="previewDisparo()" placeholder="valor de {{${n}}}"></label>`;
  }).join('');
  previewDisparo();
}
function previewDisparo() {
  const t = TEMPLATES[document.getElementById('dTpl').value];
  if (!t) return;
  const vals = {};
  document.querySelectorAll('#dVars input[data-var]').forEach((i) => { vals[i.dataset.var] = i.value; });
  const txt = preencher(t.corpo, vals);
  document.getElementById('dPreview').innerHTML = txt.replace(/</g, '&lt;') +
    `<div style="margin-top:8px;font-size:11.5px;color:var(--muted)">categoria: ${catLabel(t.categoria)}</div>`;
}

// ---------------- Template dentro de uma conversa aberta ----------------
async function abrirTemplateConversa() {
  if (!convAberta) return;
  await carregarTemplates();
  if (!TEMPLATES.length) { toast('Nenhum template aprovado ainda.'); return; }
  const sel = document.getElementById('tcTpl');
  sel.innerHTML = TEMPLATES.map((t, i) => `<option value="${i}">${t.nome} (${catLabel(t.categoria)})</option>`).join('');
  document.getElementById('tcContato').textContent = convNome || 'o contato';
  document.getElementById('tcErro').textContent = '';
  montarVarsTC();
  document.getElementById('modalTplConv').classList.add('open');
}
function fecharTplConv() { document.getElementById('modalTplConv').classList.remove('open'); }
function montarVarsTC() {
  const t = TEMPLATES[document.getElementById('tcTpl').value];
  const wrap = document.getElementById('tcVars');
  if (!t) { wrap.innerHTML = ''; document.getElementById('tcPreview').textContent = '—'; return; }
  const nums = extrairVars(t.corpo);
  wrap.innerHTML = nums.map((n) => {
    const val = n === 1 ? (convNome || '') : '';
    return `<label class="campo"><span>Variável {{${n}}}</span><input data-var="${n}" value="${val.replace(/"/g, '')}" oninput="previewTC()" placeholder="valor de {{${n}}}"></label>`;
  }).join('');
  previewTC();
}
function previewTC() {
  const t = TEMPLATES[document.getElementById('tcTpl').value];
  if (!t) return;
  const vals = {};
  document.querySelectorAll('#tcVars input[data-var]').forEach((i) => { vals[i.dataset.var] = i.value; });
  document.getElementById('tcPreview').innerHTML = preencher(t.corpo, vals).replace(/</g, '&lt;') +
    `<div style="margin-top:8px;font-size:11.5px;color:var(--muted)">categoria: ${catLabel(t.categoria)}</div>`;
}
async function enviarTemplateConversa() {
  const t = TEMPLATES[document.getElementById('tcTpl').value];
  const err = document.getElementById('tcErro');
  if (!t) { err.textContent = 'Escolha um template.'; return; }
  if (!convAberta) { err.textContent = 'Abra uma conversa primeiro.'; return; }
  const variaveis = [...document.querySelectorAll('#tcVars input[data-var]')]
    .sort((a, b) => a.dataset.var - b.dataset.var).map((i) => i.value);
  const d = await (await fetch(`/api/conversas/${convAberta}/enviar-template`, {
    method: 'POST', headers: H, body: JSON.stringify({ templateId: t.id, variaveis }),
  })).json();
  if (d.erro) { err.textContent = d.erro; return; }
  fecharTplConv();
  toast(d.enviado === false && d.aviso ? 'Registrado (envio pela Meta pendente)' : 'Template enviado ✅');
  abrir(convAberta); conversas(); janelas();
}
async function disparar() {
  const nome = document.getElementById('dNome').value.trim();
  const telefone = document.getElementById('dTel').value.trim();
  const idx = document.getElementById('dTpl').value;
  const t = TEMPLATES[idx];
  const err = document.getElementById('dErro');
  if (!telefone) { err.textContent = 'Informe o número do WhatsApp.'; return; }
  if (!t) { err.textContent = 'Escolha um template.'; return; }
  const variaveis = [...document.querySelectorAll('#dVars input[data-var]')]
    .sort((a, b) => a.dataset.var - b.dataset.var).map((i) => i.value);
  const d = await (await fetch('/api/iniciar-conversa', {
    method: 'POST', headers: H,
    body: JSON.stringify({ nome, telefone, templateId: t.id, variaveis }),
  })).json();
  if (d.erro) { err.textContent = d.erro; return; }
  fecharDisparo();
  toast(d.enviado === false && d.aviso ? 'Conversa criada (envio pela Meta pendente)' : 'Mensagem disparada 🚀');
  carregar();
}

// ---------------- Visão geral ----------------
async function dashboard() {
  const d = await (await fetch('/api/dashboard', { headers: H })).json();
  if (d.demo) document.getElementById('demoFlag').classList.remove('hide');

  const k = d.kpis || {};
  set('kAguardando', k.aguardando); set('kAtendimento', k.emAtendimento);
  set('kParados', k.parados); set('kResolvidos', k.resolvidos); set('kTarefas', k.tarefas);

  // badge de atendimento (aguardando)
  badge('navBadgeAtend', (k.aguardando || 0));

  // tempos (TMPR/TMA) na Visão
  set('tmprVisao', d.tempos?.tmpr || '—');
  set('tmaVisao', d.tempos?.tma || '—');

  desenhar('cVolume', {
    type: 'bar',
    data: {
      labels: (d.porDia || []).map((x) => x.dia),
      datasets: [
        { label: 'Recebidas', data: (d.porDia || []).map((x) => +x.entradas), backgroundColor: '#1f37a3', borderRadius: 4 },
        { label: 'Enviadas', data: (d.porDia || []).map((x) => +x.saidas), backgroundColor: '#ffd21a', borderRadius: 4 },
      ],
    },
    options: baseOpts({ legend: true }),
  });

  const rot = { aguardando: 'Aguardando', em_atendimento: 'Em atendimento', parado: 'Parado', resolvido: 'Resolvido' };
  const cor = { aguardando: '#ffd21a', em_atendimento: '#1f37a3', parado: '#d63b3b', resolvido: '#12a150' };
  const sd = d.statusDist || [];
  desenhar('cStatus', {
    type: 'doughnut',
    data: {
      labels: sd.map((x) => rot[x.status] || x.status),
      datasets: [{ data: sd.map((x) => +x.n), backgroundColor: sd.map((x) => cor[x.status] || '#999'), borderWidth: 0 }],
    },
    options: { responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 12 } } } } },
  });

  const e = d.economia || {};
  document.getElementById('ecoEconomia').textContent = BRL(e.economia);
  document.getElementById('ecoReal').textContent = BRL(e.custoReal);
  document.getElementById('ecoSem').textContent = BRL(e.custoSeTudoMarketing);
  const pc = e.porCategoria || {};
  desenhar('cEco', {
    type: 'bar',
    data: {
      labels: ['Mensagens enviadas'],
      datasets: [
        { label: 'Texto livre', data: [pc.texto_livre || 0], backgroundColor: '#12a150' },
        { label: 'Utilidade', data: [(pc.utility || 0) + (pc.template || 0)], backgroundColor: '#1f37a3' },
        { label: 'Marketing', data: [pc.marketing || 0], backgroundColor: '#d98a1f' },
      ],
    },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, grid: { display: false } } },
      plugins: { legend: { display: false } } },
  });

  const m = d.metas || [];
  desenhar('cMetas', {
    type: 'bar',
    data: {
      labels: m.map((x) => x.unidade || 'Unidade'),
      datasets: [
        { label: 'Realizado', data: m.map((x) => +x.realizado), backgroundColor: '#ffd21a', borderRadius: 4 },
        { label: 'Meta', data: m.map((x) => +x.alvo), backgroundColor: '#e6e8ef', borderRadius: 4 },
      ],
    },
    options: baseOpts({ legend: true }),
  });

  document.getElementById('listaMetas').innerHTML = m.length
    ? m.map((x) => {
        const pct = x.alvo ? Math.min(100, Math.round((x.realizado / x.alvo) * 100)) : 0;
        const cor = pct >= 100 ? 'var(--good)' : pct >= 70 ? 'var(--brand)' : 'var(--warn)';
        return `<div class="meta-row"><span><b>${x.unidade || 'Unidade'}</b></span>
            <span>${x.realizado}/${x.alvo} · <b style="color:${cor}">${pct}%</b></span></div>
          <div class="meta-bar"><i style="width:${pct}%"></i></div>`;
      }).join('')
    : '<p class="muted">Sem metas cadastradas.</p>';
}

function baseOpts({ legend }) {
  return {
    responsive: true, maintainAspectRatio: false,
    scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: '#f0f1f6' }, ticks: { precision: 0 } } },
    plugins: { legend: legend ? { position: 'bottom', labels: { boxWidth: 12, font: { size: 12 } } } : { display: false } },
  };
}
function desenhar(id, cfg) {
  const el = document.getElementById(id); if (!el) return;
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(el.getContext('2d'), cfg);
}

// ---------------- Atendimento ----------------
async function conversas() {
  const d = await (await fetch('/api/conversas', { headers: H })).json();
  const el = document.getElementById('listaConversas');
  const lista = d.conversas || [];
  if (!lista.length) { el.innerHTML = '<p class="muted">Nenhuma conversa aberta.</p>'; return; }
  el.innerHTML = lista.map((c) => `
    <div class="conv" onclick="abrir(${c.id}, '${(c.contato || '').replace(/'/g, '')}')">
      <div>
        <div class="nome">${c.contato || 'Contato'} <span class="muted" style="font-weight:400">· ${c.unidade || ''}</span></div>
        <div class="prev">${c.ultima || ''}</div>
        ${c.responsavel ? `<div class="muted" style="font-size:11px;margin-top:3px">👤 ${c.responsavel}</div>` : '<div class="muted" style="font-size:11px;margin-top:3px">na fila</div>'}
      </div>
      <div style="text-align:right">
        <span class="pill ${c.status}">${rotulo(c.status)}</span>
        <div class="muted" style="font-size:11px;margin-top:4px">${c.janela_aberta ? 'janela 24h ✓' : 'janela fechada'}</div>
      </div>
    </div>`).join('');
}

// ---------------- Funil ----------------
async function funil() {
  const el = document.getElementById('funilEtapas'); if (!el) return;
  const d = await (await fetch('/api/funil', { headers: H })).json();
  const t = d.totais || {};
  set('funilConv', `Conversão ${d.conversao || 0}%`);
  const maxV = Math.max(1, t.total || 1);
  const etapa = (lab, val, cls) => {
    const w = Math.max(6, Math.round(((val || 0) / maxV) * 100));
    return `<div class="funil-etapa"><span class="fl">${lab}</span>
      <span class="fb ${cls}" style="width:${w}%">${val || 0}</span></div>`;
  };
  el.innerHTML =
    etapa('Total de leads', t.total, 'lead') +
    etapa('Em atendimento', t.em_atendimento, 'atend') +
    etapa('Matriculou', t.matriculou, 'matriculou') +
    etapa('Já é aluno', t.ja_aluno, 'atend') +
    etapa('Vai pensar', t.vai_pensar, 'pensar') +
    etapa('Sem interesse', t.sem_interesse, 'perdido') +
    etapa('Sem resposta', t.sem_resposta, 'frio');

  const vend = d.porVendedor || [];
  document.getElementById('funilVendedores').innerHTML = vend.length
    ? vend.map((v) => `<div class="vend-row">
        <span class="vn">${v.nome}</span>
        <span class="vbar"><i style="width:${v.conversao || 0}%"></i></span>
        <span class="vp"><b>${v.conversao || 0}%</b> · ${v.matriculas}/${v.atendimentos}</span>
      </div>`).join('')
    : '<p class="muted">Sem atendimentos com desfecho ainda.</p>';
}

// ---------------- Equipe ----------------
async function equipe() {
  const el = document.getElementById('listaEquipe'); if (!el) return;
  const d = await (await fetch('/api/equipe', { headers: H })).json();
  const eq = d.equipe || [];
  set('eqDisp', eq.filter((x) => x.papel === 'vendedor' && x.status === 'disponivel').length);
  set('eqTmpr', d.tempos?.tmpr || '—');
  set('eqTma', d.tempos?.tma || '—');
  el.innerHTML = eq.map((u) => {
    const ini = (u.nome || '?').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
    const proximo = { disponivel: 'pausa', pausa: 'indisponivel', indisponivel: 'disponivel' };
    const rot = { disponivel: 'Disponível', pausa: 'Em pausa', indisponivel: 'Indisponível' };
    return `<div class="eq-row">
      <span class="eq-av">${ini}</span>
      <div>
        <div class="eq-nome">${u.nome} <span class="muted" style="font-weight:400;font-size:12px">· ${u.papel === 'coordenador' ? 'Coordenador' : 'Vendedor'}${u.unidade ? ' · ' + u.unidade : ''}</span></div>
        <div class="eq-sub">${u.abertas} conversa(s) aberta(s)</div>
      </div>
      <div class="eq-carga">
        <span class="eq-status ${u.status}" onclick="mudarStatus(${u.id}, '${proximo[u.status]}')"><span class="d"></span>${rot[u.status]}</span>
      </div>
    </div>`;
  }).join('');
}

async function mudarStatus(usuarioId, status) {
  await fetch('/api/status', { method: 'POST', headers: H, body: JSON.stringify({ usuarioId, status }) });
  equipe();
}

async function gargalos() {
  const d = await (await fetch('/api/gargalos', { headers: H })).json();
  const g = d.gargalos || [];
  badge('navBadgeGarg', g.length);
  // banner IA na visão geral
  const titulo = document.getElementById('iaTitulo');
  const resumo = document.getElementById('iaResumo');
  if (g.length) {
    titulo.innerHTML = `A IA achou <b>${g.length} ${g.length === 1 ? 'gargalo' : 'gargalos'}</b> no atendimento hoje`;
    resumo.textContent = g.map((x) => x.titulo).join(' · ');
  } else {
    titulo.innerHTML = 'Nenhum gargalo no atendimento agora 👏';
    resumo.textContent = 'A IA não encontrou conversas travadas neste momento.';
  }
  const el = document.getElementById('listaGargalos');
  if (el) el.innerHTML = g.length
    ? g.map((x) => `<div class="gargalo"><span class="ic ${x.gravidade}">${iconeGrav(x.gravidade)}</span>
        <span>${x.titulo}<div class="gv">gravidade: ${x.gravidade}</div></span></div>`).join('')
    : '<p class="muted">Nenhum gargalo agora. 👏</p>';
}

async function tarefas() {
  const d = await (await fetch('/api/tarefas', { headers: H })).json();
  const t = d.tarefas || [];
  document.getElementById('listaTarefas').innerHTML = t.length
    ? t.slice(0, 12).map((x) => `<div class="tarefa"><span>▫️</span><span>${x.titulo}</span></div>`).join('')
    : '<p class="muted">Sem tarefas pendentes.</p>';
}

// ---------------- Drawer ----------------
async function abrir(id, nome) {
  convAberta = id;
  if (nome) convNome = nome;
  document.getElementById('drawerNome').textContent = convNome || 'Conversa';
  document.getElementById('drawer').classList.add('open');
  const body = document.getElementById('drawerBody');
  body.innerHTML = '<p class="muted">Carregando…</p>';
  const d = await (await fetch('/api/conversas/' + id, { headers: H })).json();
  const msgs = (d.mensagens || []).map((m) =>
    `<div class="msg ${m.direcao}">${(m.conteudo || '').replace(/</g, '&lt;')}</div>`).join('');
  // sugestão da IA compacta (uma linha; clica no texto pra expandir)
  const sug = d.sugestao
    ? `<div class="sug" id="sugBox">
        <span class="sug-ic">💡</span>
        <span class="sug-tx" onclick="document.getElementById('sugBox').classList.toggle('aberta')" title="Clique para ver / recolher">${d.sugestao.replace(/</g, '&lt;')}</span>
        <button class="sug-use" onclick="usarSugestao()">Usar</button>
      </div>`
    : '';
  body.innerHTML = msgs + sug;
  body.scrollTop = body.scrollHeight;
  window._sug = d.sugestao || '';
  document.getElementById('envioInfo').textContent = d.envio ? '💡 ' + d.envio.motivo : '';
  // janela fechada: só template entrega — avisa e destaca o botão de template
  const fechada = d.envio && d.envio.meio === 'template';
  const foot = document.querySelector('#drawer .foot');
  if (foot) foot.classList.toggle('janela-fechada', !!fechada);
  document.getElementById('janelaAviso').classList.toggle('hide', !fechada);
  // marca o desfecho já escolhido, se houver

  // respostas rápidas (chips que inserem o texto)
  const qr = document.getElementById('quickRow');
  qr.innerHTML = RESPOSTAS.map((r, i) =>
    `<button class="quick" title="${(r.texto || '').replace(/"/g, '')}" onclick="usarResposta(${i})">${r.atalho}</button>`).join('');

  // marca o desfecho já escolhido, se houver
  document.querySelectorAll('#desfechoRow .df').forEach((b) => b.classList.remove('on'));
  if (d.desfecho) {
    const b = document.querySelector(`#desfechoRow .df.${d.desfecho}`);
    if (b) b.classList.add('on');
  }
}

function usarResposta(i) {
  const r = RESPOSTAS[i]; if (!r) return;
  const ta = document.getElementById('respTexto');
  ta.value = (ta.value ? ta.value + '\n' : '') + r.texto;
  ta.focus();
}

async function marcarDesfecho(desfecho) {
  if (!convAberta) return;
  const d = await (await fetch(`/api/conversas/${convAberta}/desfecho`,
    { method: 'POST', headers: H, body: JSON.stringify({ desfecho }) })).json();
  if (d.erro) { toast(d.erro); return; }
  const rot = { matriculou: 'Matriculou 🎉', ja_aluno: 'Já é aluno', vai_pensar: 'Vai pensar', sem_interesse: 'Sem interesse', sem_resposta: 'Sem resposta' };
  toast('Desfecho: ' + (rot[desfecho] || desfecho));
  fecharDrawer(); carregar();
}
function usarSugestao() {
  const s = (window._sug || '').replace(/^\[IA[^\]]*\]\s*/, '').replace(/^Sugestão:\s*/, '').replace(/^"|"$/g, '');
  document.getElementById('respTexto').value = s;
}
async function responder() {
  const ta = document.getElementById('respTexto');
  const texto = ta.value.trim();
  if (!texto || !convAberta) return;
  const d = await (await fetch(`/api/conversas/${convAberta}/responder`,
    { method: 'POST', headers: H, body: JSON.stringify({ texto }) })).json();
  if (d.erro) { toast(d.erro); return; }
  ta.value = '';
  toast('Resposta enviada');
  // mantém o drawer aberto: recarrega só a conversa e atualiza as listas em segundo plano
  abrir(convAberta);
  conversas(); janelas();
}
async function rodarCuradoria() {
  toast('Rodando curadoria…');
  const d = await (await fetch('/api/curadoria', { method: 'POST', headers: H })).json();
  toast('Curadoria concluída' + (d.tarefasCriadas != null ? ` · ${d.tarefasCriadas} tarefa(s)` : ''));
  carregar();
}

function fecharDrawer() { document.getElementById('drawer').classList.remove('open'); }
function set(id, v) { const el = document.getElementById(id); if (el) el.textContent = v ?? 0; }
function badge(id, n) { const el = document.getElementById(id); if (!el) return;
  if (n > 0) { el.textContent = n; el.classList.remove('hide'); } else el.classList.add('hide'); }
function rotulo(s) { return ({ aguardando: 'Aguardando', em_atendimento: 'Em atendimento', parado: 'Parado', resolvido: 'Resolvido' })[s] || s; }
function iconeGrav(g) {
  if (g === 'alta') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>';
}
let _t;
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(_t); _t = setTimeout(() => t.classList.remove('show'), 1600); }
function sair(e) { e.preventDefault(); sessionStorage.clear(); location.href = '/'; }

carregar();
