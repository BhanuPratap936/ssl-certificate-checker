require("dotenv").config()
const { google } = require("googleapis");
const nodemailer = require("nodemailer");
const { checkDomain, getDomain } = require("./checker");

async function sendAlert(problems) {
  const { SMTP_USER, SMTP_PASS, ALERT_TO } = process.env;
  if (!SMTP_USER || !SMTP_PASS || !ALERT_TO || !problems.length) return;
  const lines = problems.map(
    (r) => `- ${r[0]}: ${r[1]} (days left: ${r[2] === "" ? "n/a" : r[2]}, expires: ${r[3] || "n/a"})`
  );
  const mailer = nodemailer.createTransport({
    service: "gmail",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await mailer.sendMail({
    from: SMTP_USER,
    to: ALERT_TO,
    subject: `SSL alert: ${problems.length} certificate(s) need attention`,
    text: "These certificates need attention:\n\n" + lines.join("\n"),
  });
}

async function main() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = process.env.SHEET_ID;
  const tab = `'${process.env.SHEET_TAB || "Sheet1"}'`;

  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A2:B` });
  const rows = res.data.values || [];
  const now = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";

  const out = await Promise.all(
    rows.map(async (r) => {
      const url = (r[0] || "").trim();
      if (!url) return ["", "", "", "", "", ""];
      const domain = (r[1] || "").trim() || getDomain(url);
      try {
        const c = await checkDomain(domain);
        return [domain, c.status, c.days, c.expires, c.issuer, now];
      } catch (e) {
        return [domain, `ERROR: ${e.message}`, "", "", "", now];
      }
    })
  );

  if (out.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!B2:G${out.length + 1}`,
      valueInputOption: "RAW",
      requestBody: { values: out },
    });
  }
  await sendAlert(out.filter((r) => r[1] && r[1] !== "OK"));
  console.log(`Checked ${out.filter((r) => r[1]).length} site(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
