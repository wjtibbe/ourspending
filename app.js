(function(){
'use strict';
const {
  useState,
  useEffect,
  useCallback,
  useRef
} = React;

// ============================================================
//  CONFIG — your Supabase project
// ============================================================
const SUPABASE_URL = "https://cleeaaqyhmevacsfjawi.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNsZWVhYXF5aG1ldmFjc2ZqYXdpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1OTk4MjYsImV4cCI6MjA5OTE3NTgyNn0.iOVxSvzVrby5WJmlcnEne__l5mxpbC45MU2GtNJrYtc";
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
//  CONSTANTS
// ============================================================
const CATEGORIES = [{
  id: "groceries",
  label: "Groceries",
  icon: "🛒"
}, {
  id: "snacks",
  label: "Snacks & drinks",
  icon: "🥤"
}, {
  id: "dining",
  label: "Dining out",
  icon: "🍽️"
}, {
  id: "household",
  label: "Household",
  icon: "🧺"
}, {
  id: "rent",
  label: "Rent & fixed",
  icon: "🏠"
}, {
  id: "transport",
  label: "Transport",
  icon: "🚌"
}, {
  id: "travel",
  label: "Travel",
  icon: "✈️"
}, {
  id: "health",
  label: "Health & fitness",
  icon: "💪"
}, {
  id: "subscriptions",
  label: "Subscriptions",
  icon: "📱"
}, {
  id: "clothing",
  label: "Clothing",
  icon: "👕"
}, {
  id: "entertainment",
  label: "Entertainment",
  icon: "🎬"
}, {
  id: "gifts",
  label: "Gifts",
  icon: "🎁"
}, {
  id: "personalcare",
  label: "Personal care",
  icon: "💅"
}, {
  id: "other",
  label: "Other",
  icon: "📦"
}];
const CURRENCIES = ["EUR", "USD", "COP"];
const SYMBOL = {
  EUR: "€",
  USD: "$",
  COP: "COP"
};
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const perEur = (cur, r) => cur === "EUR" ? 1 : cur === "USD" ? r.usdPerEur : r.copPerEur;
const toEUR = (a, cur, r) => a / perEur(cur, r);
const fromEUR = (a, cur, r) => a * perEur(cur, r);
const fmt = (n, cur) => {
  const v = n || 0;
  if (cur === "COP") return "COP " + v.toLocaleString("en-US", {
    maximumFractionDigits: 0
  });
  return SYMBOL[cur] + " " + v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
};
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const catById = id => CATEGORIES.find(c => c.id === id) || CATEGORIES[CATEGORIES.length - 1];
const timeAgo = iso => {
  if (!iso) return "never";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};
const ratesAreStale = r => !r.updatedAt || Date.now() - new Date(r.updatedAt).getTime() > 6 * 3600 * 1000;

// ============================================================
//  LIVE RATES (via Claude API + web search)
// ============================================================
// Live mid-market rates via a keyless public API (ExchangeRate-API open endpoint).
// It uses central-bank reference rates (same basis Wise uses) and includes COP.
async function fetchLiveRates() {
  // Primary source: open.er-api.com — no key, includes COP
  const res = await fetch("https://open.er-api.com/v6/latest/EUR");
  if (!res.ok) throw new Error("Rate API HTTP " + res.status);
  const data = await res.json();
  if (data.result !== "success" || !data.rates) throw new Error("Rate API error");
  const usd = Number(data.rates.USD);
  const cop = Number(data.rates.COP);
  if (!(usd > 0.7 && usd < 2)) throw new Error("USD implausible");
  if (!(cop > 2500 && cop < 9000)) throw new Error("COP implausible");
  return {
    usdPerEur: usd,
    copPerEur: cop,
    updatedAt: new Date().toISOString()
  };
}
const RATES_ENABLED = true;

// ============================================================
//  ROOT
// ============================================================
function App() {
  const [session, setSession] = useState(null);
  const [booting, setBooting] = useState(true);
  useEffect(() => {
    db.auth.getSession().then(({
      data
    }) => {
      setSession(data.session);
      setBooting(false);
    });
    const {
      data: sub
    } = db.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  if (booting) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 60,
      textAlign: "center",
      color: "var(--muted)"
    }
  }, "Loading…");
  if (!session) return /*#__PURE__*/React.createElement(Auth, null);
  return /*#__PURE__*/React.createElement(Home, {
    session: session
  });
}

// ============================================================
//  AUTH
// ============================================================
function Auth() {
  const [mode, setMode] = useState("signin"); // signin | signup
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const submit = async () => {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      if (mode === "signup") {
        if (!name.trim()) throw new Error("Enter your name.");
        const {
          data,
          error
        } = await db.auth.signUp({
          email: email.trim(),
          password: pw
        });
        if (error) throw error;
        // store intended name for profile bootstrap
        localStorage.setItem("pending_name", name.trim());
        if (!data.session) {
          setMsg("Account created. Check your email to confirm, then sign in.");
          setMode("signin");
        }
      } else {
        const {
          error
        } = await db.auth.signInWithPassword({
          email: email.trim(),
          password: pw
        });
        if (error) throw error;
      }
    } catch (e) {
      setErr(e.message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    style: S.authWrap
  }, /*#__PURE__*/React.createElement("img", {
    className: "auth-photo",
    src: "assets/couple-beach.png",
    alt: ""
  }), /*#__PURE__*/React.createElement("div", {
    style: S.authCard
  }, /*#__PURE__*/React.createElement("div", {
    style: S.brandBig
  }, /*#__PURE__*/React.createElement("span", {
    style: S.brandMark
  }), " Our", /*#__PURE__*/React.createElement("b", {
    style: {
      color: "var(--green)"
    }
  }, "Spending")), /*#__PURE__*/React.createElement("p", {
    style: {
      color: "var(--muted)",
      fontSize: 14,
      marginTop: 0
    }
  }, "Shared expenses for two — EUR · USD · COP"), /*#__PURE__*/React.createElement("div", {
    style: S.segWide
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(mode === "signin" ? S.segOn : {})
    },
    onClick: () => setMode("signin")
  }, "Sign in"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(mode === "signup" ? S.segOn : {})
    },
    onClick: () => setMode("signup")
  }, "Sign up")), mode === "signup" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, "Your name"), /*#__PURE__*/React.createElement("input", {
    style: S.input,
    value: name,
    onChange: e => setName(e.target.value),
    placeholder: "Willem-Jan or Steffania"
  })), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, "Email"), /*#__PURE__*/React.createElement("input", {
    style: S.input,
    type: "email",
    value: email,
    onChange: e => setEmail(e.target.value),
    placeholder: "you@email.com"
  }), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, "Password"), /*#__PURE__*/React.createElement("input", {
    style: S.input,
    type: "password",
    value: pw,
    onChange: e => setPw(e.target.value),
    placeholder: "••••••••"
  }), err && /*#__PURE__*/React.createElement("div", {
    style: S.errBox
  }, err), msg && /*#__PURE__*/React.createElement("div", {
    style: S.okBox
  }, msg), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      opacity: busy ? 0.6 : 1
    },
    disabled: busy,
    onClick: submit
  }, busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account")), /*#__PURE__*/React.createElement("img", {
    className: "auth-photo",
    src: "assets/couple-mountain.png",
    alt: ""
  }));
}

