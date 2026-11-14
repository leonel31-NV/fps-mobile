# Arena FPS — FPS multiplayer mobile para o Render

Jogo FPS no navegador: a câmera traseira do celular vira o cenário, você mira arrastando o dedo,
anda com o joystick e atira. O servidor (Node + Express + Socket.IO) controla vida, munição, recarga,
dano, respawn e placar.

```
backend/   server.js, package.json, .env.example   -> Render Web Service
frontend/  index.html, style.css, game.js, config.js -> Render Static Site
render.yaml
```

## Controles
Joystick (esquerda) move · arrastar na tela gira a mira · Atirar · Recarregar.
No computador: WASD, setas ←/→ para girar, Espaço atira, R recarrega.

## Teste local
```bash
cd backend && npm install
SERVE_FRONTEND=true npm start      # abre http://localhost:3000
```
A câmera só funciona em HTTPS ou em `localhost`. Sem câmera, o jogo continua com fundo escuro.

## Publicar no Render
1. **GitHub:** crie um repositório, e na pasta do projeto rode `git init`, `git add .`, `git commit -m "FPS"`,
   `git remote add origin <URL>`, `git push -u origin main`.
2. **Backend:** no Render, *New > Web Service*, escolha o repositório.
   Root Directory `backend` · Build `npm install` · Start `npm start` · Health Check `/health`.
3. Anote a URL do backend (ex.: `https://fps-backend.onrender.com`).
4. **Frontend:** *New > Static Site*, mesmo repositório.
   Root Directory `frontend` · Build Command `echo "window.BACKEND_URL='$BACKEND_URL';" > config.js` · Publish Directory `.`
   · variável `BACKEND_URL` = URL do backend.
5. Volte ao backend e defina `ALLOWED_ORIGINS` = URL do frontend (sem barra final). O serviço reinicia.
6. Alternativa: *New > Blueprint* usando o `render.yaml` (ele pedirá as duas variáveis).
7. **Testar:** abra o frontend em dois aparelhos (ou duas abas), crie uma sala em um, entre com o código no outro.
8. **Logs:** painel do serviço no Render > *Logs*. Erros de CORS indicam `ALLOWED_ORIGINS` errado.

## Limitações (primeira versão)
- Partidas ficam **na memória**: se o serviço reiniciar, as salas somem. Para escalar para mais de uma
  instância, seria necessário Redis (adaptador do Socket.IO) — não incluído de propósito.
- Plano gratuito do Render: o serviço dorme após inatividade e o primeiro acesso demora para acordar.
- Reconexão: se a conexão cair, o cliente tenta entrar de novo na sala, mas como jogador novo (placar zerado).
- Arena 2D simples: acerto calculado por raio no plano; não há obstáculos.

## Segurança implementada
Validação de todas as entradas, limite de eventos por segundo, cadência de tiro, munição e recarga
controladas pelo servidor, sem dano a si mesmo, nomes sanitizados, salas vazias removidas, CORS restrito.
