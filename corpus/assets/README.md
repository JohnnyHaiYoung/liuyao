# 资料图片

未来按来源 ID 建子目录，存放 Markdown 需要引用的卦象、图表和必要的原页图。例如清洗文件 `corpus/cleaned/src-示例.md` 可以引用 `![第12页卦象](../assets/src-示例/p012-hexagram.png)`。

发布包必须包含被引用的图片。Agent 阅读 Markdown 时只看到图片路径；若需要让 DeepSeek 分析图片，程序要读取文件并以图像输入提交。尽量同时保留可核对的文字或结构化信息，避免仅靠图片识别计算。
