# Obsidian Fast Note Sync CLI 改编说明

## 概述

本 CLI 是对 [Obsidian Fast Note Sync](https://github.com/haierkeys/fast-note-sync) 插件的命令行移植版本，移除了 Obsidian 依赖，可以在纯命令行环境中运行。

---

## 改动方面

### 1. 技术栈改编

| 项目 | 原插件 | CLI |
|------|--------|-----|
| 运行环境 | Obsidian 插件 (浏览器) | Node.js |
| WebSocket | 浏览器 WebSocket | `ws` 库 |
| 文件系统 | Obsidian Vault API | Node.js `fs` |
| 文件监视 | Obsidian 内部事件 | `chokidar` 库 |
| 类型系统 | Obsidian API 类型 | 自定义类型 |

### 2. 代码结构改编

| 项目 | 原插件 | CLI |
|------|--------|-----|
| 编程范式 | 函数式 export | 面向类 (class) |
| 配置方式 | Obsidian Settings | `config.json` 文件 |
| 入口点 | Obsidian 插件入口 | `index.ts` |

### 3. 移除的功能

| 功能 | 说明 |
|------|------|
| `isInitSync` 元数据 | 简化为 vault 是否为空判断 |
| 云预览 (cloudPreview) | 未实现 |
| 设置同步 (SettingSync) | 未实现 |
| 分片进度预估 | 未实现 |
| Obsidian 内部集成 | 移除 |

### 4. 保留的核心逻辑

- WebSocket 通信协议 (`Action|JSON` 格式)
- 二进制分块上传/下载 (40字节头: sessionId(36) + chunkIndex(4))
- 同步消息处理 (NoteSync/FileSync/FolderSync)
- 哈希缓存机制
- 忽略文件机制

---

## 文件对应关系及具体改动
## 文件对应关系

```
原插件                          CLI
─────────────────────────────────────────────────
src/lib/file_operator.ts   →   obsidian-sync-cli/src/file_operator.ts
src/lib/note_operator.ts   →   obsidian-sync-cli/src/note_operator.ts
src/lib/folder_operator.ts →   obsidian-sync-cli/src/folder_operator.ts
src/lib/websocket.ts       →   obsidian-sync-cli/src/websocket.ts
src/lib/helps.ts          →   obsidian-sync-cli/src/helps.ts
src/lib/types.ts          →   obsidian-sync-cli/src/types.ts
(无)                       →   obsidian-sync-cli/src/vault.ts      # 模拟 Vault API
(无)                       →   obsidian-sync-cli/src/config.ts    # 配置加载
(无)                       →   obsidian-sync-cli/src/fs_watcher.ts # 文件监视
```
### 1. file_operator.ts

| 原插件 | CLI |
|--------|-----|
| `src/lib/file_operator.ts` | `src/file_operator.ts` |

**主要改动：**
- 函数 → 类：`export const` → `class FileOperator`
- `plugin.app.vault` → `this.vault` (自定义 Vault 类)
- `plugin.websocket` → `this.client` (自定义 SyncClient 类)
- 移除 `Notice`, `Platform`, `TFile` 等 Obsidian 依赖
- 保留：文件上传、下载、分块处理、二进制消息处理、mtime 同步、重命名处理
- 添加：`enableLocalPush` 参数控制是否允许本地上传

---

### 2. note_operator.ts

| 原插件 | CLI |
|--------|-----|
| `src/lib/note_operator.ts` | `src/note_operator.ts` |

**主要改动：**
- 函数 → 类：`export const` → `class NoteOperator`
- `plugin.app.vault` → `this.vault`
- `plugin.websocket` → `this.client`
- 移除 `Notice`, `TFile`, `TAbstractFile` 等 Obsidian 依赖
- 保留：笔记修改、删除、重命名、上传、下载、mtime 同步处理
- 添加：`enableLocalPush` 参数控制是否允许本地上传

---

### 3. folder_operator.ts

| 原插件 | CLI |
|--------|-----|
| `src/lib/folder_operator.ts` | `src/folder_operator.ts` |

**主要改动：**
- 函数 → 类：`export const` → `class FolderOperator`
- `plugin.app.vault` → `this.vault`
- 移除 `TFolder`, `normalizePath` 等 Obsidian 依赖
- 保留：文件夹创建、删除、重命名处理

---

### 4. websocket.ts

| 原插件 | CLI |
|--------|-----|
| `src/lib/websocket.ts` | `src/websocket.ts` |

**主要改动：**
- 浏览器 `WebSocket` → Node.js `ws` 库
- `plugin.websocket.ws` → `this.ws`
- 移除 `Notice`, `moment`, `Platform` 等 Obsidian 依赖
- 添加：Node.js 进程退出处理 (`process.exit()`)
- 保留：认证、消息收发、重连、心跳

---

### 5. helps.ts

| 原插件 | CLI |
|--------|-----|
| `src/lib/helps.ts` | `src/helps.ts` |

**主要改动：**
- `dump()` → `log()` (直接用 console.log)
- 移除 `Notice`, `moment` 等 Obsidian 依赖
- 保留：`normalizePath`, `hashContent`, `hashArrayBuffer`, `sleep`, `msToSeconds`, `getSafeCtime` 等工具函数（这些函数在 CLI 中仍然需要）

---

### 6. types.ts

| 原插件 | CLI |
|--------|-----|
| `src/lib/types.ts` | `src/types.ts` |

**主要改动：**
- 复制大部分类型定义（如 `SnapFile`, `SyncMessage`, `FileDownloadSession` 等）
- 添加 CLI 特有类型：`TFile`, `TFolder`, `TAbstractFile`, `FileStat`
- 添加 `CLIConfig` 接口

---

### 7. vault.ts (CLI 独有)

**说明：** 模拟 Obsidian Vault API

**实现功能：**
- `getFiles()` - 获取文件列表
- `read(path)` - 读取文件内容
- `create(path, content)` - 创建文件
- `modify(path, content)` - 修改文件
- `delete(path)` - 删除文件
- `createFolder(path)` - 创建文件夹
- 使用 Node.js `fs` 模块实现

---

### 8. config.ts (CLI 独有)

**说明：** 配置文件加载器

**实现功能：**
- 读取 `config.json`
- 支持两种格式：原插件格式 (`vault`, `api`, `apiToken`) 和 CLI 格式 (`vault_name`, `api_url`, `api_token`)
- 默认值处理

---

### 9. fs_watcher.ts (CLI 独有)

**说明：** 文件监视器

**实现功能：**
- 使用 `chokidar` 库监视文件变化
- 监听 `add`, `change`, `unlink` 事件
- 触发 NoteOperator/FileOperator 的相应方法
- 哈希缓存避免重复处理

---

### 10. index.ts (CLI 独有)

**说明：** CLI 主入口

**实现功能：**
- 加载配置
- 初始化 Vault、SyncClient、Operators
- 注册消息处理器
- 启动同步
- 优雅退出处理

---

## 同步逻辑差异

### NoteSync 发送

| 字段 | 原插件 | CLI |
|------|--------|-----|
| lastTime | isInitSync 计算 | vault 为空时为 0 |
| delNotes | 支持 | ✅ 支持 |
| missingNotes | 支持 | ✅ 支持 |

### FileSync 发送

| 字段 | 原插件 | CLI |
|------|--------|-----|
| lastTime | isInitSync 计算 | vault 为空时为 0 |
| delFiles | 支持 | ✅ 支持 |
| missingFiles | 支持 | ✅ 支持 |

---