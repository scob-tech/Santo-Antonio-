// scripts/simulate-message.js
// Simula um cliente mandando mensagem no WhatsApp, chamando o mesmo
// endpoint que a Z-API vai chamar de verdade no futuro.
//
// Uso: node scripts/simulate-message.js

const mensagensExemplo = [
  { telefone: '5511911112222', nome_cliente: 'João Silva', texto: 'Olá, gostaria de um orçamento de cimento e areia.', origem: 'produtos' },
  { telefone: '5511933334444', nome_cliente: 'Maria Souza', texto: 'Preciso de areia e brita, vocês entregam?', origem: 'duvidas' },
  { telefone: '5511955556666', nome_cliente: null, texto: 'Qual o valor do bloco estrutural?', origem: 'geral' },
];

async function main() {
  const escolhida = mensagensExemplo[Math.floor(Math.random() * mensagensExemplo.length)];
  const res = await fetch('http://localhost:3000/webhook/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(escolhida),
  });
  const data = await res.json();
  console.log('Lead criado:', data);
}

main().catch(console.error);
