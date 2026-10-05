// SPDX-License-Identifier: Apache-2.0
//
// 「文件转码」页：上传一个本地文件到路由器，用 ffmpeg 转码后下载结果。
//
// 实现上复用了现有的任务机制——上传的文件会变成一个名为 convert 的
// 普通 UCI task，因此后端 (rpcd/ucode + ffmpeg-ctl) 完全不需要改动。
// 上传 / 下载走 LuCI 标准的 cgi-io 通道。

'use strict';
'require view';
'require form';
'require rpc';
'require uci';
'require ui';
'require dom';
'require poll';
'require request';

/*
 * 页面脚本的版本号。
 *
 * 浏览器会缓存 luci-static 下的 JS，改了前端却看到旧行为时很难判断是
 * 「代码没生效」还是「逻辑本身有问题」。把它显示在页面上，一比对就知道。
 * 每次改动这个文件都要同步更新。
 */
var JS_VERSION = '1.2';

/* 上传的源文件与转码产物都放在 /tmp（tmpfs，重启即清） */
var SECTION = 'convert';
var SRC_BASE = '/tmp/ffmpeg-convert.in';
var OUT_BASE = '/tmp/ffmpeg-convert.out';

/*
 * 用 cgi-io 的「直接」端点，而不是 LuCI 的 /cgi-bin/luci/cgi-* 转发路径。
 * 实测（ImmortalWrt 24.10 + LuCI 26.x）前者返回 200，后者返回 404，
 * 因此不能依赖 ui.uploadFile()（它内部写死了 L.env.cgi_base + '/cgi-upload'）。
 */
var UPLOAD_URL = '/cgi-bin/cgi-upload';
var DOWNLOAD_URL = '/cgi-bin/cgi-download';

/*
 * cgi-io 返回的错误是英文原文，这里映射成可翻译的文案。
 * 未匹配到的原样显示，总比吞掉强。
 */
var UPLOAD_ERRORS = {
	'Access to path denied by ACL': _('Access to the upload path was denied by ACL.'),
	'Upload permission denied': _('Upload permission denied.'),
	'I/O failure while writing target file': _('I/O failure while writing the file.'),
	'Internal program failure': _('Internal program failure.')
};

var callStatus = rpc.declare({
	object: 'ffmpeg',
	method: 'status',
	expect: { '': {} }
});

var callLog = rpc.declare({
	object: 'ffmpeg',
	method: 'log',
	params: [ 'section', 'lines' ],
	expect: { '': {} }
});

var callEncoders = rpc.declare({
	object: 'ffmpeg',
	method: 'encoders',
	expect: { '': {} }
});

var callExitCode = rpc.declare({
	object: 'ffmpeg',
	method: 'exitcode',
	params: [ 'section' ],
	expect: { '': {} }
});

var callConfig = rpc.declare({
	object: 'ffmpeg',
	method: 'config',
	params: [ 'section' ],
	expect: { '': {} }
});

var callConfigure = rpc.declare({
	object: 'ffmpeg',
	method: 'configure',
	params: [ 'section', 'json' ],
	expect: { '': {} }
});

var callProbe = rpc.declare({
	object: 'ffmpeg',
	method: 'probe',
	params: [ 'path' ],
	expect: { '': {} }
});

var callControl = rpc.declare({
	object: 'ffmpeg',
	method: 'control',
	params: [ 'action', 'section' ],
	expect: { '': {} },
	reject: true
});

/* 输出容器：显示名 -> 扩展名 */
var CONTAINERS = [
	[ 'mp4',  'MP4 (.mp4)',        '.mp4'  ],
	[ 'mkv',  'Matroska (.mkv)',   '.mkv'  ],
	[ 'webm', 'WebM (.webm)',      '.webm' ],
	[ 'avi',  'AVI (.avi)',        '.avi'  ],
	[ 'ts',   'MPEG-TS (.ts)',     '.ts'   ],
	[ 'mp3',  'MP3 (.mp3, 仅音频)', '.mp3'  ],
	[ 'm4a',  'M4A (.m4a, 仅音频)', '.m4a'  ]
];

/* 页面状态 */
var state = {
	uploaded: false,
	picked: null,
	srcPath: '',
	srcName: '',
	srcSize: 0,
	running: false,
	finished: false,
	failed: false,
	lastParams: null,
	lastWritten: null
};

