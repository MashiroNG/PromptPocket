# PromptPocket 提示词口袋

PromptPocket 是一个为 ChatGPT 网页版优化的本地提示词管理 Chrome 插件。它可以把网页里看到的好提示词快速保存下来，并在需要时通过侧边栏、右键菜单或 ChatGPT 输入框旁的快捷浮窗直接复用。

当前版本：`1.1.9`

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
- 在 ChatGPT 网页版输入框旁显示快捷浮窗，点击后可快速插入提示词；展开本窗口的插件侧边栏时自动隐藏入口和快捷浮窗，关闭侧边栏后恢复入口，刷新网页也保持此行为。
- 选中网页文字后可出现悬浮保存按钮，也可通过右键保存。
- 保存弹窗支持修改标题、内容、保存文件夹，也可以直接新建文件夹。
- 使用提示词时可选择直接粘贴到当前输入框，或只复制后手动粘贴。
- 支持导入前预览、合并导入、覆盖导入和导入前自动备份。
- 支持 JSON 导出和数据清理工具，便于备份和去重。
- 首次打开默认亮色，支持切换深色；侧边栏和保存弹窗会沿用已保存的主题选择。

## 安装方式

需要 Chrome 142 或更新版本，以支持侧边栏打开、关闭事件。

1. 打开 Chrome 的 `chrome://extensions`。
2. 打开右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择包含 `manifest.json` 的项目根目录，不要选择 `src/`。
5. 打开 ChatGPT 或 Gemini 网页，点击浏览器工具栏里的插件图标，即可打开侧边栏；可在扩展菜单中将图标固定到工具栏。

### 更新已安装的插件

1. 先从侧边栏导出 JSON 备份，再下载或拉取仓库最新代码，保持原安装目录不变。
2. 打开 `chrome://extensions/`，点击 PromptPocket 卡片上的“重新加载”，无需卸载插件。
3. 刷新已打开的 ChatGPT/Gemini 页面，再打开插件侧边栏。

侧边栏和保存弹窗首次打开默认亮色；手动切换主题后会记住选择。展开插件侧边栏时，同一窗口网页输入框旁的“提示词”按钮和快捷浮窗自动隐藏；关闭侧边栏后恢复按钮，侧边栏展开期间刷新网页也不会重新显示按钮。

## 快速使用

### 保存网页选中文字

1. 在网页或 ChatGPT 页面选中一段提示词。
2. 点击选区旁的“保存提示词”悬浮按钮，或右键选择 `PromptPocket 提示词口袋 -> 保存选中内容为提示词`。
3. 在弹窗里修改标题、内容和保存文件夹。
4. 点击保存后，提示词会进入对应文件夹。

### 在 ChatGPT 快捷输入

1. 先关闭插件侧边栏，再点击 ChatGPT 输入框。
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

```text
PromptPocket/
├── manifest.json              # 扩展入口配置
├── src/
│   ├── background.js          # 后台菜单、消息及保存逻辑
│   ├── content.js             # 网页选区保存和快捷输入
│   ├── shared/                # 后台、网页和侧边栏共用逻辑
│   │   ├── sidepanel-logic.js
│   │   ├── storage-migrations.js
│   │   ├── folder-store.js
│   │   ├── folder-message-contract.js
│   │   └── injection-routing.js
│   ├── sidepanel/             # 侧边栏页面、样式及交互
│   │   ├── sidepanel.html
│   │   ├── sidepanel.css
│   │   ├── sidepanel.js
│   │   ├── sidepanel-runtime.js
│   │   └── sidepanel-save-logic.js
│   └── save-selection/        # 选区保存页及首帧主题
│       ├── save-selection.html
│       ├── save-selection.css
│       ├── save-selection.js
│       └── save-selection-theme.js
├── icons/                     # 扩展图标
├── tests/                     # 9 个 Node.js 行为测试文件
├── scripts/release.ps1         # 版本检查、归档及发布
├── package.json               # 测试命令，无第三方依赖
├── README.md
├── LICENSE
├── .gitignore
└── .gitattributes
```

运行文件集中在 `src/`，按页面和共享用途分类，保留原文件名及普通脚本加载方式。`manifest.json` 必须留在根目录；安装时仍选择项目根目录，无需编译或新增构建步骤。

## 开发与维护

本项目没有第三方 npm 依赖，无需安装依赖或编译；直接按安装方式加载项目根目录。测试需要支持 `structuredClone` 的 Node.js（17 或更新版本）：

```sh
npm test
```

Windows 发布脚本示例：

```powershell
powershell -NoProfile -File scripts/release.ps1 -Version 1.1.9
```

发布需要干净的 Git 工作区、Git、Node.js 和 GitHub 凭据。脚本会生成 ZIP、创建标签，默认推送分支和标签并创建 GitHub Release；`-SkipPush -SkipRelease` 仍会创建本地标签，不是只读检查。

`npm test` 覆盖提示词处理、文件夹存储、数据迁移、保存冲突、输入注入消息、主题记忆和侧边栏与悬浮按钮的显示联动。侧边栏联动检查包含同窗口隔离、展开后刷新，以及关闭后恢复按钮。

待确认：`src/background.js` 仍监听旧 `quickAccessData` 存储项，但本仓库没有写入方；可能用于旧版本数据变更通知，暂时保留。

## 权限说明

- `storage`：保存提示词、文件夹、主题和快捷设置。
- `contextMenus`：创建右键菜单。
- `clipboardWrite`：复制提示词内容。
- `sidePanel`：打开插件侧边栏。
- `activeTab` 和 `scripting`：将提示词粘贴到当前网页输入框。
- `host_permissions`：支持 ChatGPT 和 Gemini 等网页上的快捷输入与文本处理。

## 许可证

本项目沿用原项目的 MIT License。
