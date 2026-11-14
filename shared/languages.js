(function exposeLanguages(global) {
  const options = Object.freeze([
    { code: "de", label: "Deutsch" },
    { code: "en", label: "English" },
    { code: "es", label: "Español" },
    { code: "ru", label: "Русский" },
    { code: "uk", label: "Українська" }
  ].map(Object.freeze));
  const codes = Object.freeze(options.map(({ code }) => code));
  const normalize = value => codes.includes(value) ? value : "en";
  const detect = value => normalize(typeof value === "string" ? value.toLowerCase().split(/[-_]/)[0] : value);
  global.HdmLanguages = { options, codes, normalize, detect };
})(globalThis);
