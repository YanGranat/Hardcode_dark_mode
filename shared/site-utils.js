(function exposeSiteUtils(global) {
  const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);
  const SCRIPT_PREFIX = "hdm-universal-";
  function isRestrictedPage(url) {
    return url.hostname === "chromewebstore.google.com" ||
      (url.hostname === "chrome.google.com" && url.pathname.startsWith("/webstore"));
  }

  // The origin itself is the identifier: a hash could give two sites the same one.
  const scriptId = origin => SCRIPT_PREFIX + origin;

  function fromUrl(value) {
    try {
      const url = new URL(value);
      if (!SUPPORTED_PROTOCOLS.has(url.protocol) || isRestrictedPage(url)) {
        return { supported: false, reason: "restricted" };
      }

      const hostname = url.hostname.toLowerCase();
      // "*" parses as a host name but would be a match pattern for every site.
      if (!hostname || hostname.includes("*")) return { supported: false, reason: "invalid" };
      // Chrome match patterns cannot isolate ports. Treat every port on a host
      // as one library entry so stored state matches actual script scope.
      const origin = `${url.protocol}//${hostname}`;
      return {
        supported: true,
        origin,
        hostname,
        label: hostname.replace(/^www\./, ""),
        matchPattern: `${url.protocol}//${hostname}/*`,
        scriptId: scriptId(origin)
      };
    } catch (error) {
      return { supported: false, reason: "invalid" };
    }
  }

  function normalizeStoredSite(value) {
    if (!value || typeof value.origin !== "string") {
      return null;
    }

    const site = fromUrl(value.origin);
    if (!site.supported) {
      return null;
    }

    return {
      origin: site.origin,
      hostname: site.hostname,
      label: site.label,
      matchPattern: site.matchPattern,
      scriptId: site.scriptId,
      enabled: value.enabled !== false,
      mode: value.mode === "selected" ? "selected" : "page",
      exclusions: HdmRules.normalizeExclusions(value.exclusions),
      inclusions: HdmRules.normalizeInclusions(value.inclusions),
      protections: HdmRules.normalizeExclusions(value.protections),
      addedAt: Number.isFinite(value.addedAt) && value.addedAt > 0 ? value.addedAt : 0
    };
  }

  function normalizeLibrary(value) {
    const seen = new Set();
    return (Array.isArray(value) ? value : []).map(normalizeStoredSite).filter(site => {
      if (!site || seen.has(site.origin)) return false;
      seen.add(site.origin);
      return true;
    });
  }

  global.HdmSites = {
    fromUrl,
    normalizeStoredSite,
    normalizeLibrary,
    ownsRegistration: id => typeof id === "string" && id.startsWith(SCRIPT_PREFIX)
  };
})(globalThis);
