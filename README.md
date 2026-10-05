# luci-app-ffmpeg

OpenWrt / ImmortalWrt 上的 FFmpeg 管理界面。在路由器上配置、启停、查看转码任务，
并提供一个「上传 → 转码 → 下载」的文件转码页，整个流程都在浏览器里完成。

支持 OpenWrt 21.02 及以上（22.03 / 23.05 / 24.10 均可用），已在
ImmortalWrt 24.10.6 x86/64 上实测。

---

## 功能

| 页面 | 路径 | 说明 |
| --- | --- | --- |
| 总览 | `服务 → FFmpeg` | 每个任务的运行状态、PID、运行时长；启动 / 停止 / 重启 / 查看日志；状态每 3 秒自动刷新 |
| **文件转码** | `服务 → FFmpeg → 文件转码` | **上传文件 → 选参数转码 → 下载结果**，全程在网页里完成 |
| 任务 | `服务 → FFmpeg → 任务` | 增删改任务：输入源、输出目标、音视频编码、码率、缩放、帧率、封装格式、日志级别、额外参数 |
| 设置 | `服务 → FFmpeg → 设置` | 全局设置：总开关、ffmpeg 路径、工作目录、日志目录 |

一个 UCI `task` 段 = 一个独立的 ffmpeg 进程。每个任务有独立日志
`<logdir>/<section>.log`，启动前自动轮转为 `.log.1`。标记「开机自启」的任务由
`/etc/init.d/ffmpeg` 在开机时拉起，关机时统一停止。

所有 ffmpeg 参数都在服务端的 shell 脚本里组装，不经过前端拼接，避免命令注入。

### 文件转码页

它本质上就是**一个名叫 `convert` 的普通 task**，因此后端不需要任何特殊支持：

```
上传  浏览器 --cgi-upload-->   /tmp/ffmpeg-convert.in.<ext>       (cgi-io)
转码  前端 -> ubus ffmpeg configure -> ffmpeg-ctl start           (写 UCI + 启进程)
下载  浏览器 <--cgi-download-- /tmp/ffmpeg-convert.out.<ext>      (cgi-io)
```

几个值得说明的设计：

* 源文件和产物都放在 `/tmp`（tmpfs），**不会写入闪存**，重启即清空。
* 因为走的是标准 task 机制，这个 `convert` 任务也会出现在「任务」页里，可以手动微调。
* **编码器列表是探测出来的，不是写死的**：前端启动时调用
  `ubus ffmpeg encoders`，后端对每个候选编码器**实际跑一次 0.1 秒的编码**，
  只有真正跑通的才列进下拉框。仅查 `ffmpeg -encoders` 列表是不够的——
  `h264_v4l2m2m` 这类编码器会出现在列表里，但在没有 v4l2 设备节点的机器上
  一用就报 `Could not find a valid device`。
* **上传后会探测源文件**（`ubus ffmpeg probe`），实测本机能否解码它。
  如果不能，页面直接提示「只有『复制』可用」，而不是让你转码失败后再去猜原因。

---

## 安装

从 [Releases](../../releases) 或 `dist/` 下载 ipk，传到路由器后安装：

```sh
opkg install luci-app-ffmpeg_*.ipk
opkg install luci-i18n-ffmpeg-zh-cn_*.ipk     # 简体中文（可选）
opkg install luci-i18n-ffmpeg-zh-tw_*.ipk     # 繁体中文（可选）
```

依赖：`luci-base` `ffmpeg` `rpcd` `rpcd-mod-ucode` `ucode` `ucode-mod-fs` `cgi-io`。

`cgi-io` 是文件上传/下载所必需的，由 opkg 自动安装。

---

## 编码器为什么这么少？

这是最常见的问题：**为什么下拉框里没有 H.264/H.265？为什么连解码都不行？**

**这不是本应用的缺陷，而是 OpenWrt/ImmortalWrt 官方 ffmpeg 包的构建策略。**
官方 ffmpeg 默认只带一小部分编解码器，原因有三个，互相独立：

### 1. 专利编解码器默认不编译

H.264 / H.265 / VC1 在 ffmpeg 的构建系统里被归类为 **patented codecs**，
只有在 `CONFIG_BUILD_PATENTED=y` 时才会编进去：

