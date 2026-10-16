// Envoi des alertes côté serveur Node : canaux HTTP communs + e-mail SMTP (nodemailer).
import nodemailer from 'nodemailer';
import { NOTIFIER_TYPES, senders } from '../shared/notifiers.js';

export { NOTIFIER_TYPES };

const nodeSenders = {
  ...senders,
  async email(n, msg) {
    const transport = nodemailer.createTransport({
      host: n.host,
      port: Number(n.port) || 587,
      secure: Boolean(n.secure),
      auth: n.username ? { user: n.username, pass: n.password } : undefined,
      tls: { rejectUnauthorized: !n.ignoreTls },
      connectionTimeout: 15_000,
    });
    await transport.sendMail({
      from: n.from || n.username,
      to: n.to,
      subject: `[Vigie] ${msg.title}`,
      text: `${msg.text}\n\n— Vigie`,
    });
  },
};

export async function send(notifier, msg) {
  const fn = nodeSenders[notifier.type];
  if (!fn) throw new Error(`Type de notification inconnu : ${notifier.type}`);
  await fn(notifier, msg);
}
