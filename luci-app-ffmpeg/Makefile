#
# Copyright (C) 2025 luci-app-ffmpeg contributors
#
# This is free software, licensed under the Apache License, Version 2.0.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-ffmpeg
PKG_VERSION:=1.2
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=luci-app-ffmpeg contributors

LUCI_TITLE:=LuCI support for FFmpeg task management
LUCI_DESCRIPTION:=Manage FFmpeg tasks on the router (start / stop / restart / \
	logs), plus a file conversion page that uploads a file, transcodes it on the \
	device and offers the result for download. Only encoders this device can \
	actually use are offered, and the source file is probed after upload so an \
	unsupported format is reported before a conversion is attempted.
LUCI_DEPENDS:=+luci-base +ffmpeg +rpcd +rpcd-mod-ucode +ucode +ucode-mod-fs +cgi-io
LUCI_PKGARCH:=all

define Package/luci-app-ffmpeg/conffiles
/etc/config/ffmpeg
endef

# luci.mk 的位置取决于本包的放置方式：
#   feeds/luci/applications/luci-app-ffmpeg/    -> ../../luci.mk
#   package/luci-app-ffmpeg/（已装 luci feed）  -> $(TOPDIR)/feeds/luci/luci.mk
LUCI_MK:=$(firstword $(wildcard ../../luci.mk $(TOPDIR)/feeds/luci/luci.mk $(TOPDIR)/package/luci/luci.mk))

ifeq ($(LUCI_MK),)
  $(error luci.mk not found. Put this package into the luci feed, or make sure the luci feed is installed)
endif

include $(LUCI_MK)

# call BuildPackage - OpenWrt buildroot signature
