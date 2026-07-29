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

// ---- i18n helpers (dictionaries live in i18n.js) ----
const t = (k, v) => window.I18N.t(k, v);
const monthName = m => window.I18N.months()[m];
const numLocale = () => window.I18N.lang === "es" ? "es-CO" : "en-US";
// Household-scoped registries. Populated by Dashboard once the household's
// configuration is loaded; until then the built-in defaults apply, which is
// exactly the pre-multi-household behaviour.
let CAT_REGISTRY = null;
const setCatRegistry = r => {
  CAT_REGISTRY = r;
};
// Resolves any category id, including custom and deactivated ones, so
// historical expenses always stay readable.
const builtinEntry = c => ({
  id: c.id,
  icon: c.icon,
  defaultIcon: c.icon,
  label: null,
  custom: false,
  active: true,
  rowId: null,
  overridden: false
});
const catEntry = id => {
  if (CAT_REGISTRY && CAT_REGISTRY.byId[id]) return CAT_REGISTRY.byId[id];
  const b = BUILTIN_CATEGORIES.find(c => c.id === id);
  return b ? builtinEntry(b) : null;
};
const catLabel = c => {
  const id = c && c.id ? c.id : c;
  const e = catEntry(id);
  if (!e) return String(id);
  // A household-specific name (rename or custom category) wins; built-ins
  // without an override fall back to the translated default.
  if (e.label) return e.label;
  return t("cat_" + id);
};
// Categories offered for new expenses: active ones only.
const activeCategories = () => CAT_REGISTRY ? CAT_REGISTRY.active : BUILTIN_CATEGORIES.map(builtinEntry);
// Budgets keep showing any category that still has a budget configured, even
// after it was deactivated, so nothing silently disappears.
const budgetCategories = budgets => {
  const list = activeCategories().slice();
  const seen = new Set(list.map(c => c.id));
  Object.keys(budgets || {}).forEach(id => {
    if (!seen.has(id)) {
      const e = catEntry(id);
      if (e) list.push(e);
    }
  });
  return list;
};
const isKnownCategory = id => !!catEntry(id);