// ============================================================
//  HOME (after login) — loads profile, then household
// ============================================================
function Home({
  session
}) {
  const user = session.user;
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const loadProfile = useCallback(async () => {
    setLoading(true);
    setErr(null);
    // ensure a profile row exists
    let {
      data: prof
    } = await db.from("profiles").select("*").eq("id", user.id).maybeSingle();
    if (!prof) {
      const pendingName = localStorage.getItem("pending_name") || (user.email ? user.email.split("@")[0] : "Me");
      const {
        data: created,
        error
      } = await db.from("profiles").insert({
        id: user.id,
        display_name: pendingName
      }).select().single();
      if (error) {
        setErr(error.message);
        setLoading(false);
        return;
      }
      localStorage.removeItem("pending_name");
      prof = created;
    }
    setProfile(prof);
    setLoading(false);
  }, [user]);
  useEffect(() => {
    loadProfile();
  }, [loadProfile]);
  if (loading) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 60,
      textAlign: "center",
      color: "var(--muted)"
    }
  }, "Loading your profile…");
  if (err) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 40,
      color: "var(--danger)"
    }
  }, "Error: ", err, " ", /*#__PURE__*/React.createElement("button", {
    onClick: loadProfile
  }, "Retry"));
  if (!profile.household_id) return /*#__PURE__*/React.createElement(Onboard, {
    user: user,
    profile: profile,
    onDone: loadProfile
  });
  return /*#__PURE__*/React.createElement(Dashboard, {
    user: user,
    profile: profile,
    reloadProfile: loadProfile
  });
}

// ============================================================
//  ONBOARD — create or join a household
// ============================================================
function Onboard({
  user,
  profile,
  onDone
}) {
  const [tab, setTab] = useState("create"); // create | join
  const [hhName, setHhName] = useState("Our household");
  const [slot, setSlot] = useState(0);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const {
        data: hh,
        error
      } = await db.from("households").insert({
        name: hhName.trim() || "Our household"
      }).select().single();
      if (error) throw error;
      const {
        error: e2
      } = await db.from("profiles").update({
        household_id: hh.id,
        slot
      }).eq("id", user.id);
      if (e2) throw e2;
      onDone();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const join = async () => {
    setBusy(true);
    setErr(null);
    try {
      const {
        data: hh,
        error
      } = await db.from("households").select("id").eq("invite_code", code.trim().toLowerCase()).maybeSingle();
      if (error) throw error;
      if (!hh) throw new Error("No household found with that code.");
      const {
        error: e2
      } = await db.from("profiles").update({
        household_id: hh.id,
        slot
      }).eq("id", user.id);
      if (e2) throw e2;
      onDone();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    style: S.authWrap
  }, /*#__PURE__*/React.createElement("div", {
    style: S.authCard
  }, /*#__PURE__*/React.createElement("div", {
    style: S.brandBig
  }, /*#__PURE__*/React.createElement("span", {
    style: S.brandMark
  }), " Set up"), /*#__PURE__*/React.createElement("p", {
    style: {
      color: "var(--muted)",
      fontSize: 14,
      marginTop: 0
    }
  }, "One of you creates the household, the other joins with the invite code."), /*#__PURE__*/React.createElement("div", {
    style: S.segWide
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(tab === "create" ? S.segOn : {})
    },
    onClick: () => setTab("create")
  }, "Create"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(tab === "join" ? S.segOn : {})
    },
    onClick: () => setTab("join")
  }, "Join")), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, "You are"), /*#__PURE__*/React.createElement("div", {
    style: S.segWide
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(slot === 0 ? S.segOnA : {})
    },
    onClick: () => setSlot(0)
  }, "Willem-Jan"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(slot === 1 ? S.segOnB : {})
    },
    onClick: () => setSlot(1)
  }, "Steffania")), tab === "create" ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, "Household name"), /*#__PURE__*/React.createElement("input", {
    style: S.input,
    value: hhName,
    onChange: e => setHhName(e.target.value)
  }), err && /*#__PURE__*/React.createElement("div", {
    style: S.errBox
  }, err), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      opacity: busy ? 0.6 : 1
    },
    disabled: busy,
    onClick: create
  }, busy ? "Creating…" : "Create household")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, "Invite code"), /*#__PURE__*/React.createElement("input", {
    style: S.input,
    value: code,
    onChange: e => setCode(e.target.value),
    placeholder: "e.g. a1b2c3d4"
  }), err && /*#__PURE__*/React.createElement("div", {
    style: S.errBox
  }, err), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      opacity: busy ? 0.6 : 1
    },
    disabled: busy,
    onClick: join
  }, busy ? "Joining…" : "Join household"))));
}

