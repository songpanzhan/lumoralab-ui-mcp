#!/usr/bin/env node
/**
 * @lumoralab/ui-mcp — 只读访问 @lumoralab/ui (React) 组件库的 MCP 服务。
 *
 * 数据来源（按优先级）：
 *   1. `@lumoralab/ui/dist/componentSchema.json`（推荐）
 *      —— 从已安装的 npm 包读结构化 schema，AI 拿到的是 props/示例/refMethods，
 *         token 友好、与源码版本一致。
 *   2. 文件系统扫描（fallback）
 *      —— 在 monorepo 内部使用：环境变量 `LUMORALAB_UI_REACT_ROOT` 或自动向上
 *         查找 `pnpm-workspace.yaml`，扫描 `src/components/` 子目录。
 *
 * 设计要点：
 *   1. 只读：不写文件、不修改组件库源码。
 *   2. 路径懒解析：解析失败不会让进程崩溃，工具调用时返回结构化错误。
 *   3. 双模式：schema 模式（npm 安装）和 source 模式（monorepo dev）输出结构有差异，
 *      响应里通过 `dataSource` 字段标明。
 *
 * 暴露的 Tool：
 *   - list_components       列出全部组件
 *   - get_component         读取单个组件详情（props/示例/源码）
 *   - get_library_overview  返回库的整体信息
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

/** 目标组件库的 npm 包名。 */
const PACKAGE_NAME = '@lumoralab/ui';

/** 当前 MCP 覆盖的框架；Vue / Flutter 版本暂未接入。 */
const FRAMEWORK = 'react';

// ---- schema bundle 类型（与 packages/ui/react/scripts/build-schema.ts 对齐）---

type ComponentKind = 'custom' | 're-export';

interface ReExportSchema {
  from: string;
  doc: string;
  note?: string;
}

interface PropSchema {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: string;
  description: string;
}

interface RefMethodSchema {
  name: string;
  signature: string;
  description: string;
}

interface ExampleSchema {
  title: string;
  description?: string;
  code: string;
}

interface ComponentSchema {
  name: string;
  kind: ComponentKind;
  description: string;
  category?: string;
  status?: 'stable' | 'beta' | 'experimental' | 'deprecated';
  reExport?: ReExportSchema;
  props: PropSchema[];
  refMethods?: RefMethodSchema[];
  typeDefs?: Record<string, string>;
  examples: ExampleSchema[];
  notes?: string[];
}

interface SchemaBundle {
  package: string;
  version: string;
  framework: 'react';
  generatedAt: string;
  install: string;
  peerDependencies: Record<string, string>;
  readme: string | null;
  components: ComponentSchema[];
}

// ---- source-mode 元数据（fs 扫描）-------------------------------------------

/**
 * 直接透传 antd 的"未包装"组件白名单（仅 source 模式 fallback 使用）。
 *
 * 为什么静态写死：fs 扫描看不到 re-export 的语义，需要靠这份白名单告诉 AI
 * "这是透传，去看 antd 文档"。在 schema 模式下，re-export 信息直接来自
 * 各组件 `schema.ts`，不依赖这份白名单。
 */
const RE_EXPORTS: Record<string, { from: string; doc: string; note: string }> = {
  Button: {
    from: 'antd',
    doc: 'https://ant.design/components/button',
    note: '直接透传 antd@6 的 Button，未做包装，所有 props 同 antd Button。',
  },
  Input: {
    from: 'antd',
    doc: 'https://ant.design/components/input',
    note: '直接透传 antd@6 的 Input，未做包装，所有 props 同 antd Input。',
  },
};

interface SourceComponentMeta {
  name: string;
  kind: ComponentKind;
  description: string;
  entryFile?: string;
  typesFile?: string;
  reExport?: { from: string; doc: string; note: string };
}

// ---- 数据源解析结果 --------------------------------------------------------

