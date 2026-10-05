// SPDX-License-Identifier: Apache-2.0
'use strict';
'require view';
'require form';
'require uci';

return view.extend({
	render: function () {
		var m, s, o;

		m = new form.Map('ffmpeg', _('FFmpeg Tasks'),
			_('Every task is one ffmpeg process. Changing a task requires a restart of that task to take effect.'));

		s = m.section(form.TypedSection, 'task', _('Tasks'));
		s.anonymous = true;
		s.addremove = true;
		s.sectiontitle = function (section_id) {
			return uci.get('ffmpeg', section_id, 'name') || section_id;
		};

		/* --- 基本 --- */

		o = s.option(form.Flag, 'enabled', _('Enable'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Flag, 'autostart', _('Start on boot'));
		o.default = '0';
		o.rmempty = false;

		o = s.option(form.Value, 'name', _('Task name'));
		o.placeholder = _('My task');

		/* --- 输入输出 --- */

		o = s.option(form.Value, 'input', _('Input source'));
		o.placeholder = 'udp://239.0.0.1:1234';
		o.rmempty = false;

		o = s.option(form.Value, 'output', _('Output target'));
		o.placeholder = '/mnt/video/output.mp4';
		o.rmempty = false;

		/* --- 视频 --- */

		o = s.option(form.ListValue, 'video_codec', _('Video codec'));
		o.value('copy', _('Copy (no re-encode)'));
		o.value('libx264', 'H.264 (libx264)');
		o.value('libx265', 'H.265 (libx265)');
		o.value('mpeg4', 'MPEG-4');
		o.value('mpeg2video', 'MPEG-2');
		o.value('none', _('Disable video'));
		o.default = 'copy';
		o.rmempty = false;

		o = s.option(form.Value, 'video_bitrate', _('Video bitrate'));
		o.placeholder = '2000k';

		o = s.option(form.Value, 'scale', _('Scale'));
		o.placeholder = '1280:-2';

		o = s.option(form.Value, 'fps', _('Frame rate'));
		o.placeholder = '25';

		/* --- 音频 --- */

		o = s.option(form.ListValue, 'audio_codec', _('Audio codec'));
		o.value('copy', _('Copy (no re-encode)'));
		o.value('aac', 'AAC');
		o.value('libmp3lame', 'MP3');
		o.value('ac3', 'AC-3');
		o.value('libopus', 'Opus');
		o.value('none', _('Disable audio'));
		o.default = 'copy';
		o.rmempty = false;

		o = s.option(form.Value, 'audio_bitrate', _('Audio bitrate'));
		o.placeholder = '128k';

		/* --- 输出与日志 --- */

		o = s.option(form.Value, 'format', _('Output format'));
		o.placeholder = 'mpegts';

		o = s.option(form.Flag, 'overwrite', _('Overwrite output'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.ListValue, 'loglevel', _('Log level'));
		o.value('quiet', _('Quiet'));
		o.value('error', _('Error'));
		o.value('warning', _('Warning'));
		o.value('info', _('Info'));
		o.value('verbose', _('Verbose'));
		o.value('debug', _('Debug'));
		o.default = 'warning';
		o.rmempty = false;

		o = s.option(form.Value, 'extra_args', _('Extra arguments'));
		o.placeholder = '-preset veryfast -g 50';
		o.description = _('Raw ffmpeg options appended right before the output target.');

		return m.render();
	}
});
