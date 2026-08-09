# foundry-ai-runtime

供 Foundry 系列项目复用的结构化 AI 生成运行时。它把模型调用统一成一个经过 Zod 校验的 `generateObject()`，支持三种 transport：

- OpenAI-compatible HTTP，固定使用 `/v1/chat/completions`
- Codex CLI
- Claude Code CLI

这个包只统一 transport、结构化输出、超时、重试、错误和可用性探测。业务 prompt、领域 schema、repair、cache、跨 provider fallback 和模型选择仍由调用方负责。

## Requirements

- Node.js 22 或更高版本
- ESM
- Zod 4

## Install

包目前直接从 GitHub 安装。只使用 OpenAI-compatible HTTP 时，安装主包和 peer dependency `zod`：

```bash
npm install git+ssh://git@github.com/lemin9538/foundry-ai-runtime.git#main zod
```

如果当前网络无法访问 GitHub SSH 的 22 端口，改用官方 SSH 443 入口：

```bash
npm install git+ssh://git@ssh.github.com:443/lemin9538/foundry-ai-runtime.git#main zod
```

使用 Codex CLI 时，同时安装 Codex adapter：

```bash
npm install --omit=optional git+ssh://git@github.com/lemin9538/foundry-ai-runtime.git#main zod ai-sdk-provider-codex-cli
```

使用 Claude Code CLI 时，同时安装 Claude adapter：

```bash
npm install --omit=optional git+ssh://git@github.com/lemin9538/foundry-ai-runtime.git#main zod ai-sdk-provider-claude-code
```

两个 CLI 都需要时，可以一次安装：

```bash
npm install --omit=optional git+ssh://git@github.com/lemin9538/foundry-ai-runtime.git#main zod ai-sdk-provider-codex-cli ai-sdk-provider-claude-code
```

正式项目不要长期跟随 `#main`，应替换为发布 tag 或固定 commit SHA。例如固定到首个可用版本：

```bash
npm install git+ssh://git@github.com/lemin9538/foundry-ai-runtime.git#dafc8ac83557b16f09658ab62ed2848181f68e93 zod
```

`--omit=optional` 避免 adapter 再安装其可选的内置 CLI 二进制。运行时会明确调用系统 PATH 中的 `codex` 或 `claude`；也可以通过 `executable` 指定路径。CLI 本身需要提前安装并登录：

```bash
codex login status
claude auth status --json
```

若某个 CLI provider 被使用但 adapter 未安装，运行时会抛出 `AIRuntimeError`，错误码为 `ADAPTER_NOT_INSTALLED`。HTTP 用户不会加载或需要任何 CLI adapter。

## OpenAI-Compatible HTTP

```ts
import { generateObject } from "foundry-ai-runtime";
import { z } from "zod";

const StoryboardSchema = z.object({
  title: z.string(),
  scenes: z.array(z.object({
    id: z.string(),
    summary: z.string(),
  })),
});

const result = await generateObject({
  provider: {
    kind: "openai-compatible",
    baseURL: "http://127.0.0.1:11434/v1",
    model: "qwen3:14b",
    // apiKey: process.env.OPENAI_API_KEY,
    // headers: { "x-tenant-id": "content-foundry" },
  },
  schema: StoryboardSchema,
  schemaName: "storyboard",
  system: "You produce concise production storyboards.",
  prompt: "Create a two-scene storyboard about structured AI output.",
});

console.log(result.value);
```

`baseURL` 是 API 根地址，而不是完整 endpoint。运行时会请求：

```text
{baseURL}/chat/completions
```

HTTP 只兼容 OpenAI Chat Completions 协议，不兼容 Responses API、Anthropic Messages API 或各厂商的私有协议。OpenAI、vLLM、Ollama、llama.cpp、LM Studio 等服务只要正确实现该兼容接口，就使用同一种配置。

默认 `structuredOutputs` 为 `false`。运行时在线上发送：

```json
{ "response_format": { "type": "json_object" } }
```

同时仍在客户端用传入的 Zod schema 验证结果。确认目标服务支持 OpenAI `json_schema` 后，可以启用原生 schema：

```ts
const provider = {
  kind: "openai-compatible" as const,
  baseURL: "https://api.example.com/v1",
  model: "model-name",
  apiKey: process.env.MODEL_API_KEY,
  structuredOutputs: true,
};
```

此时请求使用 `response_format.type = "json_schema"`，并包含由 Zod schema 转换出的 JSON Schema。

## Codex CLI

```ts
import { generateObject } from "foundry-ai-runtime";
import { z } from "zod";

const result = await generateObject({
  provider: {
    kind: "codex-cli",
    model: "gpt-5.4-mini",
    // executable: "/usr/local/bin/codex",
  },
  schema: z.object({ answer: z.string(), confidence: z.number() }),
  system: "Do not inspect files or run commands. Return only the requested data.",
  prompt: "Summarize why schema validation matters in one sentence.",
});
```

每次调用都在新建的空临时目录中运行，完成后删除该目录。Codex adapter 固定使用：

- 系统 `codex` 可执行文件
- `approvalMode: "never"`
- `sandboxMode: "read-only"`
- `skipGitRepoCheck: true`
- `history.persistence = "none"`
- `mcp_servers = {}` and `web_search = "disabled"`
- 禁用 adapter 日志

