// server.js
// Ponte entre UazAPI (WhatsApp) e a API da OpenAI (GPT)
//
// Fluxo:
// 1. UazAPI recebe mensagem no WhatsApp -> manda POST pra este servidor (webhook)
// 2. Este servidor pega o texto e manda pra API da OpenAI
// 3. Pega a resposta do GPT e manda de volta pra UazAPI enviar no WhatsApp

const express = require("express");
const app = express();
app.use(express.json());

// ====== VARIÁVEIS DE AMBIENTE (configurar no painel do Render/Railway) ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const UAZAPI_SERVER_URL = process.env.UAZAPI_SERVER_URL; // ex: https://wdqwdw.uazapi.com
const UAZAPI_INSTANCE_TOKEN = process.env.UAZAPI_INSTANCE_TOKEN; // token da instância (não é o admin token)
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "Você é um assistente virtual simpático e objetivo. Responda de forma curta e clara.";

// Guarda simples em memória pra não responder a própria mensagem em loop
// (mesmo com wasSentByApi configurado, é uma segunda camada de segurança)
const processedMessageIds = new Set();

app.get("/", (req, res) => {
  res.send("Bot rodando ✅");
});

// ====== ENDPOINT QUE RECEBE O WEBHOOK DA UAZAPI ======
app.post("/webhook", async (req, res) => {
  try {
    // Responde imediatamente pra UazAPI não ficar esperando (evita timeout/retry)
    res.status(200).json({ received: true });

    const body = req.body;

    // A UazAPI manda o evento dentro de "message" (formato pode variar levemente
    // dependendo da versão - ajuste os campos abaixo se necessário depois de ver
    // o payload real no log)
    const message = body.message || body;

    // Ignora mensagens enviadas pela própria API (evita loop)
    if (message.fromMe || message.wasSentByApi) {
      console.log("Ignorando mensagem própria (fromMe/wasSentByApi)");
      return;
    }

    // Ignora mensagens de grupo (opcional)
    if (message.isGroup) {
      console.log("Ignorando mensagem de grupo");
      return;
    }

    const messageId = message.id || message.messageid;
    if (messageId) {
      if (processedMessageIds.has(messageId)) {
        console.log("Mensagem já processada, ignorando duplicata");
        return;
      }
      processedMessageIds.add(messageId);
    }

    // Número do remetente e texto da mensagem
    const from = message.sender || message.chatid || message.from;
    const text = message.text || message.content || message.body;

    if (!from || !text) {
      console.log("Payload sem 'from' ou 'text' reconhecível:", JSON.stringify(body));
      return;
    }

    console.log(`Mensagem recebida de ${from}: ${text}`);

    // ====== CHAMA A API DA OPENAI ======
    const gptReply = await callOpenAI(text);

    // ====== ENVIA A RESPOSTA DE VOLTA PRO WHATSAPP VIA UAZAPI ======
    await sendWhatsAppMessage(from, gptReply);

    console.log(`Resposta enviada para ${from}: ${gptReply}`);
  } catch (err) {
    console.error("Erro no webhook:", err);
  }
});

// ====== FUNÇÃO: CHAMA O GPT ======
async function callOpenAI(userText) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText },
      ],
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("Erro na OpenAI:", errText);
    return "Desculpe, tive um problema para responder agora. Tente novamente em instantes.";
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "Não entendi, pode repetir?";
}

// ====== FUNÇÃO: ENVIA MENSAGEM DE VOLTA PELA UAZAPI ======
async function sendWhatsAppMessage(number, text) {
  const response = await fetch(`${UAZAPI_SERVER_URL}/send/text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      token: UAZAPI_INSTANCE_TOKEN,
    },
    body: JSON.stringify({
      number: number,
      text: text,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("Erro ao enviar mensagem via UazAPI:", errText);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