// ============================================================
//  DASHBOARD
// ============================================================
function Dashboard({
  user,
  profile,
  reloadProfile
}) {
  const [household, setHousehold] = useState(null);
  const [expenses, setExpenses] = useState([]);
  const [budgets, setBudgets] = useState({});
  const [members, setMembers] = useState([]);
  const [tab, setTab] = useState("overview");
  const [displayCur, setDisplayCur] = useState("COP");
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return {
      y: d.getFullYear(),
      m: d.getMonth()
    };
  });
  const [toast, setToast] = useState(null);
  const [ratesLoading, setRatesLoading] = useState(false);
  const hhId = profile.household_id;
  const showToast = m => {
    setToast(m);
    setTimeout(() => setToast(null), 2400);
  };
  const rates = household ? {
    usdPerEur: Number(household.usd_per_eur),
    copPerEur: Number(household.cop_per_eur),
    updatedAt: household.rates_updated_at
  } : {
    usdPerEur: 1.08,
    copPerEur: 4600,
    updatedAt: null
  };

  // people names from members (slot 0 / slot 1), fallback defaults
  const people = ["Willem-Jan", "Steffania"];
  members.forEach(m => {
    if (m.slot === 0 || m.slot === 1) people[m.slot] = m.display_name;
  });
  const loadAll = useCallback(async () => {
    const [{
      data: hh
    }, {
      data: exp
    }, {
      data: bud
    }, {
      data: mem
    }] = await Promise.all([db.from("households").select("*").eq("id", hhId).single(), db.from("expenses").select("*").eq("household_id", hhId).order("spent_on", {
      ascending: false
    }), db.from("budgets").select("*").eq("household_id", hhId), db.from("profiles").select("display_name, slot").eq("household_id", hhId)]);
    if (hh) setHousehold(hh);
    if (exp) setExpenses(exp);
    if (bud) {
      const b = {};
      bud.forEach(r => b[r.category] = Number(r.monthly_eur));
      setBudgets(b);
    }
    if (mem) setMembers(mem);
  }, [hhId]);
  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // realtime subscriptions
  useEffect(() => {
    const ch = db.channel("hh-" + hhId).on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "expenses",
      filter: `household_id=eq.${hhId}`
    }, loadAll).on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "budgets",
      filter: `household_id=eq.${hhId}`
    }, loadAll).on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "households",
      filter: `id=eq.${hhId}`
    }, loadAll).subscribe();
    return () => db.removeChannel(ch);
  }, [hhId, loadAll]);

  // auto-refresh rates on open if stale
  useEffect(() => {
    if (household && ratesAreStale(rates) && RATES_ENABLED) updateRates(true);
  }, [household]);
  const disp = eur => fmt(fromEUR(eur, displayCur, rates), displayCur);
  const monthExpenses = expenses.filter(e => {
    const [y, m] = e.spent_on.split("-").map(Number);
    return y === month.y && m - 1 === month.m;
  });
  async function updateRates(silent) {
    setRatesLoading(true);
    try {
      const r = await fetchLiveRates();
      await db.from("households").update({
        usd_per_eur: r.usdPerEur,
        cop_per_eur: r.copPerEur,
        rates_updated_at: r.updatedAt
      }).eq("id", hhId);
      if (!silent) showToast(`Rates updated: $${r.usdPerEur.toFixed(2)} · COP ${Math.round(r.copPerEur).toLocaleString("en-US")}`);
    } catch (e) {
      if (!silent) showToast("Couldn't fetch live rates — using last known");
    } finally {
      setRatesLoading(false);
    }
  }
  const addExpense = async exp => {
    const {
      error
    } = await db.from("expenses").insert({
      household_id: hhId,
      amount_orig: exp.amountOrig,
      currency: exp.currency,
      amount_eur: exp.amountEUR,
      rate_used: exp.rateUsed,
      kind: exp.kind,
      payer: exp.payer,
      category: exp.category,
      note: exp.note,
      spent_on: exp.date,
      created_by: user.id
    });
    if (error) {
      showToast("Save failed: " + error.message);
      return;
    }
    showToast("Expense saved");
    setTab("overview");
    loadAll();
  };
  const deleteExpense = async id => {
    await db.from("expenses").delete().eq("id", id);
    loadAll();
  };
  const saveBudgets = async b => {
    await db.from("budgets").delete().eq("household_id", hhId);
    const rows = Object.entries(b).map(([category, monthly_eur]) => ({
      household_id: hhId,
      category,
      monthly_eur
    }));
    if (rows.length) await db.from("budgets").insert(rows);
    showToast("Budgets saved");
    loadAll();
  };
  const saveMyName = async nm => {
    await db.from("profiles").update({
      display_name: nm
    }).eq("id", user.id);
    showToast("Name saved");
    loadAll();
  };
  const saveRates = async r => {
    await db.from("households").update({
      usd_per_eur: r.usdPerEur,
      cop_per_eur: r.copPerEur,
      rates_updated_at: new Date().toISOString()
    }).eq("id", hhId);
    showToast("Rates saved");
    loadAll();
  };
  const saveSource = async src => {
    await db.from("households").update({
      rate_source: src
    }).eq("id", hhId);
    showToast("Rate source saved");
    loadAll();
  };
  if (!household) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 60,
      textAlign: "center",
      color: "var(--muted)"
    }
  }, "Loading household…");
  return /*#__PURE__*/React.createElement("div", {
    style: S.appRoot
  }, /*#__PURE__*/React.createElement("header", {
    style: S.topbar
  }, /*#__PURE__*/React.createElement("div", {
    style: S.brand
  }, /*#__PURE__*/React.createElement("span", {
    style: S.brandMark
  }), " Our", /*#__PURE__*/React.createElement("b", {
    style: {
      color: "var(--green)"
    }
  }, "Spending")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: S.curSwitch
  }, CURRENCIES.map(c => /*#__PURE__*/React.createElement("button", {
    key: c,
    style: {
      ...S.curBtn,
      ...(displayCur === c ? S.curOn : {})
    },
    onClick: () => setDisplayCur(c)
  }, c === "COP" ? "COP" : SYMBOL[c]))), /*#__PURE__*/React.createElement("button", {
    style: S.iconBtn,
    onClick: loadAll,
    title: "Refresh"
  }, "⟳"))), /*#__PURE__*/React.createElement("div", {
    style: S.ratesLine
  }, /*#__PURE__*/React.createElement("span", null, "1€ = $", rates.usdPerEur.toFixed(2), " · COP ", Math.round(rates.copPerEur).toLocaleString("en-US"), /*#__PURE__*/React.createElement("span", {
    style: {
      opacity: 0.8
    }
  }, " · ", ratesLoading ? "updating…" : timeAgo(rates.updatedAt))), /*#__PURE__*/React.createElement("button", {
    style: S.linkBtn,
    onClick: () => updateRates(false),
    disabled: ratesLoading
  }, ratesLoading ? "…" : "Update rates")), /*#__PURE__*/React.createElement("main", {
    style: {
      padding: "4px 16px 16px"
    }
  }, tab === "overview" && /*#__PURE__*/React.createElement(Overview, {
    people: people,
    month: month,
    setMonth: setMonth,
    monthExpenses: monthExpenses,
    disp: disp,
    displayCur: displayCur,
    onDelete: deleteExpense
  }), tab === "add" && /*#__PURE__*/React.createElement(AddExpense, {
    people: people,
    rates: rates,
    saving: false,
    onAdd: addExpense,
    ratesLoading: ratesLoading,
    onUpdateRates: () => updateRates(false)
  }), tab === "budgets" && /*#__PURE__*/React.createElement(Budgets, {
    people: people,
    profile: profile,
    household: household,
    month: month,
    monthExpenses: monthExpenses,
    budgets: budgets,
    rates: rates,
    disp: disp,
    displayCur: displayCur,
    onSaveBudgets: saveBudgets,
    onSaveName: saveMyName,
    onSaveRates: saveRates,
    onSaveSource: saveSource,
    onSignOut: () => db.auth.signOut()
  })), toast && /*#__PURE__*/React.createElement("div", {
    style: S.toast
  }, toast), /*#__PURE__*/React.createElement("nav", {
    style: S.tabbar
  }, /*#__PURE__*/React.createElement(TabBtn, {
    active: tab === "overview",
    onClick: () => setTab("overview"),
    icon: "📒",
    label: "Overview"
  }), /*#__PURE__*/React.createElement(TabBtn, {
    active: tab === "add",
    onClick: () => setTab("add"),
    icon: "＋",
    label: "Add",
    big: true
  }), /*#__PURE__*/React.createElement(TabBtn, {
    active: tab === "budgets",
    onClick: () => setTab("budgets"),
    icon: "🎯",
    label: "Budgets"
  })));
}
function TabBtn({
  active,
  onClick,
  icon,
  label,
  big
}) {
  return /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.tabBtn,
      ...(active ? S.tabActive : {})
    },
    onClick: onClick
  }, /*#__PURE__*/React.createElement("span", {
    style: big ? S.tabIconBig : S.tabIcon
  }, icon), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11
    }
  }, label));
}
const kindLabel = (e, people) => e.kind === "shared" ? "Shared" : e.kind === "p0" ? `Private · ${people[0]}` : `Private · ${people[1]}`;
const kindDot = e => e.kind === "shared" ? "var(--green)" : e.kind === "p0" ? "var(--blue)" : "var(--ochre)";

