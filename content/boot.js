// Registered only for enabled whole-page sites. Marking the root here, before the
// first paint, avoids a light flash while the controller reads the library; the
// controller then confirms or withdraws these markers.
(() => {
  // A frame matched through its creator (about:, blob:, data:) is left to the
  // controller, which resolves whose site such a document belongs to.
  if (!/^https?:$/.test(location.protocol)) return;
  // "dmx-boot" paints the canvas until the controller has looked at the real page.
  const mark = root => root.classList.add("dmx-site", "dmx-site-universal", "dmx-on", "dmx-boot");
  if (document.documentElement) return mark(document.documentElement);
  const observer = new MutationObserver(() => {
    if (!document.documentElement) return;
    observer.disconnect();
    mark(document.documentElement);
  });
  observer.observe(document, { childList: true });
})();
