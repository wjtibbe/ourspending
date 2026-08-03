// Deterministic category mapping for imported bank transactions.
//
// The app's category keys are the source of truth (they match
// BUILTIN_CATEGORIES in app.js). A provider's own category names are never
// copied in and never create new categories — they are only ever *mapped* onto
// a key that already exists here. Anything unrecognised lands on "other".
//
// There is no AI in this path. The repo's only AI integration is scan-receipt,
// which is image-only, so there is no existing text categoriser to fall back
// on and none is introduced.

export const APP_CATEGORIES = [
  "groceries", "snacks", "dining", "household", "rent", "transport", "travel",
  "health", "subscriptions", "clothing", "entertainment", "gifts",
  "personalcare", "other",
] as const;

export type AppCategory = (typeof APP_CATEGORIES)[number];
export const FALLBACK_CATEGORY: AppCategory = "other";

// Lowercase, strip accents and punctuation, collapse whitespace. This is what
// makes "Transporte", "TRANSPORT" and "transport." the same lookup key, and
// what lets one alias table serve English, Spanish and Dutch at once.
export function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// One canonical key per concept. Adding a language means adding words here,
// never adding a category.
const ALIAS_GROUPS: Record<AppCategory, string[]> = {
  groceries: [
    "groceries", "grocery", "grocery store", "supermarket", "supermarkets",
    "food store", "food and groceries",
    "boodschappen", "supermarkt", "kruidenier", "levensmiddelen",
    "supermercado", "mercado", "abarrotes", "comestibles", "tienda",
  ],
  snacks: [
    "snacks", "snack", "drinks", "beverages", "coffee", "coffee shop", "cafe",
    "kiosk", "convenience store",
    "snoep", "frisdrank", "koffie", "tussendoortjes",
    "bebidas", "cafeteria", "refrescos", "botanas", "dulces",
  ],
  dining: [
    "dining", "dining out", "restaurant", "restaurants", "restaurants and bars",
    "bars", "bar", "pub", "fast food", "takeaway", "take away", "food delivery",
    "eating out", "food and drink",
    "uit eten", "eten bestellen", "afhaal", "eetcafe",
    "restaurante", "restaurantes", "comida", "comida rapida", "cena", "almuerzo",
  ],
  household: [
    "household", "home", "home improvement", "hardware", "hardware store",
    "furniture", "cleaning", "diy", "garden", "appliances",
    "huishouden", "huis", "schoonmaak", "meubels", "tuin", "klussen",
    "hogar", "casa", "limpieza", "muebles", "ferreteria", "jardin",
  ],
  rent: [
    "rent", "rent and fixed", "housing", "mortgage", "utilities",
    "bills", "bills and utilities", "electricity", "water", "internet",
    "phone bill", "insurance",
    "huur", "hypotheek", "vaste lasten", "nutsvoorzieningen", "energie",
    "verzekering",
    "alquiler", "renta", "hipoteca", "servicios publicos", "facturas",
    "electricidad", "agua", "seguro",
  ],
  transport: [
    "transport", "transportation", "transports", "taxi", "taxis", "cab", "cabs",
    "ride sharing", "ridesharing", "ride hailing", "rideshare",
    "uber", "didi", "indrive", "cabify", "lyft", "bolt", "beat",
    "public transport", "public transportation", "transit", "bus", "metro",
    "subway", "train", "rail", "fuel", "gas station", "gasoline", "petrol",
    "parking", "toll", "tolls", "car", "automotive",
    "vervoer", "openbaar vervoer", "trein", "benzine", "brandstof", "parkeren",
    "tanken", "ov",
    "transporte", "transporte publico", "gasolina", "combustible",
    "estacionamiento", "parqueadero", "peaje", "taxis",
  ],
  travel: [
    "travel", "trips", "trip", "flight", "flights", "airline", "airlines",
    "airfare", "hotel", "hotels", "accommodation", "lodging", "holiday",
    "vacation", "car rental", "tourism",
    "reizen", "reis", "vliegticket", "vliegreis", "vakantie", "hotels",
    "huurauto",
    "viajes", "viaje", "vuelos", "aerolinea", "alojamiento", "vacaciones",
    "hospedaje", "turismo",
  ],
  health: [
    "health", "healthcare", "health care", "medical", "pharmacy", "drugstore",
    "doctor", "dentist", "hospital", "clinic", "optician", "therapy",
    "gezondheid", "apotheek", "dokter", "huisarts", "tandarts", "ziekenhuis",
    "kliniek",
    "salud", "farmacia", "droguería", "drogueria", "medico", "dentista",
    "hospital", "clinica", "eps",
  ],
  subscriptions: [
    "subscriptions", "subscription", "streaming", "software", "saas",
    "membership", "memberships", "cloud", "hosting", "domain", "app store",
    "abonnementen", "abonnement", "lidmaatschap",
    "suscripciones", "suscripcion", "membresia", "membresias",
  ],
  clothing: [
    "clothing", "clothes", "apparel", "fashion", "shoes", "footwear",
    "accessories", "jewellery", "jewelry",
    "kleding", "kleren", "schoenen", "mode", "sieraden",
    "ropa", "vestimenta", "zapatos", "moda", "calzado", "accesorios",
  ],
  entertainment: [
    "entertainment", "leisure", "cinema", "movies", "music", "concerts",
    "games", "gaming", "sports", "events", "nightlife", "books", "hobbies",
    "vermaak", "uitgaan", "bioscoop", "films", "muziek", "spellen", "sport",
    "boeken", "hobby",
    "entretenimiento", "ocio", "cine", "peliculas", "musica", "juegos",
    "deportes", "eventos", "libros",
  ],
  gifts: [
    "gifts", "gift", "presents", "donation", "donations", "charity", "tips",
    "cadeaus", "cadeau", "geschenken", "donaties", "goede doel", "fooi",
    "regalos", "regalo", "donaciones", "caridad", "propina",
  ],
  personalcare: [
    "personal care", "personalcare", "beauty", "cosmetics", "hairdresser",
    "barber", "salon", "spa", "gym", "fitness", "wellness", "grooming",
    "persoonlijke verzorging", "kapper", "schoonheid", "sportschool",
    "verzorging",
    "cuidado personal", "belleza", "cosmeticos", "peluqueria", "barberia",
    "gimnasio", "estetica",
  ],
  other: [
    "other", "others", "uncategorized", "uncategorised", "miscellaneous",
    "misc", "general", "shopping", "services", "cash", "atm", "transfers",
    "transfer", "withdrawal", "unknown",
    "overig", "overige", "ongecategoriseerd", "divers", "opname", "overboeking",
    "otros", "otro", "sin categoria", "varios", "retiro", "transferencia",
  ],
};

