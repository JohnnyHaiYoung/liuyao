# 本地 Wiki 第一批 · 复验命令与预期（供独立验收方）

- 交付基线：`wiki-batch1@ead9ad0b`（功能提交 `9102135`/`ead9ad0b`；自 `main@e5e8b31` 分叉，未合并 `main`）
- 上轮复验：`docs/wiki_expansion_batch1_reacceptance_2f31a08_2026-10-10.md`
- 交付说明：`docs/wiki_expansion_batch1_delivery.md`；私有资料包清单：`docs/wiki_expansion_batch1_pack_inventory.md`
- 性质：**研发自测材料，非签收结论**；本批资料独立验收后由第五阶段在冻结版本对齐，不自行进入正式发布包。

## 一键总回归（预期每行退出码 = 0）

```powershell
cd E:\workspace-ai\xuanxue\liuyao
git rev-parse --short HEAD            # 应为 ead9ad0b

node tools\corpus-cli.ts verify
node app\scripts\build-wiki-catalog.mjs --check
node --import ./app/scripts/lib/register-ts.mjs app/scripts/check-wiki-batch1.mjs
node --import ./app/scripts/lib/register-ts.mjs app/scripts/check-migration-phase4.mjs
node app\scripts\check-orchestration.mjs
node --import ./app/scripts/lib/register-ts.mjs app/scripts/check-phase4-e2e.mjs
cd app; npm run typecheck; npm run build
```

预期：`verify 132/0/0`；目录 17 页一致；`batch1 36/36`；`migration 30/30`；`orchestration 107/107`；`e2e 67/67`；typecheck/build 退出码 0。

## 引用追问五种问法（复验 04e77bd P1）

```powershell
cd E:\workspace-ai\xuanxue\liuyao
node --import ./app/scripts/lib/register-ts.mjs --input-type=module -e "const {loadCatalog,resolveProjectRoot}=await import('./app/src/server/wiki/catalog.ts');const {planTurn,buildMissingInputReply}=await import('./app/src/server/chat/planner.ts');const root=resolveProjectRoot();const c=loadCatalog(root);const prev=[{sid:'S1',sourceId:'src-777319b69476',locatorValue:'¶0002',qualityStatus:'usable'}];for(const q of ['这次引用了什么？','刚才引用了什么？','上一条引用了什么？','引用了哪些来源？','用了哪些资料？']){const r=planTurn({question:q,projectRoot:root,catalog:c,promptVersion:'phase4-v1',previousCitations:prev});console.log('### '+q);console.log(buildMissingInputReply(r.plan));}"
```

预期：5 问都列出 `S1（src-777319b69476 ¶0002）｜质量：usable`；去掉 `previousCitations` 后输出「无可用引用」。聊天服务与 planner 共用 `isCitationFollowup()`（`planner.ts` 导出、`stream-service.ts` 导入），不再各自复制正则。

## 长讲义已核对章节（复验 04e77bd 第 2 项）

```powershell
node -e "const s=require('fs').readFileSync('wiki/sources/src-a76b03f471fe.md','utf8');console.log(s.includes('¶0215')&&s.includes('¶0218')&&s.includes('爻象')?'已核对章节（爻象 ¶0215–¶0218）存在':'缺失')"
```

来源页 `wiki/sources/src-a76b03f471fe.md` 已回原件核对「第五章 爻象·爻位 第一节 爻象」（`¶0215–¶0218`）并编入 4 条 `source_claim`；其余章节标 `needs_review`，不把「全文已提取」当「规则已核对」。

## 故障注入（临时改名原件、用完恢复）

## 故障注入（只在临时解包副本运行，不改动工作区原件）

```powershell
cd E:\workspace-ai\xuanxue\liuyao
$reloc = 'storage\tmp\unpack-faultinject'
Remove-Item -Recurse -Force $reloc -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $reloc | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory((Resolve-Path "dist\liuyao-wiki-batch1-ead9ad0b-corpus.zip").Path, (Resolve-Path $reloc).Path)
$env:LIUYAO_PROJECT_ROOT = (Resolve-Path $reloc).Path
node --import ./app/scripts/lib/register-ts.mjs app/scripts/check-wiki-batch1-faultinject.mjs
$env:LIUYAO_PROJECT_ROOT = $null
```

预期 6/6：缺原件 / 篡改原件 / 缺清洗文件 → `src-777319b69476` 不可引用，恢复后重新可引用。故障注入脚本只在 `LIUYAO_PROJECT_ROOT` 指向的临时副本内改名/恢复，不改动工作区私有原件。

## 私有资料包

```powershell
Get-FileHash dist\liuyao-wiki-batch1-ead9ad0b-corpus.zip -Algorithm SHA256
```

预期 SHA-256：`09c31228eff616a0dc3dd601e47f7c645c115f574272262d19a355eb9d43a874`。解包 150 文件；无 F 盘副本 `verify` 为 122 通过 / 10 条预期源盘不可访问警告 / 0 失败；解包副本批次检查 **36/36**。包绑定提交 `ead9ad0b`。

## 边界与遗留

- 构建仍有 20 条动态追踪提示 + standalone 发布包核验，归**第五阶段**，本批不判定。
- 本批未调用真实计费模型，不验证现实占断准确率。
- 长讲义除「爻象」一节外，其余章节待后续批次逐章核对。
