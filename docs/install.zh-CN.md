# pith-brain 基础安装方案

本文面向本仓库的源码安装。项目目录可以叫 `pith-brain`，当前 npm 包与 CLI 命令仍叫 `pith-wiki`，桌面应用名为 `pith`。日常使用可启动桌面端，命令行可用于初始化、入库和检索；不需要部署数据库或向量服务。

## 1. 环境准备

- macOS 或 Linux；Windows 为 best-effort，本文的命令使用 Bash / Zsh 语法。
- Node.js **22.19.0 或更高的 22.x 版本**，以及随 Node 安装的 npm。虽然根 `package.json` 标注 `>=20`、`.nvmrc` 为 `20`，当前锁文件中的 `@earendil-works/pi-ai` 要求 `>=22.19.0`，本方案按实际依赖要求准备环境。
- Git（需要克隆时使用），以及能够下载 npm 依赖和 Electron 的网络。
- 使用默认 DeepSeek 方案进行对话、入库时，需要有效 API key 和可访问的模型服务；本地 `list` / `get` / `query` 不需要 key。

先检查工具版本：

```bash
node --version
npm --version
git --version
```

## 2. 获取源码并安装依赖

已有项目时直接进入现有 `pith-brain` 目录，跳过克隆。全新环境执行：

```bash
git clone https://github.com/l-zhi/pith-wiki.git pith-brain
cd pith-brain
```

以下命令均从仓库根目录开始。根项目和 `desktop/` 各有独立的锁文件与依赖目录：

```bash
npm ci
npm --prefix desktop ci
```

只使用 CLI 时可跳过第二条。`npm ci` 按锁文件安装，会重新创建对应的 `node_modules`。

## 3. 初始化基础配置

为让开发启动和构建后启动使用同一套数据，在后续启动所用的终端中设置：

```bash
export PITH_WIKI_HOME="$HOME/.pith-wiki"
npm run dev -- init
```

交互式初始化时选择 provider、填写 API key；首次体验可跳过自动监听目录。此时写入 `$PITH_WIKI_HOME/config.json`。已有配置时 `init` 默认不会覆盖，会提示 `nothing written` 并返回退出码 1；直接编辑已有文件即可。

也可以先生成不含密钥的最小配置，再用编辑器填写 `providers.deepseek.apiKey`：

```bash
npm run dev -- init --provider deepseek --no-prompt
```

默认 DeepSeek 模板补全后的结构如下，`YOUR_API_KEY` 需替换为自己的 key：

```json
{
  "providers": {
    "deepseek": {
      "baseURL": "https://api.deepseek.com",
      "model": "deepseek-chat",
      "apiKey": "YOUR_API_KEY"
    }
  },
  "activeProvider": "deepseek"
}
```

当前配置使用 `config.json`，不使用 `.env`。密钥也可以放在同一文件的 `secrets` 中，再通过 provider 的 `apiKeyEnv` 引用；基础安装任选一种即可。更多字段见 [配置说明](config.zh-CN.md)。

`PITH_WIKI_HOME` 只在当前终端及其子进程中生效，新终端需重新设置。不设置时，CLI 的 `npm run dev` 和桌面开发模式默认使用 `~/.pith-wiki-dev/`，构建后启动默认使用 `~/.pith-wiki/`。知识库默认在所选 home 的 `wiki-data/` 下；切换目录不会自动搬迁已有数据。

## 4. 启动桌面端或 CLI

桌面端开发启动：

```bash
npm --prefix desktop run dev
```

应出现应用窗口。若出现首次引导，按界面完成 provider 配置；监听笔记目录可稍后在设置中添加。

桌面端构建后启动（先退出开发进程）：

```bash
npm --prefix desktop run build
npm --prefix desktop start
```

CLI 构建后启动：

```bash
npm run build
npm start -- --help
npm start
```

`npm start` 打开交互式 REPL；开发时可直接用 `npm run dev`。在仓库中使用这些脚本无需全局安装 `pith-wiki`。

## 5. 安装验证

先验证不依赖模型服务的本地路径（从仓库根目录运行）：

```bash
npm run typecheck
npm run build
npm start -- --version
npm start -- list
npm start -- query "安装验证"
```

预期：类型检查和构建退出码为 0，版本与根 `package.json` 一致；空库显示 `(no entries)` 和 `(no matching entries)`，这不是安装失败。已有知识库时会列出或检索已有条目。

配置好真实 key 后，验证一次模型入库和读取：

```bash
printf '%s\n' '安装验证：pith-brain 将文档整理为本地 Markdown 知识库，支持关键词检索。' | npm start -- ingest --collection install-check
npm start -- list --collection install-check
```

预期：入库成功，列表中出现新条目，文件位于 `$PITH_WIKI_HOME/wiki-data/install-check/`。再运行 `npm start -- get <实际输出的条目ID>`，应能读回内容；执行前将占位符替换为真实 ID。桌面端验证以窗口打开、配置可保存、发送消息后得到回复为准。模型调用成功与否依赖实际服务鉴权和网络，离线检查不能代替这一项。

## 6. Docker 安装（CLI）

Docker 方式可替代上面的本机 Node 安装。宿主机需要安装并启动 Docker Desktop（macOS）或 Docker Engine（Linux），并已获取本仓库源码；进入仓库根目录执行后续命令。先运行 `docker version`，确认 Client 和 Server 都能正常显示。

