// OurSpending theme controller.
// Modes: "system" (follow prefers-color-scheme), "light", "dark".
// Resolution order: explicit user choice -> device/system preference.
// The chosen mode is stored in localStorage and stamped on <html data-theme>,
// which drives the semantic CSS tokens defined in index.html.
(function () {
  const KEY = "ourspending_theme";
  const root = document.documentElement;
  const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const listeners = new Set();

  function readStored() {
    try {
      const v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : "system";
    } catch (e) {
      return "system";
    }
  }

  let mode = readStored();

  function systemTheme() {
    return mq && mq.matches ? "dark" : "light";
  }

  function resolved() {
    return mode === "system" ? systemTheme() : mode;
  }

  function apply() {
    if (mode === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", mode);
    }
    const meta = document.querySelector('meta[name="theme-color"]:not([media])');
    if (meta) meta.setAttribute("content", resolved() === "dark" ? "#121714" : "#F3F6F1");
    listeners.forEach(fn => fn(mode, resolved()));
  }

  // Keep "system" mode live when the device flips between light/dark.
  if (mq && mq.addEventListener) {
    mq.addEventListener("change", () => {
      if (mode === "system") apply();
    });
  }

  window.THEME = {
    get mode() {
      return mode;
    },
    get resolved() {
      return resolved();
    },
    set(next) {
      if (next !== "light" && next !== "dark" && next !== "system") return;
      mode = next;
      try {
        if (next === "system") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, next);
      } catch (e) { /* ignore */ }
      apply();
    },
    // Cycles light -> dark -> system -> light
    cycle() {
      this.set(mode === "light" ? "dark" : mode === "dark" ? "system" : "light");
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };

  apply();
})();
