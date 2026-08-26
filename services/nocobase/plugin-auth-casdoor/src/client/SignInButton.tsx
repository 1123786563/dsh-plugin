/**
 * "Sign in with Casdoor" button on the NocoBase sign-in page. When the
 * authenticator exposes multiple casdoor organizations (options.public.orgs),
 * the button opens a small chooser; each entry asks the server for the
 * authorize URL with that org (casdoor shared-app client-id suffix selects the
 * login page) and navigates there.
 */

import { useAPIClient } from '@nocobase/client';
import { Button, Space } from 'antd';
import React, { useState } from 'react';

interface AuthenticatorProps {
  name: string
  title?: string
  /** Sign-in-page shape: options IS the public part; admin shape nests it. */
  options?: { orgs?: string[], buttonText?: string, public?: { orgs?: string[], buttonText?: string } }
}

export const SignInButton = (props: { authenticator: AuthenticatorProps }) => {
  const api = useAPIClient();
  const { authenticator } = props;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const orgs = (authenticator?.options?.orgs ?? authenticator?.options?.public?.orgs ?? [])
    .map((org) => String(org).trim())
    .filter((org) => org.length > 0);

  const goTo = async (org?: string) => {
    setBusy(true);
    try {
      const response: any = await api.request({
        url: 'casdoorAuth:getAuthUrl',
        method: 'POST',
        headers: { 'X-Authenticator': authenticator.name },
        data: org === undefined ? {} : { org },
      });
      const url = response?.data?.data?.url ?? response?.data?.url;
      if (typeof url === 'string' && url.length > 0) {
        window.location.replace(url);
        return;
      }
    } finally {
      setBusy(false);
    }
  };

  const text =
    authenticator?.options?.buttonText ||
    authenticator?.options?.public?.buttonText ||
    authenticator?.title ||
    'Sign in with Casdoor';

  if (orgs.length <= 1) {
    return (
      <Button block loading={busy} onClick={() => void goTo(orgs[0])}>
        {text}
      </Button>
    );
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={8}>
      <Button block onClick={() => setOpen((value) => !value)}>
        {text}
      </Button>
      {open
        ? orgs.map((org) => (
            <Button key={org} block size="small" loading={busy} onClick={() => void goTo(org)}>
              {org === 'built-in' ? `${org} (平台)` : org}
            </Button>
          ))
        : null}
    </Space>
  );
};