// ============================================================
//  CONSTANTS
// ============================================================
const BUILTIN_CATEGORIES = [{
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

// ============================================================
//  CONFIGURABLE PERSON/SHARED COLORS
// ============================================================
// The app's original hardcoded defaults (same hues as the --blue/--ochre/
// --green CSS tokens) - kept as the fallback so an existing household sees
// NO visual change until it deliberately picks a color in Settings.
const DEFAULT_COLORS = {
  shared: "#1F6B4E",
  p0: "#33608D",
  p1: "#A6641C"
};
// A curated, readable-with-white-text palette for the Settings color picker
// - deliberately not a free-form input, so every choice stays legible
// (incl. in dark mode, where labels/badges still render white-on-color)
// and visually consistent with the rest of the app.
const COLOR_PALETTE = ["#33608D", "#1F6B4E", "#A6641C", "#0E7490", "#4338CA", "#8E4585", "#BE185D", "#B91C1C", "#C2410C", "#92400E", "#15803D", "#525252"];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
/** True only for a well-formed 6-digit hex color - anything else (null, "", "orange") is rejected rather than trusted. */
const isValidColor = v => typeof v === "string" && HEX_COLOR_RE.test(v);
/**
 * Resolves the three colors the app actually uses (shared, person 0, person
 * 1) from persisted household/member rows, falling back to the original
 * defaults for anything missing/invalid - existing households (or a
 * database that hasn't run the color-columns upgrade yet) render exactly as
 * before.
 */
function resolveColors(household, members) {
  const p0 = (members || []).find(m => m.slot === 0);
  const p1 = (members || []).find(m => m.slot === 1);
  return {
    shared: isValidColor(household && household.shared_color) ? household.shared_color : DEFAULT_COLORS.shared,
    p0: isValidColor(p0 && p0.color) ? p0.color : DEFAULT_COLORS.p0,
    p1: isValidColor(p1 && p1.color) ? p1.color : DEFAULT_COLORS.p1
  };
}
/** The single place that maps a "kind" ("shared"/"p0"/"p1" - the same tag expenses AND calendar events use) to its configured color, so a color chosen in Settings has one consistent meaning everywhere it's used. */
const colorForKind = (kind, colors) => kind === "p0" ? colors.p0 : kind === "p1" ? colors.p1 : colors.shared;
const perEur = (cur, r) => cur === "EUR" ? 1 : cur === "USD" ? r.usdPerEur : r.copPerEur;
const toEUR = (a, cur, r) => a / perEur(cur, r);
const fromEUR = (a, cur, r) => a * perEur(cur, r);
// Converted amounts always round UP: whole pesos for COP, whole cents for EUR/USD.
const ceilCur = (v, cur) => cur === "COP" ? Math.ceil(v) : Math.ceil(v * 100) / 100;
const fmt = (n, cur) => {
  const v = n || 0;
  if (cur === "COP") return "COP " + v.toLocaleString(numLocale(), {
    maximumFractionDigits: 0
  });
  return SYMBOL[cur] + " " + v.toLocaleString(numLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
};
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const catById = id => catEntry(id) || BUILTIN_CATEGORIES[BUILTIN_CATEGORIES.length - 1];
// Downscale a receipt photo to a small JPEG and return raw base64 (no data: prefix).
const resizeReceiptImage = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 1568;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]);
    };
    img.onerror = () => reject(new Error(t("photo_read_error")));
    img.src = reader.result;
  };
  reader.onerror = () => reject(new Error(t("file_read_error")));
  reader.readAsDataURL(file);
});
const withTimeout = (promise, ms, message) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
const timeAgo = iso => {
  if (!iso) return t("never");
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return t("just_now");
  if (mins < 60) return t("min_ago", {
    n: mins
  });
  const h = Math.floor(mins / 60);
  if (h < 24) return t("h_ago", {
    n: h
  });
  return t("d_ago", {
    n: Math.floor(h / 24)
  });
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
  }, t("loading"));
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
        if (!name.trim()) throw new Error(t("enter_your_name"));
        const {
          data,
          error
        } = await db.auth.signUp({
          email: email.trim(),
          password: pw,
          options: {
            data: {
              display_name: name.trim()
            }
          }
        });
        if (error) throw error;
        // Metadata is the source of truth; localStorage is a same-device fallback.
        try {
          localStorage.setItem("pending_name", name.trim());
        } catch (e2) {/* private mode */}
        if (!data.session) {
          setMsg(t("account_created"));
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
      setErr(e.message || t("something_wrong"));
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
  }, t("tagline")), /*#__PURE__*/React.createElement("div", {
    style: S.segWide
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(mode === "signin" ? S.segOn : {})
    },
    onClick: () => setMode("signin")
  }, t("sign_in")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(mode === "signup" ? S.segOn : {})
    },
    onClick: () => setMode("signup")
  }, t("sign_up"))), mode === "signup" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("your_name")), /*#__PURE__*/React.createElement("input", {
    style: S.input,
    value: name,
    onChange: e => setName(e.target.value),
    placeholder: t("name_ph")
  })), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("email")), /*#__PURE__*/React.createElement("input", {
    style: S.input,
    type: "email",
    value: email,
    onChange: e => setEmail(e.target.value),
    placeholder: "you@email.com"
  }), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("password")), /*#__PURE__*/React.createElement("input", {
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
  }, busy ? t("please_wait") : mode === "signin" ? t("sign_in") : t("create_account"))), /*#__PURE__*/React.createElement("img", {
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
      let stored = null;
      try {
        stored = localStorage.getItem("pending_name");
      } catch (e2) {/* private mode */}
      const meta = user.user_metadata || {};
      const pendingName = (meta.display_name || meta.full_name || meta.name || stored || (user.email ? user.email.split("@")[0] : "") || "").trim() || t("member_one");
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
      try {
        localStorage.removeItem("pending_name");
      } catch (e2) {/* private mode */}
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
  }, t("loading_profile"));
  if (err) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 40,
      color: "var(--danger)"
    }
  }, "Error: ", err, " ", /*#__PURE__*/React.createElement("button", {
    onClick: loadProfile
  }, t("retry")));
  if (!profile.household_id) return /*#__PURE__*/React.createElement(NoHousehold, {
    user: user,
    profile: profile,
    lang: window.I18N.lang,
    onSetLang: l => {
      window.I18N.set(l);
      loadProfile();
    },
    themeMode: window.THEME.mode,
    onSetTheme: m => {
      window.THEME.set(m);
      loadProfile();
    },
    onReload: loadProfile,
    onSignOut: () => db.auth.signOut()
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
// Maps the database guards raised by create_household / join_household onto
// translated messages, with a readable fallback for anything unexpected.
function householdError(e) {
  const raw = (e && (e.message || e.hint || "")) + "";
  if (raw.includes("already_in_household")) return t("err_already_household");
  if (raw.includes("invalid_code")) return t("no_household_code");
  if (raw.includes("household_full")) return t("err_household_full");
  if (raw.includes("not_authenticated")) return t("err_not_authenticated");
  if (raw.includes("Failed to fetch") || raw.includes("NetworkError")) return t("err_network");
  return raw || t("something_wrong");
}
function Onboard({
  user,
  profile,
  onDone,
  onSkip,
  embedded
}) {
  const [tab, setTab] = useState("create"); // create | join
  const [hhName, setHhName] = useState("Our household");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const {
        error
      } = await db.rpc("create_household", {
        p_name: hhName.trim()
      });
      if (error) throw error;
      onDone();
    } catch (e) {
      setErr(householdError(e));
    } finally {
      setBusy(false);
    }
  };
  const join = async () => {
    setBusy(true);
    setErr(null);
    try {
      const {
        error
      } = await db.rpc("join_household", {
        p_code: code.trim()
      });
      if (error) throw error;
      onDone();
    } catch (e) {
      setErr(householdError(e));
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
  }), " " + t("set_up")), /*#__PURE__*/React.createElement("p", {
    style: {
      color: "var(--muted)",
      fontSize: 14,
      marginTop: 0
    }
  }, t("onboard_hint")), /*#__PURE__*/React.createElement("div", {
    style: S.segWide
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(tab === "create" ? S.segOn : {})
    },
    onClick: () => setTab("create")
  }, t("create")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(tab === "join" ? S.segOn : {})
    },
    onClick: () => setTab("join")
  }, t("join"))), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("welcome_name", {
    name: profile && profile.display_name || ""
  })), tab === "create" ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("household_name")), /*#__PURE__*/React.createElement("input", {
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
  }, busy ? t("creating") : t("create_household"))) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("invite_code")), /*#__PURE__*/React.createElement("input", {
    style: S.input,
    value: code,
    onChange: e => setCode(e.target.value),
    placeholder: t("code_ph")
  }), err && /*#__PURE__*/React.createElement("div", {
    style: S.errBox
  }, err), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      opacity: busy ? 0.6 : 1
    },
    disabled: busy,
    onClick: join
  }, busy ? t("joining") : t("join_household"))), onSkip && /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      marginTop: 10
    },
    onClick: onSkip
  }, t("do_this_later"))));
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
  // Start in the user's saved preference so the UI never flashes EUR first.
  const [displayCur, setDisplayCur] = useState(() => CURRENCIES.includes(profile.preferred_currency) ? profile.preferred_currency : "EUR");
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return {
      y: d.getFullYear(),
      m: d.getMonth()
    };
  });
  const [rangeMode, setRangeMode] = useState(false);
  const [range, setRange] = useState(() => ({
    from: todayStr(),
    to: todayStr()
  }));
  const [editingExpense, setEditingExpense] = useState(null);
  const [lang, setLangState] = useState(window.I18N.lang);
  const changeLang = l => {
    window.I18N.set(l);
    setLangState(l);
  };
  const prefCurRef = useRef(profile.preferred_currency);
  useEffect(() => {
    if (profile.preferred_currency !== prefCurRef.current) {
      prefCurRef.current = profile.preferred_currency;
      if (CURRENCIES.includes(profile.preferred_currency)) setDisplayCur(profile.preferred_currency);
    }
  }, [profile.preferred_currency]);
  const [themeMode, setThemeModeState] = useState(window.THEME.mode);
  const changeTheme = m => {
    window.THEME.set(m);
    setThemeModeState(m);
  };
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

  // Member names come from the household's profiles, keyed by slot.
  // Identity is never inferred from a display name.
  const people = [t("member_one"), t("member_two")];
  members.forEach(m => {
    if ((m.slot === 0 || m.slot === 1) && m.display_name) people[m.slot] = m.display_name;
  });
  const [catRows, setCatRows] = useState([]);
  const loadCategories = useCallback(async () => {
    const {
      data,
      error
    } = await db.from("household_categories").select("*").eq("household_id", hhId).order("sort_order");
    // A missing table or an empty result both mean "all built-ins active",
    // which is the pre-migration behaviour.
    if (!error && data) setCatRows(data);
  }, [hhId]);
  useEffect(() => {
    loadCategories();
  }, [loadCategories]);
  const colors = resolveColors(household, members);
  const loadAll = useCallback(async () => {
    const [{
      data: hh
    }, {
      data: exp
    }, {
      data: bud
    }, {
      data: mem,
      error: memErr
    }] = await Promise.all([db.from("households").select("*").eq("id", hhId).single(), db.from("expenses").select("*").eq("household_id", hhId).order("spent_on", {
      ascending: false
    }), db.from("budgets").select("*").eq("household_id", hhId), db.from("profiles").select("id, display_name, slot, color").eq("household_id", hhId)]);
    if (hh) setHousehold(hh);
    if (exp) setExpenses(exp);
    if (bud) {
      const b = {};
      bud.forEach(r => b[r.category] = Number(r.monthly_eur));
      setBudgets(b);
    }
    if (mem) setMembers(mem);
    else if (memErr) showToast(t("load_failed") + memErr.message);
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
  // Publish the household's categories + colours to the module-level registries
  // so every component (including historical rows) resolves them consistently.
  const categories = (() => {
    const byId = {};
    const active = [];
    const all = [];
    const configured = {};
    catRows.forEach(r => configured[r.category_key] = r);
    BUILTIN_CATEGORIES.forEach(c => {
      const row = configured[c.id];
      // No row at all == the untouched default. A row exists only where this
      // household deviates: renamed, re-iconed or switched off.
      const entry = {
        id: c.id,
        icon: row && row.icon || c.icon,
        defaultIcon: c.icon,
        label: row && row.label || null,
        custom: false,
        active: row ? row.active : true,
        rowId: row ? row.id : null,
        overridden: !!(row && (row.label || row.icon))
      };
      byId[c.id] = entry;
      all.push(entry);
      if (entry.active) active.push(entry);
    });
    catRows.filter(r => r.is_custom).forEach(r => {
      const entry = {
        id: r.category_key,
        label: r.label,
        icon: r.icon || "🏷️",
        defaultIcon: r.icon || "🏷️",
        custom: true,
        active: r.active && !r.archived_at,
        rowId: r.id,
        overridden: true
      };
      byId[entry.id] = entry;
      all.push(entry);
      if (entry.active) active.push(entry);
    });
    return {
      byId,
      active,
      all,
      rows: catRows
    };
  })();
  setCatRegistry(categories);
  const disp = eur => fmt(ceilCur(fromEUR(eur, displayCur, rates), displayCur), displayCur);
  const monthExpenses = expenses.filter(e => {
    if (rangeMode) return e.spent_on >= range.from && e.spent_on <= range.to;
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
      if (!silent) showToast(`${t("rates_updated")}: $${r.usdPerEur.toFixed(2)} · COP ${Math.round(r.copPerEur).toLocaleString(numLocale())}`);
    } catch (e) {
      if (!silent) showToast(t("rates_fetch_failed"));
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
      showToast(t("save_failed") + error.message);
      return;
    }
    showToast(t("expense_saved"));
    setTab("overview");
    loadAll();
  };
  const updateExpense = async (id, exp) => {
    const {
      error
    } = await db.from("expenses").update({
      amount_orig: exp.amountOrig,
      currency: exp.currency,
      amount_eur: exp.amountEUR,
      rate_used: exp.rateUsed,
      kind: exp.kind,
      payer: exp.payer,
      category: exp.category,
      note: exp.note,
      spent_on: exp.date
    }).eq("id", id);
    if (error) {
      showToast(t("save_failed") + error.message);
      return;
    }
    showToast(t("expense_updated"));
    setEditingExpense(null);
    setTab("overview");
    loadAll();
  };
  const importExpenses = async (parsedRows, onProgress) => {
    const batchSize = 50;
    for (let i = 0; i < parsedRows.length; i += batchSize) {
      const batch = parsedRows.slice(i, i + batchSize).map(exp => {
        const eur = toEUR(exp.amount, exp.currency, rates);
        return {
          household_id: hhId,
          amount_orig: exp.amount,
          currency: exp.currency,
          amount_eur: Math.round(eur * 100) / 100,
          rate_used: perEur(exp.currency, rates),
          kind: exp.kind,
          payer: exp.payer,
          category: exp.category,
          note: exp.note,
          spent_on: exp.date,
          created_by: user.id
        };
      });
      const {
        error
      } = await db.from("expenses").insert(batch);
      if (error) throw new Error(t("rows_failed", {
        from: i + 1,
        to: i + batch.length
      }) + ": " + error.message);
      if (onProgress) onProgress(Math.min(i + batchSize, parsedRows.length), parsedRows.length);
    }
    showToast(t("expenses_imported", {
      n: parsedRows.length
    }));
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
    showToast(t("budgets_saved"));
    loadAll();
  };
  const saveRates = async r => {
    await db.from("households").update({
      usd_per_eur: r.usdPerEur,
      cop_per_eur: r.copPerEur,
      rates_updated_at: new Date().toISOString()
    }).eq("id", hhId);
    showToast(t("rates_saved"));
    loadAll();
  };
  const saveSource = async src => {
    await db.from("households").update({
      rate_source: src
    }).eq("id", hhId);
    showToast(t("source_saved"));
    loadAll();
  };
  const saveColor = async (who, hex) => {
    // Apply locally first so the swatch (and every screen using it) updates
    // the instant you click, instead of waiting on a round trip.
    if (who === "shared") {
      setHousehold(h => h ? { ...h, shared_color: hex } : h);
    } else {
      const slot = who === "p0" ? 0 : 1;
      setMembers(ms => ms.map(m => m.slot === slot ? { ...m, color: hex } : m));
    }
    let error;
    if (who === "shared") {
      ({ error } = await db.from("households").update({
        shared_color: hex
      }).eq("id", hhId));
    } else {
      const slot = who === "p0" ? 0 : 1;
      const member = members.find(m => m.slot === slot);
      if (member) ({ error } = await db.from("profiles").update({
        color: hex
      }).eq("id", member.id));
    }
    if (error) {
      showToast(t("save_failed") + error.message);
    } else {
      showToast(t("color_saved"));
    }
    loadAll();
  };
  if (!household) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 60,
      textAlign: "center",
      color: "var(--muted)"
    }
  }, t("loading_household"));
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
    title: t("refresh")
  }, "⟳"), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.iconBtn,
      ...(tab === "settings" ? {
        borderColor: "var(--green)",
        color: "var(--green)"
      } : {})
    },
    onClick: () => setTab("settings"),
    title: t("settings"),
    "aria-label": t("settings")
  }, "⚙"))), /*#__PURE__*/React.createElement("div", {
    style: S.ratesLine
  }, /*#__PURE__*/React.createElement("span", null, "1€ = $", rates.usdPerEur.toFixed(2), " · COP ", Math.round(rates.copPerEur).toLocaleString(numLocale()), /*#__PURE__*/React.createElement("span", {
    style: {
      opacity: 0.8
    }
  }, " · ", ratesLoading ? t("updating") : timeAgo(rates.updatedAt))), /*#__PURE__*/React.createElement("button", {
    style: S.linkBtn,
    onClick: () => updateRates(false),
    disabled: ratesLoading
  }, ratesLoading ? "…" : t("update_rates"))), /*#__PURE__*/React.createElement("main", {
    style: {
      padding: "4px 16px 16px"
    }
  }, tab === "overview" && /*#__PURE__*/React.createElement(Overview, {
    lang: lang,
    onSetLang: changeLang,
    themeMode: themeMode,
    onSetTheme: changeTheme,
    people: people,
    colors: colors,
    month: month,
    setMonth: setMonth,
    rangeMode: rangeMode,
    setRangeMode: setRangeMode,
    range: range,
    setRange: setRange,
    monthExpenses: monthExpenses,
    disp: disp,
    displayCur: displayCur,
    onDelete: deleteExpense,
    onEdit: exp => {
      setEditingExpense(exp);
      setTab("add");
    }
  }), tab === "add" && /*#__PURE__*/React.createElement(AddExpense, {
    key: editingExpense ? editingExpense.id : "new",
    editingExpense: editingExpense,
    onUpdate: updateExpense,
    onCancelEdit: () => {
      setEditingExpense(null);
      setTab("overview");
    },
    people: people,
    colors: colors,
    rates: rates,
    defaultCurrency: CURRENCIES.includes(profile.preferred_currency) ? profile.preferred_currency : "EUR",
    saving: false,
    onAdd: addExpense,
    ratesLoading: ratesLoading,
    onUpdateRates: () => updateRates(false)
  }), tab === "budgets" && /*#__PURE__*/React.createElement(Budgets, {
    people: people,
    month: month,
    monthExpenses: monthExpenses,
    budgets: budgets,
    rates: rates,
    disp: disp,
    displayCur: displayCur,
    onSaveBudgets: saveBudgets
  }), tab === "groceries" && /*#__PURE__*/React.createElement(GroceryList, {
    hhId: hhId,
    user: user
  }), tab === "settings" && /*#__PURE__*/React.createElement(SettingsPage, {
    user: user,
    profile: profile,
    household: household,
    colors: colors,
    onSaveColor: saveColor,
    people: people,
    members: members,
    hhId: hhId,
    rates: rates,
    disp: disp,
    displayCur: displayCur,
    lang: lang,
    onSetLang: changeLang,
    themeMode: themeMode,
    onSetTheme: changeTheme,
    categories: categories,
    onReloadCategories: loadCategories,
    onSaveRates: saveRates,
    onSaveSource: saveSource,
    onImportExpenses: importExpenses,
    onProfileChanged: () => {
      reloadProfile();
      loadAll();
    },
    onHouseholdChanged: loadAll,
    showToast: showToast,
    onSignOut: () => db.auth.signOut()
  }), tab === "calendar" && /*#__PURE__*/React.createElement(Calendar, {
    hhId: hhId,
    user: user,
    profile: profile,
    people: people,
    colors: colors,
    showToast: showToast
  })), toast && /*#__PURE__*/React.createElement("div", {
    style: S.toast
  }, toast), /*#__PURE__*/React.createElement("nav", {
    style: S.tabbar
  }, /*#__PURE__*/React.createElement(TabBtn, {
    active: tab === "overview",
    onClick: () => {
      setEditingExpense(null);
      setTab("overview");
    },
    icon: "📒",
    label: t("tab_overview")
  }), /*#__PURE__*/React.createElement(TabBtn, {
    active: tab === "groceries",
    onClick: () => setTab("groceries"),
    icon: "🛒",
    label: t("tab_list")
  }), /*#__PURE__*/React.createElement(TabBtn, {
    active: tab === "add",
    onClick: () => {
      setEditingExpense(null);
      setTab("add");
    },
    icon: "＋",
    label: t("tab_add"),
    big: true
  }), /*#__PURE__*/React.createElement(TabBtn, {
    active: tab === "calendar",
    onClick: () => setTab("calendar"),
    icon: "📅",
    label: t("tab_calendar")
  }), /*#__PURE__*/React.createElement(TabBtn, {
    active: tab === "budgets",
    onClick: () => setTab("budgets"),
    icon: "🎯",
    label: t("tab_budgets")
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
    onClick: onClick,
    "aria-current": active ? "page" : undefined,
    "aria-label": label
  }, /*#__PURE__*/React.createElement("span", {
    style: big ? S.tabIconBig : S.tabIcon
  }, icon), /*#__PURE__*/React.createElement("span", {
    style: S.tabLabel
  }, label));
}
const kindDot = (e, colors) => colorForKind(e.kind, colors);
const kindText = (e, people) => e.kind === "shared" ? t("kind_shared_paid", {
  name: people[e.payer]
}) : t("kind_private", {
  name: e.kind === "p0" ? people[0] : people[1]
});
const initialsOf = name => (name || "").trim().split(/[\s-]+/).filter(Boolean).map(w => w[0]).join("").slice(0, 2).toUpperCase();
const kindInitials = (e, people) => initialsOf(e.kind === "shared" ? people[e.payer] : e.kind === "p0" ? people[0] : people[1]);