/*
 * 本机 ffmpeg 真正可用的编码器；null 表示尚未或无法探测（此时列出全部候选）。
 *
 * 后端用「实际跑一次编码」探测，而不是查 -encoders 列表——
 * h264_v4l2m2m 那类编码器会出现在列表里，但在没有 v4l2 设备节点的机器上
 * （虚拟机、多数 x86）一用就报 "Could not find a valid device"。
 */
var available = { video: null, audio: null };

/*
 * 按探测结果填充编码器下拉框。
 *
 * 路由器上的 ffmpeg 经常不带 libx264 / libx265，如果无条件列出这些选项，
 * 用户会选中一个根本不存在的编码器，直到转码时才报 Unknown encoder。
 * 所以只列出探测到确实可用的；探测失败时退回列出全部候选，并保留 copy/none。
 */
function addCodecOptions(o, kind, candidates) {
	var list = available[kind];

	for (var i = 0; i < candidates.length; i++) {
		var id = candidates[i][0];

		/* copy / none 是 ffmpeg 的内建行为，不属于编码器列表 */
		if (id === 'copy' || id === 'none') {
			o.value(id, candidates[i][1]);
			continue;
		}

		if (list == null || list.indexOf(id) >= 0)
			o.value(id, candidates[i][1]);
	}
}

/* 由 render() 赋值，供 startConversion 保存表单 */
var formMap = null;

/* option 名 -> option 对象，由 render() 填充。
   启动转码时直接从这些对象读取界面上的当前值，不依赖 form.parse()。 */
var FIELD_OPTS = {};

/* 需要写进 UCI 的转换参数（input/output 另行设置） */
var PARAM_FIELDS = [
	'output_container', 'video_codec', 'video_bitrate', 'scale', 'fps',
	'audio_codec', 'audio_bitrate', 'extra_args', 'loglevel'
];

/* poll 句柄，SPA 切换视图时需要显式移除 */
var pollHandle = null;

/* poll 回调需要引用的 DOM 节点，由 renderResult() 填充 */
var pollRefs = null;

function containerExt(id) {
	for (var i = 0; i < CONTAINERS.length; i++)
		if (CONTAINERS[i][0] === id)
			return CONTAINERS[i][2];

	return '.mp4';
}

function outPath(container) {
	return OUT_BASE + containerExt(container);
}

function humanSize(bytes) {
	return '%1024.2mB'.format(+bytes || 0);
}

/* ------------------------------------------------------------------ */
/* 各区块                                                              */
/* ------------------------------------------------------------------ */

