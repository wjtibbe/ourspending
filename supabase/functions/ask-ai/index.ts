// Supabase Edge Function: proxies a household expense question to the Claude API.
// Deploy with: supabase functions deploy ask-ai
// Requires secret: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-haiku-4-5-20251001";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async req => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { question, context } = await req.json();
    if (!question || typeof question !== "string") {
      return new Response(JSON.stringify({ error: "Missing question" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY secret is not set" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const systemPrompt = `You are a helpful assistant inside a shared household expense-tracking app called OurSpending. Answer the user's question using ONLY the expense data given below — do not invent numbers. Lead with the direct answer, then at most 1-2 short supporting sentences. Reply in the same language as the question. All amounts are in EUR. Today's date is ${today}.

Expense data (CSV columns: date,category,kind,payer,amount_eur,note):
${String(context || "").slice(0, 100000)}`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: "user", content: question }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return new Response(JSON.stringify({ error: `Anthropic API error (${resp.status}): ${errText}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await resp.json();
    const answer = data?.content?.[0]?.text ?? "Geen antwoord ontvangen.";

    return new Response(JSON.stringify({ answer }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
