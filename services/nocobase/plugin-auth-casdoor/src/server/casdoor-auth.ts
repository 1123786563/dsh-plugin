/**
 * Casdoor OIDC authentication type for NocoBase.
 *
 * Authorization-code flow against a casdoor IdP: the browser is sent to
 * casdoor's authorize endpoint, casdoor calls back with `code` + `state`
 * (see server/plugin.ts actions), and `validate()` exchanges the code,
 * resolves the user identity, and returns the NocoBase user.
 *
 * Identity resolution order:
 *   1. `usersAuthenticators` binding by uuid (`casdoor:<sub>`)
 *   2. existing local user with the same email (binding is created)
 *   3. JIT signup (when `options.public.autoSignup !== false`)
 *
 * The casdoor application is used org-agnostically: we always authorize with
 * the plain client id and never validate `aud`, so casdoor's shared-app
 * "-org-<org>" client-id suffixes never matter here.
 */

import { AuthConfig, BaseAuth } from '@nocobase/auth';
import { randomBytes } from 'node:crypto';

/** uuid prefix keeps casdoor identities from colliding with other auth types. */
const UUID_PREFIX = 'casdoor:';

/** OIDC-style claims we consume from casdoor userinfo / id_token payload. */
interface CasdoorClaims {
  sub: string;
  name?: string;
  preferred_username?: string;
  email?: string;
  [key: string]: unknown;
}

export interface CasdoorAuthOptions {
  /** Browser-facing casdoor origin (authorize URL). */
  issuer: string;
  /** Server-to-server origin; falls back to issuer. Set when browser and
   * container reach casdoor differently (docker compose: issuer
   * http://127.0.0.1:8001, serverIssuer http://casdoor:8000). */
  serverIssuer: string;
  clientId: string;
  clientSecret: string;
  autoSignup: boolean;
}

export class CasdoorAuth extends BaseAuth {
  constructor(config: AuthConfig) {
    const userCollection = config.ctx.db.getCollection('users');
    super({ ...config, userCollection });
  }

  get casdoorOptions(): CasdoorAuthOptions {
    const options = (this.authenticator?.options ?? {}) as Record<string, any>;
    const issuer = String(options.issuer ?? '').replace(/\/+$/, '');
    return {
      issuer,
      serverIssuer: String(options.serverIssuer ?? issuer).replace(/\/+$/, '') || issuer,
      clientId: String(options.clientId ?? ''),
      clientSecret: String(options.clientSecret ?? ''),
      autoSignup: options.public?.autoSignup !== false,
    };
  }

  /** Callback URL casdoor redirects back to (mounted in server/plugin.ts). */
  redirectUrl(): string {
    return `${originOf(this.ctx)}/api/casdoorAuth:redirect`;
  }

  /**
   * Build the casdoor authorize URL. `state` is a short-lived JWT signed with
   * the app's auth secret carrying the authenticator name, so the callback can
   * reconstruct this auth instance without relying on headers/cookies the
   * browser redirect cannot carry.
   *
   * `org` selects the casdoor login page via the shared-app client-id suffix
   * (`<clientId>-org-<org>`); the code still exchanges against the shared
   * client credentials, so validation stays org-agnostic.
   */
  async getAuthUrl(org?: string): Promise<string> {
    const { issuer, clientId } = this.casdoorOptions;
    const orgSlug = typeof org === 'string' ? org.trim() : '';
    const loginClientId = orgSlug.length > 0 && orgSlug !== 'built-in'
      ? `${clientId}-org-${orgSlug}`
      : clientId;
    const state = await this.jwt.sign(
      { a: this.authenticator.name, n: randomBytes(8).toString('base64url') },
      { expiresIn: '10m' },
    );
    const params = new URLSearchParams({
      client_id: loginClientId,
      response_type: 'code',
      redirect_uri: this.redirectUrl(),
      scope: 'openid profile email',
      state,
    });
    return `${issuer}/login/oauth/authorize?${params.toString()}`;
  }

