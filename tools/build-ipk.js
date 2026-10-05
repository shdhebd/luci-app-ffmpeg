'use strict';
const fs = require('fs');
const path = require('path');
const ipk = require('./ipk.js');
const lmoTool = require('./lmo.js');

const SRC = path.join(__dirname, '..', 'luci-app-ffmpeg');
const OUT = path.join(__dirname, '..', 'dist');
const VERSION = '1.0.0-r1';
fs.mkdirSync(OUT, { recursive: true });

function read(p) { return fs.readFileSync(path.join(SRC, p)); }

// 由文件列表推导出需要的目录条目
function withDirs(files) {
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
	for (const d of [ ...dirs ].sort()) out.push({ name: d, mode: 0o755, type: 'dir' });
	return out.concat(files);
}

const POSTINST = '#!/bin/sh\n[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0\n[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0\n. ${IPKG_INSTROOT}/lib/functions.sh\ndefault_postinst $0 $@\n';
const PRERM = '#!/bin/sh\n[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0\n. ${IPKG_INSTROOT}/lib/functions.sh\ndefault_prerm $0 $@\n';

function buildPackage(spec) {
	const files = spec.files;
	const dataEntries = withDirs(files.map(function (f) {
		return { name: f.dest, mode: f.mode, type: 'file', data: f.data };
	}));

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

	const controlEntries = [ { name: './', mode: 0o755, type: 'dir' } ].concat(ctrlFiles);
	const controlTarGz = ipk.gzip(ipk.makeTar(controlEntries));

	const outFile = path.join(OUT, spec.name + '_' + VERSION + '_all.ipk');
	fs.writeFileSync(outFile, ipk.makeIpk(dataTarGz, controlTarGz));
	console.log('  ' + spec.name + '_' + VERSION + '_all.ipk  (' + fs.statSync(outFile).size + ' bytes, 内含 ' + files.length + ' 个文件)');
	return outFile;
}

// ---- 主包 ----
const mainFiles = [
	{ dest: './etc/config/ffmpeg', mode: 0o644, data: read('root/etc/config/ffmpeg') },
	{ dest: './etc/init.d/ffmpeg', mode: 0o755, data: read('root/etc/init.d/ffmpeg') },
	{ dest: './etc/uci-defaults/40_luci-app-ffmpeg', mode: 0o755, data: read('root/etc/uci-defaults/40_luci-app-ffmpeg') },
	{ dest: './usr/libexec/ffmpeg-ctl', mode: 0o755, data: read('root/usr/libexec/ffmpeg-ctl') },
	{ dest: './usr/share/luci/menu.d/luci-app-ffmpeg.json', mode: 0o644, data: read('root/usr/share/luci/menu.d/luci-app-ffmpeg.json') },
	{ dest: './usr/share/rpcd/acl.d/luci-app-ffmpeg.json', mode: 0o644, data: read('root/usr/share/rpcd/acl.d/luci-app-ffmpeg.json') },
	{ dest: './usr/share/rpcd/ucode/ffmpeg', mode: 0o644, data: read('root/usr/share/rpcd/ucode/ffmpeg') },
	{ dest: './www/luci-static/resources/view/ffmpeg/overview.js', mode: 0o644, data: read('htdocs/luci-static/resources/view/ffmpeg/overview.js') },
	{ dest: './www/luci-static/resources/view/ffmpeg/tasks.js', mode: 0o644, data: read('htdocs/luci-static/resources/view/ffmpeg/tasks.js') },
	{ dest: './www/luci-static/resources/view/ffmpeg/settings.js', mode: 0o644, data: read('htdocs/luci-static/resources/view/ffmpeg/settings.js') }
];

console.log('构建 ipk:');
buildPackage({
	name: 'luci-app-ffmpeg',
	depends: 'libc, luci-base, ffmpeg, rpcd, rpcd-mod-ucode, ucode, ucode-mod-fs',
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
			{ dest: './etc/uci-defaults/luci-i18n-ffmpeg-' + slug, mode: 0o644, data: Buffer.from(uciDefault, 'utf8') },
			{ dest: './usr/lib/lua/luci/i18n/luci-app-ffmpeg.' + slug + '.lmo', mode: 0o644, data: built }
		]
	});
}
