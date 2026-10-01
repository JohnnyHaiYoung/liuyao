import { redirect } from 'next/navigation';
import { ChatApp } from '@/components/ChatApp';
import { authenticateCookies } from '@/server/auth/session';
import { getConfig, isLlmConfigured } from '@/server/config';

/** 主页：未登录跳转登录页；已登录渲染聊天界面。 */
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const auth = await authenticateCookies();
  if (!auth) {
    redirect('/login');
  }
  const config = getConfig();
  return (
    <ChatApp
      owner={auth.owner}
      llmConfigured={isLlmConfigured()}
      defaultModel={config.llm.activeModelId}
      fakeMode={config.llm.fakeMode}
    />
  );
}
