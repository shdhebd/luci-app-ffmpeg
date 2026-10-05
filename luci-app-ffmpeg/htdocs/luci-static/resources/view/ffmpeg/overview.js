// SPDX-License-Identifier: Apache-2.0
'use strict';
'require view';
'require rpc';
'require uci';
'require ui';
'require poll';

/*
 * expect: { '': {} } 表示「要求整个 ubus 回复是对象」。
 * 当 ubus 调用失败时回复会是数字状态码，此时被替换成 {}，
 * 避免把数字当成状态表使用。
 */
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

/* reject: true 让非零的 ubus 状态码（如权限拒绝）变成 Promise 拒绝 */
var callControl = rpc.declare({
	object: 'ffmpeg',
	method: 'control',
	params: [ 'action', 'section' ],
	expect: { '': {} },
	reject: true
});

/* 查询当前用户对 ubus 对象 ffmpeg 的 control 方法是否有写权限 */
var callSessionAccess = rpc.declare({
	object: 'session',
	method: 'access',
	params: [ 'scope', 'object', 'function' ],
	expect: { access: false }
});

/* 最近一次 status 调用的结果，形如 { section: { running, pid, started } } */
var statusMap = {};

/* 是否展示启停按钮；无权限时后端会拒绝，这里只是为了不误导只读用户 */
var mayControl = true;

/* poll 句柄，SPA 切换视图时需要显式移除，避免轮询不断累积 */
var pollHandle = null;

var BADGE_STYLE = 'display:inline-block;min-width:4.5em;text-align:center;' +
	'padding:2px 8px;border-radius:3px;color:#fff;';

function statusBadge(running) {
	return E('span', {
		'class': 'ifacebadge',
		'style': BADGE_STYLE + 'background:' + (running ? '#4caf50' : '#9e9e9e')
	}, running ? _('Running') : _('Stopped'));
}

function formatUptime(seconds) {
	seconds = +seconds || 0;

	if (seconds <= 0)
		return '';

	var d = Math.floor(seconds / 86400);
	var h = Math.floor((seconds % 86400) / 3600);
	var m = Math.floor((seconds % 3600) / 60);

	if (d > 0)
		return '%sd %sh %sm'.format(d, h, m);

	if (h > 0)
		return '%sh %sm'.format(h, m);

	return '%sm'.format(m);
}

function actionButton(label, cssClass, handler) {
	return E('button', {
		'class': 'cbi-button ' + cssClass,
		'style': 'margin:1px 4px 1px 0',
		'click': handler
	}, label);
}

function runControl(action, section) {
	ui.showModal(_('Please wait'), [
		E('p', { 'class': 'spinning' }, _('Applying changes...'))
	]);

	return callControl(action, section).then(function (res) {
		ui.hideModal();

		if (res && res.ok) {
			ui.addNotification(null, E('p', {}, _('Operation completed.')), 'info');
		}
		else {
			var detail = (res && res.output) ? res.output : _('Operation failed.');

			ui.addNotification(null, E('p', {}, [
				E('strong', {}, _('Operation failed.')),
				E('br'),
				E('code', { 'style': 'white-space:pre-wrap' }, detail)
			]), 'error');
		}

		return refreshStatus();
	}).catch(function (err) {
		ui.hideModal();
		/* ubus 层的错误信息（含 Permission denied）由 luci-base 翻译 */
		ui.addNotification(null, E('p', {}, err.message || String(err)), 'error');
	});
}

function showLog(section) {
	ui.showModal(_('Task log'), [
		E('p', { 'class': 'spinning' }, _('Loading...'))
	]);

	return callLog(section, 500).then(function (res) {
		var lines = (res && res.lines) || [];

		ui.showModal(_('Task log'), [
			E('pre', {
				'style': 'max-height:60vh;overflow:auto;background:#1b1b1b;color:#e0e0e0;' +
					'padding:10px;border-radius:4px;font-size:12px;line-height:1.45;' +
					'white-space:pre-wrap;word-break:break-all;margin:0'
			}, lines.length ? lines.join('\n') : _('The log is empty.')),
			E('div', { 'class': 'right', 'style': 'margin-top:10px' }, [
				E('button', {
					'class': 'btn cbi-button',
					'click': ui.hideModal
				}, _('Close'))
			])
		]);
	}).catch(function (err) {
		ui.hideModal();
		ui.addNotification(null, E('p', {}, err.message || String(err)), 'error');
	});
}

