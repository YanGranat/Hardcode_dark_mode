(function exposeRequests(global) {
  async function send(operation, timeout, timeoutError) {
    let timer;
    try {
      const response = await Promise.race([
        operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error(timeoutError)), timeout); })
      ]);
      if (!response?.ok) throw Error(response?.error || "worker_error");
      return response;
    } finally { clearTimeout(timer); }
  }
  global.HdmRequests = { send };
})(globalThis);
