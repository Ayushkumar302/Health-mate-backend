import nodemailer from "nodemailer";

// Sends emails through the SMTP server in .env (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, e.g. Gmail with an
// App Password). Without one it uses an Ethereal test inbox (https://ethereal.email): nothing reaches a real
// inbox, and each email gets a preview link instead, which the demo shows on screen.

let transportPromise;

export const usingTestInbox = () => !process.env.SMTP_HOST;

const createTransport = async () => {
  if (!usingTestInbox()) {
    const port = Number(process.env.SMTP_PORT) || 587;
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  const account = await nodemailer.createTestAccount();
  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.user, pass: account.pass },
  });
};

const getTransport = () => {
  transportPromise ||= createTransport().catch(error => {
    transportPromise = null; // try again next time
    throw error;
  });
  return transportPromise;
};

// returns { previewUrl } when the test inbox is used
export const sendMail = async ({ to, subject, text, html }) => {
  const transport = await getTransport();
  const info = await transport.sendMail({
    from: process.env.MAIL_FROM || "Medora <no-reply@medora.health>",
    to,
    subject,
    text,
    html,
  });
  return { previewUrl: usingTestInbox() ? nodemailer.getTestMessageUrl(info) || undefined : undefined };
};

const escapeHtml = text => String(text).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

// one simple branded layout for every email: greeting, a paragraph, a button, a note
export const actionEmail = ({ name, intro, button, url, note }) => ({
  text: `Hi ${name},\n\n${intro}\n\n${button}: ${url}\n\n${note}\n\nMedora`,
  html: `
  <div style="font-family:Arial,Helvetica,sans-serif;background:#f3f7fb;padding:32px 16px">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;border:1px solid #e2e8f0">
      <p style="margin:0 0 24px;font-size:20px;font-weight:bold;color:#3674AB">Medora</p>
      <p style="margin:0 0 12px;font-size:16px;color:#0f172a">Hi ${escapeHtml(name)},</p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#334155">${escapeHtml(intro)}</p>
      <a href="${escapeHtml(url)}" style="display:inline-block;background:#3674AB;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:999px">${escapeHtml(button)}</a>
      <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#64748b">${escapeHtml(note)}</p>
      <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;word-break:break-all">${escapeHtml(url)}</p>
    </div>
  </div>`,
});
