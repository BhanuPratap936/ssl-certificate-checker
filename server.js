// Public chat server: chat page + JSON API with simple commands.
require("dotenv").config();
const express = require("express");
const path = require("path");
const { checkDomain, getDomain } = require("./checker");
const sheets = require("./sheets");

const app = express();
app.set("trust proxy", 1); // correct client IPs behind Render's proxy
app.use(express.json({ limit: "2kb" }));
app.use(express.static(path.join(__dirname, "public")));

// In-memory rate limits per IP.
const buckets = { chat: new Map(), add: new Map(), upd: new Map() };
const lastUpdate = new Map(); // domain -> time of last /updateSiteStatus
function tooMany(kind, ip, max, windowMs) {
  const now = Date.now();
  const list = (buckets[kind].get(ip) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) return true;
  list.push(now);
  buckets[kind].set(ip, list);
  return false;
}
setInterval(() => { Object.values(buckets).forEach((b) => b.clear()); lastUpdate.clear(); }, 60 * 60 * 1000).unref();

const DOMAIN_RE = /(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})/gi;
const STRICT_DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/;
const NOT_SETUP = "Monitoring isn't set up on this server yet.";

const HELP = [
  "Commands (start with / or @):",
  "/check <site>: live certificate check",
  "/status: summary of all monitored sites",
  "/status <site>: latest saved status of one site",
  "/addDomain <site>: add a site to daily monitoring",
  "/updateSiteStatus <site>: re-check a monitored site now and update the Sheet",
  "/help: show this message",
  "",
  "You can also type a website name without a command.",
  "Sites can't be removed from chat.",
].join("\n");

async function checkMany(text) {
  const domains = [...new Set([...text.matchAll(DOMAIN_RE)].map((m) => getDomain(m[1])))]
    .filter(Boolean)
    .slice(0, 5);
  if (!domains.length) return { text: "Send a website, like example.com. I can check up to 5 at once. Type /help for commands." };
  const results = await Promise.all(
    domains.map(async (domain) => {
      try {
        return { domain, ...(await checkDomain(domain)) };
      } catch (e) {
        return { domain, status: "ERROR", error: e.message };
      }
    })
  );
  return { results };
}

function rowToResult(r) {
  const domain = sheets.rowDomain(r);
  const s = r[2] || "";
  if (!s) return { domain, status: "PENDING", error: "not checked yet; the next daily run will fill it in" };
  if (s.startsWith("ERROR")) return { domain, status: "ERROR", error: s.replace(/^ERROR:\s*/, "") };
  return { domain, status: s, days: r[3], expires: r[4], issuer: r[5] || "unknown" };
}

async function status(args) {
  if (!sheets.enabled()) return { text: NOT_SETUP };
  const rows = (await sheets.readRows()).filter((r) => r[0]);
  if (!args) {
    const n = { ok: 0, warn: 0, bad: 0, pending: 0 };
    rows.forEach((r) => {
      const s = r[2] || "";
      if (!s) n.pending++;
      else if (s === "OK") n.ok++;
      else if (s === "WARNING") n.warn++;
      else n.bad++;
    });
    return {
      text: `Monitoring ${rows.length} site(s).\nOK: ${n.ok}\nExpiring within 30 days: ${n.warn}\nNeeds action: ${n.bad}\nNot checked yet: ${n.pending}\n\nUse /status <site> for details.`,
    };
  }
  const domain = getDomain(args.split(/\s+/)[0]);
  const row = sheets.findRow(rows, domain);
  if (!row) return { text: `${domain || "That site"} isn't monitored yet. Add it with /addDomain ${domain || "example.com"}` };
  return { results: [rowToResult(row)] };
}

async function add(args, ip) {
  if (!sheets.enabled()) return { text: NOT_SETUP };
  const parts = args.split(/\s+/).filter(Boolean);
  const code = process.env.ADD_CODE; // optional access code
  if (code && parts[1] !== code) return { text: "Adding sites needs an access code: /addDomain example.com CODE" };
  const domain = getDomain(parts[0] || "");
  if (!STRICT_DOMAIN.test(domain)) return { text: "Usage: /addDomain example.com" };
  if (tooMany("add", ip, 5, 3600000)) return { text: "Limit reached: 5 additions per hour. Try again later." };
  try {
    const r = await sheets.addDomain(domain);
    if (!r.added) return { text: `${domain} wasn't added: ${r.reason}.` };
    return { text: `Added ${domain}. It will be checked every day. Its status right now:`, results: [{ domain, ...r.check }] };
  } catch (e) {
    if (e.isSite) return { text: `Couldn't add ${domain}: ${e.message}. The site must be public and serve HTTPS.` };
    console.error("Sheet error:", e.message);
    return { text: `Couldn't save ${domain} to the Sheet. This is a server setup problem, not your site. Please tell the admin to check the logs.` };
  }
}

async function update(args, ip) {
  if (!sheets.enabled()) return { text: NOT_SETUP };
  const domain = getDomain(args.split(/\s+/)[0] || "");
  if (!STRICT_DOMAIN.test(domain)) return { text: "Usage: /updateSiteStatus example.com" };
  if (Date.now() - (lastUpdate.get(domain) || 0) < 60000) {
    return { text: `${domain} was updated less than a minute ago. Please wait a moment.` };
  }
  if (tooMany("upd", ip, 10, 3600000)) return { text: "Limit reached: 10 updates per hour. Try again later." };
  try {
    const r = await sheets.updateDomain(domain);
    if (!r.updated) return { text: `${domain} isn't monitored yet. Add it with /addDomain ${domain}` };
    lastUpdate.set(domain, Date.now());
    return { text: `Checked ${domain} and updated the Sheet:`, results: [{ domain, ...r.result }] };
  } catch (e) {
    console.error("Sheet error:", e.message);
    return { text: `Couldn't update ${domain} in the Sheet. This is a server setup problem. Please tell the admin to check the logs.` };
  }
}

async function handle(message, ip) {
  const m = message.trim().match(/^[\/@](\w+)\s*([\s\S]*)$/);
  if (!m) return checkMany(message);
  const cmd = m[1].toLowerCase();
  const args = m[2].trim();
  if (cmd === "help") return { text: HELP };
  if (cmd === "check") return checkMany(args);
  if (cmd === "status") return status(args);
  if (cmd === "adddomain") return add(args, ip);
  if (cmd === "updatesitestatus") return update(args, ip);
  return { text: `Unknown command /${m[1]}. Type /help to see what I can do.` };
}

app.post("/api/chat", async (req, res) => {
  if (tooMany("chat", req.ip, 20, 60000)) return res.status(429).json({ text: "Too many messages. Try again in a minute." });
  const message = String((req.body && req.body.message) || "").slice(0, 500);
  try {
    res.json(await handle(message, req.ip));
  } catch (e) {
    console.error(e);
    res.json({ text: "Something went wrong. Please try again." });
  }
});

app.get("/health", (_req, res) => res.send("ok"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));