// Flattened once at module load: normalized alias -> app category key.
const ALIASES: Map<string, AppCategory> = (() => {
  const m = new Map<string, AppCategory>();
  for (const key of Object.keys(ALIAS_GROUPS) as AppCategory[]) {
    // The category key itself always maps to itself.
    m.set(normalize(key), key);
    for (const alias of ALIAS_GROUPS[key]) {
      const n = normalize(alias);
      if (n) m.set(n, key);
    }
  }
  return m;
})();

// Merchant Category Codes, where a provider supplies one. Ranges first, exact
// codes second, so an unknown code inside a known range still resolves.
const MCC_RANGES: Array<[number, number, AppCategory]> = [
  [3000, 3299, "travel"],       // airlines
  [3300, 3499, "transport"],    // car rental
  [3500, 3999, "travel"],       // lodging
  [4111, 4131, "transport"],    // commuter transport, taxis, bus
  [5811, 5814, "dining"],
  [5960, 5969, "subscriptions"],
  [7011, 7011, "travel"],
  [7832, 7841, "entertainment"],
  [7991, 7998, "entertainment"],
];

const MCC_EXACT: Record<number, AppCategory> = {
  4121: "transport", 4457: "travel", 4468: "travel", 4511: "travel",
  4582: "travel", 4722: "travel", 4784: "transport", 4789: "transport",
  4812: "subscriptions", 4814: "rent", 4816: "subscriptions",
  4899: "subscriptions", 4900: "rent",
  5411: "groceries", 5422: "groceries", 5441: "snacks", 5451: "groceries",
  5462: "snacks", 5499: "groceries",
  5541: "transport", 5542: "transport", 5533: "transport", 5571: "transport",
  5611: "clothing", 5621: "clothing", 5631: "clothing", 5641: "clothing",
  5651: "clothing", 5661: "clothing", 5691: "clothing", 5699: "clothing",
  5712: "household", 5719: "household", 5722: "household", 5200: "household",
  5211: "household", 5231: "household", 5251: "household", 5261: "household",
  5732: "subscriptions", 5734: "subscriptions", 5815: "subscriptions",
  5816: "subscriptions", 5817: "subscriptions", 5818: "subscriptions",
  5912: "health", 5122: "health", 5975: "health", 5976: "health",
  5940: "entertainment", 5941: "entertainment", 5942: "entertainment",
  5945: "entertainment", 5192: "entertainment",
  5947: "gifts", 8398: "gifts",
  5977: "personalcare", 7230: "personalcare", 7297: "personalcare",
  7298: "personalcare", 7995: "entertainment",
  7372: "subscriptions", 7392: "subscriptions",
  8011: "health", 8021: "health", 8031: "health", 8041: "health",
  8042: "health", 8049: "health", 8062: "health", 8071: "health",
  8099: "health", 8043: "health",
  8211: "other", 8220: "other", 8351: "other",
  6513: "rent",
};