// ---------- Overview ----------
function Overview({
  people,
  month,
  setMonth,
  monthExpenses,
  onDelete,
  disp,
  displayCur
}) {
  const [fKind, setFKind] = useState(null);
  const [fCat, setFCat] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const shift = d => {
    let m = month.m + d,
      y = month.y;
    if (m < 0) {
      m = 11;
      y--;
    }
    if (m > 11) {
      m = 0;
      y++;
    }
    setMonth({
      y,
      m
    });
  };
  const total = monthExpenses.reduce((s, e) => s + Number(e.amount_eur), 0);
  const sharedExp = monthExpenses.filter(e => e.kind === "shared");
  const sharedTotal = sharedExp.reduce((s, e) => s + Number(e.amount_eur), 0);
  const sharedPaid = [0, 1].map(p => sharedExp.filter(e => e.payer === p).reduce((s, e) => s + Number(e.amount_eur), 0));
  const priv = ["p0", "p1"].map(k => monthExpenses.filter(e => e.kind === k).reduce((s, e) => s + Number(e.amount_eur), 0));
  const pct = v => total > 0 ? v / total * 100 : 0;
  let visible = monthExpenses;
  if (fKind) visible = visible.filter(e => e.kind === fKind);
  if (fCat) visible = visible.filter(e => e.category === fCat);
  const groups = {};
  visible.forEach(e => {
    (groups[e.spent_on] = groups[e.spent_on] || []).push(e);
  });
  const dates = Object.keys(groups).sort().reverse();
  const usedCats = [...new Set(monthExpenses.map(e => e.category))];
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: S.monthNav
  }, /*#__PURE__*/React.createElement("button", {
    style: S.iconBtn,
    onClick: () => shift(-1)
  }, "‹"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600,
      fontSize: 16
    }
  }, MONTH_NAMES[month.m], " ", month.y), /*#__PURE__*/React.createElement("button", {
    style: S.iconBtn,
    onClick: () => shift(1)
  }, "›")), /*#__PURE__*/React.createElement("div", {
    style: S.hero
  }, /*#__PURE__*/React.createElement("div", {
    style: S.heroLabel
  }, "Total this month · ", displayCur), /*#__PURE__*/React.createElement("div", {
    style: S.heroAmount
  }, disp(total)), /*#__PURE__*/React.createElement("div", {
    style: S.splitBar
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: "100%",
      background: "var(--green)",
      width: pct(sharedTotal) + "%"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: "100%",
      background: "var(--blue)",
      width: pct(priv[0]) + "%"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: "100%",
      background: "var(--ochre)",
      width: pct(priv[1]) + "%"
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: S.splitLegend
  }, /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("i", {
    style: {
      ...S.dot,
      background: "var(--green)"
    }
  }), "Shared ", disp(sharedTotal)), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("i", {
    style: {
      ...S.dot,
      background: "var(--blue)"
    }
  }), people[0], " ", disp(priv[0])), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("i", {
    style: {
      ...S.dot,
      background: "var(--ochre)"
    }
  }), people[1], " ", disp(priv[1]))), sharedTotal > 0 && /*#__PURE__*/React.createElement("div", {
    style: S.sharedPaid
  }, "Shared paid by: ", people[0], " ", disp(sharedPaid[0]), " · ", people[1], " ", disp(sharedPaid[1]))), /*#__PURE__*/React.createElement("div", {
    style: S.chipRow
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.chip,
      ...(!fKind ? S.chipOn : {})
    },
    onClick: () => setFKind(null)
  }, "All"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.chip,
      ...(fKind === "shared" ? S.chipOn : {})
    },
    onClick: () => setFKind(fKind === "shared" ? null : "shared")
  }, "Shared"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.chip,
      ...(fKind === "p0" ? S.chipOn : {})
    },
    onClick: () => setFKind(fKind === "p0" ? null : "p0")
  }, people[0]), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.chip,
      ...(fKind === "p1" ? S.chipOn : {})
    },
    onClick: () => setFKind(fKind === "p1" ? null : "p1")
  }, people[1])), usedCats.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: S.chipRow
  }, usedCats.map(c => /*#__PURE__*/React.createElement("button", {
    key: c,
    style: {
      ...S.chip,
      ...(fCat === c ? S.chipOn : {})
    },
    onClick: () => setFCat(fCat === c ? null : c)
  }, catById(c).icon, " ", catById(c).label))), dates.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: S.empty
  }, "No expenses in ", MONTH_NAMES[month.m], " yet.", /*#__PURE__*/React.createElement("br", null), "Add the first one via ", /*#__PURE__*/React.createElement("b", null, "＋ Add"), "."), dates.map(date => {
    const [y, m, d] = date.split("-").map(Number);
    return /*#__PURE__*/React.createElement("div", {
      key: date,
      style: {
        marginBottom: 6
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: S.dayLabel
    }, MONTH_NAMES[m - 1], " ", d), groups[date].map(e => /*#__PURE__*/React.createElement("div", {
      key: e.id,
      style: S.expRow
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 20
      }
    }, catById(e.category).icon), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: S.expTitle
    }, catById(e.category).label, e.note ? ` — ${e.note}` : ""), /*#__PURE__*/React.createElement("div", {
      style: S.expSub
    }, /*#__PURE__*/React.createElement("i", {
      style: {
        ...S.dot,
        background: kindDot(e)
      }
    }), kindLabel(e, people), e.kind === "shared" && ` · paid by ${people[e.payer]}`)), /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "right"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: S.expAmount
    }, disp(Number(e.amount_eur))), e.currency !== displayCur && /*#__PURE__*/React.createElement("div", {
      style: S.origTag
    }, fmt(Number(e.amount_orig), e.currency)), confirmId === e.id ? /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 4,
        marginTop: 4
      }
    }, /*#__PURE__*/React.createElement("button", {
      style: {
        ...S.miniBtn,
        ...S.miniDanger
      },
      onClick: () => {
        onDelete(e.id);
        setConfirmId(null);
      }
    }, "Delete"), /*#__PURE__*/React.createElement("button", {
      style: S.miniBtn,
      onClick: () => setConfirmId(null)
    }, "No")) : /*#__PURE__*/React.createElement("button", {
      style: S.delBtn,
      onClick: () => setConfirmId(e.id)
    }, "×")))));
  }));
}

