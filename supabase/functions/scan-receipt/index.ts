// Supabase Edge Function: reads a receipt photo with Claude vision and
// returns { amount, currency, date, merchant, category }.
// Deploy: supabase functions deploy scan-receipt
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-haiku-4-5-20251001";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const PROMPT = `This is a photo of a store receipt. Reply with ONLY a JSON object, no other text:
{"amount": <number>, "currency": "EUR"|"USD"|"COP", "date": "YYYY-MM-DD"|null, "merchant": "store name"|null, "category": "<id>"}

Rules:
- amount = the grand total actually paid, after tax, tip and discounts.
- A "$" sign on a Colombian receipt means COP, not USD. Colombian receipts often write thousands with dots (12.500 = 12500 COP).
- If a field is unreadable, use null (amount: use your best estimate of the total; if truly unreadable use null).
- category must be one of: groceries, snacks, dining, household, rent, transport, travel, health, subscriptions, clothing, entertainment, gifts, personalcare, other.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { image, mediaType } = await req.json();
    if (!image || typeof image !== "string") return json({ error: "Missing image" }, 400);
    if (!ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY secret is not set" }, 500);

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: image } },
            { type: "text", text: PROMPT },
          ],
        }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return json({ error: `Anthropic API error (${resp.status}): ${errText}` }, 502);
    }

    const data = await resp.json();
    const text: string = data?.content?.[0]?.text ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return json({ error: "Could not parse receipt: " + text.slice(0, 200) }, 422);

    const parsed = JSON.parse(match[0]);
    return json({
      amount: typeof parsed.amount === "number" ? parsed.amount : null,
      currency: ["EUR", "USD", "COP"].includes(parsed.currency) ? parsed.currency : null,
      date: typeof parsed.date === "string" ? parsed.date : null,
      merchant: typeof parsed.merchant === "string" ? parsed.merchant : null,
      category: typeof parsed.category === "string" ? parsed.category : null,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
