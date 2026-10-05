# 重编 ffmpeg 以启用 H.264 / H.265

> **状态：暂未验证，仅供参考。**
> 本目录的说明和脚本都还没有在真实环境中完整跑过一遍，先放在仓库里存档。
> 等有空实际编译验证后再更新状态。

---

## 这个目录解决什么问题

OpenWrt / ImmortalWrt 官方仓库里的 ffmpeg **默认不带 H.264 / H.265**，
导致路由器读不了绝大多数手机视频，文件转码只剩「复制」可用。

原因详见主 [README 的「编码器为什么这么少」](../README.md#编码器为什么这么少)
一节，简单说就是三条**互相独立**的限制：

| 限制 | 影响 | 能否通过重编解决 |
| --- | --- | --- |
| H.264/H.265 属于 patented codecs，默认 `BUILD_PATENTED=n` | **连解码器都没有** | ✅ 加 `CONFIG_BUILD_PATENTED=y` |
| `libx264`(GPL) 与 `fdk-aac` 分发许可互斥 | 输出不了 H.264 | ✅ 但要牺牲 fdk-aac |
| `*_v4l2m2m` 硬件编解码器需要 `/dev/video*` | 列表里有但用不了 | ❌ 取决于硬件 |

**关键点：第一条和第二条是分开的。**

* 「想**读** H.264」（也就是能重编码成 mpeg4 等其他格式）
  → 只需要 `CONFIG_BUILD_PATENTED=y`，**fdk-aac 完整保留**
* 「想**输出** H.264」
  → 还要加 `libx264`，此时 fdk-aac 会被自动取消，音频回退到内置 `aac`

大多数需求属于第一种。

---

## 两档配置

| 档位 | 配置 | 得到 | 代价 |
| --- | --- | --- | --- |
| **A** | `CONFIG_BUILD_PATENTED=y` | 能读 H.264/H.265/VC1，可重编码为 `mpeg4` / `mpeg2video` / `ffv1` 等 | 无 |
| **B** | 再加 `CONFIG_PACKAGE_libx264=y` | 额外能输出 H.264 | 失去 `fdk-aac` |

档 B 的取舍来自 `libffmpeg-full` 的依赖定义：

```makefile
DEPENDS+= ... +PACKAGE_libx264:libx264 +!PACKAGE_libx264:fdk-aac
```

即「选了 libx264 就不带 fdk-aac，不选就自动带 fdk-aac」。

---

## 手工编译步骤

以 **ImmortalWrt 24.10.6 x86/64** 为例（SDK 版本必须与固件严格一致）：

```sh
# 1. 下载 SDK
#    https://downloads.immortalwrt.org/releases/24.10.6/targets/x86/64/
wget https://downloads.immortalwrt.org/releases/24.10.6/targets/x86/64/\
immortalwrt-sdk-24.10.6-x86-64_gcc-13.3.0_musl.Linux-x86_64.tar.zst

mkdir sdk && tar -xf immortalwrt-sdk-*.tar.zst -C sdk --strip-components=1
cd sdk

# 2. 拉 feeds
./scripts/feeds update -a
./scripts/feeds install -a

# 3. 配置
rm -f .config
make defconfig
cat >> .config <<'EOF'
CONFIG_BUILD_PATENTED=y
CONFIG_PACKAGE_libffmpeg-full=y
CONFIG_PACKAGE_ffmpeg=y
EOF
# 档 B 再加一行：CONFIG_PACKAGE_libx264=y
make oldconfig

# 确认开关真的生效了
grep -E '^CONFIG_(BUILD_PATENTED|PACKAGE_libx264|PACKAGE_fdk-aac)=y' .config

# 4. 编译（只编 ffmpeg，不用编整个固件）
make package/feeds/packages/ffmpeg/compile V=s -j$(nproc)
```

产物在 `bin/packages/x86_64/*/`：

```
ffmpeg_*.ipk
libffmpeg-full_*.ipk
libx264_*.ipk        # 仅档 B
fdk-aac_*.ipk        # 仅档 A
```

---

## 自动化脚本

[`build-ffmpeg-patented.sh`](build-ffmpeg-patented.sh) 把上面的流程封装起来，
**一次跑出两档产物**：

```sh
bash build-ffmpeg-patented.sh
```

它会：

1. 检查并安装编译依赖（Ubuntu / Debian，`apt`）
2. 下载 SDK 并**校验 sha256**
3. 拉 feeds
4. 编档 A → 收集到 `~/ffmpeg-openwrt-build/out/set-A-decode-only/`
5. 编档 B → 收集到 `~/ffmpeg-openwrt-build/out/set-B-x264/`
6. 打印安装命令

脚本里写死的 SDK 版本是 `24.10.6`，换固件版本时需要同步改这三行：

```sh
SDK_VER="24.10.6"
SDK_FILE="immortalwrt-sdk-${SDK_VER}-x86-64_gcc-13.3.0_musl.Linux-x86_64.tar.zst"
SDK_SHA="709bea2ce466b7ad671ce00fdcb1eb69b2b3fa0f0921b12b620725d95cd8c0e5"
```

---

## 安装到路由器

```sh
# 档 A
opkg install --force-reinstall /tmp/ffmpeg_*.ipk /tmp/libffmpeg-full_*.ipk

# 档 B
opkg install --force-reinstall /tmp/ffmpeg_*.ipk /tmp/libffmpeg-full_*.ipk \
                              /tmp/libx264_*.ipk
```

验证：

```sh
# 装完应该出现纯软件 h264 解码器（之前只有 h264_v4l2m2m）
ffmpeg -hide_banner -decoders | grep -E '^ V.* h264 '

# 档 B 才有
ffmpeg -hide_banner -encoders | grep libx264
```

装好后回到 LuCI 的文件转码页刷新，上传 H.264 视频时那条「本机无法解码」
的红字提示应该消失，编码器下拉框里也会多出可用的选项。

---

## 注意事项

* **SDK 版本必须与固件完全一致**（`cat /etc/openwrt_release` 里的
  `DISTRIB_RELEASE`），否则 libc / ABI 不匹配，包装上也跑不起来。
* **固件升级后必须重编重装**——ffmpeg 与 libc 是绑定的。
* 覆盖安装会替换掉系统自带的 ffmpeg，出问题时用 `opkg install --force-reinstall`
  装回官方版本即可恢复。
* 编译产物只适用于**同架构同版本**的设备，x86/64 的包不能给 ARM 用。
* 档 B 失去 `fdk-aac` 后，音频编码会回退到 ffmpeg 内置的 `aac`，
  质量略低但兼容性没有问题。

---

## 待办

- [ ] 在真实设备上完整验证脚本
- [ ] 补上编译所需时间 / 磁盘占用的实测数据
- [ ] 确认档 A 下 fdk-aac 的 ipk 是否需要一并安装
- [ ] 验证装完后 Luci app 的编码器探测能正确识别新增的编解码器