// ---------- Overview ----------
function Overview({
  lang,
  onSetLang,
  themeMode,
  onSetTheme,
  people,
  colors,
  month,
  setMonth,
  rangeMode,
  setRangeMode,
  range,
  setRange,
  monthExpenses,
  onDelete,
  onEdit,
  disp,
  displayCur
}) {
  const [fKind, setFKind] = useState(null);
  const [fWho, setFWho] = useState(null);
  const [fCat, setFCat] = useState(null);
  const [search, setSearch] = useState("");
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
  if (fKind === "shared") {
    visible = visible.filter(e => e.kind === "shared");
    if (fWho != null) visible = visible.filter(e => e.payer === fWho);
  } else if (fKind === "private") {
    visible = visible.filter(e => e.kind === "p0" || e.kind === "p1");
    if (fWho != null) visible = visible.filter(e => e.kind === (fWho === 0 ? "p0" : "p1"));
  }
  if (fCat) visible = visible.filter(e => e.category === fCat);
  const q = search.trim().toLowerCase();
  if (q) visible = visible.filter(e => (e.note || "").toLowerCase().includes(q) || catLabel(e.category).toLowerCase().includes(q));
  const groups = {};
  visible.forEach(e => {
    (groups[e.spent_on] = groups[e.spent_on] || []).push(e);
  });
  const dates = Object.keys(groups).sort().reverse();
  const usedCats = [...new Set(monthExpenses.map(e => e.category))];
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "flex-end",
      gap: 6,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.chip,
      minWidth: 40
    },
    title: t("theme_switch", {
      mode: t("theme_" + themeMode)
    }),
    "aria-label": t("theme_switch", {
      mode: t("theme_" + themeMode)
    }),
    onClick: () => onSetTheme(themeMode === "light" ? "dark" : themeMode === "dark" ? "system" : "light")
  }, themeMode === "light" ? "\u2600\uFE0F" : themeMode === "dark" ? "\uD83C\uDF19" : "\uD83D\uDCF1"), window.I18N.languages.map(l => /*#__PURE__*/React.createElement("button", {
    key: l,
    style: {
      ...S.chip,
      ...(lang === l ? S.chipOn : {})
    },
    onClick: () => onSetLang(l)
  }, l.toUpperCase()))), /*#__PURE__*/React.createElement("input", {
    style: {
      ...S.input,
      marginBottom: 10
    },
    placeholder: t("search_ph"),
    value: search,
    onChange: e => setSearch(e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    style: S.chipRow
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.chip,
      ...(!rangeMode ? S.chipOn : {})
    },
    onClick: () => setRangeMode(false)
  }, t("month")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.chip,
      ...(rangeMode ? S.chipOn : {})
    },
    onClick: () => setRangeMode(true)
  }, t("custom_period"))), rangeMode ? /*#__PURE__*/React.createElement("div", {
    style: {
      ...S.monthNav,
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "date",
    style: {
      ...S.input,
      flex: 1
    },
    value: range.from,
    max: range.to,
    onChange: e => setRange({
      ...range,
      from: e.target.value
    })
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)",
      fontSize: 13
    }
  }, t("to")), /*#__PURE__*/React.createElement("input", {
    type: "date",
    style: {
      ...S.input,
      flex: 1
    },
    value: range.to,
    min: range.from,
    onChange: e => setRange({
      ...range,
      to: e.target.value
    })
  })) : /*#__PURE__*/React.createElement("div", {
    style: S.monthNav
  }, /*#__PURE__*/React.createElement("button", {
    style: S.iconBtn,
    onClick: () => shift(-1)
  }, "‹"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600,
      fontSize: 16
    }
  }, monthName(month.m), " ", month.y), /*#__PURE__*/React.createElement("button", {
    style: S.iconBtn,
    onClick: () => shift(1)
  }, "›")), /*#__PURE__*/React.createElement("div", {
    style: S.hero
  }, /*#__PURE__*/React.createElement("div", {
    style: S.heroLabel
  }, rangeMode ? t("total_for_period") : t("total_this_month"), displayCur), /*#__PURE__*/React.createElement("div", {
    style: S.heroAmount
  }, disp(total)), /*#__PURE__*/React.createElement("div", {
    style: S.splitBar
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: "100%",
      background: colors.shared,
      width: pct(sharedTotal) + "%"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: "100%",
      background: colors.p0,
      width: pct(priv[0]) + "%"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: "100%",
      background: colors.p1,
      width: pct(priv[1]) + "%"
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: S.splitLegend
  }, /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("i", {
    style: {
      ...S.dot,
      background: colors.shared
    }
  }), t("shared") + " ", disp(sharedTotal)), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("i", {
    style: {
      ...S.dot,
      background: colors.p0
    }
  }), people[0], " ", disp(priv[0])), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("i", {
    style: {
      ...S.dot,
      background: colors.p1
    }
  }), people[1], " ", disp(priv[1]))), sharedTotal > 0 && /*#__PURE__*/React.createElement("div", {
    style: S.sharedPaid
  }, t("shared_paid_by"), people[0], " ", disp(sharedPaid[0]), " · ", people[1], " ", disp(sharedPaid[1]))), /*#__PURE__*/React.createElement("div", {
    style: S.chipRow
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.chip,
      ...(!fKind ? S.chipOn : {})
    },
    onClick: () => {
      setFKind(null);
      setFWho(null);
    }
  }, t("all")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.chip,
      ...(fKind === "shared" ? S.chipOn : {})
    },
    onClick: () => {
      setFKind(fKind === "shared" ? null : "shared");
      setFWho(null);
    }
  }, t("shared")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.chip,
      ...(fKind === "private" ? S.chipOn : {})
    },
    onClick: () => {
      setFKind(fKind === "private" ? null : "private");
      setFWho(null);
    }
  }, t("private"))), (fKind === "shared" || fKind === "private") && /*#__PURE__*/React.createElement("div", {
    style: S.chipRow
  }, fKind === "shared" && /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.chip,
      ...(fWho == null ? S.chipOn : {})
    },
    onClick: () => setFWho(null)
  }, t("any_payer")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.chip,
      ...(fWho === 0 ? S.chipOn : {})
    },
    onClick: () => setFWho(fWho === 0 ? null : 0)
  }, fKind === "shared" ? t("paid_by_name", {
    name: people[0]
  }) : people[0]), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.chip,
      ...(fWho === 1 ? S.chipOn : {})
    },
    onClick: () => setFWho(fWho === 1 ? null : 1)
  }, fKind === "shared" ? t("paid_by_name", {
    name: people[1]
  }) : people[1])), usedCats.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: S.chipRow
  }, usedCats.map(c => /*#__PURE__*/React.createElement("button", {
    key: c,
    style: {
      ...S.chip,
      ...(fCat === c ? S.chipOn : {})
    },
    onClick: () => setFCat(fCat === c ? null : c)
  }, catById(c).icon, " ", catLabel(c)))), dates.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: S.empty
  }, q ? t("no_match", {
    q: search.trim()
  }) : rangeMode ? t("no_expenses_period") : t("no_expenses_month", {
    month: monthName(month.m)
  }), /*#__PURE__*/React.createElement("br", null), !q && /*#__PURE__*/React.createElement(React.Fragment, null, t("add_first_via"), /*#__PURE__*/React.createElement("b", null, "＋ " + t("tab_add")), ".")), dates.map(date => {
    const [y, m, d] = date.split("-").map(Number);
    return /*#__PURE__*/React.createElement("div", {
      key: date,
      style: {
        marginBottom: 6
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: S.dayLabel
    }, monthName(m - 1), " ", d), groups[date].map(e => /*#__PURE__*/React.createElement("div", {
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
    }, catLabel(e.category), e.note ? ` — ${e.note}` : ""), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        marginTop: 2
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 18,
        height: 18,
        borderRadius: "50%",
        background: kindDot(e, colors),
        color: "var(--on-accent)",
        fontSize: 9,
        fontWeight: 700,
        flexShrink: 0
      }
    }, kindInitials(e, people)), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12,
        fontWeight: 600,
        color: kindDot(e, colors)
      }
    }, kindText(e, people)))), /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "right"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: S.expAmount
    }, e.currency === displayCur ? fmt(Number(e.amount_orig), displayCur) : disp(Number(e.amount_eur))), e.currency !== displayCur && /*#__PURE__*/React.createElement("div", {
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
    }, t("delete")), /*#__PURE__*/React.createElement("button", {
      style: S.miniBtn,
      onClick: () => setConfirmId(null)
    }, t("no"))) : /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 4,
        marginTop: 4,
        justifyContent: "flex-end"
      }
    }, /*#__PURE__*/React.createElement("button", {
      style: S.miniBtn,
      onClick: () => onEdit(e)
    }, t("edit")), /*#__PURE__*/React.createElement("button", {
      style: S.delBtn,
      onClick: () => setConfirmId(e.id)
    }, "×"))))));
  }));
}

// ---------- Add expense ----------
function AddExpense({
  people,
  colors,
  rates,
  defaultCurrency,
  onAdd,
  saving,
  ratesLoading,
  onUpdateRates,
  editingExpense,
  onUpdate,
  onCancelEdit
}) {
  const [amount, setAmount] = useState(editingExpense ? String(editingExpense.amount_orig) : "");
  const [currency, setCurrency] = useState(editingExpense ? editingExpense.currency : defaultCurrency);
  const [kind, setKind] = useState(editingExpense ? editingExpense.kind : "shared");
  const [payer, setPayer] = useState(editingExpense ? editingExpense.payer : 0);
  const [category, setCategory] = useState(() => {
    if (editingExpense) return editingExpense.category;
    const act = activeCategories();
    return act.length ? act[0].id : "other";
  });
  const [date, setDate] = useState(editingExpense ? editingExpense.spent_on : todayStr());
  const [note, setNote] = useState(editingExpense ? editingExpense.note || "" : "");
  const [err, setErr] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState(null);
  const [scanned, setScanned] = useState(false);
  const scanInputRef = useRef(null);
  const onScanFile = async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setScanErr(null);
    setScanned(false);
    setScanning(true);
    try {
      const image = await withTimeout(resizeReceiptImage(file), 15000, t("scan_photo_slow"));
      const {
        data,
        error
      } = await withTimeout(db.functions.invoke("scan-receipt", {
        body: {
          image,
          mediaType: "image/jpeg"
        }
      }), 45000, t("scan_server_slow"));
      if (error) throw error;
      if (data.error) throw new Error(data.error);
      if (!(data.amount > 0)) throw new Error(t("scan_no_total"));
      setAmount(String(data.amount));
      if (CURRENCIES.includes(data.currency)) setCurrency(data.currency);
      if (data.category && isKnownCategory(data.category)) setCategory(data.category);
      setDate(todayStr());
      if (data.merchant) setNote(String(data.merchant).slice(0, 60));
      setScanned(true);
    } catch (e2) {
      setScanErr(t("scan_failed") + (e2.message || String(e2)));
    } finally {
      setScanning(false);
    }
  };
  const pa = parseFloat(String(amount).replace(",", "."));
  const eur = pa > 0 ? toEUR(pa, currency, rates) : NaN;
  const submit = () => {
    if (!pa || pa <= 0) return setErr(t("enter_valid_amount"));
    setErr(null);
    const finalPayer = kind === "shared" ? payer : kind === "p0" ? 0 : 1;
    const exp = {
      amountOrig: pa,
      currency,
      amountEUR: Math.round(eur * 100) / 100,
      rateUsed: perEur(currency, rates),
      kind,
      payer: finalPayer,
      category,
      date,
      note: note.trim()
    };
    if (editingExpense) {
      onUpdate(editingExpense.id, exp);
      return;
    }
    onAdd(exp);
    setAmount("");
    setNote("");
  };
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    style: S.pageTitle
  }, editingExpense ? t("edit_expense") : t("new_expense")), !editingExpense && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("input", {
    ref: scanInputRef,
    type: "file",
    accept: "image/*",
    capture: "environment",
    style: {
      display: "none"
    },
    onChange: onScanFile
  }), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      marginBottom: 14,
      opacity: scanning ? 0.6 : 1
    },
    disabled: scanning,
    onClick: () => scanInputRef.current && scanInputRef.current.click()
  }, scanning ? t("scanning") : t("scan_receipt")), scanErr && /*#__PURE__*/React.createElement("div", {
    style: S.errBox
  }, scanErr), scanned && /*#__PURE__*/React.createElement("div", {
    style: S.okBox
  }, t("scan_done"))), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("amount")), /*#__PURE__*/React.createElement("div", {
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
  }, currency !== "EUR" && /*#__PURE__*/React.createElement("span", null, fmt(ceilCur(eur, "EUR"), "EUR")), currency !== "USD" && /*#__PURE__*/React.createElement("span", null, fmt(ceilCur(fromEUR(eur, "USD", rates), "USD"), "USD")), currency !== "COP" && /*#__PURE__*/React.createElement("span", null, fmt(ceilCur(fromEUR(eur, "COP", rates), "COP"), "COP")), /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 400,
      color: "var(--muted)"
    }
  }, t("rate_word"), ratesLoading ? t("updating") : timeAgo(rates.updatedAt))), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("type")), /*#__PURE__*/React.createElement("div", {
    style: S.segWide
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(kind === "shared" ? {
        background: colors.shared,
        color: "var(--on-accent)"
      } : {})
    },
    onClick: () => setKind("shared")
  }, t("shared")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(kind === "p0" ? {
        background: colors.p0,
        color: "var(--on-accent)"
      } : {})
    },
    onClick: () => setKind("p0")
  }, people[0]), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(kind === "p1" ? {
        background: colors.p1,
        color: "var(--on-accent)"
      } : {})
    },
    onClick: () => setKind("p1")
  }, people[1])), /*#__PURE__*/React.createElement("div", {
    style: S.typeHint
  }, kind === "shared" ? t("type_hint_shared") : t("type_hint_private", {
    name: kind === "p0" ? people[0] : people[1]
  })), kind === "shared" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("paid_by")), /*#__PURE__*/React.createElement("div", {
    style: S.segWide
  }, people.map((p, i) => /*#__PURE__*/React.createElement("button", {
    key: i,
    style: {
      ...S.segBtn,
      ...(payer === i ? {
        background: i === 0 ? colors.p0 : colors.p1,
        color: "var(--on-accent)"
      } : {})
    },
    onClick: () => setPayer(i)
  }, p)))), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("category")), activeCategories().length === 0 && /*#__PURE__*/React.createElement("div", {
    style: S.empty
  }, t("no_active_categories")), /*#__PURE__*/React.createElement("div", {
    style: S.catGrid
  }, activeCategories().map(c => /*#__PURE__*/React.createElement("button", {
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
  }, c.icon), /*#__PURE__*/React.createElement("span", null, catLabel(c))))), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("date")), /*#__PURE__*/React.createElement("input", {
    type: "date",
    style: S.input,
    value: date,
    onChange: e => setDate(e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("note_optional")), /*#__PURE__*/React.createElement("input", {
    style: S.input,
    placeholder: t("note_ph"),
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
  }, saving ? t("saving") : editingExpense ? t("save_changes") : t("save_expense")), editingExpense && /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      marginTop: 8
    },
    onClick: onCancelEdit
  }, t("cancel")));
}

