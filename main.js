/* Runs in the page itself (not the extension's isolated world), before the page's own scripts:
 * records which input events the page listens to (pointer* and/or mouse*), so ArtKit's Fill can
 * send exactly the kind the page draws with - sending both would draw everything twice. */
(() => {
  const seen = new Set();
  const orig = EventTarget.prototype.addEventListener;
  const publish = () => {
    const el = document.documentElement;
    if (el) el.dataset.artkitListens = [...seen].join(",");
  };
  EventTarget.prototype.addEventListener = function (type, ...rest) {
    if (typeof type === "string" && /^(pointer|mouse)(down|move|up)$/.test(type)) {
      const fam = type.startsWith("pointer") ? "pointer" : "mouse";
      if (!seen.has(fam)) { seen.add(fam); publish(); }
    }
    return orig.call(this, type, ...rest);
  };
  document.addEventListener("DOMContentLoaded", publish);
})();
