# luci-app-ffmpeg

在 OpenWrt 的 LuCI 网页界面里管理 **FFmpeg** 转码 / 推流任务的 LuCI 应用。

本仓库采用 LuCI 的 **feed 布局**：根目录下的 [`luci-app-ffmpeg/`](luci-app-ffmpeg/)
就是应用本体，`.github/workflows/build.yml` 负责自动编译。

功能说明、UCI 字段、命令行用法和排错都在 [luci-app-ffmpeg/README.md](luci-app-ffmpeg/README.md)。

---

## 拿到 ipk

### 方式一：直接下载（推荐）

[`dist/`](dist/) 目录里已经有打包好的 ipk，直接下载安装即可，不需要任何构建环境：

| 文件 | 说明 |
| --- | --- |
| [`luci-app-ffmpeg_1.0.0-r1_all.ipk`](dist/luci-app-ffmpeg_1.0.0-r1_all.ipk) | 主程序 |
| [`luci-i18n-ffmpeg-zh-cn_1.0.0-r1_all.ipk`](dist/luci-i18n-ffmpeg-zh-cn_1.0.0-r1_all.ipk) | 简体中文翻译 |
| [`luci-i18n-ffmpeg-zh-tw_1.0.0-r1_all.ipk`](dist/luci-i18n-ffmpeg-zh-tw_1.0.0-r1_all.ipk) | 繁体中文翻译 |

> 应用是纯 shell + JavaScript，不含任何需要编译的代码，Makefile 里 `LUCI_PKGARCH:=all`，
> 所以产物是**架构无关**的 `_all.ipk`，x86_64 / arm / mips 等任何设备都能安装。

### 方式二：本地重新打包

改完代码后，用仓库自带的工具重新生成 ipk（只需要 Node.js，不需要 OpenWrt SDK）：

```sh
node tools/build-ipk.js
```

产物会写到 `dist/`。工具组成：

| 文件 | 作用 |
| --- | --- |
| `tools/build-ipk.js` | 组装三个包（data / control / conffiles / postinst） |
| `tools/ipk.js` | 生成 `ar`/`tar` 归档与 ipk 封装 |
| `tools/lmo.js` | 把 `.po` 编译成 LuCI 的 `.lmo` 翻译文件 |

### 方式三：GitHub Actions

推送到 `main` / `master` 分支，或在 **Actions** 页面手动点击
**Build OpenWrt packages → Run workflow**，GitHub Actions 会下载官方 OpenWrt SDK
并编译出 ipk，完成后在该次运行的 **Artifacts** 区域下载：

| Artifact | 说明 |
| --- | --- |
| `ipk-24.10.5` | 用 OpenWrt 24.10.5 SDK 构建 |
| `ipk-23.05.5` | 用 OpenWrt 23.05.5 SDK 构建 |

两个版本各约需 10～20 分钟，并行执行。

> **注意**：GitHub Actions 必须在账号可用的情况下才能运行。如果运行 5 秒内就失败且没有日志，
> 多半是账号被限制（例如账单问题），此时请改用方式一或方式二。

---

## 安装到路由器

把下载到的 `.ipk` 传到路由器后安装：

```sh
opkg update
opkg install ffmpeg                        # 依赖，包里不含 ffmpeg 本体
opkg install luci-app-ffmpeg_*.ipk
opkg install luci-i18n-ffmpeg-zh-cn_*.ipk  # 可选：简体中文界面
```

安装完刷新 LuCI 页面，在 **服务 → FFmpeg** 就能看到。

---

## 许可证

Apache-2.0
