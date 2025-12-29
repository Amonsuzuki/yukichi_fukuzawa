type MemItem = { role: "user" | "assistant"; content: string; t: number };

async function getLineDisplayName(
  channelAccessToken: string,
  userId: string
): Promise<string | null> {
  if (!channelAccessToken || !userId) return null;

  const res = await fetch(
    `https://api.line.me/v2/bot/profile/${userId}`,
    {
      headers: {
        Authorization: `Bearer ${channelAccessToken}`,
      },
    }
  );

  if (!res.ok) return null;

  const data = await res.json();
  return typeof data?.displayName === "string" ? data.displayName : null;
}

async function getLineGroupName(
  channelAccessToken: string,
  groupId: string
): Promise<string | null> {
  const res = await fetch(
    `https://api.line.me/v2/bot/group/${groupId}/summary`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${channelAccessToken}`,
      },
    }
  );

  if (!res.ok) {
    // 403: bot not in group
    // 404: invalid groupId
    return null;
  }

  const data = await res.json();
  return data.groupName ?? null;
}


function memoryKey(event: any, userName: string, groupName: string): string {
	const s = event?.source;

	if (s?.type === "group") return `mem::${groupName}:${s.groupId ?? "unkown"}`;
	if (s?.type === "room") return `mem:${groupName}:${s.roomId ?? "unkown"}`;
	return `mem:${userName}:${s?.userId ?? "unkown"}`;
}

async function loadMemory(env: any, key: string): Promise<MemItem[]> {
	const raw = await env.YUKICHI_MEMORY_KV.get(key);
	if (!raw) return [];
	try { return JSON.parse(raw) as MemItem[]; } catch { return []; }
}

async function saveMemory(env: any, key: string, mem: MemItem[]) {
	await env.YUKICHI_MEMORY_KV.put(key, JSON.stringify(mem), { expirationTtl: 2_592_000 });
}

function appendAndTrim(mem: MemItem[], item: MemItem, maxItems = 20): MemItem[] {
	const next = [...mem, item];
	return next.length > maxItems ? next.slice(next.length - maxItems) : next;
}

function sanitizeText(s: string): string {
	if (!s) return "";

	let out = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

	out = out.replace(/[<>#]/g, "");
	out = out.replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
	out = out.replace(/\r?\n+/g, "");
	out = out.replace(/[ \t]+/g, "").trim();
	return out;
}

async function handleMessage(env: any, event: any, replyToken: string, text: string) {
	try {
	    const source = event?.source;
	    const mentioned = isBotMentioned(event);

	    const userId = event?.source?.userId;
	    let userName = "あなた";

	    if (userId) {
		    const fetched = await getLineDisplayName(
			    env.LINE_CHANNEL_ACCESS_TOKEN,
			    userId
		    );
		    if (fetched) userName = sanitizeText(fetched);
	    }

	    const groupId = event?.source?.groupId;
	    let groupName = "null";

	    if (groupId) {
		    const fetched = await getLineGroupName(
			    env.LINE_CHANNEL_ACCESS_TOKEN,
			    groupId
		    );
		    if (fetched) groupName = sanitizeText(fetched);
	    }
	

	    let answer = "null";
	    if (mentioned) {
		    const key = memoryKey(event, userName, groupName);
		    let mem = await loadMemory(env, key);

		    const userContent = userName + ": " +  sanitizeText(text); 

		    mem = appendAndTrim(mem, { role: "user", content: userContent, t: Date.now() });

		    if (!env.OPENROUTER_API_KEY) {
			    console.error("Missing OPENROUTER_API_KEY");
			    await replyText(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, "OPENROUTER_API_KEY が未設定です");
			    return;
		    }
		    const rawAnswer = await askOpenRouter(env.OPENROUTER_API_KEY, mem, text);
		    answer = sanitizeText(rawAnswer);

		
		    mem = appendAndTrim(mem, { role: "assistant", content: answer, t: Date.now() });
		    await saveMemory(env, key, mem);
	    }

	    await replyText(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, answer || "応答を生成できませんでした");
	    return;

	} catch (e: any) {
		console.error("handleMessage error;", e?.stack || e);
	}
}

// HMAC-SHA256 + Base64 で署名検証
async function verifyLineSignature(bodyText: string, signature: string, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bodyText));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return b64 === signature;
}

function fetchWithTimeout(url: string, init: RequestInit, ms: number) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...init, signal: ac.signal }).finally(() => clearTimeout(t));
}


// Reply API
async function replyText(token: string, replyToken: string, text: string) {
  if (!token) {
	  console.error("Missing LINE_CHANNEL_ACCESS_TOKEN");
	  return;
  }
  const res = await fetchWithTimeout("https://api.line.me/v2/bot/message/reply", {
	  method: "POST",
	  headers: {
		  "Content-Type": "application/json",
		  Authorization: `Bearer ${token}`,
	  },
	  body: JSON.stringify({
		  replyToken,
		  messages: [{ type: "text", text }],
	  }),
  }, 250_000);
  if (!res.ok) {
	  const t = await res.text().catch(() => "");
	  console.error("LINE reply error:", res.status, t);
  }
}

// --- メンション判定 ---
// LINE公式: botがメンションされた場合 message.mention.mentionees[].isSelf が true になる :contentReference[oaicite:3]{index=3}
function isBotMentioned(event: any): boolean {
  const mentionees = event?.message?.mention?.mentionees;
  if (!Array.isArray(mentionees)) return false;
  return mentionees.some((m: any) => m?.isSelf === true);
}

// --- OpenRouter呼び出し ---
// OpenRouter: Bearer認証 + /api/v1/chat/completions :contentReference[oaicite:4]{index=4}
async function askOpenRouter(apiKey: string, mem: MemItem[], userText: string, userName: string): Promise<string> {
  const url = "https://openrouter.ai/api/v1/chat/completions";
  const SYSTEM_PROMPT = `
あなたは「福沢諭吉」の口調・価値観（独立自尊、学問のすすめ、実学重視、文明開化期の文体）を模した“議論支援AI”である。ここは AI の最新研究・事例を議論する学生グループチャットであり、あなたの役割は、質問に対して根拠を明確に回答することにある。質問者は${userName}です．

【人格・文体】
- 一人称は「私」。読みやすさを優先する（例：「…である」「…と考える」）。
- 上から目線の説教は避ける。学生の探究心を尊重し、議論を前に進める。
- 感情的・断定的にならず、論点と根拠を明瞭に述べる。

【基本姿勢（最重要）】
- 不確かな情報を事実のように言わない。知らない場合は「今の手元情報では確証が持てない」と明言する。
- 研究・事例・数値・比較を述べる際は、必ず一次情報（論文、公式ドキュメント、著者ブログ、公式リポジトリ等）を挙げる。出典を示せない主張はしない。
- 引用は短く、要点は自分の言葉で整理する。恣意的な解釈を避ける。
- 「最新」を求められる場合、日付・版・公開時点を必ず確認し、情報が変わり得る旨を添える。

【議論支援のルール】
- モデルや手法の優劣を述べる際は、必ず条件（データセット、計算資源、推論条件、ハイパラ等）を併記する。
- SNSの噂・二次まとめのみは根拠にしない。やむを得ず触れる場合は「未検証情報」と明示する。
- 256文字以内で回答する

【口調サンプル（参考）】
- 「${userName}君。さて、問は二つに分かれる。」
- 「比較の前に条件を揃えなければ学問にならない。」
- 「根拠は以下の通り。出典なき断言は慎むべし。」

以上に従い、福沢諭吉の筆致を保ちながら、学生の研究議論を最短距離で前進させる。
`
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      // "HTTP-Referer": "https://your-app.example",
      // "X-Title": "leo-linebot",
    },
    body: JSON.stringify({
      model: "google/gemma-3-27b-it:free",
      //model: "deepseek/deepseek-r1-0528:free",
      //model: "openai/gpt-oss-20b:free", 
      max_tokens: 128,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
	...mem.map(m => ({ role: m.role, content: m.content })),
      ],
    }),
  }, 900_000);

  if (!res.ok) return "";
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim?.() || "";
}

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    console.log("HIT", request.method, new URL(request.url).pathname);
    try {
	    const url = new URL(request.url);

	    // ---- LINE Webhook ----
	    if (request.method !== "POST") return new Response("OK", { status: 200 });

	    const bodyText = await request.text();

	    // 署名検証（ここが通らないと返信・記録しません）
	    const sig = request.headers.get("x-line-signature") || "";
	    if (!(await verifyLineSignature(bodyText, sig, env.LINE_CHANNEL_SECRET))) {
		    return new Response("Bad signature", { status: 401 });
	    }

	    const payload = JSON.parse(bodyText);
	    const event = payload.events?.[0];
	    if (!event) return new Response("OK", { status: 200 });

	    const source = event.source;
	    const replyToken = event.replyToken as string | undefined;

	    if (!replyToken) return new Response("OK", { status: 200 });

	    if (event.message?.type !== "text") return new Response("OK", { status: 200 });

	    const text = sanitizeText(String(event.message.text ?? "").trim());

	    ctx.waitUntil(
		    handleMessage(env, event, replyToken, text).catch((e) => {
			    console.error("waitUntil task failed:", e?.stack || e);
		    })
	    );

	    return new Response("OK", { status: 200 });
    } catch (err: any) {
	    console.error("Worker error:", err?.stack || err);
	    return new Response("OK", { status: 200 });
    }
  },
};
