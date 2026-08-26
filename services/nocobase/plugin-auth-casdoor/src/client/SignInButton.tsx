/**
 * "Sign in with Casdoor" button on the NocoBase sign-in page: asks the server
 * for the casdoor authorize URL (the authenticator's options stay server-side)
 * and navigates there.
 */

import { useAPIClient } from '@nocobase/client';
import { Button } from 'antd';
import React from 'react';

export const SignInButton = (props: { authenticator: { name: string; title?: string; options?: any } }) => {
  const api = useAPIClient();
  const { authenticator } = props;

  const onClick = async () => {
    const response: any = await api.request({
      url: 'casdoorAuth:getAuthUrl',
      method: 'POST',
      headers: { 'X-Authenticator': authenticator.name },
    });
    const url = response?.data?.data?.url ?? response?.data?.url;
    if (typeof url === 'string' && url.length > 0) {
      window.location.replace(url);
    }
  };

  const text =
    authenticator?.options?.public?.buttonText || authenticator?.title || 'Sign in with Casdoor';
  return (
    <Button block onClick={onClick}>
      {text}
    </Button>
  );
};