function renderActions(section) {
	if (!mayControl)
		return E('em', {}, _('Read-only access'));

	return [
		actionButton(_('Start'), 'cbi-button-apply', function () {
			return runControl('start', section);
		}),
		actionButton(_('Stop'), 'cbi-button-reset', function () {
			return runControl('stop', section);
		}),
		actionButton(_('Restart'), 'cbi-button-action', function () {
			return runControl('restart', section);
		}),
		actionButton(_('Log'), 'cbi-button', function () {
			return showLog(section);
		})
	];
}

function renderTaskRow(section) {
	var running = !!(statusMap[section] && statusMap[section].running);

	return E('tr', { 'class': 'tr', 'data-section': section }, [
		E('td', { 'class': 'td' }, [
			E('strong', {}, uci.get('ffmpeg', section, 'name') || section)
		]),
		E('td', { 'class': 'td', 'style': 'word-break:break-all' },
			uci.get('ffmpeg', section, 'input') || '-'),
		E('td', { 'class': 'td', 'style': 'word-break:break-all' },
			uci.get('ffmpeg', section, 'output') || '-'),
		E('td', { 'class': 'td status-cell' }, [ statusBadge(running) ]),
		E('td', { 'class': 'td' }, [ renderActions(section) ])
	]);
}

function refreshStatus() {
	return callStatus().then(function (res) {
		statusMap = res || {};

		var root = document.getElementById('ffmpeg-overview');

		if (!root)
			return;

		var rows = root.querySelectorAll('tr[data-section]');

		for (var i = 0; i < rows.length; i++) {
			var section = rows[i].getAttribute('data-section');
			var cell = rows[i].querySelector('.status-cell');

			if (!cell)
				continue;

			var info = statusMap[section] || {};
			var up = '';

			if (info.running) {
				var started = parseInt(info.started, 10) || 0;
				var now = Math.floor(Date.now() / 1000);

				if (started > 0 && now > started)
					up = formatUptime(now - started);
			}

			// 用原生 DOM 重建单元格内容，避免依赖可选的辅助模块
			while (cell.firstChild)
				cell.removeChild(cell.firstChild);

			cell.appendChild(statusBadge(!!info.running));

			if (up) {
				cell.appendChild(E('div', {
					'style': 'font-size:11px;opacity:.7;margin-top:2px'
				}, up));
			}
		}
	});
}

return view.extend({
	load: function () {
		return Promise.all([
			uci.load('ffmpeg'),
			callStatus().then(function (res) {
				statusMap = res || {};
			}),
			callSessionAccess('ubus', 'ffmpeg', 'control').then(function (granted) {
				mayControl = (granted === true);
			}).catch(function () {
				/* 查询失败时不隐藏按钮，真正的权限判定仍由 rpcd 负责 */
				mayControl = true;
			})
		]);
	},

	render: function () {
		var sections = uci.sections('ffmpeg', 'task');
		var rows = sections.map(function (s) {
			return renderTaskRow(s['.name']);
		});

		var table = E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('Task')),
				E('th', { 'class': 'th' }, _('Input')),
				E('th', { 'class': 'th' }, _('Output')),
				E('th', { 'class': 'th' }, _('Status')),
				E('th', { 'class': 'th' }, _('Actions'))
			])
		].concat(rows));

		var body = sections.length
			? table
			: E('p', {}, [
				_('No tasks have been configured yet.'),
				' ',
				E('a', { 'href': L.url('admin/services/ffmpeg/tasks') }, _('Add a task'))
			]);

		var stats = [];

		if (sections.length) {
			var runningCount = sections.filter(function (s) {
				return !!(statusMap[s['.name']] && statusMap[s['.name']].running);
			}).length;

			stats = [
				E('div', { 'class': 'cbi-section-descr' },
					_('Running: %s / %s').format(runningCount, sections.length))
			];
		}

		var container = E('div', { 'id': 'ffmpeg-overview' }, [
			E('h2', {}, _('FFmpeg Overview')),
			E('p', { 'class': 'cbi-section-descr' },
				_('Runtime state of every configured FFmpeg task. The list refreshes automatically.')),
			E('div', { 'class': 'cbi-section' }, stats.concat([ body ]))
		]);

		/* 视图可能被反复进入，先移除上一次的轮询句柄 */
		if (pollHandle) {
			poll.remove(pollHandle);
			pollHandle = null;
		}

		pollHandle = function () {
			return refreshStatus();
		};

		poll.add(pollHandle, 5);

		return container;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
