import { useState } from 'react';
import { LogIn, Radar } from 'lucide-react';
import { api } from '../lib/api';

export default function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(username, password);
      onLoggedIn();
    } catch (err) {
      setError((err as Error).message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6 shadow-xl">
        <div className="flex items-center gap-2 text-xl font-bold">
          <Radar className="text-emerald-600" size={26} /> Vigie
        </div>
        <p className="text-sm text-slate-500">Connectez-vous pour accéder à la surveillance.</p>
        <label className="block">
          <span className="label">Identifiant</span>
          <input className="input" autoComplete="username" autoFocus required value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">Mot de passe</span>
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}
        <button className="btn-primary w-full justify-center py-2" disabled={busy}>
          <LogIn size={16} /> {busy ? 'Connexion…' : 'Se connecter'}
        </button>
      </form>
    </div>
  );
}
