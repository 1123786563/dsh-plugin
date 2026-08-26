/**
 * Server entry: register the `casdoor` auth type and the two HTTP endpoints
 * of the authorization-code flow.
 *
 *   POST/GET /api/casdoorAuth:getAuthUrl  — browser asks where to redirect
 *   GET    /api/casdoorAuth:redirect      — casdoor callback (code + state);
 *                                           issues the NocoBase token and 302s
 *                                           back to /signin?authenticator=&token=
 */

import { Plugin } from '@nocobase/server';
import { authType } from '../constants';
import { CasdoorAuth } from './casdoor-auth';

export class PluginAuthCasdoorServer extends Plugin {
  async load() {
    this.app.authManager.registerTypes(authType, {
      auth: CasdoorAuth,
      title: 'Casdoor',
    });

    this.app.resourcer.define({
      name: 'casdoorAuth',
      actions: {
        async getAuthUrl(ctx: any, next: any) {
          const name = ctx.get('x-authenticator');
          if (!name) ctx.throw(400, 'Missing X-Authenticator header.');
          const org = ctx.action?.params?.values?.org;
          const auth = (await ctx.app.authManager.get(name, ctx)) as CasdoorAuth;
          const url = await auth.getAuthUrl(typeof org === 'string' ? org : undefined);
          ctx.body = { url };
          await next();
        },
        async redirect(ctx: any, next: any) {
          const state = String(ctx.request?.query?.state ?? '');
          if (!state) ctx.throw(401, 'Missing state.');
          let payload: any;
          try {
            payload = await ctx.app.authManager.jwt.decode(state);
          } catch {
            ctx.throw(401, 'Invalid or expired login state.');
          }
          const name = String(payload?.a ?? '');
          if (!name) ctx.throw(401, 'Invalid login state payload.');
          const auth = (await ctx.app.authManager.get(name, ctx)) as CasdoorAuth;
          const { token } = await auth.signIn();
          // Relative Location: the browser resolves it against the callback
          // request's own origin, so the port/host the user actually reached
          // NocoBase on is preserved behind any proxy or port mapping.
          const back = new URL('/signin', 'http://callback.invalid');
          back.searchParams.set('authenticator', name);
          back.searchParams.set('token', token);
          ctx.redirect(back.pathname + back.search);
        },
      },
    });

    // Both endpoints run before any user exists, so keep them publicly callable.
    this.app.acl.allow('casdoorAuth', 'getAuthUrl');
    this.app.acl.allow('casdoorAuth', 'redirect');
  }

  async install() {}
  async afterEnable() {}
  async afterDisable() {}
  async remove() {}
}

export default PluginAuthCasdoorServer;
