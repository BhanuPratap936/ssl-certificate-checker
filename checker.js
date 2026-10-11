const tls = require("tls");
const net = require("net");
const dns = require("dns").promises;

const WARN_DAYS = 30;
const CRIT_DAYS = 7;

// Block private/internal addresses so nobody can use this to probe a network.
const blocked = new net.BlockList();
[["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
 ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 4]]
  .forEach(([a, p]) => blocked.addSubnet(a, p, "ipv4"));
[["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]
  .forEach(([a, p]) => blocked.addSubnet(a, p, "ipv6"));

function getDomain(input) {
  const s = String(input).trim();
  try {
    return new URL(s.includes("://") ? s : "https://" + s).hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function resolvePublic(host) {
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => blocked.check(a.address, a.family === 6 ? "ipv6" : "ipv4"))) {
    throw new Error("not a public website");
  }
  return addrs[0]; // connect to the checked IP itself (prevents DNS tricks)
}

function readCert(ip, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: ip, port: 443, servername: host, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        const result = { cert, authError: socket.authorizationError };
        socket.end();
        resolve(result);
      }
    );
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("connection timed out")));
    socket.on("error", reject);
  });
}

async function checkDomain(host, timeoutMs = 10000) {
  const { address } = await resolvePublic(host);
  const { cert, authError } = await readCert(address, host, timeoutMs);
  if (!cert || !cert.valid_to) throw new Error("no certificate returned");

  const expires = new Date(cert.valid_to);
  const days = Math.floor((expires - Date.now()) / 86400000);
  let status = "OK";
  if (days < 0) status = "EXPIRED";
  else if (authError) status = "INVALID";
  else if (days <= CRIT_DAYS) status = "CRITICAL";
  else if (days <= WARN_DAYS) status = "WARNING";

  return {
    status,
    days,
    expires: expires.toISOString().slice(0, 10),
    issuer: (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || "unknown",
    note: status === "INVALID" ? String(authError) : "",
  };
}

module.exports = { checkDomain, getDomain };
