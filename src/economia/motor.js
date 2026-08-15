// Motor de economia — o diferencial de venda.
// Decide COMO mandar a mensagem pra pagar o mínimo (ou nada) pra Meta:
//   - se a janela de 24h está aberta  -> manda TEXTO LIVRE (grátis)
//   - se a janela fechou              -> precisa de TEMPLATE (cobrado)
// Também escolhe a categoria certa do template (utility é bem mais barato
// que marketing) e evita re-disparo desnecessário.

// A janela de 24h começa/renova a cada mensagem que o CLIENTE manda.
const JANELA_MS = 24 * 60 * 60 * 1000;

// Recebeu mensagem do cliente agora -> nova hora de expiração.
export function novaExpiracaoJanela(agora = new Date()) {
  return new Date(agora.getTime() + JANELA_MS);
}

// A janela está aberta?
export function janelaAberta(janelaExpiraEm, agora = new Date()) {
  if (!janelaExpiraEm) return false;
  return new Date(janelaExpiraEm).getTime() > agora.getTime();
}

// Dada uma conversa, decide o meio de envio.
// Retorna { meio: 'texto_livre' | 'template', motivo, custoRelativo }
export function decidirEnvio(conversa, agora = new Date()) {
  if (janelaAberta(conversa?.janela_expira_em, agora)) {
    return {
      meio: 'texto_livre',
      motivo: 'Janela de 24h aberta — dá pra responder de graça em texto livre.',
      custoRelativo: 0,
    };
  }
  return {
    meio: 'template',
    motivo: 'Janela fechada — precisa de template aprovado. Prefira categoria "utility".',
    custoRelativo: 1,
  };
}

// Escolhe a categoria mais barata que ainda é aceitável pro conteúdo.
// Regra prática: se a mensagem NÃO tem persuasão/oferta, tende a "utility".
// Palavras de promoção puxam pra "marketing" (mais caro).
const GATILHOS_MARKETING = [
  'promo', 'promoção', 'desconto', 'oferta', 'aproveite', 'imperdível',
  'condição especial', 'últimas vagas', 'black', 'liquidação', 'ganhe',
];

export function sugerirCategoria(texto = '') {
  const t = texto.toLowerCase();
  const temMkt = GATILHOS_MARKETING.some((g) => t.includes(g));
  if (temMkt) {
    return {
      categoria: 'marketing',
      aviso: 'Tem cara de oferta — a Meta provavelmente classifica como marketing (mais caro). ' +
             'Se der, tire a persuasão pra virar utility.',
    };
  }
  return {
    categoria: 'utility',
    aviso: 'Sem persuasão/oferta — deve passar como utility (bem mais barato). ' +
           'Ex.: aviso de vencimento, confirmação, atualização de conta.',
  };
}

// Estimativa de custo por categoria (R$) — valores de referência Meta Brasil.
// Ajuste conforme sua tabela real. Serve pro painel mostrar economia.
export const CUSTOS_REF = {
  utility: 0.035,
  marketing: 0.3217,
  authentication: 0.035,
  texto_livre: 0,
};
