> [!WARNING]
> **重要：使用前请务必备份数据！**
> 本项目是一个基于 AI (Vibe Coding) 生成的临时替代方案。由于代码未经严谨的人工审查，可能存在潜在 Bug。请务必在测试环境使用，并确保数据已备份。

## 项目背景

原项目前端是 [haierkeys/obsidian-fast-note-sync](https://github.com/haierkeys/obsidian-fast-note-sync)
根据其代码vibe了一个 CLI 工具，在未安装 Obsidian 的情况下可直接将本地文件夹作为库进行同步,方便ai如[openclaw](https://github.com/openclaw/openclaw)在资源有限的服务器上也能修改 Obsidian 里的内容
需要搭配其后端食用[haierkeys/fast-note-sync-service](https://github.com/haierkeys/fast-note-sync-service)
## 功能

- 笔记同步（NoteSync）
- 附件同步（FileSync）
- 文件夹同步（FolderSync）
- 本地文件变化监听，自动上传
- 服务器更新自动下载
- 支持分块下载大文件

## 配置 (config.json)
项目目录下需要新建一个 config.json 来连接你的同步服务,内容如下
```json
{
  "vault": "库名",
  "vault_dir": "/path/to/vault",
  "api": "http://server:9000",
  "apiToken": "your-token",
  "enable_local_push": true
}
```

## 使用

```bash
# 安装依赖
npm install

# 编译
npm run build

# 运行
node dist/index.js

# 后台运行
tmux new -s sync 'node dist/index.js'
```

首次运行会从服务器下载全部文件（库为空时自动全量同步）。
