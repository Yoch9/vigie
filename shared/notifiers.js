// Canaux d'alerte communs au serveur Node et au Worker Cloudflare : uniquement des appels HTTP (fetch).
// Chaque canal reçoit un message { kind, title, text, monitor } et lève une exception explicite en cas d'échec.

// Description des canaux : champs saisis dans l'interface, champs secrets (jamais renvoyés au navigateur)
// et champs obligatoires.
export const NOTIFIER_TYPES = {
  email: {
    label: 'E-mail (SMTP)',
    fields: ['host', 'port', 'username', 'password', 'from', 'to'],
    flags: ['secure', 'ignoreTls'],
    secrets: ['password'],
    required: ['host', 'to'],
  },
  emailapi: {
    label: 'E-mail (API Brevo ou Resend)',
    fields: ['provider', 'apiKey', 'from', 'to'],
    secrets: ['apiKey'],
    required: ['apiKey', 'from', 'to'],
  },
  teams: { label: 'Microsoft Teams (workflow webhook)', fields: ['webhookUrl'], secrets: ['webhookUrl'], required: ['webhookUrl'] },
  slack: { label: 'Slack', fields: ['webhookUrl'], secrets: ['webhookUrl'], required: ['webhookUrl'] },
  discord: { label: 'Discord', fields: ['webhookUrl'], secrets: ['webhookUrl'], required: ['webhookUrl'] },
  telegram: { label: 'Telegram', fields: ['botToken', 'chatId'], secrets: ['botToken'], required: ['botToken', 'chatId'] },
  ntfy: { label: 'ntfy (notification mobile)', fields: ['server', 'topic', 'token'], secrets: ['token'], required: ['topic'] },
  webhook: { label: 'Webhook JSON', fields: ['url'], secrets: [], required: ['url'] },
};

const COLORS = { down: 'attention', up: 'good', cert: 'warning', test: 'accent' };

export async function post(url, body, headers = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // fetch() ne donne que « fetch failed » : la vraie raison est dans err.cause
    const cause = err.cause?.code || err.cause?.message;
    if (err.name === 'TimeoutError') throw new Error('Délai dépassé (15 s)');
    if (cause || /network connection lost/i.test(err.message)) throw new Error(`${new URL(url).host} injoignable${cause ? ` (${cause})` : ''}`);
    throw err;
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`HTTP ${res.status}${detail ? ` : ${detail}` : ''}`);
  }
}

export const senders = {
  // Teams : webhook d'un workflow « Publier dans un canal lorsqu'une requête webhook est reçue ».
  async teams(n, msg) {
    await post(n.webhookUrl, {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              { type: 'TextBlock', text: msg.title, weight: 'Bolder', size: 'Medium', color: COLORS[msg.kind], wrap: true },
              { type: 'TextBlock', text: msg.text.replace(/\n/g, '\n\n'), wrap: true },
            ],
          },
        },
      ],
    });
  },

  async slack(n, msg) {
    await post(n.webhookUrl, { text: `*${msg.title}*\n${msg.text}` });
  },

  async discord(n, msg) {
    await post(n.webhookUrl, { content: `**${msg.title}**\n${msg.text}` });
  },

  async telegram(n, msg) {
    await post(`https://api.telegram.org/bot${n.botToken}/sendMessage`, {
      chat_id: n.chatId,
      text: `${msg.title}\n\n${msg.text}`,
      disable_web_page_preview: true,
    });
  },

  async ntfy(n, msg) {
    const server = (n.server || 'https://ntfy.sh').replace(/\/+$/, '');
    await post(
      server,
      {
        topic: n.topic,
        title: msg.title,
        message: msg.text,
        priority: msg.kind === 'down' ? 5 : msg.kind === 'cert' ? 4 : 3,
        tags: [msg.kind === 'down' ? 'red_circle' : msg.kind === 'up' ? 'green_circle' : 'warning'],
      },
      n.token ? { Authorization: `Bearer ${n.token}` } : {},
    );
  },

  async webhook(n, msg) {
    await post(n.url, {
      event: msg.kind,
      title: msg.title,
      message: msg.text,
      monitor: msg.monitor ? { id: msg.monitor.id, name: msg.monitor.name, type: msg.monitor.type, target: msg.monitor.target } : null,
      time: new Date().toISOString(),
    });
  },

  // E-mail sans SMTP (le Worker Cloudflare ne peut pas ouvrir le port 25/587 de façon fiable)
  async emailapi(n, msg) {
    const to = String(n.to).split(/[,;\s]+/).filter(Boolean);
    const subject = `[Vigie] ${msg.title}`;
    const text = `${msg.text}

— Vigie`;
    if (n.provider === 'resend') {
      await post('https://api.resend.com/emails', { from: n.from, to, subject, text }, { Authorization: `Bearer ${n.apiKey}` });
    } else {
      await post(
        'https://api.brevo.com/v3/smtp/email',
        { sender: { email: n.from }, to: to.map((email) => ({ email })), subject, textContent: text },
        { 'api-key': n.apiKey },
      );
    }
  },
};
