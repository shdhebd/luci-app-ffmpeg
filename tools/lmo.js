'use strict';
// lmo.js —— LuCI 的 .lmo 生成器（对应 luci-base/src/po2lmo.c + lib/lmo.h）

function sfhGet16(buf, i) { return (buf[i] | (buf[i + 1] << 8)) >>> 0; }
function sChar(b) { return (b << 24) >> 24; }

// SuperFastHash，带外部初值，与 C 版本逐位一致
function sfhHash(buf, len, init) {
	let hash = init >>> 0;
	let off = 0;
	let rem = len & 3;
	let n = len >>> 2;

	for (; n > 0; n--) {
		let tmp;
		hash = (hash + sfhGet16(buf, off)) >>> 0;
		tmp = ((sfhGet16(buf, off + 2) << 11) ^ hash) >>> 0;
		hash = (((hash << 16) >>> 0) ^ tmp) >>> 0;
		off += 4;
		hash = (hash + (hash >>> 11)) >>> 0;
	}

	switch (rem) {
	case 3:
		hash = (hash + sfhGet16(buf, off)) >>> 0;
		hash = (hash ^ ((hash << 16) >>> 0)) >>> 0;
		hash = (hash ^ ((sChar(buf[off + 2]) << 18) >>> 0)) >>> 0;
		hash = (hash + (hash >>> 11)) >>> 0;
		break;
	case 2:
		hash = (hash + sfhGet16(buf, off)) >>> 0;
		hash = (hash ^ ((hash << 11) >>> 0)) >>> 0;
		hash = (hash + (hash >>> 17)) >>> 0;
		break;
	case 1:
		hash = (hash + sChar(buf[off])) >>> 0;
		hash = (hash ^ ((hash << 10) >>> 0)) >>> 0;
		hash = (hash + (hash >>> 1)) >>> 0;
		break;
	}

	hash = (hash ^ ((hash << 3) >>> 0)) >>> 0;
	hash = (hash + (hash >>> 5)) >>> 0;
	hash = (hash ^ ((hash << 4) >>> 0)) >>> 0;
	hash = (hash + (hash >>> 17)) >>> 0;
	hash = (hash ^ ((hash << 25) >>> 0)) >>> 0;
	hash = (hash + (hash >>> 6)) >>> 0;

	return hash >>> 0;
}

// 从一行 po 文本里取出引号内的内容，反转义规则与 C 版 extract_string 一致
function extractString(line) {
	const t = line.replace(/\r?\n$/, '');
	if (t.startsWith('#')) return null;
	const start = t.indexOf('"');
	if (start < 0) return null;

	const out = [];
	for (let i = start + 1; i < t.length; i++) {
		const c = t[i];
		if (c === '\\') {
			const n = t[i + 1];
			if (n === '"' || n === '\\') { out.push(n); i++; }
			else { out.push('\\', n === undefined ? '' : n); i++; }
		}
		else if (c === '"') break;
		else out.push(c);
	}
	return out.join('');
}

// 解析 po，返回 [{ key, val }]，key 已按 po2lmo 的规则合成
function parsePo(text) {
	const lines = text.split('\n');
	const msgs = [];
	let msg = null;
	let cur = null;

	function flush() {
		if (msg && (msg.id !== null || msg.val !== null)) msgs.push(msg);
		msg = null;
		cur = null;
	}

	for (const raw of lines) {
		const line = raw;

		if (line.startsWith('msgctxt "')) { flush(); msg = { ctxt: '', id: null, plural: null, val: '' }; cur = 'ctxt'; }
		else if (line.startsWith('msgid_plural "')) { if (!msg) { msg = { ctxt: null, id: null, plural: '', val: '' }; } msg.plural = ''; cur = 'plural'; }
		else if (line.startsWith('msgid "')) { flush(); msg = { ctxt: null, id: '', plural: null, val: null }; cur = 'id'; }
		else if (line.startsWith('msgstr "')) { if (!msg) { msg = { ctxt: null, id: null, plural: null, val: '' }; } msg.val = ''; cur = 'val'; }
		else if (line.startsWith('msgstr[')) { if (!msg) { msg = { ctxt: null, id: null, plural: null, val: '' }; } msg.val = ''; cur = 'val'; }

		if (!cur) continue;

		const s = extractString(line);
		if (s === null) continue;

		if (cur === 'ctxt') msg.ctxt = (msg.ctxt || '') + s;
		else if (cur === 'id') msg.id = (msg.id || '') + s;
		else if (cur === 'plural') msg.plural = (msg.plural || '') + s;
		else if (cur === 'val') msg.val = (msg.val || '') + s;
	}

	flush();
	return msgs;
}

