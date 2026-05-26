'use client';

import { useEffect, useState } from 'react';
import { exchangeCodeForToken } from '@/lib/auth';

export default function CallbackPage() {
  const [status, setStatus] = useState('Cognito 토큰 교환 중...');
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code');
    if (!code) {
      setStatus('인증 코드가 없습니다.');
      return;
    }
    exchangeCodeForToken(code)
      .then(() => { window.location.replace('/'); })
      .catch((e) => setStatus(`로그인 실패: ${e.message}`));
  }, []);
  return <p>{status}</p>;
}
