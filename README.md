# @lumoralab/ui-mcp

一个只读访问 [`@lumoralab/ui`](../../packages/ui/react) 组件库的 MCP (Model Context Protocol) 服务。让 AI 客户端（Claude Desktop / Claude Code / Cursor 等）能够检索组件清单、源码与类型，作为生成业务代码时的上下文。

> 仅读取 React 版本（`packages/ui/react`）。Vue 与 Flutter 版本暂不在覆盖范围内。

## 特性

- **只读访问**：不会修改组件库源码，安全可靠
- **动态扫描**：自动扫描组件目录，新增组件无需修改服务代码
- **类型安全**：完整的 TypeScript 支持
- **错误处理**：优雅处理各种错误情况，提供清晰的错误信息

## 暴露的工具 (Tools)

| 名称                     | 入参                 | 作用                                                                               |
| ------------------------ | -------------------- | ---------------------------------------------------------------------------------- |
| `list_components`        | 无                   | 列出库中所有可用组件：名称、类型（`custom` 自研 / `re-export` antd 透传）、描述、源码与类型文件相对路径 |
| `get_component`          | `{ name: string }`   | 读取指定组件：自研组件返回 `types.ts` 内容（包含类型定义）；透传组件返回来源（antd）与文档链接。`name` 大小写不敏感 |
| `get_library_overview`   | 无                   | 返回 `package.json` 摘要、`peerDependencies`、`exports`、安装命令、`import` 示例、入口源码与 README |

## 当前覆盖的组件

实现来自 [`packages/ui/react/src/components/index.tsx`](../../packages/ui/react/src/components/index.tsx)：

- **InvoicePreview** — 自研发票预览弹窗，源码见 [`packages/ui/react/src/components/InvoicePreview`](../../packages/ui/react/src/components/InvoicePreview)
- **Button** — 透传自 `antd` 的 `Button`，未做包装
- **Input** — 透传自 `antd` 的 `Input`，未做包装

## 安装与使用

### 依赖安装

```bash
# 方式 A：在 monorepo 根使用 pnpm 一次性装齐所有 workspace
pnpm install

# 方式 B：单独在本目录构建
cd mcp/@lumoralab-ui
pnpm install
pnpm run build
```

### 构建

产物输出到 `build/index.js`，可执行（含 `#!/usr/bin/env node` shebang），由 `package.json` 的 `bin` 字段暴露为 `@lumoralab/ui-mcp` 命令。

```bash
pnpm run build
```

## 配置

### 仓库根目录解析

服务启动时会自动向上查找 `pnpm-workspace.yaml`，定位到 `packages/ui/react`。如果在非标准布局下运行（如全局安装、独立部署），可通过环境变量覆盖：

```bash
LUMORALAB_UI_REACT_ROOT=/abs/path/to/packages/ui/react @lumoralab/ui-mcp
```

解析失败时**进程不会崩溃**：MCP 服务正常握手，但所有工具调用都会返回 `isError: true` 的结构化错误（AI 客户端能直接看到中文原因），同时往 stderr 打印一行警告，便于排查。

## 在 Claude Desktop / Claude Code 中接入

`~/.claude/claude_desktop_config.json`（或对应客户端的 MCP 配置）追加：

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

如需把 MCP 部署在仓库以外，使用环境变量指向真实路径：

```json
{
  "mcpServers": {
    "lumoralab-ui": {
      "command": "node",
      "args": ["/opt/lumoralab-ui-mcp/build/index.js"],
      "env": {
        "LUMORALAB_UI_REACT_ROOT": "/opt/lumoralab/packages/ui/react"
      }
    }
  }
}
```

构建后并在客户端中重启 MCP，即可在对话中通过 `list_components` / `get_component` / `get_library_overview` 拉取组件库上下文。

## 工作流程

1. AI 询问 "@lumoralab/ui 里有哪些组件？" → 调用 `list_components`
2. AI 想了解 `InvoicePreview` 的 props → 调用 `get_component({ name: 'InvoicePreview' })`，得到 `types.ts` + 入口源码
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
