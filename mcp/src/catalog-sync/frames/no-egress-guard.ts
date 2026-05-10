import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";

const BLOCKED_VENDOR_HOST = "framesdata.com";
let installed = false;

export function installFramesDataNoEgressGuard(): void {
  if (installed) {
    return;
  }
  installed = true;

  const originalLookup = dns.lookup.bind(dns);
  dns.lookup = ((hostname: string, ...rest: unknown[]) => {
    assertNotFramesDataHost(hostname);
    return (originalLookup as (...args: unknown[]) => unknown)(hostname, ...rest);
  }) as typeof dns.lookup;

  const originalNetConnect = net.connect.bind(net);
  net.connect = ((...args: unknown[]) => {
    assertSocketArgs(args);
    return (originalNetConnect as (...inner: unknown[]) => net.Socket)(...args);
  }) as typeof net.connect;

  const originalTlsConnect = tls.connect.bind(tls);
  tls.connect = ((...args: unknown[]) => {
    assertSocketArgs(args);
    return (originalTlsConnect as (...inner: unknown[]) => tls.TLSSocket)(...args);
  }) as typeof tls.connect;
}

export function assertNotFramesDataHost(hostname: string | undefined): void {
  if (!hostname) {
    return;
  }
  const normalized = hostname.toLowerCase();
  if (normalized === BLOCKED_VENDOR_HOST || normalized.endsWith(`.${BLOCKED_VENDOR_HOST}`)) {
    throw new Error(`Frames Data egress blocked by v0.6a bulk-file-ingest boundary: ${hostname}`);
  }
}

function assertSocketArgs(args: readonly unknown[]): void {
  const first = args[0];
  if (typeof first === "string") {
    assertNotFramesDataHost(new URL(first).hostname);
    return;
  }
  if (typeof first === "object" && first) {
    const options = first as { host?: string; hostname?: string };
    assertNotFramesDataHost(options.host ?? options.hostname);
  }
}
