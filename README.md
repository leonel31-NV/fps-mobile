# Arena FPS — laser tag com câmera, para o Render

Jogo multiplayer no navegador. Não há personagens gerados: a câmera traseira mostra o mundo real e você
atira em **pessoas de verdade**. Quando a mira (centro da tela) estiver sobre uma pessoa, aparece o
quadro vermelho "ALVO"; ao tocar em **Atirar**, o servidor registra o acerto.

```
backend/   server.js, package.json, .env.example   -> Render Web Service
frontend/  index.html, style.css, game.js, config.js -> Render Static Site
render.yaml
```

## Como funciona
- **Detecção de pessoas:** roda no celular de quem atira (TensorFlow.js + COCO-SSD, baixado de CDN na
  1ª abertura, alguns MB). O vídeo da câmera **nunca** é enviado ao servidor.
- **Quem foi atingido:** cada jogador escolhe uma cor e deve vestir algo dela (camisa, boné, fita).
  Com 1 adversário vivo, ele é o alvo automaticamente. Com 2 ou mais, o celular compara a cor da
  roupa da pessoa sob a mira com a cor de cada jogador.
- **Servidor (autoridade):** vida, munição (12), cadência, recarga, dano (25), respawn (3 s) e placar.
  Ignora tiros em si mesmo, em alvo já derrubado ou inválido, e limita eventos por segundo.
- **Som e arma:** tiro, recarga, acerto e dano são sintetizados no aparelho; a arma aparece na tela
  com recuo, clarão e animação de recarga.

## Controles
Botões **Atirar** (segure para rajada) e **Recarregar**. No computador: Espaço atira, R recarrega.

## Teste local
```bash
cd backend && npm install
SERVE_FRONTEND=true npm start      # http://localhost:3000
```
A câmera só funciona em HTTPS ou `localhost`.

## Publicar no Render
1. **GitHub:** suba o projeto (pastas `backend` e `frontend` na raiz do repositório).
2. **Backend:** *New > Web Service* · Root Directory `backend` · Build `npm install` · Start `npm start`
   · Health Check `/health`. Anote a URL.
3. **Frontend:** *New > Static Site* · Root Directory `frontend` · Publish Directory `.`
   · Build Command `echo "window.BACKEND_URL='URL_DO_BACKEND';" > config.js`
4. No backend, em *Environment*, crie `ALLOWED_ORIGINS` = URL do frontend (sem barra no final).
5. **Atualizações:** após `git push`, o Render publica sozinho (se o deploy automático estiver ligado).
6. **Logs:** painel do serviço > *Logs*. Erro de CORS = `ALLOWED_ORIGINS` diferente da URL do frontend.

## Limitações
- **O acerto é decidido pelo celular do atirador** (a câmera não vai ao servidor). O servidor valida
  alvo, cadência e munição, mas não consegue provar que havia mesmo uma pessoa na mira. Serve para
  jogar entre amigos, não para competição com desconfiança.
- A detecção depende de luz e distância: funciona melhor com a pessoa inteira visível e de frente.
  Em celulares fracos pode ficar lenta.
- Identificação por cor falha com roupas escuras/sem cor ou cores parecidas; nesse caso o jogo avisa
  "Pessoa detectada, mas não identificada".
- Partidas ficam **na memória**: reiniciar o serviço apaga as salas. Plano gratuito do Render dorme
  sem uso e o 1º acesso demora. Se a conexão cair, o jogador volta à sala como novo (placar zerado).
- Jogue apenas com quem concordou em participar.
