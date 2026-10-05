# luci-app-ffmpeg

在 OpenWrt 的 LuCI 网页界面里管理 **FFmpeg** 转码 / 推流任务的 LuCI 应用。

支持 LuCI 的客户端渲染框架（OpenWrt 21.02 及以上），后端使用 `rpcd` + `ucode`。

---

## 功能

| 页面 | 路径 | 说明 |
| --- | --- | --- |
| 总览 | `服务 → FFmpeg` | 查看每个任务的运行状态、PID、运行时长，支持启动 / 停止 / 重启 / 查看日志，状态每 5 秒自动刷新 |
| 任务 | `服务 → FFmpeg → 任务` | 增删改任务：输入源、输出目标、音视频编码、码率、缩放、帧率、封装格式、日志级别、额外参数 |
| 设置 | `服务 → FFmpeg → 设置` | 全局设置：总开关、ffmpeg 路径、工作目录、日志目录 |

* 一个 UCI `task` 段 = 一个独立的 ffmpeg 进程。
* 每个任务有独立日志：`<logdir>/<section>.log`，每次启动前自动轮转为 `.log.1`。
* 标记「开机自启」的任务由 `/etc/init.d/ffmpeg` 在开机时拉起，关机时统一停止。
* 所有 ffmpeg 参数在服务端的 shell 脚本里组装，不经过前端拼接，避免命令注入。

---

## 目录结构

```
luci-app-ffmpeg/
├── Makefile                                   # OpenWrt 包定义（include luci.mk）
├── htdocs/luci-static/resources/view/ffmpeg/
│   ├── overview.js                            # 总览页（状态 / 控制 / 日志）
│   ├── tasks.js                               # 任务配置页
│   └── settings.js                            # 全局设置页
├── po/
│   ├── templates/luci-app-ffmpeg.pot          # 翻译模板
│   ├── zh_Hans/luci-app-ffmpeg.po             # 简体中文
│   └── zh_Hant/luci-app-ffmpeg.po             # 繁体中文
├── tools/
│   └── check-i18n.js                          # 翻译覆盖率自检脚本（不打包进 ipk）
└── root/
    ├── etc/
    │   ├── config/ffmpeg                      # UCI 默认配置
    │   ├── init.d/ffmpeg                      # 开机自启 / 关机停止
    │   └── uci-defaults/40_luci-app-ffmpeg    # 安装后置动作
    └── usr/
        ├── libexec/ffmpeg-ctl                 # 任务控制脚本（启动 / 停止 / 日志轮转）
        └── share/
            ├── luci/menu.d/luci-app-ffmpeg.json   # 菜单项
            └── rpcd/
                ├── acl.d/luci-app-ffmpeg.json     # 权限声明
                └── ucode/ffmpeg                   # ubus 对象 ffmpeg
```

---

## 编译

把这个目录放进 OpenWrt 源码树，然后按常规方式编译（Makefile 会自动定位 `luci.mk`，
放在 `package/` 或 `feeds/luci/applications/` 下都可以）：

```sh
# 方式一：直接放进 package/
cp -r luci-app-ffmpeg <openwrt>/package/

cd <openwrt>
make menuconfig          # LuCI → Applications → luci-app-ffmpeg
make package/luci-app-ffmpeg/compile V=s
```

```sh
# 方式二：作为 luci feed 的一个应用
cd <openwrt>/feeds/luci/applications
git clone <this-repo> luci-app-ffmpeg
cd <openwrt>
./scripts/feeds update -a && ./scripts/feeds install -a
make package/luci-app-ffmpeg/compile V=s
```

编译时会自动把 `po/<dir>/luci-app-ffmpeg.po` 用 `po2lmo` 编译成 `.lmo` 并生成语言包，
无需自己写任何 po 规则。要注意**目录名**和**生成的包名**是两套写法：

| `po/` 目录名（必须这样写） | 生成的 ipk 包名 | `.lmo` 文件名 |
| --- | --- | --- |
| `zh_Hans` | `luci-i18n-ffmpeg-zh-cn` | `luci-app-ffmpeg.zh-cn.lmo` |
| `zh_Hant` | `luci-i18n-ffmpeg-zh-tw` | `luci-app-ffmpeg.zh-tw.lmo` |

