var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugin-auth-casdoor/src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  PluginAuthCasdoorClient: () => PluginAuthCasdoorClient,
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);
var import_client3 = require("@nocobase/client");
var import_client4 = __toESM(require("@nocobase/plugin-auth/client"));

// plugin-auth-casdoor/src/constants.ts
var authType = "casdoor";

// plugin-auth-casdoor/src/client/Options.tsx
var import_client = require("@nocobase/client");
var import_jsx_runtime = require("react/jsx-runtime");
var Options = () => {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    import_client.SchemaComponent,
    {
      schema: {
        type: "object",
        properties: {
          issuer: {
            type: "string",
            title: "Casdoor issuer (origin, e.g. http://127.0.0.1:8001)",
            "x-decorator": "FormItem",
            "x-component": "Input",
            required: true
          },
          clientId: {
            type: "string",
            title: "Client ID",
            "x-decorator": "FormItem",
            "x-component": "Input",
            required: true
          },
          clientSecret: {
            type: "string",
            title: "Client Secret",
            "x-decorator": "FormItem",
            "x-component": "Password",
            required: true
          },
          "public.autoSignup": {
            type: "boolean",
            title: "Sign up automatically when the user does not exist",
            "x-decorator": "FormItem",
            "x-component": "Checkbox",
            default: true
          },
          "public.buttonText": {
            type: "string",
            title: "Sign-in button text",
            "x-decorator": "FormItem",
            "x-component": "Input",
            default: "Sign in with Casdoor"
          }
        }
      }
    }
  );
};

// plugin-auth-casdoor/src/client/SignInButton.tsx
var import_client2 = require("@nocobase/client");
var import_antd = require("antd");
var import_jsx_runtime2 = require("react/jsx-runtime");
var SignInButton = (props) => {
  var _a, _b;
  const api = (0, import_client2.useAPIClient)();
  const { authenticator } = props;
  const onClick = async () => {
    var _a2, _b2, _c, _d;
    const response = await api.request({
      url: "casdoorAuth:getAuthUrl",
      method: "POST",
      headers: { "X-Authenticator": authenticator.name }
    });
    const url = (_d = (_b2 = (_a2 = response == null ? void 0 : response.data) == null ? void 0 : _a2.data) == null ? void 0 : _b2.url) != null ? _d : (_c = response == null ? void 0 : response.data) == null ? void 0 : _c.url;
    if (typeof url === "string" && url.length > 0) {
      window.location.replace(url);
    }
  };
  const text = ((_b = (_a = authenticator == null ? void 0 : authenticator.options) == null ? void 0 : _a.public) == null ? void 0 : _b.buttonText) || (authenticator == null ? void 0 : authenticator.title) || "Sign in with Casdoor";
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_antd.Button, { block: true, onClick, children: text });
};

// plugin-auth-casdoor/src/client/index.tsx
var PluginAuthCasdoorClient = class extends import_client3.Plugin {
  async load() {
    const auth = this.app.pm.get(import_client4.default);
    auth.registerType(authType, {
      components: {
        SignInButton,
        AdminSettingsForm: Options
      }
    });
  }
};
var index_default = PluginAuthCasdoorClient;