function renderUpload() {
	/* 所有反馈都内联显示，不使用浮动通知或弹窗 */
	var status = E('div', { 'style': 'margin-top:8px' }, [
		E('em', {}, _('No file has been uploaded yet.'))
	]);

	/* 源文件探测结果：显示流编码，并在本机无法解码时给出明确提示 */
	var probeBox = E('div', { 'style': 'margin-top:6px;display:none' });

	function showStatus(children, color) {
		dom.content(status, E('span', {
			'style': color ? 'color:' + color : ''
		}, children));
	}

	/* 隐藏的文件选择框，由「浏览…」按钮触发 */
	var input = E('input', {
		'type': 'file',
		'style': 'display:none',
		'change': function (ev) {
			var f = ev.currentTarget.files[0];
			if (!f)
				return;

			state.picked = f;
			dom.content(pickInfo, [
				E('strong', {}, f.name), ' (', humanSize(f.size), ')'
			]);
			upBtn.disabled = false;
			showStatus([ _('No file has been uploaded yet.') ], null);
		}
	});

	var pickInfo = E('div', { 'style': 'margin:8px 0' }, [ E('em', {}, _('No file selected.')) ]);

	var browseBtn = E('button', {
		'class': 'btn cbi-button',
		'click': function (ev) { ev.currentTarget.previousElementSibling.click(); }
	}, _('Browse…'));

	var progress = E('div', {
		'class': 'cbi-progressbar',
		'title': '0%',
		'style': 'margin-top:8px;display:none'
	}, E('div', { 'style': 'width:0' }));

	var upBtn = E('button', {
		'class': 'btn cbi-button cbi-button-action',
		'disabled': true,
		'style': 'margin-left:8px',
		'click': function () {
			var f = state.picked;
			if (!f)
				return Promise.resolve();

			/* 保留原扩展名：无扩展名的输入虽然 ffmpeg 也能读，
			   但带上更稳妥，也便于在日志里辨认 */
			var ext = (f.name.match(/\.[A-Za-z0-9]+$/) || [ ''])[0];
			var dest = SRC_BASE + ext;

			progress.style.display = 'block';
			upBtn.disabled = true;
			showStatus([ E('span', { 'class': 'spinning' }, _('Uploading…')) ], null);

			var data = new FormData();
			data.append('sessionid', rpc.getSessionID());
			data.append('filename', dest);
			data.append('filedata', f);

			return request.post(UPLOAD_URL, data, {
				timeout: 0,
				progress: function (pev) {
					var pct = pev.total ? (pev.loaded / pev.total) * 100 : 0;
					progress.setAttribute('title', '%.2f%%'.format(pct));
					progress.firstElementChild.style.width = '%.2f%%'.format(pct);
				}
			}).then(function (res) {
				var reply = null;
				try { reply = res.json(); } catch (e) {}

				/*
				 * cgi-io 即使失败也返回 HTTP 200，必须看 JSON 内容。
				 * 失败时形如：
				 *   { "message": "Access to path denied by ACL",
				 *     "failure": [ 0, "No error information" ] }
				 * 真正可读的原因在 message 里；failure 只是 [errcode, strerror(code)]，
				 * 直接 String() 它只会得到「0,No error information」这种无用信息。
				 * 成功时则返回 { size, checksum, sha256sum }。
				 */
				if (reply && reply.failure) {
					var reason = reply.message ||
						(Array.isArray(reply.failure) ? reply.failure[1] : String(reply.failure)) ||
						_('Upload failed.');

					throw new Error(UPLOAD_ERRORS[reason] || reason);
				}

				if (!reply || typeof reply.size === 'undefined')
					throw new Error(_('Upload failed.'));

				state.uploaded = true;
				state.srcPath = dest;
				state.srcName = f.name;
				state.srcSize = (reply && reply.size) || f.size;
				state.finished = false;

				progress.style.display = 'none';
				progress.firstElementChild.style.width = '0';
				upBtn.disabled = false;

				showStatus([
					E('strong', { 'style': 'color:#4caf50' }, _('Uploaded')),
					' ',
					E('strong', {}, state.srcName),
					' (', humanSize(state.srcSize), ')'
				], null);

				/*
				 * 探测源文件：把「本机能不能解码」提前告诉用户。
				 * 设备常缺 H.264/H.265 解码器（专利编解码器默认不编译），
				 * 这种情况下任何重编码都会失败，只有「复制」可行——
				 * 与其让人试一次再猜原因，不如上传完就讲清楚。
				 */
				probeBox.style.display = 'block';
				dom.content(probeBox, [ E('em', { 'class': 'spinning' }, _('Analyzing the file…')) ]);

				return callProbe(state.srcPath).then(function (pr) {
					if (!pr || pr.ok !== true) {
						probeBox.style.display = 'none';
						return;
					}

					var info = [];

					if (pr.video || pr.audio)
						info.push(E('span', {}, '%s: %s   %s: %s'.format(
							_('Video'), pr.video || '-', _('Audio'), pr.audio || '-')));
					else
						info.push(E('span', {}, _('No audio or video stream was detected.')));

					if (pr.decodable === true) {
						info.push(E('div', { 'style': 'color:#4caf50;margin-top:2px' },
							_('This device can decode this file, so re-encoding is available.')));
					}
					else {
						info.push(E('div', { 'style': 'color:#e53935;margin-top:2px' },
							_('This device cannot decode this file. Only “Copy (no re-encode)” will work; any re-encode will fail.')));
					}

					dom.content(probeBox, info);
				}).catch(function () {
					probeBox.style.display = 'none';
				});
			}).catch(function (e) {
				progress.style.display = 'none';
				progress.firstElementChild.style.width = '0';
				upBtn.disabled = false;
				showStatus([
					E('strong', {}, _('Upload failed.')),
					' ',
					E('span', {}, e.message || String(e))
				], '#e53935');
			});
		}
	}, _('Upload'));

	return E('div', { 'class': 'cbi-section' }, [
		E('h3', {}, _('1. Source file')),
		E('p', { 'class': 'cbi-section-descr' },
			_('The file is uploaded into the router RAM disk and never written to flash.')),
		E('div', {}, [ input, browseBtn, upBtn ]),
		pickInfo,
		progress,
		status,
		probeBox
	]);
}

