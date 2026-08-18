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

// ====== MEMÓRIA PERSISTENTE DE CONVERSA (via Upstash Redis) ======
// Isso garante que o histórico da conversa NÃO se perde se o servidor
// reiniciar (diferente de guardar só em uma variável na memória RAM).
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const MAX_HISTORY_MESSAGES = 20; // limita o tamanho para não estourar custo/tokens

// Fallback em memória, caso o Redis não esteja configurado ou falhe
const memoryFallback = new Map();

async function getHistory(from) {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    console.log("Redis não configurado, usando fallback em memória para", from);
    return memoryFallback.get(from) || [];
  }
  try {
    const res = await fetch(`${UPSTASH_REDIS_REST_URL}/get/conversa:${encodeURIComponent(from)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("Redis GET retornou erro:", res.status, errText);
      return memoryFallback.get(from) || [];
    }
    const data = await res.json();
    if (data.result) {
      const parsed = JSON.parse(data.result);
      console.log(`Histórico encontrado no Redis para ${from}: ${parsed.length} mensagens`);
      return parsed;
    }
    console.log(`Nenhum histórico encontrado no Redis para ${from} (conversa nova)`);
    return [];
  } catch (err) {
    console.error("Erro ao buscar histórico no Redis, usando fallback em memória:", err);
    return memoryFallback.get(from) || [];
  }
}

async function saveHistory(from, history) {
  // mantém só as últimas N mensagens para não crescer infinito
  if (history.length > MAX_HISTORY_MESSAGES) {
    history = history.slice(history.length - MAX_HISTORY_MESSAGES);
  }
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    memoryFallback.set(from, history);
    return;
  }
  try {
    const res = await fetch(`${UPSTASH_REDIS_REST_URL}/set/conversa:${encodeURIComponent(from)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(history),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("Redis SET retornou erro:", res.status, errText);
    } else {
      console.log(`Histórico salvo no Redis para ${from} (${history.length} mensagens)`);
    }
  } catch (err) {
    console.error("Erro ao salvar histórico no Redis, usando fallback em memória:", err);
    memoryFallback.set(from, history);
  }
}

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

    // Busca o histórico salvo dessa conversa (sobrevive a reinícios do servidor)
    const history = await getHistory(from);
    history.push({ role: "user", content: text });

    // ====== CHAMA A API DA OPENAI, PASSANDO O HISTÓRICO INTEIRO ======
    const gptReply = await callOpenAI(history);

    // Salva a resposta do bot no histórico também, para a próxima mensagem
    history.push({ role: "assistant", content: gptReply });
    await saveHistory(from, history);

    // ====== ENVIA A RESPOSTA DE VOLTA PRO WHATSAPP VIA UAZAPI ======
    await sendWhatsAppMessage(from, gptReply);

    console.log(`Resposta enviada para ${from}: ${gptReply}`);
  } catch (err) {
    console.error("Erro no webhook:", err);
  }
});

// ====== FUNÇÃO: CHAMA O GPT (agora recebe o histórico completo da conversa) ======
async function callOpenAI(history) {
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
        ...history,
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
