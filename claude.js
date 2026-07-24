// claude.js
// Camada de IA de verdade, usando a API da Anthropic. Três responsabilidades:
//   1. Gerar a boas-vindas automática + resumo de interesse (na hora que o
//      lead chega, substitui o stub de palavra-chave do ai.js)
//   2. Analisar uma conversa inteira e SUGERIR se fechou, valor e resumo
//      pro relatório — o vendedor sempre confirma antes de contar de verdade
//   3. Sugerir uma tarefa de follow-up pra agenda, olhando a conversa
//
// Configuração via variável de ambiente ANTHROPIC_API_KEY. Sem ela, todas
// as funções retornam null e quem chamou usa o stub antigo (ai.js) como
// fallback — o sistema nunca trava por falta de IA configurada.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-5';

const configurado = Boolean(ANTHROPIC_API_KEY);

if (!configurado) {
  console.log('>> IA real não configurada (ANTHROPIC_API_KEY ausente) — usando respostas padrão simples (ai.js).');
}

async function chamarClaude(system, mensagemUsuario, maxTokens = 400) {
  if (!configurado) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: mensagemUsuario }],
      }),
    });
    if (!res.ok) {
      const erro = await res.text().catch(() => '');
      console.error(`>> Erro na API da Anthropic (status ${res.status}): ${erro}`);
      return null;
    }
    const data = await res.json();
    const bloco = (data.content || []).find((b) => b.type === 'text');
    return bloco ? bloco.text : null;
  } catch (err) {
    console.error('>> Erro de rede chamando a Anthropic:', err.message);
    return null;
  }
}

function extrairJSON(texto) {
  if (!texto) return null;
  try {
    const limpo = texto.replace(/```json|```/g, '').trim();
    return JSON.parse(limpo);
  } catch {
    return null;
  }
}

function formatarTranscricao(mensagens) {
  return mensagens
    .map((m) => `${m.remetente === 'cliente' ? 'Cliente' : m.remetente === 'vendedor' ? 'Vendedor' : 'IA'}: ${m.texto}`)
    .join('\n');
}

// Gera boas-vindas + resumo de interesse quando um lead novo chega.
// Retorna { boas_vindas, interesse } ou null se IA não configurada/falhou.
async function processarNovaMensagem(texto, nomeCliente, statusHorario) {
  const contextoHorario = statusHorario && !statusHorario.aberto
    ? ` A loja está FECHADA agora (fora do horário de funcionamento) — a próxima abertura é ${statusHorario.proxima_abertura_texto}. Avise disso de forma natural na mensagem, deixando claro que o pedido já foi anotado e que um vendedor vai atender assim que a loja abrir.`
    : '';

  const system = `Você escreve mensagens automáticas de boas-vindas para o WhatsApp do Depósito Santo Antônio, uma loja de material de construção em São Paulo. Seu tom é caloroso, humano e prestativo — nunca robótico, nunca genérico demais.${contextoHorario} Responda SOMENTE em JSON válido, sem markdown, no formato exato:
{"boas_vindas": "mensagem curta em português, no máximo 3 frases, mostrando que leu o que o cliente escreveu e avisando quando será atendido", "interesse": "resumo bem curto (3-6 palavras) do que o cliente quer, ex: 'cimento e areia' ou 'orçamento de tijolo'"}`;

  const userMsg = `Mensagem do cliente${nomeCliente ? ` (${nomeCliente})` : ''}: "${texto}"`;
  const resposta = await chamarClaude(system, userMsg, 300);
  return extrairJSON(resposta);
}

// Lê a conversa inteira e sugere resultado/valor/resumo pro relatório.
// NUNCA grava nada sozinha — é só sugestão pro vendedor confirmar.
async function analisarConversa(mensagens) {
  const system = `Você analisa conversas de vendas de uma loja de material de construção pra ajudar a preencher o relatório do dia. Leia a conversa e responda SOMENTE em JSON válido, sem markdown, no formato exato:
{"resultado_sugerido": "convertido" | "perdido" | "indefinido", "valor_sugerido": numero_ou_null, "motivo_perda_sugerido": "texto_curto_ou_null", "resumo": "1 frase curta resumindo o que aconteceu na conversa", "confianca": "alta" | "media" | "baixa"}
Use "indefinido" se não estiver claro pela conversa se a venda fechou ou não. Só preencha valor_sugerido se um valor em reais foi claramente mencionado como o valor fechado. motivo_perda_sugerido só se resultado_sugerido for "perdido".`;

  const resposta = await chamarClaude(system, formatarTranscricao(mensagens), 400);
  return extrairJSON(resposta);
}

// Sugere uma tarefa de follow-up pra agenda do dia seguinte, olhando a conversa.
async function sugerirTarefa(mensagens) {
  const system = `Você ajuda um vendedor de loja de material de construção a organizar a agenda do dia seguinte. Leia a conversa e diga se falta alguma ação de follow-up óbvia e específica. Responda SOMENTE em JSON válido, sem markdown:
{"sugerir": true_ou_false, "titulo": "o que fazer, curto e direto, ou null", "tipo": "orcamento_ou_catalogo_ou_frete_ou_pos_venda_ou_ligacao_ou_objecao_ou_outro_ou_null"}
Só sugira (sugerir:true) se houver uma ação clara pendente (ex: prometeu mandar orçamento e ainda não mandou, cliente pediu pra ligar depois, ficou de calcular frete). Se a conversa já foi resolvida ou não há nada pendente óbvio, responda sugerir:false.`;

  const resposta = await chamarClaude(system, formatarTranscricao(mensagens), 250);
  return extrairJSON(resposta);
}

// Análise de FIM DE DIA (rodada 1x/dia, não a cada mensagem) — olha uma
// conversa ainda em aberto e procura duas coisas pra alimentar a agenda
// do dia seguinte: gargalo (pendência sem resolução) e oportunidade de
// venda complementar (produto relacionado que ainda não foi oferecido).
async function analisarDiaria(mensagens) {
  const system = `Você revisa, no fim do dia, uma conversa de vendas ainda em aberto numa loja de material de construção, procurando duas coisas específicas:
1. GARGALO: o vendedor deixou o cliente sem resposta em algum ponto, ou ficou uma pendência clara sem resolução (ex: prometeu orçamento e não mandou, cliente perguntou algo e não foi respondido).
2. OPORTUNIDADE: dado o que o cliente está comprando ou perguntando, existe um produto complementar óbvio que vale oferecer (ex: quem compra cimento pode precisar de areia/brita; quem faz laje pode precisar de manta impermeabilizante; etc) e isso ainda não foi oferecido na conversa.
Responda SOMENTE em JSON válido, sem markdown, no formato exato:
{"gargalo": {"existe": true_ou_false, "titulo": "ação curta pro vendedor fazer amanhã, ou null", "tipo": "ligacao_ou_orcamento_ou_catalogo_ou_frete_ou_objecao_ou_outro_ou_null"}, "oportunidade": {"existe": true_ou_false, "titulo": "sugestão curta do que oferecer, ou null"}}
Seja conservador: só marque existe:true quando for bem claro pela conversa, pra não gerar tarefa desnecessária.`;

  const resposta = await chamarClaude(system, formatarTranscricao(mensagens), 350);
  return extrairJSON(resposta);
}

module.exports = { processarNovaMensagem, analisarConversa, sugerirTarefa, analisarDiaria, configurado };