function renderResult() {
	var statusBox = E('div', {}, [ E('em', {}, _('Idle')) ]);
	var logBox = E('pre', {
		'id': 'convert-log',
		'style': 'max-height:280px;overflow:auto;background:#1b1b1b;color:#e0e0e0;' +
			'padding:10px;border-radius:4px;font-size:12px;line-height:1.45;' +
			'white-space:pre-wrap;word-break:break-all;margin:8px 0 0 0;display:none'
	});

	var dlBtn = E('button', {
		'class': 'btn cbi-button cbi-button-action',
		'disabled': true,
		'style': 'margin-left:8px',
		'click': function () {
			/* 下载时才计算路径，保证和当前选择的输出容器一致 */
			var container = uci.get('ffmpeg', SECTION, 'output_container') || 'mp4';
			var base = (state.srcName || 'output').replace(/\.[^.]+$/, '');
			var name = base + containerExt(container);

			/* 用 cgi-io 的 download 端点，字段名与官方 flash.js 一致 */
			var form = E('form', {
				'method': 'post',
				'action': DOWNLOAD_URL,
				'enctype': 'application/x-www-form-urlencoded'
			}, [
				E('input', { 'type': 'hidden', 'name': 'sessionid', 'value': rpc.getSessionID() }),
				E('input', { 'type': 'hidden', 'name': 'path', 'value': outPath(container) }),
				E('input', { 'type': 'hidden', 'name': 'filename', 'value': name })
			]);

			document.body.appendChild(form);
			form.submit();
			form.parentNode.removeChild(form);
		}
	}, _('Download result'));

	var stopBtn = E('button', {
		'class': 'btn cbi-button cbi-button-reset',
		'disabled': true,
		'style': 'margin-left:8px',
		'click': function () {
			setStatus(statusBox, _('Stopping…'), '#ff9800');
			return callControl('stop', SECTION).then(function () {
				setStatus(statusBox, _('Conversion stopped.'), '#9e9e9e');
				return refresh(pollRefs);
			}).catch(function (e) {
				showLog(logBox, String(e.message || e).split('\n'));
				setStatus(statusBox, _('Conversion failed.'), '#e53935');
			});
		}
	}, _('Stop'));

	var startBtn = E('button', {
		'class': 'btn cbi-button cbi-button-apply',
		'click': function () { return startConversion(startBtn, dlBtn, stopBtn, statusBox, logBox); }
	}, _('Start conversion'));

	/* 供 poll 回调使用（poll 在 render() 里统一注册） */
	pollRefs = { start: startBtn, download: dlBtn, stop: stopBtn, status: statusBox, log: logBox };

	return E('div', { 'class': 'cbi-section' }, [
		E('h3', {}, _('3. Run and download')),
		E('p', { 'class': 'cbi-section-descr' },
			_('The conversion runs on the router. Keep this page open to follow the progress.')),
		E('div', {}, [ startBtn, stopBtn, dlBtn ]),
		E('div', { 'style': 'margin-top:10px' }, [ statusBox ]),
		logBox
	]);
}

/* ------------------------------------------------------------------ */
/* 行为                                                               */
/* ------------------------------------------------------------------ */

function setStatus(statusBox, text, color) {
	dom.content(statusBox, E('span', {
		'class': 'ifacebadge',
		'style': 'background:' + (color || '#9e9e9e') + ';color:#fff;padding:2px 8px;border-radius:3px'
	}, text));
}

