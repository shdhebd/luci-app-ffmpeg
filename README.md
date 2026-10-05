# luci-app-ffmpeg

在 OpenWrt 的 LuCI 网页界面里管理 **FFmpeg** 转码 / 推流任务的 LuCI 应用。

本仓库采用 LuCI 的 **feed 布局**：根目录下的 [`luci-app-ffmpeg/`](luci-app-ffmpeg/)
就是应用本体，`.github/workflows/build.yml` 负责自动编译。

功能说明、UCI 字段、命令行用法和排错都在 [luci-app-ffmpeg/README.md](luci-app-ffmpeg/README.md)。

---

## 自动编译

推送到 `main` / `master` 分支，或在仓库的 **Actions** 页面手动点击
**Build OpenWrt packages → Run workflow**，GitHub Actions 会下载官方 OpenWrt SDK
并编译出 ipk。

编译完成后在该次运行的 **Artifacts** 区域下载：

| Artifact | 说明 |
| --- | --- |
| `ipk-24.10.5` | 用 OpenWrt 24.10.5 SDK 构建 |
| `ipk-23.05.5` | 用 OpenWrt 23.05.5 SDK 构建 |

两个版本各约需 10～20 分钟，并行执行。

每个 artifact 里包含三个包：

| 包 | 说明 |
| --- | --- |
| `luci-app-ffmpeg_*.ipk` | 主程序 |
| `luci-i18n-ffmpeg-zh-cn_*.ipk` | 简体中文翻译 |
| `luci-i18n-ffmpeg-zh-tw_*.ipk` | 繁体中文翻译 |

> 应用本身是纯 shell + JavaScript，Makefile 里 `LUCI_PKGARCH:=all`，
> 编译产物是**架构无关**的 `_all.ipk`，x86_64 / arm / mips 等任何设备都能安装。
> 两个 SDK 版本编出来的内容基本一致，任选其一即可。

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
