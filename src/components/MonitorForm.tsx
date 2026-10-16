import { useState } from 'react';
import { Copy } from 'lucide-react';
import Modal, { Check, Field } from './Modal';
import { api, TYPE_LABELS, type Capabilities, type Monitor, type MonitorType, type Notifier } from '../lib/api';

type Draft = Partial<Monitor>;

const DEFAULTS: Draft = {
  type: 'http',
  name: '',
  group: '',
  target: '',
  interval: 60,
  retryInterval: 20,
  timeout: 10,
  retries: 2,
  resendEvery: 0,
  method: 'GET',
  acceptedStatus: '200-399',
  headers: '',
  body: '',
  ignoreTls: false,
  followRedirects: true,
  certExpiryDays: 14,
  keyword: '',
  invertKeyword: false,
  port: 443,
  pingCount: 1,
  dnsType: 'A',
  dnsServer: '',
  dnsExpected: '',
};

const TARGET_HINT: Record<MonitorType, [string, string]> = {
  http: ['URL', 'https://www.exemple.fr'],
  keyword: ['URL', 'https://www.exemple.fr/statut'],
  tcp: ['Hôte ou IP', 'routeur.exemple.fr'],
  ping: ['Hôte ou IP', '203.0.113.1'],
  dns: ['Nom à résoudre', 'exemple.fr'],
  push: ['', ''],
};

