'use strict';
const fs = require('fs');
const path = require('path');
const ipk = require('./ipk.js');
const lmoTool = require('./lmo.js');

const SRC = path.join(__dirname, '..', 'luci-app-ffmpeg');
const OUT = path.join(__dirname, '..', 'dist');
const VERSION = '1.2-r1';
fs.mkdirSync(OUT, { recursive: true });

function read(p) { return fs.readFileSync(path.join(SRC, p)); }

// 由文件列表推导出需要的目录条目
function withDirs(files, dirMtime) {
	const dirs = new Set([ './' ]);
	for (const f of files) {
		const parts = f.name.split('/');
		parts.pop();
		let cur = '.';
		for (const p of parts) {
			if (p === '' || p === '.') continue;
			cur = cur === '.' ? './' + p : cur + '/' + p;
			dirs.add(cur + '/');
		}
	}
	const out = [];
	for (const d of [ ...dirs ].sort()) out.push({ name: d, mode: 0o755, type: 'dir', mtime: dirMtime || 0 });
	return out.concat(files);
}

const POSTINST = [
	'#!/bin/sh',
	'[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0',
	'[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0',
	'. ${IPKG_INSTROOT}/lib/functions.sh',
	'default_postinst $0 $@',
	'# 清掉 LuCI 的菜单/模块缓存，并让 rpcd 重新加载 menu.d、acl.d 与 ucode 插件。',
	'# 少了这一步，新装的 ubus 对象不会注册，界面会报「对象不存在」。',
	'[ -n "${IPKG_INSTROOT}" ] || {',
	'	rm -f /tmp/luci-indexcache.*',
	'	rm -rf /tmp/luci-modulecache/',
	'	/etc/init.d/rpcd reload 2>/dev/null',
	'}',
	'exit 0',
	''
].join('\n');
const PRERM = '#!/bin/sh\n[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0\n. ${IPKG_INSTROOT}/lib/functions.sh\ndefault_prerm $0 $@\n';

function buildPackage(spec) {
	const files = spec.files;

	/* 生成物没有源文件 mtime，回退到构建时刻 */
	const fallbackMtime = Math.floor(Date.now() / 1000);

	const dataEntries = withDirs(files.map(function (f) {
		return {
			name: f.dest,
			mode: f.mode,
			type: 'file',
			data: f.data,
			mtime: f.mtime || fallbackMtime
		};
	}), fallbackMtime);

	const dataTarGz = ipk.gzip(ipk.makeTar(dataEntries));

	let control = '';
	control += 'Package: ' + spec.name + '\n';
	control += 'Version: ' + VERSION + '\n';
	control += 'Depends: ' + spec.depends + '\n';
	control += 'Source: feeds/luci/applications/luci-app-ffmpeg\n';
	control += 'SourceName: ' + spec.name + '\n';
	control += 'License: Apache-2.0\n';
	control += 'Section: luci\n';
	control += 'Architecture: all\n';
	control += 'Installed-Size: ' + dataTarGz.length + '\n';
	control += 'Description: ' + spec.description + '\n';

	const ctrlFiles = [
		{ name: './control', mode: 0o644, type: 'file', data: Buffer.from(control, 'utf8') },
		{ name: './postinst', mode: 0o755, type: 'file', data: Buffer.from(POSTINST, 'utf8') },
		{ name: './prerm', mode: 0o755, type: 'file', data: Buffer.from(PRERM, 'utf8') }
	];
	if (spec.conffiles)
		ctrlFiles.push({ name: './conffiles', mode: 0o644, type: 'file', data: Buffer.from(spec.conffiles, 'utf8') });

	const controlEntries = [ { name: './', mode: 0o755, type: 'dir', mtime: fallbackMtime } ].concat(
	ctrlFiles.map(function (f) { return Object.assign({ mtime: fallbackMtime }, f); }));
	const controlTarGz = ipk.gzip(ipk.makeTar(controlEntries));

	const outFile = path.join(OUT, spec.name + '_' + VERSION + '_all.ipk');
	fs.writeFileSync(outFile, ipk.makeIpk(dataTarGz, controlTarGz));
	console.log('  ' + spec.name + '_' + VERSION + '_all.ipk  (' + fs.statSync(outFile).size + ' bytes, 内含 ' + files.length + ' 个文件)');
	return outFile;
}

