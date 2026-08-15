// Sugestão em tempo real: ao chegar uma mensagem do cliente, a IA rascunha
// uma resposta pro atendente. Ele revisa e envia (não manda sozinho).
import { completar } from './client.js';

const SISTEMA = `Você é assistente de atendimento de uma rede de academias no Brasil
(modelo "clube": um plano dá acesso a todas as modalidades — musculação, natação,
pilates, dança, lutas e bike). Escreva respostas curtas, cordiais e naturais para
WhatsApp, em português do Brasil, do ponto de vista do atendente. Nunca invente
valores ou datas: se faltar informação, faça UMA pergunta objetiva para avançar a
venda ou a renovação. Não use linguagem de propaganda agressiva.`;

// historico: array de { direcao: 'entrada'|'saida', conteudo }
export async function sugerirResposta({ contatoNome, historico = [] }) {
  const linhas = historico
    .slice(-8)
    .map((m) => `${m.direcao === 'entrada' ? 'Cliente' : 'Atendente'}: ${m.conteudo}`)
    .join('\n');

  const usuario =
    `Contato: ${contatoNome || 'lead'}\n` +
    `Conversa até agora:\n${linhas || '(cliente acabou de iniciar)'}\n\n` +
    `Rascunhe a próxima resposta do atendente.`;

  return completar({ sistema: SISTEMA, usuario, maxTokens: 300 });
}
