// Supabase Edge Function: reads a receipt photo with Claude vision and
// returns { amount, currency, merchant, category }.
// The expense date is always set client-side to today, not read from the receipt.
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
{"amount": <number>, "currency": "EUR"|"USD"|"COP", "merchant": "store name"|null, "category": "<id>"}

Rules:
- amount = the grand total actually paid, after tax, tip and discounts.
- A "$" sign on a Colombian receipt means COP, not USD. Colombian receipts often write thousands with dots (12.500 = 12500 COP).
- If a field is unreadable, use null (amount: use your best estimate of the total; if truly unreadable use null).
- category must be one of: groceries, snacks, dining, household, rent, transport, travel, health, subscriptions, clothing, entertainment, gifts, personalcare, other.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  console.log("scan-receipt: request received");

  try {
    const { image, mediaType } = await req.json();
    console.log("scan-receipt: parsed body, image length =", image ? image.length : 0);

    if (!image || typeof image !== "string") return json({ error: "Missing image" }, 400);
    if (!ANTHROPIC_API_KEY) {
      console.error("scan-receipt: ANTHROPIC_API_KEY is not set");
      return json({ error: "ANTHROPIC_API_KEY secret is not set" }, 500);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    console.log("scan-receipt: calling Anthropic...");
    let resp: Response;
    try {
      resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
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
    } catch (fetchErr) {
      console.error("scan-receipt: fetch to Anthropic failed/timed out:", String(fetchErr));
      return json({ error: "Kon Claude niet bereiken (timeout of netwerkfout): " + String(fetchErr) }, 504);
    } finally {
      clearTimeout(timeout);
    }

    console.log("scan-receipt: Anthropic responded with status", resp.status);

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("scan-receipt: Anthropic error body:", errText);
      return json({ error: `Anthropic API error (${resp.status}): ${errText}` }, 502);
    }

    const data = await resp.json();
    const text: string = data?.content?.[0]?.text ?? "";
    console.log("scan-receipt: Anthropic text:", text.slice(0, 300));

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return json({ error: "Could not parse receipt: " + text.slice(0, 200) }, 422);

    const parsed = JSON.parse(match[0]);
    return json({
      amount: typeof parsed.amount === "number" ? parsed.amount : null,
      currency: ["EUR", "USD", "COP"].includes(parsed.currency) ? parsed.currency : null,
      merchant: typeof parsed.merchant === "string" ? parsed.merchant : null,
      category: typeof parsed.category === "string" ? parsed.category : null,
    });
  } catch (e) {
    console.error("scan-receipt: unexpected error:", String(e));
    return json({ error: String(e) }, 500);
  }
});
