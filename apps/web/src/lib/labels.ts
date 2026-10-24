/** Permission labels for UI text (mirror of packages/manifest/src/permissions.ts; tested for drift). */
export const PERMISSION_LABELS: Record<string, string> = {
  "fs.read": "读取文件",
  "fs.write": "写入文件",
  "net.fetch": "访问网络",
  "process.spawn": "运行命令",
  "env.read": "读取环境变量",
  "secrets.read": "读取密钥明文",
  "llm.invoke": "调用模型",
  "session.read": "读取会话",
  "session.modify": "改写请求",
  "hooks.critical": "关键拦截",
  "tools.invoke": "调用其他工具",
  "ui.panel": "显示面板",
  "ui.interact": "与你交互",
};

export const permissionLabel = (id: string): string => PERMISSION_LABELS[id] ?? id;