// ---------- Color swatch picker ----------
function ColorSwatchRow({ label, value, onPick }) {
  return /*#__PURE__*/React.createElement("div", {
    style: { marginBottom: 12 }
  }, /*#__PURE__*/React.createElement("div", {
    style: S.namesRow
  }, /*#__PURE__*/React.createElement("span", null, label), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 20,
      height: 20,
      borderRadius: "50%",
      background: value,
      display: "inline-block",
      border: "1px solid var(--line)"
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }
  }, COLOR_PALETTE.map(hex => /*#__PURE__*/React.createElement("button", {
    key: hex,
    type: "button",
    onClick: () => onPick(hex),
    "aria-label": hex,
    "aria-pressed": value === hex,
    style: {
      width: 28,
      height: 28,
      borderRadius: "50%",
      background: hex,
      border: value === hex ? "3px solid var(--ink)" : "2px solid transparent",
      padding: 0,
      cursor: "pointer"
    }
  }))));
}

// ---------- Budgets & settings ----------
function Budgets({
  people,
  month,
  monthExpenses,
  budgets,
  rates,
  disp,
  displayCur,
  onSaveBudgets,
}) {
  const [draft, setDraft] = useState(() => {
    const d = {};
    budgetCategories(budgets).forEach(c => d[c.id] = budgets[c.id] != null ? String(budgets[c.id]) : "");
    return d;
  });
  const [editing, setEditing] = useState(false);
  const spentByCat = {};
  monthExpenses.forEach(e => {
    spentByCat[e.category] = (spentByCat[e.category] || 0) + Number(e.amount_eur);
  });
  const totalBudget = Object.values(budgets).reduce((s, v) => s + v, 0);
  const totalSpent = monthExpenses.reduce((s, e) => s + Number(e.amount_eur), 0);
  const save = () => {
    const b = {};
    budgetCategories(budgets).forEach(c => {
      const v = parseFloat(String(draft[c.id]).replace(",", "."));
      if (v > 0) b[c.id] = v;
    });
    onSaveBudgets(b);
    setEditing(false);
  };
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    style: S.pageTitle
  }, t("budgets_dash"), monthName(month.m)), /*#__PURE__*/React.createElement("div", {
    style: S.budgetNote
  }, t("budgets_note", {
    cur: displayCur
  })), totalBudget > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      ...S.hero,
      padding: "14px 16px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: S.heroLabel
  }, t("total")), /*#__PURE__*/React.createElement("div", {
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
  }, t("of_word"), disp(totalBudget))), /*#__PURE__*/React.createElement(Bar, {
    spent: totalSpent,
    budget: totalBudget
  })), budgetCategories(budgets).map(c => {
    const b = budgets[c.id];
    const sp = spentByCat[c.id] || 0;
    return /*#__PURE__*/React.createElement("div", {
      key: c.id,
      style: S.budgetRow
    }, /*#__PURE__*/React.createElement("div", {
      style: S.budgetHead
    }, /*#__PURE__*/React.createElement("span", null, c.icon, " ", catLabel(c)), editing ? /*#__PURE__*/React.createElement("span", {
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
  }, t("save")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      flex: 1,
      width: "auto"
    },
    onClick: () => setEditing(false)
  }, t("cancel"))) : /*#__PURE__*/React.createElement("button", {
    style: S.ghostBtn,
    onClick: () => setEditing(true)
  }, t("edit_budgets")));
}

// ---------- Settings ----------
const CURRENCY_CHOICES = ["EUR", "USD", "COP"];
// Palette offered for member/shared colours. Values are concrete hex so they
// survive light/dark theme switches and round-trip through the database.
function SettingsPage({
  user,
  profile,
  household,
  colors,
  onSaveColor,
  people,
  members,
  hhId,
  rates,
  disp,
  displayCur,
  lang,
  onSetLang,
  themeMode,
  onSetTheme,
  categories,
  onReloadCategories,
  onSaveRates,
  onSaveSource,
  onImportExpenses,
  onProfileChanged,
  onHouseholdChanged,
  showToast,
  onSignOut
}) {
  const [name, setName] = useState(profile.display_name || "");
  const [savingName, setSavingName] = useState(false);
  const [rateDraft, setRateDraft] = useState({
    usd: String(rates.usdPerEur),
    cop: String(rates.copPerEur)
  });
  const [editRates, setEditRates] = useState(false);
  const [sourceDraft, setSourceDraft] = useState(household && household.rate_source || "wise.com");
  const [editSource, setEditSource] = useState(false);
  const [err, setErr] = useState(null);
  const mySlot = profile.slot === 0 || profile.slot === 1 ? profile.slot : null;

  // --- profile ---
  const saveName = async () => {
    const v = name.trim();
    if (v.length < 2 || v.length > 40) {
      setErr(t("name_invalid"));
      return;
    }
    setSavingName(true);
    setErr(null);
    const {
      error
    } = await db.from("profiles").update({
      display_name: v
    }).eq("id", user.id);
    setSavingName(false);
    if (error) {
      setErr(t("save_failed") + error.message);
      return;
    }
    showToast(t("name_saved"));
    onProfileChanged();
  };
  const saveCurrency = async cur => {
    const {
      error
    } = await db.from("profiles").update({
      preferred_currency: cur
    }).eq("id", user.id);
    if (error) {
      setErr(t("save_failed") + error.message);
      return;
    }
    showToast(t("currency_saved"));
    onProfileChanged();
  };
  const copyCode = () => {
    if (!household || !household.invite_code) return;
    navigator.clipboard.writeText(household.invite_code).then(() => showToast(t("copied")), () => setErr(t("copy_failed")));
  };
  const saveR = () => {
    const usd = parseFloat(String(rateDraft.usd).replace(",", "."));
    const cop = parseFloat(String(rateDraft.cop).replace(",", "."));
    if (!(usd > 0) || !(cop > 0)) {
      setErr(t("rates_invalid"));
      return;
    }
    setErr(null);
    onSaveRates({
      usdPerEur: usd,
      copPerEur: cop
    });
    setEditRates(false);
  };
  const section = title => /*#__PURE__*/React.createElement("h2", {
    style: {
      ...S.pageTitle,
      marginTop: 26
    }
  }, title);
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    style: S.pageTitle
  }, t("settings")), err && /*#__PURE__*/React.createElement("div", {
    style: S.errBox
  }, err),
  // ===== PROFILE =====
  section(t("sec_profile")), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("display_name")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("input", {
    style: {
      ...S.input,
      flex: 1
    },
    value: name,
    maxLength: 40,
    onChange: e => setName(e.target.value)
  }), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      marginTop: 0,
      width: "auto",
      padding: "0 18px",
      opacity: savingName || name.trim() === (profile.display_name || "") ? 0.6 : 1
    },
    disabled: savingName || name.trim() === (profile.display_name || ""),
    onClick: saveName
  }, t("save"))), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("default_currency")), /*#__PURE__*/React.createElement("div", {
    style: S.segWide
  }, CURRENCY_CHOICES.map(c => /*#__PURE__*/React.createElement("button", {
    key: c,
    style: {
      ...S.segBtn,
      ...(profile.preferred_currency === c ? S.segOn : {})
    },
    onClick: () => saveCurrency(c)
  }, c === "COP" ? "COP" : SYMBOL[c] + " " + c))), /*#__PURE__*/React.createElement("div", {
    style: S.privacyNote
  }, t("default_currency_hint")), mySlot != null && /*#__PURE__*/React.createElement(ColorSwatchRow, {
    label: t("my_colour"),
    value: mySlot === 0 ? colors.p0 : colors.p1,
    onPick: hex => onSaveColor(mySlot === 0 ? "p0" : "p1", hex)
  }), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("language")), /*#__PURE__*/React.createElement("div", {
    style: S.segWide
  }, window.I18N.languages.map(l => /*#__PURE__*/React.createElement("button", {
    key: l,
    style: {
      ...S.segBtn,
      ...(lang === l ? S.segOn : {})
    },
    onClick: () => onSetLang(l)
  }, l.toUpperCase()))), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("appearance")), /*#__PURE__*/React.createElement("div", {
    style: S.segWide
  }, ["light", "dark", "system"].map(m => /*#__PURE__*/React.createElement("button", {
    key: m,
    style: {
      ...S.segBtn,
      ...(themeMode === m ? S.segOn : {})
    },
    onClick: () => onSetTheme(m)
  }, t("theme_" + m)))),
  // ===== HOUSEHOLD =====
  section(t("sec_household")), household ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("household_name")), /*#__PURE__*/React.createElement("div", {
    style: S.namesRow
  }, /*#__PURE__*/React.createElement("span", null, household.name || "—")), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("household_members")), members.map(m => /*#__PURE__*/React.createElement("div", {
    key: m.id,
    style: S.namesRow
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 14,
      height: 14,
      borderRadius: "50%",
      background: m.slot === 0 ? colors.p0 : colors.p1,
      display: "inline-block"
    }
  }), m.display_name, m.id === user.id ? " · " + t("you") : ""))), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("colors")), /*#__PURE__*/React.createElement(ColorSwatchRow, {
    label: t("shared"),
    value: colors.shared,
    onPick: hex => onSaveColor("shared", hex)
  }), /*#__PURE__*/React.createElement(ColorSwatchRow, {
    label: people[0],
    value: colors.p0,
    onPick: hex => onSaveColor("p0", hex)
  }), /*#__PURE__*/React.createElement(ColorSwatchRow, {
    label: people[1],
    value: colors.p1,
    onPick: hex => onSaveColor("p1", hex)
  }), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("invite_share")), /*#__PURE__*/React.createElement("div", {
    style: S.namesRow
  }, /*#__PURE__*/React.createElement("code", null, household.invite_code || "—"), /*#__PURE__*/React.createElement("button", {
    style: S.miniBtn,
    onClick: copyCode
  }, t("copy")))) : /*#__PURE__*/React.createElement("div", {
    style: S.privacyNote
  }, t("no_household_yet")),
  // ===== CATEGORIES =====
  household && /*#__PURE__*/React.createElement(React.Fragment, null, section(t("sec_categories")), /*#__PURE__*/React.createElement(CategorySettings, {
    hhId: hhId,
    user: user,
    categories: categories,
    onChanged: onReloadCategories,
    showToast: showToast
  })),
  // ===== CURRENCY & RATES =====
  household && /*#__PURE__*/React.createElement(React.Fragment, null, section(t("sec_rates")), editRates ? /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: S.namesRow
  }, /*#__PURE__*/React.createElement("span", null, "1 € = $"), /*#__PURE__*/React.createElement("input", {
    style: {
      ...S.input,
      width: 120,
      marginTop: 0
    },
    inputMode: "decimal",
    value: rateDraft.usd,
    onChange: e => setRateDraft({
      ...rateDraft,
      usd: e.target.value
    })
  })), /*#__PURE__*/React.createElement("div", {
    style: S.namesRow
  }, /*#__PURE__*/React.createElement("span", null, "1 € = COP"), /*#__PURE__*/React.createElement("input", {
    style: {
      ...S.input,
      width: 120,
      marginTop: 0
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
      gap: 8,
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      marginTop: 0,
      flex: 1,
      width: "auto"
    },
    onClick: saveR
  }, t("save")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      marginTop: 0,
      flex: 1,
      width: "auto"
    },
    onClick: () => setEditRates(false)
  }, t("cancel")))) : /*#__PURE__*/React.createElement("div", {
    style: S.namesRow
  }, /*#__PURE__*/React.createElement("span", null, "1€ = $", rates.usdPerEur.toFixed(2), " · COP ", Math.round(rates.copPerEur).toLocaleString(numLocale())), /*#__PURE__*/React.createElement("button", {
    style: S.miniBtn,
    onClick: () => {
      setRateDraft({
        usd: String(rates.usdPerEur),
        cop: String(rates.copPerEur)
      });
      setEditRates(true);
    }
  }, t("edit"))), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("rate_source")), editSource ? /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("input", {
    style: S.input,
    value: sourceDraft,
    onChange: e => setSourceDraft(e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      marginTop: 0,
      flex: 1,
      width: "auto"
    },
    onClick: () => {
      onSaveSource(sourceDraft.trim() || "wise.com");
      setEditSource(false);
    }
  }, t("save")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      marginTop: 0,
      flex: 1,
      width: "auto"
    },
    onClick: () => setEditSource(false)
  }, t("cancel")))) : /*#__PURE__*/React.createElement("div", {
    style: S.namesRow
  }, /*#__PURE__*/React.createElement("span", null, "🌐 ", household.rate_source || "wise.com"), /*#__PURE__*/React.createElement("button", {
    style: S.miniBtn,
    onClick: () => {
      setSourceDraft(household.rate_source || "wise.com");
      setEditSource(true);
    }
  }, t("edit"))), /*#__PURE__*/React.createElement("div", {
    style: S.privacyNote
  }, t("privacy_note")), /*#__PURE__*/React.createElement(ImportExpenses, {
    people: people,
    rates: rates,
    onImport: onImportExpenses
  }), /*#__PURE__*/React.createElement(CalendarSync, {
    hhId: hhId,
    user: user,
    people: people,
    showToast: showToast
  })), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      marginTop: 24,
      color: "var(--danger)",
      borderColor: "var(--danger)"
    },
    onClick: onSignOut
  }, t("sign_out")));
}

