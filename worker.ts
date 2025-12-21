const ALLOWED_GROUP_IDS = new Set([
  "C932229a87836229baa9466c6a67cda9b",
]);

const SYSTEM_PROMPT = `
あなたは「福沢諭吉」の口調・価値観（独立自尊、学問のすすめ、実学重視、文明開化期の文体）を模した“議論支援AI”である。ここは AI の最新研究・事例を議論する学生グループチャットであり、あなたの役割は、問いを整理し、根拠を明確にし、学びを促すことにある。

【人格・文体】
- 一人称は「余」または「私」。語尾は古風にしつつ、読みやすさを優先する（例：「…である」「…と考う」「…なり」）。
- 上から目線の説教は避ける。学生の探究心を尊重し、議論を前に進める。
- 感情的・断定的にならず、論点と根拠を明瞭に述べる。

【基本姿勢（最重要）】
- 不確かな情報を事実のように言わない。知らぬ場合は「今の手元情報では確証が持てぬ」と明言する。
- 研究・事例・数値・比較を述べる際は、必ず一次情報（論文、公式ドキュメント、著者ブログ、公式リポジトリ等）を挙げる。出典を示せない主張はしない。
- 引用は短く、要点は自分の言葉で整理する。恣意的な解釈を避ける。
- 「最新」を求められる場合、日付・版・公開時点を必ず確認し、情報が変わり得る旨を添える。

【応答の構成（既定フォーマット）】
1) 要点（1〜3行）：問いへの結論または暫定結論を簡潔に述べる。
2) 根拠：主要な論文・資料を箇条書きで示す（著者、年、会議/誌、arXiv IDやURL等）。
3) 論点整理：前提・定義・比較軸（ベンチマーク、データ、評価指標、制約）を明示する。
4) 次の一手：学生が検証できる具体的アクション（読むべき節、再現コード、簡易実験手順）を1〜3個提示。
5)（任意）問い返し：不明点が大きい場合のみ、質問は最大1つに絞る。

【議論支援のルール】
- 質問の意図が曖昧なら「何を比較し、何を最適化したいか」を短く確認する。
- モデルや手法の優劣を述べる際は、必ず条件（データセット、計算資源、推論条件、ハイパラ等）を併記する。
- SNSの噂・二次まとめのみは根拠にしない。やむを得ず触れる場合は「未検証情報」と明示する。
- 過度な自己言及（AIである、など）は避ける。必要最小限に留める。

【安全・倫理】
- 個人情報の収集、特定個人への攻撃、違法行為の指南、危険物・不正アクセス等は拒否し、安全な代替案を示す。
- 研究倫理（データ利用規約、著作権、プライバシー）に留意し、注意喚起する。

【口調サンプル（参考）】
- 「さて、問は二つに分かる。第一に定義、第二に評価である。」
- 「余は断ずるに、比較の前に条件を揃えねば学問にならぬ。」
- 「根拠は以下の通り。出典なき断言は慎むべし。」

以上に従い、福沢諭吉の筆致を保ちながら、学生の研究議論を最短距離で前進させよ。
`


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

	    /*
	    // check whether group_id is valid
	    if (source?.type === "group") {
	      const groupId = source.groupId;

	      if (!groupId || !ALLOWED_GROUP_IDS.has(groupId)) {
		console.warn("Unauthorized group:", groupId);

		return new Response("OK", { status: 200 });
	      }
	    }
	    */

	    if (!replyToken) return new Response("OK", { status: 200 });

	    if (event.message?.type !== "text") return new Response("OK", { status: 200 });

	    const text = String(event.message.text ?? "").trim();

	    ctx.waitUntil(handleMessage(env, event, replyToken, text));

	    return new Response("OK", { status: 200 });
    } catch (err: any) {
	    console.error("Worker error:", err?.stack || err);
	    return new Response("OK", { status: 200 });
    }
  },
};

async function handleMessage(env: any, event: any, replyToken: string, text: string) {
	try {
	    const mentioned = isBotMentioned(event);
	    const source = event?.source;

	    // LLM
	    if (mentioned) {
		    if (!env.OPENROUTER_API_KEY) {
			    console.error("Missing OPENROUTER_API_KEY");
			    await replyText(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, "OPENROUTER_API_KEY が未設定です");
			    return;
		    }
		    const answer = await askOpenRouter(env.OPENROUTER_API_KEY, text);
		    await replyText(env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, answer || "応答を生成できませんでした");
		    return;
	    }

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

// Reply API
async function replyText(token: string, replyToken: string, text: string) {
  if (!token) {
	  console.error("Missing LINE_CHANNEL_ACCESS_TOKEN");
	  return;
  }
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
	  method: "POST",
	  headers: {
		  "Content-Type": "application/json",
		  Authorization: `Bearer ${token}`,
	  },
	  body: JSON.stringify({
		  replyToken,
		  messages: [{ type: "text", text }],
	  }),
  });
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
async function askOpenRouter(apiKey: string, userText: string): Promise<string> {
  const url = "https://openrouter.ai/api/v1/chat/completions";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      // 任意（推奨）：アプリ識別子。未設定でも動作はします。
      // "HTTP-Referer": "https://your-app.example",
      // "X-Title": "leo-linebot",
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b:free", // OpenRouter上のモデルID :contentReference[oaicite:5]{index=5}
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText },
      ],
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("OpenRouter error:", res.status, t);
    return "";
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim?.() || "";
}
