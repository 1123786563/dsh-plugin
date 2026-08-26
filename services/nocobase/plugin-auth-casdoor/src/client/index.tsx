/**
 * Browser entry: register the `casdoor` auth type's login button and admin
 * settings form with the auth plugin's client.
 */

import { Plugin } from '@nocobase/client';
import AuthPlugin from '@nocobase/plugin-auth/client';
import { authType } from '../constants';
import { Options } from './Options';
import { SignInButton } from './SignInButton';

export class PluginAuthCasdoorClient extends Plugin {
  async load() {
    const auth = this.app.pm.get(AuthPlugin);
    auth.registerType(authType, {
      components: {
        SignInButton,
        AdminSettingsForm: Options,
      },
    });
  }
}

export default PluginAuthCasdoorClient;