export default function MonitorForm({
  monitor,
  notifiers,
  caps,
  groups,
  onClose,
  onSaved,
}: {
  monitor?: Monitor;
  notifiers: Notifier[];
  caps: Capabilities;
  groups: string[];
  onClose: () => void;
  onSaved: (m: Monitor) => void;
}) {
  const [d, setD] = useState<Draft>(() =>
    monitor
      ? { ...DEFAULTS, ...monitor }
      : {
          ...DEFAULTS,
          interval: Math.max(DEFAULTS.interval!, caps.minInterval),
          retryInterval: Math.min(DEFAULTS.retryInterval!, caps.maxRetryInterval ?? Infinity),
          notifierIds: notifiers.filter((n) => n.isDefault).map((n) => n.id),
        },
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const type = d.type as MonitorType;
  const isHttp = type === 'http' || type === 'keyword';
  const pushUrl = monitor?.pushToken ? `${location.origin}/api/push/${monitor.pushToken}` : '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      onSaved(await api.saveMonitor(d, monitor?.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const num = (k: keyof Draft) => ({
    type: 'number',
    className: 'input',
    value: String(d[k] ?? ''),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value === '' ? undefined : (Number(e.target.value) as never)),
  });
  const txt = (k: keyof Draft) => ({
    className: 'input',
    value: String(d[k] ?? ''),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(k, e.target.value as never),
  });

  return (
    <Modal title={monitor ? `Modifier « ${monitor.name} »` : 'Nouvelle sonde'} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type de sonde">
            <select className="input" value={type} onChange={(e) => set('type', e.target.value as MonitorType)} disabled={Boolean(monitor)}>
              {Object.entries(TYPE_LABELS)
                .filter(([k]) => caps.monitorTypes.includes(k as MonitorType) || k === type)
                .map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
            </select>
            {caps.platform === 'cloudflare' && !monitor && (
              <span className="mt-1 block text-[11px] text-slate-500">Pas de ping depuis Cloudflare : pour un routeur, surveillez un port ouvert (443, 22…).</span>
            )}
          </Field>
          <Field label="Nom affiché">
            <input {...txt('name')} placeholder="Site vitrine, routeur agence Lyon…" required autoFocus={!monitor} />
          </Field>

          {type !== 'push' && (
            <Field label={TARGET_HINT[type][0]} className={type === 'tcp' ? '' : 'sm:col-span-2'}>
              <input {...txt('target')} placeholder={TARGET_HINT[type][1]} required />
            </Field>
          )}
          {type === 'tcp' && (
            <Field label="Port" hint="ex. 443 (HTTPS), 22 (SSH), 3389 (RDP), 5060 (SIP)">
              <input {...num('port')} min={1} max={65535} required />
            </Field>
          )}
          {type === 'keyword' && (
            <>
              <Field label="Mot-clé recherché dans la page" hint="Sensible à la casse">
                <input {...txt('keyword')} required />
              </Field>
              <div className="flex items-end pb-2">
                <Check label="Alerter si le mot-clé est PRÉSENT (inverse)" checked={Boolean(d.invertKeyword)} onChange={(v) => set('invertKeyword', v)} />
              </div>
            </>
          )}
          {type === 'dns' && (
            <>
              <Field label="Type d'enregistrement">
                <select className="input" value={d.dnsType} onChange={(e) => set('dnsType', e.target.value)}>
                  {['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'SRV', 'PTR'].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </Field>
              {caps.platform === 'cloudflare' ? (
                <Field label="Résolveur">
                  <select className="input" value={d.dnsServer || 'cloudflare'} onChange={(e) => set('dnsServer', e.target.value)}>
                    <option value="cloudflare">Cloudflare (1.1.1.1)</option>
                    <option value="google">Google (8.8.8.8)</option>
                  </select>
                </Field>
              ) : (
                <Field label="Serveur DNS (optionnel)" hint="Vide = résolveur du système. ex. 1.1.1.1">
                  <input {...txt('dnsServer')} />
                </Field>
              )}
              <Field label="Valeur attendue (optionnel)" hint="DOWN si aucune réponse ne contient ce texte" className="sm:col-span-2">
                <input {...txt('dnsExpected')} />
              </Field>
            </>
          )}
          {type === 'ping' && (
            <Field label="Paquets par vérification">
              <input {...num('pingCount')} min={1} max={10} />
            </Field>
          )}
          {type === 'push' && (
            <div className="rounded-lg bg-slate-100 p-3 text-sm dark:bg-slate-800 sm:col-span-2">
              <p className="mb-2 text-slate-600 dark:text-slate-300">
                Sonde passive : c'est l'équipement ou le script qui appelle Vigie. Si aucun appel n'arrive pendant l'intervalle, la sonde passe DOWN.
              </p>
              {pushUrl ? (
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded bg-white px-2 py-1 text-xs dark:bg-slate-950">{pushUrl}</code>
                  <button type="button" className="btn-ghost !p-1.5" onClick={() => navigator.clipboard.writeText(pushUrl)} aria-label="Copier l'URL">
                    <Copy size={14} />
                  </button>
                </div>
              ) : (
                <p className="text-xs text-slate-500">L'URL à appeler sera générée à l'enregistrement.</p>
              )}
              <p className="mt-2 text-[11px] text-slate-500">
                Paramètres facultatifs : <code>?status=down&amp;msg=texte&amp;ping=12</code>. Exemple cron :{' '}
                <code>*/5 * * * * curl -fsS URL &gt;/dev/null</code>
              </p>
            </div>
          )}
        </div>

        <fieldset className="grid gap-4 border-t border-slate-200 pt-4 dark:border-slate-800 sm:grid-cols-4">
          <legend className="sr-only">Fréquence</legend>
          <Field label={type === 'push' ? 'Signal attendu toutes les (s)' : 'Vérifier toutes les (s)'}>
            <input {...num('interval')} min={caps.minInterval} step={caps.intervalStep ?? 1} />
          </Field>
          {type !== 'push' && (
            <>
              <Field label="Délai max (s)">
                <input {...num('timeout')} min={1} max={60} />
              </Field>
              <Field label="Essais avant DOWN" hint="Échecs tolérés">
                <input {...num('retries')} min={0} max={10} />
              </Field>
              <Field label="Intervalle des essais (s)">
                <input {...num('retryInterval')} min={5} max={caps.maxRetryInterval} />
              </Field>
            </>
          )}
          <Field label="Groupe (optionnel)" className="sm:col-span-2">
            <input {...txt('group')} list="vigie-groups" placeholder="Clients, Infra, Sites web…" />
            <datalist id="vigie-groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </Field>
          <Field label="Relancer l'alerte toutes les (min)" hint="0 = une seule alerte par incident" className="sm:col-span-2">
            <input {...num('resendEvery')} min={0} />
          </Field>
        </fieldset>

        {isHttp && (
          <details className="rounded-lg border border-slate-200 dark:border-slate-800">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Options HTTP avancées</summary>
            <div className="grid gap-4 border-t border-slate-200 p-3 dark:border-slate-800 sm:grid-cols-3">
              <Field label="Méthode">
                <select className="input" value={d.method} onChange={(e) => set('method', e.target.value)}>
                  {['GET', 'HEAD', 'POST', 'PUT', 'OPTIONS'].map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </Field>
              <Field label="Codes HTTP acceptés" hint="ex. 200-299,401">
                <input {...txt('acceptedStatus')} />
              </Field>
              {caps.tlsOptions && (
                <Field label="Alerte certificat (jours avant)" hint="0 = désactivé">
                  <input {...num('certExpiryDays')} min={0} />
                </Field>
              )}
              <Field label="En-têtes (un par ligne)" className="sm:col-span-3">
                <textarea {...txt('headers')} rows={2} placeholder="Authorization: Bearer …" className="input font-mono text-xs" />
              </Field>
              {['POST', 'PUT'].includes(d.method ?? '') && (
                <Field label="Corps de la requête" className="sm:col-span-3">
                  <textarea {...txt('body')} rows={3} className="input font-mono text-xs" />
                </Field>
              )}
              <div className="flex flex-col gap-2 sm:col-span-3">
                <Check label="Suivre les redirections" checked={d.followRedirects !== false} onChange={(v) => set('followRedirects', v)} />
                {caps.tlsOptions && (
                  <Check label="Ignorer les erreurs de certificat TLS (auto-signé…)" checked={Boolean(d.ignoreTls)} onChange={(v) => set('ignoreTls', v)} />
                )}
              </div>
            </div>
          </details>
        )}

        <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
          <span className="label">Alerter via</span>
          {notifiers.length ? (
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {notifiers.map((n) => (
                <Check
                  key={n.id}
                  label={n.name}
                  checked={Boolean(d.notifierIds?.includes(n.id))}
                  onChange={(v) => set('notifierIds', v ? [...(d.notifierIds ?? []), n.id] : (d.notifierIds ?? []).filter((x) => x !== n.id))}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">Aucun canal configuré — ajoutez-en un dans « Notifications ».</p>
          )}
        </div>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Annuler
          </button>
          <button className="btn-primary" disabled={saving}>
            {saving ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