/** MCP 启动后锁定的数据来源。 */
type DataSource =
  | { ok: true; mode: 'schema'; bundle: SchemaBundle; bundlePath: string }
  | { ok: true; mode: 'source'; root: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// 数据源解析
// ---------------------------------------------------------------------------

/**
 * 解析数据源，优先级：
 *   1. 环境变量 `LUMORALAB_UI_REACT_ROOT` → source 模式（开发者显式指定）
 *   2. `@lumoralab/ui/componentSchema.json` 可解析 → schema 模式
 *   3. 自动向上找 `pnpm-workspace.yaml` → source 模式
 *
 * 关键设计：失败时返回 `{ ok: false, error }`，**不抛异常**。
 */
function resolveDataSource(): DataSource {
  // 1) 环境变量优先 → source 模式
  const override = process.env.LUMORALAB_UI_REACT_ROOT;
  if (override) {
    const abs = path.resolve(override);
    if (!existsSync(path.join(abs, 'package.json'))) {
      return {
        ok: false,
        error: `LUMORALAB_UI_REACT_ROOT="${abs}" 不存在 package.json，无法定位 @lumoralab/ui。`,
      };
    }
    return { ok: true, mode: 'source', root: abs };
  }

  // 2) 尝试从已安装的 npm 包加载 dist/componentSchema.json
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schemaBundle = tryLoadSchemaBundle(here);
  if (schemaBundle) return schemaBundle;

  // 3) 自动向上查找 pnpm-workspace.yaml → source 模式
  let dir = here;
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      const candidate = path.join(dir, 'packages', 'ui', 'react');
      if (existsSync(path.join(candidate, 'package.json'))) {
        return { ok: true, mode: 'source', root: candidate };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return {
    ok: false,
    error:
      '无法定位 @lumoralab/ui：未找到已安装的 npm 包 (dist/componentSchema.json) 也未找到本地 monorepo (pnpm-workspace.yaml)。请安装 @lumoralab/ui 或设置 LUMORALAB_UI_REACT_ROOT 指向 packages/ui/react。',
  };
}

/**
 * 尝试从 node_modules 加载 `@lumoralab/ui/dist/componentSchema.json`。
 *
 * 用 `createRequire` 而非动态 import：require.resolve 走的是磁盘解析，
 * 不会触发 ESM loader、不会执行任何代码，纯粹拿到 JSON 文件路径。
 */
function tryLoadSchemaBundle(startDir: string): DataSource | null {
  try {
    const requireFromHere = createRequire(path.join(startDir, 'noop.js'));
    const bundlePath = requireFromHere.resolve(`${PACKAGE_NAME}/dist/componentSchema.json`);
    const raw = readFileSync(bundlePath, 'utf8');
    const bundle = JSON.parse(raw) as SchemaBundle;
    if (!bundle.components || !Array.isArray(bundle.components)) {
      return null;
    }
    return { ok: true, mode: 'schema', bundle, bundlePath };
  } catch {
    return null;
  }
}

/** 单进程内缓存解析结果。 */
let cachedSource: DataSource | null = null;
function getDataSource(): DataSource {
  if (!cachedSource) cachedSource = resolveDataSource();
  return cachedSource;
}

// ---------------------------------------------------------------------------
// 工具结果辅助函数
// ---------------------------------------------------------------------------

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

function okResult(body: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
  };
}

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function relFromRoot(reactRoot: string, absPath: string): string {
  return path.relative(reactRoot, absPath).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// source 模式：扫描磁盘
// ---------------------------------------------------------------------------

async function discoverComponentsFromFs(reactRoot: string): Promise<SourceComponentMeta[]> {
  const componentsDir = path.join(reactRoot, 'src', 'components');
  const list: SourceComponentMeta[] = [];

  for (const [name, info] of Object.entries(RE_EXPORTS)) {
    list.push({
      name,
      kind: 're-export',
      description: info.note,
      reExport: info,
    });
  }

  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fs.readdir(componentsDir, { withFileTypes: true });
  } catch {
    return list;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // re-export 目录（只有 schema.ts 没有 index.tsx）已经在白名单里覆盖
    if (RE_EXPORTS[entry.name]) continue;

    const compDir = path.join(componentsDir, entry.name);
    const candidates = ['index.tsx', 'index.ts', `${entry.name}.tsx`, `${entry.name}.ts`];
    let entryFile: string | undefined;
    for (const c of candidates) {
      const p = path.join(compDir, c);
      if (existsSync(p)) {
        entryFile = p;
        break;
      }
    }
    if (!entryFile) continue;

    const typesPath = path.join(compDir, 'types.ts');
    const typesFile = existsSync(typesPath) ? typesPath : undefined;

    list.push({
      name: entry.name,
      kind: 'custom',
      description: `自研组件，源码位于 src/components/${entry.name}/`,
      entryFile,
      typesFile,
    });
  }

  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

async function handleList(ds: Extract<DataSource, { ok: true }>) {
  if (ds.mode === 'schema') {
    const summary = ds.bundle.components.map((c) => ({
      name: c.name,
      kind: c.kind,
      category: c.category,
      status: c.status,
      description: c.description,
      reExportedFrom: c.reExport?.from,
    }));
    return {
      dataSource: 'schema' as const,
      package: ds.bundle.package,
      version: ds.bundle.version,
      framework: ds.bundle.framework,
      count: summary.length,
      components: summary,
    };
  }

  const list = await discoverComponentsFromFs(ds.root);
  const summary = list.map((c) => ({
    name: c.name,
    kind: c.kind,
    description: c.description,
    entryFile: c.entryFile ? relFromRoot(ds.root, c.entryFile) : null,
    typesFile: c.typesFile ? relFromRoot(ds.root, c.typesFile) : null,
    reExportedFrom: c.reExport?.from,
  }));
  return {
    dataSource: 'source' as const,
    package: PACKAGE_NAME,
    framework: FRAMEWORK,
    count: summary.length,
    components: summary,
  };
}

async function handleGetComponent(ds: Extract<DataSource, { ok: true }>, name: string) {
  if (ds.mode === 'schema') {
    const found = ds.bundle.components.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!found) {
      return {
        dataSource: 'schema' as const,
        found: false,
        requested: name,
        available: ds.bundle.components.map((c) => c.name),
      };
    }
    return {
      dataSource: 'schema' as const,
      found: true,
      importExample: `import { ${found.name} } from '${PACKAGE_NAME}';`,
      ...found,
    };
  }

  const all = await discoverComponentsFromFs(ds.root);
  const found = all.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!found) {
    return {
      dataSource: 'source' as const,
      found: false,
      requested: name,
      available: all.map((c) => c.name),
    };
  }

  if (found.kind === 're-export') {
    return {
      dataSource: 'source' as const,
      found: true,
      name: found.name,
      kind: 're-export' as const,
      description: found.description,
      reExportedFrom: found.reExport!.from,
      doc: found.reExport!.doc,
      importExample: `import { ${found.name} } from '${PACKAGE_NAME}';`,
      note: '此组件未在 @lumoralab/ui 中包装，直接透传 antd 同名组件。Props 与文档请参考 antd 官方文档。',
    };
  }

  const types = found.typesFile ? await readFileSafe(found.typesFile) : null;
  return {
    dataSource: 'source' as const,
    found: true,
    name: found.name,
    kind: 'custom' as const,
    description: found.description,
    importExample: `import { ${found.name} } from '${PACKAGE_NAME}';`,
    entryFile: found.entryFile ? relFromRoot(ds.root, found.entryFile) : null,
    typesFile: found.typesFile ? relFromRoot(ds.root, found.typesFile) : null,
    types,
  };
}