// ---------- Add expense ----------
function AddExpense({
  people,
  rates,
  onAdd,
  saving,
  ratesLoading,
  onUpdateRates
}) {
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("COP");
  const [kind, setKind] = useState("shared");
  const [payer, setPayer] = useState(0);
  const [category, setCategory] = useState("groceries");
  const [date, setDate] = useState(todayStr());
  const [note, setNote] = useState("");
  const [err, setErr] = useState(null);
  const pa = parseFloat(String(amount).replace(",", "."));
  const eur = pa > 0 ? toEUR(pa, currency, rates) : NaN;
  const submit = () => {
    if (!pa || pa <= 0) return setErr("Enter a valid amount.");
    setErr(null);
    const finalPayer = kind === "shared" ? payer : kind === "p0" ? 0 : 1;
    onAdd({
      amountOrig: pa,
      currency,
      amountEUR: Math.round(eur * 100) / 100,
      rateUsed: perEur(currency, rates),
      kind,
      payer: finalPayer,
      category,
      date,
      note: note.trim()
    });
    setAmount("");
    setNote("");
  };
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    style: S.pageTitle
  }, "New expense"), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, "Amount"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("input", {
    style: S.amountInput,
    inputMode: "decimal",
    placeholder: "0.00",
    value: amount,
    onChange: e => setAmount(e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    style: S.seg
  }, CURRENCIES.map(c => /*#__PURE__*/React.createElement("button", {
    key: c,
    style: {
      ...S.segBtn,
      ...(currency === c ? S.segOn : {})
    },
    onClick: () => setCurrency(c)
  }, c === "COP" ? "COP" : SYMBOL[c])))), pa > 0 && /*#__PURE__*/React.createElement("div", {
    style: S.convertHint
  }, currency !== "EUR" && /*#__PURE__*/React.createElement("span", null, fmt(eur, "EUR")), currency !== "USD" && /*#__PURE__*/React.createElement("span", null, fmt(fromEUR(eur, "USD", rates), "USD")), currency !== "COP" && /*#__PURE__*/React.createElement("span", null, fmt(fromEUR(eur, "COP", rates), "COP")), /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 400,
      color: "var(--muted)"
    }
  }, "rate ", ratesLoading ? "updating…" : timeAgo(rates.updatedAt))), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, "Type"), /*#__PURE__*/React.createElement("div", {
    style: S.segWide
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(kind === "shared" ? S.segOn : {})
    },
    onClick: () => setKind("shared")
  }, "Shared"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(kind === "p0" ? S.segOnA : {})
    },
    onClick: () => setKind("p0")
  }, people[0]), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(kind === "p1" ? S.segOnB : {})
    },
    onClick: () => setKind("p1")
  }, people[1])), /*#__PURE__*/React.createElement("div", {
    style: S.typeHint
  }, kind === "shared" ? "A joint expense — select who paid below." : `Personal expense of ${kind === "p0" ? people[0] : people[1]}.`), kind === "shared" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, "Paid by"), /*#__PURE__*/React.createElement("div", {
    style: S.segWide
  }, people.map((p, i) => /*#__PURE__*/React.createElement("button", {
    key: i,
    style: {
      ...S.segBtn,
      ...(payer === i ? i === 0 ? S.segOnA : S.segOnB : {})
    },
    onClick: () => setPayer(i)
  }, p)))), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, "Category"), /*#__PURE__*/React.createElement("div", {
    style: S.catGrid
  }, CATEGORIES.map(c => /*#__PURE__*/React.createElement("button", {
    key: c.id,
    style: {
      ...S.catBtn,
      ...(category === c.id ? S.catOn : {})
    },
    onClick: () => setCategory(c.id)
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 18
    }
  }, c.icon), /*#__PURE__*/React.createElement("span", null, c.label)))), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, "Date"), /*#__PURE__*/React.createElement("input", {
    type: "date",
    style: S.input,
    value: date,
    onChange: e => setDate(e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, "Note (optional)"), /*#__PURE__*/React.createElement("input", {
    style: S.input,
    placeholder: "e.g. market, fuel, gift…",
    value: note,
    maxLength: 60,
    onChange: e => setNote(e.target.value)
  }), err && /*#__PURE__*/React.createElement("div", {
    style: S.errBox
  }, err), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      opacity: saving ? 0.6 : 1
    },
    disabled: saving,
    onClick: submit
  }, saving ? "Saving…" : "Save expense"));
}