这些设置隔离业务仓库并阻止写文件，但不等价于容器或虚拟机级安全边界。Codex 自身的用户级配置仍可能存在；不要把不可信 prompt 当成可以执行任意 agent 工作的任务传入。本包定位是结构化生成，不是 coding-agent orchestration。

## Claude Code CLI

```ts
const result = await generateObject({
  provider: {
    kind: "claude-cli",
    model: "sonnet",
    // executable: "/usr/local/bin/claude",
  },
  schema: StoryboardSchema,
  prompt: "Create a compact two-scene storyboard.",
});
```

Claude Code 同样在一次性的空临时目录中运行，并固定：

- `maxTurns: 1`
- `permissionMode: "dontAsk"`
- `tools: []`
- `settingSources: []`
- `persistSession: false`
- 禁用 adapter 日志

因此不会加载项目或用户的 `CLAUDE.md`、Skills 和 settings source，也不会向 Claude 暴露工具。

## Timeout And Retry

默认每次 attempt 的超时为 300 秒，最大为 3600 秒。默认最多尝试 2 次；AI SDK 自带的内部重试被关闭，所有 provider 都由本包统一计数和退避。

```ts
const result = await generateObject({
  provider,
  schema,
  prompt,
  timeoutMs: 120_000,
  retry: {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 10_000,
  },
  signal: abortController.signal,
});
```

可重试情况包括 timeout、HTTP 429、HTTP 5xx、provider overload、常见网络故障和不符合 schema 的模型输出。认证失败、缺失 adapter、缺失 CLI、无效配置和外部 abort 不重试。HTTP `Retry-After` 与 `retry-after-ms` 会被读取，但不会突破 `retry.maxDelayMs`。

成功结果包含：

```ts
interface GenerateObjectResult<T> {
  value: T;
  provider: "openai-compatible" | "codex-cli" | "claude-cli";
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
  finishReason?: string;
  attempts: number;
  durationMs: number;
}
```

## Error Contract

所有运行时失败统一为 `AIRuntimeError`：

```ts
import { AIRuntimeError } from "foundry-ai-runtime";

try {
  await generateObject(request);
} catch (error) {
  if (error instanceof AIRuntimeError) {
    console.error(error.code, error.provider, error.retryable, error.attempts);
  }
}
```

稳定错误码：

```text
INVALID_CONFIG
ADAPTER_NOT_INSTALLED
PROVIDER_UNAVAILABLE
AUTHENTICATION_FAILED
RATE_LIMITED
OVERLOADED
TIMEOUT
ABORTED
INVALID_OUTPUT
REQUEST_FAILED
```

公开错误消息会折叠换行、截断长度并清理 API key、认证 header、完整 prompt 和 Bearer token。不要依赖具体错误文本做程序分支，使用 `code`、`retryable` 和 `statusCode`。

## Provider Inspection

`inspectProvider()` 不调用模型，也不消耗推理额度。

```ts
import { inspectProvider } from "foundry-ai-runtime";

const cliStatus = await inspectProvider({
  kind: "codex-cli",
  model: "gpt-5.4-mini",
});

const httpStatus = await inspectProvider({
  kind: "openai-compatible",
  baseURL: "http://127.0.0.1:11434/v1",
  model: "qwen3:14b",
}, {
  probeHTTP: true,
  timeoutMs: 5_000,
});
```

CLI 检查运行 `--version` 和对应的 auth status 命令，并同时确认 optional adapter 可以加载。返回值不会包含 auth 命令原始 stdout/stderr，避免泄露账号和凭据。HTTP 默认只验证配置；只有 `probeHTTP: true` 时才请求 `{baseURL}/models`。

字段语义：

- `configured`：配置在语法上完整有效
- `installed`：CLI 可执行文件存在并能启动
- `authenticated`：auth status 或 HTTP probe 被接受
- `reachable`：HTTP endpoint 返回了响应，包括非 2xx 响应
- `available`：当前检查范围内可实际使用

## Environment Policy

本包不读取项目专用环境变量，也不猜测 provider。调用方负责把自己的配置映射为 `AIProviderConfig`。这样不同仓库可以继续使用各自的配置命名，而公共运行时不需要知道 `SCENE2VIDEO_*`、`DEEPSEEK_*` 或其他业务前缀。

CLI provider 的 `env` 只用于显式覆盖或移除子进程环境变量：

```ts
const provider = {
  kind: "codex-cli" as const,
  model: "gpt-5.4-mini",
  env: {
    HTTPS_PROXY: "http://127.0.0.1:7890",
    REMOVE_FROM_CHILD: undefined,
  },
};
```

## Development

```bash
npm install
npm run check
npm pack --dry-run
```

真实 CLI smoke test 需要显式指定模型，避免脚本替使用者选择或产生意外费用：

```bash
FOUNDRY_AI_MODEL=gpt-5.4-mini npm run smoke:codex
FOUNDRY_AI_MODEL=sonnet npm run smoke:claude
```

可选变量：

```text
FOUNDRY_AI_EXECUTABLE
FOUNDRY_AI_TIMEOUT_MS
```
