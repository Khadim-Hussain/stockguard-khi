import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
  console.warn("⚠️ SMTP credentials missing. Email campaign feature will not work.");
}

export async function sendProductEmail({ recipients, product }) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
      ${product.image ? `<img src="${product.image}" alt="${product.title}" style="width:100%;max-height:300px;object-fit:cover;border-radius:8px;margin-bottom:20px"/>` : ""}
      <h1 style="color:#333;font-size:24px">${product.title}</h1>
      <div style="color:#555;font-size:16px;line-height:1.6;margin:16px 0">${product.description || "No description available."}</div>
      ${product.price ? `<p style="font-size:20px;font-weight:bold;color:#008060">Price: $${product.price}</p>` : ""}
      <hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>
      <p style="color:#999;font-size:12px">This email was sent via StockGuard Marketing Tool</p>
    </div>
  `;

  const isBulk = recipients.length > 1;

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: isBulk ? process.env.SMTP_FROM || process.env.SMTP_USER : recipients[0],
    bcc: isBulk ? recipients.join(",") : undefined,
    subject: `Check out: ${product.title}`,
    html,
  });
}
