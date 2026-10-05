#!/bin/bash
#
# 为 ImmortalWrt 24.10.6 x86/64 编译带专利编解码器的 ffmpeg
#
# 官方构建默认禁用「专利编解码器」（H.264/H.265/VC1 的解码器与复用器），
# 导致路由器上的 ffmpeg 读不了 H.264 视频，任何重编码都会失败，只剩
# 「复制」可用。本脚本重编 ffmpeg，产出两套 ipk：
#
#   set-A  仅启用专利解码器      -> 能读 H.264/H.265 并重编码为 mpeg4 等，
#                                   保留 fdk-aac（音频编码质量更好）
#   set-B  专利解码器 + libx264  -> 额外能输出 H.264，
#                                   但 libx264(GPL) 与 fdk-aac 不能共存，
#                                   音频回退到 ffmpeg 内置 aac
#
# 用法：  bash build-ffmpeg.sh
#
set -euo pipefail

# ---------------------------------------------------------------- 配置
SDK_VER="24.10.6"
SDK_FILE="immortalwrt-sdk-${SDK_VER}-x86-64_gcc-13.3.0_musl.Linux-x86_64.tar.zst"
SDK_URL="https://downloads.immortalwrt.org/releases/${SDK_VER}/targets/x86/64/${SDK_FILE}"
SDK_SHA="709bea2ce466b7ad671ce00fdcb1eb69b2b3fa0f0921b12b620725d95cd8c0e5"

WORK="${HOME}/ffmpeg-openwrt-build"
SDK_DIR="${WORK}/sdk"
OUT_DIR="${WORK}/out"

# 只编这些包；依赖由 make 自动拉起
PKGS="package/feeds/packages/ffmpeg/compile"

# 最终需要收集的 ipk（设备上要替换/新增的）
COLLECT="ffmpeg libffmpeg-full libffmpeg libx264 fdk-aac"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. 依赖
log "检查编译依赖"
NEED=()
for c in gcc g++ make flex bison gawk gettext git rsync unzip zstd wget \
         python3 file; do
	command -v "$c" >/dev/null 2>&1 || NEED+=("$c")
done
# 头文件单独判断，命令存在不代表开发包已装
[ -f /usr/include/zlib.h ]  || NEED+=(zlib1g-dev)
[ -f /usr/include/ncurses.h ] || NEED+=(libncurses-dev)
[ -f /usr/include/openssl/ssl.h ] || NEED+=(libssl-dev)

if [ "${#NEED[@]}" -gt 0 ]; then
	log "安装缺失的依赖：${NEED[*]}"
	sudo apt-get update
	sudo apt-get install -y \
		build-essential clang flex bison g++ gawk gcc-multilib g++-multilib \
		gettext git libncurses-dev libssl-dev python3 python3-setuptools \
		rsync unzip zlib1g-dev file wget zstd subversion time \
		"${NEED[@]}"
else
	echo "  依赖已齐备"
fi

# ---------------------------------------------------------------- 2. SDK
mkdir -p "$WORK"
cd "$WORK"

if [ ! -f "$SDK_FILE" ]; then
	log "下载 SDK（约 490 MB）"
	wget -c -O "$SDK_FILE" "$SDK_URL"
else
	echo "  SDK 已存在，跳过下载"
fi

log "校验 SDK"
echo "${SDK_SHA}  ${SDK_FILE}" | sha256sum -c - \
	|| die "SDK 校验失败，请删除 ${WORK}/${SDK_FILE} 后重试"

if [ ! -d "$SDK_DIR" ]; then
	log "解压 SDK"
	mkdir -p "$SDK_DIR"
	tar -xf "$SDK_FILE" -C "$SDK_DIR" --strip-components=1
else
	echo "  SDK 已解压，跳过"
fi

cd "$SDK_DIR"

# ---------------------------------------------------------------- 3. feeds
if [ ! -d feeds/packages ]; then
	log "更新并安装 feeds"
	./scripts/feeds update -a
	./scripts/feeds install -a
else
	echo "  feeds 已就绪，跳过"
fi

