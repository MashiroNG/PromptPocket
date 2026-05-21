# PromptPocket 提示词口袋

PromptPocket 是一个为 ChatGPT 网页版优化的本地提示词管理 Chrome 插件。它可以把网页里看到的好提示词快速保存下来，并在需要时通过侧边栏、右键菜单或 ChatGPT 输入框旁的快捷浮窗直接复用。

当前版本：`1.0.7`

## 原仓库

本项目基于 SimplestPrompt fork 改造：

[https://github.com/thejohnd0e/SimplestPrompt](https://github.com/thejohnd0e/SimplestPrompt)

感谢原作者提供的轻量本地提示词收藏基础。

## 主要功能

- 本地保存提示词，不需要账号，不上传云端。
- 支持文件夹管理、拖拽排序、搜索和按文件夹筛选。
- 支持置顶提示词，置顶内容可直接出现在右键一级菜单。
- 支持置顶管理视图，可拖拽或用按钮调整置顶顺序。
- 支持快捷提示词管理，可拖拽或用按钮调整 ChatGPT 快捷弹窗顺序。
- 支持快捷提示词范围设置：全部提示词、只显示置顶、指定文件夹。
- 在 ChatGPT 网页版输入框旁显示快捷浮窗，点击后可快速插入提示词。
- 选中网页文字后可出现悬浮保存按钮，也可通过右键保存。
- 保存弹窗支持修改标题、内容、保存文件夹，也可以直接新建文件夹。
- 使用提示词时可选择直接粘贴到当前输入框，或只复制后手动粘贴。
- 支持导入前预览、合并导入、覆盖导入和导入前自动备份。
- 支持 JSON 导出和数据清理工具，便于备份和去重。
- 支持浅色和深色主题切换。

## 安装方式

1. 打开 Chrome 的 `chrome://extensions`。
2. 打开右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目文件夹。
5. 打开 ChatGPT 网页版，点击浏览器工具栏里的插件图标，即可打开侧边栏。

## 快速使用

### 保存网页选中文字

1. 在网页或 ChatGPT 页面选中一段提示词。
2. 点击选区旁的“保存提示词”悬浮按钮，或右键选择 `PromptPocket 提示词口袋 -> 保存选中内容为提示词`。
3. 在弹窗里修改标题、内容和保存文件夹。
4. 点击保存后，提示词会进入对应文件夹。

### 在 ChatGPT 快捷输入

1. 点击 ChatGPT 输入框。
2. 输入框右侧会出现 `提示词` 浮窗按钮。
3. 点击按钮打开快捷提示词列表。
4. 搜索或选择提示词，点击后会插入到当前输入框。

### 管理快捷范围

在侧边栏的 `快捷范围` 中选择：

- `全部提示词`：快捷弹窗显示所有提示词。
- `只显示置顶`：快捷弹窗只显示置顶提示词。
- `指定文件夹`：快捷弹窗只显示某个文件夹中的提示词。

设置会实时同步到已经打开的 ChatGPT 快捷弹窗。

## 数据与隐私

所有提示词数据保存在 Chrome 本地存储 `chrome.storage.local` 中。插件不会上传提示词内容，也不需要登录账号。

导出数据为 JSON 文件，主要结构如下：

```json
[
  {
    "id": "folder-id",
    "name": "收件箱",
    "prompts": [
      {
        "id": "prompt-id",
        "title": "提示词标题",
        "text": "提示词内容",
        "timestamp": "2026-05-19T00:00:00.000Z",
        "sourceUrl": "https://chatgpt.com/",
        "sourceTitle": "ChatGPT",
        "pinned": true,
        "pinnedAt": "2026-05-19T00:00:00.000Z",
        "quickAt": "2026-05-19T00:00:00.000Z"
      }
    ]
  }
]
```

## 项目结构

- `manifest.json`：插件名称、版本、权限、图标和入口配置。
- `background.js`：右键菜单、复制、粘贴、选中内容保存和菜单刷新逻辑。
- `content.js`：网页选区保存按钮、ChatGPT 快捷提示词按钮和快捷弹窗。
- `sidepanel.html`：侧边栏界面结构。
- `sidepanel.css`：侧边栏主题、布局、动画和组件样式。
- `sidepanel-runtime.js`：侧边栏通用存储、主题和版本辅助逻辑。
- `sidepanel.js`：侧边栏状态、搜索、筛选、编辑、导入导出、排序和清理逻辑。
- `save-selection.html`：保存选中文字时的确认弹窗界面。
- `save-selection.js`：保存弹窗的数据读取、文件夹选择和保存逻辑。
- `scripts/release.ps1`：发布脚本，自动检查版本、语法、打包、推送标签并创建 GitHub Release。
- `icons/`：插件图标。
- `assets/`：项目截图素材。

## 发布流程

发布前先确认 `manifest.json` 和 README 的版本号已经更新，然后在项目根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -Version 1.0.7 -ReleaseNotes "新增 Gemini 快捷提示词按钮，优化选中文本指令和快捷指令下拉框。"
```

脚本会依次完成版本校验、JavaScript 语法检查、生成 `PromptPocket-v版本号.zip`、创建并推送 Git tag，以及在 GitHub 上创建 Release 并上传 zip。脚本会使用本机 Git Credential Manager 中已经登录的 GitHub 凭据。

## 权限说明

- `storage`：保存提示词、文件夹、主题和快捷设置。
- `contextMenus`：创建右键菜单。
- `clipboardWrite`：复制提示词内容。
- `sidePanel`：打开插件侧边栏。
- `activeTab` 和 `scripting`：将提示词粘贴到当前网页输入框。
- `host_permissions`：支持 ChatGPT 和 Gemini 等网页上的快捷输入与文本处理。

## 许可证

本项目沿用原项目的 MIT License。
