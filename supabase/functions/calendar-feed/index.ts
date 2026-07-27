// Supabase Edge Function: serves the household calendar as a live ICS feed.
// Subscribe URL: /functions/v1/calendar-feed?token=<feed token>
// Deploy with "Verify JWT" OFF — calendar clients cannot send an auth header.
// Auth is the unguessable per-household token in public.calendar_feeds.
//
// Requires the calendar_feeds table (see supabase/calendar.sql, section 5).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const esc = (v: unknown) =>
  String(v ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");

const fold = (line: string) => {
  const out: string[] = [];
  let s = line;
  while (s.length > 73) {
    out.push(s.slice(0, 73));
    s = " " + s.slice(73);
  }
  out.push(s);
  return out.join("\r\n");
};

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const dayStamp = (d: Date) =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

const RRULE: Record<string, string> = {
  daily: "FREQ=DAILY",
  weekly: "FREQ=WEEKLY",
  biweekly: "FREQ=WEEKLY;INTERVAL=2",
  monthly: "FREQ=MONTHLY",
  yearly: "FREQ=YEARLY",
};

async function rest(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get("token");
  if (!token || token.length < 16) {
    return new Response("Missing or invalid token", { status: 401 });
  }

  try {
    const feeds = await rest(
      `calendar_feeds?token=eq.${encodeURIComponent(token)}&select=household_id&limit=1`,
    );
    if (!feeds.length) return new Response("Unknown token", { status: 403 });

    const householdId = feeds[0].household_id;
    const events = await rest(
      `calendar_events?household_id=eq.${householdId}&select=*&order=starts_at`,
    );

    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//OurSpending//Shared Calendar//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:OurSpending",
      "X-PUBLISHED-TTL:PT30M",
    ];

    for (const e of events) {
      const s = new Date(e.starts_at);
      const en = new Date(e.ends_at);
      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${e.id}@ourspending`);
      lines.push(`DTSTAMP:${stamp(new Date(e.updated_at ?? e.created_at ?? Date.now()))}`);
      if (e.all_day) {
        const endPlus = new Date(en.getTime() + 86400000);
        lines.push(`DTSTART;VALUE=DATE:${dayStamp(s)}`);
        lines.push(`DTEND;VALUE=DATE:${dayStamp(endPlus)}`);
      } else {
        lines.push(`DTSTART:${stamp(s)}`);
        lines.push(`DTEND:${stamp(en)}`);
      }
      lines.push(fold(`SUMMARY:${esc(e.title)}`));
      if (e.description) lines.push(fold(`DESCRIPTION:${esc(e.description)}`));
      if (e.location) lines.push(fold(`LOCATION:${esc(e.location)}`));
      const rule = RRULE[e.recurrence];
      if (rule) {
        lines.push(
          e.recurrence_until
            ? `RRULE:${rule};UNTIL=${e.recurrence_until.replace(/-/g, "")}T235959Z`
            : `RRULE:${rule}`,
        );
      }
      lines.push("END:VEVENT");
    }

    lines.push("END:VCALENDAR");

    return new Response(lines.join("\r\n"), {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": "public, max-age=900",
        "Content-Disposition": 'inline; filename="ourspending.ics"',
      },
    });
  } catch (e) {
    console.error("calendar-feed:", String(e));
    return new Response("Feed error", { status: 500 });
  }
});