# ------------------------------------------------- 4. 生成配置的辅助函数
# 每次都从干净的基础配置开始，避免上一次的选项残留
write_config() {
	local patent="$1" x264="$2"

	log "生成配置（BUILD_PATENTED=${patent}, libx264=${x264}）"

	# 从干净状态开始，避免上一次的选项残留导致「以为改了其实没改」
	rm -f .config

	# 以 SDK 自带配置为基础
	make defconfig >/dev/null 2>&1 || true

	{
		echo "CONFIG_BUILD_PATENTED=y"
		echo "CONFIG_PACKAGE_libffmpeg-full=y"
		echo "CONFIG_PACKAGE_ffmpeg=y"
		# 注意用 if 而不是 [ ] &&：在 set -e 下，条件为假时后者会让整块返回非零
		if [ "$x264" = "y" ]; then
			echo "CONFIG_PACKAGE_libx264=y"
		fi
	} >> .config

	# oldconfig 补齐依赖并丢弃无效项
	make oldconfig </dev/null >/dev/null 2>&1 || true

	# 确认关键开关真的生效了
	grep -q '^CONFIG_BUILD_PATENTED=y' .config \
		|| die "CONFIG_BUILD_PATENTED 未能启用"
	if [ "$x264" = "y" ]; then
		grep -q '^CONFIG_PACKAGE_libx264=y' .config \
			|| die "CONFIG_PACKAGE_libx264 未能启用（检查 libx264 是否在 feeds 中）"
	fi

	# 打印实际生效的关键开关。
	# libffmpeg-full 的依赖里写了 +!PACKAGE_libx264:fdk-aac，
	# 也就是「不选 libx264 就自动带上 fdk-aac」——这里正好验证它按预期解析。
	printf '  BUILD_PATENTED = %s\n' "$(grep -c '^CONFIG_BUILD_PATENTED=y' .config)"
	printf '  libffmpeg-full = %s\n' "$(grep -c '^CONFIG_PACKAGE_libffmpeg-full=y' .config)"
	printf '  libx264        = %s\n' "$(grep -c '^CONFIG_PACKAGE_libx264=y' .config)"
	printf '  fdk-aac        = %s\n' "$(grep -c '^CONFIG_PACKAGE_fdk-aac=y' .config)"
}

# ------------------------------------------------------------ 5. 编译并收集
build_and_collect() {
	local tag="$1"

	log "编译（${tag}）—— 首次编译约 10-25 分钟"
	make $PKGS V=s -j"$(nproc)" 2>&1 | tail -n 40

	local dest="${OUT_DIR}/${tag}"
	rm -rf "$dest"
	mkdir -p "$dest"

	# 用 find 去重：同一个包可能同时出现在 base/ 与 packages/ 下
	local found=0
	for p in $COLLECT; do
		while IFS= read -r f; do
			[ -n "$f" ] || continue
			cp -f "$f" "$dest/"
			found=$((found + 1))
		done < <(find bin/packages -maxdepth 3 -type f \
			\( -name "${p}_*.ipk" -o -name "${p}.ipk" \) 2>/dev/null | sort -u)
	done

	[ "$found" -gt 0 ] || die "${tag} 没有收集到任何 ipk，编译可能失败了"

	log "${tag} 产物"
	ls -1sh "$dest" | sed 's/^/    /'
}

# ---------------------------------------------------------------- 6. 档 A
write_config y n
build_and_collect set-A-decode-only

# ---------------------------------------------------------------- 7. 档 B
# 必须重新生成配置并让 make 感知选项变化，否则不会重编 ffmpeg
write_config y y
build_and_collect set-B-x264

# ---------------------------------------------------------------- 8. 汇总
log "完成"
cat <<EOF

产物目录：
  ${OUT_DIR}/set-A-decode-only    仅解码器，保留 fdk-aac
  ${OUT_DIR}/set-B-x264           解码器 + libx264（无 fdk-aac）

装到设备（先传到 /tmp）：

  档 A:
    opkg install --force-reinstall /tmp/ffmpeg_*.ipk /tmp/libffmpeg-full_*.ipk

  档 B:
    opkg install --force-reinstall /tmp/ffmpeg_*.ipk /tmp/libffmpeg-full_*.ipk \\
                                  /tmp/libx264_*.ipk

装完在设备上验证：

  ffmpeg -hide_banner -decoders | grep -E '^ V.* h264 '     # 应出现纯软件 h264
  ffmpeg -hide_banner -encoders | grep libx264               # 档 B 才有

注意：
  * SDK 版本必须与固件一致（本脚本对应 ImmortalWrt ${SDK_VER} x86/64）
  * 固件升级后需要重新编译并重装
  * 两档都用 --force-reinstall 覆盖原有 ffmpeg 包
EOF
