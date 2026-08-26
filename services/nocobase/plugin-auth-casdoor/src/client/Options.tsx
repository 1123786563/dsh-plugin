/**
 * Admin settings form for the casdoor authenticator (the lower half of the
 * authenticator edit drawer). Dotted field paths bind into the authenticator
 * record's `options` object, mirroring the built-in Email/Password form.
 */

import { SchemaComponent } from '@nocobase/client';
import React from 'react';

export const Options = () => {
  return (
    <SchemaComponent
      schema={{
        type: 'object',
        properties: {
          issuer: {
            type: 'string',
            title: 'Casdoor issuer (origin, e.g. http://127.0.0.1:8001)',
            'x-decorator': 'FormItem',
            'x-component': 'Input',
            required: true,
          },
          clientId: {
            type: 'string',
            title: 'Client ID',
            'x-decorator': 'FormItem',
            'x-component': 'Input',
            required: true,
          },
          clientSecret: {
            type: 'string',
            title: 'Client Secret',
            'x-decorator': 'FormItem',
            'x-component': 'Password',
            required: true,
          },
          'public.autoSignup': {
            type: 'boolean',
            title: 'Sign up automatically when the user does not exist',
            'x-decorator': 'FormItem',
            'x-component': 'Checkbox',
            default: true,
          },
          'public.buttonText': {
            type: 'string',
            title: 'Sign-in button text',
            'x-decorator': 'FormItem',
            'x-component': 'Input',
            default: 'Sign in with Casdoor',
          },
        },
      }}
    />
  );
};
