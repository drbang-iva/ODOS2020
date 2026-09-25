const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin === 'http://localhost:18103' && url.pathname === '/fhir/R4/ServiceRequest' && init?.method === 'POST') {
    throw Object.assign(new Error('W1 injected order write failure'), { status: 503 });
  }
  return realFetch(input, init);
};
