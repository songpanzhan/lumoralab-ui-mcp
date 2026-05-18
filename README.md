# @lumoralab/ui-mcp

一个只读访问 **@lumoralab/ui**  组件库的 MCP (Model Context Protocol) 服务。让 AI 客户端（Claude Desktop / Claude Code / Cursor 等）能够检索组件清单、源码与类型，作为生成业务代码时的上下文。


## 暴露的工具 (Tools)

| 名称                     | 入参                 | 作用                                                                               |
| ------------------------ | -------------------- | ---------------------------------------------------------------------------------- |
| `list_components`        | 无                   | 列出库中所有可用组件：名称、类型（`custom` 自研 / `re-export` antd 透传）、描述、源码与类型文件相对路径 |
| `get_component`          | `{ name: string }`   | 读取指定组件详情：自研组件返回组件描述和文件路径；透传组件返回来源（antd）与文档链接。`name` 大小写不敏感 |
| `get_library_overview`   | 无                   | 返回 `package.json` 摘要、`peerDependencies`、`exports`、安装命令、`import` 示例、入口源码与 README |


## 在 Claude Desktop / Claude Code 中接入

### 方式一：全局安装后使用

```bash
pnpm install -g @lumoralab/ui-mcp
```

`~/.claude/claude_desktop_config.json`（或对应客户端的 MCP 配置）追加：

```json
{
  "mcpServers": {
    "lumoralab-ui": {
      "command": "@lumoralab/ui-mcp"
    }
  }
}
```

### 方式二：本地源码运行

适用于在 monorepo 中开发调试：

```json
{
  "mcpServers": {
    "lumoralab-ui": {
      "command": "node",
      "args": ["<your-project-path>/mcp/@lumoralab-ui/build/index.js"]
    }
  }
}
```

> 将 `<your-project-path>` 替换为实际的项目根目录路径。


构建后并在客户端中重启 MCP，即可在对话中通过 `list_components` / `get_component` / `get_library_overview` 拉取组件库上下文。

## 工作流程

1. AI 询问 "@lumoralab/ui 里有哪些组件？" → 调用 `list_components`
2. AI 想了解 `InvoicePreview` 的基本信息 → 调用 `get_component({ name: 'InvoicePreview' })`，得到组件描述和文件路径
3. AI 想了解整体安装方式与 peerDeps → 调用 `get_library_overview`

## 开发

### 本地测试

构建完成后可以直接用 stdio 协议手动喂三条消息验证服务能跑通：

```bash
(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'; \
 echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'; \
 echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}') \
 | node ./build/index.js
```

预期看到 `initialize` 结果（含 `tools` capability）+ `tools/list` 返回三个工具的 schema。

### 项目结构

```
src/
├── index.ts          # 主服务入口
```

## 技术栈

- **运行时**：Node.js ≥ 20，ESM 模块（`type: module`）
- **MCP SDK**：[`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) v1（稳定版），stdio 传输
- **入参校验**：`zod` v3
- **传输方式**：`StdioServerTransport`（stdin/stdout JSON-RPC）