原因是 luci.mk 内部有一张 `LUCI_LC_ALIAS` 别名表，`zh_Hans`/`zh_Hant` 会被映射成
运行时的 `zh-cn`/`zh-tw`，只有目录名参与定位 `po/<dir>/*.po`。
目录名用 `zh-cn` 反而会找不到翻译源文件。

---

## 安装

```sh
opkg update
opkg install ffmpeg                       # 必须，包里不含 ffmpeg 本体
opkg install luci-app-ffmpeg
opkg install luci-i18n-ffmpeg-zh-cn        # 简体中文语言包（注意是 zh-cn，不是 zh_Hans）
```

安装后刷新 LuCI 页面，在「服务」菜单下就能看到 **FFmpeg**。luci.mk 会自动生成 postinst，
安装时清掉 LuCI 缓存并执行 `/etc/init.d/rpcd reload`，所以一般不需要手动重启 rpcd。

> `root/etc/uci-defaults/40_luci-app-ffmpeg` 在**安装时**就由 `default_postinst()`
> 执行（不是等下次开机），它负责修正脚本权限并执行 `/etc/init.d/ffmpeg enable`。
> 万一没有生效，手动补一次即可：
>
> ```sh
> chmod +x /usr/libexec/ffmpeg-ctl /etc/init.d/ffmpeg
> /etc/init.d/ffmpeg enable
> ```
>
> 不执行也不会影响任务的「启动 / 停止」按钮，只是重启路由器后不会自动拉起任务。

> **注意**：路由器上跑 ffmpeg 非常吃 CPU 和内存。建议：
> * 优先使用 `copy` 编码（只做封装转换，几乎不占 CPU）；
> * 软编码 `libx264` / `libx265` 在低端路由器上可能无法达到实时速度；
> * 输出到 `/tmp`（tmpfs）会占用内存，长时间录制请写到 U 盘或网络存储。

---

## UCI 配置说明

`/etc/config/ffmpeg`

```uci
config globals 'globals'
	option enabled '1'                    # 总开关，0 = 开机不启动任何任务
	option binary '/usr/bin/ffmpeg'       # ffmpeg 可执行文件路径
	option workdir '/tmp/ffmpeg'          # 任务的工作目录
	option logdir '/var/log/ffmpeg'       # 日志目录

config task 'example'
	option name '示例转码任务'             # 显示名称
	option enabled '1'                    # 是否启用该任务
	option autostart '0'                  # 是否开机自启
	option input 'udp://239.0.0.1:1234'   # 输入源（URL / 设备 / 文件）
	option output '/mnt/video/out.mp4'    # 输出目标
	option video_codec 'copy'             # copy / libx264 / libx265 / mpeg4 / mpeg2video / none
	option video_bitrate ''               # 例如 2000k
	option audio_codec 'copy'             # copy / aac / libmp3lame / ac3 / libopus / none
	option audio_bitrate ''               # 例如 128k
	option scale ''                       # 例如 1280:-2
	option fps ''                         # 例如 25
	option format ''                      # 例如 mpegts
	option loglevel 'warning'             # quiet / error / warning / info / verbose / debug
	option overwrite '1'                  # 1 = -y，0 = -n
	option extra_args ''                  # 追加在输出目标之前的原始参数
```

生成的命令行等价于：

```
ffmpeg -hide_banner -nostdin -loglevel <level> -y -i <input> \
       -c:v <vcodec> -b:v <vbitrate> -c:a <acodec> -b:a <abitrate> \
       -vf scale=<scale> -r <fps> <extra_args> -f <format> <output>
```

### 常用示例

**1. UDP 组播流转 HLS 分片（不重新编码）**

```uci
config task 'iptv'
	option name 'IPTV 转 HLS'
	option enabled '1'
	option autostart '1'
	option input 'udp://@239.1.1.1:1234?overrun_nonfatal=1&fifo_size=5000000'
	option output '/mnt/usb/hls/stream.m3u8'
	option video_codec 'copy'
	option audio_codec 'copy'
	option format 'hls'
	option extra_args '-hls_time 4 -hls_list_size 6 -hls_flags delete_segments'
```

**2. 摄像头 RTSP 转 RTMP 推流**

```uci
config task 'push'
	option name 'RTSP 转推 RTMP'
	option enabled '1'
	option autostart '1'
	option input 'rtsp://admin:pass@192.168.1.64:554/Streaming/Channels/101'
	option output 'rtmp://live.example.com/live/streamkey'
	option video_codec 'copy'
	option audio_codec 'aac'
	option format 'flv'
```