// ---------- Category settings ----------
// Storage model is sparse on purpose: a household_categories row exists only
// where a household deviates from the built-in defaults (renamed, re-iconed,
// switched off) or defines a category of its own. A household with no rows —
// including every brand-new one — therefore starts with the full built-in set
// active, and no default is ever duplicated per household.
function CategorySettings({
  hhId,
  user,
  categories,
  onChanged,
  showToast
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(null);

  // Writes the household's deviation for one category. If a built-in ends up
  // matching the default again, its row is removed rather than left behind, so
  // the table keeps holding only real differences.
  const writeOverride = async (cat, next) => {
    const label = (next.label || "").trim() || null;
    const icon = (next.icon || "").trim() || null;
    const active = next.active !== false;
    if (!cat.custom) {
      const deviates = !!label || (!!icon && icon !== cat.defaultIcon) || !active;
      if (!deviates) {
        if (cat.rowId) {
          const {
            error
          } = await db.from("household_categories").delete().eq("id", cat.rowId);
          if (error) throw new Error(error.message);
        }
        return;
      }
    }
    const {
      error
    } = await db.from("household_categories").upsert({
      household_id: hhId,
      category_key: cat.id,
      is_custom: !!cat.custom,
      label,
      icon,
      active,
      archived_at: active ? null : cat.custom ? new Date().toISOString() : null,
      created_by: user.id
    }, {
      onConflict: "household_id,category_key"
    });
    if (error) throw new Error(error.message);
  };
  const run = async (fn, okMsg) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      if (okMsg) showToast(okMsg);
      setEditing(null);
      onChanged();
    } catch (e) {
      setErr(t("category_save_failed") + (e.message || String(e)));
    } finally {
      setBusy(false);
    }
  };
  const toggle = cat => run(() => writeOverride(cat, {
    label: cat.label,
    icon: cat.custom ? cat.icon : cat.icon === cat.defaultIcon ? null : cat.icon,
    active: !cat.active
  }), cat.active ? t("category_disabled") : t("category_enabled"));

  // "Remove" never risks history: a category that was ever booked against is
  // archived instead of deleted, so old expenses keep resolving their label.
  const removeCategory = cat => run(async () => {
    const [exp, bud] = await Promise.all([db.from("expenses").select("id", {
      count: "exact",
      head: true
    }).eq("household_id", hhId).eq("category", cat.id), db.from("budgets").select("id", {
      count: "exact",
      head: true
    }).eq("household_id", hhId).eq("category", cat.id)]);
    if (exp.error) throw new Error(exp.error.message);
    if (bud.error) throw new Error(bud.error.message);
    const used = (exp.count || 0) + (bud.count || 0) > 0;
    if (cat.custom && !used && cat.rowId) {
      const {
        error
      } = await db.from("household_categories").delete().eq("id", cat.rowId);
      if (error) throw new Error(error.message);
      showToast(t("category_removed"));
      return;
    }
    await writeOverride(cat, {
      label: cat.label,
      icon: cat.custom ? cat.icon : null,
      active: false
    });
    showToast(used ? t("category_archived_used") : t("category_archived"));
  });
  const resetToDefault = cat => run(() => writeOverride(cat, {
    label: null,
    icon: null,
    active: cat.active
  }), t("category_reset"));
  const saveEdit = form => run(async () => {
    const label = form.label.trim();
    if (label.length < 2 || label.length > 30) throw new Error(t("category_name_invalid"));
    if (form.isNew) {
      const key = "custom_" + Math.random().toString(36).slice(2, 10);
      const {
        error
      } = await db.from("household_categories").insert({
        household_id: hhId,
        category_key: key,
        is_custom: true,
        label,
        icon: form.icon.trim() || "🏷️",
        active: form.active,
        sort_order: 100 + categories.rows.length,
        created_by: user.id
      });
      if (error) throw new Error(error.message);
    } else {
      // A built-in keeps its stable key; only the household's display
      // override changes, so historical expenses never need rewriting.
      await writeOverride(form.cat, {
        label: form.cat.custom ? label : label === t("cat_" + form.cat.id) ? null : label,
        icon: form.icon.trim(),
        active: form.active
      });
    }
  }, t("category_saved"));
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: S.privacyNote
  }, t("categories_hint")), err && /*#__PURE__*/React.createElement("div", {
    style: S.errBox
  }, err), categories.all.map(c => /*#__PURE__*/React.createElement("div", {
    key: c.id,
    style: S.namesRow
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      opacity: c.active ? 1 : 0.5,
      display: "flex",
      alignItems: "center",
      gap: 8,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 18
    }
  }, c.icon), /*#__PURE__*/React.createElement("span", {
    style: {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, catLabel(c)), !c.active && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "var(--muted)"
    }
  }, "· " + t("inactive"))), /*#__PURE__*/React.createElement("button", {
    style: S.miniBtn,
    disabled: busy,
    onClick: () => setEditing({
      cat: c,
      isNew: false,
      label: catLabel(c),
      icon: c.icon,
      active: c.active
    })
  }, t("edit")))), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      marginTop: 10
    },
    disabled: busy,
    onClick: () => setEditing({
      cat: null,
      isNew: true,
      label: "",
      icon: "🏷️",
      active: true
    })
  }, "＋ " + t("add_category")), editing && /*#__PURE__*/React.createElement(CategoryEditor, {
    form: editing,
    busy: busy,
    onChange: setEditing,
    onCancel: () => setEditing(null),
    onSave: () => saveEdit(editing),
    onToggle: () => toggle(editing.cat),
    onRemove: () => removeCategory(editing.cat),
    onReset: () => resetToDefault(editing.cat)
  }));
}

// ---------- Category edit modal ----------
function CategoryEditor({
  form,
  busy,
  onChange,
  onCancel,
  onSave,
  onToggle,
  onRemove,
  onReset
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const cat = form.cat;
  const set = (k, v) => onChange({
    ...form,
    [k]: v
  });
  return /*#__PURE__*/React.createElement("div", {
    style: S.modalWrap,
    onClick: onCancel
  }, /*#__PURE__*/React.createElement("div", {
    style: S.modalCard,
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      ...S.pageTitle,
      marginTop: 0
    }
  }, form.isNew ? t("add_category") : t("edit_category")), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("category_name")), /*#__PURE__*/React.createElement("input", {
    style: S.input,
    value: form.label,
    maxLength: 30,
    placeholder: t("category_name_ph"),
    onChange: e => set("label", e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("category_icon")), /*#__PURE__*/React.createElement("input", {
    style: {
      ...S.input,
      width: 90,
      textAlign: "center",
      fontSize: 20
    },
    value: form.icon,
    maxLength: 4,
    onChange: e => set("icon", e.target.value)
  }), !form.isNew && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("status")), /*#__PURE__*/React.createElement("div", {
    style: S.segWide
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(form.active ? S.segOn : {})
    },
    disabled: busy,
    onClick: () => {
      if (!form.active) onToggle();
    }
  }, t("active")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(!form.active ? S.segOn : {})
    },
    disabled: busy,
    onClick: () => {
      if (form.active) onToggle();
    }
  }, t("inactive")))), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      opacity: busy ? 0.6 : 1
    },
    disabled: busy,
    onClick: onSave
  }, busy ? t("saving") : t("save")), !form.isNew && cat && !cat.custom && cat.overridden && /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      marginTop: 8
    },
    disabled: busy,
    onClick: onReset
  }, t("reset_default")), !form.isNew && confirmRemove ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      marginTop: 0,
      flex: 1,
      width: "auto",
      background: "var(--danger)"
    },
    disabled: busy,
    onClick: onRemove
  }, t("remove")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      marginTop: 0,
      flex: 1,
      width: "auto"
    },
    onClick: () => setConfirmRemove(false)
  }, t("cancel"))) : !form.isNew && /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      marginTop: 8,
      color: "var(--danger)",
      borderColor: "var(--danger)"
    },
    disabled: busy,
    onClick: () => setConfirmRemove(true)
  }, t("remove")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      marginTop: 8
    },
    onClick: onCancel
  }, t("cancel")), !form.isNew && /*#__PURE__*/React.createElement("div", {
    style: S.privacyNote
  }, t("category_remove_hint"))));
}

// ---------- Shell for a signed-in user without a household ----------
function NoHousehold({
  user,
  profile,
  lang,
  onSetLang,
  themeMode,
  onSetTheme,
  onReload,
  onSignOut
}) {
  const [showSetup, setShowSetup] = useState(true);
  const [name, setName] = useState(profile.display_name || "");
  const [err, setErr] = useState(null);
  const saveName = async () => {
    const v = name.trim();
    if (v.length < 2 || v.length > 40) {
      setErr(t("name_invalid"));
      return;
    }
    const {
      error
    } = await db.from("profiles").update({
      display_name: v
    }).eq("id", user.id);
    if (error) {
      setErr(t("save_failed") + error.message);
      return;
    }
    setErr(null);
    onReload();
  };
  if (showSetup) return /*#__PURE__*/React.createElement(Onboard, {
    user: user,
    profile: profile,
    onDone: onReload,
    onSkip: () => setShowSetup(false)
  });
  return /*#__PURE__*/React.createElement("div", {
    style: {
      ...S.appRoot,
      padding: "16px"
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: S.pageTitle
  }, t("settings")), /*#__PURE__*/React.createElement("div", {
    style: S.empty
  }, t("no_household_yet")), err && /*#__PURE__*/React.createElement("div", {
    style: S.errBox
  }, err), /*#__PURE__*/React.createElement("button", {
    style: S.primaryBtn,
    onClick: () => setShowSetup(true)
  }, t("set_up_household")), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("display_name")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("input", {
    style: {
      ...S.input,
      flex: 1
    },
    value: name,
    maxLength: 40,
    onChange: e => setName(e.target.value)
  }), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      marginTop: 0,
      width: "auto",
      padding: "0 18px"
    },
    onClick: saveName
  }, t("save"))), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("language")), /*#__PURE__*/React.createElement("div", {
    style: S.segWide
  }, window.I18N.languages.map(l => /*#__PURE__*/React.createElement("button", {
    key: l,
    style: {
      ...S.segBtn,
      ...(lang === l ? S.segOn : {})
    },
    onClick: () => onSetLang(l)
  }, l.toUpperCase()))), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("appearance")), /*#__PURE__*/React.createElement("div", {
    style: S.segWide
  }, ["light", "dark", "system"].map(m => /*#__PURE__*/React.createElement("button", {
    key: m,
    style: {
      ...S.segBtn,
      ...(themeMode === m ? S.segOn : {})
    },
    onClick: () => onSetTheme(m)
  }, t("theme_" + m)))), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      marginTop: 24,
      color: "var(--danger)",
      borderColor: "var(--danger)"
    },
    onClick: onSignOut
  }, t("sign_out")));
}