async function handleOverview(ds: Extract<DataSource, { ok: true }>) {
  if (ds.mode === 'schema') {
    const sampleNames = ds.bundle.components.slice(0, 6).map((c) => c.name);
    return {
      dataSource: 'schema' as const,
      package: ds.bundle.package,
      framework: ds.bundle.framework,
      version: ds.bundle.version,
      generatedAt: ds.bundle.generatedAt,
      bundlePath: ds.bundlePath,
      peerDependencies: ds.bundle.peerDependencies,
      install: ds.bundle.install,
      importExample: [
        sampleNames.length > 0
          ? `import { ${sampleNames.join(', ')} } from '${PACKAGE_NAME}';`
          : `import { /* components */ } from '${PACKAGE_NAME}';`,
        `import '${PACKAGE_NAME}/dist/index.css';`,
      ].join('\n'),
      readme: ds.bundle.readme,
    };
  }

  const reactRoot = ds.root;
  const pkgRaw = await readFileSafe(path.join(reactRoot, 'package.json'));
  const readme = await readFileSafe(path.join(reactRoot, 'README.md'));
  const indexSrc = await readFileSafe(path.join(reactRoot, 'src', 'index.ts'));
  const components = await discoverComponentsFromFs(reactRoot);
  const sampleNames = components.slice(0, 6).map((c) => c.name);

  let pkg: any = null;
  if (pkgRaw) {
    try {
      pkg = JSON.parse(pkgRaw);
    } catch {
      /* ignore */
    }
  }

  return {
    dataSource: 'source' as const,
    package: PACKAGE_NAME,
    framework: FRAMEWORK,
    rootPath: reactRoot,
    version: pkg?.version ?? null,
    description: pkg?.description ?? null,
    peerDependencies: pkg?.peerDependencies ?? {},
    exports: pkg?.exports ?? {},
    install: `pnpm add ${PACKAGE_NAME} antd react react-dom`,
    importExample: [
      sampleNames.length > 0
        ? `import { ${sampleNames.join(', ')} } from '${PACKAGE_NAME}';`
        : `import { /* components */ } from '${PACKAGE_NAME}';`,
      `import '${PACKAGE_NAME}/dist/index.css';`,
    ].join('\n'),
    entryFile: indexSrc ? relFromRoot(reactRoot, path.join(reactRoot, 'src', 'index.ts')) : null,
    entrySource: indexSrc,
    readme,
  };
}

