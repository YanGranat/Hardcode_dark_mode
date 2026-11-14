(function exposeRuntime(global) {
  const shared = ["shared/rules.js", "shared/site-utils.js", "shared/languages.js"];
  const content = [...shared, "shared/requests.js", "content/selectors.js", "content/cutout-geometry.js", "content/cutouts.js", "content/painter.js",
    "editor/translations.js", "editor/view.js", "editor/input.js", "editor/draft.js", "editor/picker.js", "editor/matches.js", "content/controller.js", "content/start.js"];
  global.HdmRuntime = { shared, content, boot: ["content/boot.js"], css: ["styles/universal.css"], shadow: ["content/shadow-bridge.js"] };
})(globalThis);