export type CategorySource =
  | "provider_category"
  | "merchant_category"
  | "mcc"
  | "description"
  | "fallback";

export type CategoryResolution = {
  category: AppCategory;
  source: CategorySource;
  /** The provider value that produced the match, for auditing. */
  matched: string | null;
};

export type CategoryInput = {
  /** The provider's own category name, e.g. Wise details.category. */
  providerCategory?: unknown;
  /** A merchant-level category name, if the provider supplies one. */
  merchantCategory?: unknown;
  /** Merchant Category Code, numeric or numeric string. */
  mcc?: unknown;
  /** Free text: transaction description, merchant name. Lowest confidence. */
  description?: unknown;
};

function lookupText(value: unknown): AppCategory | null {
  const n = normalize(value);
  if (!n) return null;
  const direct = ALIASES.get(n);
  if (direct) return direct;

  // Multi-word provider labels ("Restaurants and Bars", "Transporte publico")
  // often contain a known alias as a phrase. Try the longest phrases first so
  // "public transport" wins over "transport" would-be ties, then single words.
  const words = n.split(" ");
  for (let size = Math.min(3, words.length); size >= 1; size--) {
    for (let i = 0; i + size <= words.length; i++) {
      const phrase = words.slice(i, i + size).join(" ");
      // Single short words are too noisy to trust (e.g. "bar" inside "barco").
      if (size === 1 && phrase.length < 3) continue;
      const hit = ALIASES.get(phrase);
      if (hit) return hit;
    }
  }
  return null;
}

function lookupMcc(value: unknown): AppCategory | null {
  const code = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(code)) return null;
  if (MCC_EXACT[code]) return MCC_EXACT[code];
  for (const [lo, hi, cat] of MCC_RANGES) {
    if (code >= lo && code <= hi) return cat;
  }
  return null;
}

/**
 * Resolve a provider's categorisation onto an existing app category.
 *
 * `allowed` is the set of category keys the household actually has switched on.
 * If a mapping lands on a category the household disabled, the result falls
 * back rather than resurrecting a category the household chose to hide.
 *
 * This function never throws: a categorisation problem must never stop an
 * import, so the worst case is FALLBACK_CATEGORY.
 */
export function resolveCategory(
  input: CategoryInput,
  allowed?: Set<string> | null,
): CategoryResolution {
  const permitted = (c: AppCategory) => !allowed || allowed.has(c);

  try {
    const attempts: Array<[CategorySource, unknown, AppCategory | null]> = [
      ["provider_category", input.providerCategory, lookupText(input.providerCategory)],
      ["merchant_category", input.merchantCategory, lookupText(input.merchantCategory)],
      ["mcc", input.mcc, lookupMcc(input.mcc)],
      ["description", input.description, lookupText(input.description)],
    ];

    for (const [source, raw, hit] of attempts) {
      if (hit && permitted(hit)) {
        return { category: hit, source, matched: raw == null ? null : String(raw) };
      }
    }
  } catch {
    // Fall through to the fallback below.
  }

  return { category: FALLBACK_CATEGORY, source: "fallback", matched: null };
}