function refresh(refs) {
	if (!refs)
		return Promise.resolve();

	return callStatus().then(function (res) {
		var info = (res || {})[SECTION] || {};
		var running = !!info.running;

		if (running) {
			state.running = true;
			setStatus(refs.status, _('Running…'), '#ff9800');
			refs.start.disabled = true;
			refs.stop.disabled = false;
			refs.download.disabled = true;
		}
		else {
			if (state.running) {
				/*
				 * 从运行中变成已结束：用 ffmpeg 的真实退出码判定成败。
				 *
				 * 之前是拿日志里的关键词猜（Error/Invalid/...），
				 * 结果 "Unknown encoder 'libx264'" 这类报错匹配不上，
				 * 失败的任务被判成成功，还会启用「下载结果」按钮，
				 * 点下去只会得到 "Failed to stat requested path"。
				 */
				state.running = false;

				return Promise.all([
					callLog(SECTION, 200),
					callExitCode(SECTION).catch(function () { return {}; })
				]).then(function (r) {
					var lines = (r[0] && r[0].lines) || [];
					var ec = r[1] || {};

					showLog(refs.log, lines);

					var code = (ec.known === true) ? parseInt(ec.code, 10) : null;

					if (code === 0) {
						state.finished = true;
						state.failed = false;
						refs.download.disabled = false;
					}
					else {
						state.finished = false;
						state.failed = true;
						refs.download.disabled = true;

						var head = (code != null)
							? _('ffmpeg exited with code %s.').format(code)
							: _('Conversion failed.');

						return showFailure(refs.log, head, lines).then(function () {
							refs.start.disabled = !state.uploaded;
							refs.stop.disabled = true;
						});
					}

					refs.start.disabled = !state.uploaded;
					refs.stop.disabled = true;
				});
			}

			/*
			 * 注意：这里不能用「!state.running」就报 Idle。
			 * 任务结束后的第一次轮询已经把结论记在 finished/failed 里，
			 * 后续每 3 秒的轮询必须保持这个结论，否则状态会被反复刷成
			 * 「空闲」，而日志还停在失败内容上，两者对不上。
			 */
			if (state.failed)
				setStatus(refs.status, _('Conversion failed.'), '#e53935');
			else if (state.finished)
				setStatus(refs.status, _('Conversion finished.'), '#4caf50');
			else
				setStatus(refs.status, _('Idle'), '#9e9e9e');

			refs.start.disabled = !state.uploaded;
			refs.stop.disabled = true;
			refs.download.disabled = !state.finished;
		}
	});
}

function showLog(logBox, lines) {
	var text = lines.length ? lines.join('\n') : '';
	logBox.style.display = text ? 'block' : 'none';
	dom.content(logBox, text);
}

/*
 * 失败时把设备上 /etc/config/ffmpeg 里该段的真实内容一并显示。
 *
 * 这里刻意走后端读文件，而不是用 uci.get()：LuCI 的 uci 缓存里可能只有
 * 未提交的变更，拿它当依据会得出「参数没写进去」这种错误结论。
 */
function dumpConfig() {
	return callConfig(SECTION).then(function (res) {
		var lines = [ '--- /etc/config/ffmpeg (' + SECTION + ') ---' ];
		var body = (res && res.lines) || [];

		if (body.length === 0)
			lines.push(_('(this section does not exist)'));
		else
			lines = lines.concat(body);

		/*
		 * 带上前端实际发送的参数。
		 * 落盘内容与发送内容一对比，就能判断是「没发出去」还是「没写进去」。
		 */
		if (state.lastParams) {
			lines.push('', '--- sent by this page ---');
			lines.push(JSON.stringify(state.lastParams));
		}

		if (state.lastWritten != null)
			lines.push('fields written: ' + state.lastWritten);

		lines.push('', 'convert.js ' + JS_VERSION);

		return lines;
	}).catch(function () {
		return [ '--- /etc/config/ffmpeg ---', _('(failed to read)'), '', 'convert.js ' + JS_VERSION ];
	});
}

/* 把诊断信息和日志一起写进日志框 */
function showFailure(logBox, headline, detail) {
	return dumpConfig().then(function (dump) {
		var lines = (detail && detail.length) ? detail : [ _('ffmpeg produced no output.') ];

		showLog(logBox, [ headline ].concat([ '' ], lines, [ '' ], dump));
	});
}

