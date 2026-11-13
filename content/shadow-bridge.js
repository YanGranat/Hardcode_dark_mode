// Runs only in registered library documents, in the page's own JavaScript
// world. It reports newly created open roots without reading their contents.
(() => {
  const key = "__hdmShadowBridge";
  if (globalThis[key]) return;
  let active = true;
  let original;
  let wrapper;
  function install() {
    active = true;
    if (Element.prototype.attachShadow === wrapper) return;
    original = Element.prototype.attachShadow;
    const predecessor = original;
    wrapper = function (options) {
      const root = Reflect.apply(predecessor, this, [options]);
      if (active && root.mode === "open") {
        this.dispatchEvent(new CustomEvent("hdm-shadow-root", { bubbles: true, composed: true }));
      }
      return root;
    };
    Element.prototype.attachShadow = wrapper;
  }
  document.addEventListener("hdm-shadow-enable", install);
  document.addEventListener("hdm-shadow-disable", () => {
    active = false;
    if (Element.prototype.attachShadow === wrapper) Element.prototype.attachShadow = original;
  });
  globalThis[key] = true;
  install();
})();
