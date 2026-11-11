import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { ServerConfig } from './config.ts';
import { understandingSettings } from './config.ts';

// What the web UI may change while the center runs: the model each LLM role uses, and which credential the model calls
// run under. Model choices are plain settings in the database. Provider secrets never are: they are written to files
// in `secretsDir` (next to the server config, mode 0600), read at each call, and never sent back to a browser (only
// their last four characters, to recognize them).

export const LLM_ROLES = ['digest', 'curate', 'restage'] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

export const ROLE_LABEL: Record<LlmRole, { label: string; detail: string }> = {
  digest: { label: '摘要员', detail: '把每段对话写成摘要，调用最多' },
  curate: { label: '整理员', detail: '读摘要，更新项目看板' },
  restage: { label: '复核员', detail: '规则变化后，把每个项目的阶段和优先级复核一次' },
};

/** Offered in the UI; any other model id the provider accepts can be typed in. */
export const MODEL_OPTIONS = [
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5（快、便宜，适合摘要）' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5（均衡，适合整理）' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5（最强）' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
];

export const ModelId = z.string().regex(/^[A-Za-z0-9._:[\]-]{1,100}$/, 'a model id: letters, digits and . _ : - [ ]');

/**
 * `login`: the Claude Code login of the center's machine (subscription). `oauth_token`: a `claude setup-token` token
 * (subscription). `api_key`: an Anthropic API key (billed per token to that API account).
 */
export const CREDENTIAL_MODES = ['login', 'oauth_token', 'api_key'] as const;
export type CredentialMode = (typeof CREDENTIAL_MODES)[number];

export type Credential = { mode: 'login' } | { mode: 'oauth_token'; token: string } | { mode: 'api_key'; key: string };

export type ProviderView = {
  mode: CredentialMode;
  /** Where the active credential comes from: chosen in the UI, the server config's oauthTokenFile, or the default. */
  origin: 'settings' | 'config' | 'default';
  /** Which secrets are stored (`oauth_token`, `api_key`), each with its last four characters. */
  stored: Partial<Record<'oauth_token' | 'api_key', string>>;
};

export type SettingsView = {
  models: Record<LlmRole, string>;
  model_options: typeof MODEL_OPTIONS;
  roles: Array<{ role: LlmRole; label: string; detail: string }>;
  provider: ProviderView;
  /** Whether provider secrets can be set from the UI (the center knows where to keep them). */
  secrets_writable: boolean;
};

const SECRET_FILE: Record<'oauth_token' | 'api_key', string> = { oauth_token: 'anthropic-oauth-token', api_key: 'anthropic-api-key' };
const Secret = z.string().trim().min(20, 'too short to be a token or key').max(500).regex(/^\S+$/, 'must not contain whitespace');

export class SettingsError extends Error {}

export class Settings {
  private readonly db: DatabaseSync;
  private readonly config: ServerConfig;
  readonly secretsDir: string | null;
  private readonly clock: () => Date;

  constructor(db: DatabaseSync, config: ServerConfig, secretsDir: string | null, clock: () => Date = () => new Date()) {
    this.db = db;
    this.config = config;
    this.secretsDir = secretsDir;
    this.clock = clock;
  }