```makefile
# openwrt/packages: multimedia/ffmpeg/Makefile
FFMPEG_PATENTED_DECODERS:= h264 hevc vc1

FFMPEG_CONFIGURE+= \
    $(if $(CONFIG_BUILD_PATENTED),, \
        $(call FFMPEG_DISABLE,decoder,$(FFMPEG_PATENTED_DECODERS)) \
        $(call FFMPEG_DISABLE,muxer,$(FFMPEG_PATENTED_MUXERS)) ...)
```

**默认关闭，所以连解码器都没有。** 这不是「缺个库」，而是 `--disable-decoder=h264`
把 ffmpeg 自带的原生 H.264 解码器直接裁掉了——**运行时无法补装**。

影响：设备读不了 H.264/H.265 视频，因此任何**重编码**都会失败
（重编码必须先解码），只剩「复制」可用。

### 2. libx264 / libx265 是 GPL，与 fdk-aac 不能共存

```makefile
# x264 support and fdk-aac support can't coexist and be distributed.
ifneq ($(CONFIG_PACKAGE_libx264),)
    FFMPEG_CONFIGURE+= --enable-gpl --enable-libx264
else
    FFMPEG_CONFIGURE+= $(if $(CONFIG_PACKAGE_fdk-aac),--enable-libfdk-aac)
endif
```

两者在**分发许可上互斥**，编译时只能二选一。官方构建选了 `fdk-aac`
（音质更好的 AAC 编码器），代价就是没有 `libx264`。

影响：设备**输出不了 H.264**。

> 注意：这个取舍**只影响编码器**。H.264/H.265 的**解码器**属于限制 1，
> 与 fdk-aac 无关——也就是说，「想读 H.264」不需要牺牲 fdk-aac。

### 3. 硬件编解码器需要 v4l2 设备节点

`h264_v4l2m2m` / `hevc_v4l2m2m` 这类编码器会出现在 `ffmpeg -encoders` 的输出里，
但它们需要 `/dev/video*`：

```
[h264_v4l2m2m] Could not find a valid device
[h264_v4l2m2m] can't configure encoder
```

在虚拟机、多数 x86 机器上没有这些设备节点，所以它们**在列表里但用不了**。
本应用通过实际试跑来识别这种情况，不会把它们列出来。

### 结果：默认构建能做什么

| | 可用 | 不可用 |
| --- | --- | --- |
| **视频编码** | `mpeg4` `mpeg2video` `mpeg1video` `h263` `mjpeg` `ffv1` `prores` | `libx264` `libx265` `libvpx` |
| **视频解码** | `mpeg1/2/4` `vp8` `vp9` `msmpeg4` | **`h264`** `hevc` `vc1` |
| **音频编码** | `aac` `libfdk_aac` `libmp3lame` `ac3` `eac3` `libopus` `flac` `mp2` | — |

所以：

* **MPEG-4 / VP8 / VP9 的源** → 可以正常重编码、缩放、压缩
* **H.264 / H.265 的源**（大多数手机视频）→ **只能「复制」**，不能重编码

### 想要 H.264 怎么办

需要**重新编译 ffmpeg**。两种档位：

| 档位 | 配置 | 得到 | 代价 |
| --- | --- | --- | --- |
| **A** | `CONFIG_BUILD_PATENTED=y` | 能**读** H.264/H.265，可重编码为 mpeg4 等 | 无，fdk-aac 保留 |
| **B** | 再加 `CONFIG_PACKAGE_libx264=y` | 额外能**输出** H.264 | 失去 fdk-aac（回退内置 aac） |

大多数场景**只需要档 A**。

详细步骤和自动化脚本见 [`rebuild-ffmpeg/`](rebuild-ffmpeg/)（暂未验证，仅供参考）。

---

## 从源码构建

本包遵循 LuCI 的 feed 布局，放进 `feeds/luci/applications/` 或
`package/` 下即可用标准 buildroot 编译：

```sh
# 在 OpenWrt/ImmortalWrt SDK 或完整源码树中
cp -r luci-app-ffmpeg package/
make menuconfig      # LuCI -> Applications -> luci-app-ffmpeg
make package/luci-app-ffmpeg/compile V=s
```

国际化包由 `luci.mk` 依据 `po/` 目录自动生成。注意 `po/` 下的目录名必须是
`zh_Hans` / `zh_Hant`，而 `luci.mk` 通过 `LUCI_LC_ALIAS` 把生成的包名映射为
`luci-i18n-ffmpeg-zh-cn` / `-zh-tw`。