function startConversion(startBtn, dlBtn, stopBtn, statusBox, logBox) {
	if (!state.uploaded) {
		setStatus(statusBox, _('Please upload a source file first.'), '#e53935');
		return Promise.resolve();
	}

	/*
	 * 先从界面收集参数，再交给后端写进 UCI。
	 *
	 * 顺序很重要：输出文件的扩展名由 output_container 决定，
	 * 如果先算出路径再去读表单，界面上改过的容器就不会体现在文件名里。
	 *
	 * 配置也刻意不由前端保存：LuCI 的 uci 抽象把改动分成
	 * values / changes / creates 三套状态，提交时任何一步不符合预期都会
	 * 静默丢失（实测表现为段根本没建出来，转码时才发现配置为空）。
	 */
	var params = {
		name: _('File conversion'),
		enabled: '1',
		input: state.srcPath,
		overwrite: '1'
	};

	for (var i = 0; i < PARAM_FIELDS.length; i++) {
		var name = PARAM_FIELDS[i];
		var opt = FIELD_OPTS[name];
		var val = opt ? opt.formvalue(SECTION) : null;

		if (val != null && val !== '')
			params[name] = String(val);
	}

	var container = params.output_container || 'mp4';
	var out = outPath(container);
	params.output = out;

	/* 全程内联反馈，不用弹窗 */
	setStatus(statusBox, _('Starting conversion…'), '#ff9800');
	startBtn.disabled = true;
	logBox.style.display = 'none';
	dom.content(logBox, '');

	state.finished = false;
	state.failed = false;

	/* 记下实际发送的内容，失败时一并显示，便于确认参数有没有构造对 */
	state.lastParams = params;

	return callConfigure(SECTION, JSON.stringify(params)).then(function (cfg) {
		if (!cfg || cfg.ok !== true)
			throw new Error((cfg && cfg.error) || _('Failed to save the conversion settings.'));

		state.lastWritten = cfg.written;

		/*
		 * 立刻回读确认配置真的落盘了。
		 * 之前就是带着一份空配置去启动转码，ffmpeg 因为 input/output 为空
		 * 直接退出，日志也是空的，从报错完全看不出真正的原因。
		 */
		return callConfig(SECTION).then(function (chk) {
			var lines = (chk && chk.lines) || [];

			if (lines.length === 0)
				throw new Error(_('Settings were not saved (the section is still empty).'));

			return callControl('start', SECTION);
		});
	}).then(function (res) {
		state.running = true;

		if (res && res.ok) {
			showLog(logBox, []);
			setStatus(statusBox,
				_('Conversion started.') + '  ' +
				'%s=%s, %s=%s, %s=%s'.format('container', container,
					'video_codec', params.video_codec || '-',
					'audio_codec', params.audio_codec || '-'),
				'#ff9800');
		}
		else {
			var detail = (res && res.output) ? res.output.split('\n') : null;
			setStatus(statusBox, _('Conversion failed.'), '#e53935');
			state.failed = true;
			startBtn.disabled = false;

			return showFailure(logBox, _('Conversion failed.'), detail);
		}

		return refresh({ start: startBtn, download: dlBtn, stop: stopBtn, status: statusBox, log: logBox });
	}).catch(function (e) {
		setStatus(statusBox, _('Conversion failed.'), '#e53935');
		state.failed = true;
		startBtn.disabled = false;

		return showFailure(logBox, _('Conversion failed.'), String(e.message || e).split('\n'));
	});
}

/* ------------------------------------------------------------------ */
/* 视图                                                               */
/* ------------------------------------------------------------------ */