// 生成 lmo（与 po2lmo 的字节输出一致）
function buildLmo(poText) {
	const msgs = parsePo(poText);
	const dataChunks = [];
	const entries = [];
	let offset = 0;

	function emit(str) {
		const b = Buffer.from(str, 'utf8');
		const pad = (4 - (b.length % 4)) % 4;
		const rec = { offset: offset, length: b.length, str: str };
		dataChunks.push(b);
		if (pad) dataChunks.push(Buffer.alloc(pad));
		offset += b.length + pad;
		return rec;
	}

	for (const m of msgs) {
		// C 版里空 msgid / 空 msgstr 不会分配内存，指针保持 NULL；
		// 空 msgid 因此落入 header 分支去提取 Plural-Forms。
		const hasId = (m.id !== null && m.id !== '');
		const hasVal = (m.val !== null && m.val !== '');

		if (hasId && hasVal) {
			let key;
			if (m.ctxt && m.plural) key = m.ctxt + '\u0001' + m.id + '\u0002' + '0';
			else if (m.ctxt) key = m.ctxt + '\u0001' + m.id;
			else if (m.plural) key = m.id + '\u0002' + '0';
			else key = m.id;

			const kb = Buffer.from(key, 'utf8');
			const vb = Buffer.from(m.val, 'utf8');
			const keyId = sfhHash(kb, kb.length, kb.length);
			const valId = sfhHash(vb, vb.length, vb.length);

			if (keyId !== valId) {
				const rec = emit(m.val);
				entries.push({ keyId: keyId, valId: 1, offset: rec.offset, length: rec.length });
			}
		}
		else if (hasVal) {
			// header：抽出 Plural-Forms 行
			const v = m.val;
			let field = 0;
			let esc = false;
			for (let p = 0; p < v.length; p++) {
				if (esc) {
					if (v[p] === 'n') {
						const seg = v.substring(field, p - 1);
						if (seg.toLowerCase().startsWith('plural-forms: ')) {
							const val = seg.substring(14);
							const rec = emit(val);
							entries.push({ keyId: 0, valId: 0, offset: rec.offset, length: rec.length });
							break;
						}
						field = p + 1;
					}
					esc = false;
				}
				else if (v[p] === '\\') esc = true;
			}
		}
	}

	entries.sort(function (a, b) { return (a.keyId >>> 0) - (b.keyId >>> 0) || 0; });

	const idx = Buffer.alloc(entries.length * 16);
	entries.forEach(function (e, i) {
		idx.writeUInt32BE(e.keyId >>> 0, i * 16);
		idx.writeUInt32BE(e.valId >>> 0, i * 16 + 4);
		idx.writeUInt32BE(e.offset >>> 0, i * 16 + 8);
		idx.writeUInt32BE(e.length >>> 0, i * 16 + 12);
	});

	const tail = Buffer.alloc(4);
	tail.writeUInt32BE(offset >>> 0, 0);

	return Buffer.concat(dataChunks.concat([ idx, tail ]));
}

module.exports = { sfhHash: sfhHash, parsePo: parsePo, buildLmo: buildLmo };