// ---------- CSV import ----------
function parseImportCsv(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter(l => l.trim().length);
  if (!lines.length) return [];
  const header = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).map(line => {
    const cols = line.split(",");
    const row = {};
    header.forEach((h, i) => row[h] = (cols[i] || "").trim());
    return row;
  });
}
const VALID_KINDS = ["shared", "p0", "p1"];
function ImportExpenses({
  people,
  rates,
  onImport
}) {
  const [rows, setRows] = useState(null);
  const [fileName, setFileName] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const fileInputRef = useRef(null);
  const onFile = e => {
    const file = e.target.files[0];
    if (!file) return;
    setErr(null);
    setProgress(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseImportCsv(String(reader.result));
        const invalid = [];
        const clean = parsed.map((r, i) => {
          const amount = parseFloat(r.amount);
          const category = isKnownCategory(r.category) ? r.category : null;
          const kind = VALID_KINDS.includes(r.kind) ? r.kind : null;
          const currency = CURRENCIES.includes(r.currency) ? r.currency : null;
          if (!r.date || !(amount > 0) || !currency || !category || !kind) invalid.push(i + 2);
          return {
            date: r.date,
            amount,
            currency,
            category,
            kind,
            payer: Number(r.payer) === 1 ? 1 : 0,
            note: r.note || ""
          };
        });
        if (invalid.length) {
          setErr(t("csv_invalid_rows", {
            lines: invalid.slice(0, 10).join(", ") + (invalid.length > 10 ? "…" : "")
          }));
          setRows(null);
          return;
        }
        setRows(clean);
      } catch (e2) {
        setErr(t("csv_read_error") + e2.message);
        setRows(null);
      }
    };
    reader.readAsText(file);
  };
  const totalEur = rows ? rows.reduce((s, r) => s + toEUR(r.amount, r.currency, rates), 0) : 0;
  const byCategory = {};
  if (rows) rows.forEach(r => {
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
  });
  const runImport = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onImport(rows, (done, total) => setProgress({
        done,
        total
      }));
      setRows(null);
      setFileName("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 20,
      paddingTop: 16,
      borderTop: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("import_csv")), /*#__PURE__*/React.createElement("input", {
    ref: fileInputRef,
    type: "file",
    accept: ".csv",
    onChange: onFile
  }), err && /*#__PURE__*/React.createElement("div", {
    style: S.errBox
  }, err), rows && /*#__PURE__*/React.createElement("div", {
    style: S.privacyNote
  }, rows.length, t("rows_in"), fileName, t("total_approx"), fmt(totalEur, "EUR"), " · ", Object.entries(byCategory).map(([c, n]) => `${catLabel(c)}: ${n}`).join(", ")), rows && /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      marginTop: 8,
      opacity: busy ? 0.6 : 1
    },
    disabled: busy,
    onClick: runImport
  }, busy ? progress ? t("importing", {
    done: progress.done,
    total: progress.total
  }) : t("importing_short") : t("import_n", {
    n: rows.length
  })));
}

// ---------- Grocery list ----------
function GroceryList({
  hhId,
  user
}) {
  const [items, setItems] = useState([]);
  const [text, setText] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [err, setErr] = useState(null);
  const load = useCallback(async () => {
    const {
      data,
      error
    } = await db.from("groceries").select("*").eq("household_id", hhId).order("created_at");
    if (error) {
      setErr(error.message);
      return;
    }
    setErr(null);
    if (data) setItems(data);
  }, [hhId]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const ch = db.channel("groceries-" + hhId).on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "groceries",
      filter: `household_id=eq.${hhId}`
    }, load).subscribe();
    return () => db.removeChannel(ch);
  }, [hhId, load]);
  const add = async () => {
    const name = text.trim();
    if (!name) return;
    setText("");
    const tmpId = "tmp-" + Date.now();
    setItems(cur => [...cur, {
      id: tmpId,
      name,
      done: false
    }]);
    const {
      error
    } = await db.from("groceries").insert({
      household_id: hhId,
      name,
      created_by: user.id
    });
    if (error) {
      setErr(t("grocery_save_failed") + error.message);
      setItems(cur => cur.filter(i => i.id !== tmpId));
      setText(name);
      return;
    }
    load();
  };
  const toggle = async item => {
    setItems(cur => cur.map(i => i.id === item.id ? {
      ...i,
      done: !i.done
    } : i));
    await db.from("groceries").update({
      done: !item.done
    }).eq("id", item.id);
  };
  const remove = async id => {
    setItems(cur => cur.filter(i => i.id !== id));
    await db.from("groceries").delete().eq("id", id);
  };
  const clearAll = async () => {
    setConfirmClear(false);
    setItems([]);
    await db.from("groceries").delete().eq("household_id", hhId);
  };
  const remaining = items.filter(i => !i.done).length;
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    style: S.pageTitle
  }, t("grocery_list"), items.length > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 400,
      fontSize: 14,
      color: "var(--muted)"
    }
  }, " · ", t("to_get", {
    n: remaining
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("input", {
    style: {
      ...S.input,
      flex: 1
    },
    placeholder: t("grocery_ph"),
    value: text,
    maxLength: 80,
    onChange: e => setText(e.target.value),
    onKeyDown: e => {
      if (e.key === "Enter") add();
    }
  }), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      width: "auto",
      marginTop: 0,
      padding: "0 20px"
    },
    onClick: add
  }, t("add"))), err && /*#__PURE__*/React.createElement("div", {
    style: S.errBox
  }, err, /*#__PURE__*/React.createElement("br", null), err.includes("does not exist") && t("groceries_missing_table")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14
    }
  }, items.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: S.empty
  }, t("list_empty"), /*#__PURE__*/React.createElement("br", null), t("list_empty_hint")), items.map(item => /*#__PURE__*/React.createElement("div", {
    key: item.id,
    style: {
      ...S.expRow,
      opacity: item.done ? 0.55 : 1
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => toggle(item),
    style: {
      width: 26,
      height: 26,
      borderRadius: "50%",
      border: item.done ? "2px solid var(--green)" : "2px solid var(--line)",
      background: item.done ? "var(--green)" : "transparent",
      color: "var(--on-accent)",
      fontSize: 14,
      fontWeight: 700,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
      flexShrink: 0,
      padding: 0
    }
  }, item.done ? "✓" : ""), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      fontSize: 15,
      textDecoration: item.done ? "line-through" : "none",
      color: item.done ? "var(--muted)" : "var(--ink)",
      overflowWrap: "break-word"
    }
  }, item.name), /*#__PURE__*/React.createElement("button", {
    style: S.delBtn,
    onClick: () => remove(item.id)
  }, "×")))), items.length > 0 && (confirmClear ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 16
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      marginTop: 0,
      flex: 1,
      width: "auto",
      background: "var(--danger)"
    },
    onClick: clearAll
  }, t("clear_confirm")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      marginTop: 0,
      flex: 1,
      width: "auto"
    },
    onClick: () => setConfirmClear(false)
  }, t("cancel"))) : /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      marginTop: 16,
      color: "var(--danger)",
      borderColor: "var(--danger)"
    },
    onClick: () => setConfirmClear(true)
  }, t("clear_list"))));
}
// ---------- Calendar helpers ----------
const startOfDay = d => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const endOfDay = d => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const addMonthsD = (d, n) => {
  const x = new Date(d);
  x.setDate(1);
  x.setMonth(x.getMonth() + n);
  return x;
};
const ymdLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hhmmLocal = d => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
// Weeks run Monday -> Sunday.
const startOfWeek = d => {
  const x = startOfDay(d);
  return addDays(x, -((x.getDay() + 6) % 7));
};
const toLocalInput = d => `${ymdLocal(d)}T${hhmmLocal(d)}`;
const fromLocalInput = v => new Date(v);
const sameYmd = (a, b) => ymdLocal(a) === ymdLocal(b);
const eventColor = (e, colors) => colorForKind(e.kind, colors);
const ownerName = (e, people) => e.kind === "shared" ? t("shared") : e.kind === "p0" ? people[0] : people[1];

// 0 = Sunday ... 6 = Saturday, same convention as Date#getDay().
const isWeekendDate = d => {
  const dow = d.getDay();
  return dow === 0 || dow === 6;
};

// Expands recurring events into concrete occurrences inside [from, to].
// Guarded so a malformed rule can never loop away. "weekday" is its own
// recurrence rule (conceptually BYDAY=MO,TU,WE,TH,FR): it advances one day
// at a time like "daily", but Saturday/Sunday are never emitted as
// occurrences - this is a real exclusion in the rule itself, not "daily"
// with weekends hidden afterwards, so every consumer (rendering, badges,
// ICS export) sees the same skipped dates.
function expandEvents(rows, from, to) {
  const out = [];
  rows.forEach(e => {
    const s = new Date(e.starts_at);
    const en = new Date(e.ends_at);
    const dur = Math.max(0, en.getTime() - s.getTime());
    if (e.recurrence === "none") {
      if (en >= from && s <= to) out.push({
        ...e,
        _start: s,
        _end: en
      });
      return;
    }
    const until = e.recurrence_until ? endOfDay(new Date(e.recurrence_until + "T00:00:00")) : null;
    let cur = new Date(s);
    let guard = 0;
    while (cur <= to && guard++ < 500) {
      if (until && cur > until) break;
      const cEnd = new Date(cur.getTime() + dur);
      const skipsWeekend = e.recurrence === "weekday" && isWeekendDate(cur);
      if (!skipsWeekend && cEnd >= from) out.push({
        ...e,
        _start: new Date(cur),
        _end: cEnd,
        _recurring: true
      });
      if (e.recurrence === "daily" || e.recurrence === "weekday") cur = addDays(cur, 1);else if (e.recurrence === "weekly") cur = addDays(cur, 7);else if (e.recurrence === "biweekly") cur = addDays(cur, 14);else if (e.recurrence === "monthly") {
        const n = new Date(cur);
        n.setMonth(n.getMonth() + 1);
        cur = n;
      } else if (e.recurrence === "yearly") {
        const n = new Date(cur);
        n.setFullYear(n.getFullYear() + 1);
        cur = n;
      } else break;
    }
  });
  return out.sort((a, b) => a._start - b._start);
}
const eventsOnDay = (list, day) => list.filter(e => {
  const ds = startOfDay(day);
  const de = endOfDay(day);
  return e._start <= de && e._end >= ds;
});