  /**
   * Core authentication: exchange the callback code, resolve the casdoor
   * identity, and return the NocoBase user (binding or JIT signup).
   */
  async validate() {
    const ctx = this.ctx as any;
    const { serverIssuer, clientId, clientSecret, autoSignup } = this.casdoorOptions;
    const code = String(ctx.request?.query?.code ?? '');
    if (!serverIssuer || !clientId || !clientSecret) {
      ctx.throw(400, 'Casdoor authenticator is not configured (issuer / clientId / clientSecret).');
    }
    if (!code) {
      ctx.throw(400, 'Missing authorization code from casdoor.');
    }

    const claims = await this.exchangeCodeForClaims(serverIssuer, clientId, clientSecret, code);
    const uuid = `${UUID_PREFIX}${claims.sub}`;
    const email = typeof claims.email === 'string' && claims.email.length > 0 ? claims.email : '';
    const nickname =
      (typeof claims.name === 'string' && claims.name) ||
      (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
      claims.sub;

    // 1. Already bound to this authenticator.
    const bound = await (this.authenticator as any).findUser(uuid);
    if (bound) return bound;

    // 2. Bind an existing local user with the same email.
    if (email) {
      const byEmail = await this.userRepository.findOne({ filter: { email } });
      if (byEmail) {
        await this.bindUser(uuid, byEmail.id, nickname);
        return byEmail;
      }
    }

    // 3. JIT signup.
    if (!autoSignup) {
      ctx.throw(403, 'Casdoor user is not bound and automatic sign-up is disabled.');
    }
    return (this.authenticator as any).newUser(uuid, { nickname, ...(email ? { email } : {}) });
  }

  /** Create the usersAuthenticators binding row for an existing user. */
  private async bindUser(uuid: string, userId: number, nickname: string) {
    try {
      // Preferred: the N:M association API (handles column naming itself).
      const user = await this.userRepository.findOne({ filter: { id: userId } });
      await (this.authenticator as any).addUser(user, { through: { uuid, nickname } });
    } catch {
      // Fallback: direct row on the through collection.
      await this.ctx.db.getModel('usersAuthenticators').create({
        uuid,
        userId,
        authenticatorName: (this.authenticator as any).name,
        nickname,
      });
    }
  }

  /**
   * Exchange the authorization code for tokens, then resolve claims:
   * casdoor's /api/userinfo when it answers, else the id_token JWT payload,
   * else the JWT access token (casdoor apps with tokenFormat=JWT).
   */
  private async exchangeCodeForClaims(
    issuer: string,
    clientId: string,
    clientSecret: string,
    code: string,
  ): Promise<CasdoorClaims> {
    const tokenResponse = await fetch(`${issuer}/api/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const tokenBody: any = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenBody.access_token) {
      throw new Error(
        `casdoor token exchange failed: HTTP ${tokenResponse.status} ${JSON.stringify(tokenBody).slice(0, 200)}`,
      );
    }

    let claims: CasdoorClaims | null = null;
    try {
      const userinfo = await fetch(`${issuer}/api/userinfo`, {
        headers: { authorization: `Bearer ${tokenBody.access_token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (userinfo.ok) {
        const payload: any = await userinfo.json().catch(() => null);
        if (payload?.sub) claims = payload;
      }
    } catch {
      // fall through to JWT payloads
    }
    if (!claims && typeof tokenBody.id_token === 'string') {
      claims = decodeJwtPayload(tokenBody.id_token);
    }
    if (!claims) {
      claims = decodeJwtPayload(tokenBody.access_token);
    }
    if (!claims?.sub) {
      throw new Error('casdoor identity could not be resolved from token exchange');
    }
    return claims;
  }
}

/** Resolve the request origin across koa/resourcer context shapes (never "null"). */
export function originOf(ctx: any): string {
  const request = ctx.request ?? ctx
  const originCandidates = [request.origin, ctx.origin, ctx.get?.('origin')]
  // Host header carries the port; wrapped koa request.origin has been seen
  // dropping it behind the nocobase proxy layer, so prefer the header and
  // borrow the scheme from any origin-shaped candidate (http fallback).
  const host = request.headers?.host ?? request.get?.('host') ?? ctx.get?.('host')
  if (typeof host === 'string' && host.length > 0) {
    const scheme = originCandidates.find(
      (candidate) => typeof candidate === 'string' && candidate.startsWith('http'),
    )?.split('://')[0] ?? 'http'
    return `${scheme}://${host}`
  }
  for (const candidate of originCandidates) {
    if (typeof candidate === 'string' && candidate.startsWith('http')) return candidate.replace(/\/+$/, '')
  }
  return 'http://127.0.0.1:13000'
}

/** Decode the payload segment of a JWT without verification (identity comes from the server-to-server code exchange). */
function decodeJwtPayload(token: string): CasdoorClaims | null {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