// ---------- Budgets & settings ----------
function Budgets({
  people,
  profile,
  household,
  month,
  monthExpenses,
  budgets,
  rates,
  disp,
  displayCur,
  onSaveBudgets,
  onSaveName,
  onSaveRates,
  onSaveSource,
  onSignOut
}) {
  const [draft, setDraft] = useState(() => {
    const d = {};
    CATEGORIES.forEach(c => d[c.id] = budgets[c.id] != null ? String(budgets[c.id]) : "");
    return d;
  });
  const [editing, setEditing] = useState(false);
  const [myName, setMyName] = useState(profile.display_name);
  const [editName, setEditName] = useState(false);
  const [rateDraft, setRateDraft] = useState({
    usd: String(rates.usdPerEur),
    cop: String(rates.copPerEur)
  });
  const [editRates, setEditRates] = useState(false);
  const [sourceDraft, setSourceDraft] = useState(household.rate_source || "wise.com");
  const [editSource, setEditSource] = useState(false);
  const spentByCat = {};
  monthExpenses.forEach(e => {
    spentByCat[e.category] = (spentByCat[e.category] || 0) + Number(e.amount_eur);
  });
  const totalBudget = Object.values(budgets).reduce((s, v) => s + v, 0);
  const totalSpent = monthExpenses.reduce((s, e) => s + Number(e.amount_eur), 0);
  const save = () => {
    const b = {};
    CATEGORIES.forEach(c => {
      const v = parseFloat(String(draft[c.id]).replace(",", "."));
      if (v > 0) b[c.id] = v;
    });
    onSaveBudgets(b);
    setEditing(false);
  };
  const saveR = () => {
    const usd = parseFloat(String(rateDraft.usd).replace(",", "."));
    const cop = parseFloat(String(rateDraft.cop).replace(",", "."));
    if (!(usd > 0) || !(cop > 0)) return;
    onSaveRates({
      usdPerEur: usd,
      copPerEur: cop
    });
    setEditRates(false);
  };
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    style: S.pageTitle
  }, "Budgets — ", MONTH_NAMES[month.m]), /*#__PURE__*/React.createElement("div", {
    style: S.budgetNote
  }, "Budgets are set in EUR and count all expenses. Shown in ", displayCur, "."), totalBudget > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      ...S.hero,
      padding: "14px 16px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: S.heroLabel
  }, "Total"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "baseline",
      gap: 6,
      margin: "2px 0 10px"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 24,
      fontWeight: 800
    }
  }, disp(totalSpent)), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)"
    }
  }, "of ", disp(totalBudget))), /*#__PURE__*/React.createElement(Bar, {
    spent: totalSpent,
    budget: totalBudget
  })), CATEGORIES.map(c => {
    const b = budgets[c.id];
    const sp = spentByCat[c.id] || 0;
    return /*#__PURE__*/React.createElement("div", {
      key: c.id,
      style: S.budgetRow
    }, /*#__PURE__*/React.createElement("div", {
      style: S.budgetHead
    }, /*#__PURE__*/React.createElement("span", null, c.icon, " ", c.label), editing ? /*#__PURE__*/React.createElement("span", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 4,
        color: "var(--muted)"
      }
    }, "€ ", /*#__PURE__*/React.createElement("input", {
      style: S.budgetInput,
      inputMode: "decimal",
      placeholder: "—",
      value: draft[c.id],
      onChange: e => setDraft({
        ...draft,
        [c.id]: e.target.value
      })
    })) : /*#__PURE__*/React.createElement("span", null, disp(sp), b ? /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)",
        fontWeight: 400
      }
    }, " / ", disp(b)) : null)), b > 0 && !editing && /*#__PURE__*/React.createElement(Bar, {
      spent: sp,
      budget: b
    }));
  }), editing ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      flex: 1,
      width: "auto"
    },
    onClick: save
  }, "Save"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      flex: 1,
      width: "auto"
    },
    onClick: () => setEditing(false)
  }, "Cancel")) : /*#__PURE__*/React.createElement("button", {
    style: S.ghostBtn,
    onClick: () => setEditing(true)
  }, "Edit budgets (in EUR)"), /*#__PURE__*/React.createElement("h2", {
    style: {
      ...S.pageTitle,
      marginTop: 28
    }
  }, "Settings"), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, "Your name"), editName ? /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("input", {
    style: S.input,
    value: myName,
    maxLength: 16,
    onChange: e => setMyName(e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      flex: 1,
      width: "auto"
    },
    onClick: () => {
      onSaveName(myName.trim() || "Me");
      setEditName(false);
    }
  }, "Save"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      flex: 1,
      width: "auto"
    },
    onClick: () => {
      setMyName(profile.display_name);
      setEditName(false);
    }
  }, "Cancel"))) : /*#__PURE__*/React.createElement("div", {
    style: S.namesRow
  }, /*#__PURE__*/React.createElement("span", null, "You are shown as ", /*#__PURE__*/React.createElement("b", null, profile.display_name)), /*#__PURE__*/React.createElement("button", {
    style: S.miniBtn,
    onClick: () => setEditName(true)
  }, "Edit")), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, "Invite code (share with your partner)"), /*#__PURE__*/React.createElement("div", {
    style: S.namesRow
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "monospace",
      fontSize: 16,
      letterSpacing: 1
    }
  }, household.invite_code), /*#__PURE__*/React.createElement("button", {
    style: S.miniBtn,
    onClick: () => {
      navigator.clipboard && navigator.clipboard.writeText(household.invite_code);
    }
  }, "Copy")), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, "Exchange rates (manual override)"), editRates ? /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: S.rateEditRow
  }, /*#__PURE__*/React.createElement("span", null, "1 € = $"), /*#__PURE__*/React.createElement("input", {
    style: {
      ...S.input,
      width: 120
    },
    inputMode: "decimal",
    value: rateDraft.usd,
    onChange: e => setRateDraft({
      ...rateDraft,
      usd: e.target.value
    })
  })), /*#__PURE__*/React.createElement("div", {
    style: S.rateEditRow
  }, /*#__PURE__*/React.createElement("span", null, "1 € = COP"), /*#__PURE__*/React.createElement("input", {
    style: {
      ...S.input,
      width: 120
    },
    inputMode: "decimal",
    value: rateDraft.cop,
    onChange: e => setRateDraft({
      ...rateDraft,
      cop: e.target.value
    })
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      flex: 1,
      width: "auto"
    },
    onClick: saveR
  }, "Save"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      flex: 1,
      width: "auto"
    },
    onClick: () => setEditRates(false)
  }, "Cancel"))) : /*#__PURE__*/React.createElement("div", {
    style: S.namesRow
  }, /*#__PURE__*/React.createElement("span", null, "1€ = $", rates.usdPerEur.toFixed(2), " · COP ", Math.round(rates.copPerEur).toLocaleString("en-US")), /*#__PURE__*/React.createElement("button", {
    style: S.miniBtn,
    onClick: () => {
      setRateDraft({
        usd: String(rates.usdPerEur),
        cop: String(rates.copPerEur)
      });
      setEditRates(true);
    }
  }, "Edit")), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, "Rate source"), editSource ? /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("input", {
    style: S.input,
    value: sourceDraft,
    maxLength: 40,
    onChange: e => setSourceDraft(e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      marginTop: 8,
      flexWrap: "wrap"
    }
  }, ["wise.com", "xe.com", "banrep.gov.co"].map(s => /*#__PURE__*/React.createElement("button", {
    key: s,
    style: S.miniBtn,
    onClick: () => setSourceDraft(s)
  }, s))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      flex: 1,
      width: "auto"
    },
    onClick: () => {
      onSaveSource(sourceDraft.trim() || "wise.com");
      setEditSource(false);
    }
  }, "Save"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      flex: 1,
      width: "auto"
    },
    onClick: () => setEditSource(false)
  }, "Cancel"))) : /*#__PURE__*/React.createElement("div", {
    style: S.namesRow
  }, /*#__PURE__*/React.createElement("span", null, "🌐 ", household.rate_source || "wise.com"), /*#__PURE__*/React.createElement("button", {
    style: S.miniBtn,
    onClick: () => {
      setSourceDraft(household.rate_source || "wise.com");
      setEditSource(true);
    }
  }, "Edit")), /*#__PURE__*/React.createElement("div", {
    style: S.privacyNote
  }, "Each expense locks in the rate at the moment you save it, so past totals never shift. Everyone in your household sees the same data in real time."), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      marginTop: 20,
      color: "var(--danger)",
      borderColor: "var(--danger)"
    },
    onClick: onSignOut
  }, "Sign out"));
}
function Bar({
  spent,
  budget
}) {
  const pct = budget > 0 ? Math.min(spent / budget * 100, 100) : 0;
  const color = spent > budget ? "var(--danger)" : spent >= budget * 0.8 ? "var(--warn)" : "var(--green)";
  return /*#__PURE__*/React.createElement("div", {
    style: S.barTrack
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: "100%",
      borderRadius: 6,
      width: pct + "%",
      background: color,
      transition: "width .4s"
    }
  }));
}