// ---- 主包 ----
// 只有这两类文件在设备上需要可执行位（相对 root/ 的路径）。
// uci-defaults 由 OpenWrt 用 `.` source 执行，官方包也是 644，故不列入。
const EXEC_PATHS = [ 'root/etc/init.d/', 'root/usr/libexec/' ];

// 自动收集 root/ 与 htdocs/ 下的全部文件，避免新增文件时漏打包。
//   包内路径 root/xxx     -> /xxx
//   包内路径 htdocs/xxx   -> /www/xxx      （与 luci.mk 的 HTDOCS=/www 一致）
function collectTree() {
	const out = [];

	function walk(dir, rel) {
		for (const name of fs.readdirSync(dir).sort()) {
			const full = path.join(dir, name);
			const r = rel ? rel + '/' + name : name;
			const st = fs.statSync(full);

			if (st.isDirectory()) {
				walk(full, r);
				continue;
			}

			const exec = EXEC_PATHS.some(function (p) { return r.indexOf(p) === 0; });
			out.push({
				dest: './' + r.replace(/^root\//, '').replace(/^htdocs\//, 'www/'),
				mode: exec ? 0o755 : 0o644,
				data: fs.readFileSync(full),
				/* 用源文件的真实 mtime：文件没改就不变、改了才变。
				   若写死固定值，浏览器会认为 /luci-static 下的 JS 永远
				   没变而一直用缓存，前端改动就到不了页面。 */
				mtime: Math.floor(st.mtimeMs / 1000)
			});
		}
	}

	walk(path.join(SRC, 'root'), 'root');
	walk(path.join(SRC, 'htdocs'), 'htdocs');
	return out;
}

const mainFiles = collectTree();

/* 生成物（lmo、uci-defaults）没有对应的源文件 mtime，用构建时刻 */
const NOW = Math.floor(Date.now() / 1000);

console.log('构建 ipk:');
buildPackage({
	name: 'luci-app-ffmpeg',
	depends: 'libc, luci-base, ffmpeg, rpcd, rpcd-mod-ucode, ucode, ucode-mod-fs, cgi-io',
	description: ' LuCI support for FFmpeg task management',
	conffiles: '/etc/config/ffmpeg\n',
	files: mainFiles
});

// ---- i18n ----
for (const lang of [ 'zh_Hans', 'zh_Hant' ]) {
	const slug = lang === 'zh_Hans' ? 'zh-cn' : 'zh-tw';
	const label = lang === 'zh_Hans' ? '简体中文 (Chinese Simplified)' : '正體中文 (Chinese Traditional)';
	const po = read('po/' + lang + '/luci-app-ffmpeg.po').toString('utf8');
	const built = lmoTool.buildLmo(po);

	const uciDefault = "uci set luci.languages." + slug.replace('-', '_') + "='" + label + "'; uci commit luci\n";

	buildPackage({
		name: 'luci-i18n-ffmpeg-' + slug,
		depends: 'libc, luci-base, luci-app-ffmpeg',
		description: ' Translation for luci-app-ffmpeg - ' + label,
		files: [
			{ dest: './etc/uci-defaults/luci-i18n-ffmpeg-' + slug, mode: 0o644, data: Buffer.from(uciDefault, 'utf8'), mtime: NOW },
			{ dest: './usr/lib/lua/luci/i18n/luci-app-ffmpeg.' + slug + '.lmo', mode: 0o644, data: built, mtime: NOW }
		]
	});
}
