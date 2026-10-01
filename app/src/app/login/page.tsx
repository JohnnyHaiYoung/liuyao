import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/LoginForm';
import { authenticateCookies } from '@/server/auth/session';

/** 登录页：已登录直接回到聊天界面。 */
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const auth = await authenticateCookies();
  if (auth) {
    redirect('/');
  }
  return (
    <div className="login-shell">
      <LoginForm />
    </div>
  );
}
