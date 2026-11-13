(() => {
  const controllerKey = "__hardcodeDarkModeUniversalController";
  if (globalThis[controllerKey]?.refresh) {
    globalThis[controllerKey].refresh();
    return;
  }
  globalThis[controllerKey] = HdmThemeController.create();
  globalThis[controllerKey].refresh();
})();
