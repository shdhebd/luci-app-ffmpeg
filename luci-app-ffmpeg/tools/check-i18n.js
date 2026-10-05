// i18n 一致性自检：把源码里的 _('...') 字符串与 po 文件的 msgid 对比。
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.argv[2];

function walk(dir, out) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory())
			walk(p, out);
		else
			out.push(p);
	}
	return out;
}

const files = walk(root, []);

/* ---- 1. 从源码收集待翻译字符串 ---- */
const src = new Map(); // string -> [source files]

function add(str, file) {
	if (!src.has(str))
		src.set(str, new Set());
	src.get(str).add(file);
}

for (const f of files) {
	const rel = path.relative(root, f).replace(/\\/g, '/');

	// 只扫描 LuCI 的 i18n-scan 会提取字符串的位置，避免把工具脚本自身算进来
	const isView = /^htdocs\/.*\.js$/.test(rel);
	const isMenu = /^root\/.*\/menu\.d\/.*\.json$/.test(rel);

	if (!isView && !isMenu)
		continue;

	if (isView) {
		const text = fs.readFileSync(f, 'utf8');
		const re = /_\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*\)/g;
		let m;
		while ((m = re.exec(text)) !== null)
			add(m[2].replace(/\\(['"\\])/g, '$1'), rel);
	}
	else {
		const json = JSON.parse(fs.readFileSync(f, 'utf8'));
		for (const key of Object.keys(json))
			if (json[key] && json[key].title)
				add(json[key].title, rel);
	}
}

/* ---- 2. 解析 po/pot 的 msgid ---- */
function parsePo(file) {
	const text = fs.readFileSync(file, 'utf8');
	const ids = new Set();
	const re = /^msgid\s+"((?:[^"\\]|\\.)*)"\s*$/gm;
	let m;
	while ((m = re.exec(text)) !== null) {
		const id = m[1].replace(/\\(["\\])/g, '$1');
		if (id.length > 0)
			ids.add(id);
	}
	return ids;
}

function parsePoTranslations(file) {
	const text = fs.readFileSync(file, 'utf8');
	const pairs = new Map();
	const re = /^msgid\s+"((?:[^"\\]|\\.)*)"\s*\nmsgstr\s+"((?:[^"\\]|\\.)*)"\s*$/gm;
	let m;
	while ((m = re.exec(text)) !== null) {
		const id = m[1].replace(/\\(["\\])/g, '$1');
		const str = m[2].replace(/\\(["\\])/g, '$1');
		if (id.length > 0)
			pairs.set(id, str);
	}
	return pairs;
}

let problems = 0;

function report(label, list) {
	if (list.length === 0) {
		console.log(`OK   ${label}`);
	}
	else {
		problems += list.length;
		console.log(`FAIL ${label}`);
		for (const item of list)
			console.log(`       - ${item}`);
	}
}

const potIds = parsePo(path.join(root, 'po/templates/luci-app-ffmpeg.pot'));

const missingInPot = [...src.keys()].filter(s => !potIds.has(s)).sort();
report(`模板 pot 覆盖源码字符串 (${src.size} 条)`, missingInPot);

const unusedInPot = [...potIds].filter(s => !src.has(s)).sort();
report('模板 pot 中多余的条目', unusedInPot);

for (const lang of [ 'zh_Hans', 'zh_Hant' ]) {
	const poFile = path.join(root, 'po', lang, 'luci-app-ffmpeg.po');

	if (!fs.existsSync(poFile)) {
		console.log(`FAIL 缺少 po 文件: po/${lang}/luci-app-ffmpeg.po`);
		problems++;
		continue;
	}

	const pairs = parsePoTranslations(poFile);

	const missing = [...src.keys()].filter(s => !pairs.has(s)).sort();
	report(`${lang}: 覆盖源码字符串`, missing);

	const empty = [...pairs.entries()].filter(([ , v ]) => v.length === 0).map(([ k ]) => k);
	report(`${lang}: 未翻译（msgstr 为空）`, empty);

	const stale = [...pairs.keys()].filter(s => !src.has(s)).sort();
	report(`${lang}: 源码中已不存在的条目`, stale);
}

console.log(problems === 0 ? '\n=== 全部检查通过 ===' : `\n=== 发现 ${problems} 个问题 ===`);
process.exit(problems === 0 ? 0 : 1);