// ---------------------------------------------------------------------------
// MCP 服务与工具注册
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: '@lumoralab/ui-mcp',
  version: '1.0.0',
});

server.registerTool(
  'list_components',
  {
    title: '列出 @lumoralab/ui 组件',
    description:
      '列出 @lumoralab/ui (React) 导出的所有组件，包含名称、类型（custom / re-export）、分类与描述。优先返回结构化 schema（来自已安装的 npm 包）。',
  },
  async () => {
    const ds = getDataSource();
    if (!ds.ok) return errorResult(ds.error);
    return okResult(await handleList(ds));
  },
);

server.registerTool(
  'get_component',
  {
    title: '读取组件详情',
    description:
      '根据组件名读取详情：schema 模式返回 props/示例/refMethods/类型定义；source 模式返回源码与类型文件路径。',
    inputSchema: {
      name: z
        .string()
        .min(1)
        .describe('组件名，例如 "InvoicePreview"、"Button"、"Input"。大小写不敏感。'),
    },
  },
  async ({ name }) => {
    const ds = getDataSource();
    if (!ds.ok) return errorResult(ds.error);
    return okResult(await handleGetComponent(ds, name));
  },
);

server.registerTool(
  'get_library_overview',
  {
    title: '读取 @lumoralab/ui 库概览',
    description:
      '返回 @lumoralab/ui 的版本、peerDependencies、安装命令、import 示例、README。schema 模式还会带上 schema 生成时间与 bundle 路径。',
  },
  async () => {
    const ds = getDataSource();
    if (!ds.ok) return errorResult(ds.error);
    return okResult(await handleOverview(ds));
  },
);

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

const initial = getDataSource();
if (!initial.ok) {
  console.error(`[@lumoralab/ui-mcp] 警告：${initial.error}`);
  console.error('[@lumoralab/ui-mcp] 服务仍会启动，工具调用会返回结构化错误（isError: true）。');
} else if (initial.mode === 'schema') {
  console.error(
    `[@lumoralab/ui-mcp] 数据源：schema（${initial.bundle.components.length} 个组件，version=${initial.bundle.version}）`,
  );
} else {
  console.error(`[@lumoralab/ui-mcp] 数据源：source（${initial.root}）`);
}

const transport = new StdioServerTransport();
await server.connect(transport);
