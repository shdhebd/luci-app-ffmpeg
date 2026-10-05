// SPDX-License-Identifier: Apache-2.0
'use strict';
'require view';
'require form';

return view.extend({
	render: function () {
		var m, s, o;

		m = new form.Map('ffmpeg', _('FFmpeg Settings'),
			_('Global settings shared by every task.'));

		s = m.section(form.NamedSection, 'globals', 'globals', _('Global settings'));
		s.addremove = false;

		o = s.option(form.Flag, 'enabled', _('Enable FFmpeg management'));
		o.default = '1';
		o.rmempty = false;
		o.description = _('When disabled, no task is started on boot.');

		o = s.option(form.Value, 'binary', _('FFmpeg binary'));
		o.default = '/usr/bin/ffmpeg';
		o.rmempty = false;
		o.description = _('Absolute path of the ffmpeg executable.');

		o = s.option(form.Value, 'workdir', _('Working directory'));
		o.default = '/tmp/ffmpeg';
		o.rmempty = false;
		o.description = _('Each task is started from this directory.');

		o = s.option(form.Value, 'logdir', _('Log directory'));
		o.default = '/var/log/ffmpeg';
		o.rmempty = false;
		o.description = _('One <section>.log file is written per task.');

		return m.render();
	}
});