**3. 降低码率与分辨率（软编码）**

```uci
config task 'transcode'
	option name '降码率转码'
	option input '/mnt/usb/in.mp4'
	option output '/mnt/usb/out.mp4'
	option video_codec 'libx264'
	option video_bitrate '1200k'
	option scale '1280:-2'
	option fps '25'
	option audio_codec 'aac'
	option audio_bitrate '128k'
	option extra_args '-preset veryfast -profile:v main'
```

---

## 手动操作

```sh
# 命令行控制单个任务
/usr/libexec/ffmpeg-ctl start   <section>
/usr/libexec/ffmpeg-ctl stop    <section>
/usr/libexec/ffmpeg-ctl restart <section>
/usr/libexec/ffmpeg-ctl stopall

# 查看日志
tail -f /var/log/ffmpeg/<section>.log

# 服务
/etc/init.d/ffmpeg start|stop|restart|enable|disable
```

---

## 国际化（i18n）

* 源字符串使用 `_('...')` 包裹，位于 `htdocs/luci-static/resources/view/ffmpeg/*.js`
  以及 `root/usr/share/luci/menu.d/luci-app-ffmpeg.json` 的菜单标题。
* 翻译文件位于 `po/<lang>/luci-app-ffmpeg.po`，模板位于 `po/templates/luci-app-ffmpeg.pot`。
* 新增翻译语言：复制 `po/templates/luci-app-ffmpeg.pot`
  到 `po/<lang>/luci-app-ffmpeg.po`，填好 `msgstr` 与头部 `Language:` 字段即可。

更新模板（需要 `perl` 与 `gettext`）：

```sh
# 在 OpenWrt 源码树中
./feeds/luci/build/i18n-scan.pl . > po/templates/luci-app-ffmpeg.pot
```

已提供：

| 语言 | 源文件 | 生成的语言包 |
| --- | --- | --- |
| 简体中文 | `po/zh_Hans/luci-app-ffmpeg.po` | `luci-i18n-ffmpeg-zh-cn` |
| 繁体中文 | `po/zh_Hant/luci-app-ffmpeg.po` | `luci-i18n-ffmpeg-zh-tw` |

共 67 条待翻译字符串，两种语言均已完整翻译。可用仓库自带的脚本核对覆盖率
（需要 `node`，只读取文件，不修改任何内容）：

```sh
cd luci-app-ffmpeg
node tools/check-i18n.js .
```

它会检查三件事：源码里的 `_('...')` 是否都进了 `.pot`、各语言是否都翻译了、
以及 `.po` 里有没有源码中已删除的陈旧条目。

也可以用 gettext 工具校验 `.po` 语法：

```sh
msgfmt --check --statistics po/zh_Hans/luci-app-ffmpeg.po -o /dev/null
```

---

## 排错

| 现象 | 排查方向 |
| --- | --- |
| 菜单里看不到 FFmpeg | `opkg install luci-compat` 不需要；确认 `/usr/share/luci/menu.d/luci-app-ffmpeg.json` 存在，并强制刷新浏览器缓存（Ctrl+F5） |
| 点击启动后立刻变为「已停止」 | 打开「日志」查看 ffmpeg 报错。常见原因：输入源不可达、输出路径不可写、编码器未编入当前 ffmpeg |
| 提示 `invalid action` / `invalid section name` | ubus 对象未生效，执行 `/etc/init.d/rpcd restart` |
| 权限错误（Access denied） | 确认 `/usr/share/rpcd/acl.d/luci-app-ffmpeg.json` 存在且 JSON 合法 |
| 开机没有自动启动任务 | 检查 task 的 `enabled` 与 `autostart` 是否都为 1，以及 `/etc/init.d/ffmpeg enable` 是否执行过 |
| 提示缺少 libx264 | OpenWrt 的 `ffmpeg` 包默认不一定编入 x264，需要安装带该编码器的变体或自行编译 |

调试 ubus 后端：

```sh
ubus -v list ffmpeg
ubus call ffmpeg status
ubus call ffmpeg log '{"section":"example","lines":50}'
```

如果 `ubus -v list ffmpeg` 提示找不到对象，说明 rpcd 没有加载脚本，用

```sh
logread | grep -i rpcd
```

查看具体原因（ucode 语法错误、脚本权限为组/其他用户可写、缺少 `ucode-mod-fs` 等）。

---

## 许可证

Apache-2.0