// ---------- Calendar ----------
function Calendar({
  hhId,
  user,
  profile,
  people,
  colors,
  showToast
}) {
  const [view, setView] = useState("month");
  const [cursor, setCursor] = useState(() => new Date());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [modal, setModal] = useState(null);
  const mySlot = profile && (profile.slot === 0 || profile.slot === 1) ? profile.slot : 0;

  // Visible range for the current view.
  let from, to;
  if (view === "month") {
    from = startOfWeek(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
    to = endOfDay(addDays(from, 41));
  } else if (view === "week") {
    from = startOfWeek(cursor);
    to = endOfDay(addDays(from, 6));
  } else {
    from = startOfDay(cursor);
    to = endOfDay(cursor);
  }
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const load = useCallback(async () => {
    setLoading(true);
    // Fetch anything overlapping the range, plus every recurring series
    // (its parent row may start long before the visible window).
    const {
      data,
      error
    } = await db.from("calendar_events").select("*").eq("household_id", hhId).or(`recurrence.neq.none,and(ends_at.gte.${fromIso},starts_at.lte.${toIso})`).order("starts_at");
    setLoading(false);
    if (error) {
      setErr(error.message);
      return;
    }
    setErr(null);
    setRows(data || []);
  }, [hhId, fromIso, toIso]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const ch = db.channel("cal-" + hhId).on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "calendar_events",
      filter: `household_id=eq.${hhId}`
    }, load).subscribe();
    return () => db.removeChannel(ch);
  }, [hhId, load]);
  const events = expandEvents(rows, from, to);
  const canEdit = e => e.created_by === user.id || e.kind === "shared";
  const saveEvent = async form => {
    const payload = {
      household_id: hhId,
      title: form.title.trim(),
      description: form.description.trim() || null,
      location: form.location.trim() || null,
      starts_at: form.startsAt,
      ends_at: form.endsAt,
      all_day: form.allDay,
      kind: form.kind,
      recurrence: form.recurrence,
      recurrence_until: form.recurrenceUntil || null
    };
    if (form.id) {
      const {
        error
      } = await db.from("calendar_events").update(payload).eq("id", form.id);
      if (error) throw new Error(error.message);
      showToast(t("event_updated"));
    } else {
      payload.created_by = user.id;
      const {
        error
      } = await db.from("calendar_events").insert(payload);
      if (error) throw new Error(error.message);
      showToast(t("event_saved"));
    }
    setModal(null);
    load();
  };
  const deleteEvent = async id => {
    const {
      error
    } = await db.from("calendar_events").delete().eq("id", id);
    if (error) {
      showToast(t("save_failed") + error.message);
      return;
    }
    showToast(t("event_deleted"));
    setModal(null);
    load();
  };
  const shift = n => {
    if (view === "month") setCursor(addMonthsD(cursor, n));else if (view === "week") setCursor(addDays(cursor, 7 * n));else setCursor(addDays(cursor, n));
  };
  const headerLabel = () => {
    if (view === "month") return `${monthName(cursor.getMonth())} ${cursor.getFullYear()}`;
    if (view === "week") {
      const ws = startOfWeek(cursor);
      const we = addDays(ws, 6);
      return `${ws.getDate()} ${monthName(ws.getMonth()).slice(0, 3)} – ${we.getDate()} ${monthName(we.getMonth()).slice(0, 3)}`;
    }
    return `${window.I18N.weekdays()[(cursor.getDay() + 6) % 7]} ${cursor.getDate()} ${monthName(cursor.getMonth())}`;
  };
  const openNew = day => {
    const base = day ? new Date(day) : new Date();
    if (!day) base.setMinutes(0, 0, 0);else base.setHours(9, 0, 0, 0);
    const end = new Date(base.getTime() + 60 * 60 * 1000);
    setModal({
      mode: "edit",
      form: {
        id: null,
        title: "",
        description: "",
        location: "",
        startsAt: base.toISOString(),
        endsAt: end.toISOString(),
        allDay: false,
        kind: "shared",
        recurrence: "none",
        recurrenceUntil: ""
      }
    });
  };
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: S.calNav
  }, /*#__PURE__*/React.createElement("button", {
    style: S.iconBtn,
    onClick: () => shift(-1),
    "aria-label": "previous"
  }, "‹"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600,
      fontSize: 16,
      textAlign: "center",
      flex: 1
    }
  }, headerLabel()), /*#__PURE__*/React.createElement("button", {
    style: S.iconBtn,
    onClick: () => shift(1),
    "aria-label": "next"
  }, "›")), /*#__PURE__*/React.createElement("div", {
    style: {
      ...S.chipRow,
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6
    }
  }, ["month", "week", "day"].map(v => /*#__PURE__*/React.createElement("button", {
    key: v,
    style: {
      ...S.chip,
      ...(view === v ? S.chipOn : {})
    },
    onClick: () => setView(v)
  }, t("view_" + v)))), /*#__PURE__*/React.createElement("button", {
    style: S.chip,
    onClick: () => setCursor(new Date())
  }, t("today"))), err && /*#__PURE__*/React.createElement("div", {
    style: S.errBox
  }, t("events_load_failed"), err, /*#__PURE__*/React.createElement("br", null), (err.includes("does not exist") || err.includes("schema cache")) && t("calendar_missing_table")), loading && !rows.length ? /*#__PURE__*/React.createElement("div", {
    style: S.empty
  }, t("loading_events")) : view === "month" ? /*#__PURE__*/React.createElement(MonthGrid, {
    from: from,
    cursor: cursor,
    events: events,
    people: people,
    colors: colors,
    onDay: d => {
      setCursor(d);
      setView("day");
    },
    onEvent: e => setModal({
      mode: "view",
      event: e
    })
  }) : /*#__PURE__*/React.createElement(AgendaView, {
    view: view,
    from: from,
    events: events,
    people: people,
    colors: colors,
    onEvent: e => setModal({
      mode: "view",
      event: e
    })
  }), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      marginTop: 16
    },
    onClick: () => openNew(view === "day" ? cursor : null)
  }, "＋ " + t("add_event")), modal && modal.mode === "view" && /*#__PURE__*/React.createElement(EventDetail, {
    event: modal.event,
    people: people,
    colors: colors,
    canEdit: canEdit(modal.event),
    onClose: () => setModal(null),
    onEdit: () => setModal({
      mode: "edit",
      form: {
        id: modal.event.id,
        title: modal.event.title,
        description: modal.event.description || "",
        location: modal.event.location || "",
        startsAt: modal.event.starts_at,
        endsAt: modal.event.ends_at,
        allDay: modal.event.all_day,
        kind: modal.event.kind,
        recurrence: modal.event.recurrence,
        recurrenceUntil: modal.event.recurrence_until || ""
      }
    }),
    onDelete: () => deleteEvent(modal.event.id)
  }), modal && modal.mode === "edit" && /*#__PURE__*/React.createElement(EventForm, {
    initial: modal.form,
    people: people,
    mySlot: mySlot,
    onCancel: () => setModal(null),
    onSave: saveEvent
  }));
}

// ---------- Month grid ----------
function MonthGrid({
  from,
  cursor,
  events,
  people,
  colors,
  onDay,
  onEvent
}) {
  const today = new Date();
  const cells = [];
  for (let i = 0; i < 42; i++) cells.push(addDays(from, i));
  return /*#__PURE__*/React.createElement("div", {
    style: S.calCard
  }, /*#__PURE__*/React.createElement("div", {
    style: S.calWeekHead
  }, window.I18N.weekdays().map(w => /*#__PURE__*/React.createElement("div", {
    key: w,
    style: S.calWeekDay
  }, w))), /*#__PURE__*/React.createElement("div", {
    style: S.calGrid
  }, cells.map((d, i) => {
    const inMonth = d.getMonth() === cursor.getMonth();
    const isToday = sameYmd(d, today);
    const dayEvents = eventsOnDay(events, d);
    return /*#__PURE__*/React.createElement("button", {
      key: i,
      style: {
        ...S.calCell,
        opacity: inMonth ? 1 : 0.38
      },
      onClick: () => onDay(d)
    }, /*#__PURE__*/React.createElement("span", {
      style: isToday ? S.calDayNumToday : S.calDayNum
    }, d.getDate()), /*#__PURE__*/React.createElement("span", {
      style: S.calChips
    }, dayEvents.slice(0, 2).map((e, j) => /*#__PURE__*/React.createElement("span", {
      key: j,
      style: {
        ...S.calChip,
        background: eventColor(e, colors)
      },
      onClick: ev => {
        ev.stopPropagation();
        onEvent(e);
      }
    }, e.all_day ? e.title : `${hhmmLocal(e._start)} ${e.title}`)), dayEvents.length > 2 && /*#__PURE__*/React.createElement("span", {
      style: S.calMore
    }, "+", dayEvents.length - 2)));
  })));
}

// ---------- Week / day agenda ----------
function AgendaView({
  view,
  from,
  events,
  people,
  colors,
  onEvent
}) {
  const days = [];
  const count = view === "week" ? 7 : 1;
  for (let i = 0; i < count; i++) days.push(addDays(from, i));
  const today = new Date();
  const anyEvents = events.length > 0;
  if (!anyEvents) return /*#__PURE__*/React.createElement("div", {
    style: S.empty
  }, view === "week" ? t("no_events_week") : t("no_events_day"));
  return /*#__PURE__*/React.createElement("div", null, days.map((d, i) => {
    const dayEvents = eventsOnDay(events, d);
    if (view === "week" && !dayEvents.length) return null;
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        marginBottom: 10
      }
    }, view === "week" && /*#__PURE__*/React.createElement("div", {
      style: S.dayLabel
    }, window.I18N.weekdays()[(d.getDay() + 6) % 7], " ", d.getDate(), sameYmd(d, today) ? " · " + t("today") : ""), dayEvents.length === 0 ? /*#__PURE__*/React.createElement("div", {
      style: S.empty
    }, t("no_events_day")) : dayEvents.map((e, j) => /*#__PURE__*/React.createElement("button", {
      key: j,
      style: S.calRow,
      onClick: () => onEvent(e)
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        ...S.calRowBar,
        background: eventColor(e, colors)
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        minWidth: 0,
        textAlign: "left"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: S.calRowTitle
    }, e.title), /*#__PURE__*/React.createElement("span", {
      style: S.calRowSub
    }, e.all_day ? t("all_day") : `${hhmmLocal(e._start)} – ${hhmmLocal(e._end)}`, " · ", ownerName(e, people), e.location ? " · " + e.location : "")))));
  }));
}

// ---------- Event detail modal ----------
function EventDetail({
  event,
  people,
  colors,
  canEdit,
  onClose,
  onEdit,
  onDelete
}) {
  const [confirm, setConfirm] = useState(false);
  const owner = ownerName(event, people);
  return /*#__PURE__*/React.createElement("div", {
    style: S.modalWrap,
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: S.modalCard,
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 12,
      height: 12,
      borderRadius: 4,
      background: eventColor(event, colors),
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("h2", {
    style: {
      ...S.pageTitle,
      margin: 0,
      flex: 1
    }
  }, event.title)), /*#__PURE__*/React.createElement("div", {
    style: S.modalMeta
  }, event.all_day ? `${ymdLocal(event._start)} · ${t("all_day")}` : `${ymdLocal(event._start)} · ${hhmmLocal(event._start)} – ${hhmmLocal(event._end)}`), event.location && /*#__PURE__*/React.createElement("div", {
    style: S.modalMeta
  }, "📍 ", event.location), /*#__PURE__*/React.createElement("div", {
    style: S.modalMeta
  }, "👤 ", owner, event._recurring ? " · " + t("recurring_badge") : ""), event.description && /*#__PURE__*/React.createElement("div", {
    style: {
      ...S.modalMeta,
      whiteSpace: "pre-wrap",
      marginTop: 10,
      color: "var(--ink)"
    }
  }, event.description), !canEdit && /*#__PURE__*/React.createElement("div", {
    style: S.privacyNote
  }, t("readonly_event", {
    name: event.kind === "p0" ? people[0] : people[1]
  })), confirm ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 16
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      marginTop: 0,
      flex: 1,
      width: "auto",
      background: "var(--danger)"
    },
    onClick: onDelete
  }, t("delete_event")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      marginTop: 0,
      flex: 1,
      width: "auto"
    },
    onClick: () => setConfirm(false)
  }, t("cancel"))) : /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 16
    }
  }, canEdit && /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      marginTop: 0,
      flex: 1,
      width: "auto"
    },
    onClick: onEdit
  }, t("edit")), canEdit && /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      marginTop: 0,
      flex: 1,
      width: "auto",
      color: "var(--danger)",
      borderColor: "var(--danger)"
    },
    onClick: () => setConfirm(true)
  }, t("delete")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      marginTop: 0,
      flex: canEdit ? 0 : 1,
      width: "auto"
    },
    onClick: onClose
  }, t("close")))));
}