// ============================================================
//  STYLES
// ============================================================
const S = {
  appRoot: {
    minHeight: "100vh",
    background: "var(--bg)",
    color: "var(--ink)",
    maxWidth: 480,
    margin: "0 auto",
    paddingBottom: 84
  },
  authWrap: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 24,
    padding: 16
  },
  authCard: {
    background: "var(--card)",
    border: "1px solid var(--line)",
    borderTop: "3px solid var(--green)",
    borderRadius: 18,
    padding: 24,
    width: "100%",
    maxWidth: 400
  },
  brandBig: {
    fontSize: 22,
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontWeight: 700
  },
  brand: {
    fontSize: 17,
    display: "flex",
    alignItems: "center",
    gap: 8
  },
  brandMark: {
    width: 12,
    height: 12,
    borderRadius: "3px 12px 3px 12px",
    background: "var(--green)",
    display: "inline-block"
  },
  topbar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 16px 6px"
  },
  iconBtn: {
    border: "1px solid var(--line)",
    background: "var(--card)",
    color: "var(--ink)",
    width: 34,
    height: 34,
    borderRadius: 10,
    fontSize: 17,
    cursor: "pointer"
  },
  curSwitch: {
    display: "flex",
    border: "1px solid var(--line)",
    borderRadius: 10,
    overflow: "hidden",
    background: "var(--card)"
  },
  curBtn: {
    border: "none",
    background: "none",
    padding: "8px 10px",
    fontSize: 13,
    fontWeight: 700,
    color: "var(--muted)",
    cursor: "pointer"
  },
  curOn: {
    background: "var(--green)",
    color: "#fff"
  },
  ratesLine: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0 16px 6px",
    fontSize: 12,
    color: "var(--muted)"
  },
  linkBtn: {
    border: "none",
    background: "none",
    color: "var(--green)",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    textDecoration: "underline"
  },
  pageTitle: {
    fontSize: 20,
    fontWeight: 700,
    margin: "10px 0 14px"
  },
  monthNav: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    margin: "4px 0 12px"
  },
  hero: {
    background: "var(--card)",
    border: "1px solid var(--line)",
    borderTop: "3px solid var(--green)",
    borderRadius: 16,
    padding: 16,
    marginBottom: 14
  },
  heroLabel: {
    fontSize: 12,
    color: "var(--muted)",
    textTransform: "uppercase",
    letterSpacing: 0.6
  },
  heroAmount: {
    fontSize: 32,
    fontWeight: 800,
    letterSpacing: -1,
    margin: "2px 0 12px"
  },
  splitBar: {
    height: 8,
    borderRadius: 6,
    background: "var(--line)",
    overflow: "hidden",
    display: "flex"
  },
  splitLegend: {
    display: "flex",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: "4px 10px",
    fontSize: 12,
    color: "var(--muted)",
    marginTop: 8
  },
  sharedPaid: {
    fontSize: 12,
    color: "var(--muted)",
    marginTop: 8,
    borderTop: "1px dashed var(--line)",
    paddingTop: 8
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    display: "inline-block",
    marginRight: 5
  },
  chipRow: {
    display: "flex",
    gap: 6,
    overflowX: "auto",
    paddingBottom: 8
  },
  chip: {
    border: "1px solid var(--line)",
    background: "var(--card)",
    color: "var(--ink)",
    borderRadius: 999,
    padding: "6px 12px",
    fontSize: 13,
    whiteSpace: "nowrap",
    cursor: "pointer"
  },
  chipOn: {
    background: "var(--green)",
    borderColor: "var(--green)",
    color: "#fff"
  },
  dayLabel: {
    fontSize: 12,
    color: "var(--muted)",
    margin: "12px 2px 6px"
  },
  expRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "var(--card)",
    border: "1px solid var(--line)",
    borderRadius: 14,
    padding: "10px 12px",
    marginBottom: 6
  },
  expTitle: {
    fontSize: 14,
    fontWeight: 600,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis"
  },
  expSub: {
    fontSize: 12,
    color: "var(--muted)",
    marginTop: 2
  },
  expAmount: {
    fontWeight: 700,
    fontSize: 14
  },
  origTag: {
    fontSize: 11,
    color: "var(--ochre)"
  },
  delBtn: {
    border: "none",
    background: "none",
    color: "var(--muted)",
    fontSize: 16,
    cursor: "pointer",
    padding: "2px 4px"
  },
  miniBtn: {
    border: "1px solid var(--line)",
    background: "var(--card)",
    borderRadius: 8,
    fontSize: 12,
    padding: "4px 8px",
    cursor: "pointer",
    color: "var(--ink)"
  },
  miniDanger: {
    background: "var(--danger)",
    borderColor: "var(--danger)",
    color: "#fff"
  },
  empty: {
    textAlign: "center",
    color: "var(--muted)",
    padding: "40px 16px",
    lineHeight: 1.6
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: 600,
    margin: "16px 0 6px"
  },
  input: {
    width: "100%",
    fontSize: 15,
    padding: "11px 12px",
    border: "1px solid var(--line)",
    borderRadius: 12,
    background: "var(--card)",
    color: "var(--ink)"
  },
  amountInput: {
    flex: 1,
    fontSize: 26,
    fontWeight: 700,
    padding: "10px 14px",
    border: "1px solid var(--line)",
    borderRadius: 12,
    background: "var(--card)",
    color: "var(--ink)",
    minWidth: 0,
    width: 100
  },
  seg: {
    display: "flex",
    border: "1px solid var(--line)",
    borderRadius: 12,
    overflow: "hidden",
    background: "var(--card)"
  },
  segWide: {
    display: "flex",
    border: "1px solid var(--line)",
    borderRadius: 12,
    overflow: "hidden",
    background: "var(--card)",
    width: "100%"
  },
  segBtn: {
    border: "none",
    background: "none",
    padding: "10px 8px",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--muted)",
    cursor: "pointer",
    flex: 1,
    whiteSpace: "nowrap"
  },
  segOn: {
    background: "var(--green)",
    color: "#fff"
  },
  segOnA: {
    background: "var(--blue)",
    color: "#fff"
  },
  segOnB: {
    background: "var(--ochre)",
    color: "#fff"
  },
  typeHint: {
    fontSize: 12,
    color: "var(--muted)",
    marginTop: 6
  },
  convertHint: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px 12px",
    marginTop: 8,
    fontSize: 13,
    fontWeight: 600,
    color: "var(--green)"
  },
  catGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: 6
  },
  catBtn: {
    border: "1px solid var(--line)",
    background: "var(--card)",
    borderRadius: 12,
    padding: "10px 4px",
    fontSize: 12,
    cursor: "pointer",
    color: "var(--ink)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4
  },
  catOn: {
    borderColor: "var(--green)",
    background: "#E9F2EC",
    fontWeight: 700
  },
  primaryBtn: {
    width: "100%",
    marginTop: 18,
    padding: 14,
    border: "none",
    borderRadius: 14,
    background: "var(--green-deep)",
    color: "#fff",
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer"
  },
  ghostBtn: {
    width: "100%",
    marginTop: 12,
    padding: 12,
    border: "1px solid var(--line)",
    borderRadius: 14,
    background: "var(--card)",
    color: "var(--ink)",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer"
  },
  budgetNote: {
    fontSize: 12,
    color: "var(--muted)",
    margin: "-6px 0 12px"
  },
  budgetRow: {
    background: "var(--card)",
    border: "1px solid var(--line)",
    borderRadius: 14,
    padding: "12px 14px",
    marginBottom: 8
  },
  budgetHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 14,
    fontWeight: 600
  },
  budgetInput: {
    width: 90,
    padding: "6px 8px",
    border: "1px solid var(--line)",
    borderRadius: 8,
    fontSize: 14,
    textAlign: "right",
    background: "var(--bg)",
    color: "var(--ink)"
  },
  barTrack: {
    height: 8,
    borderRadius: 6,
    background: "var(--bg)",
    marginTop: 10,
    overflow: "hidden"
  },
  namesRow: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    fontSize: 14,
    flexWrap: "wrap"
  },
  rateEditRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
    fontSize: 14,
    whiteSpace: "nowrap"
  },
  privacyNote: {
    fontSize: 12,
    color: "var(--muted)",
    marginTop: 18,
    lineHeight: 1.5
  },
  errBox: {
    color: "var(--danger)",
    fontSize: 13,
    marginTop: 12,
    background: "#FBEFE7",
    padding: "8px 10px",
    borderRadius: 10
  },
  okBox: {
    color: "var(--green)",
    fontSize: 13,
    marginTop: 12,
    background: "#E9F2EC",
    padding: "8px 10px",
    borderRadius: 10
  },
  toast: {
    position: "fixed",
    bottom: 92,
    left: "50%",
    transform: "translateX(-50%)",
    background: "var(--ink)",
    color: "#fff",
    padding: "10px 16px",
    borderRadius: 12,
    fontSize: 13,
    zIndex: 20,
    maxWidth: "92vw"
  },
  tabbar: {
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
    maxWidth: 480,
    margin: "0 auto",
    display: "flex",
    background: "var(--card)",
    borderTop: "1px solid var(--line)",
    padding: "6px 8px calc(8px + env(safe-area-inset-bottom))"
  },
  tabBtn: {
    flex: 1,
    border: "none",
    background: "none",
    cursor: "pointer",
    color: "var(--muted)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    padding: "6px 0",
    borderRadius: 12
  },
  tabActive: {
    color: "var(--green-deep)",
    fontWeight: 700
  },
  tabIcon: {
    fontSize: 20,
    lineHeight: 1
  },
  tabIconBig: {
    fontSize: 20,
    lineHeight: 1,
    background: "var(--green-deep)",
    color: "#fff",
    width: 34,
    height: 34,
    borderRadius: 12,
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  }
};
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));
})();