本仓库的 [Dockerfile](../Dockerfile) 构建 CLI 镜像，使用 Node 22 和独立构建阶段；不运行 Electron 桌面窗口，也不提供 Web 页面或桌面定时任务，因此无需映射端口。构建上下文由 [.dockerignore](../.dockerignore) 限定为 CLI 所需文件，配置和密钥在运行时写入数据卷。

### 构建镜像并初始化

```bash
docker build --pull -t pith-brain:local .
docker run --rm pith-brain:local --version
docker volume create pith-brain-data
docker run --rm -it --mount type=volume,src=pith-brain-data,dst=/data pith-brain:local init
```

`pith-brain:local` 是本地构建的镜像名。首次初始化按提示选择 provider、填写 API key，暂时跳过监听目录。镜像以非 root 的 `node` 用户运行，固定 `PITH_WIKI_HOME=/data`；配置写入卷中的 `/data/config.json`，知识库写入 `/data/wiki-data/`。每次启动都挂载同一个卷，`--rm` 删除容器后数据仍会保留；卷的生命周期见 [Docker 官方说明](https://docs.docker.com/engine/storage/volumes/)。

已有配置时再次 `init` 会返回退出码 1 并提示 `nothing written`。需要修改卷中配置时，可先导出到宿主机（目录内文件包含密钥），用编辑器修改，再写回：

```bash
mkdir -p "$HOME/.pith-brain-docker"
docker run --rm --mount type=volume,src=pith-brain-data,dst=/data --entrypoint cat pith-brain:local /data/config.json > "$HOME/.pith-brain-docker/config.json"
chmod 600 "$HOME/.pith-brain-docker/config.json"
# 用编辑器修改上面的 config.json，完成后执行：
docker run --rm -i --mount type=volume,src=pith-brain-data,dst=/data --entrypoint sh pith-brain:local -c 'umask 077; cat > /data/config.json' < "$HOME/.pith-brain-docker/config.json"
```

### 启动与验证

```bash
docker run --rm --mount type=volume,src=pith-brain-data,dst=/data pith-brain:local list
docker run --rm --mount type=volume,src=pith-brain-data,dst=/data pith-brain:local query "安装验证"
docker run --rm -it --mount type=volume,src=pith-brain-data,dst=/data pith-brain:local chat
```

前两条不需要 API key：空库应分别显示 `(no entries)` 和 `(no matching entries)`。第三条进入交互式 REPL，需要有效模型配置；`-it` 为交互终端所需参数，参见 [Docker 容器运行说明](https://docs.docker.com/engine/containers/run/)。

配置真实 key 后，可以通过标准输入验证入库；管道输入使用 `-i`，不分配 TTY：

```bash
printf '%s\n' '安装验证：pith-brain 支持将文档整理为本地知识库。' | docker run --rm -i --mount type=volume,src=pith-brain-data,dst=/data pith-brain:local ingest --collection install-check
docker run --rm --mount type=volume,src=pith-brain-data,dst=/data pith-brain:local list --collection install-check
```

预期第二个新容器仍能列出第一个容器入库的条目，证明知识库已持久化。基础镜像包含内置 skills 文件；需要额外 CLI 的技能须另行安装其依赖。

### 读取宿主机笔记（可选）

容器无法直接读取宿主机的 `/Users/...` 路径。将示例 `notes` 目录替换为自己的实际目录并挂载到容器工作区 `/workspace`：

```bash
mkdir -p "$HOME/notes"
docker run --rm -it \
  --mount type=volume,src=pith-brain-data,dst=/data \
  --mount "type=bind,src=$HOME/notes,dst=/workspace,readonly" \
  pith-brain:local chat
```

例如宿主机 `$HOME/notes/article.md` 在容器内是 `/workspace/article.md`。此挂载只读，适合读取和入库原始笔记；知识库写入仍由 `/data` 卷承接。若配置自动监听，`watchDirs[].path` 应填 `/workspace`，后续每次启动均需同样挂载。宿主机旧配置中的绝对路径必须改成相应容器路径。

更新源码后重新执行构建命令，再使用同一卷启动即可。没有配置数据卷的临时容器不用于保存正式知识库。

## 7. 常见问题

| 现象 | 处理方式 |
|---|---|
| 安装提示 `EBADENGINE` 或运行出现 ESM / 语法错误 | 检查 `node --version`，按本文要求使用 Node 22.19.0+ 的 22.x，再安装依赖；不要只依赖旧 `.nvmrc`。 |
| 桌面端提示缺少模块或 Electron | 确认根目录和 `desktop/` 都完成 `npm ci`；Electron 下载失败时检查网络后重试桌面依赖安装。 |
| 提示没有 API key | 检查当前 `PITH_WIKI_HOME` 下的 `config.json`，确认 `activeProvider` 对应条目已填写真实 `apiKey`。 |
| 开发模式有数据，构建后却是空库 | 检查两个启动终端的 `PITH_WIKI_HOME` 是否一致。 |
| `config.json` 解析失败 | 按报错修正 JSON（双引号、无注释、无尾逗号），保留已有 provider 和目录配置。 |
| 桌面开发端口 `5273` 被占用 | 退出此前启动的桌面开发进程后重试。 |
| Docker 无法连接 daemon / socket | 启动 Docker Desktop 或 Docker Engine，再用 `docker version` 确认 Server 可用。 |
| Docker 中找不到宿主机文件 | 添加笔记目录挂载，并使用 `/workspace/...` 等容器内路径。 |

Skills 等扩展可在基础安装验证后按需添加；不属于基础启动的必装依赖。CLI 的进一步用法见 [使用说明](usage.zh-CN.md)。