return view.extend({
	load: function () {
		return Promise.all([
			uci.load('ffmpeg'),
			callEncoders().then(function (res) {
				/* probed 为 false 说明探测失败，保持 null 让 render() 列出全部候选 */
				if (res && res.probed === true) {
					available.video = Array.isArray(res.video) ? res.video : [];
					available.audio = Array.isArray(res.audio) ? res.audio : [];
				}
			}).catch(function () {
				/* 探测异常同样退回全量候选 */
			})
		]).then(function () {
			if (!uci.get('ffmpeg', SECTION))
				uci.add('ffmpeg', 'task', SECTION);

			if (uci.get('ffmpeg', SECTION, 'output_container') == null)
				uci.set('ffmpeg', SECTION, 'output_container', 'mp4');

			if (uci.get('ffmpeg', SECTION, 'name') == null)
				uci.set('ffmpeg', SECTION, 'name', _('File conversion'));

			return callStatus().then(function (res) {
				state.running = !!((res || {})[SECTION] || {}).running;
			});
		});
	},

	render: function () {
		var m, s, o;

		m = new form.Map('ffmpeg', _('File conversion'),
			_('Upload a file, convert it with FFmpeg on the router, then download the result. The settings below are stored as a normal task named "convert".'));
		formMap = m;

		s = m.section(form.NamedSection, SECTION, 'task', _('2. Conversion parameters'));

		o = s.option(form.ListValue, 'output_container', _('Output container'));
		for (var i = 0; i < CONTAINERS.length; i++)
			o.value(CONTAINERS[i][0], CONTAINERS[i][1]);
		o.default = 'mp4';
		o.rmempty = false;
		FIELD_OPTS.output_container = o;

		o = s.option(form.ListValue, 'video_codec', _('Video codec'));
		addCodecOptions(o, 'video', [
			[ 'copy', _('Copy (no re-encode)') ],
			[ 'libx264', 'H.264 (libx264)' ],
			[ 'libx265', 'H.265 (libx265)' ],
			[ 'h264_v4l2m2m', _('H.264 (hardware, v4l2m2m)') ],
			[ 'hevc_v4l2m2m', _('H.265 (hardware, v4l2m2m)') ],
			[ 'mpeg4', 'MPEG-4' ],
			[ 'mpeg2video', 'MPEG-2' ],
			[ 'mpeg1video', 'MPEG-1' ],
			[ 'libvpx', 'VP8 (libvpx)' ],
			[ 'libvpx-vp9', 'VP9 (libvpx-vp9)' ],
			[ 'h263', 'H.263' ],
			[ 'mjpeg', 'MJPEG' ],
			[ 'ffv1', _('FFV1 (lossless)') ],
			[ 'prores', 'ProRes' ],
			[ 'none', _('Disable video') ]
		]);
		o.default = 'copy';
		o.rmempty = false;
		o.description = _('Only encoders this device can actually use are listed. If H.264/H.265 are missing, this ffmpeg build cannot encode them.');
		FIELD_OPTS.video_codec = o;

		o = s.option(form.Value, 'video_bitrate', _('Video bitrate'));
		o.placeholder = '2000k';
		FIELD_OPTS.video_bitrate = o;

		o = s.option(form.Value, 'scale', _('Scale'));
		o.placeholder = '1280:-2';
		FIELD_OPTS.scale = o;

		o = s.option(form.Value, 'fps', _('Frame rate'));
		o.placeholder = '25';
		FIELD_OPTS.fps = o;

		o = s.option(form.ListValue, 'audio_codec', _('Audio codec'));
		addCodecOptions(o, 'audio', [
			[ 'copy', _('Copy (no re-encode)') ],
			[ 'aac', 'AAC' ],
			[ 'libfdk_aac', 'AAC (libfdk_aac)' ],
			[ 'libmp3lame', 'MP3' ],
			[ 'ac3', 'AC-3' ],
			[ 'eac3', 'E-AC-3' ],
			[ 'libopus', 'Opus' ],
			[ 'libvorbis', 'Vorbis' ],
			[ 'flac', 'FLAC' ],
			[ 'mp2', 'MP2' ],
			[ 'none', _('Disable audio') ]
		]);
		o.default = 'copy';
		o.rmempty = false;
		FIELD_OPTS.audio_codec = o;

		o = s.option(form.Value, 'audio_bitrate', _('Audio bitrate'));
		o.placeholder = '128k';
		FIELD_OPTS.audio_bitrate = o;

		o = s.option(form.Value, 'extra_args', _('Extra arguments'));
		o.placeholder = '-preset veryfast';
		o.description = _('Raw ffmpeg options appended right before the output target.');
		FIELD_OPTS.extra_args = o;

		o = s.option(form.ListValue, 'loglevel', _('Log level'));
		o.value('quiet', _('Quiet'));
		o.value('error', _('Error'));
		o.value('warning', _('Warning'));
		o.value('info', _('Info'));
		o.value('verbose', _('Verbose'));
		o.value('debug', _('Debug'));
		o.default = 'info';
		o.rmempty = false;
		FIELD_OPTS.loglevel = o;

		return m.render().then(function (formNodes) {
			var container = E('div', {}, [
				E('h2', {}, _('File conversion')),
				E('div', { 'style': 'font-size:85%;color:#888;margin:-6px 0 10px' },
					'luci-app-ffmpeg · convert.js ' + JS_VERSION),
				renderUpload(),
				E('div', { 'class': 'cbi-section' }, [].concat(formNodes)),
				renderResult()
			]);

			/* 视图可能被反复进入，先移除上一次的轮询句柄 */
			if (pollHandle) {
				poll.remove(pollHandle);
				pollHandle = null;
			}

			pollHandle = function () { return refresh(pollRefs); };
			poll.add(pollHandle, 3);

			return container;
		});
	}
});
