export async function suggestContent(storeId: string) {
  const fallback = {
    storeName: `Store ${storeId}`,
    tagline: "Quality products, fast delivery.",
    products: [
      { title: "Classic Tee", price: 499 },
      { title: "Canvas Tote", price: 299 },
      { title: "Ceramic Mug", price: 199 },
    ],
  };

  const key = process.env.GROQ_API_KEY;
  const base = process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1";
  const model = process.env.GROQ_MODEL ?? "llama-3.1-70b-versatile";
  const timeoutMsRaw = Number(process.env.AI_HTTP_TIMEOUT_MS ?? "15000");
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 15000;

  if (!key) return { ...fallback, source: "fallback" as const };

  let res: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "Return strict JSON only." },
          {
            role: "user",
            content:
              `Suggest a storeName, tagline, and 3 starter products (title, price INR) for storeId=${storeId}.`,
          },
        ],
        temperature: 0.7,
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
  } catch {
    return { ...fallback, source: "fallback" as const };
  }

  if (!res.ok) return { ...fallback, source: "fallback" as const };

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  try {
    const parsed = JSON.parse(text);
    return { ...parsed, source: "llm" as const };
  } catch {
    return { ...fallback, source: "fallback" as const };
  }
}
