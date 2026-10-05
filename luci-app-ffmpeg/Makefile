#
# Copyright (C) 2025 luci-app-ffmpeg contributors
#
# This is free software, licensed under the Apache License, Version 2.0.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-ffmpeg
PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=luci-app-ffmpeg contributors

LUCI_TITLE:=LuCI support for FFmpeg task management
LUCI_DESCRIPTION:=Web interface to configure, start, stop and inspect FFmpeg \
	transcoding / streaming tasks directly on the router.
LUCI_DEPENDS:=+luci-base +ffmpeg +rpcd +rpcd-mod-ucode +ucode +ucode-mod-fs
LUCI_PKGARCH:=all

define Package/luci-app-ffmpeg/conffiles
/etc/config/ffmpeg
endef

# luci.mk 的位置取决于本包的放置方式：
#   feeds/luci/applications/luci-app-ffmpeg/  -> ../../luci.mk
#   package/luci-app-ffmpeg/（已安装 luci feed）-> $(TOPDIR)/feeds/luci/luci.mk
LUCI_MK:=$(firstword $(wildcard ../../luci.mk $(TOPDIR)/feeds/luci/luci.mk $(TOPDIR)/package/luci/luci.mk))

ifeq ($(LUCI_MK),)
  $(error luci.mk not found. Put this package into the luci feed, or make sure the luci feed is installed)
endif

include $(LUCI_MK)

# call BuildPackage - OpenWrt buildroot signature
