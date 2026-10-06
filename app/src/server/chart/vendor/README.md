# 排盘核心的来源与校验（阶段 4）

本目录是阶段 3 排盘模块 paipan/src/ 的**逐字节副本**，供 app 服务端直接打包使用。

- 来源：paipan/src/{core,calendar,rules,index}.ts
- 复制时的上游提交：7467a4b 第四阶段：修正集成设计小节编号（9/10 连续）
- 为什么要副本：Next/webpack 无法解析 app 之外的 TypeScript 源码包（实测报
  Module not found: Can't resolve 'liuyao-paipan'），而任务书要求排盘只能由服务端调用
  阶段 3 模块完成。副本方式属于任务书允许的"编译后的 JS/采用源码"，并用下面的脚本杜绝漂移。
- **一致性校验**：
ode app/scripts/check-paipan-vendor.mjs（逐文件比对 SHA-256，任何一侧
  改动都会非零退出，必须先同步再提交）。
- 运行时依赖：lunar-typescript@1.8.6（app/package.json 已声明，MIT、零传递依赖）。
- 规则版本文件仍以 paipan/rules/rule-profile.v1.json 为单一事实来源（服务端读取该项目内文件）。
