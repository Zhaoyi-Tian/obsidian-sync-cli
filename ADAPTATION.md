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
| 只读模式 (readonlySyncEnabled) | 简化为 enableLocalPush |
| 同步日志管理器 | 未实现 |
| 文件夹快照管理器 | 未实现 |

### 4. 保留的核心逻辑

- WebSocket 通信协议 (`Action|JSON` 格式)
- 二进制分块上传/下载 (40字节头: sessionId(36) + chunkIndex(4))
- 同步消息处理 (NoteSync/FileSync/FolderSync)
- 哈希缓存机制
- 忽略文件机制

---

## 文件对应关系及具体改动

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
- 添加：`enableLocalPush` 参数控制是否允许本地上传

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
- **添加：元数据持久化** - 存储在 `vault_dir/.obsidian/sync-metadata.json`
- **添加：文件哈希持久化** - 存储在 `vault_dir/.obsidian/file-hashes.json`
- **添加：.obsidian 文件夹忽略** - `isIgnoredFile()` 忽略 .obsidian 路径

---

### 5. helps.ts

| 原插件 | CLI |
|--------|-----|
| `src/lib/helps.ts` | `src/helps.ts` |

**主要改动：**
- `dump()` → `log()` (直接用 console.log)
- 移除 `Notice`, `moment` 等 Obsidian 依赖
- 保留：`normalizePath`, `hashContent`, `hashArrayBuffer`, `sleep`, `msToSeconds`, `getSafeCtime` 等工具函数

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
- 监听 `add`, `change`, `unlink`, `addDir`, `unlinkDir` 事件
- 触发 NoteOperator/FileOperator/FolderOperator 的相应方法
- 哈希缓存避免重复处理
- **忽略规则**：`^\.`（根目录隐藏文件）、`.obsidian`、`node_modules`、`.git`
- **修复：事件绑定** - chokidar 事件现在正确调用处理函数（之前只记录日志）
- **修复：忽略模式** - 不再忽略父路径中包含 `.` 的目录（如 `.openclaw`）

---

### 10. index.ts (CLI 独有)

**说明：** CLI 主入口

**实现功能：**
- 加载配置
- 初始化 Vault、SyncClient、Operators
- 注册消息处理器
- 启动同步
- 优雅退出处理
- **添加：Vault 空目录检测** - 当 vault 为空但有旧同步数据时，清除元数据强制全量同步（防止误删远程文件）

---

## 同步逻辑差异

### 元数据持久化

| 功能 | 原插件 | CLI |
|------|--------|-----|
| 存储位置 | localStorage | `vault_dir/.obsidian/sync-metadata.json` |
| 文件哈希 | localStorage | `vault_dir/.obsidian/file-hashes.json` |
| lastNoteSyncTime | ✅ 持久化 | ✅ 持久化 |
| lastFileSyncTime | ✅ 持久化 | ✅ 持久化 |
| lastFolderSyncTime | ✅ 持久化 | ✅ 持久化 |
| 空 Vault 检测 | isInitSync 标志 | 检测 vault 是否为空 + 清除旧元数据 |

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

## 消息类型覆盖

| 类别 | 原插件 | CLI | 状态 |
|------|--------|-----|------|
| **笔记** | 6种 | 6种 | ✅ 完整 |
| **文件** | 7种 | 7种 | ✅ 完整 |
| **文件夹** | 4种 | 4种 | ✅ 完整 |
| **配置** | 6种 | 0种 | ❌ 未实现 |

**总计**: CLI 支持 17/23 种消息类型 (74%)

---

## 逻辑差异清单

### 已修复 ✅

1. **元数据持久化** - CLI 现已支持，存储在 `.obsidian` 目录
2. **文件哈希持久化** - CLI 现已支持，存储在 `.obsidian` 目录
3. **chokidar 事件处理** - CLI 已修复，事件现在正确调用处理函数
4. **Vault 空目录检测** - CLI 已添加，防止误删远程文件

### 高优先级

5. **路径排除检查 (isPathExcluded)** - CLI 缺失
6. **同步启用状态检查 (syncEnabled)** - CLI 简化处理
7. **只读模式 (readonlySyncEnabled)** - CLI 简化为 enableLocalPush

### 中优先级

8. **重命名时哈希匹配检查** - CLI 逻辑简化
9. **文件夹删除时等待检查 (waitForFolderEmpty)** - CLI 缺失
10. **冲突通知用户** - CLI 只有日志

### 低优先级

11. **分片进度预估** - CLI 缺失
12. **上传取消回调** - CLI 使用不同方式

---

## 使用方式

```bash
# 安装依赖
npm install

# 构建
npm run build

# 运行
node dist/index.js
```

### config.json 配置

```json
{
  "vault_dir": "/path/to/vault",
  "vault_name": "MyVault",
  "api_url": "http://localhost:9000",
  "api_token": "your-token",
  "enable_local_push": true
}
```

---

## 许可证

本 CLI 仅供学习交流使用，遵循原插件的开源协议。
