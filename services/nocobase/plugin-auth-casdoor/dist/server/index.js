var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugin-auth-casdoor/src/server/index.ts
var index_exports = {};
__export(index_exports, {
  CasdoorAuth: () => CasdoorAuth,
  authType: () => authType,
  default: () => plugin_default,
  namespace: () => namespace
});
module.exports = __toCommonJS(index_exports);

// plugin-auth-casdoor/src/server/plugin.ts
var import_server = require("@nocobase/server");

// plugin-auth-casdoor/src/constants.ts
var namespace = "@dsh/plugin-auth-casdoor";
var authType = "casdoor";

// plugin-auth-casdoor/src/server/casdoor-auth.ts
var import_auth = require("@nocobase/auth");
var import_node_crypto = require("node:crypto");
var UUID_PREFIX = "casdoor:";
var CasdoorAuth = class extends import_auth.BaseAuth {
  constructor(config) {
    const userCollection = config.ctx.db.getCollection("users");
    super({ ...config, userCollection });
  }
  get casdoorOptions() {
    const options = this.authenticator?.options ?? {};
    const issuer = String(options.issuer ?? "").replace(/\/+$/, "");
    return {
      issuer,
      serverIssuer: String(options.serverIssuer ?? issuer).replace(/\/+$/, "") || issuer,
      clientId: String(options.clientId ?? ""),
      clientSecret: String(options.clientSecret ?? ""),
      autoSignup: options.public?.autoSignup !== false
    };
  }
  /** Callback URL casdoor redirects back to (mounted in server/plugin.ts). */
  redirectUrl() {
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
  async getAuthUrl(org) {
    const { issuer, clientId } = this.casdoorOptions;
    const orgSlug = typeof org === "string" ? org.trim() : "";
    const loginClientId = orgSlug.length > 0 && orgSlug !== "built-in" ? `${clientId}-org-${orgSlug}` : clientId;
    const state = await this.jwt.sign(
      { a: this.authenticator.name, n: (0, import_node_crypto.randomBytes)(8).toString("base64url") },
      { expiresIn: "10m" }
    );
    const params = new URLSearchParams({
      client_id: loginClientId,
      response_type: "code",
      redirect_uri: this.redirectUrl(),
      scope: "openid profile email",
      state
    });
    return `${issuer}/login/oauth/authorize?${params.toString()}`;
  }
  /**
   * Core authentication: exchange the callback code, resolve the casdoor
   * identity, and return the NocoBase user (binding or JIT signup).
   */
  async validate() {
    const ctx = this.ctx;
    const { serverIssuer, clientId, clientSecret, autoSignup } = this.casdoorOptions;
    const code = String(ctx.request?.query?.code ?? "");
    if (!serverIssuer || !clientId || !clientSecret) {
      ctx.throw(400, "Casdoor authenticator is not configured (issuer / clientId / clientSecret).");
    }
    if (!code) {
      ctx.throw(400, "Missing authorization code from casdoor.");
    }
    const claims = await this.exchangeCodeForClaims(serverIssuer, clientId, clientSecret, code);
    const uuid = `${UUID_PREFIX}${claims.sub}`;
    const email = typeof claims.email === "string" && claims.email.length > 0 ? claims.email : "";
    const nickname = typeof claims.name === "string" && claims.name || typeof claims.preferred_username === "string" && claims.preferred_username || claims.sub;
    const bound = await this.authenticator.findUser(uuid);
    if (bound) return bound;
    if (email) {
      const byEmail = await this.userRepository.findOne({ filter: { email } });
      if (byEmail) {
        await this.bindUser(uuid, byEmail.id, nickname);
        return byEmail;
      }
    }
    if (!autoSignup) {
      ctx.throw(403, "Casdoor user is not bound and automatic sign-up is disabled.");
    }
    return this.authenticator.newUser(uuid, { nickname, ...email ? { email } : {} });
  }
  /** Create the usersAuthenticators binding row for an existing user. */
  async bindUser(uuid, userId, nickname) {
    try {
      const user = await this.userRepository.findOne({ filter: { id: userId } });
      await this.authenticator.addUser(user, { through: { uuid, nickname } });
    } catch {
      await this.ctx.db.getModel("usersAuthenticators").create({
        uuid,
        userId,
        authenticatorName: this.authenticator.name,
        nickname
      });
    }
  }
  /**
   * Exchange the authorization code for tokens, then resolve claims:
   * casdoor's /api/userinfo when it answers, else the id_token JWT payload,
   * else the JWT access token (casdoor apps with tokenFormat=JWT).
   */
  async exchangeCodeForClaims(issuer, clientId, clientSecret, code) {
    const tokenResponse = await fetch(`${issuer}/api/login/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code
      }),
      signal: AbortSignal.timeout(15e3)
    });
    const tokenBody = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenBody.access_token) {
      throw new Error(
        `casdoor token exchange failed: HTTP ${tokenResponse.status} ${JSON.stringify(tokenBody).slice(0, 200)}`
      );
    }
    let claims = null;
    try {
      const userinfo = await fetch(`${issuer}/api/userinfo`, {
        headers: { authorization: `Bearer ${tokenBody.access_token}` },
        signal: AbortSignal.timeout(15e3)
      });
      if (userinfo.ok) {
        const payload = await userinfo.json().catch(() => null);
        if (payload?.sub) claims = payload;
      }
    } catch {
    }
    if (!claims && typeof tokenBody.id_token === "string") {
      claims = decodeJwtPayload(tokenBody.id_token);
    }
    if (!claims) {
      claims = decodeJwtPayload(tokenBody.access_token);
    }
    if (!claims?.sub) {
      throw new Error("casdoor identity could not be resolved from token exchange");
    }
    return claims;
  }
};
function originOf(ctx) {
  const request = ctx.request ?? ctx;
  const originCandidates = [request.origin, ctx.origin, ctx.get?.("origin")];
  const host = request.headers?.host ?? request.get?.("host") ?? ctx.get?.("host");
  if (typeof host === "string" && host.length > 0) {
    const scheme = originCandidates.find(
      (candidate) => typeof candidate === "string" && candidate.startsWith("http")
    )?.split("://")[0] ?? "http";
    return `${scheme}://${host}`;
  }
  for (const candidate of originCandidates) {
    if (typeof candidate === "string" && candidate.startsWith("http")) return candidate.replace(/\/+$/, "");
  }
  return "http://127.0.0.1:13000";
}
function decodeJwtPayload(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// plugin-auth-casdoor/src/server/plugin.ts
var PluginAuthCasdoorServer = class extends import_server.Plugin {
  async load() {
    this.app.authManager.registerTypes(authType, {
      auth: CasdoorAuth,
      title: "Casdoor"
    });
    this.app.resourcer.define({
      name: "casdoorAuth",
      actions: {
        async getAuthUrl(ctx, next) {
          const name = ctx.get("x-authenticator");
          if (!name) ctx.throw(400, "Missing X-Authenticator header.");
          const org = ctx.action?.params?.values?.org;
          const auth = await ctx.app.authManager.get(name, ctx);
          const url = await auth.getAuthUrl(typeof org === "string" ? org : void 0);
          ctx.body = { url };
          await next();
        },
        async redirect(ctx, next) {
          const state = String(ctx.request?.query?.state ?? "");
          if (!state) ctx.throw(401, "Missing state.");
          let payload;
          try {
            payload = await ctx.app.authManager.jwt.decode(state);
          } catch {
            ctx.throw(401, "Invalid or expired login state.");
          }
          const name = String(payload?.a ?? "");
          if (!name) ctx.throw(401, "Invalid login state payload.");
          const auth = await ctx.app.authManager.get(name, ctx);
          const { token } = await auth.signIn();
          const back = new URL("/signin", "http://callback.invalid");
          back.searchParams.set("authenticator", name);
          back.searchParams.set("token", token);
          ctx.redirect(back.pathname + back.search);
        }
      }
    });
    this.app.acl.allow("casdoorAuth", "getAuthUrl");
    this.app.acl.allow("casdoorAuth", "redirect");
  }
  async install() {
  }
  async afterEnable() {
  }
  async afterDisable() {
  }
  async remove() {
  }
};
var plugin_default = PluginAuthCasdoorServer;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CasdoorAuth,
  authType,
  namespace
});
