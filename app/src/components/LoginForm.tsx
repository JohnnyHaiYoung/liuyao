'use client';

import { useState } from 'react';
import { ApiRequestError, api } from '@/lib/api-client';

/** 登录表单：密码只提交到服务端，前端不保存任何凭据。 */
export function LoginForm() {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting || password === '') return;
    setSubmitting(true);
    setError(null);
    try {
      await api.login(password);
      setPassword('');
      // 登录成功后整页跳转，确保服务端组件拿到新的登录态。
      window.location.assign('/');
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        setError(caught.message);
      } else {
        setError('登录失败，请稍后再试。');
      }
      setSubmitting(false);
    }
  }

  return (
    <form className="login-card" onSubmit={handleSubmit}>
      <h1>六爻 Agent</h1>
      <p>第一阶段：可持久保存的自由聊天网站。请输入拥有者密码。</p>
      <div className="field">
        <label htmlFor="password">密码</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoFocus
        />
      </div>
      {error ? <div className="banner error" role="alert">{error}</div> : null}
      <button className="button primary" type="submit" disabled={submitting || password === ''}>
        {submitting ? '登录中…' : '登录'}
      </button>
    </form>
  );
}