  private read<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.value) as T);
  }

  private write(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), this.clock().toISOString());
  }

  /** Each role's model: what the UI set, else the server config's (`restage` follows `curate` unless set). */
  models(): Record<LlmRole, string> {
    const u = understandingSettings(this.config);
    const set = this.read<Partial<Record<LlmRole, string>>>('models') ?? {};
    const curate = set.curate ?? u.curateModel;
    return { digest: set.digest ?? u.digestModel, curate, restage: set.restage ?? curate };
  }

  setModels(patch: Partial<Record<LlmRole, string>>): Record<LlmRole, string> {
    const current = this.read<Partial<Record<LlmRole, string>>>('models') ?? {};
    for (const [role, model] of Object.entries(patch)) {
      if (!LLM_ROLES.includes(role as LlmRole)) throw new SettingsError(`unknown role ${JSON.stringify(role)}`);
      const parsed = ModelId.safeParse(model);
      if (!parsed.success) throw new SettingsError(`${role}: ${parsed.error.issues[0]!.message}`);
      current[role as LlmRole] = parsed.data;
    }
    this.write('models', current);
    return this.models();
  }

  private secretPath(kind: 'oauth_token' | 'api_key'): string | null {
    return this.secretsDir === null ? null : join(this.secretsDir, SECRET_FILE[kind]);
  }

  private readSecret(kind: 'oauth_token' | 'api_key'): string | null {
    const path = this.secretPath(kind);
    if (path === null) return null;
    try {
      const value = readFileSync(path, 'utf8').trim();
      return value === '' ? null : value;
    } catch {
      return null;
    }
  }

  private configOauthToken(): string | null {
    const file = understandingSettings(this.config).oauthTokenFile;
    if (file === undefined) return null;
    try {
      const value = readFileSync(file, 'utf8').trim();
      return value === '' ? null : value;
    } catch {
      return null;
    }
  }

  /**
   * The credential model calls run under now: the mode chosen in the UI (with its stored secret), else the config's
   * oauthTokenFile, else the machine's Claude Code login. A chosen mode whose secret is gone falls back to the login.
   */
  credential(): Credential {
    const chosen = this.read<{ mode: CredentialMode }>('provider')?.mode;
    if (chosen === 'oauth_token') {
      const token = this.readSecret('oauth_token');
      if (token !== null) return { mode: 'oauth_token', token };
    } else if (chosen === 'api_key') {
      const key = this.readSecret('api_key');
      if (key !== null) return { mode: 'api_key', key };
    } else if (chosen === 'login') {
      return { mode: 'login' };
    }
    const fromConfig = this.configOauthToken();
    return fromConfig === null ? { mode: 'login' } : { mode: 'oauth_token', token: fromConfig };
  }

  provider(): ProviderView {
    const chosen = this.read<{ mode: CredentialMode }>('provider')?.mode;
    const active = this.credential();
    const stored: ProviderView['stored'] = {};
    for (const kind of ['oauth_token', 'api_key'] as const) {
      const v = this.readSecret(kind);
      if (v !== null) stored[kind] = v.slice(-4);
    }
    const origin: ProviderView['origin'] =
      chosen !== undefined && chosen === active.mode ? 'settings' : active.mode === 'oauth_token' ? 'config' : 'default';
    return { mode: active.mode, origin, stored };
  }

  /**
   * Chooses the credential mode, storing `secret` for it when given. Choosing a mode that needs a secret without one
   * stored (or given) is refused, so the center never switches to a credential it does not have.
   */
  setProvider(mode: CredentialMode, secret?: string): ProviderView {
    if (!CREDENTIAL_MODES.includes(mode)) throw new SettingsError(`unknown mode ${JSON.stringify(mode)}`);
    if (mode !== 'login') {
      if (secret !== undefined) {
        const parsed = Secret.safeParse(secret);
        if (!parsed.success) throw new SettingsError(parsed.error.issues[0]!.message);
        const path = this.secretPath(mode);
        if (path === null) throw new SettingsError('this center was started without a place for secrets');
        mkdirSync(this.secretsDir!, { recursive: true, mode: 0o700 });
        const tmp = `${path}.tmp-${process.pid}`;
        writeFileSync(tmp, `${parsed.data}\n`, { mode: 0o600 });
        renameSync(tmp, path);
      }
      if (this.readSecret(mode) === null) throw new SettingsError(`no ${mode === 'api_key' ? 'API key' : 'OAuth token'} is stored yet`);
    }
    this.write('provider', { mode });
    return this.provider();
  }

  /** Deletes a stored secret; if it was the active one, the login (or the config's token file) takes over. */
  clearSecret(kind: 'oauth_token' | 'api_key'): ProviderView {
    const path = this.secretPath(kind);
    if (path !== null) rmSync(path, { force: true });
    // It was the active one: back to the default (the config's token file, else the login).
    if (this.read<{ mode: CredentialMode }>('provider')?.mode === kind) this.db.prepare(`DELETE FROM settings WHERE key = 'provider'`).run();
    return this.provider();
  }

  view(): SettingsView {
    return {
      models: this.models(),
      model_options: MODEL_OPTIONS,
      roles: LLM_ROLES.map((role) => ({ role, ...ROLE_LABEL[role] })),
      provider: this.provider(),
      secrets_writable: this.secretsDir !== null,
    };
  }
}
