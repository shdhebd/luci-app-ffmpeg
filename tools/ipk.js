'use strict';
// ipk.js —— 生成 OpenWrt ipk（格式: gzip(tar(debian-binary, data.tar.gz, control.tar.gz))）
const zlib = require('zlib');

const EPOCH = 1750000000;

function octal(n, len) {
	const s = (n >>> 0).toString(8);
	return s.padStart(len - 1, '0') + '\0';
}

function tarHeader(name, mode, size, typeflag) {
	const h = Buffer.alloc(512, 0);
	h.write(name, 0, 100, 'utf8');
	h.write(octal(mode, 8), 100, 8, 'latin1');
	h.write(octal(0, 8), 108, 8, 'latin1');
	h.write(octal(0, 8), 116, 8, 'latin1');
	h.write((size >>> 0).toString(8).padStart(11, '0') + '\0', 124, 12, 'latin1');
	h.write(octal(EPOCH, 12), 136, 12, 'latin1');
	h.write('        ', 148, 8, 'latin1');           // checksum 占位（8 空格）
	h.write(typeflag, 156, 1, 'latin1');
	h.write('ustar\0', 257, 6, 'latin1');
	h.write('00', 263, 2, 'latin1');
	h.write('root', 265, 4, 'latin1');
	h.write('root', 297, 4, 'latin1');

	let sum = 0;
	for (let i = 0; i < 512; i++) sum += h[i];
	h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
	return h;
}

// entries: [{ name, mode, type ('file'|'dir'), data }]
function makeTar(entries) {
	const chunks = [];
	for (const e of entries) {
		const isDir = e.type === 'dir';
		const data = isDir ? Buffer.alloc(0) : e.data;
		const name = isDir && !e.name.endsWith('/') ? e.name + '/' : e.name;
		chunks.push(tarHeader(name, e.mode, data.length, isDir ? '5' : '0'));
		if (!isDir && data.length) {
			chunks.push(data);
			const pad = (512 - (data.length % 512)) % 512;
			if (pad) chunks.push(Buffer.alloc(pad));
		}
	}
	chunks.push(Buffer.alloc(1024));   // 结束块
	return Buffer.concat(chunks);
}

function makeIpk(dataTarGz, controlTarGz) {
	const debianBinary = Buffer.from('2.0\n', 'utf8');
	const inner = makeTar([
		{ name: './debian-binary', mode: 0o644, type: 'file', data: debianBinary },
		{ name: './data.tar.gz', mode: 0o644, type: 'file', data: dataTarGz },
		{ name: './control.tar.gz', mode: 0o644, type: 'file', data: controlTarGz }
	]);
	return zlib.gzipSync(inner, { level: 9 });
}

module.exports = { makeTar: makeTar, makeIpk: makeIpk, gzip: function (b) { return zlib.gzipSync(b, { level: 9 }); } };
