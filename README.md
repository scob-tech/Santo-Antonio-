# scobtech · Atendimento WhatsApp + IA

Sistema de atendimento pelo WhatsApp com uma camada de IA (sugestão de resposta,
curadoria de fim de dia e detecção de gargalos) e um **motor de economia** que
escolhe o jeito mais barato de responder (texto livre dentro da janela de 24h vs.
template). Multi-academia, feito pra rodar no **Railway** a partir de um push no
**GitHub**.

Stack: **Node.js + Express**, **PostgreSQL**, **API de LLM** (Claude ou OpenAI).

> **A regra de ouro deste projeto:** ele **sobe mesmo sem nenhuma credencial**.
> Sem banco, sem Meta e sem IA, ele roda em **modo demonstração** com dados de
> exemplo — pra você ver o painel funcionando antes de plugar as coisas.

---

## Como subir no Railway (seu fluxo: .zip → GitHub → Railway)

1. **Suba pro GitHub.** Descompacte este `.zip`, crie um repositório novo no
   GitHub e suba os arquivos (pode arrastar tudo na interface do GitHub, ou
   `git init && git add . && git commit && git push`).

2. **Crie o projeto no Railway.** Em [railway.app](https://railway.app):
   *New Project → Deploy from GitHub repo* → escolha o repositório.
   O Railway detecta o Node sozinho e faz o build.

3. **Adicione o PostgreSQL.** Dentro do projeto: *New → Database → PostgreSQL*
   (1 clique). Ele cria a variável `DATABASE_URL` automaticamente. Na primeira
   subida o sistema **cria as tabelas e insere os dados de exemplo da DANDY**.

4. **Preencha as variáveis** (aba *Variables* do serviço). Veja `.env.example`
   pra lista completa. No começo, você só precisa de:
   - `VERIFY_TOKEN` — uma senha que **você inventa** (usada no passo do webhook)
   - `PAINEL_SENHA` — senha pra entrar no painel (padrão: `dandy2026`)

   As credenciais da Meta (`WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`) e da IA
   (`LLM_API_KEY`) você preenche **depois** — sem elas o sistema roda em modo
   demo/simulado.

5. **Pegue a URL pública.** O Railway te dá uma URL `https://...up.railway.app`.
   Abra ela: cai na tela de login do painel. Essa mesma URL + `/webhook` é o
   endereço que você vai colar na Meta.

6. **Quando o número de teste da Meta sair:** no painel da Meta, configure o
   webhook com:
   - **Callback URL:** `https://SEU-APP.up.railway.app/webhook`
   - **Verify token:** o mesmo valor que você pôs em `VERIFY_TOKEN`
   Assine o campo `messages`. Pronto — as mensagens começam a cair no sistema.

---

## Rodando na sua máquina (opcional)

```bash
npm install
cp .env.example .env      # edite se quiser (pode deixar tudo em branco)
npm start
# abre http://localhost:3000  (login com a PAINEL_SENHA)
```

Sem `DATABASE_URL`, sobe em modo demo. Com um Postgres local, rode
`npm run initdb` uma vez (ou deixe o boot criar as tabelas).

---

## Os 3 acessos (papéis)

Na tela de login você escolhe o papel — ele controla o que aparece:

- **Gerente** — vê a rede toda, relatório/curadoria da IA, roda curadoria.
- **Coordenador** — vê a unidade dele + os gargalos.
- **Vendedor** — vê os atendimentos dele + as metas.

Na Fase 1 o acesso é por papel com uma senha única (simples, pra demonstração).
Login individual por usuário entra na Fase 2.

---

## O que tem dentro (mapa do código)

```
src/
  index.js            → sobe o Express, monta tudo, liga o agendador
  config.js           → lê as variáveis de ambiente + flags de modo demo
  db/
    schema.sql        → as tabelas (academias, unidades, usuarios, contatos,
                        conversas, mensagens, tarefas, templates, metas)
    pool.js           → conexão com o Postgres (null em modo demo)
    init.js           → cria as tabelas + seed de exemplo (DANDY)
  whatsapp/
    webhook.js        → recebe mensagens da Meta e roteia pro banco + IA
    send.js           → envia (texto livre / template) pela Graph API
  ia/
    client.js         → fala com Claude ou OpenAI (simulado sem chave)
    sugestao.js       → rascunha a resposta em tempo real
    curadoria.js      → resumo do dia + gera tarefas
    gargalos.js       → varredura por regras (sem resposta, parado, janela)
  economia/
    motor.js          → janela de 24h, texto livre vs template, categoria
  cron/
    agendador.js      → gargalos a cada 30min, curadoria após as 20h
  auth/
    auth.js           → login por papel (Fase 1)
  routes/
    painel.js         → API que alimenta o painel
public/
  index.html          → tela de login
  painel.html         → o painel
  app.js, styles.css  → front do painel
```

---

## O motor de economia (o diferencial de venda)

- **Janela de 24h:** toda mensagem do cliente abre/renova 24h em que você
  responde em **texto livre, de graça**. O sistema controla isso por conversa.
- **Texto livre vs template:** dentro da janela → texto livre (grátis). Janela
  fechada → precisa de **template** aprovado (cobrado).
- **Categoria certa:** o sistema sugere `utility` (bem mais barato) vs
  `marketing` (mais caro) olhando se a mensagem tem cara de oferta/persuasão.
- **Sem re-disparo à toa:** só manda template pra quem realmente precisa.

---

## Fase 1 (agora) x Fase 2 (depois)

**Fase 1 — este repositório:** atendimento unificado no WhatsApp, IA (sugestão,
curadoria, gargalos), 3 acessos, metas de vendas e o motor de economia. Não vira
"sistema de origem" dos dados sensíveis do aluno — menos risco, mais rápido de vender.

**Fase 2:** CRM completo (ficha do aluno, planos e financeiro, renovação no app,
frequência por catraca, fidelidade). Entra quando a Fase 1 estiver rodando e
confiável.

---

## Segurança e dados (importante)

Isto é um esqueleto de **Fase 1**. A autenticação é simples (senha única por
papel) — suficiente pra demonstração e piloto, mas **antes de colocar dados reais
de clientes**, troque por login por usuário e revise permissões. Nunca suba o
`.env` pro GitHub (já está no `.gitignore`).

---

_scobtech · construção incremental. Comece subindo em modo demo, veja o painel,
e vá plugando banco → IA → Meta conforme cada peça fica pronta._