// ---------- Event create/edit form ----------
function EventForm({
  initial,
  people,
  mySlot,
  onCancel,
  onSave
}) {
  const [f, setF] = useState(() => ({
    ...initial,
    startsAt: toLocalInput(new Date(initial.startsAt)),
    endsAt: toLocalInput(new Date(initial.endsAt))
  }));
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(cur => ({
    ...cur,
    [k]: v
  }));
  const submit = async () => {
    if (!f.title.trim()) return setErr(t("event_title_required"));
    const s = fromLocalInput(f.allDay ? f.startsAt.slice(0, 10) + "T00:00" : f.startsAt);
    const e = f.allDay ? endOfDay(fromLocalInput(f.endsAt.slice(0, 10) + "T00:00")) : fromLocalInput(f.endsAt);
    if (isNaN(s) || isNaN(e)) return setErr(t("event_end_before_start"));
    if (e < s) return setErr(t("event_end_before_start"));
    setErr(null);
    setBusy(true);
    try {
      await onSave({
        ...f,
        title: f.title,
        startsAt: s.toISOString(),
        endsAt: e.toISOString()
      });
    } catch (e2) {
      setErr(t("save_failed") + (e2.message || String(e2)));
      setBusy(false);
    }
  };
  const dtType = f.allDay ? "date" : "datetime-local";
  const dtVal = v => f.allDay ? v.slice(0, 10) : v;
  return /*#__PURE__*/React.createElement("div", {
    style: S.modalWrap,
    onClick: onCancel
  }, /*#__PURE__*/React.createElement("div", {
    style: S.modalCard,
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      ...S.pageTitle,
      marginTop: 0
    }
  }, f.id ? t("edit_event") : t("new_event")), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("event_title")), /*#__PURE__*/React.createElement("input", {
    style: S.input,
    value: f.title,
    maxLength: 120,
    placeholder: t("event_title_ph"),
    onChange: e => set("title", e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("belongs_to")), /*#__PURE__*/React.createElement("div", {
    style: S.segWide
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(f.kind === "shared" ? S.segOn : {})
    },
    onClick: () => set("kind", "shared")
  }, t("shared")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(f.kind === "p0" ? S.segOnA : {})
    },
    onClick: () => set("kind", "p0")
  }, people[0]), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.segBtn,
      ...(f.kind === "p1" ? S.segOnB : {})
    },
    onClick: () => set("kind", "p1")
  }, people[1])), /*#__PURE__*/React.createElement("label", {
    style: S.switchRow
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: f.allDay,
    onChange: e => set("allDay", e.target.checked)
  }), /*#__PURE__*/React.createElement("span", null, t("all_day"))), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("starts")), /*#__PURE__*/React.createElement("input", {
    type: dtType,
    style: S.input,
    value: dtVal(f.startsAt),
    onChange: e => set("startsAt", f.allDay ? e.target.value + "T00:00" : e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("ends")), /*#__PURE__*/React.createElement("input", {
    type: dtType,
    style: S.input,
    value: dtVal(f.endsAt),
    onChange: e => set("endsAt", f.allDay ? e.target.value + "T00:00" : e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("event_location")), /*#__PURE__*/React.createElement("input", {
    style: S.input,
    value: f.location,
    maxLength: 120,
    placeholder: t("event_location_ph"),
    onChange: e => set("location", e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("event_desc")), /*#__PURE__*/React.createElement("textarea", {
    style: {
      ...S.input,
      minHeight: 70,
      resize: "vertical"
    },
    value: f.description,
    maxLength: 500,
    placeholder: t("event_desc_ph"),
    onChange: e => set("description", e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("repeats")), /*#__PURE__*/React.createElement("select", {
    style: S.input,
    value: f.recurrence,
    onChange: e => set("recurrence", e.target.value)
  }, ["none", "daily", "weekday", "weekly", "biweekly", "monthly", "yearly"].map(r => /*#__PURE__*/React.createElement("option", {
    key: r,
    value: r
  }, t("repeat_" + r)))), f.recurrence !== "none" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("repeat_until")), /*#__PURE__*/React.createElement("input", {
    type: "date",
    style: S.input,
    value: f.recurrenceUntil,
    onChange: e => set("recurrenceUntil", e.target.value)
  })), err && /*#__PURE__*/React.createElement("div", {
    style: S.errBox
  }, err), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.primaryBtn,
      opacity: busy ? 0.6 : 1
    },
    disabled: busy,
    onClick: submit
  }, busy ? t("saving") : t("save_event")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      marginTop: 8
    },
    onClick: onCancel
  }, t("cancel"))));
}

// ---------- ICS export (RFC 5545) ----------
const icsEscape = v => String(v == null ? "" : v).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsFold = line => {
  // RFC 5545 caps content lines at 75 octets; continuations start with a space.
  const out = [];
  let s = line;
  while (s.length > 73) {
    out.push(s.slice(0, 73));
    s = " " + s.slice(73);
  }
  out.push(s);
  return out.join("\r\n");
};
const icsStamp = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsDay = d => ymdLocal(d).replace(/-/g, "");
const icsRule = e => {
  const map = {
    daily: "FREQ=DAILY",
    weekday: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    weekly: "FREQ=WEEKLY",
    biweekly: "FREQ=WEEKLY;INTERVAL=2",
    monthly: "FREQ=MONTHLY",
    yearly: "FREQ=YEARLY"
  };
  const base = map[e.recurrence];
  if (!base) return null;
  if (!e.recurrence_until) return base;
  return `${base};UNTIL=${icsDay(new Date(e.recurrence_until + "T00:00:00"))}T235959Z`;
};
function buildIcs(rows, people) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//OurSpending//Shared Calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:OurSpending"];
  rows.forEach(e => {
    const s = new Date(e.starts_at);
    const en = new Date(e.ends_at);
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${e.id}@ourspending`);
    lines.push(`DTSTAMP:${icsStamp(new Date())}`);
    if (e.all_day) {
      lines.push(`DTSTART;VALUE=DATE:${icsDay(s)}`);
      lines.push(`DTEND;VALUE=DATE:${icsDay(addDays(en, 1))}`);
    } else {
      lines.push(`DTSTART:${icsStamp(s)}`);
      lines.push(`DTEND:${icsStamp(en)}`);
    }
    lines.push(icsFold(`SUMMARY:${icsEscape(e.title)}`));
    if (e.description) lines.push(icsFold(`DESCRIPTION:${icsEscape(e.description)}`));
    if (e.location) lines.push(icsFold(`LOCATION:${icsEscape(e.location)}`));
    const owner = e.kind === "shared" ? "Shared" : e.kind === "p0" ? people[0] : people[1];
    lines.push(icsFold(`CATEGORIES:${icsEscape(owner)}`));
    const rule = icsRule(e);
    if (rule) lines.push(`RRULE:${rule}`);
    lines.push("END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

// ---------- Calendar connections (Settings) ----------
// Providers needing OAuth are listed but stay disabled until server-side
// credentials exist — see supabase/CALENDAR_SETUP.md. Nothing is faked.
const OAUTH_PROVIDERS = ["google", "apple", "outlook"];
function CalendarSync({
  hhId,
  user,
  people,
  showToast
}) {
  const [conns, setConns] = useState([]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const load = useCallback(async () => {
    const {
      data,
      error
    } = await db.from("calendar_connections").select("*").eq("user_id", user.id);
    if (error) {
      setErr(error.message);
      return;
    }
    setErr(null);
    setConns(data || []);
  }, [user.id]);
  useEffect(() => {
    load();
  }, [load]);
  const exportIcs = async () => {
    setBusy(true);
    setInfo(null);
    try {
      const {
        data,
        error
      } = await db.from("calendar_events").select("*").eq("household_id", hhId).order("starts_at");
      if (error) throw new Error(error.message);
      if (!data || !data.length) {
        showToast(t("ics_nothing"));
        return;
      }
      const blob = new Blob([buildIcs(data, people)], {
        type: "text/calendar;charset=utf-8"
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ourspending.ics";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(t("ics_downloaded"));
    } catch (e2) {
      setErr(e2.message || String(e2));
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async id => {
    setConfirmId(null);
    const {
      error
    } = await db.from("calendar_connections").delete().eq("id", id);
    if (error) {
      setErr(error.message);
      return;
    }
    showToast(t("connection_removed"));
    load();
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 20,
      paddingTop: 16,
      borderTop: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: S.fieldLabel
  }, t("calendar_sync")), err && /*#__PURE__*/React.createElement("div", {
    style: S.errBox
  }, err), conns.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 10
    }
  }, conns.map(c => /*#__PURE__*/React.createElement("div", {
    key: c.id,
    style: S.syncRow
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: S.expTitle
  }, t("provider_" + c.provider)), /*#__PURE__*/React.createElement("div", {
    style: S.expSub
  }, t("sync_status_" + c.sync_status), c.last_synced_at ? " · " + t("last_synced") + timeAgo(c.last_synced_at) : "")), confirmId === c.id ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.miniBtn,
      ...S.miniDanger
    },
    onClick: () => disconnect(c.id)
  }, t("disconnect")), /*#__PURE__*/React.createElement("button", {
    style: S.miniBtn,
    onClick: () => setConfirmId(null)
  }, t("no"))) : /*#__PURE__*/React.createElement("button", {
    style: S.miniBtn,
    onClick: () => setConfirmId(c.id)
  }, t("disconnect"))))), conns.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: S.privacyNote
  }, t("no_connections")), /*#__PURE__*/React.createElement("button", {
    style: {
      ...S.ghostBtn,
      marginTop: 8,
      opacity: busy ? 0.6 : 1
    },
    disabled: busy,
    onClick: exportIcs
  }, "📅 " + t("export_ics")), /*#__PURE__*/React.createElement("div", {
    style: S.privacyNote
  }, t("export_ics_hint")), /*#__PURE__*/React.createElement("div", {
    style: {
      ...S.chipRow,
      marginTop: 10
    }
  }, OAUTH_PROVIDERS.map(p => /*#__PURE__*/React.createElement("button", {
    key: p,
    style: {
      ...S.chip,
      opacity: 0.65
    },
    onClick: () => setInfo(p)
  }, t("provider_" + p), " · ", t("setup_required")))), info && /*#__PURE__*/React.createElement("div", {
    style: S.okBox
  }, t("provider_" + info), ": ", t("setup_required_hint")));
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
    color: "var(--on-accent)"
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
    color: "var(--on-accent)"
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
    color: "var(--on-accent)"
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
    color: "var(--on-accent)"
  },
  segOnA: {
    background: "var(--blue)",
    color: "var(--on-accent)"
  },
  segOnB: {
    background: "var(--ochre)",
    color: "var(--on-accent)"
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
    background: "var(--tint-green)",
    fontWeight: 700
  },
  primaryBtn: {
    width: "100%",
    marginTop: 18,
    padding: 14,
    border: "none",
    borderRadius: 14,
    background: "var(--green-deep)",
    color: "var(--on-accent)",
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
    background: "var(--tint-danger)",
    padding: "8px 10px",
    borderRadius: 10
  },
  okBox: {
    color: "var(--green)",
    fontSize: 13,
    marginTop: 12,
    background: "var(--tint-green)",
    padding: "8px 10px",
    borderRadius: 10
  },
  calNav: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    margin: "4px 0 10px"
  },
  calCard: {
    background: "var(--card)",
    border: "1px solid var(--line)",
    borderRadius: 14,
    padding: 6,
    overflow: "hidden"
  },
  calWeekHead: {
    display: "flex"
  },
  calWeekDay: {
    flex: 1,
    textAlign: "center",
    fontSize: 10,
    fontWeight: 700,
    color: "var(--muted)",
    padding: "2px 0 4px",
    minWidth: 0
  },
  calGrid: {
    display: "flex",
    flexWrap: "wrap"
  },
  calCell: {
    width: "14.2857%",
    minHeight: 62,
    border: "none",
    background: "transparent",
    borderTop: "1px solid var(--line)",
    padding: "3px 2px",
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: 2,
    cursor: "pointer",
    minWidth: 0,
    overflow: "hidden",
    font: "inherit",
    color: "var(--ink)"
  },
  calDayNum: {
    fontSize: 11,
    color: "var(--muted)",
    textAlign: "left",
    paddingLeft: 2
  },
  calDayNumToday: {
    fontSize: 11,
    fontWeight: 800,
    color: "var(--on-accent)",
    background: "var(--green)",
    borderRadius: "50%",
    width: 18,
    height: 18,
    lineHeight: "18px",
    textAlign: "center",
    alignSelf: "flex-start"
  },
  calChips: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0
  },
  calChip: {
    fontSize: 9,
    lineHeight: 1.3,
    color: "var(--on-accent)",
    borderRadius: 4,
    padding: "1px 3px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "left"
  },
  calMore: {
    fontSize: 9,
    color: "var(--muted)",
    paddingLeft: 2,
    textAlign: "left"
  },
  calRow: {
    display: "flex",
    alignItems: "stretch",
    gap: 10,
    width: "100%",
    background: "var(--card)",
    border: "1px solid var(--line)",
    borderRadius: 12,
    padding: 10,
    marginBottom: 6,
    cursor: "pointer",
    font: "inherit",
    color: "var(--ink)",
    textAlign: "left"
  },
  calRowBar: {
    width: 4,
    borderRadius: 3,
    flexShrink: 0
  },
  calRowTitle: {
    display: "block",
    fontSize: 15,
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  },
  calRowSub: {
    display: "block",
    fontSize: 12,
    color: "var(--muted)",
    marginTop: 2
  },
  modalWrap: {
    position: "fixed",
    inset: 0,
    background: "var(--overlay)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    zIndex: 50
  },
  modalCard: {
    background: "var(--elevated)",
    border: "1px solid var(--line)",
    borderRadius: 18,
    padding: 20,
    width: "100%",
    maxWidth: 440,
    maxHeight: "88vh",
    overflowY: "auto",
    boxShadow: "var(--shadow-modal)"
  },
  modalMeta: {
    fontSize: 13,
    color: "var(--muted)",
    marginTop: 6
  },
  switchRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginTop: 12,
    fontSize: 14,
    cursor: "pointer"
  },
  syncRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "var(--card)",
    border: "1px solid var(--line)",
    borderRadius: 12,
    padding: 10,
    marginBottom: 6
  },
  toast: {
    position: "fixed",
    bottom: 92,
    left: "50%",
    transform: "translateX(-50%)",
    background: "var(--toast-bg)",
    color: "var(--toast-ink)",
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
    display: "grid",
    gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) auto minmax(0,1fr) minmax(0,1fr)",
    alignItems: "center",
    background: "var(--card)",
    borderTop: "1px solid var(--line)",
    padding: "6px 8px calc(8px + env(safe-area-inset-bottom))"
  },
  tabBtn: {
    minWidth: 0,
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
  tabLabel: {
    fontSize: 11,
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
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
    color: "var(--on-accent)",
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
