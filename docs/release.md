# Release checklist

发布到 npm 前过一遍这份清单。先跑自动部分（一条命令），再做手动 smoke test。

## 自动部分

```bash
npm run release:check
```

[`scripts/release-check.sh`](../scripts/release-check.sh) 会按顺序：

1. `vitest`（包括 `tests/version.test.ts` 的版本字面量回归检查）
2. `tsc --noEmit`
3. `npm run build`
4. `npm pack` 生成 tarball
5. 在临时目录 `npm install` 这个 tarball，跑 `pith-wiki --version`，断言等于 `package.json#version`

退出码 0 = 包可以发了。非 0 = 看输出，最常见的 case 是 `bin/pith-wiki.ts` 又被人写死了字面量版本号。

**这一步不会 touch 你的全局 PATH** —— 装 tarball 在 `mktemp -d` 里的隔离 sandbox，结束清理。

## 手动 smoke test（自动通过后再做）

需要全局装 + 真跑一遍主流程，因为自动测试不调用 LLM。

```bash
# 1. 用临时 HOME，避免污染真实数据
export PITH_WIKI_HOME=~/.pith-wiki-release-test

# 2. 装刚才打的 tarball
npm i -g ./pith-wiki-*.tgz

# 3. 走完真实新用户路径
pith-wiki --version                            # 等于 package.json
pith-wiki init --api-key $DEEPSEEK_API_KEY     # 生成 .env，chmod 600
echo "# release smoke test" | pith-wiki ingest --collection test
pith-wiki list                                  # 应能看到刚 ingest 的条目
pith-wiki query "smoke"                         # 关键词检索
pith-wiki                                       # 进 REPL，问一句

# 4. 清理
npm uninstall -g pith-wiki
rm -rf ~/.pith-wiki-release-test ./pith-wiki-*.tgz
unset PITH_WIKI_HOME
```

## 发布

确认上面两步都过：

```bash
# beta 版（推荐：默认 npm install 拿不到，要 @beta tag）
npm publish --tag beta

# 稳定版：先发 beta 真有人测过，再把 latest 切过来
npm dist-tag add pith-wiki@0.2.0 latest
```

> `0.2.0-beta.x` 这种带 prerelease 后缀的版本号，npm 默认 **不会**进 `latest` tag，但
> `npm publish` 不带 `--tag` 仍然会 publish 到默认 tag，建议显式标 `--tag beta` 避免歧义。

## 历史教训

| 版本 | 教训 |
| --- | --- |
| 0.2.0-beta.0 | `bin/pith-wiki.ts` 写死了 `.version('0.1.0')`，`npm run dev` 抓不到。修复：[`src/version.ts`](../src/version.ts) 运行时读 + [`tests/version.test.ts`](../tests/version.test.ts) 防回归。 |
