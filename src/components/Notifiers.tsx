import { useState } from 'react';
import { BellRing, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import Modal, { Check, Field } from './Modal';
import { api, SECRET, type Notifier } from '../lib/api';

interface FieldDef {
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
  secret?: boolean;
  wide?: boolean;
  options?: [string, string][];
}

const FIELDS: Record<string, FieldDef[]> = {
  email: [
    { key: 'host', label: 'Serveur SMTP', placeholder: 'smtp.office365.com' },
    { key: 'port', label: 'Port', placeholder: '587' },
    { key: 'username', label: 'Identifiant (optionnel)' },
    { key: 'password', label: 'Mot de passe', secret: true },
    { key: 'from', label: 'Expéditeur', placeholder: 'vigie@exemple.fr' },
    { key: 'to', label: 'Destinataire(s)', placeholder: 'noc@exemple.fr, astreinte@exemple.fr' },
  ],
  emailapi: [
    { key: 'provider', label: 'Service', options: [['brevo', 'Brevo (300 e-mails/jour gratuits)'], ['resend', 'Resend']] },
    { key: 'apiKey', label: "Clé d'API", secret: true },
    { key: 'from', label: 'Expéditeur', placeholder: 'vigie@exemple.fr', hint: 'Adresse ou domaine validé chez le service' },
    { key: 'to', label: 'Destinataire(s)', placeholder: 'noc@exemple.fr, astreinte@exemple.fr' },
  ],
  teams: [
    {
      key: 'webhookUrl',
      label: 'URL du webhook',
      secret: true,
      wide: true,
      hint: 'Teams → canal → Workflows → « Publier dans un canal lorsqu’une requête webhook est reçue », puis copier l’URL.',
    },
  ],
  slack: [{ key: 'webhookUrl', label: 'URL du webhook entrant', secret: true, wide: true }],
  discord: [{ key: 'webhookUrl', label: 'URL du webhook', secret: true, wide: true, hint: 'Paramètres du salon → Intégrations → Webhooks' }],
  telegram: [
    { key: 'botToken', label: 'Jeton du bot', secret: true, hint: 'Créé avec @BotFather' },
    { key: 'chatId', label: 'ID de la conversation', hint: 'Votre ID ou celui du groupe (ex. -100…)' },
  ],
  ntfy: [
    { key: 'server', label: 'Serveur', placeholder: 'https://ntfy.sh' },
    { key: 'topic', label: 'Sujet (topic)', hint: 'Choisissez un nom difficile à deviner' },
    { key: 'token', label: "Jeton d'accès (optionnel)", secret: true, wide: true },
  ],
  webhook: [{ key: 'url', label: 'URL (POST JSON)', wide: true, hint: 'Reçoit { event, title, message, monitor, time }' }],
};

function NotifierForm({ notifier, types, onClose, onSaved }: { notifier?: Notifier; types: Record<string, string>; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Partial<Notifier> & { applyToAll?: boolean }>(
    () => notifier ?? { type: Object.keys(types)[0], name: '', isDefault: true, port: '587', provider: 'brevo' },
  );
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string | boolean) => setD((p) => ({ ...p, [k]: v }));
  const type = String(d.type);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await fn();
      if (ok) setInfo(ok);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={notifier ? `Modifier « ${notifier.name} »` : 'Nouveau canal de notification'} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await api.saveNotifier(d, notifier?.id);
            onSaved();
          });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type">
            <select className="input" value={type} onChange={(e) => set('type', e.target.value)} disabled={Boolean(notifier)}>
              {Object.entries(types).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Nom">
            <input className="input" value={String(d.name ?? '')} onChange={(e) => set('name', e.target.value)} placeholder="Équipe réseau, Mon téléphone…" required />
          </Field>
          {(FIELDS[type] ?? []).map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint} className={f.wide ? 'sm:col-span-2' : ''}>
              {f.options ? (
                <select className="input" value={String(d[f.key] || f.options[0][0])} onChange={(e) => set(f.key, e.target.value)}>
                  {f.options.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              ) : (
              <input
                className="input"
                type={f.secret ? 'password' : 'text'}
                autoComplete="off"
                placeholder={d[f.key] === SECRET ? '•••••••• (inchangé)' : f.placeholder}
                value={d[f.key] === SECRET ? '' : String(d[f.key] ?? '')}
                onChange={(e) => set(f.key, e.target.value === '' && notifier?.[f.key] === SECRET ? SECRET : e.target.value)}
              />
              )}
            </Field>
          ))}
        </div>
        {type === 'email' && (
          <div className="flex flex-col gap-2">
            <Check label="Connexion TLS directe (port 465)" checked={Boolean(d.secure)} onChange={(v) => set('secure', v)} />
            <Check label="Accepter un certificat SMTP non valide" checked={Boolean(d.ignoreTls)} onChange={(v) => set('ignoreTls', v)} />
          </div>
        )}
        <div className="flex flex-col gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
          <Check label="Cocher par défaut sur les nouvelles sondes" checked={Boolean(d.isDefault)} onChange={(v) => set('isDefault', v)} />
          <Check label="Ajouter à toutes les sondes existantes" checked={Boolean(d.applyToAll)} onChange={(v) => set('applyToAll', v)} />
        </div>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">{error}</p>}
        {info && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">{info}</p>}
        <div className="flex justify-between gap-2">
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => run(() => api.testNotifier({ ...d, id: notifier?.id }), 'Message de test envoyé.')}>
            <Send size={14} /> Envoyer un test
          </button>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Annuler
            </button>
            <button className="btn-primary" disabled={busy}>
              Enregistrer
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

