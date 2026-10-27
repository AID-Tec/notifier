# NOTIFIER Cloud

Notificador **WhatsApp (Baileys) + Telegram** que roda em servidor (Render), pensado para
avisar o dono da operação sobre:

- cada execução agendada (sucesso/falha) do GitHub Actions da rotina do Pacto Gorjeta;
- cada resposta ou recusa de cliente detectada pelo n8n;
- qualquer outro evento que chame `POST /notify`.

> ⚠️ WhatsApp via Baileys é **não oficial**. Viola os termos do WhatsApp e pode levar ao
> bloqueio do número. O **Telegram** é o canal oficial/seguro e funciona como reserva:
> se o WhatsApp cair, o aviso ainda chega.

---

## Como funciona

```
GitHub Actions ─┐
                ├─ POST /notify ──> WhatsApp (Baileys) ──> seu número
n8n (Render) ───┘                └> Telegram (reserva)
```

- **Sessão do WhatsApp** fica no Postgres (`DATABASE_URL`) ou num Persistent Disk
  (`SESSION_DIR`). Assim o pareamento sobrevive a deploys e reinícios.
- **Fila de mensagens**: se o WhatsApp estiver desconectado/dormindo, a mensagem é
  gravada em `notifier_fila` e sai sozinha quando a conexão voltar. Nada se perde.

---

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `PORT` | Render injeta | Porta HTTP |
| `NOTIFIER_KEY` | **sim** | Chave enviada no header `x-notifier-key` |
| `WHATSAPP_TARGET` | sim | Número de destino, DDI+DDD+número |
| `WHATSAPP_ENABLED` | não | `0` desliga o WhatsApp |
| `TELEGRAM_TOKEN` | recomendado | Token do bot (BotFather) |
| `TELEGRAM_CHAT_ID` | recomendado | Seu chat ID |
| `TELEGRAM_ENABLED` | não | `0` desliga o Telegram |
| `DATABASE_URL` | recomendado | Postgres para sessão + fila |
| `SESSION_DIR` | não | Pasta da sessão quando não usa Postgres |

Nenhum segredo fica no repositório.

---

## Endpoints

Todos exigem `x-notifier-key` (exceto `/health`).

| Método | Rota | Para que serve |
|---|---|---|
| `GET` | `/health` | Keep-alive / monitoração |
| `GET` | `/status` | Estado do WhatsApp, canais e fila |
| `POST` | `/notify` | Envia mensagem |
| `GET` | `/wa/qr` | Devolve o QR de pareamento (dataURL PNG) |
| `POST` | `/wa/pair` | Gera código de pareamento (`{"numero":"55..."}`) |
| `POST` | `/wa/logout` | Apaga a sessão e permite novo pareamento |

### Exemplo de envio

```bash
curl -X POST https://SEU-SERVICO.onrender.com/notify \
  -H "Content-Type: application/json" \
  -H "x-notifier-key: SUA_CHAVE" \
  -d '{"fonte":"pacto","titulo":"✅ Rotina concluída","mensagem":"12 enviados, 0 erros"}'
```

Resposta:

```json
{ "ok": true, "enfileirado": false, "resultados": [ ... ] }
```

Se o WhatsApp estiver fora, responde `202` com `"enfileirado": true`.

---

## Pareamento do WhatsApp (primeira vez)

1. Abra `https://SEU-SERVICO.onrender.com/wa/qr?key=SUA_CHAVE` e escaneie o QR
   (ou use `/wa/pair` para gerar um código de 8 caracteres).
2. No celular: **WhatsApp → Aparelhos conectados → Conectar aparelho**.
3. Confirme com `GET /status` que `whatsapp.estado` virou `conectado`.

A sessão fica salva no Postgres/disco — não precisa repetir a cada deploy.

---

## Rodando local

```bash
npm install
NOTIFIER_KEY=teste WHATSAPP_TARGET=5516999999999 TELEGRAM_TOKEN=... TELEGRAM_CHAT_ID=... npm start
node server.js send "teste" --fonte manual
```