### 离线构建 ipk

仓库自带一个不依赖 buildroot 的 ipk 打包工具，适合快速迭代：

```sh
node tools/build-ipk.js
```

产物在 `dist/`。它会扫描 `luci-app-ffmpeg/root/` 与 `htdocs/` 下的全部文件
（新增文件不需要改脚本），`root/` 映射到 `/`，`htdocs/` 映射到 `/www/`，
并依据 `po/` 生成 `.lmo` 与对应的 i18n 包。

> 打包时每个文件的 mtime 取自**源文件的真实修改时间**，而不是固定值。
> 这一点很重要：`/www/luci-static/` 下的 JS 会被浏览器按
> `ETag` / `Last-Modified` 缓存，如果每次构建的时间戳都一样，浏览器会认为
> 文件从未变化而一直使用旧缓存——前端改了也看不到效果。

### 校验

```sh
node luci-app-ffmpeg/tools/check-i18n.js luci-app-ffmpeg
```

检查 `po/` 是否覆盖了源码中的全部 `_()` 字符串，并**报出无法被 i18n-scan
提取的写法**（例如 `_('a' + 'b')` 这种拼接、或参数是变量），这类写法会在
界面上留下未翻译的英文且不会被常规检查发现。

---

## 国际化

界面文案全部通过 `_()` 提取，现有简体中文、繁体中文两种翻译：

```
luci-app-ffmpeg/po/
├── templates/luci-app-ffmpeg.pot
├── zh_Hans/luci-app-ffmpeg.po
└── zh_Hant/luci-app-ffmpeg.po
```

---

## 目录结构

```
luci-app-ffmpeg/
├── Makefile                        buildroot 包定义
├── htdocs/luci-static/resources/view/ffmpeg/
│   ├── overview.js                 总览页
│   ├── convert.js                  文件转码页
│   ├── tasks.js                    任务页
│   └── settings.js                 设置页
├── po/                             翻译
├── root/
│   ├── etc/config/ffmpeg           UCI 默认配置
│   ├── etc/init.d/ffmpeg           开机自启 / 关机停止
│   ├── etc/uci-defaults/           首次安装时清理 LuCI 缓存
│   ├── usr/libexec/ffmpeg-ctl      任务控制脚本（组装 ffmpeg 参数并启停）
│   └── usr/share/
│       ├── luci/menu.d/            菜单注册
│       └── rpcd/
│           ├── acl.d/              ACL 权限
│           └── ucode/ffmpeg        ubus 后端
└── tools/check-i18n.js             翻译覆盖率检查

tools/
├── build-ipk.js                    离线打包入口
├── ipk.js                          ipk/tar 生成
└── lmo.js                          .po -> .lmo 编译

rebuild-ffmpeg/                     重编 ffmpeg 以启用 H.264/H.265 的说明（暂未验证）
```

### ubus 接口

后端对象 `ffmpeg` 提供以下方法：

| 方法 | 参数 | 说明 |
| --- | --- | --- |
| `status` | — | 各任务的运行状态、PID、启动时间 |
| `log` | `section`, `lines` | 读取任务日志 |
| `control` | `action`, `section` | `start` / `stop` / `restart` |
| `configure` | `section`, `json` | 写入任务配置（参数以 JSON 字符串传入） |
| `config` | `section` | 读取 `/etc/config/ffmpeg` 中该段的真实内容 |
| `exitcode` | `section` | 上一次运行的 ffmpeg 退出码 |
| `encoders` | — | 实测可用的编码器列表 |
| `probe` | `path` | 探测媒体文件的流编码与可解码性 |

---

## 已知限制

* **文件转码不适合大文件**。源文件与产物都放在 `/tmp`（内存盘），
  几百 MB 的视频会直接吃掉内存；转码本身也很吃 CPU。
* **失败判定依赖退出码**，只有在任务完整跑完一轮后才会得出结论；
  页面每 3 秒轮询一次。
* **`probe` 只接受 `/tmp/` 下的普通文件名**，避免被用来读取任意文件的信息。
* 本应用**不修改 ffmpeg 本身**。能否处理某种格式完全取决于设备上的 ffmpeg
  构建带了哪些编解码器（见上文）。

---

## 许可

Apache License 2.0