export default function Notifiers({ notifiers, types, usage, onChange }: { notifiers: Notifier[]; types: Record<string, string>; usage: Record<string, number>; onChange: () => void }) {
  const [editing, setEditing] = useState<Notifier | 'new' | null>(null);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Canaux de notification</h2>
          <p className="text-sm text-slate-500">Où Vigie envoie les alertes DOWN, les retours à la normale et les certificats bientôt expirés.</p>
        </div>
        <button className="btn-primary" onClick={() => setEditing('new')}>
          <Plus size={16} /> Ajouter
        </button>
      </div>
      {notifiers.length === 0 && (
        <div className="card flex flex-col items-center gap-2 p-10 text-center text-slate-500">
          <BellRing size={28} />
          <p>Aucun canal pour l'instant. Sans canal, les incidents sont seulement visibles ici.</p>
        </div>
      )}
      <ul className="space-y-2">
        {notifiers.map((n) => (
          <li key={n.id} className="card flex items-center gap-3 px-4 py-3">
            <BellRing size={18} className="text-slate-400" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {n.name}
                {n.isDefault && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-normal text-slate-600 dark:bg-slate-800 dark:text-slate-300">par défaut</span>}
              </div>
              <div className="text-xs text-slate-500">
                {types[n.type] ?? n.type} · {usage[n.id] ?? 0} sonde(s)
              </div>
            </div>
            <button className="btn-ghost !p-2" title="Envoyer un test" onClick={() => api.testNotifier(n).then(() => alert('Test envoyé.'), (e) => alert(`Échec : ${e.message}`))}>
              <Send size={15} />
            </button>
            <button className="btn-ghost !p-2" title="Modifier" onClick={() => setEditing(n)}>
              <Pencil size={15} />
            </button>
            <button
              className="btn-danger !p-2"
              title="Supprimer"
              onClick={() => confirm(`Supprimer le canal « ${n.name} » ?`) && api.deleteNotifier(n.id).then(onChange)}
            >
              <Trash2 size={15} />
            </button>
          </li>
        ))}
      </ul>
      {editing && (
        <NotifierForm
          notifier={editing === 'new' ? undefined : editing}
          types={types}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChange();
          }}
        />
      )}
    </div>
  );
}
