import nodemailer from "nodemailer";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}
export interface Mailer {
  send(mail: Mail): Promise<void>;
  /** Only the memory mailer keeps an outbox (tests / e2e). */
  outbox?: Mail[];
}

export function memoryMailer(): Mailer {
  const outbox: Mail[] = [];
  return { outbox, async send(m) { outbox.push(m); } };
}

export function smtpMailer(url: string, from: string): Mailer {
  const transport = nodemailer.createTransport(url);
  return {
    async send(m) {
      await transport.sendMail({ from, to: m.to, subject: m.subject, text: m.text, ...(m.attachments ? { attachments: m.attachments } : {}) });
    },
  };
}
