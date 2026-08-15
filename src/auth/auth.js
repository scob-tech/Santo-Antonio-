// Autenticação simples da Fase 1: uma senha única (PAINEL_SENHA) libera o
// acesso, e o usuário escolhe o papel (gerente/coordenador/vendedor) que
// controla o que ele vê. É proposital ser simples pra demonstração —
// na Fase 2 vira login por usuário com senha individual.
import { config } from '../config.js';

const PAPEIS = ['gerente', 'coordenador', 'vendedor'];

// "token" bobo só pra amarrar papel à sessão do navegador. Não é segurança
// séria — é um protótipo de venda. Não exponha dados sensíveis aqui.
export function login({ senha, papel }) {
  if (senha !== config.painelSenha) {
    return { ok: false, erro: 'Senha incorreta.' };
  }
  if (!PAPEIS.includes(papel)) {
    return { ok: false, erro: 'Papel inválido.' };
  }
  const token = Buffer.from(`${papel}:${Date.now()}`).toString('base64');
  return { ok: true, token, papel };
}

// middleware: exige header x-papel válido (vindo do front após login)
export function exigirPapel(req, res, next) {
  const papel = req.header('x-papel');
  if (!PAPEIS.includes(papel)) {
    return res.status(401).json({ erro: 'Faça login.' });
  }
  req.papel = papel;
  next();
}
