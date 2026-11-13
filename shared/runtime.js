(function exposeRuntime(global) {
  const shared = ["shared/rules.js", "shared/site-utils.js"];
  const content = [...shared, "shared/requests.js", "content/selectors.js", "content/cutouts.js", "content/painter.js",
    "editor/view.js", "editor/input.js", "editor/picker.js", "editor/matches.js", "content/controller.js", "content/start.js"];
  global.HdmRuntime = { shared, content, boot: ["content/boot.js"], css: ["styles/universal.css"], shadow: ["content/shadow-bridge.js"] };
})(globalThis);
